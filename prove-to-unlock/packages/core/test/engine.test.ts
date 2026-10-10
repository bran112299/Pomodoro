import { describe, expect, it } from "vitest";
import { type Commitment, type Config, Ledger, defaultConfig, evaluate, localTimeToEpoch, streak } from "../src/index.js";

const TZ = "America/New_York";
const DAY = "2026-10-12"; // a Monday
const at = (hhmm: string, day = DAY) => {
  const [h, m] = hhmm.split(":").map(Number);
  return localTimeToEpoch(day, h! * 60 + m!, TZ);
};

const gym: Commitment = {
  id: "gym",
  title: "Go to the gym",
  enabled: true,
  days: [0, 1, 2, 3, 4, 5, 6],
  window: { start: "05:00", end: "24:00" },
  requirements: [
    { kind: "photo", placeId: "gym", repeatMaxHamming: 8 },
    { kind: "altitude", direction: "down", floors: 3 },
  ],
  require: "all",
  away: { regionPlaceId: "city", requirements: [{ kind: "focus", sessions: 1 }], require: "all" },
  createdAt: 0,
};

function config(extra: Partial<Config> = {}): Config {
  return {
    ...defaultConfig(),
    commitments: [gym],
    places: [
      { id: "gym", name: "Gym", lat: 40.0, lon: -74.0, radiusM: 40 },
      { id: "city", name: "City", lat: 40.0, lon: -74.0, radiusM: 30000 },
    ],
    ...extra,
  };
}

async function device() {
  return Ledger.create("Phone", "ios");
}

const photo = (dhash: string, capturedAt: number, over: Record<string, unknown> = {}) => ({
  cid: "gym",
  day: DAY,
  kind: "photo" as const,
  at: capturedAt,
  detail: { dhash, labels: [], live: true, capturedAt, placeId: "gym", insidePlace: true, ...over },
});

describe("engine", () => {
  it("is unlocked outside the window and locked inside it until proven", async () => {
    const d = await device();
    expect(evaluate({ config: config(), records: d.records(), now: at("04:59"), tz: TZ }).locked).toBe(false);
    const s = evaluate({ config: config(), records: d.records(), now: at("08:00"), tz: TZ });
    expect(s.locked).toBe(true);
    expect(s.nextChangeAt).toBe(at("00:00", "2026-10-13"));
    expect(s.commitments[0]!.requirements.map((r) => r.ok)).toEqual([false, false]);
  });

  it("unlocks when every requirement is proven, on any paired device", async () => {
    const d = await device();
    await d.issue("proof", photo("0f0f0f0f0f0f0f0f", at("07:00")), at("07:00"));
    let s = evaluate({ config: config(), records: d.records(), now: at("07:01"), tz: TZ });
    expect(s.locked).toBe(true);
    await d.issue("proof", { cid: "gym", day: DAY, kind: "altitude", at: at("07:00"), detail: { deltaM: -8.6, samples: 40, startedAt: at("06:58"), endedAt: at("07:00") } }, at("07:00"));
    s = evaluate({ config: config(), records: d.records(), now: at("07:01"), tz: TZ });
    expect(s.locked).toBe(false);
    expect(s.commitments[0]!.unlockedBy).toBe("proven");
  });

  it("rejects a repeated photo (same dHash as an earlier day)", async () => {
    const d = await device();
    await d.issue("proof", { ...photo("aaaaaaaaaaaaaaaa", at("07:00", "2026-10-11")), day: "2026-10-11" }, at("07:00", "2026-10-11"));
    await d.issue("proof", photo("aaaaaaaaaaaaaaab", at("07:00")), at("07:00")); // 1 bit different
    const s = evaluate({ config: config(), records: d.records(), now: at("07:05"), tz: TZ });
    const r = s.commitments[0]!.requirements[0]!;
    expect(r.ok).toBe(false);
    expect(r.failures.join()).toMatch(/repeat/);
  });

  it("rejects a photo taken outside the place", async () => {
    const d = await device();
    await d.issue("proof", photo("0123456789abcdef", at("07:00"), { insidePlace: false }), at("07:00"));
    const r = evaluate({ config: config(), records: d.records(), now: at("07:05"), tz: TZ }).commitments[0]!.requirements[0]!;
    expect(r.ok).toBe(false);
    expect(r.failures.join()).toMatch(/not taken at Gym/);
  });

  it("emergency unlock is temporary", async () => {
    const d = await device();
    await d.issue("emergency", { day: DAY, until: at("09:15") }, at("09:00"));
    expect(evaluate({ config: config(), records: d.records(), now: at("09:10"), tz: TZ }).locked).toBe(false);
    expect(evaluate({ config: config(), records: d.records(), now: at("09:16"), tz: TZ }).locked).toBe(true);
  });

  it("away status swaps in the substitute requirements (capped per month)", async () => {
    const d = await device();
    await d.issue("status", { cid: "gym", day: DAY, region: "away", outsideFraction: 0.95, spanHours: 10 }, at("12:00"));
    let s = evaluate({ config: config(), records: d.records(), now: at("13:00"), tz: TZ });
    expect(s.commitments[0]!.mode).toBe("away");
    expect(s.locked).toBe(true);
    await d.issue("proof", { cid: "gym", day: DAY, kind: "focus", at: at("13:30"), detail: { sessions: 1, minutes: 25 } }, at("13:30"));
    s = evaluate({ config: config(), records: d.records(), now: at("13:31"), tz: TZ });
    expect(s.locked).toBe(false);

    const capped = config({ policy: { ...defaultConfig().policy, maxAwayDaysPerMonth: 0 } });
    expect(evaluate({ config: capped, records: d.records(), now: at("13:31"), tz: TZ }).commitments[0]!.mode).toBe("normal");
  });

  it("excused days count only if declared before the window starts", async () => {
    const d = await device();
    const late = config({ excused: [{ day: DAY, createdAt: at("06:00") }] });
    expect(evaluate({ config: late, records: d.records(), now: at("08:00"), tz: TZ }).locked).toBe(true);
    const early = config({ excused: [{ day: DAY, createdAt: at("20:00", "2026-10-11") }] });
    expect(evaluate({ config: early, records: d.records(), now: at("08:00"), tz: TZ }).locked).toBe(false);
  });

  it("'any N' and counted requirements", async () => {
    const d = await device();
    const c: Commitment = {
      ...gym,
      away: undefined,
      requirements: [
        { kind: "anki", mode: "count", count: 30 },
        { kind: "focus", sessions: 2, minutesPerSession: 25 },
        { kind: "presence", placeId: "gym", minutes: 45 },
      ],
      require: { any: 2 },
    };
    const cfg = config({ commitments: [c] });
    const proof = (kind: string, detail: object, t: string) => d.issue("proof", { cid: "gym", day: DAY, kind, at: at(t), detail } as never, at(t));
    await proof("anki", { reviews: 20, cleared: false, deckIds: [] }, "08:00");
    await proof("anki", { reviews: 15, cleared: false, deckIds: [] }, "09:00");
    // Overlapping presence intervals must not double count: 07:00-07:30 and 07:15-07:40 = 40 min.
    await proof("presence", { placeId: "gym", from: at("07:00"), to: at("07:30") }, "07:30");
    await proof("presence", { placeId: "gym", from: at("07:15"), to: at("07:40") }, "07:40");
    let s = evaluate({ config: cfg, records: d.records(), now: at("10:00"), tz: TZ });
    expect(s.commitments[0]!.requirements.map((r) => r.ok)).toEqual([true, false, false]);
    expect(s.commitments[0]!.requirements[2]!.progress).toBe("40 / 45 min");
    expect(s.locked).toBe(true);
    await proof("focus", { sessions: 2, minutes: 50 }, "11:00");
    s = evaluate({ config: cfg, records: d.records(), now: at("11:01"), tz: TZ });
    expect(s.locked).toBe(false);
  });

  it("only applies on selected weekdays and never locks on a broken window", async () => {
    const d = await device();
    const weekendOnly = config({ commitments: [{ ...gym, days: [0, 6] }] });
    expect(evaluate({ config: weekendOnly, records: d.records(), now: at("08:00"), tz: TZ }).locked).toBe(false);
    const broken = config({ commitments: [{ ...gym, window: { start: "10:00", end: "09:00" } }] });
    expect(evaluate({ config: broken, records: d.records(), now: at("09:30"), tz: TZ }).locked).toBe(false);
  });

  it("counts a streak of proven days", async () => {
    const d = await device();
    const simple: Commitment = { ...gym, away: undefined, requirements: [{ kind: "focus", sessions: 1 }] };
    const cfg = config({ commitments: [simple] });
    for (const day of ["2026-10-09", "2026-10-10", "2026-10-11"]) {
      await d.issue("proof", { cid: "gym", day, kind: "focus", at: at("09:00", day), detail: { sessions: 1, minutes: 25 } }, at("09:00", day));
    }
    // Today not done yet -> streak still counts the previous 3 days.
    expect(streak({ config: cfg, records: d.records(), now: at("08:00"), tz: TZ }, "gym")).toBe(3);
  });
});
