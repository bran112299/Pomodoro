import Foundation
import Network

/// Finds linked computers on the Wi-Fi (Bonjour `_provetounlock._tcp`) so their addresses stay
/// current when DHCP hands out new ones. The TXT record carries the device id.
@MainActor
final class Discovery {
    private var browser: NWBrowser?
    private var resolving: [String: NWConnection] = [:]
    var onFound: ((String, [String], Int) -> Void)?

    func start() {
        let params = NWParameters.tcp
        params.includePeerToPeer = false
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_provetounlock._tcp", domain: nil), using: params)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in self?.handle(results) }
        }
        b.start(queue: .main)
        browser = b
    }

    func stop() {
        browser?.cancel()
        resolving.values.forEach { $0.cancel() }
        resolving.removeAll()
    }

    private func handle(_ results: Set<NWBrowser.Result>) {
        for r in results {
            guard case let .bonjour(txt) = r.metadata, let id = txt.dictionary["id"], resolving[id] == nil else { continue }
            // Resolve the service to an address by connecting briefly.
            let conn = NWConnection(to: r.endpoint, using: .tcp)
            resolving[id] = conn
            conn.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self else { return }
                    switch state {
                    case .ready:
                        if case let .hostPort(host, port) = conn.currentPath?.remoteEndpoint {
                            var h = "\(host)"
                            if let pct = h.firstIndex(of: "%") { h = String(h[..<pct]) } // strip interface scope
                            self.onFound?(id, [h], Int(port.rawValue))
                        }
                        conn.cancel()
                        self.resolving[id] = nil
                    case .failed, .cancelled:
                        self.resolving[id] = nil
                    default:
                        break
                    }
                }
            }
            conn.start(queue: .main)
        }
    }
}
