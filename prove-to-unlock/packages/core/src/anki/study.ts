// Study queue: which cards to show now, built from imported decks + the merged review log.

import { DEFAULT_FSRS_PARAMS, type FsrsParams, type ReviewEvent, type SrsCard, newCard, replay } from "../fsrs.js";
import { dayKey, localTimeToEpoch } from "../time.js";
import type { Deck, DeckCard } from "./apkg.js";

export interface StudyOptions {
  newPerDay: number;
  /** Max reviews per day (default unlimited). */
  reviewsPerDay?: number;
  /** Anki's day starts at 4am by default so late-night study counts for "today". */
  rolloverHour?: number;
  /** Show learning cards up to this early when nothing else is left (Anki: 20 min). */
  learnAheadMs?: number;
  tz?: string;
  params?: FsrsParams;
  /** Restrict to these decks. */
  deckIds?: string[];
}

export interface QueueItem {
  card: DeckCard;
  deckId: string;
  srs: SrsCard;
  kind: "new" | "learning" | "review";
}

export interface StudyQueue {
  items: QueueItem[];
  counts: { new: number; learning: number; review: number };
  /** When the next learning card becomes due (if any are waiting). */
  nextDueAt?: number;
  /** Nothing left to do today (learning cards waiting on a timer don't count). */
  cleared: boolean;
}

/** Start of the study day containing `now` (rollover-aware), and the next one. */
export function studyDayBounds(now: number, rolloverHour = 4, tz?: string): { start: number; end: number; day: string } {
  const shifted = now - rolloverHour * 3600_000;
  const day = dayKey(shifted, tz);
  const start = localTimeToEpoch(day, rolloverHour * 60, tz);
  // Next day's start: compute from the next calendar day to stay DST-correct.
  const next = dayKey(start + 36 * 3600_000, tz);
  const end = localTimeToEpoch(next, rolloverHour * 60, tz);
  return { start, end, day };
}

export function buildQueue(decks: readonly Deck[], events: readonly ReviewEvent[], now: number, opts: StudyOptions): StudyQueue {
  const p = opts.params ?? DEFAULT_FSRS_PARAMS;
  const learnAhead = opts.learnAheadMs ?? 20 * 60_000;
  const { start, end } = studyDayBounds(now, opts.rolloverHour ?? 4, opts.tz);
  const selected = opts.deckIds?.length ? decks.filter((d) => opts.deckIds!.includes(d.id)) : decks;
  const cardIds = new Set<string>();
  for (const d of selected) for (const c of d.cards) cardIds.add(c.id);

  const relevant = events.filter((e) => cardIds.has(e.cardId));
  const states = replay(relevant, p);

  // New cards introduced today = cards whose first-ever review happened today.
  const firstSeen = new Map<string, number>();
  for (const e of relevant) firstSeen.set(e.cardId, Math.min(firstSeen.get(e.cardId) ?? Infinity, e.at));
  let introducedToday = 0;
  for (const t of firstSeen.values()) if (t >= start && t < end) introducedToday++;

  // Reviews already done today (for the review limit), counting graduated-review cards only.
  const reviewedToday = new Set(relevant.filter((e) => e.at >= start && e.at < end).map((e) => e.cardId));

  const learning: QueueItem[] = [];
  const waiting: QueueItem[] = [];
  const reviews: QueueItem[] = [];
  const fresh: QueueItem[] = [];
  for (const d of selected) {
    for (const card of d.cards) {
      const srs = states.get(card.id);
      if (!srs) {
        fresh.push({ card, deckId: d.id, srs: newCard(now), kind: "new" });
      } else if (srs.state === "learning" || srs.state === "relearning") {
        (srs.due <= now ? learning : waiting).push({ card, deckId: d.id, srs, kind: "learning" });
      } else if (srs.state === "review" && srs.due < end) {
        reviews.push({ card, deckId: d.id, srs, kind: "review" });
      }
    }
  }
  learning.sort((a, b) => a.srs.due - b.srs.due);
  waiting.sort((a, b) => a.srs.due - b.srs.due);
  reviews.sort((a, b) => a.srs.due - b.srs.due);
  fresh.sort((a, b) => a.card.position - b.card.position);

  const reviewLimit = opts.reviewsPerDay ?? Infinity;
  const reviewsLeft = Math.max(0, reviewLimit - [...reviewedToday].filter((id) => (states.get(id)?.state ?? "new") === "review").length);
  const reviewItems = reviews.slice(0, reviewsLeft);
  const newItems = fresh.slice(0, Math.max(0, opts.newPerDay - introducedToday));

  const items = [...learning, ...reviewItems, ...newItems];
  if (items.length === 0) {
    // Learn ahead: nothing else to do, show learning cards that are due soon.
    for (const w of waiting) if (w.srs.due <= now + learnAhead) items.push(w);
  }
  const stillWaiting = waiting.filter((w) => !items.includes(w));
  return {
    items,
    counts: {
      new: newItems.length,
      learning: items.filter((i) => i.kind === "learning").length,
      review: reviewItems.length,
    },
    nextDueAt: stillWaiting[0]?.srs.due,
    cleared: items.length === 0,
  };
}

/**
 * Reviews today that count toward a commitment: the answer must have been visible for at least
 * `minAnswerMs` before rating (mashing buttons doesn't count). Only this device's events count, so
 * proofs from several devices never double-count the same review.
 */
export function honestReviewsToday(
  events: readonly ReviewEvent[],
  now: number,
  opts: { minAnswerMs: number; deviceId: string; rolloverHour?: number; tz?: string; deckIds?: string[] },
): number {
  const { start, end } = studyDayBounds(now, opts.rolloverHour ?? 4, opts.tz);
  return events.filter(
    (e) =>
      e.deviceId === opts.deviceId &&
      e.at >= start &&
      e.at < end &&
      e.at - e.answerShownAt >= opts.minAnswerMs &&
      (!opts.deckIds?.length || opts.deckIds.includes(e.deckId)),
  ).length;
}
