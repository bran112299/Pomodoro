// The local-network "linker": an HTTP server other devices talk to, mDNS advertisement and
// discovery, pairing, and the periodic sync loop with paired computers.
//
// No accounts, no cloud. Everything is authenticated with device keys (see @ptu/core protocol).

import http from "node:http";
import os from "node:os";
import { Bonjour, type Browser, type Service } from "bonjour-service";
import {
  type DeckSummary,
  type DeviceHello,
  type InfoResponse,
  type Ledger,
  MDNS_SERVICE_TYPE,
  PROTOCOL_VERSION,
  PairingCode,
  type PairRequest,
  type PairResponse,
  ReplayGuard,
  type SyncRequest,
  type SyncResponse,
  type TrustResponse,
  authHeader,
  deviceIdFromPublicKey,
  encodePairingQr,
  fingerprint,
  isDeviceHello,
  utf8,
  verifyAuth,
  type Deck,
} from "@ptu/core";

const MAX_BODY = 16 * 1024 * 1024;

export interface AgentDeps {
  ledger: Ledger;
  decks: () => Deck[];
  /** Called after anything changed (new records, new peer) so the app can persist + re-evaluate. */
  changed: (what: "records" | "peers") => void;
  log: (msg: string) => void;
}

export interface DiscoveredDevice {
  deviceId: string;
  name: string;
  fingerprint: string;
  hosts: string[];
  port: number;
  paired: boolean;
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(a.address);
    }
  }
  return out;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: http.IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "request too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

export class Agent {
  private server: http.Server | null = null;
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;
  private published: Service | null = null;
  private replay = new ReplayGuard();
  private pairing: PairingCode | null = null;
  private discovered = new Map<string, DiscoveredDevice>();
  private syncTimer: NodeJS.Timeout | null = null;
  private syncing = false;
  port = 0;

  constructor(private deps: AgentDeps) {}

  get ledger(): Ledger {
    return this.deps.ledger;
  }

  async start(preferredPort: number): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.port = await new Promise<number>((resolve, reject) => {
      const s = this.server!;
      const onError = (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && preferredPort !== 0) {
          s.removeListener("error", onError);
          s.listen(0, "0.0.0.0", () => resolve((s.address() as { port: number }).port));
        } else reject(e);
      };
      s.on("error", onError);
      s.listen(preferredPort, "0.0.0.0", () => {
        s.removeListener("error", onError);
        resolve((s.address() as { port: number }).port);
      });
    });
    this.deps.log(`linker listening on port ${this.port}`);
    await this.startMdns();
    this.syncTimer = setInterval(() => void this.syncAll(), 30_000);
    setTimeout(() => void this.syncAll(), 2000);
  }

  async stop(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.browser?.stop();
    await new Promise<void>((r) => (this.published ? this.published.stop?.(() => r()) ?? r() : r()));
    this.bonjour?.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private async startMdns(): Promise<void> {
    try {
      this.bonjour = new Bonjour();
      const fp = await fingerprint(this.ledger.hello().publicKey);
      this.published = this.bonjour.publish({
        name: `${this.ledger.name} (${this.ledger.deviceId.slice(0, 4)})`,
        type: MDNS_SERVICE_TYPE,
        port: this.port,
        txt: { id: this.ledger.deviceId, fp, v: String(PROTOCOL_VERSION) },
      });
      this.browser = this.bonjour.find({ type: MDNS_SERVICE_TYPE }, (svc) => this.onService(svc));
      this.browser.on("down", (svc: Service) => {
        const id = (svc.txt as Record<string, string> | undefined)?.id;
        if (id) this.discovered.delete(id);
      });
    } catch (e) {
      this.deps.log(`mDNS unavailable: ${(e as Error).message} (pair by entering an address instead)`);
    }
  }

  private onService(svc: Service): void {
    const txt = (svc.txt ?? {}) as Record<string, string>;
    const id = txt.id;
    if (!id || id === this.ledger.deviceId || !/^[0-9a-f]{16}$/.test(id)) return;
    const hosts = (svc.addresses ?? []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    const d: DiscoveredDevice = { deviceId: id, name: svc.name, fingerprint: txt.fp ?? "", hosts, port: svc.port, paired: !!this.ledger.peer(id) };
    this.discovered.set(id, d);
    // Keep paired computers' addresses fresh (DHCP changes).
    const peer = this.ledger.peer(id);
    if (peer && hosts.length && (peer.port !== svc.port || peer.hosts?.join() !== hosts.join())) {
      peer.hosts = hosts;
      peer.port = svc.port;
      this.deps.changed("peers");
    }
  }

  discoveredDevices(): DiscoveredDevice[] {
    return [...this.discovered.values()].map((d) => ({ ...d, paired: !!this.ledger.peer(d.deviceId) }));
  }

  // ------------------------------------------------------------------ pairing

  async startPairing(): Promise<{ code: string; qr: string; fingerprint: string; expiresAt: number; hosts: string[]; port: number }> {
    this.pairing = new PairingCode();
    const fp = await fingerprint(this.ledger.hello().publicKey);
    const hosts = lanAddresses();
    return {
      code: this.pairing.code,
      expiresAt: this.pairing.expiresAt,
      fingerprint: fp,
      hosts,
      port: this.port,
      qr: encodePairingQr({ hosts: hosts.length ? hosts : ["127.0.0.1"], port: this.port, deviceId: this.ledger.deviceId, fingerprint: fp, code: this.pairing.code, name: this.ledger.name }),
    };
  }

  cancelPairing(): void {
    this.pairing = null;
  }

  /** Pair with another computer that is showing a code. */
  async pairWith(hosts: string[], port: number, code: string): Promise<DeviceHello> {
    const pairReq: PairRequest = { code: code.trim(), device: this.ledger.hello(), listen: { hosts: lanAddresses(), port: this.port } };
    const body = JSON.stringify(pairReq);
    let lastErr: Error | null = null;
    for (const host of hosts) {
      try {
        const res = await fetch(`http://${host}:${port}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(6000) });
        const json = (await res.json().catch(() => ({}))) as PairResponse & { error?: string };
        if (!res.ok) throw new Error(json.error ?? `pairing failed (${res.status})`);
        if (!isDeviceHello(json.device)) throw new Error("the other device sent an invalid reply");
        await this.ledger.addPeer(json.device, { hosts, port });
        this.deps.changed("peers");
        void this.syncAll();
        return json.device;
      } catch (e) {
        lastErr = e as Error;
      }
    }
    throw lastErr ?? new Error("no address to try");
  }

  // ------------------------------------------------------------------ sync client

  /** Sync with every paired computer we have an address for. */
  async syncAll(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      for (const p of this.ledger.peers()) {
        if (!p.hosts?.length || !p.port) continue; // phones/extensions connect to us instead
        await this.syncWith(p.deviceId).catch((e) => this.deps.log(`sync with ${p.name} failed: ${(e as Error).message}`));
      }
    } finally {
      this.syncing = false;
    }
  }

  async syncWith(peerId: string): Promise<void> {
    const p = this.ledger.peer(peerId);
    if (!p?.hosts?.length || !p.port) return;
    const req = this.ledger.syncRequestFor(peerId);
    const sentUpTo = this.ledger.seq;
    const bodyText = JSON.stringify(req);
    const body = utf8(bodyText);
    let lastErr: Error | null = null;
    for (const host of p.hosts) {
      try {
        const res = await fetch(`http://${host}:${p.port}/v1/sync`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: await authHeader(this.ledger.identity, "POST", "/v1/sync", body) },
          body: bodyText,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as SyncResponse;
        const before = this.ledger.seq;
        await this.ledger.applySyncResponse(peerId, sentUpTo, json);
        this.deps.changed(this.ledger.seq !== before ? "records" : "peers");
        return;
      } catch (e) {
        lastErr = e as Error;
      }
    }
    throw lastErr ?? new Error("unreachable");
  }

  // ------------------------------------------------------------------ server

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Cache-Control", "no-store");
    const send = (status: number, obj: unknown) => {
      const s = JSON.stringify(obj);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) });
      res.end(s);
    };
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://x");
      const pathWithQuery = url.pathname + url.search;
      const body = req.method === "POST" ? await readBody(req) : new Uint8Array();

      if (req.method === "GET" && url.pathname === "/v1/info") {
        const hello = this.ledger.hello();
        const info: InfoResponse = { ...hello, protocol: PROTOCOL_VERSION, fingerprint: await fingerprint(hello.publicKey), pairing: !!this.pairing?.active };
        return send(200, info);
      }

      if (req.method === "POST" && url.pathname === "/v1/pair") {
        let parsed: { code?: unknown; device?: unknown; listen?: { hosts?: unknown; port?: unknown } };
        try {
          parsed = JSON.parse(Buffer.from(body).toString("utf8"));
        } catch {
          throw new HttpError(400, "invalid JSON");
        }
        if (!this.pairing) throw new HttpError(403, "this device isn't showing a pairing code");
        if (!isDeviceHello(parsed.device)) throw new HttpError(400, "invalid device");
        if ((await deviceIdFromPublicKey(parsed.device.publicKey).catch(() => "")) !== parsed.device.deviceId) {
          throw new HttpError(400, "device id doesn't match its key");
        }
        const result = this.pairing.consume(String(parsed.code ?? ""));
        if (result !== "ok") {
          if (result === "locked" || result === "expired") this.pairing = null;
          throw new HttpError(403, result === "wrong" ? "wrong code" : result === "expired" ? "code expired" : "too many attempts; start pairing again");
        }
        this.pairing = null;
        const remote = req.socket.remoteAddress?.replace(/^::ffff:/, "");
        const isComputer = parsed.device.platform === "mac" || parsed.device.platform === "windows" || parsed.device.platform === "linux";
        const discovered = this.discovered.get(parsed.device.deviceId);
        const listen = parsed.listen;
        const listenHosts = Array.isArray(listen?.hosts) ? listen.hosts.filter((h): h is string => typeof h === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(h)).slice(0, 8) : [];
        const listenPort = typeof listen?.port === "number" && listen.port > 0 && listen.port < 65536 ? listen.port : undefined;
        // Prefer the address the request actually came from; it's known to be reachable.
        const hosts = [...new Set([...(remote ? [remote] : []), ...listenHosts, ...(discovered?.hosts ?? [])])];
        await this.ledger.addPeer(parsed.device, isComputer ? { hosts, port: listenPort ?? discovered?.port ?? this.port } : {});
        this.deps.changed("peers");
        this.deps.log(`linked with ${parsed.device.name} (${parsed.device.platform})`);
        const out: PairResponse = { device: this.ledger.hello() };
        return send(200, out);
      }

      // Everything below requires a signed request from a paired device.
      const auth = await verifyAuth(req.headers.authorization, req.method ?? "GET", pathWithQuery, body, this.ledger.trustedKeys(), this.replay);
      if (!auth.ok) throw new HttpError(auth.status, auth.reason);
      if (auth.deviceId === this.ledger.deviceId) throw new HttpError(403, "own key");

      if (req.method === "POST" && url.pathname === "/v1/sync") {
        let sreq: SyncRequest;
        try {
          sreq = JSON.parse(Buffer.from(body).toString("utf8")) as SyncRequest;
        } catch {
          throw new HttpError(400, "invalid JSON");
        }
        const before = this.ledger.seq;
        const out = await this.ledger.handleSync(auth.deviceId, sreq);
        this.deps.changed(this.ledger.seq !== before ? "records" : "peers");
        return send(200, out);
      }

      if (req.method === "GET" && url.pathname === "/v1/trust") {
        const devices: DeviceHello[] = [this.ledger.hello(), ...this.ledger.peers().map((p) => ({ deviceId: p.deviceId, name: p.name, platform: p.platform, publicKey: p.publicKey }))];
        const out: TrustResponse = { devices };
        return send(200, out);
      }

      if (req.method === "GET" && url.pathname === "/v1/decks") {
        const out: DeckSummary[] = this.deps.decks().map((d) => ({ id: d.id, name: d.name, cards: d.cards.length, importedAt: d.importedAt }));
        return send(200, { decks: out });
      }

      const deckMatch = /^\/v1\/decks\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && deckMatch) {
        const id = decodeURIComponent(deckMatch[1]!);
        const deck = this.deps.decks().find((d) => d.id === id);
        if (!deck) throw new HttpError(404, "no such deck");
        return send(200, deck);
      }

      throw new HttpError(404, "not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) this.deps.log(`linker error: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) send(status, { error: (e as Error).message });
    }
  }
}
