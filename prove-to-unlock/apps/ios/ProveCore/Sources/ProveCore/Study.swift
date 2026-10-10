import Foundation

/// Decks and the study queue. Port of packages/core/src/anki/study.ts (+ Deck shapes from apkg.ts).

public struct MediaFile: Codable, Equatable {
    public var mime: String
    public var data: String // base64
}

public struct DeckCard: Codable, Equatable, Identifiable {
    public var id: String
    public var noteId: String
    public var ord: Int
    public var front: String
    public var back: String
    public var styleId: String
    public var tags: [String]
    public var position: Int
}

public struct Deck: Codable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var importedAt: Millis
    public var source: String
    public var cards: [DeckCard]
    public var styles: [String: String]
    public var media: [String: MediaFile]
}

public struct QueueItem: Equatable {
    public enum Kind: String { case new, learning, review }
    public var card: DeckCard
    public var deckId: String
    public var srs: SrsCard
    public var kind: Kind
}

public struct StudyQueue: Equatable {
    public var items: [QueueItem]
    public var counts: (new: Int, learning: Int, review: Int)
    public var nextDueAt: Millis?
    public var cleared: Bool

    public static func == (a: StudyQueue, b: StudyQueue) -> Bool {
        a.items == b.items && a.counts == b.counts && a.nextDueAt == b.nextDueAt && a.cleared == b.cleared
    }
}

public enum Study {
    public static func dayBounds(now: Millis, rolloverHour: Int = 4, time lt: LocalTime) -> (start: Millis, end: Millis, day: DayKey) {
        let day = lt.dayKey(now - Millis(rolloverHour) * 3_600_000)
        let start = lt.epoch(day: day, minutesOfDay: rolloverHour * 60)!
        let next = lt.dayKey(start + 36 * 3_600_000)
        let end = lt.epoch(day: next, minutesOfDay: rolloverHour * 60)!
        return (start, end, day)
    }

    public static func buildQueue(decks: [Deck], events: [ReviewEvent], now: Millis, newPerDay: Int, reviewsPerDay: Int? = nil, rolloverHour: Int = 4, learnAheadMs: Millis = 20 * 60_000, deckIds: [String]? = nil, time lt: LocalTime = LocalTime(), params: FsrsParams = .default) -> StudyQueue {
        let (start, end, _) = dayBounds(now: now, rolloverHour: rolloverHour, time: lt)
        let selected = (deckIds?.isEmpty == false) ? decks.filter { deckIds!.contains($0.id) } : decks
        let cardIds = Set(selected.flatMap { $0.cards.map(\.id) })
        let relevant = events.filter { cardIds.contains($0.cardId) }
        let states = FSRS.replay(relevant, params)

        var firstSeen: [String: Millis] = [:]
        for e in relevant { firstSeen[e.cardId] = min(firstSeen[e.cardId] ?? .max, e.at) }
        let introducedToday = firstSeen.values.filter { $0 >= start && $0 < end }.count
        let reviewedToday = Set(relevant.filter { $0.at >= start && $0.at < end }.map(\.cardId))

        var learning: [QueueItem] = [], waiting: [QueueItem] = [], reviews: [QueueItem] = [], fresh: [QueueItem] = []
        for d in selected {
            for card in d.cards {
                if let srs = states[card.id] {
                    switch srs.state {
                    case .learning, .relearning:
                        let item = QueueItem(card: card, deckId: d.id, srs: srs, kind: .learning)
                        if srs.due <= now { learning.append(item) } else { waiting.append(item) }
                    case .review where srs.due < end:
                        reviews.append(QueueItem(card: card, deckId: d.id, srs: srs, kind: .review))
                    default: break
                    }
                } else {
                    fresh.append(QueueItem(card: card, deckId: d.id, srs: .new(now: now), kind: .new))
                }
            }
        }
        // Stable sorts, like Array.prototype.sort in modern JS engines.
        func stableSorted(_ a: [QueueItem], by key: (QueueItem) -> Millis) -> [QueueItem] {
            a.enumerated().sorted { key($0.element) != key($1.element) ? key($0.element) < key($1.element) : $0.offset < $1.offset }.map(\.element)
        }
        learning = stableSorted(learning) { $0.srs.due }
        waiting = stableSorted(waiting) { $0.srs.due }
        reviews = stableSorted(reviews) { $0.srs.due }
        fresh = stableSorted(fresh) { Millis($0.card.position) }

        let reviewedReviewCards = reviewedToday.filter { states[$0]?.state == .review }.count
        let reviewsLeft = max(0, (reviewsPerDay ?? Int.max) - reviewedReviewCards)
        let reviewItems = Array(reviews.prefix(reviewsLeft))
        let newItems = Array(fresh.prefix(max(0, newPerDay - introducedToday)))
        var items = learning + reviewItems + newItems
        if items.isEmpty {
            items = waiting.filter { $0.srs.due <= now + learnAheadMs }
        }
        let shown = Set(items.map(\.card.id))
        let stillWaiting = waiting.filter { !shown.contains($0.card.id) }
        return StudyQueue(
            items: items,
            counts: (newItems.count, items.filter { $0.kind == .learning }.count, reviewItems.count),
            nextDueAt: stillWaiting.first?.srs.due,
            cleared: items.isEmpty
        )
    }

    public static func honestReviewsToday(_ events: [ReviewEvent], now: Millis, minAnswerMs: Double, deviceId: String, rolloverHour: Int = 4, deckIds: [String]? = nil, time lt: LocalTime = LocalTime()) -> Int {
        let (start, end, _) = dayBounds(now: now, rolloverHour: rolloverHour, time: lt)
        return events.filter { e in
            e.deviceId == deviceId && e.at >= start && e.at < end && Double(e.at - e.answerShownAt) >= minAnswerMs && (deckIds?.isEmpty != false || deckIds!.contains(e.deckId))
        }.count
    }
}

/// Proof accounting for Anki and focus sessions. Port of packages/core/src/proofs.ts.
public enum Proofs {
    @discardableResult
    public static func issueAnkiProofs(ledger: Ledger, decks: [Deck], now: Millis, newCardsPerDay: Int, time lt: LocalTime = LocalTime()) throws -> Int {
        let config = ledger.config()
        let day = lt.dayKey(now)
        var issued = 0
        let state = Engine.evaluate(config: config, records: ledger.records(), now: now, time: lt)
        for cs in state.commitments where cs.unlockedBy == nil || [.proven, .unlockRecord, .emergency].contains(cs.unlockedBy!) {
            let c = cs.commitment
            let reqs = cs.mode == .away ? (c.away?.requirements ?? []) : c.requirements
            for case let .anki(req) in reqs {
                let existing = Engine.proofs(ledger.records()).filter { $0.body.cid == c.id && $0.body.day == day && $0.body.kind == .anki }
                func reviews(_ p: ProofRef) -> Int { if case let .anki(d) = p.body.detail { return d.reviews }; return 0 }
                let claimed = existing.filter { $0.iss == ledger.deviceId }.reduce(0) { $0 + reviews($1) }
                let others = existing.filter { $0.iss != ledger.deviceId }.reduce(0) { $0 + reviews($1) }
                let honest = Study.honestReviewsToday(ledger.reviews(), now: now, minAnswerMs: config.policy.minAnswerMs, deviceId: ledger.deviceId, rolloverHour: 0, deckIds: req.deckIds, time: lt)
                let delta = honest - claimed
                let deckIds = req.deckIds ?? []
                if req.mode == .count {
                    let target = req.count ?? 20
                    if delta > 0 && (others + honest >= target || delta >= 10) {
                        try ledger.issue(.proof(ProofBody(cid: c.id, day: day, at: now, detail: .anki(AnkiDetail(reviews: delta, cleared: false, deckIds: deckIds)))), now: now)
                        issued += 1
                    }
                } else {
                    if existing.contains(where: { if case let .anki(d) = $0.body.detail { return d.cleared }; return false }) { continue }
                    let selected = req.deckIds?.isEmpty == false ? decks.filter { req.deckIds!.contains($0.id) } : decks
                    guard selected.contains(where: { !$0.cards.isEmpty }) else { continue }
                    let q = Study.buildQueue(decks: selected, events: ledger.reviews(), now: now, newPerDay: newCardsPerDay, time: lt)
                    if q.cleared {
                        try ledger.issue(.proof(ProofBody(cid: c.id, day: day, at: now, detail: .anki(AnkiDetail(reviews: max(0, delta), cleared: true, deckIds: deckIds)))), now: now)
                        issued += 1
                    }
                }
            }
        }
        return issued
    }

    public static func issueFocusProof(ledger: Ledger, commitmentId: String, minutes: Double, now: Millis, time lt: LocalTime = LocalTime()) throws -> Bool {
        guard minutes >= 1, minutes <= 240, ledger.config().commitments.contains(where: { $0.id == commitmentId }) else { return false }
        try ledger.issue(.proof(ProofBody(cid: commitmentId, day: lt.dayKey(now), at: now, detail: .focus(FocusDetail(sessions: 1, minutes: minutes)))), now: now)
        return true
    }
}
