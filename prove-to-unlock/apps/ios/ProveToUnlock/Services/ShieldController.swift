import DeviceActivity
import FamilyControls
import Foundation
import ManagedSettings
import ProveCore

/// Applies and clears Screen Time shields. The same logic runs in the DeviceActivity monitor
/// extension at the start/end of each commitment window, so locks apply on time even when the
/// app isn't running, and always lift at the end of the window (the built-in dead-man switch).
enum Shields {
    static let store = ManagedSettingsStore(named: ManagedSettingsStore.Name("ptu"))

    static func loadSelection() -> FamilyActivitySelection {
        Storage.read(FamilyActivitySelection.self, from: Storage.selectionURL) ?? FamilyActivitySelection()
    }

    static func saveSelection(_ s: FamilyActivitySelection) {
        try? Storage.write(s, to: Storage.selectionURL)
    }

    /// `allExcept`: shield every app except the selected ones (the selected apps are your
    /// essentials). Otherwise shield only the selected apps / categories / sites.
    static func apply(_ selection: FamilyActivitySelection, allExcept: Bool) {
        if allExcept {
            store.shield.applicationCategories = .all(except: selection.applicationTokens)
            store.shield.webDomainCategories = .all(except: selection.webDomainTokens)
            store.shield.applications = nil
            store.shield.webDomains = nil
        } else {
            store.shield.applications = selection.applicationTokens.isEmpty ? nil : selection.applicationTokens
            store.shield.applicationCategories = selection.categoryTokens.isEmpty ? nil : .specific(selection.categoryTokens)
            store.shield.webDomains = selection.webDomainTokens.isEmpty ? nil : selection.webDomainTokens
            store.shield.webDomainCategories = nil
        }
    }

    static func clear() {
        store.clearAllSettings()
    }

    /// Re-decide from the shared plan (used by both the app and the extension).
    static func reconcile(now: Millis = nowMillis()) {
        guard let plan = Storage.read(ShieldPlan.self, from: Storage.planURL) else { clear(); return }
        let allExcept = (Storage.read(AppSettings.self, from: Storage.settingsURL) ?? AppSettings()).blockAllExceptSelected
        if plan.shouldShield(now: now) { apply(loadSelection(), allExcept: allExcept) } else { clear() }
    }

    // MARK: schedules

    static let center = DeviceActivityCenter()

    static func activityName(_ commitmentId: String) -> DeviceActivityName { DeviceActivityName("ptu.c.\(commitmentId)") }
    static let emergencyActivity = DeviceActivityName("ptu.emergency")

    /// One repeating daily schedule per commitment window. The extension decides on weekdays.
    static func schedule(_ config: Config) {
        center.stopMonitoring(center.activities.filter { $0.rawValue.hasPrefix("ptu.c.") })
        for c in config.commitments where c.enabled {
            guard let s = LocalTime.parseTimeOfDay(c.window.start), let e = LocalTime.parseTimeOfDay(c.window.end), e - s >= 15 else { continue }
            let endMin = min(e, 24 * 60 - 1) // DeviceActivity can't express 24:00
            let schedule = DeviceActivitySchedule(
                intervalStart: DateComponents(hour: s / 60, minute: s % 60),
                intervalEnd: DateComponents(hour: endMin / 60, minute: endMin % 60),
                repeats: true
            )
            try? center.startMonitoring(activityName(c.id), during: schedule)
        }
    }

    /// After an emergency unlock, re-check when it ends (min 15 minutes, a Screen Time limit).
    static func scheduleEmergencyEnd(minutes: Double) {
        center.stopMonitoring([emergencyActivity])
        let cal = Calendar.current
        let start = Date()
        let end = start.addingTimeInterval(max(15, minutes) * 60)
        let schedule = DeviceActivitySchedule(
            intervalStart: cal.dateComponents([.year, .month, .day, .hour, .minute, .second], from: start),
            intervalEnd: cal.dateComponents([.year, .month, .day, .hour, .minute, .second], from: end),
            repeats: false
        )
        try? center.startMonitoring(emergencyActivity, during: schedule)
    }

    static var authorized: Bool { AuthorizationCenter.shared.authorizationStatus == .approved }

    static func requestAuthorization() async throws {
        try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
    }
}
