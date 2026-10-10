import Combine
import ProveCore
import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// Renders card HTML with JavaScript disabled (cards can't run scripts) and media inlined.
struct CardWebView: UIViewRepresentable {
    var html: String
    var css: String
    var media: [String: MediaFile]

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = false
        let v = WKWebView(frame: .zero, configuration: cfg)
        v.isOpaque = false
        v.backgroundColor = .clear
        return v
    }

    func updateUIView(_ v: WKWebView, context: Context) {
        let doc = """
        <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>:root{color-scheme:light dark}body{font:22px -apple-system,sans-serif;text-align:center;padding:12px;margin:0;word-wrap:break-word}img{max-width:100%;height:auto}.cloze{font-weight:bold;color:#3478f6}hr#answer{border:0;border-top:1px solid #8884;margin:16px 0}</style>
        <style>\(css)</style></head><body class="card">\(Self.inline(html, media))</body></html>
        """
        v.loadHTMLString(doc, baseURL: nil)
    }

    static func inline(_ html: String, _ media: [String: MediaFile]) -> String {
        var out = html
        for (name, f) in media {
            let url = "data:\(f.mime);base64,\(f.data)"
            for q in ["\"", "'"] {
                out = out.replacingOccurrences(of: "src=\(q)\(name)\(q)", with: "src=\(q)\(url)\(q)")
                if let enc = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed), enc != name {
                    out = out.replacingOccurrences(of: "src=\(q)\(enc)\(q)", with: "src=\(q)\(url)\(q)")
                }
            }
        }
        return out
    }
}

func fmtInterval(_ ms: Millis) -> String {
    let m = Double(ms) / 60_000
    if m < 60 { return "\(max(1, Int(m.rounded())))m" }
    let h = m / 60
    if h < 24 { return "\(Int(h.rounded()))h" }
    let d = h / 24
    if d < 31 { return "\(Int(d.rounded()))d" }
    if d < 365 { return String(format: "%.1fmo", d / 30) }
    return String(format: "%.1fy", d / 365)
}

struct StudyView: View {
    @EnvironmentObject var model: AppModel
    var deckIds: [String]?
    var target: Int?
    @State private var shownAt: Millis?
    @State private var now = nowMillis()
    @State private var note: String?

    static let ratingColors: [Color] = [.gray, .red, .orange, .green, .blue]

    var queue: StudyQueue {
        Study.buildQueue(decks: model.decks, events: model.reviews, now: now, newPerDay: model.settings.newCardsPerDay, deckIds: deckIds, time: model.time)
    }

    var honest: Int {
        Study.honestReviewsToday(model.reviews, now: now, minAnswerMs: model.config.policy.minAnswerMs, deviceId: model.deviceId, deckIds: deckIds, time: model.time)
    }

    var body: some View {
        let q = queue
        VStack(spacing: 12) {
            HStack {
                Text("\(q.counts.new)").foregroundStyle(.blue)
                Text("\(q.counts.learning)").foregroundStyle(.orange)
                Text("\(q.counts.review)").foregroundStyle(.green)
                Spacer()
                Text("\(honest)\(target.map { " / \($0)" } ?? "") honest reviews").font(.caption).foregroundStyle(.secondary)
            }
            .font(.headline)
            if model.decks.isEmpty {
                ContentUnavailableView("No decks", systemImage: "rectangle.stack", description: Text("Import an .apkg in the Cards tab, or link a computer; its decks sync here."))
            } else if let item = q.items.first {
                let deck = model.decks.first { $0.id == item.deckId }
                CardWebView(html: shownAt == nil ? item.card.front : item.card.back, css: deck?.styles[item.card.styleId] ?? "", media: deck?.media ?? [:])
                    .frame(maxHeight: .infinity)
                if let shown = shownAt {
                    let p = FSRS.preview(item.srs, now: nowMillis())
                    HStack {
                        ForEach(Rating.allCases, id: \.self) { r in
                            Button {
                                rate(r, item: item, shown: shown)
                            } label: {
                                VStack {
                                    Text(fmtInterval((p[r]?.due ?? 0) - nowMillis())).font(.caption2)
                                    Text(["", "Again", "Hard", "Good", "Easy"][r.rawValue]).bold()
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .tint(Self.ratingColors[r.rawValue])
                        }
                    }
                } else {
                    Button("Show answer") { shownAt = nowMillis() }.buttonStyle(.borderedProminent).controlSize(.large)
                }
            } else {
                ContentUnavailableView(q.cleared ? "All caught up" : "Nothing due right now", systemImage: "checkmark.circle", description: Text(q.nextDueAt.map { "Next learning card in \(fmtInterval($0 - now))." } ?? ""))
            }
            if let n = note { Text(n).font(.caption).foregroundStyle(.orange) }
        }
        .padding()
        .navigationTitle("Study")
        .onReceive(Timer.publish(every: 10, on: .main, in: .common).autoconnect()) { _ in now = nowMillis() }
    }

    func rate(_ r: Rating, item: QueueItem, shown: Millis) {
        let at = nowMillis()
        note = Double(at - shown) < model.config.policy.minAnswerMs ? "Too fast to count: read the answer before rating." : nil
        model.addReview(ReviewEvent(id: randomId(bytes: 12), cardId: item.card.id, deckId: item.deckId, rating: r, at: at, answerShownAt: shown, deviceId: model.deviceId))
        shownAt = nil
        now = nowMillis()
    }
}

struct DecksView: View {
    @EnvironmentObject var model: AppModel
    @State private var importing = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink("Study now") { StudyView() }.disabled(model.decks.isEmpty)
                    Button("Import .apkg file") { importing = true }
                } footer: {
                    Text("Decks imported in the computer app sync here automatically. Newer Anki exports (compressed) must be imported on the computer, or exported with “Support older Anki versions”.")
                }
                Section("Decks") {
                    if model.decks.isEmpty { Text("No decks yet.").foregroundStyle(.secondary) }
                    ForEach(model.decks) { d in
                        VStack(alignment: .leading) {
                            Text(d.name)
                            Text("\(d.cards.count) cards").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .onDelete { idx in idx.map { model.decks[$0].id }.forEach(model.deleteDeck) }
                }
            }
            .navigationTitle("Cards")
            .fileImporter(isPresented: $importing, allowedContentTypes: [UTType(filenameExtension: "apkg") ?? .data, UTType(filenameExtension: "colpkg") ?? .data, .zip, .data]) { result in
                if case let .success(url) = result { model.importDeck(from: url) }
            }
        }
    }
}
