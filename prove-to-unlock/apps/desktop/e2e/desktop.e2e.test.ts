// End-to-end: launch the real Electron app (test mode), link a simulated phone over the LAN
// protocol, and check that a proof from the phone unlocks the computer, and that the Esc-hold
// failsafe works. Run with `npm run test:e2e` (needs a display; CI uses xvfb-run).

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, type Page, _electron as electron } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Commitment, Ledger, type PairResponse, type SyncResponse, authHeader, dayKey, defaultConfig, utf8 } from "@ptu/core";
import type { UiState } from "../src/shared/api.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const shots = process.env.SCREENSHOTS ? path.join(here, "..", "..", "..", "docs", "screenshots") : null;

let app: ElectronApplication;
let dash: Page;
let dataDir: string;

const state = (): Promise<UiState> => dash.evaluate(() => window.ptu.getState());

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 250));
    v = await fn();
  }
  return v;
}

async function lockWindow(): Promise<Page> {
  return waitFor(
    async () => app.windows().find((w) => w.url().includes("lock.html")) ?? null,
    (w) => !!w,
  ) as Promise<Page>;
}

function commitment(id: string, title: string): Commitment {
  const d = new Date();
  const start = Math.max(0, d.getHours() - 1);
  return {
    id,
    title,
    enabled: true,
    days: [0, 1, 2, 3, 4, 5, 6],
    window: { start: `${String(start).padStart(2, "0")}:00`, end: "24:00" },
    requirements: [{ kind: "focus", sessions: 1, minutesPerSession: 25 }],
    require: "all",
    createdAt: Date.now(),
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "ptu-e2e-"));
  app = await electron.launch({
    executablePath: require("electron") as unknown as string,
    args: [path.join(here, "..", "dist", "main", "main.cjs"), "--no-sandbox"],
    env: { ...process.env, PTU_USER_DATA: dataDir, ELECTRON_ENABLE_LOGGING: "1" },
  });
  dash = await app.firstWindow();
  await dash.waitForSelector("text=Prove to Unlock");
  if (shots) mkdirSync(shots, { recursive: true });
});

afterAll(async () => {
  // The app refuses to quit while locked (by design), so stop the process directly.
  app?.process().kill("SIGKILL");
  rmSync(dataDir, { recursive: true, force: true });
});

describe("desktop app", () => {
  it("starts unlocked in test mode with a fresh identity", async () => {
    const s = await state();
    expect(s.settings.testMode).toBe(true);
    expect(s.lock.locked).toBe(false);
    expect(s.device.id).toMatch(/^[0-9a-f]{16}$/);
    expect(s.device.port).toBeGreaterThan(0);
    if (shots) await dash.screenshot({ path: path.join(shots!, "desktop-onboarding.png") });
  });

  it("locks when a commitment is active, and a proof from a linked phone unlocks it", async () => {
    const cfg = { ...defaultConfig(), ...(await state()).config, commitments: [commitment("gym", "Go to the gym")] };
    await dash.evaluate((c) => window.ptu.updateConfig(c), cfg);
    await waitFor(state, (s) => s.lock.locked);
    const lock = await lockWindow();
    await lock.waitForSelector("text=Locked to essentials");
    await lock.waitForSelector("text=TEST MODE");
    if (shots) await lock.screenshot({ path: path.join(shots!, "desktop-lock-screen.png") });

    // A simulated phone pairs with the code the computer shows.
    const phone = await Ledger.create("Test iPhone", "ios");
    const pairing = await dash.evaluate(() => window.ptu.startPairing());
    const base = `http://127.0.0.1:${pairing.port}`;
    const wrong = await fetch(`${base}/v1/pair`, { method: "POST", body: JSON.stringify({ code: pairing.code === "000000" ? "111111" : "000000", device: phone.hello() }) });
    expect(wrong.status).toBe(403);
    const res = await fetch(`${base}/v1/pair`, { method: "POST", body: JSON.stringify({ code: pairing.code, device: phone.hello() }) });
    expect(res.status).toBe(200);
    const { device } = (await res.json()) as PairResponse;
    await phone.addPeer(device);
    expect((await state()).peers.map((p) => p.name)).toContain("Test iPhone");

    // Unsigned / unpaired requests are refused.
    expect((await fetch(`${base}/v1/sync`, { method: "POST", body: "{}" })).status).toBe(401);

    // The phone proves the commitment and syncs.
    await phone.issue("proof", { cid: "gym", day: dayKey(Date.now()), kind: "focus", at: Date.now(), detail: { sessions: 1, minutes: 25 } });
    const body = JSON.stringify(phone.syncRequestFor(device.deviceId));
    const sync = await fetch(`${base}/v1/sync`, { method: "POST", headers: { authorization: await authHeader(phone.identity, "POST", "/v1/sync", utf8(body)) }, body });
    expect(sync.status).toBe(200);
    const sres = (await sync.json()) as SyncResponse;
    expect(sres.accepted).toBe(1);
    // The phone receives the desktop's config record in return.
    await phone.applySyncResponse(device.deviceId, phone.seq, sres);
    expect(phone.config().commitments.map((c) => c.id)).toEqual(["gym"]);

    const s = await waitFor(state, (x) => !x.lock.locked);
    expect(s.lock.commitments[0]!.unlockedBy).toBe("proven");
    await waitFor(async () => app.windows().some((w) => w.url().includes("lock.html")), (open) => !open);
  });

  it("won't let you edit a locked commitment, but holding Esc for 3 s always unlocks", async () => {
    const before = (await state()).config;
    await dash.evaluate((c) => window.ptu.updateConfig(c), { ...before, commitments: [...before.commitments, commitment("anki", "Study first")] });
    await waitFor(state, (s) => s.lock.locked);

    // In test mode editing is allowed; turn test mode off to check the real rules.
    await dash.evaluate(() => window.ptu.updateSettings({ testMode: false }));
    const cfg = (await state()).config;
    const err = await dash.evaluate((c) => window.ptu.updateConfig(c).then(() => "saved", (e: Error) => e.message), {
      ...cfg,
      commitments: cfg.commitments.filter((c) => c.id !== "anki"),
    });
    expect(err).toMatch(/locked right now/);
    const err2 = await dash.evaluate(() => window.ptu.updateSettings({ testMode: true }).then(() => "saved", (e: Error) => e.message));
    expect(err2).toMatch(/can't be turned on while locked/);

    const lock = await lockWindow();
    await lock.bringToFront();
    await lock.waitForSelector("text=Emergency");
    if (shots) await lock.screenshot({ path: path.join(shots!, "desktop-lock-real.png") });
    await lock.keyboard.down("Escape");
    // Released early = nothing happens.
    await new Promise((r) => setTimeout(r, 1500));
    expect((await state()).lock.locked).toBe(true);
    await lock.keyboard.up("Escape");
    await lock.keyboard.down("Escape");
    // Held for 3 s = emergency unlock; the lock window closes by itself.
    await new Promise((r) => setTimeout(r, 3400));
    await lock.keyboard.up("Escape").catch(() => undefined);
    const s = await waitFor(state, (x) => !x.lock.locked);
    expect(s.lock.emergencyUntil).toBeGreaterThan(Date.now());
    expect(s.log.some((l) => l.msg.includes("emergency unlock"))).toBe(true);
  });
});
