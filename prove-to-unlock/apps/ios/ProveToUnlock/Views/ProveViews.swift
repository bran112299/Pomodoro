import Combine
import ProveCore
import SwiftUI
import UIKit

/// Live camera only: no photo library, so old photos can't be used.
struct CameraPicker: UIViewControllerRepresentable {
    var onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    static var available: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.cameraCaptureMode = .photo
        p.allowsEditing = false
        p.delegate = context.coordinator
        return p
    }

    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ p: CameraPicker) { parent = p }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let img = info[.originalImage] as? UIImage { parent.onImage(img) }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

struct PhotoProofView: View {
    @EnvironmentObject var model: AppModel
    let target: ProveTarget
    let requirement: PhotoRequirement
    @State private var challenge: String?
    @State private var showCamera = false
    @State private var image: UIImage?
    @State private var capturedAt: Millis = 0
    @State private var checking = false
    @State private var result: PhotoCheck.Result?
    @State private var confirmedChallenge = false

    var body: some View {
        Form {
            Section {
                Text(describe(.photo(requirement), places: model.config.places)).font(.headline)
                if let c = challenge {
                    Label("Challenge: \(c)", systemImage: "hand.raised.fill").font(.title3.bold()).foregroundStyle(.orange)
                }
                if let labels = requirement.labelsAny, !labels.isEmpty {
                    Text("Must show: \(labels.joined(separator: ", "))").foregroundStyle(.secondary)
                }
            }
            if let img = image {
                Section {
                    Image(uiImage: img).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 12))
                    if challenge != nil && result == nil {
                        Toggle("This photo shows the challenge", isOn: $confirmedChallenge)
                    }
                }
            }
            if let r = result {
                Section {
                    if r.ok {
                        Label("Photo accepted", systemImage: "checkmark.seal.fill").foregroundStyle(.green).font(.headline)
                    } else {
                        Label("Photo not accepted", systemImage: "xmark.octagon.fill").foregroundStyle(.red).font(.headline)
                        ForEach(r.failures, id: \.self) { Text($0).foregroundStyle(.red) }
                    }
                }
            }
            Section {
                if checking {
                    HStack { ProgressView(); Text("Checking on this iPhone…") }
                } else if image != nil && result == nil {
                    Button("Submit photo") { Task { await submit() } }
                        .disabled(challenge != nil && !confirmedChallenge)
                    Button("Retake", role: .cancel) { image = nil; showCamera = true }
                } else if result?.ok != true {
                    Button(CameraPicker.available ? "Take photo" : "No camera available") {
                        result = nil
                        showCamera = true
                    }
                    .disabled(!CameraPicker.available)
                }
            } footer: {
                Text("Checked on-device: the photo must be new (compared with every earlier proof photo), taken in the app\(requirement.placeId != nil ? ", inside the place" : "")\(requirement.minReferenceSimilarity != nil ? ", and look like your reference photos" : "").")
            }
        }
        .navigationTitle("Photo proof")
        .onAppear { if requirement.challenge == true && challenge == nil { challenge = PhotoCheck.randomChallenge() } }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { img in
                image = img
                capturedAt = nowMillis()
                confirmedChallenge = false
                if challenge == nil { Task { await submit() } }
            }
            .ignoresSafeArea()
        }
    }

    func submit() async {
        guard let img = image else { return }
        checking = true
        result = await model.provePhoto(commitmentId: target.commitmentId, requirementIndex: target.requirementIndex, image: img, capturedAt: capturedAt, challenge: challenge.map { PhotoChallenge(prompt: $0, confirmed: confirmedChallenge) })
        checking = false
    }
}

struct PresenceProofView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var location: LocationService
    let commitmentId: String
    let requirement: PresenceRequirement

    var place: Place? { model.config.places.first { $0.id == requirement.placeId } }

    var body: some View {
        Form {
            Section {
                Text(describe(.presence(requirement), places: model.config.places)).font(.headline)
                if let since = location.inside[requirement.placeId] {
                    Label("You're there (since \(Date(timeIntervalSince1970: Double(since) / 1000).formatted(date: .omitted, time: .shortened)))", systemImage: "mappin.circle.fill").foregroundStyle(.green)
                    Button("Record my time so far") { model.checkpointPresence(placeId: requirement.placeId) }
                } else {
                    Label("Not there yet", systemImage: "mappin.slash").foregroundStyle(.secondary)
                }
            } footer: {
                Text("Your time inside \(place?.name ?? "the place") is recorded automatically when you leave, even if the app is closed (needs location access set to Always).")
            }
            if location.authorization != .authorizedAlways {
                Section {
                    Button("Allow location “Always”") { location.requestPermission() }
                }
            }
        }
        .navigationTitle("Be there")
    }
}

struct FloorsProofView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var alt = AltimeterService()
    let commitmentId: String
    let requirement: AltitudeRequirement
    @State private var result: Geo.FloorResult?

    var required: Double { requirement.floors * (requirement.metersPerFloor ?? 3) }

    var body: some View {
        Form {
            Section {
                Text(describe(.altitude(requirement), places: model.config.places)).font(.headline)
                if alt.running {
                    Text(String(format: "%+.1f m", alt.currentDelta)).font(.system(size: 54, weight: .bold, design: .rounded)).monospacedDigit()
                    Text("Need about \(formatNumber(required)) m \(requirement.direction.rawValue).").foregroundStyle(.secondary)
                }
                if let r = result {
                    if r.ok { Label("Floors verified", systemImage: "checkmark.seal.fill").foregroundStyle(.green) }
                    else { Label(r.reason ?? "Not enough height change", systemImage: "xmark.octagon.fill").foregroundStyle(.red) }
                }
                if let e = alt.error { Text(e).foregroundStyle(.red) }
            }
            Section {
                if !alt.running {
                    Button("I'm heading there") { result = nil; alt.start() }.disabled(!AltimeterService.available)
                } else {
                    Button("I'm there") {
                        alt.stop()
                        result = model.proveFloors(commitmentId: commitmentId, requirement: requirement, samples: alt.samples)
                    }
                    Button("Cancel", role: .cancel) { alt.stop() }
                }
            } footer: {
                Text("Uses the barometer, which senses height changes of a few tens of centimeters. Start where you are now, walk there, then tap “I'm there” (within 30 minutes; the weather shifts air pressure over longer times).")
            }
        }
        .navigationTitle("Floors")
        .onDisappear { alt.stop() }
    }
}

struct FocusProofView: View {
    @EnvironmentObject var model: AppModel
    let commitmentId: String
    @State var minutes: Double
    @State private var endAt: Date?
    @State private var now = Date()
    @State private var done = false
    private let tick = Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()

    init(commitmentId: String, minutes: Double) {
        self.commitmentId = commitmentId
        _minutes = State(initialValue: minutes)
    }

    var body: some View {
        VStack(spacing: 24) {
            if let end = endAt {
                let left = max(0, end.timeIntervalSince(now))
                Text(String(format: "%02d:%02d", Int(left) / 60, Int(left) % 60)).font(.system(size: 72, weight: .bold, design: .rounded)).monospacedDigit()
                Text("Stay focused. The session counts when it reaches zero.").foregroundStyle(.secondary)
                Button("Give up this session", role: .destructive) { endAt = nil }
            } else {
                if done { Label("Session recorded", systemImage: "checkmark.seal.fill").foregroundStyle(.green).font(.headline) }
                Stepper("\(Int(minutes)) minutes", value: $minutes, in: 5...180, step: 5)
                Button("Start focus session") { endAt = Date().addingTimeInterval(minutes * 60); done = false }.buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .navigationTitle("Focus")
        .onReceive(tick) { t in
            now = t
            if let end = endAt, t >= end {
                endAt = nil
                done = true
                model.proveFocus(commitmentId: commitmentId, minutes: minutes)
            }
        }
    }
}
