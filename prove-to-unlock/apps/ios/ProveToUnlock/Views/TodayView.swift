import ProveCore
import SwiftUI

struct ProveTarget: Identifiable, Equatable {
    var commitmentId: String
    var requirementIndex: Int
    var requirement: Requirement
    var id: String { "\(commitmentId):\(requirementIndex)" }
}

func describe(_ r: Requirement, places: [Place]) -> String {
    let placeName = { (id: String?) in id.flatMap { pid in places.first { $0.id == pid }?.name } }
    switch r {
    case let .photo(p): return p.placeId != nil ? "Fresh photo at \(placeName(p.placeId) ?? "the place")" : "Fresh photo"
    case let .presence(p): return "Spend \(formatNumber(p.minutes)) min at \(placeName(p.placeId) ?? "the place")"
    case let .altitude(a): return "Go \(formatNumber(a.floors)) floor\(a.floors == 1 ? "" : "s") \(a.direction.rawValue)"
    case let .anki(a): return a.mode == .due ? "Finish today's Anki cards" : "Do \(a.count ?? 20) Anki reviews"
    case let .focus(f): return "\(f.sessions) focus session\(f.sessions == 1 ? "" : "s") (\(formatNumber(f.minutesPerSession ?? 25)) min)"
    }
}

func icon(_ k: RequirementKind) -> String {
    switch k {
    case .photo: return "camera.fill"
    case .presence: return "mappin.and.ellipse"
    case .altitude: return "stairs"
    case .anki: return "rectangle.stack.fill"
    case .focus: return "timer"
    }
}

struct TodayView: View {
    @EnvironmentObject var model: AppModel
    @State private var target: ProveTarget?

    var active: [CommitmentStatus] {
        model.lock.commitments.filter { ![.disabled, .notToday, .outsideWindow].contains($0.unlockedBy) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        Image(systemName: model.lock.locked ? "lock.fill" : "lock.open.fill")
                            .font(.system(size: 34))
                            .foregroundStyle(model.lock.locked ? .red : .green)
                        VStack(alignment: .leading) {
                            Text(model.lock.locked ? "Locked to essentials" : "Unlocked").font(.title2.bold())
                            Text(model.settings.testMode ? "Test mode: nothing is actually blocked." : model.lock.locked ? "Prove today's commitment to unlock." : "You're free.")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 6)
                    if let e = model.lock.emergencyUntil {
                        Label("Emergency unlock until \(Date(timeIntervalSince1970: Double(e) / 1000).formatted(date: .omitted, time: .shortened))", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                }

                if active.isEmpty {
                    Section { Text("No commitments active right now.").foregroundStyle(.secondary) }
                }

                ForEach(active, id: \.commitment.id) { s in
                    Section {
                        ForEach(Array(s.requirements.enumerated()), id: \.offset) { i, r in
                            Button {
                                if !r.ok { target = ProveTarget(commitmentId: s.commitment.id, requirementIndex: i, requirement: r.requirement) }
                            } label: {
                                HStack {
                                    Image(systemName: r.ok ? "checkmark.circle.fill" : icon(r.requirement.kind))
                                        .foregroundStyle(r.ok ? .green : .accentColor)
                                        .frame(width: 28)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(describe(r.requirement, places: model.config.places)).foregroundStyle(.primary)
                                        Text(r.progress).font(.caption).foregroundStyle(.secondary)
                                        if !r.failures.isEmpty {
                                            Text(r.failures.joined(separator: " · ")).font(.caption).foregroundStyle(.red)
                                        }
                                    }
                                    Spacer()
                                    if !r.ok { Image(systemName: "chevron.right").foregroundStyle(.tertiary) }
                                }
                            }
                            .disabled(r.ok)
                        }
                    } header: {
                        HStack {
                            Text(s.commitment.title)
                            if s.mode == .away { Text("AWAY MODE").font(.caption2.bold()).padding(.horizontal, 5).background(.orange, in: Capsule()).foregroundStyle(.black) }
                            Spacer()
                            let st = model.streak(s.commitment.id)
                            if st > 0 { Text("🔥 \(st)") }
                        }
                    } footer: {
                        Text(s.locked ? (s.commitment.require == .all ? "Do all of these." : "Do any \(s.commitment.require.required(of: s.requirements.count)) of these.") : s.unlockedBy == .proven ? "Done for today." : s.unlockedBy == .excused ? "Excused today." : s.unlockedBy == .emergency ? "Emergency unlock active." : "")
                    }
                }

                Section {
                    HoldToEmergencyButton(minutes: model.config.policy.emergencyMinutes) {
                        model.emergency(reason: "hold on iPhone")
                    }
                } footer: {
                    Text("Unlocks every linked device for \(Int(model.config.policy.emergencyMinutes)) minutes. It always works, even offline. It's logged and resets your streak. Calls and emergency SOS are never blocked.")
                }
            }
            .navigationTitle("Today")
            .refreshable { await model.syncAll() }
            .sheet(item: $target) { t in
                NavigationStack { ProveSheet(target: t) }
            }
        }
    }
}

/// Hold for 3 seconds (the phone's version of holding Esc).
struct HoldToEmergencyButton: View {
    var minutes: Double
    var action: () -> Void
    @State private var progress: CGFloat = 0
    @State private var pressing = false

    var body: some View {
        ZStack(alignment: .leading) {
            GeometryReader { g in
                Rectangle().fill(Color.orange.opacity(0.25)).frame(width: g.size.width * progress)
            }
            Label("Hold 3 s for emergency unlock", systemImage: "exclamationmark.octagon")
                .foregroundStyle(.orange)
                .padding(.vertical, 10)
        }
        .contentShape(Rectangle())
        .onLongPressGesture(minimumDuration: 3, maximumDistance: 50) {
            progress = 0
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            action()
        } onPressingChanged: { p in
            pressing = p
            withAnimation(p ? .linear(duration: 3) : .easeOut(duration: 0.2)) { progress = p ? 1 : 0 }
        }
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Press and hold for three seconds")
    }
}

struct ProveSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let target: ProveTarget

    var body: some View {
        Group {
            switch target.requirement {
            case let .photo(r): PhotoProofView(target: target, requirement: r)
            case let .presence(r): PresenceProofView(location: model.location, commitmentId: target.commitmentId, requirement: r)
            case let .altitude(r): FloorsProofView(commitmentId: target.commitmentId, requirement: r)
            case let .anki(r): StudyView(deckIds: r.deckIds, target: r.mode == .count ? r.count ?? 20 : nil)
            case let .focus(r): FocusProofView(commitmentId: target.commitmentId, minutes: r.minutesPerSession ?? 25)
            }
        }
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }
}
