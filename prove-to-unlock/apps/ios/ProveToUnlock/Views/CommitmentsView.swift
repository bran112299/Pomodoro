import ProveCore
import SwiftUI

struct CommitmentsView: View {
    @EnvironmentObject var model: AppModel
    @State private var editing: Commitment?

    struct Template: Identifiable {
        var name: String
        var make: () -> Commitment
        var id: String { name }
    }

    static let templates: [Template] = [
        Template(name: "Go to the gym (photo + floors)") { Commitment(id: randomId(bytes: 6), title: "Go to the gym", days: [1, 2, 3, 4, 5], window: TimeWindow(start: "06:00", end: "24:00"), requirements: [.photo(PhotoRequirement(challenge: true)), .altitude(AltitudeRequirement(direction: .down, floors: 2))], createdAt: nowMillis()) },
        Template(name: "Clear today's Anki cards") { Commitment(id: randomId(bytes: 6), title: "Anki before anything", days: [0, 1, 2, 3, 4, 5, 6], window: TimeWindow(start: "05:00", end: "24:00"), requirements: [.anki(AnkiRequirement(mode: .due))], createdAt: nowMillis()) },
        Template(name: "Deep work (4 focus sessions)") { Commitment(id: randomId(bytes: 6), title: "Deep work", days: [1, 2, 3, 4, 5], window: TimeWindow(start: "08:00", end: "18:00"), requirements: [.focus(FocusRequirement(sessions: 4))], createdAt: nowMillis()) },
    ]

    var body: some View {
        NavigationStack {
            List {
                Section("Commitments") {
                    if model.config.commitments.isEmpty { Text("None yet. Start from a template below.").foregroundStyle(.secondary) }
                    ForEach(model.config.commitments) { c in
                        Button { editing = c } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text(c.title).font(.headline)
                                    if !c.enabled { Text("off").font(.caption).foregroundStyle(.secondary) }
                                }
                                Text("\(c.days.map { ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][$0] }.joined(separator: " ")) · \(c.window.start)–\(c.window.end)").font(.caption).foregroundStyle(.secondary)
                                Text(c.requirements.map { describe($0, places: model.config.places) }.joined(separator: c.require == .all ? " + " : " or ")).font(.caption)
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                }
                Section("Add") {
                    ForEach(Self.templates) { t in
                        Button("+ \(t.name)") { editing = t.make() }
                    }
                    Button("+ Blank") { editing = Commitment(id: randomId(bytes: 6), title: "", days: [1, 2, 3, 4, 5], window: TimeWindow(start: "06:00", end: "24:00"), requirements: [], createdAt: nowMillis()) }
                }
                Section {
                    NavigationLink("Excused days & rules") { RulesView() }
                }
            }
            .navigationTitle("Rules")
            .sheet(item: $editing) { c in
                NavigationStack { CommitmentEditor(commitment: c) }
            }
        }
    }
}

func minutesToDate(_ s: String) -> Date {
    let m = LocalTime.parseTimeOfDay(s) ?? 0
    return Calendar.current.date(bySettingHour: min(23, m / 60), minute: m == 1440 ? 59 : m % 60, second: 0, of: Date()) ?? Date()
}

func dateToTime(_ d: Date, isEnd: Bool) -> String {
    let c = Calendar.current.dateComponents([.hour, .minute], from: d)
    if isEnd && c.hour == 23 && c.minute == 59 { return "24:00" }
    return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
}

struct RequirementEditor: View {
    @Binding var r: Requirement
    let places: [Place]
    let decks: [Deck]

    var body: some View {
        switch r {
        case var .photo(p):
            Picker("Where", selection: Binding(get: { p.placeId ?? "" }, set: { p.placeId = $0.isEmpty ? nil : $0; r = .photo(p) })) {
                Text("Anywhere").tag("")
                ForEach(places) { Text($0.name).tag($0.id) }
            }
            TextField("Must show (e.g. dumbbell, barbell)", text: Binding(get: { (p.labelsAny ?? []).joined(separator: ", ") }, set: { p.labelsAny = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }; r = .photo(p) }))
            Toggle("Random challenge", isOn: Binding(get: { p.challenge == true }, set: { p.challenge = $0; r = .photo(p) }))
            Toggle("Must look like my reference photos", isOn: Binding(get: { p.minReferenceSimilarity != nil }, set: { p.minReferenceSimilarity = $0 ? 0.6 : nil; r = .photo(p) }))
        case var .presence(p):
            Picker("Place", selection: Binding(get: { p.placeId }, set: { p.placeId = $0; r = .presence(p) })) {
                ForEach(places) { Text($0.name).tag($0.id) }
            }
            Stepper("\(Int(p.minutes)) minutes", value: Binding(get: { p.minutes }, set: { p.minutes = $0; r = .presence(p) }), in: 5...600, step: 5)
        case var .altitude(a):
            Picker("Direction", selection: Binding(get: { a.direction }, set: { a.direction = $0; r = .altitude(a) })) {
                Text("Down").tag(AltitudeRequirement.Direction.down)
                Text("Up").tag(AltitudeRequirement.Direction.up)
            }
            Stepper("\(Int(a.floors)) floor(s)", value: Binding(get: { a.floors }, set: { a.floors = $0; r = .altitude(a) }), in: 1...50)
            Stepper(String(format: "%.1f m per floor", a.metersPerFloor ?? 3), value: Binding(get: { a.metersPerFloor ?? 3 }, set: { a.metersPerFloor = $0; r = .altitude(a) }), in: 2...6, step: 0.1)
        case var .anki(a):
            Picker("Goal", selection: Binding(get: { a.mode }, set: { a.mode = $0; r = .anki(a) })) {
                Text("Clear today's cards").tag(AnkiRequirement.Mode.due)
                Text("Do N reviews").tag(AnkiRequirement.Mode.count)
            }
            if a.mode == .count {
                Stepper("\(a.count ?? 20) reviews", value: Binding(get: { a.count ?? 20 }, set: { a.count = $0; r = .anki(a) }), in: 1...1000, step: 5)
            }
        case var .focus(f):
            Stepper("\(f.sessions) session(s)", value: Binding(get: { f.sessions }, set: { f.sessions = $0; r = .focus(f) }), in: 1...20)
            Stepper("\(Int(f.minutesPerSession ?? 25)) min each", value: Binding(get: { f.minutesPerSession ?? 25 }, set: { f.minutesPerSession = $0; r = .focus(f) }), in: 5...180, step: 5)
        }
    }
}

func newRequirement(_ k: RequirementKind, places: [Place]) -> Requirement {
    switch k {
    case .photo: return .photo(PhotoRequirement())
    case .presence: return .presence(PresenceRequirement(placeId: places.first?.id ?? "", minutes: 30))
    case .altitude: return .altitude(AltitudeRequirement(direction: .down, floors: 1))
    case .anki: return .anki(AnkiRequirement(mode: .due))
    case .focus: return .focus(FocusRequirement(sessions: 2))
    }
}

struct RequirementsSection: View {
    let title: String
    @Binding var reqs: [Requirement]
    @Binding var require: RequireMode
    let places: [Place]
    let decks: [Deck]

    var body: some View {
        ForEach(reqs.indices, id: \.self) { i in
            Section {
                RequirementEditor(r: $reqs[i], places: places, decks: decks)
                Button("Remove", role: .destructive) { reqs.remove(at: i) }
            } header: {
                Label(describe(reqs[i], places: places), systemImage: icon(reqs[i].kind))
            }
        }
        Section(title) {
            Menu("Add requirement") {
                ForEach(RequirementKind.allCases, id: \.self) { k in
                    Button(k.rawValue.capitalized) { reqs.append(newRequirement(k, places: places)) }
                        .disabled(k == .presence && places.isEmpty)
                }
            }
            if reqs.count > 1 {
                Picker("Need", selection: Binding(get: { require == .all ? 0 : require.required(of: reqs.count) }, set: { require = $0 == 0 ? .all : .any($0) })) {
                    Text("All of them").tag(0)
                    ForEach(1..<reqs.count, id: \.self) { Text("Any \($0)").tag($0) }
                }
            }
        }
    }
}

struct CommitmentEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State var commitment: Commitment
    @State private var refFor: Int?

    var exists: Bool { model.config.commitments.contains { $0.id == commitment.id } }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $commitment.title)
                Toggle("On", isOn: $commitment.enabled)
                HStack {
                    ForEach(0..<7, id: \.self) { d in
                        let on = commitment.days.contains(d)
                        Button(["S", "M", "T", "W", "T", "F", "S"][d]) {
                            if on { commitment.days.removeAll { $0 == d } } else { commitment.days.append(d); commitment.days.sort() }
                        }
                        .buttonStyle(.bordered)
                        .tint(on ? Color.accentColor : Color.gray)
                    }
                }
                DatePicker("Locked from", selection: Binding(get: { minutesToDate(commitment.window.start) }, set: { commitment.window.start = dateToTime($0, isEnd: false) }), displayedComponents: .hourAndMinute)
                DatePicker("Until (or proven)", selection: Binding(get: { minutesToDate(commitment.window.end) }, set: { commitment.window.end = dateToTime($0, isEnd: true) }), displayedComponents: .hourAndMinute)
            }
            RequirementsSection(title: "To unlock", reqs: $commitment.requirements, require: $commitment.require, places: model.config.places, decks: model.decks)
            ForEach(commitment.requirements.indices, id: \.self) { i in
                if case let .photo(p) = commitment.requirements[i], p.minReferenceSimilarity != nil {
                    Section {
                        Button("Take reference photos of the place (\(model.referenceCount(commitmentId: commitment.id, requirementIndex: i)) saved)") { refFor = i }
                    }
                }
            }
            Section {
                Toggle("When I'm away, do something else instead", isOn: Binding(get: { commitment.away != nil }, set: { on in
                    commitment.away = on ? AwayPolicy(regionPlaceId: model.config.places.first?.id ?? "", requirements: [.focus(FocusRequirement(sessions: 1))], require: .all) : nil
                }))
                .disabled(model.config.places.isEmpty)
                if let away = commitment.away {
                    Picker("Reachable area", selection: Binding(get: { away.regionPlaceId }, set: { commitment.away?.regionPlaceId = $0 })) {
                        ForEach(model.config.places) { Text($0.name).tag($0.id) }
                    }
                }
            } footer: {
                Text(model.config.places.isEmpty ? "Add your city as a big place first." : "Away = outside the area for most of the day (needs location). Capped per month.")
            }
            if commitment.away != nil {
                RequirementsSection(title: "Instead, when away", reqs: Binding(get: { commitment.away?.requirements ?? [] }, set: { commitment.away?.requirements = $0 }), require: Binding(get: { commitment.away?.require ?? .all }, set: { commitment.away?.require = $0 }), places: model.config.places, decks: model.decks)
            }
            if exists {
                Section {
                    Button("Delete commitment", role: .destructive) {
                        var c = model.config
                        c.commitments.removeAll { $0.id == commitment.id }
                        if model.updateConfig(c) { dismiss() }
                    }
                }
            }
        }
        .navigationTitle(exists ? "Edit" : "New commitment")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    var c = model.config
                    if let i = c.commitments.firstIndex(where: { $0.id == commitment.id }) { c.commitments[i] = commitment } else { c.commitments.append(commitment) }
                    if model.updateConfig(c) { dismiss() }
                }
                .disabled(commitment.title.trimmingCharacters(in: .whitespaces).isEmpty || commitment.days.isEmpty || commitment.requirements.isEmpty)
            }
        }
        .sheet(item: Binding(get: { refFor.map { RefTarget(index: $0) } }, set: { refFor = $0?.index })) { t in
            ReferencePhotosView(commitmentId: commitment.id, requirementIndex: t.index)
        }
    }
}

struct RefTarget: Identifiable { var index: Int; var id: Int { index } }

struct ReferencePhotosView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let commitmentId: String
    let requirementIndex: Int
    @State private var images: [UIImage] = []
    @State private var showCamera = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Take 3 photos of the place from different angles. Later proofs must look like these.")
                    ScrollView(.horizontal) { HStack { ForEach(images.indices, id: \.self) { Image(uiImage: images[$0]).resizable().scaledToFill().frame(width: 90, height: 90).clipped().cornerRadius(8) } } }
                    if images.count < 3 {
                        Button("Take photo \(images.count + 1) of 3") { showCamera = true }.disabled(!CameraPicker.available)
                    } else {
                        Button("Save reference photos") {
                            if let e = model.setReferences(commitmentId: commitmentId, requirementIndex: requirementIndex, images: images) { error = e } else { dismiss() }
                        }
                    }
                    if let e = error { Text(e).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Reference photos")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .fullScreenCover(isPresented: $showCamera) { CameraPicker { images.append($0) }.ignoresSafeArea() }
        }
    }
}

struct RulesView: View {
    @EnvironmentObject var model: AppModel
    @State private var excuseDate = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
    @State private var reason = ""

    var body: some View {
        Form {
            Section {
                ForEach(model.config.excused.sorted { $0.day < $1.day }, id: \.day) { e in
                    HStack { Text(e.day); if let r = e.reason { Text(r).foregroundStyle(.secondary) } }
                }
                DatePicker("Day", selection: $excuseDate, in: Date()..., displayedComponents: .date)
                TextField("Reason (optional)", text: $reason)
                Button("Excuse this day") {
                    var c = model.config
                    let day = model.time.dayKey(Millis(excuseDate.timeIntervalSince1970 * 1000))
                    c.excused.removeAll { $0.day == day }
                    c.excused.append(ExcusedDay(day: day, createdAt: nowMillis(), reason: reason.isEmpty ? nil : reason))
                    _ = model.updateConfig(c)
                    reason = ""
                }
            } header: {
                Text("Excused days")
            } footer: {
                Text("Sick or rest days must be set before the lock starts that day. Up to \(model.config.policy.maxExcusedPerMonth) per month.")
            }
            Section("Rules") {
                Stepper("Emergency unlock: \(Int(model.config.policy.emergencyMinutes)) min", value: binding(\.emergencyMinutes), in: 1...120)
                Stepper("Excused days / month: \(model.config.policy.maxExcusedPerMonth)", value: binding(\.maxExcusedPerMonth), in: 0...31)
                Stepper("Away days / month: \(model.config.policy.maxAwayDaysPerMonth)", value: binding(\.maxAwayDaysPerMonth), in: 0...31)
            }
        }
        .navigationTitle("Excused days & rules")
    }

    func binding<T>(_ kp: WritableKeyPath<Policy, T>) -> Binding<T> {
        Binding(get: { model.config.policy[keyPath: kp] }, set: { v in
            var c = model.config
            c.policy[keyPath: kp] = v
            _ = model.updateConfig(c)
        })
    }
}
