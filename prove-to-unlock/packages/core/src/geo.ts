// Places (pin + radius), the "reachable region / away" policy, and floor-level altitude checks.

import type { Place } from "./types.js";

const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface LocationSample extends LatLon {
  t: number;
  /** Horizontal accuracy (m), if known. */
  accuracyM?: number;
}

const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance (haversine), meters. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type Containment = "inside" | "outside" | "uncertain";

/**
 * Whether a fix is inside a place. With accuracy information, only answer definitively when the
 * whole accuracy circle is on one side of the boundary.
 */
export function containment(place: Place, fix: LatLon & { accuracyM?: number }): Containment {
  const d = distanceM(place, fix);
  const acc = Math.max(0, fix.accuracyM ?? 0);
  if (d + acc <= place.radiusM) return "inside";
  if (d - acc > place.radiusM) return "outside";
  // Accuracy circle straddles the edge: decide by the center when it's well inside/outside.
  return acc > place.radiusM ? "uncertain" : d <= place.radiusM ? "inside" : "outside";
}

export function validatePlace(p: Place): string | null {
  if (!p.id) return "place needs an id";
  if (!(p.lat >= -90 && p.lat <= 90)) return "latitude must be between -90 and 90";
  if (!(p.lon >= -180 && p.lon <= 180)) return "longitude must be between -180 and 180";
  if (!(p.radiusM >= 10 && p.radiusM <= 500_000)) return "radius must be between 10 m and 500 km";
  return null;
}

export interface AwayAssessment {
  region: "in" | "away" | "unknown";
  /** Fraction of time (weighted by sample spacing) spent outside the region. */
  outsideFraction: number;
  /** Hours covered by the samples. */
  spanHours: number;
}

/**
 * Decide whether the user is genuinely away from the reachable region during [from, to].
 *
 * Time-weighted: each sample counts for the time until the next sample (capped at `maxGapMs`, so a
 * phone that was off doesn't stretch one sample over the whole day). "Away" requires both enough
 * coverage (`minHours`) and spending at least `outsideFraction` of the covered time outside. This
 * stops "drive just past the line for a minute" from counting as travel.
 */
export function assessAway(
  samples: readonly LocationSample[],
  region: Place,
  opts: { from: number; to: number; outsideFraction: number; minHours: number; maxGapMs?: number },
): AwayAssessment {
  const maxGap = opts.maxGapMs ?? 2 * 3600_000;
  const pts = samples.filter((s) => s.t >= opts.from && s.t <= opts.to).sort((a, b) => a.t - b.t);
  if (pts.length === 0) return { region: "unknown", outsideFraction: 0, spanHours: 0 };
  let covered = 0;
  let outside = 0;
  for (let i = 0; i < pts.length; i++) {
    const s = pts[i]!;
    const next = pts[i + 1]?.t ?? Math.min(opts.to, s.t + maxGap);
    const dt = Math.max(0, Math.min(next - s.t, maxGap));
    const c = containment(region, s);
    if (c === "uncertain") continue;
    covered += dt;
    if (c === "outside") outside += dt;
  }
  const spanHours = covered / 3600_000;
  const frac = covered > 0 ? outside / covered : 0;
  if (spanHours < opts.minHours) return { region: "unknown", outsideFraction: frac, spanHours };
  return { region: frac >= opts.outsideFraction ? "away" : "in", outsideFraction: frac, spanHours };
}

export interface AltitudeSample {
  t: number;
  /** Barometric altitude relative to the start of the session (m). */
  relM: number;
}

export interface DescentResult {
  ok: boolean;
  /** Final minus baseline (negative = went down). */
  deltaM: number;
  requiredM: number;
  reason?: string;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Floor check from a barometer trace recorded between "heading there" and "taking the proof".
 * Uses medians of the first/last few seconds so a single noisy reading (door slam, HVAC) can't
 * fake or break the result. Only relative change is meaningful: absolute pressure drifts with the
 * weather by several meters per hour.
 */
export function evaluateFloorChange(
  samples: readonly AltitudeSample[],
  req: { direction: "down" | "up"; floors: number; metersPerFloor?: number; toleranceM?: number },
  opts: { edgeMs?: number; maxSessionMs?: number } = {},
): DescentResult {
  const perFloor = req.metersPerFloor ?? 3;
  const tol = req.toleranceM ?? 1;
  const requiredM = req.floors * perFloor;
  const edge = opts.edgeMs ?? 5000;
  const maxSession = opts.maxSessionMs ?? 30 * 60_000;
  const pts = [...samples].sort((a, b) => a.t - b.t);
  if (pts.length < 4) return { ok: false, deltaM: 0, requiredM, reason: "not enough altimeter readings" };
  const t0 = pts[0]!.t;
  const t1 = pts[pts.length - 1]!.t;
  if (t1 - t0 > maxSession) {
    return { ok: false, deltaM: 0, requiredM, reason: "session too long; the weather can drift that far" };
  }
  const head = pts.filter((s) => s.t - t0 <= edge).map((s) => s.relM);
  const tail = pts.filter((s) => t1 - s.t <= edge).map((s) => s.relM);
  const deltaM = median(tail) - median(head);
  const signed = req.direction === "down" ? -deltaM : deltaM;
  const ok = signed >= requiredM - tol;
  return ok
    ? { ok, deltaM, requiredM }
    : { ok, deltaM, requiredM, reason: `moved ${Math.abs(deltaM).toFixed(1)} m ${deltaM < 0 ? "down" : "up"}; need ${requiredM} m ${req.direction}` };
}
