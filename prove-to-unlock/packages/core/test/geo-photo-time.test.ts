import { describe, expect, it } from "vitest";
import {
  type PixelImage,
  assessAway,
  containment,
  cosineSimilarity,
  dHash,
  dayKey,
  distanceM,
  evaluateFloorChange,
  hamming,
  localTimeToEpoch,
  windowBounds,
} from "../src/index.js";

describe("geo", () => {
  it("haversine distance is accurate", () => {
    // JFK -> LAX ≈ 3,974 km
    const d = distanceM({ lat: 40.6413, lon: -73.7781 }, { lat: 33.9416, lon: -118.4085 });
    expect(d / 1000).toBeGreaterThan(3960);
    expect(d / 1000).toBeLessThan(3990);
    expect(distanceM({ lat: 10, lon: 10 }, { lat: 10, lon: 10 })).toBe(0);
  });

  it("containment respects GPS accuracy", () => {
    const place = { id: "g", name: "Gym", lat: 0, lon: 0, radiusM: 50 };
    const north = (m: number) => ({ lat: m / 111_195, lon: 0 });
    expect(containment(place, { ...north(10), accuracyM: 5 })).toBe("inside");
    expect(containment(place, { ...north(200), accuracyM: 20 })).toBe("outside");
    expect(containment(place, { ...north(10), accuracyM: 500 })).toBe("uncertain");
  });

  it("away needs sustained time outside, not a quick hop over the line", () => {
    const region = { id: "c", name: "City", lat: 0, lon: 0, radiusM: 30_000 };
    const H = 3600_000;
    const outside = { lat: 1, lon: 0 }; // ~111 km away
    const inside = { lat: 0, lon: 0 };
    const hop = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((h) => ({ t: h * H, ...(h === 4 ? outside : inside) }));
    expect(assessAway(hop, region, { from: 0, to: 9 * H, outsideFraction: 0.75, minHours: 4 }).region).toBe("in");
    const trip = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((h) => ({ t: h * H, ...(h === 0 ? inside : outside) }));
    expect(assessAway(trip, region, { from: 0, to: 9 * H, outsideFraction: 0.75, minHours: 4 }).region).toBe("away");
    expect(assessAway(trip.slice(0, 2), region, { from: 0, to: 9 * H, outsideFraction: 0.75, minHours: 4 }).region).toBe("unknown");
  });

  it("floor check uses robust medians of a barometer trace", () => {
    const trace = (deltas: number[]) => deltas.map((d, i) => ({ t: i * 1000, relM: d }));
    // 3 floors down (~9 m) with noise and a spike at the start.
    const down = trace([0, 0.2, 15, -0.1, 0, -2, -4, -6, -8, -8.9, -9.1, -9.0, -8.8, -9.2, -9.0]);
    expect(evaluateFloorChange(down, { direction: "down", floors: 3 }).ok).toBe(true);
    expect(evaluateFloorChange(down, { direction: "up", floors: 1 }).ok).toBe(false);
    const flat = trace([0, 0.3, -0.2, 0.1, 0, -0.4, 0.2, 0.1, 0, 0.2]);
    expect(evaluateFloorChange(flat, { direction: "down", floors: 1 }).ok).toBe(false);
    expect(evaluateFloorChange(trace([0, -9]), { direction: "down", floors: 3 }).reason).toMatch(/not enough/);
    const slow = [{ t: 0, relM: 0 }, { t: 1, relM: 0 }, { t: 3600_000, relM: -9 }, { t: 3600_001, relM: -9 }];
    expect(evaluateFloorChange(slow, { direction: "down", floors: 3 }).reason).toMatch(/too long/);
  });
});

function synthetic(w: number, h: number, f: (x: number, y: number) => number): PixelImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, f(x, y)));
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  return { width: w, height: h, data };
}

describe("photo fingerprints", () => {
  const scene = (x: number, y: number, w: number, h: number) => 128 + 100 * Math.sin((x / w) * 7) * Math.cos((y / h) * 5);

  it("same scene at different sizes / brightness hashes nearly the same", () => {
    const a = dHash(synthetic(640, 480, (x, y) => scene(x, y, 640, 480)));
    const b = dHash(synthetic(320, 240, (x, y) => scene(x, y, 320, 240) + 12));
    expect(hamming(a, b)).toBeLessThanOrEqual(4);
  });

  it("different scenes hash far apart", () => {
    const a = dHash(synthetic(320, 240, (x, y) => scene(x, y, 320, 240)));
    const c = dHash(synthetic(320, 240, (x, y) => (x * 3 + y * 7) % 255));
    expect(hamming(a, c)).toBeGreaterThan(16);
  });

  it("cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow();
  });
});

describe("time", () => {
  const TZ = "America/New_York";
  it("windows are local wall-clock, DST-safe", () => {
    // DST starts 2026-03-08 in New York: 05:00 local = 09:00Z, midnight end = 04:00Z next day.
    const b = windowBounds("2026-03-08", { start: "05:00", end: "24:00" }, TZ);
    expect(new Date(b.start).toISOString()).toBe("2026-03-08T09:00:00.000Z");
    expect(new Date(b.end).toISOString()).toBe("2026-03-09T04:00:00.000Z");
    // 02:30 doesn't exist that day; it shifts forward.
    expect(new Date(localTimeToEpoch("2026-03-08", 150, TZ)).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    // Fall back 2026-11-01: 01:30 happens twice; we pick the earlier (EDT).
    expect(new Date(localTimeToEpoch("2026-11-01", 90, TZ)).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(dayKey(Date.parse("2026-10-11T03:59:00Z"), TZ)).toBe("2026-10-10");
  });

  it("rejects bad windows", () => {
    expect(() => windowBounds("2026-01-01", { start: "10:00", end: "09:00" })).toThrow();
    expect(() => windowBounds("2026-01-01", { start: "25:00", end: "26:00" })).toThrow();
  });
});
