// The commitment engine: given the shared config and every verified record, decide whether this
// device should be locked right now and what is still needed to unlock it.
//
// Every device runs the same pure function over the same synced records, so they agree without a
// server. Proofs made on any paired device count everywhere.

import { checkPhotoProof } from "./photo.js";
import type { SignedRecord } from "./records.js";
import { dayKey, monthOf, weekdayOf, windowBounds } from "./time.js";
import type {
  AnkiDetail,
  Commitment,
  Config,
  DayKey,
  FocusDetail,
  PhotoDetail,
  PresenceDetail,
  ProofBody,
  Requirement,
  RequireMode,
} from "./types.js";

export interface RequirementStatus {
  requirement: Requirement;
  ok: boolean;
  /** Short human-readable progress, e.g. "2 / 4 sessions". */
  progress: string;
  proofIds: string[];
  /** Why the latest attempt didn't count (photo checks etc). */
  failures: string[];
}

export type UnlockReason =
  | "disabled"
  | "not-today"
  | "outside-window"
  | "excused"
  | "proven"
  | "unlock-record"
  | "emergency";

export interface CommitmentStatus {
  commitment: Commitment;
  day: DayKey;
  windowStart: number;
  windowEnd: number;
  mode: "normal" | "away";
  requirements: RequirementStatus[];
  satisfied: boolean;
  locked: boolean;
  /** Why it's unlocked (undefined while locked). */
  unlockedBy?: UnlockReason;
}

export interface LockState {
  locked: boolean;
  commitments: CommitmentStatus[];
  emergencyUntil?: number;
  /** Next instant at which the result may change on its own (window edges, emergency end). */
  nextChangeAt?: number;
}

export interface EngineInput {
  config: Config;
  /** Verified records only (see verifyRecord). */
  records: readonly SignedRecord[];
  now: number;
  /** IANA time zone; defaults to the device's local zone. */
  tz?: string;
}

function proofsOf(records: readonly SignedRecord[]): { id: string; body: ProofBody }[] {
  const out: { id: string; body: ProofBody }[] = [];
  for (const r of records) if (r.payload.typ === "proof") out.push({ id: r.payload.id, body: r.payload.body as ProofBody });
  return out;
}

function requiredCount(mode: RequireMode, n: number): number {
  return mode === "all" ? n : Math.max(0, Math.min(mode.any, n));
}

/** Merge [from,to) intervals and return total minutes. Prevents double-counting overlapping proofs. */
function mergedMinutes(intervals: { from: number; to: number }[]): number {
  const iv = intervals.filter((i) => i.to > i.from).sort((a, b) => a.from - b.from);
  let total = 0;
  let curFrom = -Infinity;
  let curTo = -Infinity;
  for (const i of iv) {
    if (i.from > curTo) {
      if (curTo > curFrom) total += curTo - curFrom;
      curFrom = i.from;
      curTo = i.to;
    } else curTo = Math.max(curTo, i.to);
  }
  if (curTo > curFrom) total += curTo - curFrom;
  return total / 60_000;
}

export function evaluateRequirement(
  req: Requirement,
  cid: string,
  day: DayKey,
  allProofs: readonly { id: string; body: ProofBody }[],
  config: Config,
): RequirementStatus {
  const todays = allProofs.filter((p) => p.body.cid === cid && p.body.day === day && p.body.kind === req.kind);
  const base = { requirement: req, proofIds: [] as string[], failures: [] as string[] };

  switch (req.kind) {
    case "photo": {
      const earlier = allProofs
        .filter((p) => p.body.kind === "photo")
        .map((p) => {
          const d = p.body.detail as PhotoDetail;
          return { dhash: d.dhash, capturedAt: d.capturedAt };
        });
      let lastFailures: string[] = [];
      for (const p of todays.sort((a, b) => a.body.at - b.body.at)) {
        const check = checkPhotoProof(req, p.body.detail as PhotoDetail, earlier, config.places);
        if (check.ok) return { ...base, ok: true, progress: "photo verified", proofIds: [p.id] };
        lastFailures = check.failures;
      }
      return { ...base, ok: false, progress: todays.length ? "photo rejected" : "no photo yet", failures: lastFailures };
    }

    case "presence": {
      const matching = todays.filter((p) => (p.body.detail as PresenceDetail).placeId === req.placeId);
      const minutes = mergedMinutes(matching.map((p) => p.body.detail as PresenceDetail));
      const ok = minutes >= req.minutes;
      return { ...base, ok, progress: `${Math.floor(minutes)} / ${req.minutes} min`, proofIds: matching.map((p) => p.id) };
    }

    case "altitude": {
      const required = req.floors * (req.metersPerFloor ?? 3) - (req.toleranceM ?? 1);
      const hit = todays.find((p) => {
        const d = (p.body.detail as { deltaM: number }).deltaM;
        return (req.direction === "down" ? -d : d) >= required;
      });
      return hit
        ? { ...base, ok: true, progress: `${req.floors} floor(s) ${req.direction}`, proofIds: [hit.id] }
        : { ...base, ok: false, progress: `go ${req.floors} floor(s) ${req.direction}` };
    }

    case "anki": {
      const relevant = todays.filter((p) => {
        const d = p.body.detail as AnkiDetail;
        return !req.deckIds || req.deckIds.length === 0 || d.deckIds.every((id) => req.deckIds!.includes(id));
      });
      if (req.mode === "due") {
        const cleared = relevant.find((p) => (p.body.detail as AnkiDetail).cleared);
        return cleared
          ? { ...base, ok: true, progress: "today's cards done", proofIds: [cleared.id] }
          : { ...base, ok: false, progress: "cards still due" };
      }
      const target = req.count ?? 20;
      const n = relevant.reduce((s, p) => s + (p.body.detail as AnkiDetail).reviews, 0);
      return { ...base, ok: n >= target, progress: `${Math.min(n, target)} / ${target} reviews`, proofIds: relevant.map((p) => p.id) };
    }

    case "focus": {
      const minLen = req.minutesPerSession ?? 25;
      let sessions = 0;
      for (const p of todays) {
        const d = p.body.detail as FocusDetail;
        if (d.sessions > 0 && d.minutes / d.sessions >= minLen) sessions += d.sessions;
      }
      return { ...base, ok: sessions >= req.sessions, progress: `${Math.min(sessions, req.sessions)} / ${req.sessions} sessions`, proofIds: todays.map((p) => p.id) };
    }
  }
}

/** Excused days that count: created before that day's window and within the monthly cap. */
export function validExcusedDays(config: Config, c: Commitment, tz?: string): Set<DayKey> {
  const byMonth = new Map<string, DayKey[]>();
  const sorted = [...config.excused].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const seen = new Set<DayKey>();
  for (const e of sorted) {
    if (seen.has(e.day)) continue;
    let start: number;
    try {
      start = windowBounds(e.day, c.window, tz).start;
    } catch {
      continue;
    }
    if (!(e.createdAt < start)) continue; // must be declared in advance
    const m = monthOf(e.day);
    const list = byMonth.get(m) ?? [];
    if (list.length >= config.policy.maxExcusedPerMonth) continue;
    list.push(e.day);
    byMonth.set(m, list);
    seen.add(e.day);
  }
  return seen;
}

/** Days this commitment ran in "away" mode, honoring the monthly cap (first N days win). */
export function honoredAwayDays(config: Config, c: Commitment, records: readonly SignedRecord[]): Set<DayKey> {
  const days = new Set<DayKey>();
  for (const r of records) {
    if (r.payload.typ !== "status") continue;
    const b = r.payload.body as { cid: string; day: DayKey; region: string };
    if (b.cid === c.id && b.region === "away") days.add(b.day);
  }
  const byMonth = new Map<string, number>();
  const honored = new Set<DayKey>();
  for (const d of [...days].sort()) {
    const m = monthOf(d);
    const n = byMonth.get(m) ?? 0;
    if (n >= config.policy.maxAwayDaysPerMonth) continue;
    byMonth.set(m, n + 1);
    honored.add(d);
  }
  return honored;
}

export function evaluate(input: EngineInput): LockState {
  const { config, records, now, tz } = input;
  const proofs = proofsOf(records);
  const day = dayKey(now, tz);

  let emergencyUntil: number | undefined;
  for (const r of records) {
    if (r.payload.typ !== "emergency") continue;
    const until = (r.payload.body as { until: number }).until;
    if (r.payload.iat <= now && until > now) emergencyUntil = Math.max(emergencyUntil ?? 0, until);
  }

  const statuses: CommitmentStatus[] = [];
  const changes: number[] = [];
  if (emergencyUntil) changes.push(emergencyUntil);

  for (const c of config.commitments) {
    let windowStart = 0;
    let windowEnd = 0;
    try {
      ({ start: windowStart, end: windowEnd } = windowBounds(day, c.window, tz));
    } catch {
      // Invalid window: never lock on a broken config.
      statuses.push({ commitment: c, day, windowStart, windowEnd, mode: "normal", requirements: [], satisfied: false, locked: false, unlockedBy: "disabled" });
      continue;
    }
    const stat = (s: Partial<CommitmentStatus> & Pick<CommitmentStatus, "locked">): CommitmentStatus => ({
      commitment: c,
      day,
      windowStart,
      windowEnd,
      mode: "normal",
      requirements: [],
      satisfied: false,
      ...s,
    });

    if (!c.enabled) {
      statuses.push(stat({ locked: false, unlockedBy: "disabled" }));
      continue;
    }
    if (!c.days.includes(weekdayOf(day))) {
      statuses.push(stat({ locked: false, unlockedBy: "not-today" }));
      continue;
    }
    if (now < windowStart || now >= windowEnd) {
      if (now < windowStart) changes.push(windowStart);
      statuses.push(stat({ locked: false, unlockedBy: "outside-window" }));
      continue;
    }
    changes.push(windowEnd);

    const awayDays = c.away ? honoredAwayDays(config, c, records) : new Set<DayKey>();
    const mode: "normal" | "away" = c.away && awayDays.has(day) ? "away" : "normal";
    const reqs = mode === "away" ? c.away!.requirements : c.requirements;
    const requireMode = mode === "away" ? c.away!.require : c.require;
    const reqStatus = reqs.map((r) => evaluateRequirement(r, c.id, day, proofs, config));
    const okCount = reqStatus.filter((r) => r.ok).length;
    const satisfied = okCount >= requiredCount(requireMode, reqs.length);

    let unlockedBy: UnlockReason | undefined;
    if (validExcusedDays(config, c, tz).has(day)) unlockedBy = "excused";
    else if (satisfied) unlockedBy = "proven";
    else if (
      records.some((r) => {
        if (r.payload.typ !== "unlock") return false;
        const b = r.payload.body as { cid: string; day: DayKey; until: number };
        return b.cid === c.id && b.day === day && b.until > now && r.payload.iat <= now;
      })
    )
      unlockedBy = "unlock-record";
    else if (emergencyUntil) unlockedBy = "emergency";

    statuses.push(stat({ mode, requirements: reqStatus, satisfied, locked: unlockedBy === undefined, unlockedBy }));
  }

  const future = changes.filter((t) => t > now);
  return {
    locked: statuses.some((s) => s.locked),
    commitments: statuses,
    emergencyUntil,
    nextChangeAt: future.length ? Math.min(...future) : undefined,
  };
}

/** Consecutive days (ending yesterday or today) on which the commitment was proven or excused. */
export function streak(input: EngineInput, commitmentId: string, maxDays = 365): number {
  const c = input.config.commitments.find((x) => x.id === commitmentId);
  if (!c) return 0;
  const proofs = proofsOf(input.records);
  const excused = validExcusedDays(input.config, c, input.tz);
  const awayDays = c.away ? honoredAwayDays(input.config, c, input.records) : new Set<DayKey>();
  const emergencyDays = new Set<DayKey>();
  for (const r of input.records) if (r.payload.typ === "emergency") emergencyDays.add((r.payload.body as { day: DayKey }).day);

  let count = 0;
  let t = input.now;
  for (let i = 0; i < maxDays; i++, t -= 86_400_000) {
    const day = dayKey(t, input.tz);
    if (!c.days.includes(weekdayOf(day))) continue;
    if (excused.has(day)) continue; // excused days neither break nor extend the streak
    const away = c.away && awayDays.has(day);
    const reqs = away ? c.away!.requirements : c.requirements;
    const mode = away ? c.away!.require : c.require;
    const ok = reqs.map((r) => evaluateRequirement(r, c.id, day, proofs, input.config).ok).filter(Boolean).length;
    const proven = ok >= requiredCount(mode, reqs.length) && !emergencyDays.has(day);
    if (proven) count++;
    else if (i === 0) continue; // today isn't over yet
    else break;
  }
  return count;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * While locked you can't talk your way out by editing the rules: a locked commitment can't be
 * changed or removed, essentials can't grow, policy can't loosen, and only future days can be
 * excused. Adding new commitments or places is always fine. Returns why a change is blocked.
 */
export function configChangeBlockedWhileLocked(prev: Config, next: Config, state: LockState): string | null {
  if (!state.locked) return null;
  for (const s of state.commitments.filter((c) => c.locked)) {
    const after = next.commitments.find((c) => c.id === s.commitment.id);
    if (!after) return `"${s.commitment.title}" is locked right now; it can't be deleted until you've unlocked it.`;
    const before = prev.commitments.find((c) => c.id === s.commitment.id);
    if (!same(before, after)) return `"${s.commitment.title}" is locked right now; edit it after you've unlocked it.`;
    const usedPlaces = new Set<string>();
    for (const r of [...after.requirements, ...(after.away?.requirements ?? [])]) {
      if (r.kind === "presence") usedPlaces.add(r.placeId);
      if (r.kind === "photo" && r.placeId) usedPlaces.add(r.placeId);
    }
    if (after.away) usedPlaces.add(after.away.regionPlaceId);
    for (const id of usedPlaces) {
      if (!same(prev.places.find((p) => p.id === id), next.places.find((p) => p.id === id))) {
        return "A place used by a locked commitment can't be moved or resized until you've unlocked.";
      }
    }
  }
  const newApps = next.essentials.apps.filter((a) => !prev.essentials.apps.includes(a));
  const newSites = next.essentials.sites.filter((a) => !prev.essentials.sites.includes(a));
  if (newApps.length || newSites.length) return "You can't add essentials while locked. Add them after you've unlocked.";
  const p = prev.policy;
  const n = next.policy;
  if (
    n.maxExcusedPerMonth > p.maxExcusedPerMonth ||
    n.maxAwayDaysPerMonth > p.maxAwayDaysPerMonth ||
    n.emergencyMinutes > p.emergencyMinutes ||
    n.awayOutsideFraction < p.awayOutsideFraction ||
    n.awayMinHours < p.awayMinHours ||
    n.minAnswerMs < p.minAnswerMs
  ) {
    return "Rules can't be loosened while locked.";
  }
  const today = state.commitments[0]?.day;
  const added = next.excused.filter((e) => !prev.excused.some((x) => x.day === e.day));
  if (today && added.some((e) => e.day <= today)) return "Excused days must be set in advance, not for today.";
  return null;
}
