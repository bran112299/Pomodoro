import BackgroundTasks
import ProveCore
import SwiftUI

@main
struct ProveToUnlockApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var phase
    static let refreshTask = "com.provetounlock.refresh"

    init() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTask, using: nil) { task in
            Self.scheduleRefresh()
            let work = Task { @MainActor in
                let m = AppModel()
                m.start()
                await m.syncAll()
                task.setTaskCompleted(success: true)
            }
            task.expirationHandler = { work.cancel() }
        }
    }

    static func scheduleRefresh() {
        let req = BGAppRefreshTaskRequest(identifier: refreshTask)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .onAppear {
                    model.start()
                    model.location.startBackgroundSampling()
                }
        }
        .onChange(of: phase) { _, p in
            if p == .active {
                model.refresh()
                Task { await model.syncAll() }
            } else if p == .background {
                Self.scheduleRefresh()
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        TabView {
            TodayView().tabItem { Label("Today", systemImage: model.lock.locked ? "lock.fill" : "lock.open.fill") }
            CommitmentsView().tabItem { Label("Rules", systemImage: "checklist") }
            PlacesView().tabItem { Label("Places", systemImage: "map") }
            DecksView().tabItem { Label("Cards", systemImage: "rectangle.stack") }
            DevicesView().tabItem { Label("Devices", systemImage: "laptopcomputer.and.iphone") }
            SettingsView().tabItem { Label("Settings", systemImage: "gear") }
        }
        .alert("Prove to Unlock", isPresented: Binding(get: { model.message != nil }, set: { if !$0 { model.message = nil } })) {
            Button("OK", role: .cancel) { model.message = nil }
        } message: {
            Text(model.message ?? "")
        }
        .sheet(isPresented: Binding(get: { !model.settings.onboarded }, set: { _ in })) {
            OnboardingView().interactiveDismissDisabled()
        }
    }
}
