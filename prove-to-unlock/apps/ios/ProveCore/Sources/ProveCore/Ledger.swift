import Foundation

/// The phone's local state: paired devices, every record and review it knows, with sequence
/// numbers for incremental sync. Port of packages/core/src/ledger.ts. The private key is kept
/// separately (Keychain / Secure Enclave); this struct only stores public data, so the Screen
/// Time extension can read it from the shared App Group container.

public struct PeerInfo: Codable, Equatable, Identifiable {
    public var deviceId: String
    public var name: String
    public var platform: Platform
    public var publicKey: String
    public var addedAt: Millis
    public var lastSeenAt: Millis?
    public var hosts: [String]?
    public var port: Int?
    public var pushed: SyncCursor
    public var pulled: SyncCursor
    public var id: String { deviceId }

    public var hello: DeviceHello { DeviceHello(deviceId: deviceId, name: name, platform: platform, publicKey: publicKey) }
}

public struct LedgerData: Codable, Equatable {
    public var version: Int
    public var deviceId: String
    public var publicKey: String
    public var name: String
    public var peers: [PeerInfo]
    public var records: [StoredRecord]
    public var reviews: [StoredReview]
    public var seq: Int

    public struct StoredRecord: Codable, Equatable {
        public var seq: Int
        public var raw: String
        public var receivedAt: Millis
    }

    public struct StoredReview: Codable, Equatable {
        public var seq: Int
        public var event: ReviewEvent
    }
}

public enum LedgerError: Error, LocalizedError {
    case unknownPeer, idMismatch, selfPairing, wrongIdentity
    public var errorDescription: String? {
        switch self {
        case .unknownPeer: return "That device isn't linked."
        case .idMismatch: return "The other device's id doesn't match its key."
        case .selfPairing: return "A device can't link with itself."
        case .wrongIdentity: return "Saved data belongs to a different device key."
        }
    }
}

public final class Ledger {
    public private(set) var data: LedgerData
    public let identity: Identity?
    private var parsed: [String: SignedRecord] = [:]
    private var recordIds = Set<String>()
    private var reviewIds = Set<String>()
    private var cache: [SignedRecord]?

    /// Full ledger (can sign). `identity` must match the stored device id.
    public init(identity: Identity, data: LedgerData? = nil, name: String = "iPhone") throws {
        self.identity = identity
        if let d = data {
            guard d.deviceId == identity.deviceId else { throw LedgerError.wrongIdentity }
            self.data = d
        } else {
            self.data = LedgerData(version: 1, deviceId: identity.deviceId, publicKey: identity.publicKeyBase64, name: name, peers: [], records: [], reviews: [], seq: 0)
        }
        reindex()
    }

    /// Read-only ledger (e.g. in the Screen Time extension): can evaluate but not sign.
    public init(readOnly data: LedgerData) {
        identity = nil
        self.data = data
        reindex()
    }

    private func reindex() {
        let trusted = trustedKeys()
        for r in data.records {
            if case let .success(rec) = Records.verify(r.raw, trusted: trusted, now: .max) {
                parsed[r.raw] = rec
                recordIds.insert(rec.payload.id)
            }
        }
        for r in data.reviews { reviewIds.insert(r.event.id) }
        cache = nil
    }

    public var deviceId: String { data.deviceId }
    public var name: String {
        get { data.name }
        set { data.name = String(newValue.prefix(100)) }
    }
    public var seq: Int { data.seq }
    public var hello: DeviceHello { DeviceHello(deviceId: data.deviceId, name: data.name, platform: .ios, publicKey: data.publicKey) }

    // MARK: peers

    public var peers: [PeerInfo] { data.peers }
    public func peer(_ id: String) -> PeerInfo? { data.peers.first { $0.deviceId == id } }

    public func trustedKeys() -> [String: String] {
        var m = [data.deviceId: data.publicKey]
        for p in data.peers { m[p.deviceId] = p.publicKey }
        return m
    }

    @discardableResult
    public func addPeer(_ hello: DeviceHello, hosts: [String]? = nil, port: Int? = nil, now: Millis = nowMillis()) throws -> PeerInfo {
        guard hello.isValid else { throw LedgerError.idMismatch }
        guard hello.deviceId != data.deviceId else { throw LedgerError.selfPairing }
        if let i = data.peers.firstIndex(where: { $0.deviceId == hello.deviceId }) {
            data.peers[i].name = hello.name
            data.peers[i].platform = hello.platform
            if let h = hosts { data.peers[i].hosts = h }
            if let p = port { data.peers[i].port = p }
            data.peers[i].lastSeenAt = now
            cache = nil
            return data.peers[i]
        }
        let p = PeerInfo(deviceId: hello.deviceId, name: hello.name, platform: hello.platform, publicKey: hello.publicKey, addedAt: now, lastSeenAt: now, hosts: hosts, port: port, pushed: .zero, pulled: .zero)
        data.peers.append(p)
        reindex()
        return p
    }

    public func updatePeerAddress(_ id: String, hosts: [String], port: Int) {
        guard let i = data.peers.firstIndex(where: { $0.deviceId == id }) else { return }
        data.peers[i].hosts = hosts
        data.peers[i].port = port
    }

    public func removePeer(_ id: String) {
        data.peers.removeAll { $0.deviceId == id }
        cache = nil
    }

    // MARK: records

    public func records() -> [SignedRecord] {
        if let c = cache { return c }
        let trusted = trustedKeys()
        let r = data.records.compactMap { parsed[$0.raw] }.filter { trusted[$0.payload.iss] != nil }
        cache = r
        return r
    }

    @discardableResult
    public func issue(_ body: RecordBody, now: Millis = nowMillis()) throws -> SignedRecord {
        guard let id = identity else { throw LedgerError.wrongIdentity }
        let rec = try Records.create(id, body: body, now: now)
        insert(rec, now: now)
        return rec
    }

    private func insert(_ rec: SignedRecord, now: Millis) {
        data.seq += 1
        data.records.append(.init(seq: data.seq, raw: rec.raw, receivedAt: now))
        parsed[rec.raw] = rec
        recordIds.insert(rec.payload.id)
        cache = nil
    }

    @discardableResult
    public func addRecords(_ raws: [String], now: Millis = nowMillis()) -> (accepted: Int, rejected: Int) {
        let trusted = trustedKeys()
        var a = 0, r = 0
        for raw in raws.prefix(5000) {
            switch Records.verify(raw, trusted: trusted, now: now) {
            case let .success(rec):
                if recordIds.contains(rec.payload.id) { continue }
                insert(rec, now: now)
                a += 1
            case .failure:
                r += 1
            }
        }
        return (a, r)
    }

    // MARK: reviews

    public func reviews() -> [ReviewEvent] { data.reviews.map(\.event) }

    @discardableResult
    public func addReviews(_ events: [ReviewEvent]) -> Int {
        var n = 0
        for e in events.prefix(50_000) where !reviewIds.contains(e.id) && e.id.count <= 64 {
            data.seq += 1
            data.reviews.append(.init(seq: data.seq, event: e))
            reviewIds.insert(e.id)
            n += 1
        }
        return n
    }

    // MARK: config

    public func config() -> Config {
        var best: (Config, String)?
        for r in records() {
            guard case let .config(c) = r.payload.body else { continue }
            if let (b, bid) = best {
                if c.rev > b.rev || (c.rev == b.rev && (c.updatedAt > b.updatedAt || (c.updatedAt == b.updatedAt && r.payload.id > bid))) { best = (c, r.payload.id) }
            } else {
                best = (c, r.payload.id)
            }
        }
        return best?.0 ?? .makeDefault()
    }

    @discardableResult
    public func updateConfig(now: Millis = nowMillis(), _ mutate: (inout Config) -> Void) throws -> Config {
        var c = config()
        mutate(&c)
        c.rev = config().rev + 1
        c.updatedAt = now
        try issue(.config(c), now: now)
        return c
    }

    // MARK: sync

    public func syncRequest(for peerId: String) throws -> SyncRequest {
        guard let p = peer(peerId) else { throw LedgerError.unknownPeer }
        return SyncRequest(
            records: data.records.filter { $0.seq > p.pushed.records }.map(\.raw),
            reviews: data.reviews.filter { $0.seq > p.pushed.reviews }.map(\.event),
            since: p.pulled
        )
    }

    public func applySyncResponse(peerId: String, sentUpTo: Int, response: SyncResponse, now: Millis = nowMillis()) throws {
        guard let i = data.peers.firstIndex(where: { $0.deviceId == peerId }) else { throw LedgerError.unknownPeer }
        addRecords(response.records, now: now)
        addReviews(response.reviews)
        data.peers[i].pushed = SyncCursor(records: sentUpTo, reviews: sentUpTo)
        data.peers[i].pulled = SyncCursor(records: max(data.peers[i].pulled.records, response.cursor.records), reviews: max(data.peers[i].pulled.reviews, response.cursor.reviews))
        data.peers[i].lastSeenAt = now
    }
}
