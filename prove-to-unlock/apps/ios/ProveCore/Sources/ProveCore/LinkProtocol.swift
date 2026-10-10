import Foundation

/// Local-network linking protocol. Port of packages/core/src/protocol.ts.
public enum LinkProtocol {
    public static let version = 1
    public static let defaultPort = 47123
    public static let bonjourType = "_provetounlock._tcp"
    public static let authScheme = "PTU1"
    public static let authMaxSkewMs: Millis = 2 * 60_000

    static func canonical(method: String, path: String, ts: Millis, body: Data) -> Data {
        let bodyHash = DeviceIdentity.sha256(body).base64URLEncodedString()
        return Data("\(authScheme)\n\(method.uppercased())\n\(path)\n\(ts)\n\(bodyHash)".utf8)
    }

    public static func authHeader(_ id: Identity, method: String, path: String, body: Data, now: Millis = nowMillis()) throws -> String {
        let sig = try id.key.sign(canonical(method: method, path: path, ts: now, body: body))
        return "\(authScheme) deviceId=\(id.deviceId),ts=\(now),sig=\(sig.base64URLEncodedString())"
    }

    public struct ParsedAuth: Equatable {
        public var deviceId: String
        public var ts: Millis
        public var sig: String
    }

    public static func parseAuthHeader(_ h: String) -> ParsedAuth? {
        guard h.hasPrefix(authScheme + " ") else { return nil }
        var kv: [String: String] = [:]
        for part in h.dropFirst(authScheme.count + 1).split(separator: ",") {
            if let eq = part.firstIndex(of: "=") {
                kv[part[..<eq].trimmingCharacters(in: .whitespaces)] = part[part.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            }
        }
        guard let id = kv["deviceId"], let sig = kv["sig"], let tsS = kv["ts"], let ts = Millis(tsS) else { return nil }
        return ParsedAuth(deviceId: id, ts: ts, sig: sig)
    }

    /// Verify a signed request (used by tests; the phone doesn't run a server).
    public static func verifyAuth(_ header: String, method: String, path: String, body: Data, trusted: [String: String], now: Millis = nowMillis()) -> Bool {
        guard let a = parseAuthHeader(header), abs(now - a.ts) <= authMaxSkewMs, let key = trusted[a.deviceId], let sig = Data(base64URLEncoded: a.sig) else { return false }
        return DeviceIdentity.verify(publicKeyBase64: key, signature: sig, data: canonical(method: method, path: path, ts: a.ts, body: body))
    }

    public struct PairingQR: Equatable {
        public var hosts: [String]
        public var port: Int
        public var deviceId: String
        public var fingerprint: String
        public var code: String
        public var name: String
    }

    public static func decodePairingQR(_ s: String) -> PairingQR? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("ptu://pair?") else { return nil }
        // The computer builds this with URLSearchParams (application/x-www-form-urlencoded:
        // spaces become "+"), which URLComponents doesn't decode, so parse it by hand.
        var q: [String: String] = [:]
        for pair in t.dropFirst("ptu://pair?".count).split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let decode = { (s: Substring) in String(s).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String(s) }
            q[decode(kv[0])] = kv.count > 1 ? decode(kv[1]) : ""
        }
        let hosts = (q["h"] ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty }
        guard let port = Int(q["p"] ?? ""), port > 0, port < 65536, !hosts.isEmpty else { return nil }
        let id = q["id"] ?? ""
        let code = q["c"] ?? ""
        guard id.count == 16, id.allSatisfy(\.isHexDigit), code.count == 6, code.allSatisfy(\.isNumber) else { return nil }
        return PairingQR(hosts: hosts, port: port, deviceId: id, fingerprint: q["fp"] ?? "", code: code, name: q["n"] ?? "")
    }
}

public enum Platform: String, Codable { case ios, mac, windows, linux, `extension` }

public struct DeviceHello: Codable, Equatable {
    public var deviceId: String
    public var name: String
    public var platform: Platform
    public var publicKey: String
    public init(deviceId: String, name: String, platform: Platform, publicKey: String) {
        self.deviceId = deviceId
        self.name = name
        self.platform = platform
        self.publicKey = publicKey
    }

    /// Device id must be derived from the key, and the name sane.
    public var isValid: Bool {
        deviceId.count == 16 && name.count <= 100 && publicKey.count < 512 && DeviceIdentity.deviceId(publicKeyBase64: publicKey) == deviceId
    }
}

public struct InfoResponse: Codable {
    public var deviceId: String
    public var name: String
    public var platform: Platform
    public var publicKey: String
    public var protocolVersion: Int
    public var fingerprint: String
    public var pairing: Bool
    enum CodingKeys: String, CodingKey { case deviceId, name, platform, publicKey, protocolVersion = "protocol", fingerprint, pairing }
}

public struct PairRequest: Codable {
    public var code: String
    public var device: DeviceHello
}

public struct PairResponse: Codable {
    public var device: DeviceHello
}

public struct SyncCursor: Codable, Equatable {
    public var records: Int
    public var reviews: Int
    public static let zero = SyncCursor(records: 0, reviews: 0)
}

public struct SyncRequest: Codable {
    public var records: [String]
    public var reviews: [ReviewEvent]
    public var since: SyncCursor
}

public struct SyncResponse: Codable {
    public var records: [String]
    public var reviews: [ReviewEvent]
    public var cursor: SyncCursor
    public var accepted: Int
    public var rejected: Int
}

public struct TrustResponse: Codable {
    public var devices: [DeviceHello]
}

public struct DeckSummary: Codable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var cards: Int
    public var importedAt: Millis
}
