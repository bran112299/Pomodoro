import Foundation

/// FSRS-5 scheduler with Anki-style learning steps. Port of packages/core/src/fsrs.ts; verified
/// against py-fsrs reference vectors (spec/vectors/fsrs.json).

public enum Rating: Int, Codable, CaseIterable {
    case again = 1, hard = 2, good = 3, easy = 4
}

public enum CardState: String, Codable {
    case new, learning, review, relearning
}

public struct SrsCard: Codable, Equatable {
    public var state: CardState
    public var step: Int
    public var due: Millis
    public var stability: Double
    public var difficulty: Double
    public var reps: Int
    public var lapses: Int
    public var lastReview: Millis?

    public static func new(now: Millis) -> SrsCard {
        SrsCard(state: .new, step: 0, due: now, stability: 0, difficulty: 0, reps: 0, lapses: 0, lastReview: nil)
    }
}

public struct FsrsParams {
    public var w: [Double]
    public var requestRetention: Double
    public var maximumIntervalDays: Int
    public var learningStepsMin: [Double]
    public var relearningStepsMin: [Double]
    public var enforceOrdering: Bool

    public static let fsrs5DefaultW: [Double] = [
        0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
        1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
    ]

    public static let `default` = FsrsParams(w: fsrs5DefaultW, requestRetention: 0.9, maximumIntervalDays: 36500, learningStepsMin: [1, 10], relearningStepsMin: [10], enforceOrdering: true)

    public init(w: [Double], requestRetention: Double, maximumIntervalDays: Int, learningStepsMin: [Double], relearningStepsMin: [Double], enforceOrdering: Bool) {
        precondition(w.count >= 19, "FSRS-5 needs 19 weights")
        self.w = w
        self.requestRetention = requestRetention
        self.maximumIntervalDays = maximumIntervalDays
        self.learningStepsMin = learningStepsMin
        self.relearningStepsMin = relearningStepsMin
        self.enforceOrdering = enforceOrdering
    }
}

public enum FSRS {
    public static let decay = -0.5
    public static let factor = 19.0 / 81.0
    static let minute: Millis = 60_000
    static let day: Millis = 86_400_000

    static func clampD(_ d: Double) -> Double { min(10, max(1, d)) }
    static func clampS(_ s: Double) -> Double { max(0.01, s) }

    public static func retrievability(elapsedDays: Double, stability: Double) -> Double {
        guard stability > 0 else { return 0 }
        return pow(1 + factor * max(0, elapsedDays) / stability, decay)
    }

    public static func intervalDays(_ stability: Double, _ p: FsrsParams = .default) -> Int {
        let raw = stability / factor * (pow(p.requestRetention, 1 / decay) - 1)
        // JS Math.round rounds .5 up; Foundation's rounded() rounds half away from zero (same for positives).
        return min(p.maximumIntervalDays, max(1, Int(raw.rounded())))
    }

    public static func initStability(_ g: Rating, _ p: FsrsParams = .default) -> Double { max(0.1, p.w[g.rawValue - 1]) }

    public static func initDifficulty(_ g: Rating, _ p: FsrsParams = .default) -> Double {
        clampD(p.w[4] - exp(p.w[5] * Double(g.rawValue - 1)) + 1)
    }

    public static func nextDifficulty(_ d: Double, _ g: Rating, _ p: FsrsParams = .default) -> Double {
        let delta = -p.w[6] * Double(g.rawValue - 3)
        let damped = d + delta * (10 - d) / 9
        return clampD(p.w[7] * initDifficulty(.easy, p) + (1 - p.w[7]) * damped)
    }

    public static func recallStability(_ d: Double, _ s: Double, _ r: Double, _ g: Rating, _ p: FsrsParams = .default) -> Double {
        let hard = g == .hard ? p.w[15] : 1
        let easy = g == .easy ? p.w[16] : 1
        return clampS(s * (1 + exp(p.w[8]) * (11 - d) * pow(s, -p.w[9]) * (exp((1 - r) * p.w[10]) - 1) * hard * easy))
    }

    public static func forgetStability(_ d: Double, _ s: Double, _ r: Double, _ p: FsrsParams = .default) -> Double {
        let longTerm = p.w[11] * pow(d, -p.w[12]) * (pow(s + 1, p.w[13]) - 1) * exp((1 - r) * p.w[14])
        let cap = s / exp(p.w[17] * p.w[18])
        return clampS(min(longTerm, cap))
    }

    public static func shortTermStability(_ s: Double, _ g: Rating, _ p: FsrsParams = .default) -> Double {
        clampS(s * exp(p.w[17] * (Double(g.rawValue) - 3 + p.w[18])))
    }

    static func hardDelayMin(_ steps: [Double], _ i: Int) -> Double {
        let s0 = steps[0]
        if steps.count == 1 { return min(s0 * 1.5, s0 + 1440) }
        if i == 0 { return (s0 + steps[1]) / 2 }
        return steps[min(i, steps.count - 1)]
    }

    static func ms(_ minutes: Double) -> Millis { Millis((minutes * Double(minute)).rounded()) }

    static func graduate(_ c: SrsCard, _ now: Millis, _ days: Int) -> SrsCard {
        var x = c
        x.state = .review
        x.step = 0
        x.due = now + Millis(days) * day
        return x
    }

    public static func preview(_ card: SrsCard, now: Millis, _ p: FsrsParams = .default) -> [Rating: SrsCard] {
        var out: [Rating: SrsCard] = [:]
        for r in Rating.allCases { out[r] = review(card, r, now: now, p) }
        return out
    }

    public static func review(_ card: SrsCard, _ g: Rating, now: Millis, _ p: FsrsParams = .default) -> SrsCard {
        var base = card
        base.reps += 1
        base.lastReview = now
        let elapsedDays: Double = card.lastReview.map { Double(max(0, (now - $0) / day)) } ?? 0
        let r = card.lastReview == nil ? 0 : retrievability(elapsedDays: elapsedDays, stability: card.stability)

        switch card.state {
        case .new:
            var c = base
            c.stability = initStability(g, p)
            c.difficulty = initDifficulty(g, p)
            let steps = p.learningStepsMin
            if g == .easy || steps.isEmpty { return graduate(c, now, intervalDays(c.stability, p)) }
            c.state = .learning
            switch g {
            case .again:
                c.step = 0
                c.due = now + ms(steps[0])
            case .hard:
                c.step = 0
                c.due = now + ms(hardDelayMin(steps, 0))
            default:
                if steps.count > 1 {
                    c.step = 1
                    c.due = now + ms(steps[1])
                } else {
                    return graduate(c, now, intervalDays(c.stability, p))
                }
            }
            return c

        case .learning, .relearning:
            let steps = card.state == .learning ? p.learningStepsMin : p.relearningStepsMin
            var c = base
            if elapsedDays < 1 { c.stability = shortTermStability(card.stability, g, p) }
            else if g == .again { c.stability = forgetStability(card.difficulty, card.stability, r, p) }
            else { c.stability = recallStability(card.difficulty, card.stability, r, g, p) }
            c.difficulty = nextDifficulty(card.difficulty, g, p)
            if steps.isEmpty || g == .easy { return graduate(c, now, intervalDays(c.stability, p)) }
            switch g {
            case .again:
                c.step = 0
                c.due = now + ms(steps[0])
            case .hard:
                c.due = now + ms(hardDelayMin(steps, card.step))
            default:
                let next = card.step + 1
                if next < steps.count {
                    c.step = next
                    c.due = now + ms(steps[next])
                } else {
                    return graduate(c, now, intervalDays(c.stability, p))
                }
            }
            return c

        case .review:
            let sameDay = elapsedDays < 1
            func stability(_ rating: Rating) -> Double {
                if sameDay { return shortTermStability(card.stability, rating, p) }
                return rating == .again ? forgetStability(card.difficulty, card.stability, r, p) : recallStability(card.difficulty, card.stability, r, rating, p)
            }
            let d = nextDifficulty(card.difficulty, g, p)
            if g == .again {
                var c = base
                c.stability = stability(.again)
                c.difficulty = d
                c.lapses += 1
                if let first = p.relearningStepsMin.first {
                    c.state = .relearning
                    c.step = 0
                    c.due = now + ms(first)
                    return c
                }
                return graduate(c, now, intervalDays(c.stability, p))
            }
            let sHard = stability(.hard), sGood = stability(.good), sEasy = stability(.easy)
            var iHard = intervalDays(sHard, p), iGood = intervalDays(sGood, p), iEasy = intervalDays(sEasy, p)
            if p.enforceOrdering {
                iHard = min(iHard, iGood)
                iGood = max(iGood, iHard + 1)
                iEasy = max(iEasy, iGood + 1)
            }
            var c = base
            c.difficulty = d
            switch g {
            case .hard: c.stability = sHard; return graduate(c, now, min(iHard, p.maximumIntervalDays))
            case .good: c.stability = sGood; return graduate(c, now, min(iGood, p.maximumIntervalDays))
            default: c.stability = sEasy; return graduate(c, now, min(iEasy, p.maximumIntervalDays))
            }
        }
    }
}

public struct ReviewEvent: Codable, Equatable, Identifiable {
    public var id: String
    public var cardId: String
    public var deckId: String
    public var rating: Rating
    public var at: Millis
    public var answerShownAt: Millis
    public var deviceId: String

    public init(id: String, cardId: String, deckId: String, rating: Rating, at: Millis, answerShownAt: Millis, deviceId: String) {
        self.id = id
        self.cardId = cardId
        self.deckId = deckId
        self.rating = rating
        self.at = at
        self.answerShownAt = answerShownAt
        self.deviceId = deviceId
    }
}

public extension FSRS {
    /// Rebuild card states from a merged review log (deterministic, order-independent input).
    static func replay(_ events: [ReviewEvent], _ p: FsrsParams = .default) -> [String: SrsCard] {
        let sorted = events.sorted { $0.at != $1.at ? $0.at < $1.at : $0.id < $1.id }
        var cards: [String: SrsCard] = [:]
        for e in sorted {
            let cur = cards[e.cardId] ?? .new(now: e.at)
            cards[e.cardId] = review(cur, e.rating, now: e.at, p)
        }
        return cards
    }
}
