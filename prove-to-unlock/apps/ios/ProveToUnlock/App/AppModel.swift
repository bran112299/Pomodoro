import Combine
import FamilyControls
import Foundation
import ProveCore
import UIKit

/// App state and actions. Everything that changes state ends in `commit()`, which persists,
/// re-evaluates the lock, rewrites the Screen Time plan and pushes changes to linked computers.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var config: Config = .makeDefault()
    @Published private(set) var lock = LockState(locked: false, commitments: [], emergencyUntil: nil, nextChangeAt: nil)
    @Published private(set) var peers: [PeerInfo] = []
    @Published private(set) var decks: [Deck] = []
    @Published var settings = AppSettings()
    @Published var selection = FamilyActivitySelection()
    @Published var message: String?
    @Published var syncing = false
    @Published private(set) var lastSync: Date?

    let location = LocationService()
    let time = LocalTime()
    private(set) var ledger: Ledger!
    private var identity: Identity!
    private let client = LinkClient()
    private var timer: Timer?
    let discovery = Discovery()

    var deviceName: String { ledger?.name ?? "iPhone" }
    var fingerprint: String { identity?.fingerprint ?? "" }
    var deviceId: String { identity?.deviceId ?? "" }

    private var started = false

    func start() {
        guard !started else { return }
        started = true
        do {
            identity = Identity(key: try KeyStore.loadOrCreate())
            let saved = Storage.read(LedgerData.self, from: Storage.ledgerURL)
            ledger = try Ledger(identity: identity, data: saved?.deviceId == identity.deviceId ? saved : nil, name: UIDevice.current.name)
        } catch {
            message = "Couldn't set up this device's key: \(error.localizedDescription)"
            identity = Identity(key: SoftwareKey())
            ledger = try! Ledger(identity: identity, name: UIDevice.current.name)
        }
        settings = Storage.read(AppSettings.self, from: Storage.settingsURL) ?? AppSettings()
        selection = Shields.loadSelection()
        decks = Storage.loadDecks()
        location.onVisit = { [weak self] placeId, from, to in self?.recordVisit(placeId: placeId, from: from, to: to) }
        discovery.onFound = { [weak self] id, hosts, port in
            guard let self, self.ledger.peer(id) != nil else { return }
            self.ledger.updatePeerAddress(id, hosts: hosts, port: port)
        }
        discovery.start()
        refresh()
        location.monitor(places: placesToMonitor())
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refresh()
                await self?.syncAll()
            }
        }
        Task { await syncAll() }
    }

    // MARK: state

    func refresh(now: Millis = nowMillis()) {
        config = ledger.config()
        lock = Engine.evaluate(config: config, records: ledger.records(), now: now, time: time)
        peers = ledger.peers
        updateAwayStatus(now: now)
        writePlan(now: now)
    }

    private func writePlan(now: Millis) {
        let plan = ShieldPlan.make(config: config, records: ledger.records(), now: now, time: time, testMode: settings.testMode)
        try? Storage.write(plan, to: Storage.planURL)
        if Shields.authorized { Shields.reconcile(now: now) }
    }

    private func persist() {
        do { try Storage.write(ledger.data, to: Storage.ledgerURL) } catch { message = "Couldn't save: \(error.localizedDescription)" }
        try? Storage.write(settings, to: Storage.settingsURL)
    }

    private func commit(sync: Bool = true) {
        persist()
        refresh()
        if sync { Task { await syncAll() } }
    }

    func saveSettings() {
        try? Storage.write(settings, to: Storage.settingsURL)
        refresh()
    }

    func saveSelection() {
        Shields.saveSelection(selection)
        refresh()
    }

    // MARK: config

    /// Applies the lock rules (no loosening while locked) before saving.
    func updateConfig(_ next: Config) -> Bool {
        if lock.locked && !settings.testMode, let why = Engine.configChangeBlockedWhileLocked(prev: config, next: next, state: lock) {
            message = why
            return false
        }
        do {
            try ledger.updateConfig { $0 = next }
            Shields.schedule(next)
            location.monitor(places: placesToMonitor(next))
            commit()
            return true
        } catch {
            message = error.localizedDescription
            return false
        }
    }

    func placesToMonitor(_ c: Config? = nil) -> [Place] {
        let cfg = c ?? config
        var ids = Set<String>()
        for k in cfg.commitments where k.enabled {
            for r in k.requirements + (k.away?.requirements ?? []) { r.placeIds.forEach { ids.insert($0) } }
        }
        return cfg.places.filter { ids.contains($0.id) }
    }

    // MARK: proofs

    private func issue(_ body: ProofBody) {
        do {
            try ledger.issue(.proof(body))
            commit()
        } catch { message = error.localizedDescription }
    }

    func recordVisit(placeId: String, from: Millis, to: Millis) {
        for c in config.commitments where c.enabled {
            let reqs = c.requirements + (c.away?.requirements ?? [])
            guard reqs.contains(where: { if case let .presence(p) = $0 { return p.placeId == placeId }; return false }) else { continue }
            // Credit the visit to the day it ended on.
            issue(ProofBody(cid: c.id, day: time.dayKey(to), at: to, detail: .presence(PresenceDetail(placeId: placeId, from: from, to: to))))
        }
    }

    func checkpointPresence(placeId: String) {
        guard let (from, to) = location.checkpoint(placeId: placeId, now: nowMillis()) else {
            message = "You're not inside that place right now."
            return
        }
        recordVisit(placeId: placeId, from: from, to: to)
    }

    func proveFloors(commitmentId: String, requirement: AltitudeRequirement, samples: [Geo.AltitudeSample]) -> Geo.FloorResult {
        let r = Geo.evaluateFloorChange(samples, requirement)
        if r.ok, let first = samples.first?.t, let last = samples.last?.t {
            issue(ProofBody(cid: commitmentId, day: time.dayKey(last), at: last, detail: .altitude(AltitudeDetail(deltaM: r.deltaM, samples: samples.count, startedAt: first, endedAt: last))))
        }
        return r
    }

    func proveFocus(commitmentId: String, minutes: Double) {
        do {
            if try Proofs.issueFocusProof(ledger: ledger, commitmentId: commitmentId, minutes: minutes, now: nowMillis(), time: time) { commit() }
        } catch { message = error.localizedDescription }
    }

    /// Validate + record a photo proof. Same checks every linked device re-runs.
    func provePhoto(commitmentId: String, requirementIndex: Int, image: UIImage, capturedAt: Millis, challenge: PhotoChallenge?) async -> PhotoCheck.Result {
        guard let status = lock.commitments.first(where: { $0.commitment.id == commitmentId }),
              requirementIndex < status.requirements.count,
              case let .photo(req) = status.requirements[requirementIndex].requirement
        else { return .init(ok: false, failures: ["that requirement isn't a photo"]) }

        let analysis: VisionService.Analysis
        do { analysis = try VisionService.analyze(image) } catch { return .init(ok: false, failures: [error.localizedDescription]) }

        var placeId: String?
        var inside: Bool?
        if let pid = req.placeId, let place = config.places.first(where: { $0.id == pid }) {
            let fix = await location.currentFix()
            placeId = pid
            if let f = fix {
                inside = Geo.containment(place, lat: f.coordinate.latitude, lon: f.coordinate.longitude, accuracyM: f.horizontalAccuracy) == .inside
            } else {
                inside = false
            }
        }
        var similarity: Double?
        if let fp = analysis.featurePrint {
            let refs = VisionService.loadReferences(key: "\(commitmentId):\(requirementIndex)")
            if !refs.isEmpty { similarity = VisionService.similarity(fp, to: refs) }
        }
        let detail = PhotoDetail(dhash: analysis.dhash, labels: analysis.labels, referenceSimilarity: similarity, placeId: placeId, insidePlace: inside, live: true, capturedAt: capturedAt, challenge: challenge)
        let earlier: [(dhash: String, capturedAt: Millis)] = Engine.proofs(ledger.records()).compactMap { p in
            if case let .photo(d) = p.body.detail { return (d.dhash, d.capturedAt) }
            return nil
        }
        let check = PhotoCheck.check(req, detail, earlier: earlier, places: config.places)
        if check.ok { issue(ProofBody(cid: commitmentId, day: time.dayKey(capturedAt), at: capturedAt, detail: .photo(detail))) }
        return check
    }

    func setReferences(commitmentId: String, requirementIndex: Int, images: [UIImage]) -> String? {
        let prints = images.compactMap { try? VisionService.analyze($0).featurePrint }
        guard prints.count == images.count, !prints.isEmpty else { return "Couldn't analyze the reference photos." }
        do { try VisionService.saveReferences(prints, key: "\(commitmentId):\(requirementIndex)") } catch { return error.localizedDescription }
        return nil
    }

    func referenceCount(commitmentId: String, requirementIndex: Int) -> Int {
        VisionService.loadReferences(key: "\(commitmentId):\(requirementIndex)").count
    }

    // MARK: away policy

    /// Once per day per commitment: if sustained location shows you're outside your reachable
    /// region, record "away" so the substitute task applies (on every linked device).
    private func updateAwayStatus(now: Millis) {
        let samples = location.samples()
        guard !samples.isEmpty else { return }
        let day = time.dayKey(now)
        for s in lock.commitments where s.locked {
            guard let away = s.commitment.away, let region = config.places.first(where: { $0.id == away.regionPlaceId }) else { continue }
            let already = ledger.records().contains { r in
                if case let .status(b) = r.payload.body { return b.cid == s.commitment.id && b.day == day }
                return false
            }
            if already { continue }
            let from = max(s.windowStart - 12 * 3_600_000, now - 24 * 3_600_000)
            let a = Geo.assessAway(samples, region: region, from: from, to: now, outsideFraction: config.policy.awayOutsideFraction, minHours: config.policy.awayMinHours)
            if a.region == .away {
                try? ledger.issue(.status(StatusBody(cid: s.commitment.id, day: day, region: .away, outsideFraction: a.outsideFraction, spanHours: a.spanHours)))
                persist()
                lock = Engine.evaluate(config: config, records: ledger.records(), now: now, time: time)
            }
        }
    }

    // MARK: emergency

    func emergency(reason: String) {
        let now = nowMillis()
        let minutes = config.policy.emergencyMinutes
        do {
            try ledger.issue(.emergency(EmergencyBody(day: time.dayKey(now), until: now + Millis(minutes * 60_000), reason: reason)))
            Shields.clear()
            Shields.scheduleEmergencyEnd(minutes: minutes)
            commit()
            message = "Emergency unlock for \(Int(minutes)) minutes. It's logged and resets your streak."
        } catch { message = error.localizedDescription }
    }

    // MARK: Anki

    func addReview(_ e: ReviewEvent) {
        ledger.addReviews([e])
        do { try Proofs.issueAnkiProofs(ledger: ledger, decks: decks, now: nowMillis(), newCardsPerDay: settings.newCardsPerDay, time: time) } catch { message = error.localizedDescription }
        commit()
    }

    var reviews: [ReviewEvent] { ledger.reviews() }

    func importDeck(from url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            let (imported, warnings) = try ApkgImporter.importPackage(data, fileName: url.lastPathComponent)
            for d in imported { try Storage.write(d, to: Storage.deckURL(d.id)) }
            decks = Storage.loadDecks()
            message = (["Imported \(imported.map { "\($0.name) (\($0.cards.count))" }.joined(separator: ", "))."] + warnings).joined(separator: " ")
        } catch { message = error.localizedDescription }
    }

    func deleteDeck(_ id: String) {
        try? FileManager.default.removeItem(at: Storage.deckURL(id))
        decks = Storage.loadDecks()
    }

    // MARK: linking

    func pair(qr: String) async {
        guard let q = LinkProtocol.decodePairingQR(qr) else { message = "That isn't a Prove to Unlock pairing code."; return }
        await pair(hosts: q.hosts, port: q.port, code: q.code, expectedFingerprint: q.fingerprint)
    }

    func pair(hosts: [String], port: Int, code: String, expectedFingerprint: String? = nil) async {
        do {
            let device = try await client.pair(ledger, hosts: hosts, port: port, code: code)
            if let fp = expectedFingerprint, !fp.isEmpty, let der = Data(base64Encoded: device.publicKey), DeviceIdentity.fingerprint(publicKeyDER: der) != fp {
                ledger.removePeer(device.deviceId)
                message = "The computer's fingerprint didn't match the QR code. Not linked."
                return
            }
            message = "Linked with \(device.name)."
            commit(sync: false)
            await syncAll()
        } catch { message = "Couldn't link: \(error.localizedDescription)" }
    }

    func unpair(_ id: String) {
        ledger.removePeer(id)
        commit(sync: false)
    }

    func syncAll() async {
        guard !syncing, let ledger else { return }
        syncing = true
        defer { syncing = false }
        var anyOK = false
        for p in ledger.peers where !(p.hosts ?? []).isEmpty && p.port != nil {
            for host in p.hosts ?? [] {
                let e = LinkClient.Endpoint(host: host, port: p.port!)
                do {
                    try await client.adoptTrust(ledger, e)
                    try await client.sync(ledger, peerId: p.deviceId, e)
                    try await pullDecks(e)
                    anyOK = true
                    break
                } catch {
                    continue
                }
            }
        }
        if anyOK { lastSync = Date() }
        persist()
        refresh()
    }

    private func pullDecks(_ e: LinkClient.Endpoint) async throws {
        let remote = try await client.listDecks(ledger, e)
        var changed = false
        for s in remote where !decks.contains(where: { $0.id == s.id && $0.importedAt >= s.importedAt }) {
            let d = try await client.fetchDeck(ledger, e, id: s.id)
            try Storage.write(d, to: Storage.deckURL(d.id))
            changed = true
        }
        if changed { decks = Storage.loadDecks() }
    }

    func rename(_ name: String) {
        ledger.name = name
        persist()
    }

    func streak(_ cid: String) -> Int {
        Engine.streak(config: config, records: ledger.records(), now: nowMillis(), commitmentId: cid, time: time)
    }
}
