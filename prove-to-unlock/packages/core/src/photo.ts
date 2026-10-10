// Photo proof checks: perceptual hashing for repeat detection, label / reference-similarity checks.
//
// dHash ("difference hash"): grayscale -> area-average downscale to 9x8 -> one bit per horizontal
// neighbour comparison = 64 bits. Robust to re-compression, resizing and small exposure changes,
// so re-submitting yesterday's photo (or a photo of it) lands within a few bits of the original.

import type { PhotoDetail, PhotoRequirement, Place } from "./types.js";

export interface PixelImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel (canvas ImageData layout). */
  data: Uint8Array | Uint8ClampedArray;
}

/** ITU-R BT.601 luma, the same weights Core Image/Vision use for grayscale. */
export function toGray(img: PixelImage): Float64Array {
  const { width, height, data } = img;
  if (data.length < width * height * 4) throw new Error("pixel buffer too small for dimensions");
  const out = new Float64Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!;
  }
  return out;
}

/** Exact area-average resampling (each output pixel = mean of the source area it covers). */
export function areaResize(gray: Float64Array, w: number, h: number, ow: number, oh: number): Float64Array {
  const out = new Float64Array(ow * oh);
  const sx = w / ow;
  const sy = h / oh;
  for (let oy = 0; oy < oh; oy++) {
    const y0 = oy * sy;
    const y1 = y0 + sy;
    for (let ox = 0; ox < ow; ox++) {
      const x0 = ox * sx;
      const x1 = x0 + sx;
      let sum = 0;
      let area = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1) && y < h; y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = Math.floor(x0); x < Math.ceil(x1) && x < w; x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          sum += gray[y * w + x]! * wx * wy;
          area += wx * wy;
        }
      }
      out[oy * ow + ox] = area > 0 ? sum / area : 0;
    }
  }
  return out;
}

/** 64-bit dHash as 16 lowercase hex chars. */
export function dHash(img: PixelImage): string {
  if (img.width < 9 || img.height < 8) throw new Error("image too small to hash");
  const small = areaResize(toGray(img), img.width, img.height, 9, 8);
  let hex = "";
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) {
      const bit = small[y * 9 + x]! < small[y * 9 + x + 1]! ? 1 : 0;
      byte = (byte << 1) | bit;
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

const POPCOUNT = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = (i & 1) + t[i >> 1]!;
  return t;
})();

export function hamming(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) throw new Error("dHash must be 16 hex chars");
  let d = 0;
  for (let i = 0; i < 16; i += 2) {
    d += POPCOUNT[parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16)]!;
  }
  return d;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) throw new Error("vectors must have the same nonzero length");
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Best similarity of an embedding against a set of reference embeddings ("is this MY gym?"). */
export function referenceSimilarity(embedding: ArrayLike<number>, references: readonly ArrayLike<number>[]): number {
  let best = 0;
  for (const r of references) best = Math.max(best, cosineSimilarity(embedding, r));
  return best;
}

export const DEFAULT_REPEAT_MAX_HAMMING = 8;
export const DEFAULT_MIN_LABEL_CONFIDENCE = 0.3;

/** Labels that, as the top prediction, suggest a photo of a screen rather than the real place. */
export const SCREEN_LABELS = ["monitor", "screen", "television", "computer display", "display", "laptop", "notebook computer"];

export interface PhotoCheck {
  ok: boolean;
  failures: string[];
}

/**
 * Re-checkable verification of a photo proof. The capturing device computes the detail (labels,
 * similarity, GPS containment); every device re-runs these checks, including repeat detection
 * against all earlier photo proofs it knows about.
 */
export function checkPhotoProof(
  req: PhotoRequirement,
  detail: PhotoDetail,
  earlier: readonly { dhash: string; capturedAt: number }[],
  places: readonly Place[],
): PhotoCheck {
  const failures: string[] = [];
  if (!detail.live) failures.push("photo was not taken live in the app");
  if (!/^[0-9a-f]{16}$/.test(detail.dhash)) failures.push("photo fingerprint missing");

  if (/^[0-9a-f]{16}$/.test(detail.dhash)) {
    const maxH = req.repeatMaxHamming ?? DEFAULT_REPEAT_MAX_HAMMING;
    const repeat = earlier.find((e) => e.capturedAt < detail.capturedAt && /^[0-9a-f]{16}$/.test(e.dhash) && hamming(e.dhash, detail.dhash) <= maxH);
    if (repeat) failures.push(`looks like a repeat of a photo from ${new Date(repeat.capturedAt).toISOString().slice(0, 10)}`);
  }

  if (req.labelsAny && req.labelsAny.length > 0) {
    const minC = req.minLabelConfidence ?? DEFAULT_MIN_LABEL_CONFIDENCE;
    const wanted = req.labelsAny.map((l) => l.toLowerCase());
    const hit = detail.labels.some((l) => l.confidence >= minC && wanted.some((w) => l.label.toLowerCase().includes(w)));
    if (!hit) failures.push(`didn't see any of: ${req.labelsAny.join(", ")}`);
  }

  const top = [...detail.labels].sort((a, b) => b.confidence - a.confidence)[0];
  if (top && top.confidence >= 0.5 && SCREEN_LABELS.some((s) => top.label.toLowerCase().includes(s))) {
    failures.push("looks like a photo of a screen");
  }

  if (req.minReferenceSimilarity !== undefined) {
    if (detail.referenceSimilarity === undefined) failures.push("no reference photos to compare with");
    else if (detail.referenceSimilarity < req.minReferenceSimilarity) failures.push("doesn't look like your place");
  }

  if (req.placeId) {
    const place = places.find((p) => p.id === req.placeId);
    if (!place) failures.push("the required place no longer exists");
    else if (detail.placeId !== req.placeId || detail.insidePlace !== true) failures.push(`not taken at ${place.name}`);
  }

  if (req.challenge && !detail.challenge?.confirmed) failures.push("random challenge not completed");

  return { ok: failures.length === 0, failures };
}

const CHALLENGES = [
  "Hold up 3 fingers",
  "Hold up 2 fingers",
  "Give a thumbs up",
  "Include something blue",
  "Include your left hand",
  "Make a fist in frame",
  "Point at the floor",
  "Include your shoes",
];

export function randomChallenge(rand: () => number = Math.random): string {
  return CHALLENGES[Math.floor(rand() * CHALLENGES.length) % CHALLENGES.length]!;
}
