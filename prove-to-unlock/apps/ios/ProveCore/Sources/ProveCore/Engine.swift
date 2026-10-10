import Foundation

/// The commitment engine. Port of packages/core/src/engine.ts; every device evaluates the same
/// records with the same rules, so they agree without a server.

public struct RequirementStatus: Equatable {
    public var requirement: Requirement
    public var ok: Bool
    public var progress: String
    public var proofIds: [String]
    public var failures: [String]
}

public enum UnlockReason: String, Equatable {
    case disabled, notToday = "not-today", outsideWindow = "outside-window", excused, proven, unlockRecord = "unlock-record", emergency
}

public struct CommitmentStatus: Equatable {
    public var commitment: Commitment
    public var day: DayKey
    public var windowStart: Millis
    public var windowEnd: Millis
    public var mode: Mode
    public var requirements: [RequirementStatus]
    public var satisfied: Bool
    public var locked: Bool
    public var unlockedBy: UnlockReason?

    public enum Mode: String, Equatable { case normal, away }
}

public struct LockState: Equatable {
    public var locked: Bool
    public var commitments: [CommitmentStatus]
    public var emergencyUntil: Millis?
    public var nextChangeAt: Millis?

    public init(locked: Bool, commitments: [CommitmentStatus], emergencyUntil: Millis?, nextChangeAt: Millis?) {
        self.locked = locked
        self.commitments = commitments
        self.emergencyUntil = emergencyUntil
        self.nextChangeAt = nextChangeAt
    }
}

public struct ProofRef {
    public var id: String
    public var iss: String
    public var body: ProofBody
}

public enum Engine {
    public static func proofs(_ records: [SignedRecord]) -> [ProofRef] {
        records.compactMap { r in
            if case let .proof(b) = r.payload.body { return ProofRef(id: r.payload.id, iss: r.payload.iss, body: b) }
            return nil
        }
    }

    static func mergedMinutes(_ intervals: [(from: Millis, to: Millis)]) -> Double {
        let iv = intervals.filter { $0.to > $0.from }.sorted { $0.from < $1.from }
        var total: Millis = 0
        var cur: (from: Millis, to: Millis)?
        for i in iv {
            if let c = cur, i.from <= c.to {
                cur = (c.from, max(c.to, i.to))
            } else {
                if let c = cur { total += c.to - c.from }
                cur = i
            }
        }
        if let c = cur { total += c.to - c.from }
        return Double(total) / 60_000
    }

    public static func evaluateRequirement(_ req: Requirement, cid: String, day: DayKey, proofs all: [ProofRef], config: Config) -> RequirementStatus {
        let todays = all.filter { $0.body.cid == cid && $0.body.day == day && $0.body.kind == req.kind }
        func status(_ ok: Bool, _ progress: String, _ ids: [String] = [], _ failures: [String] = []) -> RequirementStatus {
            RequirementStatus(requirement: req, ok: ok, progress: progress, proofIds: ids, failures: failures)
        }
        switch req {
        case let .photo(r):
            let earlier: [(dhash: String, capturedAt: Millis)] = all.compactMap { p in
                if case let .photo(d) = p.body.detail { return (d.dhash, d.capturedAt) }
                return nil
            }
            var last: [String] = []
            for p in todays.sorted(by: { $0.body.at < $1.body.at }) {
                guard case let .photo(d) = p.body.detail else { continue }
                let c = PhotoCheck.check(r, d, earlier: earlier, places: config.places)
                if c.ok { return status(true, "photo verified", [p.id]) }
                last = c.failures
            }
            return status(false, todays.isEmpty ? "no photo yet" : "photo rejected", [], last)

        case let .presence(r):
            let matching = todays.filter { if case let .presence(d) = $0.body.detail { return d.placeId == r.placeId }; return false }
            let minutes = mergedMinutes(matching.compactMap { if case let .presence(d) = $0.body.detail { return (d.from, d.to) }; return nil })
            return status(minutes >= r.minutes, "\(Int(minutes.rounded(.down))) / \(formatNumber(r.minutes)) min", matching.map(\.id))

        case let .altitude(r):
            let required = r.floors * (r.metersPerFloor ?? 3) - (r.toleranceM ?? 1)
            let hit = todays.first { p in
                guard case let .altitude(d) = p.body.detail else { return false }
                return (r.direction == .down ? -d.deltaM : d.deltaM) >= required
            }
            if let h = hit { return status(true, "\(formatNumber(r.floors)) floor(s) \(r.direction.rawValue)", [h.id]) }
            return status(false, "go \(formatNumber(r.floors)) floor(s) \(r.direction.rawValue)")

        case let .anki(r):
            let relevant = todays.filter { p in
                guard case let .anki(d) = p.body.detail else { return false }
                guard let ids = r.deckIds, !ids.isEmpty else { return true }
                return d.deckIds.allSatisfy { ids.contains($0) }
            }
            if r.mode == .due {
                if let c = relevant.first(where: { if case let .anki(d) = $0.body.detail { return d.cleared }; return false }) {
                    return status(true, "today's cards done", [c.id])
                }
                return status(false, "cards still due")
            }
            let target = r.count ?? 20
            let n = relevant.reduce(0) { acc, p in if case let .anki(d) = p.body.detail { return acc + d.reviews }; return acc }
            return status(n >= target, "\(min(n, target)) / \(target) reviews", relevant.map(\.id))

        case let .focus(r):
            let minLen = r.minutesPerSession ?? 25
            var sessions = 0
            for p in todays {
                if case let .focus(d) = p.body.detail, d.sessions > 0, d.minutes / Double(d.sessions) >= minLen { sessions += d.sessions }
            }
            return status(sessions >= r.sessions, "\(min(sessions, r.sessions)) / \(r.sessions) sessions", todays.map(\.id))
        }
    }

    public static func validExcusedDays(_ config: Config, _ c: Commitment, _ lt: LocalTime) -> Set<DayKey> {
        var byMonth: [String: Int] = [:]
        var seen = Set<DayKey>()
        for e in config.excused.sorted(by: { $0.day < $1.day }) {
            if seen.contains(e.day) { continue }
            guard let w = lt.windowBounds(day: e.day, window: c.window) else { continue }
            guard e.createdAt < w.start else { continue }
            let m = LocalTime.month(e.day)
            if byMonth[m, default: 0] >= config.policy.maxExcusedPerMonth { continue }
            byMonth[m, default: 0] += 1
            seen.insert(e.day)
        }
        return seen
    }

    public static func honoredAwayDays(_ config: Config, _ c: Commitment, _ records: [SignedRecord]) -> Set<DayKey> {
        var days = Set<DayKey>()
        for r in records {
            if case let .status(b) = r.payload.body, b.cid == c.id, b.region == .away { days.insert(b.day) }
        }
        var byMonth: [String: Int] = [:]
        var honored = Set<DayKey>()
        for d in days.sorted() {
            let m = LocalTime.month(d)
            if byMonth[m, default: 0] >= config.policy.maxAwayDaysPerMonth { continue }
            byMonth[m, default: 0] += 1
            honored.insert(d)
        }
        return honored
    }

    public static func evaluate(config: Config, records: [SignedRecord], now: Millis, time lt: LocalTime = LocalTime()) -> LockState {
        let proofs = proofs(records)
        let day = lt.dayKey(now)
        var emergencyUntil: Millis?
        for r in records {
            if case let .emergency(b) = r.payload.body, r.payload.iat <= now, b.until > now { emergencyUntil = max(emergencyUntil ?? 0, b.until) }
        }
        var statuses: [CommitmentStatus] = []
        var changes: [Millis] = emergencyUntil.map { [$0] } ?? []

        for c in config.commitments {
            guard let w = lt.windowBounds(day: day, window: c.window) else {
                statuses.append(CommitmentStatus(commitment: c, day: day, windowStart: 0, windowEnd: 0, mode: .normal, requirements: [], satisfied: false, locked: false, unlockedBy: .disabled))
                continue
            }
            func stat(_ locked: Bool, _ by: UnlockReason?, mode: CommitmentStatus.Mode = .normal, reqs: [RequirementStatus] = [], satisfied: Bool = false) -> CommitmentStatus {
                CommitmentStatus(commitment: c, day: day, windowStart: w.start, windowEnd: w.end, mode: mode, requirements: reqs, satisfied: satisfied, locked: locked, unlockedBy: by)
            }
            if !c.enabled { statuses.append(stat(false, .disabled)); continue }
            guard let wd = LocalTime.weekday(day), c.days.contains(wd) else { statuses.append(stat(false, .notToday)); continue }
            if now < w.start || now >= w.end {
                if now < w.start { changes.append(w.start) }
                statuses.append(stat(false, .outsideWindow))
                continue
            }
            changes.append(w.end)

            let away = c.away != nil && honoredAwayDays(config, c, records).contains(day)
            let reqs = away ? c.away!.requirements : c.requirements
            let mode = away ? c.away!.require : c.require
            let reqStatus = reqs.map { evaluateRequirement($0, cid: c.id, day: day, proofs: proofs, config: config) }
            let satisfied = reqStatus.filter(\.ok).count >= mode.required(of: reqs.count)

            var by: UnlockReason?
            if validExcusedDays(config, c, lt).contains(day) { by = .excused }
            else if satisfied { by = .proven }
            else if records.contains(where: { r in
                if case let .unlock(b) = r.payload.body { return b.cid == c.id && b.day == day && b.until > now && r.payload.iat <= now }
                return false
            }) { by = .unlockRecord }
            else if emergencyUntil != nil { by = .emergency }
            statuses.append(stat(by == nil, by, mode: away ? .away : .normal, reqs: reqStatus, satisfied: satisfied))
        }
        let future = changes.filter { $0 > now }
        return LockState(locked: statuses.contains { $0.locked }, commitments: statuses, emergencyUntil: emergencyUntil, nextChangeAt: future.min())
    }

    public static func streak(config: Config, records: [SignedRecord], now: Millis, commitmentId: String, time lt: LocalTime = LocalTime(), maxDays: Int = 365) -> Int {
        guard let c = config.commitments.first(where: { $0.id == commitmentId }) else { return 0 }
        let proofs = proofs(records)
        let excused = validExcusedDays(config, c, lt)
        let awayDays = c.away != nil ? honoredAwayDays(config, c, records) : []
        var emergencyDays = Set<DayKey>()
        for r in records { if case let .emergency(b) = r.payload.body { emergencyDays.insert(b.day) } }
        var count = 0
        var t = now
        for i in 0..<maxDays {
            defer { t -= 86_400_000 }
            let day = lt.dayKey(t)
            guard let wd = LocalTime.weekday(day), c.days.contains(wd) else { continue }
            if excused.contains(day) { continue }
            let away = c.away != nil && awayDays.contains(day)
            let reqs = away ? c.away!.requirements : c.requirements
            let mode = away ? c.away!.require : c.require
            let ok = reqs.map { evaluateRequirement($0, cid: c.id, day: day, proofs: proofs, config: config).ok }.filter { $0 }.count
            let proven = ok >= mode.required(of: reqs.count) && !emergencyDays.contains(day)
            if proven { count += 1 } else if i == 0 { continue } else { break }
        }
        return count
    }

    /// While locked you can't edit your way out (same rules as the TS core).
    public static func configChangeBlockedWhileLocked(prev: Config, next: Config, state: LockState) -> String? {
        guard state.locked else { return nil }
        for s in state.commitments where s.locked {
            guard let after = next.commitments.first(where: { $0.id == s.commitment.id }) else {
                return "\"\(s.commitment.title)\" is locked right now; it can't be deleted until you've unlocked it."
            }
            let before = prev.commitments.first(where: { $0.id == s.commitment.id })
            if before != after { return "\"\(s.commitment.title)\" is locked right now; edit it after you've unlocked it." }
            var used = Set((after.requirements + (after.away?.requirements ?? [])).flatMap(\.placeIds))
            if let a = after.away { used.insert(a.regionPlaceId) }
            for id in used where prev.places.first(where: { $0.id == id }) != next.places.first(where: { $0.id == id }) {
                return "A place used by a locked commitment can't be moved or resized until you've unlocked."
            }
        }
        if next.essentials.apps.contains(where: { !prev.essentials.apps.contains($0) }) || next.essentials.sites.contains(where: { !prev.essentials.sites.contains($0) }) {
            return "You can't add essentials while locked. Add them after you've unlocked."
        }
        let p = prev.policy, n = next.policy
        if n.maxExcusedPerMonth > p.maxExcusedPerMonth || n.maxAwayDaysPerMonth > p.maxAwayDaysPerMonth || n.emergencyMinutes > p.emergencyMinutes ||
            n.awayOutsideFraction < p.awayOutsideFraction || n.awayMinHours < p.awayMinHours || n.minAnswerMs < p.minAnswerMs {
            return "Rules can't be loosened while locked."
        }
        if let today = state.commitments.first?.day {
            let added = next.excused.filter { e in !prev.excused.contains { $0.day == e.day } }
            if added.contains(where: { $0.day <= today }) { return "Excused days must be set in advance, not for today." }
        }
        return nil
    }
}
