// Persistence for the desktop app: atomic JSON files under the user-data directory.
// The device's private key is encrypted with the OS keychain (Electron safeStorage) when available.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Deck, LedgerData } from "@ptu/core";

export interface Settings {
  /** Test mode: nothing is actually blocked; the lock screen is a normal window. */
  testMode: boolean;
  /** Browsers count as essential apps (the browser extension blocks distracting sites). */
  browsersEssential: boolean;
  /** Also quit non-essential apps (gracefully) instead of only covering them. */
  quitBlockedApps: boolean;
  launchAtLogin: boolean;
  newCardsPerDay: number;
  port: number;
  onboarded: boolean;
  /** Reference photo embeddings, keyed by `${commitmentId}:${requirementIndex}`. */
  references: Record<string, number[][]>;
}

export const DEFAULT_SETTINGS: Settings = {
  testMode: true,
  browsersEssential: true,
  quitBlockedApps: false,
  launchAtLogin: false,
  newCardsPerDay: 20,
  port: 47123,
  onboarded: false,
  references: {},
};

export interface Crypter {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

export async function writeAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Corrupt file: keep a copy for debugging and start fresh rather than crash-looping.
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => undefined);
    return null;
  }
}

type EncryptedJwk = { __enc: string };

export class Storage {
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private pending = new Map<string, () => string>();

  constructor(
    readonly dir: string,
    private crypter: Crypter | null,
  ) {}

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  async loadLedger(): Promise<LedgerData | null> {
    const raw = await readJson<LedgerData & { identity: { privateJwk: JsonWebKey | EncryptedJwk } }>(this.file("ledger.json"));
    if (!raw) return null;
    const jwk = raw.identity.privateJwk as JsonWebKey | EncryptedJwk;
    if ("__enc" in jwk) {
      if (!this.crypter?.isEncryptionAvailable()) throw new Error("device key is encrypted but the OS keychain is unavailable");
      raw.identity.privateJwk = JSON.parse(this.crypter.decryptString(Buffer.from(jwk.__enc, "base64"))) as JsonWebKey;
    }
    return raw as LedgerData;
  }

  private serializeLedger(data: LedgerData): string {
    let identity = data.identity as LedgerData["identity"] | { publicKey: string; privateJwk: EncryptedJwk };
    if (this.crypter?.isEncryptionAvailable()) {
      identity = { publicKey: data.identity.publicKey, privateJwk: { __enc: this.crypter.encryptString(JSON.stringify(data.identity.privateJwk)).toString("base64") } };
    }
    return JSON.stringify({ ...data, identity });
  }

  /** Debounced save; call flush() before quitting. */
  saveLedger(data: LedgerData): void {
    this.schedule("ledger.json", () => this.serializeLedger(data));
  }

  async loadSettings(): Promise<Settings> {
    const s = await readJson<Partial<Settings>>(this.file("settings.json"));
    return { ...DEFAULT_SETTINGS, ...(s ?? {}), references: s?.references ?? {} };
  }

  saveSettings(s: Settings): void {
    this.schedule("settings.json", () => JSON.stringify(s, null, 1));
  }

  async loadDecks(): Promise<Deck[]> {
    const dir = this.file("decks");
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const decks: Deck[] = [];
    for (const n of names.filter((x) => x.endsWith(".json"))) {
      const d = await readJson<Deck>(path.join(dir, n));
      if (d && Array.isArray(d.cards)) decks.push(d);
    }
    return decks.sort((a, b) => a.name.localeCompare(b.name));
  }

  private deckFile(id: string): string {
    return path.join(this.file("decks"), `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  }

  async saveDeck(deck: Deck): Promise<void> {
    await writeAtomic(this.deckFile(deck.id), JSON.stringify(deck));
  }

  async deleteDeck(id: string): Promise<void> {
    await fs.rm(this.deckFile(id), { force: true });
  }

  private schedule(name: string, produce: () => string): void {
    this.pending.set(name, produce);
    if (this.saveTimers.has(name)) return;
    this.saveTimers.set(
      name,
      setTimeout(() => {
        this.saveTimers.delete(name);
        void this.write(name);
      }, 250),
    );
  }

  private chains = new Map<string, Promise<void>>();

  /** Writes to the same file are serialized so an older snapshot can never land last. */
  private write(name: string): Promise<void> {
    const prev = this.chains.get(name) ?? Promise.resolve();
    const next = prev.then(async () => {
      const produce = this.pending.get(name);
      if (!produce) return;
      this.pending.delete(name);
      await writeAtomic(this.file(name), produce());
    });
    const settled = next.catch((e) => console.error(`failed to save ${name}:`, e));
    this.chains.set(name, settled);
    return settled;
  }

  async flush(): Promise<void> {
    for (const t of this.saveTimers.values()) clearTimeout(t);
    this.saveTimers.clear();
    await Promise.all([...this.pending.keys()].map((n) => this.write(n)));
    await Promise.all(this.chains.values());
  }
}
