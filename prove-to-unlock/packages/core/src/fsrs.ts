// FSRS-5 spaced-repetition scheduler (the algorithm Anki uses by default since 23.10), with
// Anki-style learning / relearning steps for same-day repetitions.
//
// Formulas follow the published FSRS-5 model (open-spaced-repetition/py-fsrs):
//   R(t, S)      = (1 + FACTOR * t / S) ^ DECAY                    DECAY = -0.5, FACTOR = 19/81
//   I(S)         = S / FACTOR * (r^(1/DECAY) - 1)                  (= S when r = 0.9)
//   S0(G)        = w[G-1]
//   D0(G)        = w4 - e^(w5 (G-1)) + 1
//   D'(D, G)     = w7 D0(4) + (1-w7) (D + ΔD (10-D)/9),  ΔD = -w6 (G-3)
//   S'r(D,S,R,G) = S (1 + e^w8 (11-D) S^-w9 (e^(w10 (1-R)) - 1) * hard(w15) * easy(w16))
//   S'f(D,S,R)   = min(w11 D^-w12 ((S+1)^w13 - 1) e^(w14 (1-R)),  S / e^(w17 w18))
//   S's(S,G)     = S e^(w17 (G - 3 + w18))                           (same-day reviews)
//
// The scheduler is a pure function of (card, rating, time), so replaying the same review log on
// any device yields the same state; that is how review progress syncs between devices.

export type Rating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy
export type CardState = "new" | "learning" | "review" | "relearning";

export interface SrsCard {
  state: CardState;
  /** Index into the (re)learning steps while in learning/relearning. */
  step: number;
  due: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReview: number | null;
}

export interface FsrsParams {
  w: readonly number[];
  requestRetention: number;
  maximumIntervalDays: number;
  learningStepsMin: readonly number[];
  relearningStepsMin: readonly number[];
  /** Keep Hard <= Good < Easy intervals for review cards (Anki behaviour). */
  enforceOrdering: boolean;
}

export const FSRS5_DEFAULT_W: readonly number[] = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
  1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];

export const DEFAULT_FSRS_PARAMS: FsrsParams = {
  w: FSRS5_DEFAULT_W,
  requestRetention: 0.9,
  maximumIntervalDays: 36500,
  learningStepsMin: [1, 10],
  relearningStepsMin: [10],
  enforceOrdering: true,
};

export const DECAY = -0.5;
export const FACTOR = 19 / 81;
const MINUTE = 60_000;
const DAY = 86_400_000;
const S_MIN = 0.01;

export function newCard(now: number): SrsCard {
  return { state: "new", step: 0, due: now, stability: 0, difficulty: 0, reps: 0, lapses: 0, lastReview: null };
}

const clampD = (d: number) => Math.min(10, Math.max(1, d));
const clampS = (s: number) => Math.max(S_MIN, s);

export function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY);
}

export function intervalDays(stability: number, p: FsrsParams = DEFAULT_FSRS_PARAMS): number {
  const raw = (stability / FACTOR) * (Math.pow(p.requestRetention, 1 / DECAY) - 1);
  return Math.min(p.maximumIntervalDays, Math.max(1, Math.round(raw)));
}

function w(p: FsrsParams, i: number): number {
  const v = p.w[i];
  if (v === undefined) throw new Error(`FSRS weight w[${i}] missing (need 19 weights)`);
  return v;
}

export function initStability(g: Rating, p: FsrsParams = DEFAULT_FSRS_PARAMS): number {
  return Math.max(0.1, w(p, g - 1));
}

export function initDifficulty(g: Rating, p: FsrsParams = DEFAULT_FSRS_PARAMS): number {
  return clampD(w(p, 4) - Math.exp(w(p, 5) * (g - 1)) + 1);
}

export function nextDifficulty(d: number, g: Rating, p: FsrsParams = DEFAULT_FSRS_PARAMS): number {
  const delta = -w(p, 6) * (g - 3);
  const damped = d + (delta * (10 - d)) / 9;
  return clampD(w(p, 7) * initDifficulty(4, p) + (1 - w(p, 7)) * damped);
}

export function recallStability(d: number, s: number, r: number, g: Rating, p: FsrsParams = DEFAULT_FSRS_PARAMS): number {
  const hard = g === 2 ? w(p, 15) : 1;
  const easy = g === 4 ? w(p, 16) : 1;
  return clampS(
    s * (1 + Math.exp(w(p, 8)) * (11 - d) * Math.pow(s, -w(p, 9)) * (Math.exp((1 - r) * w(p, 10)) - 1) * hard * easy),
  );
}

export function forgetStability(d: number, s: number, r: number, p: FsrsParams = DEFAULT_FSRS_PARAMS): number {
  const longTerm = w(p, 11) * Math.pow(d, -w(p, 12)) * (Math.pow(s + 1, w(p, 13)) - 1) * Math.exp((1 - r) * w(p, 14));
  const shortTermCap = s / Math.exp(w(p, 17) * w(p, 18));
  return clampS(Math.min(longTerm, shortTermCap));
}

export function shortTermStability(s: number, g: Rating, p: FsrsParams = DEFAULT_FSRS_PARAMS): number {
  return clampS(s * Math.exp(w(p, 17) * (g - 3 + w(p, 18))));
}

/** Delay for "Hard" while on step i (Anki semantics). */
function hardDelayMin(steps: readonly number[], i: number): number {
  const s0 = steps[0]!;
  if (steps.length === 1) return Math.min(s0 * 1.5, s0 + 1440);
  if (i === 0) return (s0 + steps[1]!) / 2;
  return steps[Math.min(i, steps.length - 1)]!;
}

function graduate(card: SrsCard, now: number, days: number): SrsCard {
  return { ...card, state: "review", step: 0, due: now + days * DAY };
}

/** Next state for every rating. `review()` applies exactly one of these. */
export function preview(card: SrsCard, now: number, p: FsrsParams = DEFAULT_FSRS_PARAMS): Record<Rating, SrsCard> {
  return {
    1: schedule(card, 1, now, p),
    2: schedule(card, 2, now, p),
    3: schedule(card, 3, now, p),
    4: schedule(card, 4, now, p),
  };
}

export function review(card: SrsCard, g: Rating, now: number, p: FsrsParams = DEFAULT_FSRS_PARAMS): SrsCard {
  return schedule(card, g, now, p);
}

function schedule(card: SrsCard, g: Rating, now: number, p: FsrsParams): SrsCard {
  if (g < 1 || g > 4 || !Number.isInteger(g)) throw new Error(`invalid rating ${g}`);
  const base: SrsCard = { ...card, reps: card.reps + 1, lastReview: now };
  // Whole days, like FSRS/Anki (a review 23 hours later is still "same day" for the model).
  const elapsedDays = card.lastReview === null ? 0 : Math.max(0, Math.floor((now - card.lastReview) / DAY));
  const r = card.lastReview === null ? 0 : retrievability(elapsedDays, card.stability);

  switch (card.state) {
    case "new": {
      const s = initStability(g, p);
      const d = initDifficulty(g, p);
      const c: SrsCard = { ...base, stability: s, difficulty: d };
      const steps = p.learningStepsMin;
      if (g === 4 || steps.length === 0) return graduate(c, now, intervalDays(s, p));
      if (g === 1) return { ...c, state: "learning", step: 0, due: now + steps[0]! * MINUTE };
      if (g === 2) return { ...c, state: "learning", step: 0, due: now + hardDelayMin(steps, 0) * MINUTE };
      // Good
      if (steps.length > 1) return { ...c, state: "learning", step: 1, due: now + steps[1]! * MINUTE };
      return graduate(c, now, intervalDays(s, p));
    }

    case "learning":
    case "relearning": {
      const steps = card.state === "learning" ? p.learningStepsMin : p.relearningStepsMin;
      let s: number;
      if (elapsedDays < 1) s = shortTermStability(card.stability, g, p);
      else if (g === 1) s = forgetStability(card.difficulty, card.stability, r, p);
      else s = recallStability(card.difficulty, card.stability, r, g, p);
      const d = nextDifficulty(card.difficulty, g, p);
      const c: SrsCard = { ...base, stability: s, difficulty: d };
      if (steps.length === 0 || g === 4) return graduate(c, now, intervalDays(s, p));
      if (g === 1) return { ...c, step: 0, due: now + steps[0]! * MINUTE };
      if (g === 2) return { ...c, due: now + hardDelayMin(steps, card.step) * MINUTE };
      const next = card.step + 1;
      if (next < steps.length) return { ...c, step: next, due: now + steps[next]! * MINUTE };
      return graduate(c, now, intervalDays(s, p));
    }

    case "review": {
      const sameDay = elapsedDays < 1;
      const stabilityFor = (rating: Rating) =>
        sameDay
          ? shortTermStability(card.stability, rating, p)
          : rating === 1
            ? forgetStability(card.difficulty, card.stability, r, p)
            : recallStability(card.difficulty, card.stability, r, rating, p);
      const d = nextDifficulty(card.difficulty, g, p);

      if (g === 1) {
        const s = stabilityFor(1);
        const c: SrsCard = { ...base, stability: s, difficulty: d, lapses: card.lapses + 1 };
        if (p.relearningStepsMin.length > 0) {
          return { ...c, state: "relearning", step: 0, due: now + p.relearningStepsMin[0]! * MINUTE };
        }
        return graduate(c, now, intervalDays(s, p));
      }

      // Keep Hard <= Good < Easy, as Anki does.
      const sHard = stabilityFor(2);
      const sGood = stabilityFor(3);
      const sEasy = stabilityFor(4);
      let iHard = intervalDays(sHard, p);
      let iGood = intervalDays(sGood, p);
      let iEasy = intervalDays(sEasy, p);
      if (p.enforceOrdering) {
        iHard = Math.min(iHard, iGood);
        iGood = Math.max(iGood, iHard + 1);
        iEasy = Math.max(iEasy, iGood + 1);
      }
      const chosen = g === 2 ? { s: sHard, i: iHard } : g === 3 ? { s: sGood, i: iGood } : { s: sEasy, i: iEasy };
      const i = Math.min(chosen.i, p.maximumIntervalDays);
      return graduate({ ...base, stability: chosen.s, difficulty: d }, now, i);
    }
  }
}

export interface ReviewEvent {
  /** Unique id (random); used to merge logs from several devices. */
  id: string;
  cardId: string;
  deckId: string;
  rating: Rating;
  /** When the rating button was pressed. */
  at: number;
  /** When the answer side was revealed (for the honesty check). */
  answerShownAt: number;
  deviceId: string;
}

/** Deterministic ordering for replay. */
export function compareEvents(a: ReviewEvent, b: ReviewEvent): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Rebuild every card's state from a review log. Cards with no events stay new. */
export function replay(
  events: readonly ReviewEvent[],
  p: FsrsParams = DEFAULT_FSRS_PARAMS,
): Map<string, SrsCard> {
  const sorted = [...events].sort(compareEvents);
  const cards = new Map<string, SrsCard>();
  for (const e of sorted) {
    const cur = cards.get(e.cardId) ?? newCard(e.at);
    cards.set(e.cardId, review(cur, e.rating, e.at, p));
  }
  return cards;
}
