// Turning local activity (Anki reviews, focus sessions) into signed proof records. Shared by the
// desktop app and the browser extension so both count reviews exactly the same way.

import { buildQueue, honestReviewsToday } from "./anki/study.js";
import type { Deck } from "./anki/apkg.js";
import { evaluate } from "./engine.js";
import type { Ledger } from "./ledger.js";
import { dayKey } from "./time.js";
import type { AnkiDetail, AnkiRequirement, Config, ProofBody } from "./types.js";

export interface ProofContext {
  ledger: Ledger;
  decks: Deck[];
  now: number;
  newCardsPerDay: number;
  tz?: string;
}

function proofsToday(ledger: Ledger, cid: string, day: string, kind: ProofBody["kind"]) {
  return ledger
    .records()
    .filter((r) => r.payload.typ === "proof")
    .map((r) => ({ iss: r.payload.iss, body: r.payload.body as ProofBody }))
    .filter((p) => p.body.cid === cid && p.body.day === day && p.body.kind === kind);
}

/** Commitments that are currently active (inside their window today, enabled). */
export function activeCommitments(config: Config, ledger: Ledger, now: number, tz?: string) {
  return evaluate({ config, records: ledger.records(), now, tz }).commitments.filter(
    (c) => c.unlockedBy === undefined || c.unlockedBy === "proven" || c.unlockedBy === "unlock-record" || c.unlockedBy === "emergency",
  );
}

/**
 * After reviews, issue Anki proofs for every active commitment with an Anki requirement.
 * Proofs carry only reviews not already claimed by this device today, so totals never
 * double-count, and reviews done on several devices add up.
 */
export async function issueAnkiProofs(ctx: ProofContext): Promise<number> {
  const { ledger, now, tz } = ctx;
  const config = ledger.config();
  const day = dayKey(now, tz);
  let issued = 0;
  for (const cs of activeCommitments(config, ledger, now, tz)) {
    const c = cs.commitment;
    const reqs = cs.mode === "away" ? (c.away?.requirements ?? []) : c.requirements;
    for (const r of reqs) {
      if (r.kind !== "anki") continue;
      const req = r as AnkiRequirement;
      const existing = proofsToday(ledger, c.id, day, "anki");
      const mine = existing.filter((p) => p.iss === ledger.deviceId);
      const claimed = mine.reduce((s, p) => s + (p.body.detail as AnkiDetail).reviews, 0);
      const others = existing.filter((p) => p.iss !== ledger.deviceId).reduce((s, p) => s + (p.body.detail as AnkiDetail).reviews, 0);
      const honest = honestReviewsToday(ledger.reviews(), now, {
        minAnswerMs: config.policy.minAnswerMs,
        deviceId: ledger.deviceId,
        rolloverHour: 0,
        tz,
        deckIds: req.deckIds,
      });
      const delta = honest - claimed;
      const deckIds = req.deckIds ?? [];

      if (req.mode === "count") {
        const target = req.count ?? 20;
        if (delta > 0 && (others + honest >= target || delta >= 10)) {
          await ledger.issue("proof", { cid: c.id, day, kind: "anki", at: now, detail: { reviews: delta, cleared: false, deckIds } }, now);
          issued++;
        }
      } else {
        if (existing.some((p) => (p.body.detail as AnkiDetail).cleared)) continue;
        const selected = req.deckIds?.length ? ctx.decks.filter((d) => req.deckIds!.includes(d.id)) : ctx.decks;
        if (!selected.some((d) => d.cards.length > 0)) continue; // nothing imported: can't "clear" an empty queue
        const q = buildQueue(selected, ledger.reviews(), now, { newPerDay: ctx.newCardsPerDay, tz });
        if (q.cleared) {
          await ledger.issue("proof", { cid: c.id, day, kind: "anki", at: now, detail: { reviews: Math.max(0, delta), cleared: true, deckIds } }, now);
          issued++;
        }
      }
    }
  }
  return issued;
}

export async function issueFocusProof(ledger: Ledger, commitmentId: string, minutes: number, now: number, tz?: string) {
  if (!(minutes >= 1 && minutes <= 240)) return { ok: false, failures: ["invalid session length"] };
  const c = ledger.config().commitments.find((x) => x.id === commitmentId);
  if (!c) return { ok: false, failures: ["unknown commitment"] };
  await ledger.issue("proof", { cid: commitmentId, day: dayKey(now, tz), kind: "focus", at: now, detail: { sessions: 1, minutes } }, now);
  return { ok: true, failures: [] };
}
