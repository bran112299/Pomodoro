import Foundation

/// Photo proof checks: dHash repeat detection, labels, "my place" similarity. Port of photo.ts.
public enum PhotoCheck {
    public static let defaultRepeatMaxHamming = 8
    public static let defaultMinLabelConfidence = 0.3
    public static let screenLabels = ["monitor", "screen", "television", "computer display", "display", "laptop", "notebook computer"]

    /// BT.601 luma from RGBA bytes.
    public static func gray(rgba: [UInt8], width: Int, height: Int) -> [Double] {
        var out = [Double](repeating: 0, count: width * height)
        var p = 0
        for i in 0..<(width * height) {
            out[i] = 0.299 * Double(rgba[p]) + 0.587 * Double(rgba[p + 1]) + 0.114 * Double(rgba[p + 2])
            p += 4
        }
        return out
    }

    /// Exact area-average resampling.
    public static func areaResize(_ g: [Double], w: Int, h: Int, ow: Int, oh: Int) -> [Double] {
        var out = [Double](repeating: 0, count: ow * oh)
        let sx = Double(w) / Double(ow)
        let sy = Double(h) / Double(oh)
        for oy in 0..<oh {
            let y0 = Double(oy) * sy, y1 = y0 + sy
            for ox in 0..<ow {
                let x0 = Double(ox) * sx, x1 = x0 + sx
                var sum = 0.0, area = 0.0
                var y = Int(y0.rounded(.down))
                while Double(y) < y1.rounded(.up) && y < h {
                    let wy = min(Double(y + 1), y1) - max(Double(y), y0)
                    if wy > 0 {
                        var x = Int(x0.rounded(.down))
                        while Double(x) < x1.rounded(.up) && x < w {
                            let wx = min(Double(x + 1), x1) - max(Double(x), x0)
                            if wx > 0 {
                                sum += g[y * w + x] * wx * wy
                                area += wx * wy
                            }
                            x += 1
                        }
                    }
                    y += 1
                }
                out[oy * ow + ox] = area > 0 ? sum / area : 0
            }
        }
        return out
    }

    /// 64-bit difference hash as 16 hex chars.
    public static func dHash(rgba: [UInt8], width: Int, height: Int) -> String? {
        guard width >= 9, height >= 8, rgba.count >= width * height * 4 else { return nil }
        let small = areaResize(gray(rgba: rgba, width: width, height: height), w: width, h: height, ow: 9, oh: 8)
        var hex = ""
        for y in 0..<8 {
            var byte: UInt8 = 0
            for x in 0..<8 {
                byte = (byte << 1) | (small[y * 9 + x] < small[y * 9 + x + 1] ? 1 : 0)
            }
            hex += String(format: "%02x", byte)
        }
        return hex
    }

    public static func isHash(_ s: String) -> Bool {
        s.count == 16 && s.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    public static func hamming(_ a: String, _ b: String) -> Int? {
        guard isHash(a), isHash(b), let x = UInt64(a, radix: 16), let y = UInt64(b, radix: 16) else { return nil }
        return (x ^ y).nonzeroBitCount
    }

    public static func cosineSimilarity(_ a: [Double], _ b: [Double]) -> Double? {
        guard a.count == b.count, !a.isEmpty else { return nil }
        var dot = 0.0, na = 0.0, nb = 0.0
        for i in a.indices {
            dot += a[i] * b[i]
            na += a[i] * a[i]
            nb += b[i] * b[i]
        }
        return na == 0 || nb == 0 ? 0 : dot / (na * nb).squareRoot()
    }

    public struct Result: Equatable {
        public var ok: Bool
        public var failures: [String]
        public init(ok: Bool, failures: [String]) {
            self.ok = ok
            self.failures = failures
        }
    }

    static func isoDay(_ ms: Millis) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }

    public static func check(_ req: PhotoRequirement, _ d: PhotoDetail, earlier: [(dhash: String, capturedAt: Millis)], places: [Place]) -> Result {
        var failures: [String] = []
        if !d.live { failures.append("photo was not taken live in the app") }
        if !isHash(d.dhash) { failures.append("photo fingerprint missing") }
        else {
            let maxH = req.repeatMaxHamming ?? defaultRepeatMaxHamming
            if let rep = earlier.first(where: { $0.capturedAt < d.capturedAt && isHash($0.dhash) && (hamming($0.dhash, d.dhash) ?? 99) <= maxH }) {
                failures.append("looks like a repeat of a photo from \(isoDay(rep.capturedAt))")
            }
        }
        if let wanted = req.labelsAny, !wanted.isEmpty {
            let minC = req.minLabelConfidence ?? defaultMinLabelConfidence
            let w = wanted.map { $0.lowercased() }
            let hit = d.labels.contains { l in l.confidence >= minC && w.contains { l.label.lowercased().contains($0) } }
            if !hit { failures.append("didn't see any of: \(wanted.joined(separator: ", "))") }
        }
        if let top = d.labels.max(by: { $0.confidence < $1.confidence }), top.confidence >= 0.5, screenLabels.contains(where: { top.label.lowercased().contains($0) }) {
            failures.append("looks like a photo of a screen")
        }
        if let minSim = req.minReferenceSimilarity {
            if let sim = d.referenceSimilarity {
                if sim < minSim { failures.append("doesn't look like your place") }
            } else {
                failures.append("no reference photos to compare with")
            }
        }
        if let pid = req.placeId {
            if let place = places.first(where: { $0.id == pid }) {
                if d.placeId != pid || d.insidePlace != true { failures.append("not taken at \(place.name)") }
            } else {
                failures.append("the required place no longer exists")
            }
        }
        if req.challenge == true && d.challenge?.confirmed != true { failures.append("random challenge not completed") }
        return Result(ok: failures.isEmpty, failures: failures)
    }

    public static let challenges = ["Hold up 3 fingers", "Hold up 2 fingers", "Give a thumbs up", "Include something blue", "Include your left hand", "Make a fist in frame", "Point at the floor", "Include your shoes"]

    public static func randomChallenge() -> String { challenges.randomElement()! }
}
