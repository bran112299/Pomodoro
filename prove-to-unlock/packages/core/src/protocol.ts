// Local-network linking protocol (no accounts, no cloud). See spec/protocol.md.
//
//   GET  /v1/info          public: who are you (device id, name, public key, fingerprint)
//   POST /v1/pair          public, needs the 6-digit code shown on the other device's screen
//   POST /v1/sync          signed request: exchange records + review events since a cursor
//   GET  /v1/trust         signed request: devices this device trusts (extension adopts them)
//   GET  /v1/decks         signed request: list imported decks
//   GET  /v1/decks/<id>    signed request: one deck with media
//
// Requests from paired devices are signed with the device key (header below), so nobody else on
// the Wi-Fi can read your cards or inject records. Records themselves are independently signed,
// so even a relaying device can't forge a proof or an unlock.

import { b64urlToBytes, bytesToB64url, timingSafeEqual, utf8 } from "./b64.js";
import { type Identity, randomBytes, sha256, sign, verify } from "./crypto.js";
import type { ReviewEvent } from "./fsrs.js";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47123;
export const MDNS_SERVICE_TYPE = "provetounlock"; // _provetounlock._tcp
export const AUTH_SCHEME = "PTU1";
export const AUTH_MAX_SKEW_MS = 2 * 60_000;

export type Platform = "ios" | "mac" | "windows" | "linux" | "extension";

export interface DeviceHello {
  deviceId: string;
  name: string;
  platform: Platform;
  publicKey: string;
}

export interface InfoResponse extends DeviceHello {
  protocol: number;
  fingerprint: string;
  /** Whether this device is currently showing a pairing code. */
  pairing: boolean;
}

export interface PairRequest {
  code: string;
  device: DeviceHello;
  /** Computers include where they can be reached so the other side can sync back. */
  listen?: { hosts: string[]; port: number };
}

export interface PairResponse {
  device: DeviceHello;
}

export interface SyncCursor {
  records: number;
  reviews: number;
}

export interface SyncRequest {
  records: string[];
  reviews: ReviewEvent[];
  /** What the caller already has from this peer. */
  since: SyncCursor;
}

export interface SyncResponse {
  records: string[];
  reviews: ReviewEvent[];
  cursor: SyncCursor;
  accepted: number;
  rejected: number;
}

export interface TrustResponse {
  devices: DeviceHello[];
}

export interface DeckSummary {
  id: string;
  name: string;
  cards: number;
  importedAt: number;
}

// ---------------------------------------------------------------------------------------------
// Signed requests

async function canonicalRequest(method: string, path: string, ts: number, body: Uint8Array): Promise<Uint8Array> {
  const bodyHash = bytesToB64url(await sha256(body));
  return utf8(`${AUTH_SCHEME}\n${method.toUpperCase()}\n${path}\n${ts}\n${bodyHash}`);
}

export async function authHeader(id: Identity, method: string, path: string, body: Uint8Array, now = Date.now()): Promise<string> {
  const sig = await sign(id, await canonicalRequest(method, path, now, body));
  return `${AUTH_SCHEME} deviceId=${id.deviceId},ts=${now},sig=${bytesToB64url(sig)}`;
}

export interface ParsedAuth {
  deviceId: string;
  ts: number;
  sig: string;
}

export function parseAuthHeader(h: string | undefined | null): ParsedAuth | null {
  if (!h || !h.startsWith(AUTH_SCHEME + " ")) return null;
  const kv = Object.fromEntries(
    h
      .slice(AUTH_SCHEME.length + 1)
      .split(",")
      .map((p) => {
        const i = p.indexOf("=");
        return i < 0 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
      }),
  );
  const ts = Number(kv.ts);
  if (!kv.deviceId || !kv.sig || !Number.isFinite(ts)) return null;
  return { deviceId: kv.deviceId, ts, sig: kv.sig };
}

/** Remembers recent signatures so a captured request can't be replayed within the skew window. */
export class ReplayGuard {
  private seen = new Map<string, number>();
  check(key: string, now: number): boolean {
    for (const [k, t] of this.seen) if (now - t > 2 * AUTH_MAX_SKEW_MS) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }
}

export type AuthResult = { ok: true; deviceId: string } | { ok: false; status: 401 | 403; reason: string };

export async function verifyAuth(
  header: string | undefined | null,
  method: string,
  path: string,
  body: Uint8Array,
  trusted: ReadonlyMap<string, string>,
  replay: ReplayGuard,
  now = Date.now(),
): Promise<AuthResult> {
  const a = parseAuthHeader(header);
  if (!a) return { ok: false, status: 401, reason: "missing or malformed authorization" };
  if (Math.abs(now - a.ts) > AUTH_MAX_SKEW_MS) return { ok: false, status: 401, reason: "clock skew too large; check both devices' time" };
  const key = trusted.get(a.deviceId);
  if (!key) return { ok: false, status: 403, reason: "device not paired" };
  let sig: Uint8Array;
  try {
    sig = b64urlToBytes(a.sig);
  } catch {
    return { ok: false, status: 401, reason: "bad signature encoding" };
  }
  if (!(await verify(key, sig, await canonicalRequest(method, path, a.ts, body)))) {
    return { ok: false, status: 401, reason: "bad signature" };
  }
  if (!replay.check(`${a.deviceId}:${a.sig}`, now)) return { ok: false, status: 401, reason: "replayed request" };
  return { ok: true, deviceId: a.deviceId };
}

// ---------------------------------------------------------------------------------------------
// Pairing codes

export class PairingCode {
  readonly code: string;
  readonly expiresAt: number;
  private attempts = 0;
  private used = false;

  constructor(now = Date.now(), ttlMs = 5 * 60_000, readonly maxAttempts = 5) {
    // Unbiased 6-digit code from 32 random bits (rejection sampling).
    let n: number;
    do {
      const b = randomBytes(4);
      n = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    } while (n >= 4_294_000_000);
    this.code = String(n % 1_000_000).padStart(6, "0");
    this.expiresAt = now + ttlMs;
  }

  get active(): boolean {
    return !this.used && this.attempts < this.maxAttempts;
  }

  /** One-time check. Burns the code on success; locks it after too many wrong guesses. */
  consume(candidate: string, now = Date.now()): "ok" | "expired" | "wrong" | "locked" {
    if (this.used || this.attempts >= this.maxAttempts) return "locked";
    if (now > this.expiresAt) return "expired";
    this.attempts++;
    const a = utf8(String(candidate).padStart(6, "0").slice(0, 16));
    const b = utf8(this.code);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      this.used = true;
      return "ok";
    }
    return this.attempts >= this.maxAttempts ? "locked" : "wrong";
  }
}

// ---------------------------------------------------------------------------------------------
// QR payload

export interface PairingQr {
  hosts: string[];
  port: number;
  deviceId: string;
  fingerprint: string;
  code: string;
  name: string;
}

export function encodePairingQr(q: PairingQr): string {
  const params = new URLSearchParams({
    v: String(PROTOCOL_VERSION),
    h: q.hosts.join(","),
    p: String(q.port),
    id: q.deviceId,
    fp: q.fingerprint,
    c: q.code,
    n: q.name,
  });
  return `ptu://pair?${params.toString()}`;
}

export function decodePairingQr(s: string): PairingQr | null {
  const m = /^ptu:\/\/pair\?(.*)$/.exec(s.trim());
  if (!m) return null;
  const p = new URLSearchParams(m[1]);
  const port = Number(p.get("p"));
  const hosts = (p.get("h") ?? "").split(",").filter(Boolean);
  const deviceId = p.get("id") ?? "";
  const code = p.get("c") ?? "";
  if (!hosts.length || !(port > 0 && port < 65536) || !/^[0-9a-f]{16}$/.test(deviceId) || !/^\d{6}$/.test(code)) return null;
  return { hosts, port, deviceId, fingerprint: p.get("fp") ?? "", code, name: p.get("n") ?? "" };
}

// ---------------------------------------------------------------------------------------------
// Validation of untrusted JSON

export function isDeviceHello(x: unknown): x is DeviceHello {
  const d = x as DeviceHello;
  return (
    !!d &&
    typeof d.deviceId === "string" &&
    /^[0-9a-f]{16}$/.test(d.deviceId) &&
    typeof d.name === "string" &&
    d.name.length <= 100 &&
    ["ios", "mac", "windows", "linux", "extension"].includes(d.platform) &&
    typeof d.publicKey === "string" &&
    d.publicKey.length < 512
  );
}

export function isReviewEvent(x: unknown): x is ReviewEvent {
  const e = x as ReviewEvent;
  return (
    !!e &&
    typeof e.id === "string" &&
    e.id.length <= 64 &&
    typeof e.cardId === "string" &&
    typeof e.deckId === "string" &&
    [1, 2, 3, 4].includes(e.rating) &&
    Number.isFinite(e.at) &&
    Number.isFinite(e.answerShownAt) &&
    typeof e.deviceId === "string"
  );
}
