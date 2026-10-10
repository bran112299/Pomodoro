import CryptoKit
import Foundation

/// A device's signing key. P-256 ECDSA over SHA-256; public keys travel as SPKI DER (base64) and
/// signatures as raw r||s, exactly like WebCrypto on the desktop/extension side.
public protocol DeviceKey {
    var publicKeyDER: Data { get }
    func sign(_ data: Data) throws -> Data
}

public struct SoftwareKey: DeviceKey {
    public let privateKey: P256.Signing.PrivateKey

    public init() { privateKey = P256.Signing.PrivateKey() }
    public init(rawRepresentation: Data) throws { privateKey = try P256.Signing.PrivateKey(rawRepresentation: rawRepresentation) }

    public var rawRepresentation: Data { privateKey.rawRepresentation }
    public var publicKeyDER: Data { privateKey.publicKey.derRepresentation }
    public func sign(_ data: Data) throws -> Data { try privateKey.signature(for: data).rawRepresentation }
}

#if os(iOS) || os(macOS)
/// Hardware-backed key: the private key never leaves the Secure Enclave.
public struct SecureEnclaveKey: DeviceKey {
    public let privateKey: SecureEnclave.P256.Signing.PrivateKey

    public static var isAvailable: Bool { SecureEnclave.isAvailable }

    public init() throws { privateKey = try SecureEnclave.P256.Signing.PrivateKey() }
    public init(dataRepresentation: Data) throws { privateKey = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: dataRepresentation) }

    /// Opaque handle (not the key itself) for storing in the Keychain.
    public var dataRepresentation: Data { privateKey.dataRepresentation }
    public var publicKeyDER: Data { privateKey.publicKey.derRepresentation }
    public func sign(_ data: Data) throws -> Data { try privateKey.signature(for: data).rawRepresentation }
}
#endif

public enum DeviceIdentity {
    /// Device id = first 8 bytes of SHA-256(SPKI), hex. Derived from the key so it can't be spoofed.
    public static func deviceId(publicKeyDER: Data) -> String {
        Data(SHA256.hash(data: publicKeyDER).prefix(8)).hexString
    }

    public static func deviceId(publicKeyBase64: String) -> String? {
        guard let der = Data(base64Encoded: publicKeyBase64) else { return nil }
        return deviceId(publicKeyDER: der)
    }

    /// "3F9A-12CD-77B0-E415"
    public static func fingerprint(publicKeyDER: Data) -> String {
        let hex = Data(SHA256.hash(data: publicKeyDER).prefix(8)).hexString.uppercased()
        var groups: [String] = []
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 4)
            groups.append(String(hex[i..<j]))
            i = j
        }
        return groups.joined(separator: "-")
    }

    public static func verify(publicKeyBase64: String, signature: Data, data: Data) -> Bool {
        guard signature.count == 64,
              let der = Data(base64Encoded: publicKeyBase64),
              let key = try? P256.Signing.PublicKey(derRepresentation: der),
              let sig = try? P256.Signing.ECDSASignature(rawRepresentation: signature)
        else { return false }
        return key.isValidSignature(sig, for: data)
    }

    public static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }
}

public struct Identity {
    public let key: DeviceKey
    public let deviceId: String
    public let publicKeyBase64: String

    public init(key: DeviceKey) {
        self.key = key
        publicKeyBase64 = key.publicKeyDER.base64EncodedString()
        deviceId = DeviceIdentity.deviceId(publicKeyDER: key.publicKeyDER)
    }

    public var fingerprint: String { DeviceIdentity.fingerprint(publicKeyDER: key.publicKeyDER) }
}

public func randomId(bytes: Int = 16) -> String {
    var g = SystemRandomNumberGenerator()
    return Data((0..<bytes).map { _ in UInt8.random(in: 0...255, using: &g) }).base64URLEncodedString()
}
