import FamilyControls
import ProveCore
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var picking = false
    @State private var authError: String?
    @State private var authorized = Shields.authorized

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Test mode", isOn: Binding(get: { model.settings.testMode }, set: { on in
                        if on && model.lock.locked && !model.settings.testMode {
                            model.message = "Test mode can't be turned on while locked. Use the emergency unlock if you really need to."
                            return
                        }
                        model.settings.testMode = on
                        model.saveSettings()
                    }))
                } footer: {
                    Text("In test mode nothing is actually blocked; you can try everything safely. Turn it off to make the lock real.")
                }

                Section {
                    if authorized {
                        Label("Screen Time access granted", systemImage: "checkmark.shield.fill").foregroundStyle(.green)
                    } else {
                        Button("Allow Screen Time access") {
                            Task {
                                do {
                                    try await Shields.requestAuthorization()
                                    authorized = Shields.authorized
                                    Shields.schedule(model.config)
                                } catch {
                                    authError = error.localizedDescription
                                }
                            }
                        }
                        if let e = authError { Text(e).font(.caption).foregroundStyle(.red) }
                    }
                    Picker("While locked", selection: Binding(get: { model.settings.blockAllExceptSelected }, set: { model.settings.blockAllExceptSelected = $0; model.saveSettings() })) {
                        Text("Block everything except essentials").tag(true)
                        Text("Block only chosen apps").tag(false)
                    }
                    Button(model.settings.blockAllExceptSelected ? "Choose essential apps" : "Choose apps to block") { picking = true }
                        .disabled(!authorized)
                } header: {
                    Text("Blocking")
                } footer: {
                    Text("Uses Apple's Screen Time. Phone calls, emergency SOS and this app always work. Locks lift by themselves at the end of each window, even if this app never opens.")
                }

                Section("Cards") {
                    Stepper("New cards per day: \(model.settings.newCardsPerDay)", value: Binding(get: { model.settings.newCardsPerDay }, set: { model.settings.newCardsPerDay = $0; model.saveSettings() }), in: 0...500, step: 5)
                }

                Section("Location") {
                    LabeledContent("Access", value: locationText)
                    Button("Allow location “Always”") { model.location.requestPermission() }
                }
            }
            .navigationTitle("Settings")
            .familyActivityPicker(isPresented: $picking, selection: Binding(get: { model.selection }, set: { model.selection = $0; model.saveSelection() }))
        }
    }

    var locationText: String {
        switch model.location.authorization {
        case .authorizedAlways: return "Always"
        case .authorizedWhenInUse: return "While using"
        case .denied, .restricted: return "Off"
        default: return "Not set"
        }
    }
}

struct OnboardingView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "lock.badge.checkmark").font(.system(size: 56)).foregroundStyle(.tint)
                Text("Prove with X you can do Y before unlocking Z").font(.title.bold())
                Text("Your phone (and linked computers) stay locked to the essentials until you've done what you committed to today and proved it.")
                VStack(alignment: .leading, spacing: 10) {
                    Label("Create a commitment under Rules: the gym, Anki cards, focus sessions…", systemImage: "checklist")
                    Label("Mark places on the map (gym, your city) for location and away rules.", systemImage: "map")
                    Label("Link your computer under Devices by scanning its QR code.", systemImage: "qrcode")
                    Label("You start in test mode: nothing is blocked until you turn it off.", systemImage: "testtube.2")
                    Label("Failsafe: hold the emergency button for 3 seconds. Calls and SOS always work.", systemImage: "exclamationmark.octagon")
                }
                Button {
                    model.settings.onboarded = true
                    model.saveSettings()
                    model.location.requestPermission()
                } label: {
                    Text("Get started").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            .padding(24)
        }
    }
}
