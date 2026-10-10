import Foundation

/// Signed records: base64url(payloadJSON) "." base64url(signature over the first segment's ASCII).
/// Same wire format as packages/core/src/records.ts.

public enum RecordType: String, Codable {
    case proof, unlock, emergency, config, status
}

public enum RecordBody: Equatable {
    case proof(ProofBody)
    case unlock(UnlockBody)
    case emergency(EmergencyBody)
    case config(Config)
    case status(StatusBody)

    public var type: RecordType {
        switch self {
        case .proof: return .proof
        case .unlock: return .unlock
        case .emergency: return .emergency
        case .config: return .config
        case .status: return .status
        }
    }
}

public struct RecordPayload: Codable, Equatable {
    public var v: Int
    public var id: String
    public var iss: String
    public var iat: Millis
    public var body: RecordBody
    public var typ: RecordType { body.type }

    private enum K: String, CodingKey { case v, typ, id, iss, iat, body }

    public init(id: String, iss: String, iat: Millis, body: RecordBody) {
        v = 1
        self.id = id
        self.iss = iss
        self.iat = iat
        self.body = body
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        v = try c.decode(Int.self, forKey: .v)
        id = try c.decode(String.self, forKey: .id)
        iss = try c.decode(String.self, forKey: .iss)
        iat = try c.decode(Millis.self, forKey: .iat)
        switch try c.decode(RecordType.self, forKey: .typ) {
        case .proof: body = .proof(try c.decode(ProofBody.self, forKey: .body))
        case .unlock: body = .unlock(try c.decode(UnlockBody.self, forKey: .body))
        case .emergency: body = .emergency(try c.decode(EmergencyBody.self, forKey: .body))
        case .config: body = .config(try c.decode(Config.self, forKey: .body))
        case .status: body = .status(try c.decode(StatusBody.self, forKey: .body))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(v, forKey: .v)
        try c.encode(typ, forKey: .typ)
        try c.encode(id, forKey: .id)
        try c.encode(iss, forKey: .iss)
        try c.encode(iat, forKey: .iat)
        switch body {
        case let .proof(b): try c.encode(b, forKey: .body)
        case let .unlock(b): try c.encode(b, forKey: .body)
        case let .emergency(b): try c.encode(b, forKey: .body)
        case let .config(b): try c.encode(b, forKey: .body)
        case let .status(b): try c.encode(b, forKey: .body)
        }
    }
}

public struct SignedRecord: Equatable {
    public let raw: String
    public let payload: RecordPayload
}

public enum VerifyFailure: String, Error {
    case malformed, tooLarge = "too-large", badVersion = "bad-version", unknownType = "unknown-type"
    case untrustedIssuer = "untrusted-issuer", badSignature = "bad-signature", fromFuture = "from-future"
}

public enum Records {
    public static let maxFutureSkewMs: Millis = 5 * 60 * 1000
    public static let maxRecordBytes = 64 * 1024

    public static func create(_ identity: Identity, body: RecordBody, now: Millis = nowMillis()) throws -> SignedRecord {
        let payload = RecordPayload(id: randomId(), iss: identity.deviceId, iat: now, body: body)
        let json = try JSONCoding.encoder().encode(payload)
        let head = json.base64URLEncodedString()
        let sig = try identity.key.sign(Data(head.utf8))
        return SignedRecord(raw: "\(head).\(sig.base64URLEncodedString())", payload: payload)
    }

    /// Verify against trusted device public keys (deviceId -> SPKI base64).
    public static func verify(_ raw: String, trusted: [String: String], now: Millis = nowMillis()) -> Result<SignedRecord, VerifyFailure> {
        if raw.utf8.count > maxRecordBytes { return .failure(.tooLarge) }
        let parts = raw.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty,
              let json = Data(base64URLEncoded: String(parts[0])),
              let sig = Data(base64URLEncoded: String(parts[1]))
        else { return .failure(.malformed) }

        // Check the envelope before full decoding so unknown types / versions get precise errors.
        guard let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { return .failure(.malformed) }
        guard (obj["v"] as? Int) == 1 else { return .failure(.badVersion) }
        guard let typ = obj["typ"] as? String, RecordType(rawValue: typ) != nil else { return .failure(.unknownType) }
        guard let iss = obj["iss"] as? String else { return .failure(.malformed) }
        guard let key = trusted[iss] else { return .failure(.untrustedIssuer) }
        guard DeviceIdentity.verify(publicKeyBase64: key, signature: sig, data: Data(String(parts[0]).utf8)) else { return .failure(.badSignature) }
        guard let payload = try? JSONCoding.decoder().decode(RecordPayload.self, from: json) else { return .failure(.malformed) }
        // (Written as a subtraction so `now: .max` — "accept any time" — can't overflow.)
        if payload.iat - maxFutureSkewMs > now { return .failure(.fromFuture) }
        return .success(SignedRecord(raw: raw, payload: payload))
    }

    /// Decode without verifying (display/debug only).
    public static func parseUnverified(_ raw: String) -> RecordPayload? {
        guard let head = raw.split(separator: ".").first, let json = Data(base64URLEncoded: String(head)) else { return nil }
        return try? JSONCoding.decoder().decode(RecordPayload.self, from: json)
    }
}
