import DeviceActivity
import Foundation
import ProveCore

/// Runs (without the app) at the start and end of every commitment window and after an
/// emergency unlock expires. It only reads the precomputed ShieldPlan and applies or clears
/// shields, so it stays well inside the extension's small memory budget.
final class Monitor: DeviceActivityMonitor {
    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        Shields.reconcile(now: nowMillis())
    }

    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        // Look just past the boundary: a window ending "24:00" is scheduled to end at 23:59, and
        // the lock must lift with it.
        Shields.reconcile(now: nowMillis() + 61_000)
    }
}
