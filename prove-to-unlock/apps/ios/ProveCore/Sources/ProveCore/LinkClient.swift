import Foundation

/// Phone side of the linking protocol: pair with a computer, adopt its trusted devices, sync,
/// and download decks. Port of packages/core/src/client.ts.
public struct LinkClient {
    public struct Endpoint: Equatable {
        public var host: String
        public var port: Int
        public init(host: String, port: Int) {
            self.host = host
            self.port = port
        }
    }

    public enum ClientError: Error, LocalizedError {
        case http(Int, String)
        case invalidReply
        public var errorDescription: String? {
            switch self {
            case let .http(code, msg): return msg.isEmpty ? "HTTP \(code)" : msg
            case .invalidReply: return "The computer sent an invalid reply."
            }
        }
    }

    let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    static func url(_ e: Endpoint, _ path: String) -> URL {
        let host = e.host.contains(":") && !e.host.hasPrefix("[") ? "[\(e.host)]" : e.host
        return URL(string: "http://\(host):\(e.port)\(path)")!
    }

    private func send<T: Decodable>(_ req: URLRequest, as: T.Type) async throws -> T {
        let (data, res) = try await session.data(for: req)
        let code = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String ?? ""
            throw ClientError.http(code, msg)
        }
        return try JSONCoding.decoder().decode(T.self, from: data)
    }

    private func signed(_ ledger: Ledger, _ e: Endpoint, method: String, path: String, body: Data = Data(), timeout: TimeInterval = 15) throws -> URLRequest {
        guard let id = ledger.identity else { throw LedgerError.wrongIdentity }
        var r = URLRequest(url: Self.url(e, path), timeoutInterval: timeout)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        r.setValue(try LinkProtocol.authHeader(id, method: method, path: path, body: body), forHTTPHeaderField: "authorization")
        if method == "POST" { r.httpBody = body }
        return r
    }

    public func info(_ e: Endpoint) async throws -> InfoResponse {
        try await send(URLRequest(url: Self.url(e, "/v1/info"), timeoutInterval: 4), as: InfoResponse.self)
    }

    /// Pair using the code shown on the computer. Tries each address in turn.
    public func pair(_ ledger: Ledger, hosts: [String], port: Int, code: String) async throws -> DeviceHello {
        var lastError: Error = ClientError.invalidReply
        for host in hosts {
            let e = Endpoint(host: host, port: port)
            var r = URLRequest(url: Self.url(e, "/v1/pair"), timeoutInterval: 8)
            r.httpMethod = "POST"
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = try JSONCoding.encoder().encode(PairRequest(code: code.trimmingCharacters(in: .whitespaces), device: ledger.hello))
            do {
                let res = try await send(r, as: PairResponse.self)
                guard res.device.isValid else { throw ClientError.invalidReply }
                try ledger.addPeer(res.device, hosts: [host] + hosts.filter { $0 != host }, port: port)
                return res.device
            } catch let e as ClientError {
                throw e // the computer answered: wrong code etc.
            } catch {
                lastError = error // unreachable address; try the next one
            }
        }
        throw lastError
    }

    public func adoptTrust(_ ledger: Ledger, _ e: Endpoint) async throws {
        let res = try await send(signed(ledger, e, method: "GET", path: "/v1/trust"), as: TrustResponse.self)
        for d in res.devices where d.deviceId != ledger.deviceId && d.isValid {
            let existing = ledger.peer(d.deviceId)
            try ledger.addPeer(d, hosts: existing?.hosts, port: existing?.port)
        }
    }

    public func sync(_ ledger: Ledger, peerId: String, _ e: Endpoint) async throws {
        let req = try ledger.syncRequest(for: peerId)
        let sentUpTo = ledger.seq
        let body = try JSONCoding.encoder().encode(req)
        let res = try await send(signed(ledger, e, method: "POST", path: "/v1/sync", body: body), as: SyncResponse.self)
        try ledger.applySyncResponse(peerId: peerId, sentUpTo: sentUpTo, response: res)
    }

    public func listDecks(_ ledger: Ledger, _ e: Endpoint) async throws -> [DeckSummary] {
        struct R: Decodable { var decks: [DeckSummary] }
        return try await send(signed(ledger, e, method: "GET", path: "/v1/decks"), as: R.self).decks
    }

    public func fetchDeck(_ ledger: Ledger, _ e: Endpoint, id: String) async throws -> Deck {
        let enc = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id
        return try await send(signed(ledger, e, method: "GET", path: "/v1/decks/\(enc)", timeout: 60), as: Deck.self)
    }
}
