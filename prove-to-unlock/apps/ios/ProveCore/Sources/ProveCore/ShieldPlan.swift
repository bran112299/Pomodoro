import Foundation

/// What the Screen Time monitor extension needs to decide, on its own and without the app
/// running, whether apps should be shielded right now.
///
/// The app recomputes this whenever anything changes (proofs, sync, config) and writes it to the
/// shared App Group container. The extension never verifies signatures itself (it has a tiny
/// memory budget); it trusts this precomputed plan, which only ever *removes* locks that the app
/// already verified, and fails open (no shield) if the plan is missing or stale beyond a day.
public struct ShieldPlan: Codable, Equatable {
    public struct Window: Codable, Equatable {
        public var commitmentId: String
        public var title: String
        public var days: [Int]
        public var start: String
        public var end: String
    }

    public var generatedAt: Millis
    public var timeZone: String
    public var testMode: Bool
    public var windows: [Window]
    /// commitment id -> days on which it's already proven or excused.
    public var done: [String: [DayKey]]
    public var emergencyUntil: Millis?

    public init(generatedAt: Millis, timeZone: String, testMode: Bool, windows: [Window], done: [String: [DayKey]], emergencyUntil: Millis?) {
        self.generatedAt = generatedAt
        self.timeZone = timeZone
        self.testMode = testMode
        self.windows = windows
        self.done = done
        self.emergencyUntil = emergencyUntil
    }

    /// Build from verified state. `days` = how many days ahead to precompute "done" for (proofs
    /// can't exist for future days, but excused days can).
    public static func make(config: Config, records: [SignedRecord], now: Millis, time lt: LocalTime = LocalTime(), testMode: Bool, daysAhead: Int = 7) -> ShieldPlan {
        var done: [String: [DayKey]] = [:]
        let proofs = Engine.proofs(records)
        for c in config.commitments where c.enabled {
            let excused = Engine.validExcusedDays(config, c, lt)
            let awayDays = c.away != nil ? Engine.honoredAwayDays(config, c, records) : []
            for i in 0...daysAhead {
                let day = lt.dayKey(now + Millis(i) * 86_400_000)
                if excused.contains(day) { done[c.id, default: []].append(day); continue }
                let away = c.away != nil && awayDays.contains(day)
                let reqs = away ? c.away!.requirements : c.requirements
                let mode = away ? c.away!.require : c.require
                let ok = reqs.map { Engine.evaluateRequirement($0, cid: c.id, day: day, proofs: proofs, config: config).ok }.filter { $0 }.count
                let unlocked = records.contains { r in
                    if case let .unlock(b) = r.payload.body { return b.cid == c.id && b.day == day }
                    return false
                }
                if ok >= mode.required(of: reqs.count) || unlocked { done[c.id, default: []].append(day) }
            }
        }
        let state = Engine.evaluate(config: config, records: records, now: now, time: lt)
        return ShieldPlan(
            generatedAt: now,
            timeZone: lt.timeZone.identifier,
            testMode: testMode,
            windows: config.commitments.filter(\.enabled).map { Window(commitmentId: $0.id, title: $0.title, days: $0.days, start: $0.window.start, end: $0.window.end) },
            done: done,
            emergencyUntil: state.emergencyUntil
        )
    }

    /// Should apps be shielded at `now`? Fails open on anything unexpected.
    public func shouldShield(now: Millis) -> Bool {
        if testMode { return false }
        if let e = emergencyUntil, e > now { return false }
        // A plan older than two days is stale (app hasn't run); don't keep someone locked on it.
        if now - generatedAt > 2 * 86_400_000 { return false }
        guard let lt = LocalTime(identifier: timeZone) else { return false }
        let day = lt.dayKey(now)
        guard let wd = LocalTime.weekday(day) else { return false }
        for w in windows where w.days.contains(wd) {
            guard let b = lt.windowBounds(day: day, window: TimeWindow(start: w.start, end: w.end)) else { continue }
            if now >= b.start && now < b.end && !(done[w.commitmentId]?.contains(day) ?? false) { return true }
        }
        return false
    }
}
