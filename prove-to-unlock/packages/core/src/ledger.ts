// A device's local state: identity, paired devices, every record and review event it knows,
// with monotonically increasing sequence numbers so peers can sync incrementally.
//
// Pure in-memory logic; the host (Electron main process, extension service worker) persists
// `toJSON()` after changes and restores with `Ledger.load()`.

import { deviceIdFromPublicKey, exportIdentity, generateIdentity, type Identity, importIdentity, type StoredIdentity } from "./crypto.js";
import type { ReviewEvent } from "./fsrs.js";
import { type DeviceHello, isReviewEvent, type Platform, type SyncCursor, type SyncRequest, type SyncResponse } from "./protocol.js";
import { createRecord, type RecordBodyMap, type RecordType, type SignedRecord, verifyRecord } from "./records.js";
import { type Config, DEFAULT_ESSENTIALS, DEFAULT_POLICY } from "./types.js";

export interface PeerInfo extends DeviceHello {
  addedAt: number;
  lastSeenAt?: number;
  /** Last known LAN addresses (desktop peers). */
  hosts?: string[];
  port?: number;
  /** Highest local seq already pushed to this peer. */
  pushed: SyncCursor;
  /** Peer's cursor: what we've already pulled from them. */
  pulled: SyncCursor;
}

interface StoredRecord {
  seq: number;
  raw: string;
  receivedAt: number;
}

interface StoredReview {
  seq: number;
  event: ReviewEvent;
}

export interface LedgerData {
  version: 1;
  identity: StoredIdentity;
  name: string;
  platform: Platform;
  peers: PeerInfo[];
  records: StoredRecord[];
  reviews: StoredReview[];
  seq: number;
}

export function defaultConfig(now = 0): Config {
  return {
    rev: 0,
    updatedAt: now,
    commitments: [],
    places: [],
    excused: [],
    policy: { ...DEFAULT_POLICY },
    essentials: { apps: [...DEFAULT_ESSENTIALS.apps], sites: [...DEFAULT_ESSENTIALS.sites] },
  };
}

function bodyLooksValid(typ: RecordType, b: Record<string, unknown>): boolean {
  const str = (k: string) => typeof b[k] === "string";
  const num = (k: string) => typeof b[k] === "number" && Number.isFinite(b[k]);
  switch (typ) {
    case "proof":
      return str("cid") && str("day") && str("kind") && num("at") && typeof b.detail === "object" && b.detail !== null;
    case "unlock":
      return str("cid") && str("day") && num("until") && Array.isArray(b.proofIds);
    case "emergency":
      return str("day") && num("until");
    case "status":
      return str("cid") && str("day") && (b.region === "in" || b.region === "away");
    case "config":
      return num("rev") && Array.isArray(b.commitments) && Array.isArray(b.places) && typeof b.policy === "object";
  }
}

export class Ledger {
  private verifiedCache: SignedRecord[] | null = null;
  private recordIds = new Set<string>();
  private reviewIds = new Set<string>();
  private parsed = new Map<string, SignedRecord>(); // raw -> parsed (trusted at insert time)

  private constructor(
    readonly identity: Identity,
    private data: LedgerData,
  ) {}

  static async create(name: string, platform: Platform): Promise<Ledger> {
    const identity = await generateIdentity();
    const data: LedgerData = { version: 1, identity: await exportIdentity(identity), name, platform, peers: [], records: [], reviews: [], seq: 0 };
    return new Ledger(identity, data);
  }

  static async load(data: LedgerData): Promise<Ledger> {
    if (data.version !== 1) throw new Error(`unsupported ledger version ${data.version}`);
    const identity = await importIdentity(data.identity);
    const l = new Ledger(identity, data);
    const trusted = l.trustedKeys();
    // Re-verify stored records on load (cheap, and protects against a tampered file).
    const keep: StoredRecord[] = [];
    for (const r of data.records) {
      const v = await verifyRecord(r.raw, trusted, Number.MAX_SAFE_INTEGER);
      if (v.ok) {
        l.parsed.set(r.raw, v.record);
        l.recordIds.add(v.record.payload.id);
        keep.push(r);
      } else if (v.reason === "untrusted-issuer") {
        keep.push(r); // issuer was unpaired; keep in case it is re-paired
      }
    }
    data.records = keep;
    for (const r of data.reviews) l.reviewIds.add(r.event.id);
    return l;
  }

  toJSON(): LedgerData {
    return this.data;
  }

  get deviceId(): string {
    return this.identity.deviceId;
  }
  get name(): string {
    return this.data.name;
  }
  set name(v: string) {
    this.data.name = v.slice(0, 100);
  }
  get platform(): Platform {
    return this.data.platform;
  }
  get seq(): number {
    return this.data.seq;
  }

  hello(): DeviceHello {
    return { deviceId: this.deviceId, name: this.data.name, platform: this.data.platform, publicKey: this.identity.publicKey };
  }

  // ------------------------------------------------------------------ peers / trust

  peers(): readonly PeerInfo[] {
    return this.data.peers;
  }

  peer(deviceId: string): PeerInfo | undefined {
    return this.data.peers.find((p) => p.deviceId === deviceId);
  }

  trustedKeys(): Map<string, string> {
    const m = new Map<string, string>([[this.deviceId, this.identity.publicKey]]);
    for (const p of this.data.peers) m.set(p.deviceId, p.publicKey);
    return m;
  }

  /** Add or update a paired device. The device id must match its public key. */
  async addPeer(hello: DeviceHello, extra: Partial<Pick<PeerInfo, "hosts" | "port">> = {}, now = Date.now()): Promise<PeerInfo> {
    if ((await deviceIdFromPublicKey(hello.publicKey)) !== hello.deviceId) throw new Error("device id doesn't match its key");
    if (hello.deviceId === this.deviceId) throw new Error("can't pair a device with itself");
    const existing = this.peer(hello.deviceId);
    if (existing) {
      Object.assign(existing, { name: hello.name, platform: hello.platform, ...extra, lastSeenAt: now });
      this.verifiedCache = null;
      return existing;
    }
    const p: PeerInfo = { ...hello, ...extra, addedAt: now, lastSeenAt: now, pushed: { records: 0, reviews: 0 }, pulled: { records: 0, reviews: 0 } };
    this.data.peers.push(p);
    this.verifiedCache = null;
    // Records that arrived via relays before pairing are now trusted.
    await this.reverifyUntrusted();
    return p;
  }

  removePeer(deviceId: string): void {
    this.data.peers = this.data.peers.filter((p) => p.deviceId !== deviceId);
    this.verifiedCache = null;
  }

  private async reverifyUntrusted(): Promise<void> {
    const trusted = this.trustedKeys();
    for (const r of this.data.records) {
      if (this.parsed.has(r.raw)) continue;
      const v = await verifyRecord(r.raw, trusted, Number.MAX_SAFE_INTEGER);
      if (v.ok) {
        this.parsed.set(r.raw, v.record);
        this.recordIds.add(v.record.payload.id);
      }
    }
  }

  // ------------------------------------------------------------------ records

  /** All records from currently trusted devices. */
  records(): SignedRecord[] {
    if (!this.verifiedCache) {
      const trusted = this.trustedKeys();
      this.verifiedCache = this.data.records
        .map((r) => this.parsed.get(r.raw))
        .filter((r): r is SignedRecord => !!r && trusted.has(r.payload.iss));
    }
    return this.verifiedCache;
  }

  async issue<T extends RecordType>(typ: T, body: RecordBodyMap[T], now = Date.now()): Promise<SignedRecord<T>> {
    const rec = await createRecord(this.identity, typ, body, now);
    this.insert(rec, now);
    return rec;
  }

  private insert(rec: SignedRecord, now: number): void {
    this.data.seq++;
    this.data.records.push({ seq: this.data.seq, raw: rec.raw, receivedAt: now });
    this.parsed.set(rec.raw, rec);
    this.recordIds.add(rec.payload.id);
    this.verifiedCache = null;
  }

  /** Add records received from a peer. Unknown issuers are kept (unverified) for later pairing. */
  async addRecords(raws: readonly unknown[], now = Date.now()): Promise<{ accepted: number; rejected: number }> {
    const trusted = this.trustedKeys();
    let accepted = 0;
    let rejected = 0;
    for (const raw of raws.slice(0, 5000)) {
      if (typeof raw !== "string") {
        rejected++;
        continue;
      }
      const v = await verifyRecord(raw, trusted, now);
      if (!v.ok) {
        rejected++;
        continue;
      }
      if (this.recordIds.has(v.record.payload.id)) continue;
      if (!bodyLooksValid(v.record.payload.typ, v.record.payload.body as unknown as Record<string, unknown>)) {
        rejected++;
        continue;
      }
      this.insert(v.record, now);
      accepted++;
    }
    return { accepted, rejected };
  }

  // ------------------------------------------------------------------ reviews

  reviews(): ReviewEvent[] {
    return this.data.reviews.map((r) => r.event);
  }

  addReviews(events: readonly unknown[]): number {
    let n = 0;
    for (const e of events.slice(0, 50_000)) {
      if (!isReviewEvent(e) || this.reviewIds.has(e.id)) continue;
      this.data.seq++;
      const clean: ReviewEvent = { id: e.id, cardId: e.cardId, deckId: e.deckId, rating: e.rating, at: e.at, answerShownAt: e.answerShownAt, deviceId: e.deviceId };
      this.data.reviews.push({ seq: this.data.seq, event: clean });
      this.reviewIds.add(e.id);
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ config

  config(): Config {
    let best: SignedRecord | undefined;
    for (const r of this.records()) {
      if (r.payload.typ !== "config") continue;
      const b = r.payload.body as Config;
      const cur = best?.payload.body as Config | undefined;
      if (
        !cur ||
        b.rev > cur.rev ||
        (b.rev === cur.rev && (b.updatedAt > cur.updatedAt || (b.updatedAt === cur.updatedAt && r.payload.id > best!.payload.id)))
      ) {
        best = r;
      }
    }
    const base = defaultConfig();
    if (!best) return base;
    const c = best.payload.body as Config;
    // Fill fields added in later versions so older records stay usable.
    return {
      ...base,
      ...c,
      policy: { ...base.policy, ...c.policy },
      essentials: { ...base.essentials, ...c.essentials },
      excused: c.excused ?? [],
      places: c.places ?? [],
    };
  }

  async updateConfig(mutate: (c: Config) => Config | void, now = Date.now()): Promise<Config> {
    const cur = structuredClone(this.config());
    const next = mutate(cur) ?? cur;
    next.rev = this.config().rev + 1;
    next.updatedAt = now;
    await this.issue("config", next, now);
    return next;
  }

  // ------------------------------------------------------------------ sync

  /** Build the request we send to `peer` (everything they haven't been sent yet). */
  syncRequestFor(peerId: string): SyncRequest {
    const p = this.peer(peerId);
    if (!p) throw new Error("unknown peer");
    return {
      records: this.data.records.filter((r) => r.seq > p.pushed.records).map((r) => r.raw),
      reviews: this.data.reviews.filter((r) => r.seq > p.pushed.reviews).map((r) => r.event),
      since: p.pulled,
    };
  }

  /** After a successful sync round-trip with `peer`. */
  async applySyncResponse(peerId: string, sentUpTo: number, res: SyncResponse, now = Date.now()): Promise<void> {
    const p = this.peer(peerId);
    if (!p) throw new Error("unknown peer");
    await this.addRecords(res.records, now);
    this.addReviews(res.reviews);
    p.pushed = { records: sentUpTo, reviews: sentUpTo };
    p.pulled = { records: Math.max(p.pulled.records, res.cursor.records), reviews: Math.max(p.pulled.reviews, res.cursor.reviews) };
    p.lastSeenAt = now;
  }

  /** Handle an incoming sync request from a paired device. */
  async handleSync(fromPeer: string, req: SyncRequest, now = Date.now()): Promise<SyncResponse> {
    const p = this.peer(fromPeer);
    if (!p) throw new Error("unknown peer");
    const incoming = new Set(Array.isArray(req.records) ? req.records : []);
    const { accepted, rejected } = await this.addRecords([...incoming], now);
    const incomingReviews = new Set((Array.isArray(req.reviews) ? req.reviews : []).map((e) => (e as ReviewEvent)?.id));
    this.addReviews(Array.isArray(req.reviews) ? req.reviews : []);
    const since = req.since ?? { records: 0, reviews: 0 };
    p.lastSeenAt = now;
    return {
      records: this.data.records.filter((r) => r.seq > (since.records ?? 0) && !incoming.has(r.raw)).map((r) => r.raw),
      reviews: this.data.reviews.filter((r) => r.seq > (since.reviews ?? 0) && !incomingReviews.has(r.event.id)).map((r) => r.event),
      cursor: { records: this.data.seq, reviews: this.data.seq },
      accepted,
      rejected,
    };
  }
}
