import ProveCore
import SwiftUI
import VisionKit

/// Scan the QR code shown by the computer app.
struct QRScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    static var available: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        var done = false
        init(_ f: @escaping (String) -> Void) { onCode = f }
        func dataScanner(_ s: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case let .barcode(b) in items {
                if let v = b.payloadStringValue, v.hasPrefix("ptu://"), !done {
                    done = true
                    s.stopScanning()
                    onCode(v)
                }
            }
        }
    }
}

struct DevicesView: View {
    @EnvironmentObject var model: AppModel
    @State private var scanning = false
    @State private var host = ""
    @State private var port = "47123"
    @State private var code = ""
    @State private var name = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button { scanning = true } label: { Label("Scan the computer's QR code", systemImage: "qrcode.viewfinder") }
                        .disabled(!QRScanner.available)
                } header: {
                    Text("Link a computer")
                } footer: {
                    Text("In the computer app: Devices → Show pairing code. Linking works over your Wi-Fi; there's no account or cloud.")
                }
                Section("Or enter it") {
                    TextField("Computer's address (e.g. 192.168.1.20)", text: $host).keyboardType(.numbersAndPunctuation).textInputAutocapitalization(.never)
                    TextField("Port", text: $port).keyboardType(.numberPad)
                    TextField("6-digit code", text: $code).keyboardType(.numberPad)
                    Button("Link") { Task { await model.pair(hosts: [host.trimmingCharacters(in: .whitespaces)], port: Int(port) ?? LinkProtocol.defaultPort, code: code) } }
                        .disabled(host.isEmpty || code.count != 6)
                }
                Section {
                    if model.peers.isEmpty { Text("No linked devices yet.").foregroundStyle(.secondary) }
                    ForEach(model.peers) { p in
                        VStack(alignment: .leading) {
                            Label(p.name, systemImage: p.platform == .extension ? "puzzlepiece.extension" : p.platform == .ios ? "iphone" : "laptopcomputer")
                            Text(p.lastSeenAt.map { "last seen \(Date(timeIntervalSince1970: Double($0) / 1000).formatted(.relative(presentation: .named)))" } ?? "").font(.caption).foregroundStyle(.secondary)
                        }
                        .swipeActions { Button("Unlink", role: .destructive) { model.unpair(p.deviceId) } }
                    }
                    Button(model.syncing ? "Syncing…" : "Sync now") { Task { await model.syncAll() } }.disabled(model.syncing)
                } header: {
                    Text("Linked devices")
                } footer: {
                    if let s = model.lastSync { Text("Last sync \(s.formatted(date: .omitted, time: .shortened)).") }
                }
                Section("This iPhone") {
                    TextField("Name", text: $name).onSubmit { model.rename(name) }
                    LabeledContent("Fingerprint", value: model.fingerprint).font(.caption.monospaced())
                }
            }
            .navigationTitle("Devices")
            .onAppear { name = model.deviceName }
            .sheet(isPresented: $scanning) {
                QRScanner { value in
                    scanning = false
                    Task { await model.pair(qr: value) }
                }
                .ignoresSafeArea()
            }
        }
    }
}
