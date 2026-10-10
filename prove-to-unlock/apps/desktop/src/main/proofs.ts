// Photo proofs on the computer. (Anki and focus proofs live in @ptu/core so the extension shares them.)

import {
  type Ledger,
  type PhotoDetail,
  type PhotoRequirement,
  type ProofBody,
  checkPhotoProof,
  dayKey,
  evaluate,
  referenceSimilarity,
} from "@ptu/core";

export { issueAnkiProofs, issueFocusProof } from "@ptu/core";

export interface PhotoInput {
  commitmentId: string;
  requirementIndex: number;
  dhash: string;
  labels: { label: string; confidence: number }[];
  embedding: number[];
  capturedAt: number;
  challenge?: { prompt: string; confirmed: boolean };
}

/** Validate and, if it passes, record a photo proof. Same checks every other device re-runs. */
export async function issuePhotoProof(ledger: Ledger, input: PhotoInput, references: number[][] | undefined, now: number, tz?: string) {
  const config = ledger.config();
  const c = config.commitments.find((x) => x.id === input.commitmentId);
  if (!c) return { ok: false, failures: ["unknown commitment"] };
  const status = evaluate({ config, records: ledger.records(), now, tz }).commitments.find((s) => s.commitment.id === c.id);
  const reqs = status?.mode === "away" ? (c.away?.requirements ?? []) : c.requirements;
  const req = reqs[input.requirementIndex];
  if (!req || req.kind !== "photo") return { ok: false, failures: ["that requirement isn't a photo"] };
  if (Math.abs(now - input.capturedAt) > 2 * 60_000) return { ok: false, failures: ["photo is too old; take a new one"] };

  let similarity: number | undefined;
  if (references?.length && input.embedding.length) {
    try {
      similarity = referenceSimilarity(input.embedding, references);
    } catch {
      similarity = undefined;
    }
  }
  const detail: PhotoDetail = {
    dhash: input.dhash,
    labels: input.labels.slice(0, 10).map((l) => ({ label: String(l.label).slice(0, 80), confidence: Number(l.confidence) || 0 })),
    referenceSimilarity: similarity,
    live: true,
    capturedAt: input.capturedAt,
    // Computers have no GPS: a place-bound photo requirement must be proven on the phone.
    insidePlace: false,
    challenge: input.challenge,
  };
  const earlier = ledger
    .records()
    .filter((r) => r.payload.typ === "proof" && (r.payload.body as ProofBody).kind === "photo")
    .map((r) => (r.payload.body as ProofBody).detail as PhotoDetail);
  const check = checkPhotoProof(req as PhotoRequirement, detail, earlier, config.places);
  if (!check.ok) return check;
  await ledger.issue("proof", { cid: c.id, day: dayKey(now, tz), kind: "photo", at: now, detail }, now);
  return { ok: true, failures: [] };
}
