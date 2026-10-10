import Foundation
#if canImport(Compression) && canImport(SQLite3)
import Compression
import SQLite3

/// Import Anki packages on the phone. Supports the "legacy" layouts (collection.anki2 /
/// collection.anki21, JSON models). Packages from Anki 2.1.50+ default exports use zstd
/// (collection.anki21b), which iOS can't decompress natively: import those on the computer and
/// they sync to the phone, or export with "Support older Anki versions" ticked.
public enum ApkgImporter {
    public enum ImportError: Error, LocalizedError, Equatable {
        case notZip, noCollection, modernFormat, database(String), tooLarge
        public var errorDescription: String? {
            switch self {
            case .notZip: return "Not a valid Anki package."
            case .noCollection: return "Not an Anki package (no collection inside)."
            case .modernFormat: return "This deck uses Anki's newer compressed format. Import it in the computer app (it syncs here), or re-export from Anki with \"Support older Anki versions\" checked."
            case let .database(m): return "Couldn't read the deck database: \(m)"
            case .tooLarge: return "Package is too large to import."
            }
        }
    }

    // MARK: zip

    struct ZipEntry {
        var name: String
        var method: UInt16
        var compressedSize: Int
        var size: Int
        var localHeaderOffset: Int
    }

    static func u16(_ d: Data, _ o: Int) -> UInt16 { UInt16(d[d.startIndex + o]) | UInt16(d[d.startIndex + o + 1]) << 8 }
    static func u32(_ d: Data, _ o: Int) -> UInt32 { UInt32(u16(d, o)) | UInt32(u16(d, o + 2)) << 16 }

    static func zipEntries(_ d: Data) throws -> [ZipEntry] {
        // End of central directory: search backwards for 0x06054b50.
        guard d.count >= 22 else { throw ImportError.notZip }
        var eocd = -1
        var i = d.count - 22
        while i >= max(0, d.count - 65_557) {
            if u32(d, i) == 0x0605_4B50 { eocd = i; break }
            i -= 1
        }
        guard eocd >= 0 else { throw ImportError.notZip }
        let count = Int(u16(d, eocd + 10))
        var p = Int(u32(d, eocd + 16))
        var out: [ZipEntry] = []
        for _ in 0..<count {
            guard p + 46 <= d.count, u32(d, p) == 0x0201_4B50 else { throw ImportError.notZip }
            let method = u16(d, p + 10)
            let csize = Int(u32(d, p + 20)), size = Int(u32(d, p + 24))
            let nlen = Int(u16(d, p + 28)), xlen = Int(u16(d, p + 30)), clen = Int(u16(d, p + 32))
            let off = Int(u32(d, p + 42))
            guard p + 46 + nlen <= d.count else { throw ImportError.notZip }
            let name = String(decoding: d[(d.startIndex + p + 46)..<(d.startIndex + p + 46 + nlen)], as: UTF8.self)
            out.append(ZipEntry(name: name, method: method, compressedSize: csize, size: size, localHeaderOffset: off))
            p += 46 + nlen + xlen + clen
        }
        return out
    }

    static func extract(_ d: Data, _ e: ZipEntry) throws -> Data {
        let o = e.localHeaderOffset
        guard o + 30 <= d.count, u32(d, o) == 0x0403_4B50 else { throw ImportError.notZip }
        let start = o + 30 + Int(u16(d, o + 26)) + Int(u16(d, o + 28))
        guard start + e.compressedSize <= d.count else { throw ImportError.notZip }
        let comp = d.subdata(in: (d.startIndex + start)..<(d.startIndex + start + e.compressedSize))
        switch e.method {
        case 0: return comp
        case 8: return try inflate(comp, expected: e.size)
        default: throw ImportError.notZip
        }
    }

    /// Raw DEFLATE (zip method 8) via the Compression framework.
    static func inflate(_ src: Data, expected: Int) throws -> Data {
        if expected == 0 { return Data() }
        var dst = Data(count: expected)
        let n = dst.withUnsafeMutableBytes { (dp: UnsafeMutableRawBufferPointer) -> Int in
            src.withUnsafeBytes { (sp: UnsafeRawBufferPointer) -> Int in
                compression_decode_buffer(dp.bindMemory(to: UInt8.self).baseAddress!, expected, sp.bindMemory(to: UInt8.self).baseAddress!, src.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard n == expected else { throw ImportError.notZip }
        return dst
    }

    // MARK: sqlite

    final class DB {
        var handle: OpaquePointer?
        let path: URL
        init(bytes: Data) throws {
            path = FileManager.default.temporaryDirectory.appendingPathComponent("ptu-\(UUID().uuidString).sqlite")
            try bytes.write(to: path)
            guard sqlite3_open_v2(path.path, &handle, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
                throw ImportError.database(String(cString: sqlite3_errmsg(handle)))
            }
        }
        deinit {
            sqlite3_close(handle)
            try? FileManager.default.removeItem(at: path)
        }
        func rows(_ sql: String) throws -> [[String: Any]] {
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else { throw ImportError.database(String(cString: sqlite3_errmsg(handle))) }
            defer { sqlite3_finalize(stmt) }
            var out: [[String: Any]] = []
            while sqlite3_step(stmt) == SQLITE_ROW {
                var row: [String: Any] = [:]
                for i in 0..<sqlite3_column_count(stmt) {
                    let name = String(cString: sqlite3_column_name(stmt, i))
                    switch sqlite3_column_type(stmt, i) {
                    case SQLITE_INTEGER: row[name] = sqlite3_column_int64(stmt, i)
                    case SQLITE_FLOAT: row[name] = sqlite3_column_double(stmt, i)
                    case SQLITE_TEXT: row[name] = String(cString: sqlite3_column_text(stmt, i))
                    case SQLITE_BLOB:
                        let n = Int(sqlite3_column_bytes(stmt, i))
                        row[name] = n > 0 ? Data(bytes: sqlite3_column_blob(stmt, i), count: n) : Data()
                    default: break
                    }
                }
                out.append(row)
            }
            return out
        }
    }

    static func idString(_ v: Any?) -> String {
        if let i = v as? Int64 { return String(i) }
        if let d = v as? Double { return String(Int64(d)) }
        if let s = v as? String { return s }
        return ""
    }

    static let mimes = ["jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml", "mp3": "audio/mpeg", "ogg": "audio/ogg", "wav": "audio/wav", "m4a": "audio/mp4", "mp4": "video/mp4", "webm": "video/webm"]

    static func referencedMedia(_ html: String) -> Set<String> {
        var out = Set<String>()
        for pattern in ["\\bsrc\\s*=\\s*[\"']([^\"']+)[\"']", "\\bsrc\\s*=\\s*([^\\s\"'>]+)", "url\\(\\s*[\"']?([^\"')]+)[\"']?\\s*\\)"] {
            let re = try! NSRegularExpression(pattern: pattern, options: .caseInsensitive)
            let ns = html as NSString
            for m in re.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
                let s = ns.substring(with: m.range(at: 1))
                out.insert(s)
                if let d = s.removingPercentEncoding { out.insert(d) }
            }
        }
        return out
    }

    public static func importPackage(_ bytes: Data, fileName: String = "package.apkg", now: Millis = nowMillis(), maxUncompressed: Int = 1 << 30) throws -> (decks: [Deck], warnings: [String]) {
        let entries = try zipEntries(bytes)
        guard entries.reduce(0, { $0 + $1.size }) <= maxUncompressed else { throw ImportError.tooLarge }
        let byName = Dictionary(entries.map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
        if byName["collection.anki21b"] != nil && byName["collection.anki21"] == nil {
            throw ImportError.modernFormat
        }
        guard let colEntry = byName["collection.anki21"] ?? byName["collection.anki2"] else { throw ImportError.noCollection }
        let db = try DB(bytes: try extract(bytes, colEntry))
        var warnings: [String] = []

        // Models (note types) and decks live as JSON in the `col` table in legacy collections.
        guard let col = try db.rows("SELECT models, decks FROM col").first else { throw ImportError.noCollection }
        struct Tmpl { var name: String; var qfmt: String; var afmt: String }
        struct NT { var name: String; var cloze: Bool; var css: String; var fields: [Int: String]; var templates: [Int: Tmpl] }
        var notetypes: [String: NT] = [:]
        if let json = (col["models"] as? String)?.data(using: .utf8), let models = try JSONSerialization.jsonObject(with: json) as? [String: [String: Any]] {
            for m in models.values {
                var nt = NT(name: m["name"] as? String ?? "", cloze: (m["type"] as? Int ?? 0) == 1, css: m["css"] as? String ?? "", fields: [:], templates: [:])
                for f in m["flds"] as? [[String: Any]] ?? [] { nt.fields[f["ord"] as? Int ?? 0] = f["name"] as? String ?? "" }
                for t in m["tmpls"] as? [[String: Any]] ?? [] { nt.templates[t["ord"] as? Int ?? 0] = Tmpl(name: t["name"] as? String ?? "", qfmt: t["qfmt"] as? String ?? "", afmt: t["afmt"] as? String ?? "") }
                notetypes[idString(m["id"])] = nt
            }
        }
        var deckNames: [String: String] = [:]
        if let json = (col["decks"] as? String)?.data(using: .utf8), let decks = try JSONSerialization.jsonObject(with: json) as? [String: [String: Any]] {
            for d in decks.values { deckNames[idString(d["id"])] = d["name"] as? String ?? "" }
        }

        var notes: [String: (mid: String, fields: [String], tags: [String])] = [:]
        for r in try db.rows("SELECT id, mid, flds, tags FROM notes") {
            notes[idString(r["id"])] = (idString(r["mid"]), (r["flds"] as? String ?? "").components(separatedBy: "\u{1f}"), (r["tags"] as? String ?? "").split(whereSeparator: \.isWhitespace).map(String.init))
        }

        // media: {"0": "file.jpg"}
        var mediaEntry: [String: String] = [:]
        if let m = byName["media"], let data = try? extract(bytes, m), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            for (k, v) in obj { mediaEntry[v] = k }
        }

        var rows = try db.rows("SELECT id, nid, did, ord, type, due FROM cards")
        rows.sort { a, b in
            let pa = (a["type"] as? Int64 ?? 1) == 0 ? (a["due"] as? Int64 ?? 0) : Int64.max
            let pb = (b["type"] as? Int64 ?? 1) == 0 ? (b["due"] as? Int64 ?? 0) : Int64.max
            return pa != pb ? pa < pb : (a["id"] as? Int64 ?? 0) < (b["id"] as? Int64 ?? 0)
        }

        var decks: [String: Deck] = [:]
        var order: [String] = []
        var position = 0, skippedEmpty = 0, skippedBroken = 0
        for r in rows {
            guard let note = notes[idString(r["nid"])], let nt = notetypes[note.mid] else { skippedBroken += 1; continue }
            let ord = Int(r["ord"] as? Int64 ?? 0)
            guard let tmpl = nt.cloze ? nt.templates[0] : nt.templates[ord], !tmpl.qfmt.isEmpty else { skippedBroken += 1; continue }
            var fields: [String: String] = [:]
            for (i, name) in nt.fields { fields[name] = i < note.fields.count ? note.fields[i] : "" }
            let did = idString(r["did"])
            let deckName = deckNames[did] ?? "Imported"
            let (front, back) = CardRender.renderCard(qfmt: tmpl.qfmt, afmt: tmpl.afmt, CardRender.Context(fields: fields, tags: note.tags, deck: deckName, notetype: nt.name, cardName: tmpl.name, clozeOrd: nt.cloze ? ord + 1 : nil))
            if CardRender.isEmptyRender(front) { skippedEmpty += 1; continue }
            if decks[did] == nil {
                decks[did] = Deck(id: "anki-\(did)", name: deckName, importedAt: now, source: fileName, cards: [], styles: [:], media: [:])
                order.append(did)
            }
            decks[did]!.styles[note.mid] = nt.css
            decks[did]!.cards.append(DeckCard(id: "c\(idString(r["id"]))", noteId: "n\(idString(r["nid"]))", ord: ord, front: front, back: back, styleId: note.mid, tags: note.tags, position: position))
            position += 1
            for name in referencedMedia(front + back) where decks[did]!.media[name] == nil {
                guard let entryName = mediaEntry[name], let e = byName[entryName], let data = try? extract(bytes, e) else { continue }
                let ext = (name as NSString).pathExtension.lowercased()
                decks[did]!.media[name] = MediaFile(mime: mimes[ext] ?? "application/octet-stream", data: data.base64EncodedString())
            }
        }
        if skippedEmpty > 0 { warnings.append("\(skippedEmpty) card(s) skipped because their front side is empty") }
        if skippedBroken > 0 { warnings.append("\(skippedBroken) card(s) skipped because their note type is missing or broken") }
        let result = order.compactMap { decks[$0] }.filter { !$0.cards.isEmpty }
        if result.isEmpty { warnings.append("no cards found in this package") }
        return (result, warnings)
    }
}
#endif
