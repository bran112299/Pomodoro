// Local-time helpers. Commitments are defined in wall-clock time ("05:00".."24:00") on local
// calendar days; every device evaluates them in its own time zone (or an explicit IANA zone).

import type { DayKey, TimeOfDay } from "./types.js";

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz ?? "";
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(key, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(ms: number, tz?: string): ZonedParts {
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function dayKey(ms: number, tz?: string): DayKey {
  const p = zonedParts(ms, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function parseDayKey(day: DayKey): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`invalid day key: ${day}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function parseTimeOfDay(t: TimeOfDay): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) throw new Error(`invalid time of day: ${t}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) throw new Error(`invalid time of day: ${t}`);
  return h * 60 + min;
}

/** Offset (ms) of the zone from UTC at instant `ms`: local = utc + offset. */
function zoneOffset(ms: number, tz?: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Epoch ms of a local wall-clock time on a given day. Handles DST: a non-existent local time
 * (spring-forward gap) is shifted forward by the gap length (like JavaScript's Date); an
 * ambiguous one (fall-back) resolves to the earlier instant.
 */
export function localTimeToEpoch(day: DayKey, minutesOfDay: number, tz?: string): number {
  const { year, month, day: d } = parseDayKey(day);
  const wall = Date.UTC(year, month - 1, d, 0, 0, 0) + minutesOfDay * 60_000;
  // Two fixed-point iterations converge for all real-world zones.
  let guess = wall - zoneOffset(wall, tz);
  guess = wall - zoneOffset(guess, tz);
  const candidates = [guess - 3600_000, guess, guess + 3600_000].filter(
    (c) => c + zoneOffset(c, tz) === wall,
  );
  if (candidates.length > 0) return Math.min(...candidates);
  // In a DST gap: no instant maps to this wall time. Interpret it with the offset in effect
  // before the transition, which moves it forward by the gap (02:30 -> 03:30), like Date does.
  return wall - zoneOffset(guess - 6 * 3600_000, tz);
}

export function windowBounds(
  day: DayKey,
  window: { start: TimeOfDay; end: TimeOfDay },
  tz?: string,
): { start: number; end: number } {
  const s = parseTimeOfDay(window.start);
  const e = parseTimeOfDay(window.end);
  if (e <= s) throw new Error(`window end ${window.end} must be after start ${window.start}`);
  return { start: localTimeToEpoch(day, s, tz), end: localTimeToEpoch(day, e, tz) };
}

export function weekdayOf(day: DayKey): number {
  const { year, month, day: d } = parseDayKey(day);
  return new Date(Date.UTC(year, month - 1, d)).getUTCDay();
}

/** "YYYY-MM" for monthly caps. */
export function monthOf(day: DayKey): string {
  return day.slice(0, 7);
}
