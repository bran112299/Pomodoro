import CoreLocation
import CoreMotion
import Foundation
import ProveCore

/// Location: current fixes for photo proofs, low-power significant-change samples for the
/// "away" policy, and geofence monitoring (CLMonitor) for presence proofs.
@MainActor
final class LocationService: NSObject, ObservableObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var fixContinuations: [CheckedContinuation<CLLocation?, Never>] = []
    private var monitor: CLMonitor?
    private var monitorTask: Task<Void, Never>?

    @Published var authorization: CLAuthorizationStatus = .notDetermined
    @Published var last: CLLocation?
    /// placeId -> when we entered it (still inside).
    @Published private(set) var inside: [String: Millis] = [:]
    /// Called when a visit ends: (placeId, from, to).
    var onVisit: ((String, Millis, Millis) -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        authorization = manager.authorizationStatus
        inside = Storage.read([String: Millis].self, from: Storage.visitsURL) ?? [:]
    }

    func requestPermission() {
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        else if manager.authorizationStatus == .authorizedWhenInUse { manager.requestAlwaysAuthorization() }
    }

    func startBackgroundSampling() {
        guard CLLocationManager.significantLocationChangeMonitoringAvailable() else { return }
        manager.startMonitoringSignificantLocationChanges()
    }

    /// One good fix (or nil after a timeout).
    func currentFix(timeout: TimeInterval = 10) async -> CLLocation? {
        if let l = last, -l.timestamp.timeIntervalSinceNow < 15, l.horizontalAccuracy <= 50 { return l }
        manager.requestLocation()
        return await withCheckedContinuation { cont in
            fixContinuations.append(cont)
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1e9))
                self.resolveFix(self.last)
            }
        }
    }

    private func resolveFix(_ l: CLLocation?) {
        let conts = fixContinuations
        fixContinuations.removeAll()
        conts.forEach { $0.resume(returning: l) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            guard let l = locations.last else { return }
            self.last = l
            self.appendSamples(locations)
            if l.horizontalAccuracy <= 100 { self.resolveFix(l) }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.resolveFix(nil) }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in self.authorization = manager.authorizationStatus }
    }

    private func appendSamples(_ locs: [CLLocation]) {
        var samples = Storage.read([LocationSample].self, from: Storage.samplesURL) ?? []
        for l in locs where l.horizontalAccuracy >= 0 {
            samples.append(LocationSample(t: Millis(l.timestamp.timeIntervalSince1970 * 1000), lat: l.coordinate.latitude, lon: l.coordinate.longitude, accuracyM: l.horizontalAccuracy))
        }
        let cutoff = nowMillis() - 3 * 86_400_000
        samples = samples.filter { $0.t >= cutoff }.suffix(5000)
        try? Storage.write(samples, to: Storage.samplesURL)
    }

    func samples() -> [LocationSample] { Storage.read([LocationSample].self, from: Storage.samplesURL) ?? [] }

    // MARK: geofences

    /// Monitor these places (Life360-style circles). iOS allows ~20 per app.
    func monitor(places: [Place]) {
        monitorTask?.cancel()
        let wanted = Array(places.prefix(20))
        monitorTask = Task { @MainActor in
            let m = await CLMonitor("ptu-places")
            self.monitor = m
            for id in await m.identifiers where !wanted.contains(where: { $0.id == id }) { await m.remove(id) }
            for p in wanted {
                let cond = CLMonitor.CircularGeographicCondition(center: CLLocationCoordinate2D(latitude: p.lat, longitude: p.lon), radius: min(p.radiusM, 50_000))
                await m.add(cond, identifier: p.id, assuming: .unsatisfied)
            }
            do {
                for try await event in await m.events {
                    let t = Millis(event.date.timeIntervalSince1970 * 1000)
                    self.handle(id: event.identifier, satisfied: event.state == .satisfied, at: t)
                }
            } catch {}
        }
    }

    private func handle(id: String, satisfied: Bool, at t: Millis) {
        if satisfied {
            if inside[id] == nil { inside[id] = t }
        } else if let from = inside.removeValue(forKey: id) {
            onVisit?(id, from, t)
        }
        try? Storage.write(inside, to: Storage.visitsURL)
    }

    /// Record the time spent so far in a place you're still inside (the visit keeps going).
    func checkpoint(placeId: String, now: Millis) -> (Millis, Millis)? {
        guard let from = inside[placeId] else { return nil }
        return (from, now)
    }
}

/// Barometer sessions for floor checks.
@MainActor
final class AltimeterService: ObservableObject {
    private let altimeter = CMAltimeter()
    @Published private(set) var samples: [Geo.AltitudeSample] = []
    @Published private(set) var running = false
    @Published var error: String?

    static var available: Bool { CMAltimeter.isRelativeAltitudeAvailable() }

    func start() {
        guard Self.available else { error = "This device has no barometer."; return }
        samples = []
        running = true
        altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] data, err in
            Task { @MainActor in
                guard let self else { return }
                if let err { self.error = err.localizedDescription; return }
                if let d = data { self.samples.append(Geo.AltitudeSample(t: nowMillis(), relM: d.relativeAltitude.doubleValue)) }
            }
        }
    }

    func stop() {
        altimeter.stopRelativeAltitudeUpdates()
        running = false
    }

    var currentDelta: Double { (samples.last?.relM ?? 0) - (samples.first?.relM ?? 0) }
}
