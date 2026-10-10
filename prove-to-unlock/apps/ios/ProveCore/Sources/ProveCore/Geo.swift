import Foundation

/// Places, the reachable-region ("away") policy and barometer floor checks. Port of geo.ts.

public struct LatLon: Codable, Equatable {
    public var lat: Double
    public var lon: Double
    public init(lat: Double, lon: Double) {
        self.lat = lat
        self.lon = lon
    }
}

public struct LocationSample: Codable, Equatable {
    public var t: Millis
    public var lat: Double
    public var lon: Double
    public var accuracyM: Double?
    public init(t: Millis, lat: Double, lon: Double, accuracyM: Double? = nil) {
        self.t = t
        self.lat = lat
        self.lon = lon
        self.accuracyM = accuracyM
    }
}

public enum Containment: String, Codable { case inside, outside, uncertain }

public enum Geo {
    static let earthRadiusM = 6_371_008.8

    private static func rad(_ d: Double) -> Double { d * .pi / 180 }

    public static func distanceM(_ a: LatLon, _ b: LatLon) -> Double {
        let dLat = rad(b.lat - a.lat)
        let dLon = rad(b.lon - a.lon)
        let h = pow(sin(dLat / 2), 2) + cos(rad(a.lat)) * cos(rad(b.lat)) * pow(sin(dLon / 2), 2)
        return 2 * earthRadiusM * asin(min(1, sqrt(h)))
    }

    public static func containment(_ place: Place, lat: Double, lon: Double, accuracyM: Double? = nil) -> Containment {
        let d = distanceM(LatLon(lat: place.lat, lon: place.lon), LatLon(lat: lat, lon: lon))
        let acc = max(0, accuracyM ?? 0)
        if d + acc <= place.radiusM { return .inside }
        if d - acc > place.radiusM { return .outside }
        return acc > place.radiusM ? .uncertain : (d <= place.radiusM ? .inside : .outside)
    }

    public struct AwayAssessment: Codable, Equatable {
        public enum Region: String, Codable { case `in`, away, unknown }
        public var region: Region
        public var outsideFraction: Double
        public var spanHours: Double
    }

    public static func assessAway(_ samples: [LocationSample], region: Place, from: Millis, to: Millis, outsideFraction: Double, minHours: Double, maxGapMs: Millis = 2 * 3_600_000) -> AwayAssessment {
        let pts = samples.filter { $0.t >= from && $0.t <= to }.sorted { $0.t < $1.t }
        if pts.isEmpty { return AwayAssessment(region: .unknown, outsideFraction: 0, spanHours: 0) }
        var covered: Double = 0
        var outside: Double = 0
        for (i, s) in pts.enumerated() {
            let next = i + 1 < pts.count ? pts[i + 1].t : min(to, s.t + maxGapMs)
            let dt = Double(max(0, min(next - s.t, maxGapMs)))
            let c = containment(region, lat: s.lat, lon: s.lon, accuracyM: s.accuracyM)
            if c == .uncertain { continue }
            covered += dt
            if c == .outside { outside += dt }
        }
        let spanHours = covered / 3_600_000
        let frac = covered > 0 ? outside / covered : 0
        if spanHours < minHours { return AwayAssessment(region: .unknown, outsideFraction: frac, spanHours: spanHours) }
        return AwayAssessment(region: frac >= outsideFraction ? .away : .in, outsideFraction: frac, spanHours: spanHours)
    }

    public struct AltitudeSample: Codable, Equatable {
        public var t: Millis
        public var relM: Double
        public init(t: Millis, relM: Double) {
            self.t = t
            self.relM = relM
        }
    }

    public struct FloorResult: Equatable {
        public var ok: Bool
        public var deltaM: Double
        public var requiredM: Double
        public var reason: String?
    }

    static func median(_ xs: [Double]) -> Double {
        let s = xs.sorted()
        let m = s.count / 2
        return s.count % 2 == 1 ? s[m] : (s[m - 1] + s[m]) / 2
    }

    /// Relative barometric change between the start and end of a session (robust medians).
    public static func evaluateFloorChange(_ samples: [AltitudeSample], _ req: AltitudeRequirement, edgeMs: Millis = 5000, maxSessionMs: Millis = 30 * 60_000) -> FloorResult {
        let perFloor = req.metersPerFloor ?? 3
        let tol = req.toleranceM ?? 1
        let requiredM = req.floors * perFloor
        let pts = samples.sorted { $0.t < $1.t }
        guard pts.count >= 4, let t0 = pts.first?.t, let t1 = pts.last?.t else {
            return FloorResult(ok: false, deltaM: 0, requiredM: requiredM, reason: "not enough altimeter readings")
        }
        if t1 - t0 > maxSessionMs {
            return FloorResult(ok: false, deltaM: 0, requiredM: requiredM, reason: "session too long; the weather can drift that far")
        }
        let head = pts.filter { $0.t - t0 <= edgeMs }.map(\.relM)
        let tail = pts.filter { t1 - $0.t <= edgeMs }.map(\.relM)
        let deltaM = median(tail) - median(head)
        let signed = req.direction == .down ? -deltaM : deltaM
        let ok = signed >= requiredM - tol
        if ok { return FloorResult(ok: true, deltaM: deltaM, requiredM: requiredM, reason: nil) }
        let moved = String(format: "%.1f", abs(deltaM))
        return FloorResult(ok: false, deltaM: deltaM, requiredM: requiredM, reason: "moved \(moved) m \(deltaM < 0 ? "down" : "up"); need \(formatNumber(requiredM)) m \(req.direction.rawValue)")
    }
}

/// Format like JavaScript's default number-to-string for the values we show (no trailing ".0").
public func formatNumber(_ x: Double) -> String {
    if x == x.rounded() && abs(x) < 1e15 { return String(Int64(x)) }
    return String(x)
}
