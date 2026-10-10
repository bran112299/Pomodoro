import { describe, expect, it } from "vitest";
import {
  PairingCode,
  ReplayGuard,
  authHeader,
  b64ToBytes,
  b64urlToBytes,
  bytesToB64,
  bytesToB64url,
  createRecord,
  decodePairingQr,
  deviceIdFromPublicKey,
  encodePairingQr,
  exportIdentity,
  fingerprint,
  generateIdentity,
  importIdentity,
  parseRecordUnverified,
  utf8,
  verifyAuth,
  verifyRecord,
} from "../src/index.js";

describe("base64", () => {
  it("round-trips all lengths, standard and url-safe", () => {
    for (let n = 0; n < 70; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      expect(b64ToBytes(bytesToB64(b))).toEqual(b);
      expect(b64urlToBytes(bytesToB64url(b))).toEqual(b);
      expect(bytesToB64(b)).toBe(Buffer.from(b).toString("base64"));
    }
  });
  it("rejects garbage", () => {
    expect(() => b64ToBytes("ab$d")).toThrow();
  });
});

describe("identity", () => {
  it("device id is derived from the key and survives export/import", async () => {
    const id = await generateIdentity();
    expect(id.deviceId).toMatch(/^[0-9a-f]{16}$/);
    expect(await deviceIdFromPublicKey(id.publicKey)).toBe(id.deviceId);
    const again = await importIdentity(await exportIdentity(id));
    expect(again.deviceId).toBe(id.deviceId);
    expect(await fingerprint(id.publicKey)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  });
});

describe("signed records", () => {
  it("verifies, and rejects tampering, unknown issuers and future records", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    const trusted = new Map([[a.deviceId, a.publicKey]]);
    const now = Date.UTC(2026, 9, 10, 12);
    const r = await createRecord(a, "emergency", { day: "2026-10-10", until: now + 900_000 }, now);

    const ok = await verifyRecord(r.raw, trusted, now);
    expect(ok.ok).toBe(true);

    // Tamper with the payload: change "until".
    const payload = parseRecordUnverified(r.raw)!;
    (payload.body as { until: number }).until += 3600_000;
    const forged = bytesToB64url(utf8(JSON.stringify(payload))) + "." + r.raw.split(".")[1];
    expect(await verifyRecord(forged, trusted, now)).toEqual({ ok: false, reason: "bad-signature" });

    const fromB = await createRecord(b, "emergency", { day: "2026-10-10", until: now }, now);
    expect(await verifyRecord(fromB.raw, trusted, now)).toEqual({ ok: false, reason: "untrusted-issuer" });

    // Someone claiming to be A but signing with B's key.
    const spoofPayload = { ...fromB.payload, iss: a.deviceId };
    const spoofHead = bytesToB64url(utf8(JSON.stringify(spoofPayload)));
    expect(await verifyRecord(`${spoofHead}.${fromB.raw.split(".")[1]}`, trusted, now)).toEqual({ ok: false, reason: "bad-signature" });

    const future = await createRecord(a, "emergency", { day: "2026-10-10", until: now }, now + 3600_000);
    expect(await verifyRecord(future.raw, trusted, now)).toEqual({ ok: false, reason: "from-future" });

    expect((await verifyRecord("garbage", trusted, now)).ok).toBe(false);
    expect((await verifyRecord("a.b", trusted, now)).ok).toBe(false);
  });
});

describe("signed requests", () => {
  it("accepts a valid request once and rejects replay / wrong body / unpaired", async () => {
    const a = await generateIdentity();
    const stranger = await generateIdentity();
    const trusted = new Map([[a.deviceId, a.publicKey]]);
    const guard = new ReplayGuard();
    const now = Date.now();
    const body = utf8('{"x":1}');
    const h = await authHeader(a, "POST", "/v1/sync", body, now);

    expect(await verifyAuth(h, "POST", "/v1/sync", body, trusted, guard, now)).toEqual({ ok: true, deviceId: a.deviceId });
    expect((await verifyAuth(h, "POST", "/v1/sync", body, trusted, guard, now)).ok).toBe(false); // replay
    const h2 = await authHeader(a, "POST", "/v1/sync", body, now + 1);
    expect((await verifyAuth(h2, "POST", "/v1/sync", utf8('{"x":2}'), trusted, guard, now)).ok).toBe(false);
    expect((await verifyAuth(h2, "GET", "/v1/sync", body, trusted, guard, now)).ok).toBe(false);
    const h3 = await authHeader(a, "POST", "/v1/sync", body, now - 10 * 60_000);
    expect((await verifyAuth(h3, "POST", "/v1/sync", body, trusted, guard, now)).ok).toBe(false); // stale
    const hs = await authHeader(stranger, "POST", "/v1/sync", body, now);
    expect(await verifyAuth(hs, "POST", "/v1/sync", body, trusted, guard, now)).toMatchObject({ ok: false, status: 403 });
    expect((await verifyAuth(undefined, "POST", "/v1/sync", body, trusted, guard, now)).ok).toBe(false);
  });
});

describe("pairing codes", () => {
  it("is one-time, expires, and locks after too many attempts", () => {
    const now = 1_000_000;
    const c = new PairingCode(now);
    expect(c.code).toMatch(/^\d{6}$/);
    expect(c.consume(c.code, now + 301_000)).toBe("expired");
    const c2 = new PairingCode(now);
    expect(c2.consume(c2.code, now)).toBe("ok");
    expect(c2.consume(c2.code, now)).toBe("locked");
    const c3 = new PairingCode(now);
    const wrong = c3.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect(c3.consume(wrong, now)).toBe("wrong");
    expect(c3.consume(wrong, now)).toBe("locked");
    expect(c3.consume(c3.code, now)).toBe("locked");
  });

  it("QR payload round-trips and rejects junk", () => {
    const q = { hosts: ["192.168.1.20", "10.0.0.5"], port: 47123, deviceId: "0123456789abcdef", fingerprint: "AAAA-BBBB-CCCC-DDDD", code: "042137", name: "Brandon's Mac" };
    expect(decodePairingQr(encodePairingQr(q))).toEqual(q);
    expect(decodePairingQr("https://example.com")).toBeNull();
    expect(decodePairingQr("ptu://pair?h=1.2.3.4&p=99999&id=x&c=1")).toBeNull();
  });
});
