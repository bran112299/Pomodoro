import Foundation
import ProveCore
import Security

/// Where things live:
///  - App Group container (shared with the Screen Time extension): ledger, shield plan, selection
///  - App container: decks, settings, location samples, reference photos
///  - Keychain: the device key (a Secure Enclave handle when available)
enum Storage {
    static let appGroup = "group.com.provetounlock.shared"

    static var shared: URL {
        if let u = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) { return u }
        // Builds without the App Group entitlement (e.g. some sideloads): fall back to the app's
        // own container. The Screen Time extension then can't read the plan, so locks are only
        // updated while the app runs.
        return local
    }

    static var local: URL {
        let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ProveToUnlock", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    static var hasAppGroup: Bool { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) != nil }

    static func read<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONCoding.decoder().decode(T.self, from: data)
    }

    static func write<T: Encodable>(_ value: T, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONCoding.encoder().encode(value).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static var ledgerURL: URL { shared.appendingPathComponent("ledger.json") }
    static var planURL: URL { shared.appendingPathComponent("shield-plan.json") }
    static var selectionURL: URL { shared.appendingPathComponent("selection.json") }
    static var settingsURL: URL { shared.appendingPathComponent("settings.json") }
    static var samplesURL: URL { local.appendingPathComponent("location-samples.json") }
    static var visitsURL: URL { local.appendingPathComponent("visits.json") }
    static var decksDir: URL { local.appendingPathComponent("decks", isDirectory: true) }
    static var referencesDir: URL { local.appendingPathComponent("references", isDirectory: true) }

    static func deckURL(_ id: String) -> URL {
        decksDir.appendingPathComponent(id.replacingOccurrences(of: "[^A-Za-z0-9_-]", with: "_", options: .regularExpression) + ".json")
    }

    static func loadDecks() -> [Deck] {
        let files = (try? FileManager.default.contentsOfDirectory(at: decksDir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }.compactMap { read(Deck.self, from: $0) }.sorted { $0.name < $1.name }
    }
}

/// The device key lives in the Keychain. On real devices it's a Secure Enclave key (the private
/// key can't be extracted at all); elsewhere a software P-256 key.
enum KeyStore {
    private static let service = "com.provetounlock.devicekey"
    private static let account = "primary"

    static func loadOrCreate() throws -> DeviceKey {
        if let stored = read() {
            let kind = stored.first
            let body = stored.dropFirst()
            if kind == 1, let k = try? SecureEnclaveKey(dataRepresentation: Data(body)) { return k }
            if kind == 0, let k = try? SoftwareKey(rawRepresentation: Data(body)) { return k }
        }
        if SecureEnclaveKey.isAvailable, let k = try? SecureEnclaveKey() {
            try save(Data([1]) + k.dataRepresentation)
            return k
        }
        let k = SoftwareKey()
        try save(Data([0]) + k.rawRepresentation)
        return k
    }

    private static func read() -> Data? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true]
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    private static func save(_ data: Data) throws {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
}

struct AppSettings: Codable, Equatable {
    var testMode = true
    var onboarded = false
    var newCardsPerDay = 20
    /// "Everything except essentials" (true) or "only the selected apps" (false).
    var blockAllExceptSelected = true
}
