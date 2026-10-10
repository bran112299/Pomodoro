import Foundation
import XCTest
@testable import ProveCore

/// Cross-implementation tests: everything here must match the TypeScript core exactly
/// (spec/vectors/*.json are generated from it).
final class VectorTests: XCTestCase {
    static let root: URL = {
        var u = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { u.deleteLastPathComponent() }
        return u // prove-to-unlock/
    }()

    static func json(_ rel: String) throws -> [String: Any] {
        let data = try Data(contentsOf: root.appendingPathComponent(rel))
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    lazy var core: [String: Any] = try! Self.json("spec/vectors/core.json")

    func ms(_ v: Any?) -> Millis { (v as? NSNumber)?.int64Value ?? 0 }

    func vectorIdentity() throws -> (Identity, [String: String]) {
        let idv = core["identity"] as! [String: Any]
        let d = Data(base64URLEncoded: idv["privateD"] as! String)!
        let id = Identity(key: try SoftwareKey(rawRepresentation: d))
        return (id, [id.deviceId: id.publicKeyBase64])
    }

    // MARK: identity, records, requests

    func testIdentityMatchesWebCrypto() throws {
        let idv = core["identity"] as! [String: Any]
        let (id, _) = try vectorIdentity()
        XCTAssertEqual(id.publicKeyBase64, idv["publicKey"] as? String, "CryptoKit SPKI must equal WebCrypto SPKI")
        XCTAssertEqual(id.deviceId, idv["deviceId"] as? String)
        XCTAssertEqual(id.fingerprint, idv["fingerprint"] as? String)
    }

    func testRecordsSignedByTypeScriptVerify() throws {
        let (_, trusted) = try vectorIdentity()
        for r in core["records"] as! [[String: Any]] {
            switch Records.verify(r["raw"] as! String, trusted: trusted, now: ms(r["iat"])) {
            case let .success(rec):
                XCTAssertEqual(rec.payload.typ.rawValue, r["typ"] as? String)
                XCTAssertEqual(rec.payload.id, r["id"] as? String)
            case let .failure(e):
                XCTFail("record failed to verify: \(e)")
            }
        }
        if case .success = Records.verify(core["tampered"] as! String, trusted: trusted) { XCTFail("tampered record verified") }
        if case .success = Records.verify("garbage", trusted: trusted) { XCTFail("garbage verified") }
        guard case .failure(.untrustedIssuer) = Records.verify((core["records"] as! [[String: Any]])[0]["raw"] as! String, trusted: [:]) else { return XCTFail("expected untrusted") }
    }

    func testSwiftRecordsRoundTripAndExportForTypeScript() throws {
        let (id, trusted) = try vectorIdentity()
        let now: Millis = 1_791_810_000_000
        let recs = try [
            Records.create(id, body: .emergency(EmergencyBody(day: "2026-10-12", until: now + 60_000, reason: "swift")), now: now),
            Records.create(id, body: .proof(ProofBody(cid: "gym", day: "2026-10-12", at: now, detail: .photo(PhotoDetail(dhash: "0123456789abcdef", labels: [PhotoLabel(label: "dumbbell", confidence: 0.81)], referenceSimilarity: 0.7, placeId: "gym", insidePlace: true, live: true, capturedAt: now, challenge: PhotoChallenge(prompt: "Give a thumbs up", confirmed: true))))), now: now),
            Records.create(id, body: .config(Config.makeDefault(now: now)), now: now),
        ]
        for r in recs {
            guard case let .success(v) = Records.verify(r.raw, trusted: trusted, now: now) else { return XCTFail("own record didn't verify") }
            XCTAssertEqual(v.payload, r.payload)
        }
        let body = Data("{\"x\":1}".utf8)
        let header = try LinkProtocol.authHeader(id, method: "POST", path: "/v1/sync", body: body, now: now)
        XCTAssertTrue(LinkProtocol.verifyAuth(header, method: "POST", path: "/v1/sync", body: body, trusted: trusted, now: now))
        // Let CI verify Swift's output with the TypeScript implementation too.
        if let out = ProcessInfo.processInfo.environment["SWIFT_VECTORS_OUT"] {
            let obj: [String: Any] = ["publicKey": id.publicKeyBase64, "deviceId": id.deviceId, "records": recs.map(\.raw), "auth": ["method": "POST", "path": "/v1/sync", "body": "{\"x\":1}", "ts": now, "header": header]]
            try JSONSerialization.data(withJSONObject: obj).write(to: URL(fileURLWithPath: out))
        }
    }

    func testSignedRequestFromTypeScriptVerifies() throws {
        let (_, trusted) = try vectorIdentity()
        let a = core["auth"] as! [String: Any]
        XCTAssertTrue(LinkProtocol.verifyAuth(a["header"] as! String, method: a["method"] as! String, path: a["path"] as! String, body: Data((a["body"] as! String).utf8), trusted: trusted, now: ms(a["ts"])))
        XCTAssertFalse(LinkProtocol.verifyAuth(a["header"] as! String, method: "GET", path: a["path"] as! String, body: Data((a["body"] as! String).utf8), trusted: trusted, now: ms(a["ts"])))
    }

    func testPairingQR() {
        let q = LinkProtocol.decodePairingQR(core["qr"] as! String)
        XCTAssertEqual(q?.hosts, ["192.168.1.20", "10.0.0.7"])
        XCTAssertEqual(q?.port, 47123)
        XCTAssertEqual(q?.code, "042137")
        XCTAssertEqual(q?.name, "Brandon's Mac")
        XCTAssertNil(LinkProtocol.decodePairingQR("https://example.com"))
    }

    // MARK: engine

    func testEngineScenarios() throws {
        let (_, trusted) = try vectorIdentity()
        let cfgData = try JSONSerialization.data(withJSONObject: core["config"]!)
        let config = try JSONCoding.decoder().decode(Config.self, from: cfgData)
        let lt = LocalTime(identifier: "America/New_York")!
        for s in core["scenarios"] as! [[String: Any]] {
            let name = s["name"] as! String
            let now = ms(s["now"])
            let recs: [SignedRecord] = (s["records"] as! [String]).map { raw in
                guard case let .success(r) = Records.verify(raw, trusted: trusted, now: now) else { fatalError("vector record invalid") }
                return r
            }
            let st = Engine.evaluate(config: config, records: recs, now: now, time: lt)
            let exp = s["expected"] as! [String: Any]
            XCTAssertEqual(st.locked, exp["locked"] as? Bool, name)
            XCTAssertEqual(st.nextChangeAt, (exp["nextChangeAt"] as? NSNumber)?.int64Value, name)
            XCTAssertEqual(st.emergencyUntil, (exp["emergencyUntil"] as? NSNumber)?.int64Value, name)
            let cs = exp["commitments"] as! [[String: Any]]
            XCTAssertEqual(st.commitments.count, cs.count, name)
            for (got, want) in zip(st.commitments, cs) {
                XCTAssertEqual(got.commitment.id, want["id"] as? String, name)
                XCTAssertEqual(got.locked, want["locked"] as? Bool, name)
                XCTAssertEqual(got.unlockedBy?.rawValue, want["unlockedBy"] as? String, "\(name) \(got.commitment.id)")
                XCTAssertEqual(got.mode.rawValue, want["mode"] as? String, name)
                XCTAssertEqual(got.requirements.map(\.ok), want["ok"] as? [Bool], "\(name) \(got.commitment.id)")
                XCTAssertEqual(got.requirements.map(\.progress), want["progress"] as? [String], "\(name) \(got.commitment.id)")
            }
        }
    }

    func testConfigRoundTripsThroughJSON() throws {
        let cfgData = try JSONSerialization.data(withJSONObject: core["config"]!)
        let config = try JSONCoding.decoder().decode(Config.self, from: cfgData)
        let again = try JSONCoding.decoder().decode(Config.self, from: JSONCoding.encoder().encode(config))
        XCTAssertEqual(config, again)
        XCTAssertEqual(config.commitments.first?.require, .any(2))
        XCTAssertEqual(config.commitments.first?.requirements.map(\.kind), [.photo, .altitude, .presence])
    }

    // MARK: photo, geo, time

    func pixels(_ w: Int, _ h: Int, _ kind: Int) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(w * h * 4)
        for y in 0..<h {
            for x in 0..<w {
                let v: Int
                switch kind {
                case 0: v = (x * 7 + y * 13) % 256
                case 1: v = (x * x + y * 3) % 251
                default: v = ((x >> 3) ^ (y >> 2)) & 1 == 1 ? 230 : 20
                }
                out += [UInt8(v), UInt8((v * 3) % 256), UInt8(255 - v), 255]
            }
        }
        return out
    }

    func testDHashMatchesTypeScript() {
        for c in core["dhash"] as! [[String: Any]] {
            let w = c["width"] as! Int, h = c["height"] as! Int, k = c["kind"] as! Int
            XCTAssertEqual(PhotoCheck.dHash(rgba: pixels(w, h, k), width: w, height: h), c["expected"] as? String, "\(w)x\(h) kind \(k)")
        }
        XCTAssertEqual(PhotoCheck.hamming("0000000000000000", "000000000000000f"), 4)
        XCTAssertNil(PhotoCheck.hamming("xyz", "0000000000000000"))
    }

    func testGeo() {
        let geo = core["geo"] as! [String: Any]
        for c in geo["distances"] as! [[String: Any]] {
            let a = c["a"] as! [String: Double], b = c["b"] as! [String: Double]
            XCTAssertEqual(Geo.distanceM(LatLon(lat: a["lat"]!, lon: a["lon"]!), LatLon(lat: b["lat"]!, lon: b["lon"]!)), c["meters"] as! Double, accuracy: 1e-6)
        }
        for c in geo["containment"] as! [[String: Any]] {
            let p = c["place"] as! [String: Any], f = c["fix"] as! [String: Double]
            let place = Place(id: "g", name: "G", lat: p["lat"] as! Double, lon: p["lon"] as! Double, radiusM: p["radiusM"] as! Double)
            XCTAssertEqual(Geo.containment(place, lat: f["lat"]!, lon: f["lon"]!, accuracyM: f["accuracyM"]).rawValue, c["expected"] as? String)
        }
        for c in geo["away"] as! [[String: Any]] {
            let r = c["region"] as! [String: Any]
            let region = Place(id: "c", name: "City", lat: r["lat"] as! Double, lon: r["lon"] as! Double, radiusM: r["radiusM"] as! Double)
            let samples = (c["samples"] as! [[String: Any]]).map { LocationSample(t: ms($0["t"]), lat: ($0["lat"] as! NSNumber).doubleValue, lon: ($0["lon"] as! NSNumber).doubleValue) }
            let got = Geo.assessAway(samples, region: region, from: ms(c["from"]), to: ms(c["to"]), outsideFraction: c["outsideFraction"] as! Double, minHours: (c["minHours"] as! NSNumber).doubleValue)
            let exp = c["expected"] as! [String: Any]
            XCTAssertEqual(got.region.rawValue, exp["region"] as? String)
            XCTAssertEqual(got.outsideFraction, (exp["outsideFraction"] as! NSNumber).doubleValue, accuracy: 1e-9)
            XCTAssertEqual(got.spanHours, (exp["spanHours"] as! NSNumber).doubleValue, accuracy: 1e-9)
        }
        for c in geo["floors"] as! [[String: Any]] {
            let samples = (c["samples"] as! [[String: Any]]).map { Geo.AltitudeSample(t: ms($0["t"]), relM: ($0["relM"] as! NSNumber).doubleValue) }
            let reqData = try! JSONSerialization.data(withJSONObject: c["req"]!)
            let req = try! JSONDecoder().decode(AltitudeRequirement.self, from: reqData)
            let got = Geo.evaluateFloorChange(samples, req)
            let exp = c["expected"] as! [String: Any]
            XCTAssertEqual(got.ok, exp["ok"] as? Bool)
            XCTAssertEqual(got.deltaM, (exp["deltaM"] as! NSNumber).doubleValue, accuracy: 1e-9)
            XCTAssertEqual(got.reason, exp["reason"] as? String)
        }
    }

    func testTimeZonesAndDST() {
        let t = core["time"] as! [String: Any]
        let lt = LocalTime(identifier: t["tz"] as! String)!
        for c in t["dayKeys"] as! [[String: Any]] {
            XCTAssertEqual(lt.dayKey(ms(c["ms"])), c["expected"] as? String)
        }
        for c in t["windows"] as! [[String: Any]] {
            let b = lt.windowBounds(day: c["day"] as! String, window: TimeWindow(start: c["start"] as! String, end: c["end"] as! String))
            let exp = c["expected"] as! [String: Any]
            XCTAssertEqual(b?.start, ms(exp["start"]), "\(c)")
            XCTAssertEqual(b?.end, ms(exp["end"]), "\(c)")
        }
        XCTAssertNil(LocalTime.parseTimeOfDay("25:00"))
        XCTAssertEqual(LocalTime.weekday("2026-10-12"), 1)
        XCTAssertEqual(LocalTime.weekday("2026-10-11"), 0)
    }

    // MARK: study + FSRS

    func testStudyQueue() throws {
        let s = core["study"] as! [String: Any]
        let deck = try JSONCoding.decoder().decode(Deck.self, from: JSONSerialization.data(withJSONObject: s["deck"]!))
        let events = try JSONCoding.decoder().decode([ReviewEvent].self, from: JSONSerialization.data(withJSONObject: s["events"]!))
        let lt = LocalTime(identifier: "America/New_York")!
        for q in s["queues"] as! [[String: Any]] {
            let got = Study.buildQueue(decks: [deck], events: events, now: ms(q["now"]), newPerDay: s["newPerDay"] as! Int, time: lt)
            let exp = q["expected"] as! [String: Any]
            let counts = exp["counts"] as! [String: Int]
            XCTAssertEqual(got.counts.new, counts["new"])
            XCTAssertEqual(got.counts.learning, counts["learning"])
            XCTAssertEqual(got.counts.review, counts["review"])
            XCTAssertEqual(Array(got.items.prefix(5)).map(\.card.id), exp["first"] as? [String])
            XCTAssertEqual(got.cleared, exp["cleared"] as? Bool)
            XCTAssertEqual(got.nextDueAt, (exp["nextDueAt"] as? NSNumber)?.int64Value)
        }
    }

    func testFSRSMatchesReference() throws {
        let v = try Self.json("spec/vectors/fsrs.json")
        var reference = FsrsParams.default
        reference.enforceOrdering = false
        for (i, seq) in (v["sequences"] as! [[[String: Any]]]).enumerated() {
            var card = SrsCard.new(now: ms(seq[0]["at"]))
            for step in seq {
                card = FSRS.review(card, Rating(rawValue: step["rating"] as! Int)!, now: ms(step["at"]), reference)
                XCTAssertEqual(card.state.rawValue, step["state"] as? String, "seq \(i)")
                if card.state != .review { XCTAssertEqual(card.step, step["step"] as? Int, "seq \(i)") }
                XCTAssertEqual(card.stability, (step["stability"] as! NSNumber).doubleValue, accuracy: 1e-6, "seq \(i)")
                XCTAssertEqual(card.difficulty, (step["difficulty"] as! NSNumber).doubleValue, accuracy: 1e-6, "seq \(i)")
                XCTAssertEqual(card.due, ms(step["due"]), "seq \(i)")
            }
        }
    }

    // MARK: Anki import

    #if canImport(SQLite3)
    func testLegacyApkgImport() throws {
        let data = try Data(contentsOf: Self.root.appendingPathComponent("packages/core/test/fixtures/legacy.apkg"))
        let (decks, warnings) = try ApkgImporter.importPackage(data)
        XCTAssertEqual(warnings, [])
        XCTAssertEqual(decks.map(\.name).sorted(), ["Geography", "Spanish::Verbs"])
        let spanish = decks.first { $0.name == "Spanish::Verbs" }!
        XCTAssertEqual(spanish.cards.map(\.front), ["comer", "beber", "vivir"])
        let geo = decks.first { $0.name == "Geography" }!
        XCTAssertEqual(geo.cards.count, 4)
        XCTAssertTrue(geo.cards.contains { $0.front.contains("[country]") && $0.front.contains("Canberra") })
        XCTAssertEqual(Array(geo.media.keys), ["flag-red.png"])

        XCTAssertThrowsError(try ApkgImporter.importPackage(Data(contentsOf: Self.root.appendingPathComponent("packages/core/test/fixtures/modern.apkg")))) { e in
            XCTAssertEqual(e as? ApkgImporter.ImportError, .modernFormat)
        }
    }
    #endif

    // MARK: ledger + proofs

    func testLedgerProofsAndLockRules() throws {
        let id = Identity(key: SoftwareKey())
        let ledger = try Ledger(identity: id, name: "Test iPhone")
        let lt = LocalTime(identifier: "America/New_York")!
        let now = lt.epoch(day: "2026-10-12", minutesOfDay: 12 * 60)!
        try ledger.updateConfig(now: now - 3_600_000) { c in
            c.commitments = [Commitment(id: "f", title: "Focus", days: [0, 1, 2, 3, 4, 5, 6], window: TimeWindow(start: "00:00", end: "24:00"), requirements: [.focus(FocusRequirement(sessions: 1))], createdAt: 0)]
        }
        var state = Engine.evaluate(config: ledger.config(), records: ledger.records(), now: now, time: lt)
        XCTAssertTrue(state.locked)
        // Can't delete a locked commitment.
        var edited = ledger.config()
        edited.commitments = []
        XCTAssertNotNil(Engine.configChangeBlockedWhileLocked(prev: ledger.config(), next: edited, state: state))
        XCTAssertTrue(try Proofs.issueFocusProof(ledger: ledger, commitmentId: "f", minutes: 25, now: now, time: lt))
        state = Engine.evaluate(config: ledger.config(), records: ledger.records(), now: now, time: lt)
        XCTAssertFalse(state.locked)
        XCTAssertEqual(state.commitments.first?.unlockedBy, .proven)

        // Persist + reload as read-only (what the Screen Time extension does).
        let data = try JSONCoding.encoder().encode(ledger.data)
        let ro = Ledger(readOnly: try JSONCoding.decoder().decode(LedgerData.self, from: data))
        XCTAssertEqual(ro.records().count, ledger.records().count)
        XCTAssertFalse(Engine.evaluate(config: ro.config(), records: ro.records(), now: now, time: lt).locked)
    }
}
