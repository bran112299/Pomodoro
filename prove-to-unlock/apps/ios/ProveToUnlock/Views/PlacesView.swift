import CoreLocation
import MapKit
import ProveCore
import SwiftUI

/// Life360-style places: tap the map to drop a pin, name it, drag the radius slider.
struct PlacesView: View {
    @EnvironmentObject var model: AppModel
    @State private var camera: MapCameraPosition = .userLocation(fallback: .automatic)
    @State private var editing: Place?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                MapReader { proxy in
                    Map(position: $camera) {
                        UserAnnotation()
                        ForEach(model.config.places) { p in
                            MapCircle(center: CLLocationCoordinate2D(latitude: p.lat, longitude: p.lon), radius: p.radiusM)
                                .foregroundStyle(.blue.opacity(0.18))
                                .stroke(.blue, lineWidth: 2)
                            Annotation(p.name, coordinate: CLLocationCoordinate2D(latitude: p.lat, longitude: p.lon)) {
                                Image(systemName: "mappin.circle.fill").font(.title).foregroundStyle(.red)
                                    .onTapGesture { editing = p }
                            }
                        }
                    }
                    .onTapGesture { pt in
                        if let c = proxy.convert(pt, from: .local) {
                            editing = Place(id: randomId(bytes: 6), name: "", lat: c.latitude, lon: c.longitude, radiusM: 100)
                        }
                    }
                }
                .mapControls { MapUserLocationButton(); MapCompass() }
                .frame(minHeight: 320)

                List {
                    Section {
                        ForEach(model.config.places) { p in
                            Button { editing = p } label: {
                                HStack {
                                    Text(p.name.isEmpty ? "Unnamed" : p.name)
                                    Spacer()
                                    Text(p.radiusM >= 1000 ? String(format: "%.1f km", p.radiusM / 1000) : "\(Int(p.radiusM)) m").foregroundStyle(.secondary)
                                }
                            }
                        }
                    } header: {
                        Text("Tap the map to add a place")
                    } footer: {
                        Text("Use a small circle for the task area (the gym) and a big one for your reachable region (your city), for the away policy.")
                    }
                }
                .listStyle(.insetGrouped)
            }
            .navigationTitle("Places")
            .sheet(item: $editing) { p in
                PlaceEditor(place: p).presentationDetents([.medium])
            }
        }
    }
}

struct PlaceEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State var place: Place

    // Slider on a log scale: 20 m ... 50 km.
    var sliderValue: Binding<Double> {
        Binding(get: { log10(place.radiusM) }, set: { place.radiusM = (pow(10, $0) / 10).rounded() * 10 })
    }

    var exists: Bool { model.config.places.contains { $0.id == place.id } }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name (e.g. Gym, Home, City)", text: $place.name)
                VStack(alignment: .leading) {
                    Text("Radius: " + (place.radiusM >= 1000 ? String(format: "%.1f km", place.radiusM / 1000) : "\(Int(place.radiusM)) m"))
                    Slider(value: sliderValue, in: log10(20)...log10(50_000))
                }
                Text(String(format: "%.5f, %.5f", place.lat, place.lon)).font(.caption).foregroundStyle(.secondary)
                Button("Use my current location") {
                    Task {
                        if let f = await model.location.currentFix() {
                            place.lat = f.coordinate.latitude
                            place.lon = f.coordinate.longitude
                        }
                    }
                }
                if exists {
                    Button("Delete place", role: .destructive) {
                        var c = model.config
                        c.places.removeAll { $0.id == place.id }
                        if model.updateConfig(c) { dismiss() }
                    }
                }
            }
            .navigationTitle(exists ? "Edit place" : "New place")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var c = model.config
                        if let i = c.places.firstIndex(where: { $0.id == place.id }) { c.places[i] = place } else { c.places.append(place) }
                        if model.updateConfig(c) { dismiss() }
                    }
                    .disabled(place.name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
