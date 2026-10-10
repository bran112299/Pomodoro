import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FSRS_PARAMS,
  type Rating,
  type ReviewEvent,
  newCard,
  preview,
  replay,
  retrievability,
  review,
  intervalDays,
} from "../src/index.js";

interface Step {
  at: number;
  rating: Rating;
  state: string;
  step: number;
  due: number;
  stability: number;
  difficulty: number;
}

const vectors = JSON.parse(readFileSync(new URL("../../../spec/vectors/fsrs.json", import.meta.url), "utf8")) as {
  sequences: Step[][];
};

const REFERENCE = { ...DEFAULT_FSRS_PARAMS, enforceOrdering: false };

describe("FSRS-5 matches the reference implementation (py-fsrs)", () => {
  it("has vectors", () => expect(vectors.sequences.length).toBeGreaterThan(10));

  vectors.sequences.forEach((seq, i) => {
    it(`sequence ${i}`, () => {
      let card = newCard(seq[0]!.at);
      for (const s of seq) {
        card = review(card, s.rating, s.at, REFERENCE);
        expect(card.state).toBe(s.state);
        if (s.state !== "review") expect(card.step).toBe(s.step);
        expect(card.stability).toBeCloseTo(s.stability, 6);
        expect(card.difficulty).toBeCloseTo(s.difficulty, 6);
        expect(card.due).toBe(s.due);
      }
    });
  });
});

describe("FSRS behaviour", () => {
  const t0 = Date.UTC(2026, 0, 1, 12);
  const DAY = 86_400_000;

  it("R(S, S) = 0.9 and I(S) = S at 90% retention", () => {
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 10);
    expect(intervalDays(10)).toBe(10);
  });

  it("new card: Again/Hard stay in learning, Good steps, Easy graduates", () => {
    const p = preview(newCard(t0), t0);
    expect(p[1].state).toBe("learning");
    expect(p[1].due - t0).toBe(60_000);
    expect(p[2].due - t0).toBe(5.5 * 60_000);
    expect(p[3].step).toBe(1);
    expect(p[3].due - t0).toBe(10 * 60_000);
    expect(p[4].state).toBe("review");
    expect(p[4].due - t0).toBe(intervalDays(p[4].stability) * DAY);
  });

  it("enforces Hard <= Good < Easy for review cards", () => {
    let c = review(newCard(t0), 4, t0);
    const t1 = c.due;
    const p = preview(c, t1);
    const ivl = (x: { due: number }) => Math.round((x.due - t1) / DAY);
    expect(ivl(p[2])).toBeLessThanOrEqual(ivl(p[3]));
    expect(ivl(p[3])).toBeLessThan(ivl(p[4]));
    expect(p[1].state).toBe("relearning");
    expect(p[1].lapses).toBe(1);
  });

  it("forgetting never increases stability", () => {
    let c = review(newCard(t0), 4, t0);
    for (let i = 0; i < 5; i++) c = review(c, 3, c.due);
    const before = c.stability;
    const lapsed = review(c, 1, c.due + 30 * DAY);
    expect(lapsed.stability).toBeLessThan(before);
  });

  it("replay is order-independent of input and deterministic", () => {
    const ev = (id: string, at: number, rating: Rating): ReviewEvent => ({ id, cardId: "c1", deckId: "d", rating, at, answerShownAt: at - 3000, deviceId: "x" });
    const events = [ev("a", t0, 3), ev("b", t0 + 10 * 60_000, 3), ev("c", t0 + 3 * DAY, 3), ev("d", t0 + 9 * DAY, 2)];
    const s1 = replay(events).get("c1");
    const s2 = replay([...events].reverse()).get("c1");
    expect(s1).toEqual(s2);
    expect(s1!.reps).toBe(4);
  });

  it("rejects invalid ratings", () => {
    expect(() => review(newCard(t0), 5 as Rating, t0)).toThrow();
  });
});
