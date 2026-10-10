import { describe, expect, it } from "vitest";
import { type Deck, Ledger, type ReviewEvent, dayKey, evaluate } from "@ptu/core";
import { isEssential, parseLsappinfoFront, parseLsappinfoInfo, parseWindowsLine } from "../src/main/foreground.js";
import { issueAnkiProofs, issuePhotoProof } from "../src/main/proofs.js";
import { validateConfig } from "../src/main/validate.js";

describe("foreground app parsing", () => {
  it("parses lsappinfo output", () => {
    expect(parseLsappinfoFront('ASN:0x0-0x1a01a:\n')).toBe("ASN:0x0-0x1a01a:");
    const info = ` 23) "Safari" ASN:0x0-0x1a01a:
    bundleID="com.apple.Safari"
    bundle path="/Applications/Safari.app"
    executable path="/Applications/Safari.app/Contents/MacOS/Safari"
    pid = 4321 type="Foreground" flavor=3 Version="17.0" fileType="APPL" creator="sfri" Arch=ARM64
`;
    expect(parseLsappinfoInfo(info)).toEqual({ pid: 4321, name: "Safari", id: "com.apple.Safari" });
    expect(parseLsappinfoInfo("garbage")).toBeNull();
  });

  it("parses the Windows watcher lines", () => {
    expect(parseWindowsLine('{"pid":1234,"name":"chrome","path":"C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe"}')).toEqual({
      pid: 1234,
      name: "chrome",
      id: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    });
    expect(parseWindowsLine('{"pid":0}')).toBeNull();
    expect(parseWindowsLine("not json")).toBeNull();
  });

  it("decides what's essential", () => {
    const opts = { userApps: ["Obsidian", "code.exe"], browsersEssential: true, selfPid: 1, selfNames: ["Prove to Unlock"] };
    expect(isEssential({ pid: 1, name: "x", id: "" }, opts)).toBe(true); // ourselves
    expect(isEssential({ pid: 9, name: "Finder", id: "com.apple.finder" }, { ...opts, platform: "darwin" })).toBe(true);
    expect(isEssential({ pid: 9, name: "Steam", id: "com.valvesoftware.steam" }, { ...opts, platform: "darwin" })).toBe(false);
    expect(isEssential({ pid: 9, name: "Google Chrome", id: "com.google.Chrome" }, { ...opts, platform: "darwin" })).toBe(true);
    expect(isEssential({ pid: 9, name: "Google Chrome", id: "com.google.Chrome" }, { ...opts, browsersEssential: false, platform: "darwin" })).toBe(false);
    expect(isEssential({ pid: 9, name: "Code", id: "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" }, { ...opts, platform: "win32" })).toBe(true);
    expect(isEssential({ pid: 9, name: "obsidian", id: "/Applications/Obsidian.app" }, { ...opts, platform: "darwin" })).toBe(true);
    expect(isEssential({ pid: 9, name: "explorer", id: "C:\\Windows\\explorer.exe" }, { ...opts, platform: "win32" })).toBe(true);
    expect(isEssential({ pid: 9, name: "Discord", id: "C:\\Users\\me\\AppData\\Local\\Discord\\Discord.exe" }, { ...opts, platform: "win32" })).toBe(false);
  });
});

const deck: Deck = {
  id: "d",
  name: "D",
  importedAt: 0,
  source: "",
  styles: {},
  media: {},
  cards: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, noteId: `n${i}`, ord: 0, front: `F${i}`, back: `B${i}`, styleId: "s", tags: [], position: i })),
};

async function setup(requirements: object[]) {
  const ledger = await Ledger.create("Mac", "mac");
  await ledger.updateConfig((c) => {
    c.commitments = [{ id: "k", title: "Cards", enabled: true, days: [0, 1, 2, 3, 4, 5, 6], window: { start: "00:00", end: "24:00" }, requirements: requirements as never, require: "all", createdAt: 0 }];
  });
  return ledger;
}

const review = (ledger: Ledger, cardId: string, at: number, thinkMs = 3000): ReviewEvent => ({ id: `${cardId}-${at}`, cardId, deckId: "d", rating: 4, at, answerShownAt: at - thinkMs, deviceId: ledger.deviceId });

describe("anki proofs", () => {
  it("count mode: proofs never double count and only honest reviews count", async () => {
    const ledger = await setup([{ kind: "anki", mode: "count", count: 3 }]);
    const t = new Date().setHours(12, 0, 0, 0);
    ledger.addReviews([review(ledger, "c0", t), review(ledger, "c1", t + 5000, 100)]); // 2nd is too fast
    expect(await issueAnkiProofs({ ledger, decks: [deck], now: t + 6000, newCardsPerDay: 20 })).toBe(0);
    ledger.addReviews([review(ledger, "c2", t + 10000), review(ledger, "c3", t + 15000)]);
    expect(await issueAnkiProofs({ ledger, decks: [deck], now: t + 16000, newCardsPerDay: 20 })).toBe(1);
    expect(await issueAnkiProofs({ ledger, decks: [deck], now: t + 17000, newCardsPerDay: 20 })).toBe(0); // nothing new to claim
    expect(evaluate({ config: ledger.config(), records: ledger.records(), now: t + 17000 }).locked).toBe(false);
  });

  it("due mode: needs real decks, then clears when the queue is empty", async () => {
    const ledger = await setup([{ kind: "anki", mode: "due" }]);
    const t = new Date().setHours(12, 0, 0, 0);
    expect(await issueAnkiProofs({ ledger, decks: [], now: t, newCardsPerDay: 5 })).toBe(0);
    ledger.addReviews(deck.cards.map((c, i) => review(ledger, c.id, t + i * 2000)));
    expect(await issueAnkiProofs({ ledger, decks: [deck], now: t + 20000, newCardsPerDay: 5 })).toBe(1);
    const proof = ledger.records().find((r) => r.payload.typ === "proof")!;
    expect((proof.payload.body as { day: string }).day).toBe(dayKey(t + 20000));
  });
});

describe("photo proofs on the computer", () => {
  it("rejects stale photos and repeats, accepts fresh ones", async () => {
    const ledger = await setup([{ kind: "photo", repeatMaxHamming: 4 }]);
    const now = Date.now();
    const base = { commitmentId: "k", requirementIndex: 0, labels: [{ label: "dumbbell", confidence: 0.8 }], embedding: [1, 0, 0] };
    expect((await issuePhotoProof(ledger, { ...base, dhash: "0123456789abcdef", capturedAt: now - 10 * 60_000 }, undefined, now)).ok).toBe(false);
    expect((await issuePhotoProof(ledger, { ...base, dhash: "0123456789abcdef", capturedAt: now - 1000 }, undefined, now)).ok).toBe(true);
    const again = await issuePhotoProof(ledger, { ...base, dhash: "0123456789abcdee", capturedAt: now }, undefined, now + 1000);
    expect(again.ok).toBe(false);
    expect(again.failures.join()).toMatch(/repeat/);
  });

  it("place-bound photos must come from the phone", async () => {
    const ledger = await Ledger.create("Mac", "mac");
    await ledger.updateConfig((c) => {
      c.places = [{ id: "gym", name: "Gym", lat: 1, lon: 1, radiusM: 50 }];
      c.commitments = [{ id: "k", title: "Gym", enabled: true, days: [0, 1, 2, 3, 4, 5, 6], window: { start: "00:00", end: "24:00" }, requirements: [{ kind: "photo", placeId: "gym" }], require: "all", createdAt: 0 }];
    });
    const r = await issuePhotoProof(ledger, { commitmentId: "k", requirementIndex: 0, dhash: "0123456789abcdef", labels: [], embedding: [], capturedAt: Date.now() }, undefined, Date.now());
    expect(r.failures.join()).toMatch(/not taken at Gym/);
  });
});

describe("config validation", () => {
  it("rejects broken configs", async () => {
    const ledger = await Ledger.create("Mac", "mac");
    const c = ledger.config();
    const k = { id: "a", title: "A", enabled: true, days: [1], window: { start: "09:00", end: "08:00" }, requirements: [], require: "all" as const, createdAt: 0 };
    expect(() => validateConfig({ ...c, commitments: [k] })).toThrow(/end after/);
    expect(() => validateConfig({ ...c, commitments: [{ ...k, window: { start: "08:00", end: "09:00" } }, { ...k, window: { start: "08:00", end: "09:00" } }] })).toThrow(/unique/);
    expect(() => validateConfig({ ...c, commitments: [{ ...k, window: { start: "08:00", end: "09:00" }, requirements: [{ kind: "presence", placeId: "nope", minutes: 5 }] }] })).toThrow(/place/);
    expect(() => validateConfig({ ...c, commitments: [{ ...k, window: { start: "08:00", end: "24:00" } }] })).not.toThrow();
  });
});
