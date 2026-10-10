// Background worker: holds this browser's identity + ledger, syncs with the desktop app over
// localhost, evaluates the commitment rules and blocks non-essential sites while locked.
//
// Works standalone too (no desktop app): you can study Anki decks or do focus sessions in the
// lock page to unlock, and hold Esc for an emergency unlock.

import {
  type Config,
  type Deck,
  Ledger,
  type LedgerData,
  type LockState,
  adoptTrust,
  configChangeBlockedWhileLocked,
  dayKey,
  evaluate,
  fetchDeck,
  isReviewEvent,
  issueAnkiProofs,
  issueFocusProof,
  listDecks,
  pair,
  syncWith,
} from "@ptu/core";
import { type ExtState, type Request, type Response, ext } from "./messages.js";

const api = ext();
const DEFAULT_NEW_PER_DAY = 20;

interface LinkInfo {
  peerId: string;
  name: string;
  host: string;
  port: number;
  lastSync?: number;
  error?: string;
}

let ledger: Ledger | null = null;
let decks: Deck[] | null = null;
let link: LinkInfo | null = null;
let lastRulesSig = "";
let lastLocked: boolean | null = null;

// ---------------------------------------------------------------------------------- storage

async function load(): Promise<Ledger> {
  if (ledger) return ledger;
  const got = (await api.storage.local.get(["ledger", "link"])) as { ledger?: LedgerData; link?: LinkInfo };
  if (got.ledger) {
    ledger = await Ledger.load(got.ledger);
  } else {
    const ua = navigator.userAgent.includes("Firefox") ? "Firefox" : navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome";
    ledger = await Ledger.create(`${ua} extension`, "extension");
    await persist();
  }
  link = got.link ?? null;
  return ledger;
}

async function getDecks(): Promise<Deck[]> {
  if (!decks) decks = (((await api.storage.local.get("decks")) as { decks?: Deck[] }).decks ?? []).filter((d) => Array.isArray(d.cards));
  return decks;
}

async function persist(): Promise<void> {
  await api.storage.local.set({ ledger: ledger!.toJSON(), link });
}

/** Serialize all state-changing work so concurrent messages can't interleave. */
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------------- blocking

function lockPage(): string {
  return api.runtime.getURL("lock.html");
}

function siteFilter(site: string): string {
  return "||" + site.trim().replace(/^https?:\/\//, "").replace(/^\*\./, "");
}

async function applyBlocking(state: LockState, config: Config): Promise<void> {
  const allow = config.essentials.sites.filter((s) => s.trim()).slice(0, 500);
  const sig = state.locked ? `L|${allow.join(",")}` : "U";
  if (sig === lastRulesSig) return;
  const existing = await api.declarativeNetRequest.getDynamicRules();
  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  if (state.locked) {
    allow.forEach((site, i) =>
      addRules.push({
        id: 100 + i,
        priority: 2,
        action: { type: "allow" as chrome.declarativeNetRequest.RuleActionType },
        condition: { urlFilter: siteFilter(site), resourceTypes: ["main_frame" as chrome.declarativeNetRequest.ResourceType] },
      }),
    );
    addRules.push({
      id: 1,
      priority: 1,
      action: { type: "redirect" as chrome.declarativeNetRequest.RuleActionType, redirect: { extensionPath: "/lock.html" } },
      condition: {
        regexFilter: "^https?://",
        resourceTypes: ["main_frame" as chrome.declarativeNetRequest.ResourceType],
        excludedRequestDomains: ["localhost", "127.0.0.1"],
      },
    });
  }
  await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules });
  lastRulesSig = sig;

  // Tabs already open on a distracting site get sent to the lock page too.
  if (state.locked && lastLocked !== true) {
    const tabs = await api.tabs.query({});
    for (const t of tabs) {
      if (!t.id || !t.url || !/^https?:/.test(t.url)) continue;
      const host = new URL(t.url).host;
      if (host === "localhost" || host.startsWith("127.0.0.1")) continue;
      const allowed = allow.some((site) => {
        const s = site.replace(/^https?:\/\//, "");
        return t.url!.replace(/^https?:\/\//, "").startsWith(s) || host === s || host.endsWith("." + s.split("/")[0]);
      });
      if (!allowed) await api.tabs.update(t.id, { url: lockPage() }).catch(() => undefined);
    }
  }
  lastLocked = state.locked;
}

// ---------------------------------------------------------------------------------- sync + tick

async function syncNow(): Promise<void> {
  const l = await load();
  if (!link) return;
  const e = { host: link.host, port: link.port };
  try {
    await adoptTrust(l, e);
    await syncWith(l, link.peerId, e);
    // Pull decks from the desktop app (it's the source of truth for imported decks).
    const remote = await listDecks(l, e);
    const local = await getDecks();
    let changed = false;
    for (const s of remote) {
      const have = local.find((d) => d.id === s.id);
      if (!have || have.importedAt < s.importedAt) {
        const d = await fetchDeck(l, e, s.id);
        decks = [...(decks ?? []).filter((x) => x.id !== d.id), d];
        changed = true;
      }
    }
    if (changed) await api.storage.local.set({ decks });
    link.lastSync = Date.now();
    link.error = undefined;
  } catch (err) {
    link.error = (err as Error).message.includes("fetch") ? "desktop app not reachable (is it running?)" : (err as Error).message;
  }
  await persist();
}

async function tick(): Promise<LockState> {
  const l = await load();
  const config = l.config();
  const state = evaluate({ config, records: l.records(), now: Date.now() });
  await applyBlocking(state, config);
  if (state.nextChangeAt) api.alarms.create("edge", { when: state.nextChangeAt + 500 });
  return state;
}

async function fullTick(): Promise<void> {
  await exclusive(async () => {
    await syncNow();
    await tick();
  });
}

// ---------------------------------------------------------------------------------- messages

async function extState(): Promise<ExtState> {
  const l = await load();
  const config = l.config();
  let hostAccess = true;
  try {
    hostAccess = await api.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    /* older browsers */
  }
  return {
    device: { id: l.deviceId, name: l.name },
    lock: evaluate({ config, records: l.records(), now: Date.now() }),
    config,
    link: link ? { name: link.name, host: link.host, port: link.port, lastSync: link.lastSync, error: link.error } : null,
    decks: (await getDecks()).map((d) => ({ id: d.id, name: d.name, cards: d.cards.length, importedAt: d.importedAt })),
    hostAccess,
  };
}

async function handle(req: Request): Promise<unknown> {
  const l = await load();
  switch (req.type) {
    case "getState":
      return extState();
    case "emergency":
      return exclusive(async () => {
        const now = Date.now();
        const minutes = l.config().policy.emergencyMinutes;
        await l.issue("emergency", { day: dayKey(now), until: now + minutes * 60_000, reason: req.reason?.slice(0, 200) }, now);
        await persist();
        await tick();
        void syncNow();
      });
    case "pair":
      return exclusive(async () => {
        const e = { host: "127.0.0.1", port: Number(req.port) || 47123 };
        const device = await pair(l, e, req.code);
        link = { peerId: device.deviceId, name: device.name, host: e.host, port: e.port };
        await persist();
        await syncNow();
        await tick();
        return device.name;
      });
    case "unpair":
      return exclusive(async () => {
        if (link) l.removePeer(link.peerId);
        link = null;
        await persist();
        await tick();
      });
    case "syncNow":
      return fullTick();
    case "getStudyData":
      return { decks: await getDecks(), events: l.reviews() };
    case "addReview":
      return exclusive(async () => {
        if (!isReviewEvent(req.event) || req.event.deviceId !== l.deviceId) throw new Error("invalid review");
        l.addReviews([req.event]);
        await issueAnkiProofs({ ledger: l, decks: await getDecks(), now: Date.now(), newCardsPerDay: DEFAULT_NEW_PER_DAY });
        await persist();
        await tick();
        void syncNow();
      });
    case "proveFocus":
      return exclusive(async () => {
        const r = await issueFocusProof(l, req.commitmentId, req.minutes, Date.now());
        await persist();
        await tick();
        void syncNow();
        return r;
      });
    case "importDecks":
      return exclusive(async () => {
        const current = await getDecks();
        decks = [...current.filter((d) => !req.decks.some((n) => n.id === d.id)), ...req.decks];
        await api.storage.local.set({ decks });
      });
    case "deleteDeck":
      return exclusive(async () => {
        decks = (await getDecks()).filter((d) => d.id !== req.id);
        await api.storage.local.set({ decks });
      });
    case "updateConfig":
      return exclusive(async () => {
        const now = Date.now();
        const state = evaluate({ config: l.config(), records: l.records(), now });
        const why = configChangeBlockedWhileLocked(l.config(), req.config, state);
        if (why) throw new Error(why);
        await l.updateConfig(() => req.config, now);
        await persist();
        await tick();
        void syncNow();
      });
    case "setName":
      return exclusive(async () => {
        l.name = String(req.name).trim() || l.name;
        await persist();
      });
  }
}

api.runtime.onMessage.addListener((req: Request, _sender, sendResponse: (r: Response) => void) => {
  handle(req).then(
    (value) => sendResponse({ ok: true, value }),
    (e: Error) => sendResponse({ ok: false, error: e.message || String(e) }),
  );
  return true; // async response
});

api.alarms.onAlarm.addListener((a) => {
  if (a.name === "tick" || a.name === "edge") void fullTick();
});

function start() {
  api.alarms.create("tick", { periodInMinutes: 0.5 });
  void fullTick();
}
api.runtime.onInstalled.addListener(start);
api.runtime.onStartup.addListener(start);
start();

// Exposed for automated tests (service worker console).
(globalThis as unknown as { __ptu: unknown }).__ptu = { handle, tick, load };
