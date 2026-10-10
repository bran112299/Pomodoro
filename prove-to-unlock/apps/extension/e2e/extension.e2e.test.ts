// End-to-end: load the built extension into real Chromium, link it to a desktop linker (the same
// Agent class the desktop app runs, here in-process), and check blocking/unblocking of real page
// loads, proof sync, and the Esc failsafe. Needs a display (xvfb-run in CI).

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type Page, type Worker, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ledger, dayKey } from "@ptu/core";
import { Agent } from "../../desktop/src/main/agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.join(here, "..", "dist", "chrome");

function chromiumPath(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root)) {
    if (!d.startsWith("chromium-")) continue;
    const p = path.join(root, d, "chrome-linux", "chrome");
    if (existsSync(p)) return p;
  }
  return undefined;
}

let ctx: BrowserContext;
let sw: Worker;
let extId: string;
let desktop: Ledger;
let agent: Agent;
let site: http.Server;
let siteUrl: string;
let userDir: string;

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v)?.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 300));
    v = await fn();
  }
  return v;
}

async function extState(page: Page) {
  return page.evaluate(() => chrome.runtime.sendMessage({ type: "getState" }).then((r: { value: { lock: { locked: boolean } } }) => r.value));
}

async function visit(page: Page, url: string): Promise<string> {
  await page.goto(url).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  return page.url();
}

beforeAll(async () => {
  // A local "distracting website" (127.0.0.2 so it isn't treated as localhost).
  site = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html" });
    r.end("<title>Distracting site</title><h1>scroll forever</h1>");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.2", r));
  siteUrl = `http://127.0.0.2:${(site.address() as { port: number }).port}/`;

  desktop = await Ledger.create("Test Desktop", "linux");
  const start = Math.max(0, new Date().getHours() - 1);
  await desktop.updateConfig((c) => {
    c.commitments = [{ id: "focus", title: "Focus first", enabled: true, days: [0, 1, 2, 3, 4, 5, 6], window: { start: `${String(start).padStart(2, "0")}:00`, end: "24:00" }, requirements: [{ kind: "focus", sessions: 1 }], require: "all", createdAt: 0 }];
  });
  agent = new Agent({ ledger: desktop, decks: () => [], changed: () => undefined, log: () => undefined });
  await agent.start(0);

  userDir = mkdtempSync(path.join(os.tmpdir(), "ptu-ext-"));
  ctx = await chromium.launchPersistentContext(userDir, {
    headless: false,
    executablePath: chromiumPath(),
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-proxy-server"],
  });
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  extId = new URL(sw.url()).host;
});

afterAll(async () => {
  await ctx?.close().catch(() => undefined);
  await agent?.stop().catch(() => undefined);
  site?.close();
  rmSync(userDir, { recursive: true, force: true });
});

describe("browser extension", () => {
  it("is unlocked before linking (no commitments of its own)", async () => {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    expect((await extState(page)).lock.locked).toBe(false);
    expect(await visit(page, siteUrl)).toBe(siteUrl);
    await page.close();
  });

  it("links to the desktop app with the pairing code and starts blocking distracting sites", async () => {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    const p = await agent.startPairing();
    await page.fill("input[placeholder='6-digit code']", p.code);
    await page.fill("input[type=number]", String(agent.port));
    await page.click("text=Link");
    await page.waitForSelector("text=Linked with Test Desktop");
    expect(desktop.peers().map((x) => x.platform)).toContain("extension");

    await waitFor(() => extState(page), (s) => s.lock.locked);
    const blocked = await visit(page, siteUrl);
    expect(blocked).toBe(`chrome-extension://${extId}/lock.html`);
    await page.waitForSelector("text=This site is blocked for now");
    await page.waitForSelector("text=Focus first");
    if (process.env.SCREENSHOTS) await page.screenshot({ path: path.join(here, "..", "..", "..", "docs", "screenshots", "extension-blocked.png") });
    await page.close();
  });

  it("unblocks when a proof made on another device syncs in", async () => {
    await desktop.issue("proof", { cid: "focus", day: dayKey(Date.now()), kind: "focus", at: Date.now(), detail: { sessions: 1, minutes: 25 } });
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "syncNow" }));
    await waitFor(() => extState(page), (s) => !s.lock.locked);
    expect(await visit(page, siteUrl)).toBe(siteUrl);
    await page.close();
  });

  it("holding Esc on the lock page is an emergency unlock that syncs back to the desktop", async () => {
    // New commitment on the desktop → the browser locks again.
    await desktop.updateConfig((c) => {
      c.commitments = [...c.commitments, { ...c.commitments[0]!, id: "second", title: "Second" }];
    });
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "syncNow" }));
    await waitFor(() => extState(page), (s) => s.lock.locked);
    expect(await visit(page, siteUrl)).toContain("lock.html");
    await page.waitForSelector("text=Emergency");
    await page.keyboard.down("Escape");
    await new Promise((r) => setTimeout(r, 3400));
    await page.keyboard.up("Escape");
    await waitFor(() => extState(page), (s) => !s.lock.locked);
    await waitFor(async () => desktop.records().some((r) => r.payload.typ === "emergency"), (v) => v, 30000);
    expect(await visit(page, siteUrl)).toBe(siteUrl);
  });
});
