import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ledger, adoptTrust, authHeader, dayKey, fetchDeck, listDecks, pair, syncWith, utf8 } from "@ptu/core";
import { Agent } from "../src/main/agent.js";

let desktop: Ledger;
let agent: Agent;
let base: string;

beforeAll(async () => {
  desktop = await Ledger.create("Desk", "linux");
  agent = new Agent({
    ledger: desktop,
    decks: () => [{ id: "anki-1", name: "Deck", importedAt: 5, source: "x.apkg", cards: [], styles: {}, media: {} }],
    changed: () => undefined,
    log: () => undefined,
  });
  await agent.start(0);
  base = `http://127.0.0.1:${agent.port}`;
});

afterAll(async () => {
  await agent.stop();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("desktop linker (HTTP)", () => {
  it("refuses pairing when no code is showing, and locks the code after 5 wrong guesses", async () => {
    const phone = await Ledger.create("Phone", "ios");
    expect((await post("/v1/pair", { code: "123456", device: phone.hello() })).status).toBe(403);

    const p = await agent.startPairing();
    const wrong = p.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect((await post("/v1/pair", { code: wrong, device: phone.hello() })).status).toBe(403);
    const fifth = await post("/v1/pair", { code: wrong, device: phone.hello() });
    expect(((await fifth.json()) as { error: string }).error).toMatch(/too many attempts/);
    // Even the right code no longer works.
    expect((await post("/v1/pair", { code: p.code, device: phone.hello() })).status).toBe(403);
    expect(desktop.peer(phone.deviceId)).toBeUndefined();
  });

  it("rejects a device whose id doesn't match its key", async () => {
    const phone = await Ledger.create("Phone", "ios");
    const p = await agent.startPairing();
    const res = await post("/v1/pair", { code: p.code, device: { ...phone.hello(), deviceId: "0123456789abcdef" } });
    expect(res.status).toBe(400);
    expect((await post("/v1/pair", { code: p.code, device: phone.hello() })).status).toBe(200); // code not burned
    expect(desktop.peer("0123456789abcdef")).toBeUndefined();
  });

  it("pairs, then requires signed, non-replayed requests for everything else", async () => {
    const phone = await Ledger.create("Phone", "ios");
    const p = await agent.startPairing();
    const hello = await pair(phone, { host: "127.0.0.1", port: agent.port }, p.code);
    expect(hello.deviceId).toBe(desktop.deviceId);
    expect(desktop.peer(phone.deviceId)?.name).toBe("Phone");

    // Unsigned
    expect((await post("/v1/sync", { records: [], reviews: [], since: { records: 0, reviews: 0 } })).status).toBe(401);
    // Signed by a stranger
    const stranger = await Ledger.create("X", "ios");
    const body = JSON.stringify({ records: [], reviews: [], since: { records: 0, reviews: 0 } });
    const h = await authHeader(stranger.identity, "POST", "/v1/sync", utf8(body));
    expect((await post("/v1/sync", body, { authorization: h })).status).toBe(403);
    // Signed by the phone: works once, replay fails
    const ok = await authHeader(phone.identity, "POST", "/v1/sync", utf8(body));
    expect((await post("/v1/sync", body, { authorization: ok })).status).toBe(200);
    expect((await post("/v1/sync", body, { authorization: ok })).status).toBe(401);

    // Client helpers: trust, sync both ways, decks
    await adoptTrust(phone, { host: "127.0.0.1", port: agent.port });
    await phone.issue("proof", { cid: "c", day: dayKey(Date.now()), kind: "focus", at: Date.now(), detail: { sessions: 1, minutes: 25 } });
    await desktop.issue("emergency", { day: dayKey(Date.now()), until: Date.now() + 1000 });
    const r = await syncWith(phone, desktop.deviceId, { host: "127.0.0.1", port: agent.port });
    expect(r.received).toBeGreaterThanOrEqual(1);
    expect(desktop.records().some((x) => x.payload.iss === phone.deviceId)).toBe(true);
    expect(phone.records().some((x) => x.payload.typ === "emergency")).toBe(true);
    expect((await listDecks(phone, { host: "127.0.0.1", port: agent.port }))[0]?.name).toBe("Deck");
    expect((await fetchDeck(phone, { host: "127.0.0.1", port: agent.port }, "anki-1")).source).toBe("x.apkg");
  });

  it("caps request bodies", async () => {
    const res = await post("/v1/pair", "x".repeat(17 * 1024 * 1024)).catch(() => null);
    expect(res === null || res.status === 413).toBe(true);
  });
});
