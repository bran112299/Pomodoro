import type { Config } from "@ptu/core";

/** Reject configs that would break evaluation on other devices. */
export function validateConfig(c: Config): void {
  if (!c || !Array.isArray(c.commitments) || !Array.isArray(c.places)) throw new Error("invalid config");
  const ids = new Set<string>();
  for (const k of c.commitments) {
    if (!k.id || ids.has(k.id)) throw new Error("commitment ids must be unique");
    ids.add(k.id);
    if (!/^\d{1,2}:\d{2}$/.test(k.window.start) || !/^\d{1,2}:\d{2}$/.test(k.window.end)) throw new Error(`"${k.title}": invalid time window`);
    const [sh, sm] = k.window.start.split(":").map(Number);
    const [eh, em] = k.window.end.split(":").map(Number);
    if (eh! * 60 + em! <= sh! * 60 + sm!) throw new Error(`"${k.title}": window must end after it starts`);
    if (k.require !== "all" && !(k.require.any >= 1)) throw new Error(`"${k.title}": invalid requirement count`);
    for (const r of [...k.requirements, ...(k.away?.requirements ?? [])]) {
      if ((r.kind === "photo" && r.placeId) || r.kind === "presence") {
        const pid = r.kind === "presence" ? r.placeId : r.placeId;
        if (!c.places.some((p) => p.id === pid)) throw new Error(`"${k.title}": a requirement uses a place that doesn't exist`);
      }
    }
    if (k.away && !c.places.some((p) => p.id === k.away!.regionPlaceId)) throw new Error(`"${k.title}": the away region doesn't exist`);
  }
}
