// Generates spec/vectors/core.json from the TypeScript core. The Swift port (apps/ios/ProveCore)
// tests against these, so signatures, rules, time zones, hashing and scheduling agree exactly.
//   npx tsx scripts/gen-vectors.ts

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Commitment,
  type Config,
  Ledger,
  assessAway,
  authHeader,
  buildQueue,
  bytesToB64url,
  containment,
  createRecord,
  dHash,
  dayKey,
  defaultConfig,
  distanceM,
  encodePairingQr,
  evaluate,
  evaluateFloorChange,
  exportIdentity,
  fingerprint,
  localTimeToEpoch,
  parseRecordUnverified,
  utf8,
  windowBounds,
  type Deck,
  type ReviewEvent,
} from "../packages/core/src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TZ = "America/New_York";

function pixels(w: number, h: number, kind: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = kind === 0 ? (x * 7 + y * 13) % 256 : kind === 1 ? (x * x + y * 3) % 251 : ((x >> 3) ^ (y >> 2)) & 1 ? 230 : 20;
      out.push(v, (v * 3) % 256, 255 - v, 255);
    }
  return out;
}

async function main() {
  const phone = await Ledger.create("Vector Phone", "ios");
  const id = phone.identity;
  const stored = await exportIdentity(id);
  const now = localTimeToEpoch("2026-10-12", 10 * 60, TZ); // Monday 10:00 New York

  // --- records
  const records = [
    await createRecord(id, "emergency", { day: "2026-10-12", until: now + 900_000, reason: "vector" }, now),
    await createRecord(id, "proof", { cid: "gym", day: "2026-10-12", kind: "focus", at: now, detail: { sessions: 1, minutes: 25 } }, now),
    await createRecord(id, "status", { cid: "gym", day: "2026-10-12", region: "away", outsideFraction: 0.9, spanHours: 8 }, now),
  ];
  const p = parseRecordUnverified(records[0]!.raw)!;
  (p.body as { until: number }).until += 1;
  const tampered = bytesToB64url(utf8(JSON.stringify(p))) + "." + records[0]!.raw.split(".")[1];

  const body = '{"records":[],"reviews":[],"since":{"records":0,"reviews":0}}';
  const auth = { method: "POST", path: "/v1/sync", body, ts: now, header: await authHeader(id, "POST", "/v1/sync", utf8(body), now) };

  // --- engine scenarios (records signed by the vector identity)
  const gym: Commitment = {
    id: "gym",
    title: "Gym",
    enabled: true,
    days: [1, 2, 3, 4, 5],
    window: { start: "06:00", end: "24:00" },
    requirements: [
      { kind: "photo", placeId: "gym", repeatMaxHamming: 8, labelsAny: ["dumbbell"] },
      { kind: "altitude", direction: "down", floors: 2 },
      { kind: "presence", placeId: "gym", minutes: 30 },
    ],
    require: { any: 2 },
    away: { regionPlaceId: "city", requirements: [{ kind: "focus", sessions: 1 }], require: "all" },
    createdAt: 0,
  };
  const config: Config = {
    ...defaultConfig(now - 86_400_000),
    rev: 3,
    commitments: [gym, { ...gym, id: "anki", title: "Anki", days: [0, 1, 2, 3, 4, 5, 6], away: undefined, requirements: [{ kind: "anki", mode: "count", count: 30 }], require: "all" }],
    places: [
      { id: "gym", name: "Gym", lat: 40.7128, lon: -74.006, radiusM: 60 },
      { id: "city", name: "NYC", lat: 40.7128, lon: -74.006, radiusM: 30000 },
    ],
    excused: [{ day: "2026-10-14", createdAt: now }],
  };
  const t = (h: number, m = 0, day = "2026-10-12") => localTimeToEpoch(day, h * 60 + m, TZ);
  const sign = (typ: "proof" | "emergency" | "status" | "unlock", body: unknown, at: number) => createRecord(id, typ, body as never, at);
  const photo = (dhash: string, at: number, day = "2026-10-12", extra = {}) =>
    sign("proof", { cid: "gym", day, kind: "photo", at, detail: { dhash, labels: [{ label: "dumbbell", confidence: 0.7 }], live: true, capturedAt: at, placeId: "gym", insidePlace: true, ...extra } }, at);
  const trusted = new Map([[id.deviceId, id.publicKey]]);
  void trusted;

  const scenarioRecords = {
    none: [] as string[],
    photoAndFloors: [(await photo("f0f0f0f0f0f0f0f0", t(7))).raw, (await sign("proof", { cid: "gym", day: "2026-10-12", kind: "altitude", at: t(7), detail: { deltaM: -6.2, samples: 30, startedAt: t(6, 58), endedAt: t(7) } }, t(7))).raw],
    repeatPhoto: [(await photo("aaaaaaaaaaaaaaaa", t(7, 0, "2026-10-09"), "2026-10-09")).raw, (await photo("aaaaaaaaaaaaaaab", t(7))).raw, (await sign("proof", { cid: "gym", day: "2026-10-12", kind: "presence", at: t(8), detail: { placeId: "gym", from: t(7), to: t(7, 20) } }, t(8))).raw, (await sign("proof", { cid: "gym", day: "2026-10-12", kind: "presence", at: t(8), detail: { placeId: "gym", from: t(7, 10), to: t(7, 35) } }, t(8))).raw],
    away: [(await sign("status", { cid: "gym", day: "2026-10-12", region: "away", outsideFraction: 0.95, spanHours: 6 }, t(9))).raw, (await sign("proof", { cid: "gym", day: "2026-10-12", kind: "focus", at: t(9, 30), detail: { sessions: 1, minutes: 25 } }, t(9, 30))).raw],
    emergency: [(await sign("emergency", { day: "2026-10-12", until: t(10, 15) }, t(10))).raw],
    anki: [(await sign("proof", { cid: "anki", day: "2026-10-12", kind: "anki", at: t(8), detail: { reviews: 18, cleared: false, deckIds: [] } }, t(8))).raw, (await sign("proof", { cid: "anki", day: "2026-10-12", kind: "anki", at: t(9), detail: { reviews: 12, cleared: false, deckIds: [] } }, t(9))).raw],
  };
  const scenarios: unknown[] = [];
  const addScenario = async (name: string, recs: string[], at: number) => {
    const verified = [];
    for (const raw of recs) {
      const v = await (await import("../packages/core/src/records.js")).verifyRecord(raw, new Map([[id.deviceId, id.publicKey]]), at);
      if (!v.ok) throw new Error(`vector record didn't verify: ${v.reason}`);
      verified.push(v.record);
    }
    const s = evaluate({ config, records: verified, now: at, tz: TZ });
    scenarios.push({
      name,
      now: at,
      records: recs,
      expected: {
        locked: s.locked,
        nextChangeAt: s.nextChangeAt ?? null,
        emergencyUntil: s.emergencyUntil ?? null,
        commitments: s.commitments.map((c) => ({ id: c.commitment.id, locked: c.locked, unlockedBy: c.unlockedBy ?? null, mode: c.mode, ok: c.requirements.map((r) => r.ok), progress: c.requirements.map((r) => r.progress) })),
      },
    });
  };
  await addScenario("before window", scenarioRecords.none, t(5));
  await addScenario("locked, nothing proven", scenarioRecords.none, t(10));
  await addScenario("photo + floors (any 2 of 3)", scenarioRecords.photoAndFloors, t(10));
  await addScenario("repeat photo rejected, overlapping presence merged", scenarioRecords.repeatPhoto, t(10));
  await addScenario("away mode with substitute", scenarioRecords.away, t(10));
  await addScenario("emergency active", scenarioRecords.emergency, t(10, 5));
  await addScenario("emergency over", scenarioRecords.emergency, t(10, 20));
  await addScenario("anki counts add up", scenarioRecords.anki, t(10));
  await addScenario("excused day declared in advance", scenarioRecords.none, t(10, 0, "2026-10-14"));
  await addScenario("weekend: gym not active", scenarioRecords.none, t(10, 0, "2026-10-11"));

  // --- dHash
  const dhash = [
    { width: 64, height: 48, kind: 0 },
    { width: 97, height: 61, kind: 1 },
    { width: 128, height: 128, kind: 2 },
    { width: 9, height: 8, kind: 1 },
  ].map((c) => ({ ...c, expected: dHash({ width: c.width, height: c.height, data: new Uint8Array(pixels(c.width, c.height, c.kind)) }) }));

  // --- geo
  const place = { id: "g", name: "G", lat: 40.7128, lon: -74.006, radiusM: 50 };
  const geo = {
    distances: [
      { a: { lat: 40.6413, lon: -73.7781 }, b: { lat: 33.9416, lon: -118.4085 } },
      { a: { lat: 0, lon: 0 }, b: { lat: 0, lon: 1 } },
      { a: { lat: 51.5, lon: -0.12 }, b: { lat: 51.5001, lon: -0.1201 } },
    ].map((c) => ({ ...c, meters: distanceM(c.a, c.b) })),
    containment: [
      { lat: 40.7128, lon: -74.006, accuracyM: 5 },
      { lat: 40.7133, lon: -74.006, accuracyM: 10 },
      { lat: 40.714, lon: -74.006, accuracyM: 20 },
      { lat: 40.7128, lon: -74.006, accuracyM: 500 },
    ].map((f) => ({ place, fix: f, expected: containment(place, f) })),
    away: (() => {
      const region = { id: "c", name: "City", lat: 0, lon: 0, radiusM: 30000 };
      const H = 3600_000;
      const inside = { lat: 0, lon: 0 };
      const outside = { lat: 1, lon: 0 };
      const cases = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8].map((h) => ({ t: h * H, ...(h === 4 ? outside : inside) })),
        [0, 1, 2, 3, 4, 5, 6, 7, 8].map((h) => ({ t: h * H, ...(h === 0 ? inside : outside) })),
        [0, 1].map((h) => ({ t: h * H, ...outside })),
        [0, 3, 9].map((h) => ({ t: h * H, ...outside })),
      ];
      return cases.map((samples) => ({ region, samples, from: 0, to: 9 * H, outsideFraction: 0.75, minHours: 4, expected: assessAway(samples, region, { from: 0, to: 9 * H, outsideFraction: 0.75, minHours: 4 }) }));
    })(),
    floors: (() => {
      const trace = (d: number[], step = 1000) => d.map((v, i) => ({ t: i * step, relM: v }));
      const cases = [
        { samples: trace([0, 0.2, 15, -0.1, 0, -2, -4, -6, -8, -8.9, -9.1, -9.0, -8.8, -9.2, -9.0]), req: { direction: "down" as const, floors: 3 } },
        { samples: trace([0, 0.2, 15, -0.1, 0, -2, -4, -6, -8, -8.9, -9.1, -9.0, -8.8, -9.2, -9.0]), req: { direction: "up" as const, floors: 1 } },
        { samples: trace([0, 0.3, -0.2, 0.1, 0, -0.4, 0.2, 0.1, 0, 0.2]), req: { direction: "down" as const, floors: 1 } },
        { samples: trace([0, 1, 2, 3, 4, 5, 6, 6.5, 6.6, 6.4]), req: { direction: "up" as const, floors: 2, metersPerFloor: 3.2, toleranceM: 0.5 } },
        { samples: trace([0, -9]), req: { direction: "down" as const, floors: 3 } },
      ];
      return cases.map((c) => ({ ...c, expected: evaluateFloorChange(c.samples, c.req) }));
    })(),
  };

  // --- time
  const time = {
    tz: TZ,
    dayKeys: [Date.parse("2026-10-11T03:59:00Z"), Date.parse("2026-10-11T04:00:00Z"), Date.parse("2026-03-08T07:30:00Z")].map((ms) => ({ ms, expected: dayKey(ms, TZ) })),
    windows: [
      { day: "2026-03-08", start: "05:00", end: "24:00" },
      { day: "2026-11-01", start: "00:00", end: "12:30" },
      { day: "2026-10-12", start: "06:00", end: "23:00" },
    ].map((w) => ({ ...w, expected: windowBounds(w.day, w, TZ) })),
  };

  // --- study queue
  const deck: Deck = {
    id: "d",
    name: "D",
    importedAt: 0,
    source: "",
    styles: {},
    media: {},
    cards: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, noteId: `n${i}`, ord: 0, front: `F${i}`, back: `B${i}`, styleId: "s", tags: [], position: i })),
  };
  const ev = (cardId: string, at: number, rating: 1 | 2 | 3 | 4): ReviewEvent => ({ id: `${cardId}-${at}`, cardId, deckId: "d", rating, at, answerShownAt: at - 3000, deviceId: "me" });
  const events = [ev("c0", t(9), 1), ev("c1", t(9, 1), 3), ev("c2", t(9, 2), 4), ev("c0", t(9, 3), 3), ev("c3", t(9, 4), 2)];
  const queues = [t(9, 5), t(9, 30), t(12, 0, "2026-10-20")].map((at) => {
    const q = buildQueue([deck], events, at, { newPerDay: 6, tz: TZ });
    return { now: at, expected: { counts: q.counts, first: q.items.slice(0, 5).map((i) => i.card.id), cleared: q.cleared, nextDueAt: q.nextDueAt ?? null } };
  });

  const out = {
    about: "Generated by scripts/gen-vectors.ts from the TypeScript core. Do not edit by hand.",
    identity: { publicKey: stored.publicKey, privateD: stored.privateJwk.d, deviceId: id.deviceId, fingerprint: await fingerprint(id.publicKey) },
    records: records.map((r) => ({ raw: r.raw, typ: r.payload.typ, id: r.payload.id, iat: r.payload.iat })),
    tampered,
    auth,
    qr: encodePairingQr({ hosts: ["192.168.1.20", "10.0.0.7"], port: 47123, deviceId: id.deviceId, fingerprint: "AAAA-BBBB-CCCC-DDDD", code: "042137", name: "Brandon's Mac" }),
    config,
    scenarios,
    dhash,
    geo,
    time,
    study: { deck, events, newPerDay: 6, queues },
  };
  writeFileSync(path.join(here, "..", "spec", "vectors", "core.json"), JSON.stringify(out, null, 1));
  console.log(`wrote spec/vectors/core.json (${scenarios.length} engine scenarios)`);
}

void main();
