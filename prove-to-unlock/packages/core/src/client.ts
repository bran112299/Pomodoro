// Client side of the linking protocol (used by the browser extension and tests; the iOS app has
// a Swift port of the same calls). Talks to a computer's linker over plain HTTP on the LAN or
// localhost; every call after pairing is signed with this device's key.

import type { Deck } from "./anki/apkg.js";
import { utf8 } from "./b64.js";
import type { Ledger } from "./ledger.js";
import {
  type DeckSummary,
  type DeviceHello,
  type InfoResponse,
  type PairResponse,
  type SyncResponse,
  type TrustResponse,
  authHeader,
  isDeviceHello,
} from "./protocol.js";

export class LinkError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface Endpoint {
  host: string;
  port: number;
}

function url(e: Endpoint, path: string): string {
  const host = e.host.includes(":") && !e.host.startsWith("[") ? `[${e.host}]` : e.host;
  return `http://${host}:${e.port}${path}`;
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new LinkError(body.error ?? `HTTP ${res.status}`, res.status);
  return body;
}

export async function getInfo(e: Endpoint, timeoutMs = 4000): Promise<InfoResponse> {
  return json<InfoResponse>(await fetch(url(e, "/v1/info"), { signal: AbortSignal.timeout(timeoutMs) }));
}

/** Pair with a computer showing `code`; on success both sides trust each other. */
export async function pair(ledger: Ledger, e: Endpoint, code: string, extra: { listen?: Endpoint[] } = {}): Promise<DeviceHello> {
  const body = JSON.stringify({
    code: code.trim(),
    device: ledger.hello(),
    ...(extra.listen?.length ? { listen: { hosts: extra.listen.map((l) => l.host), port: extra.listen[0]!.port } } : {}),
  });
  const res = await json<PairResponse>(await fetch(url(e, "/v1/pair"), { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(8000) }));
  if (!isDeviceHello(res.device)) throw new LinkError("the computer sent an invalid reply");
  await ledger.addPeer(res.device, { hosts: [e.host], port: e.port });
  return res.device;
}

async function signedFetch(ledger: Ledger, e: Endpoint, method: "GET" | "POST", path: string, bodyText = "", timeoutMs = 15000): Promise<Response> {
  const body = utf8(bodyText);
  return fetch(url(e, path), {
    method,
    headers: { "content-type": "application/json", authorization: await authHeader(ledger.identity, method, path, body) },
    body: method === "POST" ? bodyText : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Adopt every device the computer trusts (so their records verify here too). */
export async function adoptTrust(ledger: Ledger, e: Endpoint): Promise<number> {
  const res = await json<TrustResponse>(await signedFetch(ledger, e, "GET", "/v1/trust"));
  let added = 0;
  for (const d of res.devices ?? []) {
    if (!isDeviceHello(d) || d.deviceId === ledger.deviceId) continue;
    if (!ledger.peer(d.deviceId)) added++;
    await ledger.addPeer(d, ledger.peer(d.deviceId)?.hosts ? { hosts: ledger.peer(d.deviceId)!.hosts, port: ledger.peer(d.deviceId)!.port } : {});
  }
  return added;
}

/** One sync round-trip: push what they haven't seen, pull what we haven't seen. */
export async function syncWith(ledger: Ledger, peerId: string, e: Endpoint): Promise<{ received: number; sent: number }> {
  const req = ledger.syncRequestFor(peerId);
  const sentUpTo = ledger.seq;
  const res = await json<SyncResponse>(await signedFetch(ledger, e, "POST", "/v1/sync", JSON.stringify(req)));
  const before = ledger.seq;
  await ledger.applySyncResponse(peerId, sentUpTo, res);
  return { received: ledger.seq - before, sent: req.records.length + req.reviews.length };
}

export async function listDecks(ledger: Ledger, e: Endpoint): Promise<DeckSummary[]> {
  return (await json<{ decks: DeckSummary[] }>(await signedFetch(ledger, e, "GET", "/v1/decks"))).decks;
}

export async function fetchDeck(ledger: Ledger, e: Endpoint, id: string): Promise<Deck> {
  return json<Deck>(await signedFetch(ledger, e, "GET", `/v1/decks/${encodeURIComponent(id)}`, "", 60_000));
}
