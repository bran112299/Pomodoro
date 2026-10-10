// Signed records: the only thing devices exchange to prove, unlock and configure.
//
// Wire format (JWS-like compact form):  base64url(payloadJSON) "." base64url(signature)
// The signature covers the ASCII bytes of the first segment, so no JSON canonicalization is needed
// and any implementation (Swift, TS) can verify records produced by any other.

import { b64urlToBytes, bytesToB64url, fromUtf8, utf8 } from "./b64.js";
import { type Identity, randomId, sign, verify } from "./crypto.js";
import type { ConfigBody, EmergencyBody, ProofBody, StatusBody, UnlockBody } from "./types.js";

export type RecordType = "proof" | "unlock" | "emergency" | "config" | "status";

export interface RecordBodyMap {
  proof: ProofBody;
  unlock: UnlockBody;
  emergency: EmergencyBody;
  config: ConfigBody;
  status: StatusBody;
}

export interface RecordPayload<T extends RecordType = RecordType> {
  v: 1;
  typ: T;
  /** Unique record id (random). */
  id: string;
  /** Issuing device id. */
  iss: string;
  /** Issued at, ms since epoch. */
  iat: number;
  body: RecordBodyMap[T];
}

export interface SignedRecord<T extends RecordType = RecordType> {
  raw: string;
  payload: RecordPayload<T>;
}

const RECORD_TYPES: ReadonlySet<string> = new Set(["proof", "unlock", "emergency", "config", "status"]);
/** Records issued further than this in the future are rejected (clock skew allowance). */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const MAX_RECORD_BYTES = 64 * 1024;

export async function createRecord<T extends RecordType>(
  id: Identity,
  typ: T,
  body: RecordBodyMap[T],
  now: number = Date.now(),
): Promise<SignedRecord<T>> {
  const payload: RecordPayload<T> = { v: 1, typ, id: randomId(16), iss: id.deviceId, iat: now, body };
  const head = bytesToB64url(utf8(JSON.stringify(payload)));
  const sig = await sign(id, utf8(head));
  return { raw: `${head}.${bytesToB64url(sig)}`, payload };
}

export type VerifyFailure =
  | "malformed"
  | "too-large"
  | "bad-version"
  | "unknown-type"
  | "untrusted-issuer"
  | "bad-signature"
  | "from-future";

export type VerifyResult<T extends RecordType = RecordType> =
  | { ok: true; record: SignedRecord<T> }
  | { ok: false; reason: VerifyFailure };

/** Parse without verifying. Only use for display/debugging. */
export function parseRecordUnverified(raw: string): RecordPayload | null {
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  try {
    return JSON.parse(fromUtf8(b64urlToBytes(raw.slice(0, dot)))) as RecordPayload;
  } catch {
    return null;
  }
}

/**
 * Verify a record against the set of trusted device public keys (deviceId -> SPKI base64).
 */
export async function verifyRecord(
  raw: string,
  trusted: ReadonlyMap<string, string>,
  now: number = Date.now(),
): Promise<VerifyResult> {
  if (typeof raw !== "string") return { ok: false, reason: "malformed" };
  if (raw.length > MAX_RECORD_BYTES) return { ok: false, reason: "too-large" };
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  let payload: RecordPayload;
  let sig: Uint8Array;
  try {
    payload = JSON.parse(fromUtf8(b64urlToBytes(parts[0]))) as RecordPayload;
    sig = b64urlToBytes(parts[1]);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload !== "object") return { ok: false, reason: "malformed" };
  if (payload.v !== 1) return { ok: false, reason: "bad-version" };
  if (!RECORD_TYPES.has(payload.typ)) return { ok: false, reason: "unknown-type" };
  if (
    typeof payload.id !== "string" ||
    typeof payload.iss !== "string" ||
    typeof payload.iat !== "number" ||
    !Number.isFinite(payload.iat) ||
    typeof payload.body !== "object" ||
    payload.body === null
  ) {
    return { ok: false, reason: "malformed" };
  }
  const key = trusted.get(payload.iss);
  if (!key) return { ok: false, reason: "untrusted-issuer" };
  if (!(await verify(key, sig, utf8(parts[0])))) return { ok: false, reason: "bad-signature" };
  if (payload.iat > now + MAX_FUTURE_SKEW_MS) return { ok: false, reason: "from-future" };
  return { ok: true, record: { raw, payload } };
}

export function isType<T extends RecordType>(r: SignedRecord, typ: T): r is SignedRecord<T> {
  return r.payload.typ === typ;
}
