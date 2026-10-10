import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deck, type ReviewEvent, buildQueue, honestReviewsToday, importApkg, renderCard } from "../src/index.js";

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function checkDecks(decks: Deck[]) {
  const byName = Object.fromEntries(decks.map((d) => [d.name, d]));
  expect(Object.keys(byName).sort()).toEqual(["Geography", "Spanish::Verbs"]);

  const spanish = byName["Spanish::Verbs"]!;
  expect(spanish.cards).toHaveLength(3);
  expect(spanish.cards.map((c) => c.front)).toEqual(["comer", "beber", "vivir"]);
  expect(spanish.cards[0]!.back).toContain("to eat");
  expect(spanish.cards[0]!.back).toContain("comer"); // {{FrontSide}}
  expect(spanish.cards[0]!.tags).toEqual(["spanish", "verbs"]);

  const geo = byName["Geography"]!;
  // Basic+reversed = 2 cards, cloze with c1 and c2 = 2 cards.
  expect(geo.cards).toHaveLength(4);
  const fronts = geo.cards.map((c) => c.front);
  expect(fronts.some((f) => f.includes("Capital of France"))).toBe(true);
  expect(fronts.some((f) => f.includes("Paris"))).toBe(true); // reversed card
  const c1 = geo.cards.find((c) => c.front.includes("[...]") && c.front.includes("Australia"))!;
  expect(c1.front).not.toContain("Canberra");
  expect(c1.back).toContain('<span class="cloze">Canberra</span>');
  const c2 = geo.cards.find((c) => c.front.includes("[country]"))!;
  expect(c2.front).toContain("Canberra");
  expect(c2.back).toContain("Not Sydney!");

  // Media referenced by the card is bundled.
  expect(Object.keys(geo.media)).toEqual(["flag-red.png"]);
  expect(geo.media["flag-red.png"]!.mime).toBe("image/png");
  expect(atob(geo.media["flag-red.png"]!.data).slice(1, 4)).toBe("PNG");
  expect(Object.keys(spanish.media)).toEqual([]);
  expect(Object.values(geo.styles)[0]).toContain(".card");
}

describe("apkg import", () => {
  it("imports a modern Anki 2.1.50+ package (anki21b, zstd, protobuf)", () => {
    const r = importApkg(fixture("modern.apkg"), { sql: SQL, now: 1 });
    checkDecks(r.decks);
    expect(r.warnings).toEqual([]);
  });

  it("imports a legacy package (anki21, JSON models)", () => {
    const r = importApkg(fixture("legacy.apkg"), { sql: SQL, now: 1 });
    checkDecks(r.decks);
  });

  it("imports an Anki 2.0-style package that only has collection.anki2", () => {
    const files = unzipSync(fixture("legacy.apkg"));
    const old = zipSync({ "collection.anki2": files["collection.anki21"]!, media: files["media"]!, "0": files["0"]! });
    checkDecks(importApkg(old, { sql: SQL }).decks);
  });

  it("card ids are stable across re-imports (review history survives)", () => {
    const a = importApkg(fixture("modern.apkg"), { sql: SQL }).decks;
    const b = importApkg(fixture("legacy.apkg"), { sql: SQL }).decks;
    const ids = (d: Deck[]) => d.flatMap((x) => x.cards.map((c) => c.id)).sort();
    expect(ids(a)).toEqual(ids(b));
  });

  it("rejects non-Anki files and zip bombs", () => {
    expect(() => importApkg(new Uint8Array([1, 2, 3]), { sql: SQL })).toThrow(/not a valid Anki package/);
    expect(() => importApkg(zipSync({ "readme.txt": new Uint8Array(10) }), { sql: SQL })).toThrow(/no collection/);
    expect(() => importApkg(fixture("modern.apkg"), { sql: SQL, maxUncompressedBytes: 1000 })).toThrow(/too large/);
  });
});

describe("template rendering", () => {
  const ctx = { fields: { Front: "Hi", Back: "", Extra: "<b>x</b>" }, tags: ["t1"], deck: "A::B", notetype: "Basic", cardName: "Card 1" };
  it("handles sections, inverted sections, filters and specials", () => {
    const { front, back } = renderCard(
      "{{Front}}{{#Back}}HAS BACK{{/Back}}{{^Back}}NO BACK{{/Back}} {{text:Extra}} {{Subdeck}} {{Tags}} {{type:Front}}",
      "{{FrontSide}}<hr id=answer>{{hint:Extra}}",
      ctx,
    );
    expect(front).toBe("HiNO BACK x B t1 ");
    expect(back).toContain("HiNO BACK");
    expect(back).toContain("<details");
  });
  it("renders sounds and furigana", () => {
    const { front } = renderCard("[sound:a.mp3] {{furigana:F}}", "", { ...ctx, fields: { F: "漢字[かんじ]" } });
    expect(front).toContain('<audio controls preload="none" src="a.mp3">');
    expect(front).toContain("<ruby><rb>漢字</rb><rt>かんじ</rt></ruby>");
  });
});

describe("study queue", () => {
  const MIN = 60_000;
  const deck: Deck = {
    id: "d",
    name: "D",
    importedAt: 0,
    source: "",
    styles: {},
    media: {},
    cards: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, noteId: `n${i}`, ord: 0, front: `F${i}`, back: `B${i}`, styleId: "s", tags: [], position: i })),
  };
  const t0 = Date.UTC(2026, 9, 12, 14); // 10:00 New York
  const opts = { newPerDay: 10, tz: "America/New_York" };
  const ev = (cardId: string, at: number, rating: 1 | 2 | 3 | 4, think = 3000): ReviewEvent => ({ id: `${cardId}-${at}`, cardId, deckId: "d", rating, at, answerShownAt: at - think, deviceId: "me" });

  it("limits new cards per day and orders learning first", () => {
    let q = buildQueue([deck], [], t0, opts);
    expect(q.counts).toEqual({ new: 10, learning: 0, review: 0 });
    const events = [ev("c0", t0, 1), ev("c1", t0 + 1000, 4)];
    q = buildQueue([deck], events, t0 + 2 * MIN, opts);
    expect(q.items[0]!.card.id).toBe("c0"); // learning card due after 1 min
    expect(q.counts.new).toBe(8);
  });

  it("is cleared when everything due is done; learning cards wait on their timer", () => {
    const events: ReviewEvent[] = [];
    let now = t0;
    for (let i = 0; i < 10; i++) events.push(ev(`c${i}`, (now += 1000), 4));
    const q = buildQueue([deck], events, now + 1000, opts);
    expect(q.cleared).toBe(true);
    // Tomorrow they're due again only after their interval.
    const later = buildQueue([deck], events, now + 40 * 86_400_000, opts);
    expect(later.counts.review).toBe(10);
  });

  it("honest review counting ignores button-mashing and other devices", () => {
    const events = [ev("c0", t0, 3, 3000), ev("c1", t0 + 1, 3, 200), { ...ev("c2", t0 + 2, 3), deviceId: "other" }];
    expect(honestReviewsToday(events, t0 + 10, { minAnswerMs: 1200, deviceId: "me", tz: "America/New_York" })).toBe(1);
  });
});
