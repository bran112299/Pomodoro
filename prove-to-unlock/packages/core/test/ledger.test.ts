import { describe, expect, it } from "vitest";
import { Ledger, createRecord, evaluate, generateIdentity } from "../src/index.js";

async function pairedPair() {
  const phone = await Ledger.create("Phone", "ios");
  const mac = await Ledger.create("Mac", "mac");
  await phone.addPeer(mac.hello());
  await mac.addPeer(phone.hello());
  return { phone, mac };
}

async function sync(from: Ledger, to: Ledger) {
  const req = from.syncRequestFor(to.deviceId);
  const sentUpTo = from.seq;
  const res = await to.handleSync(from.deviceId, JSON.parse(JSON.stringify(req)));
  await from.applySyncResponse(to.deviceId, sentUpTo, JSON.parse(JSON.stringify(res)));
  return res;
}

describe("ledger sync", () => {
  it("exchanges records and reviews both ways, incrementally, without duplicates", async () => {
    const { phone, mac } = await pairedPair();
    await phone.issue("emergency", { day: "2026-10-10", until: Date.now() + 1000 });
    mac.addReviews([{ id: "r1", cardId: "c1", deckId: "d1", rating: 3, at: 1, answerShownAt: 0, deviceId: mac.deviceId }]);
    await mac.updateConfig((c) => {
      c.essentials.sites.push("example.org");
    });

    await sync(phone, mac);
    expect(mac.records().length).toBe(2);
    expect(phone.records().length).toBe(2);
    expect(phone.reviews().length).toBe(1);
    expect(phone.config().essentials.sites).toContain("example.org");

    // Second round: nothing new flows.
    const res = await sync(phone, mac);
    expect(res.records.length).toBe(0);
    expect(res.reviews.length).toBe(0);
    expect(mac.records().length).toBe(2);

    // Persist + reload keeps everything.
    const reloaded = await Ledger.load(JSON.parse(JSON.stringify(mac.toJSON())));
    expect(reloaded.records().length).toBe(2);
    expect(reloaded.deviceId).toBe(mac.deviceId);
  });

  it("rejects records from unpaired devices, and accepts them after pairing", async () => {
    const { mac } = await pairedPair();
    const stranger = await Ledger.create("Stranger", "windows");
    const rec = await stranger.issue("emergency", { day: "2026-10-10", until: Date.now() + 1000 });
    const r = await mac.addRecords([rec.raw]);
    expect(r).toEqual({ accepted: 0, rejected: 1 });
    expect(mac.records().length).toBe(0);
  });

  it("a relay can't forge: records keep their original signer", async () => {
    const { phone, mac } = await pairedPair();
    const pc = await Ledger.create("PC", "windows");
    await mac.addPeer(pc.hello());
    await pc.addPeer(mac.hello());
    await pc.addPeer(phone.hello());
    await phone.issue("emergency", { day: "2026-10-10", until: Date.now() + 60_000 });
    await sync(phone, mac);
    await sync(pc, mac); // pc gets phone's record relayed via mac
    const got = pc.records().find((r) => r.payload.typ === "emergency");
    expect(got?.payload.iss).toBe(phone.deviceId);
  });

  it("refuses to pair a device whose id doesn't match its key", async () => {
    const mac = await Ledger.create("Mac", "mac");
    const other = await generateIdentity();
    await expect(mac.addPeer({ deviceId: "0000000000000000", name: "x", platform: "ios", publicKey: other.publicKey })).rejects.toThrow();
  });

  it("latest config wins by revision", async () => {
    const { phone, mac } = await pairedPair();
    await phone.updateConfig((c) => void (c.policy.emergencyMinutes = 20));
    await sync(phone, mac);
    await mac.updateConfig((c) => void (c.policy.emergencyMinutes = 30));
    await sync(phone, mac);
    expect(phone.config().policy.emergencyMinutes).toBe(30);
    expect(phone.config().rev).toBe(2);
  });

  it("drops malformed bodies even from trusted devices", async () => {
    const { phone, mac } = await pairedPair();
    const bad = await createRecord(phone.identity, "unlock", { nope: true } as never);
    expect(await mac.addRecords([bad.raw])).toEqual({ accepted: 0, rejected: 1 });
    // And the engine never sees it.
    expect(evaluate({ config: mac.config(), records: mac.records(), now: Date.now() }).locked).toBe(false);
  });
});
