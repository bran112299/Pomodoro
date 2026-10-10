import Foundation

/// Local-time helpers matching packages/core/src/time.ts. Commitments are wall-clock windows on
/// local calendar days, evaluated in the device's time zone (or an explicit one).
public struct LocalTime {
    public let timeZone: TimeZone
    private let calendar: Calendar

    public init(timeZone: TimeZone = .current) {
        self.timeZone = timeZone
        var c = Calendar(identifier: .gregorian)
        c.timeZone = timeZone
        calendar = c
    }

    public init?(identifier: String) {
        guard let tz = TimeZone(identifier: identifier) else { return nil }
        self.init(timeZone: tz)
    }

    private func date(_ ms: Millis) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }
    private func millis(_ d: Date) -> Millis { Millis((d.timeIntervalSince1970 * 1000).rounded()) }

    public func dayKey(_ ms: Millis) -> DayKey {
        let c = calendar.dateComponents([.year, .month, .day], from: date(ms))
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    public static func parseDayKey(_ day: DayKey) -> (year: Int, month: Int, day: Int)? {
        let p = day.split(separator: "-")
        guard p.count == 3, let y = Int(p[0]), let m = Int(p[1]), let d = Int(p[2]), p[0].count == 4, p[1].count == 2, p[2].count == 2 else { return nil }
        return (y, m, d)
    }

    /// "HH:MM" -> minutes. "24:00" allowed.
    public static func parseTimeOfDay(_ t: String) -> Int? {
        let p = t.split(separator: ":")
        guard p.count == 2, let h = Int(p[0]), let m = Int(p[1]), p[1].count == 2, (1...2).contains(p[0].count) else { return nil }
        guard m <= 59, h <= 24, !(h == 24 && m != 0) else { return nil }
        return h * 60 + m
    }

    /// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
    static func daysFromCivil(_ y0: Int, _ m: Int, _ d: Int) -> Int {
        let y = m <= 2 ? y0 - 1 : y0
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    private func offsetMs(_ ms: Millis) -> Millis {
        Millis(timeZone.secondsFromGMT(for: date(ms))) * 1000
    }

    /// Epoch ms of a wall-clock time on a day. Same algorithm as the TS core: DST gaps shift
    /// forward by the gap (02:30 -> 03:30), ambiguous fall-back times take the earlier instant.
    public func epoch(day: DayKey, minutesOfDay: Int) -> Millis? {
        guard let d = LocalTime.parseDayKey(day) else { return nil }
        let wall = Millis(LocalTime.daysFromCivil(d.year, d.month, d.day)) * 86_400_000 + Millis(minutesOfDay) * 60_000
        var guess = wall - offsetMs(wall)
        guess = wall - offsetMs(guess)
        let candidates = [guess - 3_600_000, guess, guess + 3_600_000].filter { $0 + offsetMs($0) == wall }
        if let best = candidates.min() { return best }
        return wall - offsetMs(guess - 6 * 3_600_000)
    }

    public func windowBounds(day: DayKey, window: TimeWindow) -> (start: Millis, end: Millis)? {
        guard let s = LocalTime.parseTimeOfDay(window.start), let e = LocalTime.parseTimeOfDay(window.end), e > s,
              let start = epoch(day: day, minutesOfDay: s), let end = epoch(day: day, minutesOfDay: e)
        else { return nil }
        return (start, end)
    }

    /// 0 = Sunday ... 6 = Saturday.
    public static func weekday(_ day: DayKey) -> Int? {
        guard let d = parseDayKey(day) else { return nil }
        let days = daysFromCivil(d.year, d.month, d.day)
        return ((days + 4) % 7 + 7) % 7 // 1970-01-01 was a Thursday
    }

    public static func month(_ day: DayKey) -> String { String(day.prefix(7)) }
}
