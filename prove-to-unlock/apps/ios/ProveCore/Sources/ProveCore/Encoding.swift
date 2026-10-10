import Foundation

public extension Data {
    /// base64url without padding (RFC 4648 §5).
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Accepts base64url or standard base64, with or without padding.
    init?(base64URLEncoded s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b = b.replacingOccurrences(of: "=", with: "")
        let rem = b.count % 4
        if rem == 1 { return nil }
        if rem > 0 { b += String(repeating: "=", count: 4 - rem) }
        self.init(base64Encoded: b)
    }

    var hexString: String { map { String(format: "%02x", $0) }.joined() }

    init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var out = Data(capacity: hex.count / 2)
        var idx = hex.startIndex
        while idx < hex.endIndex {
            let next = hex.index(idx, offsetBy: 2)
            guard let b = UInt8(hex[idx..<next], radix: 16) else { return nil }
            out.append(b)
            idx = next
        }
        self = out
    }
}

/// JSON coding that matches the TypeScript side (plain numbers for ms timestamps).
public enum JSONCoding {
    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }

    public static func decoder() -> JSONDecoder { JSONDecoder() }
}

/// Milliseconds since the Unix epoch, like JavaScript's Date.now().
public typealias Millis = Int64

public func nowMillis() -> Millis { Millis((Date().timeIntervalSince1970 * 1000).rounded()) }
