// Orchestrates the desktop app: state, the lock screen, essentials enforcement, proofs, linking.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, app, dialog, ipcMain, powerMonitor, screen, type WebContents } from "electron";
import QRCode from "qrcode";
import initSqlJs from "sql.js";
import {
  type Config,
  type Deck,
  Ledger,
  type LockState,
  type ReviewEvent,
  configChangeBlockedWhileLocked,
  dayKey,
  evaluate,
  fingerprint,
  importApkg,
  isReviewEvent,
  streak,
} from "@ptu/core";
import type { ImportResultInfo, LogEntry, PhotoSubmission, PublicSettings, UiState } from "../shared/api.js";
import { Agent, lanAddresses } from "./agent.js";
import { type ForegroundApp, type ForegroundWatcher, createForegroundWatcher, isEssential, quitApp } from "./foreground.js";
import { issueAnkiProofs, issueFocusProof, issuePhotoProof } from "./proofs.js";
import { type Settings, Storage } from "./storage.js";

const PLATFORM = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux";

export interface ControllerPaths {
  preload: string;
  renderer: string;
  wasmDir: string;
  modelUrl: string;
}

export class Controller {
  private ledger!: Ledger;
  private settings!: Settings;
  private decks: Deck[] = [];
  private agent!: Agent;
  private fg: ForegroundWatcher | null = null;
  private dashboard: BrowserWindow | null = null;
  private overlays: BrowserWindow[] = [];
  private essentialsMode = false;
  private blockedApp: string | undefined;
  private lastLock: LockState | null = null;
  private log: LogEntry[] = [];
  private fpCache = "";
  private tickTimer: NodeJS.Timeout | null = null;
  private lastBroadcast = "";
  private quitting = false;
  private quitAttempts = new Map<number, number>();
  private warnedTestBlock = new Map<string, number>();
  private unlockedAt: number | null = null;

  constructor(
    private storage: Storage,
    private paths: ControllerPaths,
  ) {}

  // ------------------------------------------------------------------ lifecycle

  async init(): Promise<void> {
    this.settings = await this.storage.loadSettings();
    const saved = await this.storage.loadLedger();
    this.ledger = saved ? await Ledger.load(saved) : await Ledger.create(osName(), PLATFORM);
    if (!saved) this.persist();
    this.fpCache = await fingerprint(this.ledger.hello().publicKey);
    this.decks = await this.storage.loadDecks();

    this.agent = new Agent({
      ledger: this.ledger,
      decks: () => this.decks,
      changed: () => {
        this.persist();
        this.refresh();
      },
      log: (m) => this.addLog(m),
    });
    await this.agent.start(this.settings.port);

    this.fg = createForegroundWatcher(1000);
    this.registerIpc();
    this.applyLoginItem();

    screen.on("display-added", () => this.rebuildOverlays());
    screen.on("display-removed", () => this.rebuildOverlays());
    screen.on("display-metrics-changed", () => this.rebuildOverlays());
    // Never block the OS from shutting down or logging out.
    powerMonitor.on("shutdown", () => {
      this.quitting = true;
    });

    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.tick();
    if (!process.argv.includes("--hidden") || !this.settings.onboarded) this.showDashboard();
  }

  async shutdown(): Promise<void> {
    this.quitting = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.fg?.stop();
    await this.agent?.stop().catch(() => undefined);
    await this.storage.flush();
  }

  /** Whether the app may quit now (only when unlocked, in test mode, or the OS is shutting down). */
  canQuit(): boolean {
    return this.quitting || this.settings.testMode || !this.lastLock?.locked;
  }

  allowQuit(): void {
    this.quitting = true;
  }

  private persist(): void {
    this.storage.saveLedger(this.ledger.toJSON());
  }

  private addLog(msg: string): void {
    this.log.push({ at: Date.now(), msg });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    console.log(`[ptu] ${msg}`);
    this.refresh();
  }

  private applyLoginItem(): void {
    if (process.platform === "linux") return;
    try {
      app.setLoginItemSettings({ openAtLogin: this.settings.launchAtLogin, args: ["--hidden"] });
    } catch {
      /* unsupported in dev */
    }
  }

  // ------------------------------------------------------------------ evaluation + enforcement

  private evaluate(now = Date.now()): LockState {
    return evaluate({ config: this.ledger.config(), records: this.ledger.records(), now });
  }

  private tick(): void {
    const lock = this.evaluate();
    const wasLocked = this.lastLock?.locked ?? false;
    this.lastLock = lock;

    if (!lock.locked) {
      // Show "Unlocked" on the lock screen for a moment so the user sees their proof worked.
      if (this.overlays.length) {
        this.unlockedAt ??= Date.now();
        if (Date.now() - this.unlockedAt >= 2500) this.closeOverlays();
      }
      this.essentialsMode = false;
      this.blockedApp = undefined;
      if (wasLocked) this.addLog("unlocked");
    } else {
      this.unlockedAt = null;
      if (!wasLocked) this.addLog("locked: prove your commitment to unlock");
      this.enforce();
    }
    this.refresh();
  }

  private enforce(): void {
    if (!this.essentialsMode) {
      if (this.overlays.length === 0) this.openOverlays();
      else if (!this.settings.testMode) this.keepOverlaysOnTop();
      return;
    }
    // Essentials mode: the lock screen is hidden; anything non-essential brings it back.
    const front = this.fg?.current();
    if (!front || this.isEssentialApp(front)) return;
    const label = front.name || front.id || `pid ${front.pid}`;
    if (this.settings.testMode) {
      const last = this.warnedTestBlock.get(label) ?? 0;
      if (Date.now() - last > 60_000) {
        this.warnedTestBlock.set(label, Date.now());
        this.addLog(`test mode: would block "${label}" (not an essential app)`);
      }
      return;
    }
    this.blockedApp = label;
    this.essentialsMode = false;
    this.addLog(`blocked "${label}": not an essential app`);
    this.openOverlays();
    if (this.settings.quitBlockedApps) {
      const last = this.quitAttempts.get(front.pid) ?? 0;
      if (Date.now() - last > 30_000) {
        this.quitAttempts.set(front.pid, Date.now());
        quitApp(front).catch((e) => this.addLog(`couldn't quit ${label}: ${(e as Error).message}`));
      }
    }
  }

  private isEssentialApp(front: ForegroundApp): boolean {
    return isEssential(front, {
      userApps: this.ledger.config().essentials.apps,
      browsersEssential: this.settings.browsersEssential,
      selfPid: process.pid,
      selfNames: [app.getName(), path.basename(process.execPath), "com.provetounlock.desktop", "electron"],
    });
  }

  private openOverlays(): void {
    if (this.overlays.length) {
      this.overlays.forEach((w) => w.show());
      this.overlays[0]?.focus();
      return;
    }
    const test = this.settings.testMode;
    const displays = test ? [screen.getPrimaryDisplay()] : screen.getAllDisplays();
    const primaryId = screen.getPrimaryDisplay().id;
    for (const d of displays) {
      const primary = d.id === primaryId;
      const win = new BrowserWindow(
        test
          ? { width: 980, height: 760, title: "Prove to Unlock — lock screen (TEST MODE)", backgroundColor: "#0f1117", show: false, webPreferences: this.webPrefs() }
          : {
              x: d.bounds.x,
              y: d.bounds.y,
              width: d.bounds.width,
              height: d.bounds.height,
              frame: false,
              alwaysOnTop: true,
              skipTaskbar: true,
              resizable: false,
              movable: false,
              minimizable: false,
              maximizable: false,
              fullscreenable: false,
              closable: false,
              show: false,
              backgroundColor: "#0f1117",
              webPreferences: this.webPrefs(),
            },
      );
      if (!test) {
        win.setAlwaysOnTop(true, "screen-saver");
        if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        win.on("close", (e) => {
          if (!this.quitting && this.lastLock?.locked && !this.settings.testMode) e.preventDefault();
        });
        // Windows: let the OS end the session even while locked.
        win.on("session-end", () => {
          this.quitting = true;
        });
      }
      // In test mode the user may close the lock window: treat that as "essentials only". (destroy()
      // from code doesn't emit "close", so rebuilding overlays doesn't trigger this.)
      if (test) {
        win.on("close", () => {
          if (this.lastLock?.locked) this.essentialsMode = true;
        });
      }
      win.on("closed", () => {
        this.overlays = this.overlays.filter((w) => w !== win);
      });
      void win.loadFile(path.join(this.paths.renderer, "lock.html"), { query: { primary: primary ? "1" : "0", test: test ? "1" : "0" } });
      win.once("ready-to-show", () => {
        win.show();
        if (primary) win.focus();
      });
      this.overlays.push(win);
    }
  }

  private keepOverlaysOnTop(): void {
    const primary = this.overlays[0];
    if (primary && !primary.isDestroyed()) {
      if (!primary.isVisible()) primary.show();
      if (!BrowserWindow.getFocusedWindow() || !this.overlays.includes(BrowserWindow.getFocusedWindow()!)) {
        if (BrowserWindow.getFocusedWindow() !== this.dashboard) primary.focus();
      }
    }
  }

  private closeOverlays(): void {
    for (const w of this.overlays) {
      if (!w.isDestroyed()) {
        w.setClosable(true);
        w.destroy();
      }
    }
    this.overlays = [];
  }

  private rebuildOverlays(): void {
    if (!this.overlays.length) return;
    this.closeOverlays();
    if (this.lastLock?.locked && !this.essentialsMode) this.openOverlays();
  }

  private webPrefs(): Electron.WebPreferences {
    return { preload: this.paths.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false };
  }

  showLockScreen(): void {
    if (!this.lastLock?.locked) {
      this.showDashboard();
      return;
    }
    this.essentialsMode = false;
    this.openOverlays();
    this.refresh();
  }

  showDashboard(): void {
    if (this.dashboard && !this.dashboard.isDestroyed()) {
      this.dashboard.show();
      this.dashboard.focus();
      if (this.overlays.length && !this.settings.testMode) this.dashboard.setAlwaysOnTop(true, "screen-saver", 1);
      return;
    }
    this.dashboard = new BrowserWindow({ width: 1100, height: 800, minWidth: 720, minHeight: 560, title: "Prove to Unlock", backgroundColor: "#0f1117", show: false, webPreferences: this.webPrefs() });
    void this.dashboard.loadFile(path.join(this.paths.renderer, "index.html"));
    this.dashboard.once("ready-to-show", () => this.dashboard?.show());
    if (this.overlays.length && !this.settings.testMode) this.dashboard.setAlwaysOnTop(true, "screen-saver", 1);
    this.dashboard.on("closed", () => (this.dashboard = null));
  }

  // ------------------------------------------------------------------ state for the UI

  private publicSettings(): PublicSettings {
    const { references, port: _p, ...rest } = this.settings;
    return { ...rest, referenceCounts: Object.fromEntries(Object.entries(references).map(([k, v]) => [k, v.length])) };
  }

  state(): UiState {
    const config = this.ledger.config();
    const lock = this.lastLock ?? this.evaluate();
    const input = { config, records: this.ledger.records(), now: Date.now() };
    return {
      device: { id: this.ledger.deviceId, name: this.ledger.name, platform: PLATFORM, fingerprint: this.fpCache, port: this.agent?.port ?? 0, hosts: lanAddresses() },
      lock,
      config,
      settings: this.publicSettings(),
      peers: [...this.ledger.peers()],
      decks: this.decks.map((d) => ({ id: d.id, name: d.name, cards: d.cards.length, importedAt: d.importedAt })),
      streaks: Object.fromEntries(config.commitments.map((c) => [c.id, streak(input, c.id)])),
      overlay: { visible: this.overlays.length > 0, essentialsMode: this.essentialsMode, blockedApp: this.blockedApp },
      foregroundSupported: this.fg?.supported ?? false,
      log: this.log.slice(-50),
      modelUrl: this.paths.modelUrl,
    };
  }

  private refresh(): void {
    const s = this.state();
    const json = JSON.stringify(s);
    if (json === this.lastBroadcast) return;
    this.lastBroadcast = json;
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("ptu:state", s);
  }

  // ------------------------------------------------------------------ actions

  async emergency(reason?: string): Promise<void> {
    const now = Date.now();
    const minutes = this.ledger.config().policy.emergencyMinutes;
    await this.ledger.issue("emergency", { day: dayKey(now), until: now + minutes * 60_000, reason: reason?.slice(0, 200) }, now);
    this.persist();
    this.addLog(`emergency unlock for ${minutes} min (streak reset)`);
    this.tick();
    void this.agent.syncAll();
  }

  private async afterProof(): Promise<void> {
    this.persist();
    this.tick();
    void this.agent.syncAll();
  }

  private async importDeck(sender: WebContents): Promise<ImportResultInfo> {
    const win = BrowserWindow.fromWebContents(sender) ?? undefined;
    const pick = await (win
      ? dialog.showOpenDialog(win, { title: "Import Anki deck", properties: ["openFile"], filters: [{ name: "Anki package", extensions: ["apkg", "colpkg"] }] })
      : dialog.showOpenDialog({ title: "Import Anki deck", properties: ["openFile"], filters: [{ name: "Anki package", extensions: ["apkg", "colpkg"] }] }));
    if (pick.canceled || !pick.filePaths[0]) return { imported: [], warnings: [], cancelled: true };
    const file = pick.filePaths[0];
    const bytes = new Uint8Array(await fs.readFile(file));
    const SQL = await initSqlJs({ locateFile: (f: string) => path.join(this.paths.wasmDir, f) });
    const result = importApkg(bytes, { sql: SQL, fileName: path.basename(file) });
    for (const d of result.decks) {
      await this.storage.saveDeck(d);
      this.decks = [...this.decks.filter((x) => x.id !== d.id), d].sort((a, b) => a.name.localeCompare(b.name));
    }
    this.addLog(`imported ${result.decks.length} deck(s) from ${path.basename(file)}`);
    return { imported: result.decks.map((d) => ({ id: d.id, name: d.name, cards: d.cards.length })), warnings: result.warnings };
  }

  private registerIpc(): void {
    const h = <A extends unknown[], R>(name: string, fn: (e: Electron.IpcMainInvokeEvent, ...args: A) => R | Promise<R>) =>
      ipcMain.handle(`ptu:${name}`, async (e, ...args) => fn(e, ...(args as A)));

    h("getState", () => this.state());
    h("updateConfig", async (_e, next: Config) => {
      validateConfig(next);
      if (this.lastLock?.locked && !this.settings.testMode) {
        const why = configChangeBlockedWhileLocked(this.ledger.config(), next, this.lastLock);
        if (why) throw new Error(why);
      }
      const saved = await this.ledger.updateConfig(() => next);
      this.persist();
      this.tick();
      void this.agent.syncAll();
      return saved;
    });
    h("updateSettings", (_e, patch: Partial<Settings>) => {
      if (this.lastLock?.locked && !this.settings.testMode) {
        if (patch.testMode === true) throw new Error("Test mode can't be turned on while locked. Use the emergency unlock if you really need to.");
        if (patch.browsersEssential === true && !this.settings.browsersEssential) throw new Error("You can't add essentials while locked.");
      }
      const allowed: (keyof Settings)[] = ["testMode", "browsersEssential", "quitBlockedApps", "launchAtLogin", "newCardsPerDay", "onboarded"];
      for (const k of allowed) if (k in patch) (this.settings as unknown as Record<string, unknown>)[k] = patch[k];
      this.settings.newCardsPerDay = Math.max(0, Math.min(9999, Math.floor(this.settings.newCardsPerDay)));
      // Leaving test mode while locked would make the lock screen appear abruptly; re-open cleanly.
      if ("testMode" in patch) this.rebuildOverlays();
      if ("launchAtLogin" in patch) this.applyLoginItem();
      this.storage.saveSettings(this.settings);
      this.refresh();
    });
    h("setDeviceName", (_e, name: string) => {
      this.ledger.name = String(name).trim() || osName();
      this.persist();
      this.refresh();
    });
    h("emergency", (_e, reason?: string) => this.emergency(reason));
    h("getStudyData", () => ({ decks: this.decks, events: this.ledger.reviews() }));
    h("addReview", async (_e, ev: ReviewEvent) => {
      if (!isReviewEvent(ev) || ev.deviceId !== this.ledger.deviceId) throw new Error("invalid review");
      this.ledger.addReviews([ev]);
      await issueAnkiProofs({ ledger: this.ledger, decks: this.decks, now: Date.now(), newCardsPerDay: this.settings.newCardsPerDay });
      await this.afterProof();
    });
    h("importDeck", (e) => this.importDeck(e.sender));
    h("deleteDeck", async (_e, id: string) => {
      await this.storage.deleteDeck(id);
      this.decks = this.decks.filter((d) => d.id !== id);
      this.refresh();
    });
    h("proveFocus", async (_e, cid: string, minutes: number) => {
      const r = await issueFocusProof(this.ledger, cid, minutes, Date.now());
      if (r.ok) await this.afterProof();
      return r;
    });
    h("provePhoto", async (_e, p: PhotoSubmission) => {
      const refs = this.settings.references[`${p.commitmentId}:${p.requirementIndex}`];
      const r = await issuePhotoProof(this.ledger, p, refs, Date.now());
      if (r.ok) await this.afterProof();
      return r;
    });
    h("setReferencePhotos", (_e, cid: string, idx: number, embeddings: number[][]) => {
      if (!Array.isArray(embeddings) || embeddings.some((v) => !Array.isArray(v))) throw new Error("invalid embeddings");
      this.settings.references[`${cid}:${idx}`] = embeddings.slice(0, 10);
      this.storage.saveSettings(this.settings);
      this.refresh();
    });
    h("startPairing", async () => {
      const p = await this.agent.startPairing();
      const qr = await QRCode.toDataURL(p.qr, { margin: 1, width: 320, errorCorrectionLevel: "M" });
      return { code: p.code, qr, qrText: p.qr, fingerprint: p.fingerprint, expiresAt: p.expiresAt, hosts: p.hosts, port: p.port };
    });
    h("cancelPairing", () => this.agent.cancelPairing());
    h("discover", () => this.agent.discoveredDevices());
    h("pairWith", async (_e, hosts: string[], port: number, code: string) => {
      const d = await this.agent.pairWith(hosts, port, code);
      this.addLog(`linked with ${d.name}`);
      return { name: d.name };
    });
    h("removePeer", (_e, id: string) => {
      this.ledger.removePeer(id);
      this.persist();
      this.tick();
    });
    h("syncNow", () => this.agent.syncAll());
    h("essentialsMode", () => {
      this.essentialsMode = true;
      this.blockedApp = undefined;
      if (this.settings.testMode) this.closeOverlays();
      else this.overlays.forEach((w) => w.hide());
      this.refresh();
    });
    h("showLockScreen", () => this.showLockScreen());
    h("showDashboard", () => this.showDashboard());
  }
}

function osName(): string {
  const host = os.hostname();
  return host.replace(/\.local$/, "") || (PLATFORM === "mac" ? "Mac" : PLATFORM === "windows" ? "PC" : "Computer");
}

/** Reject configs that would break evaluation on other devices. */
export function validateConfig(c: Config): void {
  if (!c || !Array.isArray(c.commitments) || !Array.isArray(c.places)) throw new Error("invalid config");
  const ids = new Set<string>();
  for (const k of c.commitments) {
    if (!k.id || ids.has(k.id)) throw new Error("commitment ids must be unique");
    ids.add(k.id);
    if (!/^\d{1,2}:\d{2}$/.test(k.window.start) || !/^\d{1,2}:\d{2}$/.test(k.window.end)) throw new Error(`"${k.title}": invalid time window`);
    const [sh, sm] = k.window.start.split(":").map(Number);
    const [eh, em] = k.window.end.split(":").map(Number);
    if (eh! * 60 + em! <= sh! * 60 + sm!) throw new Error(`"${k.title}": window must end after it starts`);
    if (k.require !== "all" && !(k.require.any >= 1)) throw new Error(`"${k.title}": invalid requirement count`);
    for (const r of [...k.requirements, ...(k.away?.requirements ?? [])]) {
      if ((r.kind === "photo" && r.placeId) || r.kind === "presence") {
        const pid = r.kind === "presence" ? r.placeId : r.placeId;
        if (!c.places.some((p) => p.id === pid)) throw new Error(`"${k.title}": a requirement uses a place that doesn't exist`);
      }
    }
    if (k.away && !c.places.some((p) => p.id === k.away!.regionPlaceId)) throw new Error(`"${k.title}": the away region doesn't exist`);
  }
}
