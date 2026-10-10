// Import Anki .apkg / .colpkg packages.
//
// Supports every package layout Anki has produced:
//   - collection.anki2   (Anki 2.0 / legacy export, JSON models in the `col` table)
//   - collection.anki21  (Anki 2.1 legacy export)
//   - collection.anki21b (Anki 2.1.50+: zstd-compressed SQLite, schema 18 with notetypes/fields/
//                         templates tables whose configs are protobuf; zstd + protobuf media map)
// Cards are rendered to HTML at import time so every client (desktop, extension, iOS) can show
// them without re-implementing Anki's template engine.

import { unzipSync } from "fflate";
import { decompress as zstdDecompress } from "fzstd";
import type { Database, SqlJsStatic } from "sql.js";
import { bytesToB64 } from "../b64.js";
import { decodeMessage, getInt, getMessages, getString } from "./protobuf.js";
import { isEmptyRender, renderCard } from "./render.js";

export interface MediaFile {
  mime: string;
  /** base64 */
  data: string;
}

export interface DeckCard {
  /** Stable across re-imports of the same deck (derived from the Anki card id). */
  id: string;
  noteId: string;
  ord: number;
  front: string;
  back: string;
  styleId: string;
  tags: string[];
  /** New-card order. */
  position: number;
}

export interface Deck {
  id: string;
  name: string;
  importedAt: number;
  source: string;
  cards: DeckCard[];
  /** notetype id -> CSS */
  styles: Record<string, string>;
  /** filename -> file (only files referenced by this deck's cards) */
  media: Record<string, MediaFile>;
}

export interface ImportResult {
  decks: Deck[];
  warnings: string[];
}

export interface ImportOptions {
  sql: SqlJsStatic;
  now?: number;
  fileName?: string;
  /** Refuse packages that would decompress to more than this (zip-bomb guard). Default 1 GiB. */
  maxUncompressedBytes?: number;
}

interface Notetype {
  id: string;
  name: string;
  cloze: boolean;
  css: string;
  fields: string[]; // by ord
  templates: { name: string; qfmt: string; afmt: string }[]; // by ord
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const isZstd = (b: Uint8Array) => ZSTD_MAGIC.every((v, i) => b[i] === v);
const maybeZstd = (b: Uint8Array) => (isZstd(b) ? zstdDecompress(b) : b);

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
};

function mimeOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

function rows(db: Database, sql: string): Record<string, unknown>[] {
  const res = db.exec(sql);
  if (res.length === 0) return [];
  const { columns, values } = res[0]!;
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

function asBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return new TextEncoder().encode(v);
  return new Uint8Array();
}

function idStr(v: unknown): string {
  // Anki ids are 13-digit ms timestamps; they fit in a double exactly.
  return typeof v === "bigint" ? v.toString() : String(v);
}

function loadNotetypesModern(db: Database): Map<string, Notetype> {
  const out = new Map<string, Notetype>();
  for (const r of rows(db, "SELECT id, name, config FROM notetypes")) {
    let cloze = false;
    let css = "";
    try {
      const cfg = decodeMessage(asBytes(r.config));
      cloze = getInt(cfg, 1) === 1;
      css = getString(cfg, 3) ?? "";
    } catch {
      /* fall back to template sniffing below */
    }
    out.set(idStr(r.id), { id: idStr(r.id), name: String(r.name), cloze, css, fields: [], templates: [] });
  }
  for (const r of rows(db, "SELECT ntid, ord, name FROM fields ORDER BY ntid, ord")) {
    const nt = out.get(idStr(r.ntid));
    if (nt) nt.fields[Number(r.ord)] = String(r.name);
  }
  for (const r of rows(db, "SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord")) {
    const nt = out.get(idStr(r.ntid));
    if (!nt) continue;
    let qfmt = "";
    let afmt = "";
    try {
      const cfg = decodeMessage(asBytes(r.config));
      qfmt = getString(cfg, 1) ?? "";
      afmt = getString(cfg, 2) ?? "";
    } catch {
      /* leave empty; card will be skipped with a warning */
    }
    nt.templates[Number(r.ord)] = { name: String(r.name), qfmt, afmt };
  }
  for (const nt of out.values()) {
    if (!nt.cloze && nt.templates.some((t) => /\{\{[^}]*cloze:/.test(t?.qfmt ?? ""))) nt.cloze = true;
  }
  return out;
}

function loadNotetypesLegacy(db: Database): Map<string, Notetype> {
  const out = new Map<string, Notetype>();
  const col = rows(db, "SELECT models FROM col")[0];
  if (!col) return out;
  const models = JSON.parse(String(col.models || "{}")) as Record<
    string,
    { id: number | string; name: string; type: number; css?: string; flds: { name: string; ord: number }[]; tmpls: { name: string; ord: number; qfmt: string; afmt: string }[] }
  >;
  for (const m of Object.values(models)) {
    const nt: Notetype = { id: idStr(m.id), name: m.name, cloze: m.type === 1, css: m.css ?? "", fields: [], templates: [] };
    for (const f of m.flds) nt.fields[f.ord] = f.name;
    for (const t of m.tmpls) nt.templates[t.ord] = { name: t.name, qfmt: t.qfmt, afmt: t.afmt };
    out.set(nt.id, nt);
  }
  return out;
}

function loadDeckNames(db: Database, modern: boolean): Map<string, string> {
  const out = new Map<string, string>();
  if (modern) {
    for (const r of rows(db, "SELECT id, name FROM decks")) out.set(idStr(r.id), String(r.name).replace(/\x1f/g, "::"));
    return out;
  }
  const col = rows(db, "SELECT decks FROM col")[0];
  if (col) {
    const decks = JSON.parse(String(col.decks || "{}")) as Record<string, { id: number | string; name: string }>;
    for (const d of Object.values(decks)) out.set(idStr(d.id), d.name);
  }
  return out;
}

function loadMediaMap(files: Record<string, Uint8Array>, warnings: string[]): Map<string, string> {
  // zip entry name -> real filename
  const map = new Map<string, string>();
  const raw = files["media"];
  if (!raw || raw.length === 0) return map;
  const data = maybeZstd(raw);
  const text = new TextDecoder().decode(data);
  if (text.trimStart().startsWith("{")) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(text) as Record<string, string>)) map.set(k, v);
    } catch {
      warnings.push("couldn't read the media list; images/audio will be missing");
    }
    return map;
  }
  try {
    const entries = getMessages(decodeMessage(data), 1);
    entries.forEach((e, i) => {
      const name = getString(e, 1);
      const legacy = getInt(e, 255);
      if (name) map.set(String(legacy ?? i), name);
    });
  } catch {
    warnings.push("couldn't read the media list; images/audio will be missing");
  }
  return map;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Media filenames referenced by rendered HTML (src="", unquoted src=, CSS url()). */
export function referencedMedia(html: string): Set<string> {
  const out = new Set<string>();
  const add = (s: string) => {
    out.add(s);
    out.add(safeDecode(s));
  };
  for (const m of html.matchAll(/\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]!);
  for (const m of html.matchAll(/\bsrc\s*=\s*([^\s"'>]+)/gi)) add(m[1]!);
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1]!);
  return out;
}

export function importApkg(bytes: Uint8Array, opts: ImportOptions): ImportResult {
  const warnings: string[] = [];
  const now = opts.now ?? Date.now();
  const maxBytes = opts.maxUncompressedBytes ?? 1024 * 1024 * 1024;

  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (total > maxBytes) throw new Error("package is too large to import");
        return true;
      },
    });
  } catch (e) {
    throw new Error(`not a valid Anki package: ${(e as Error).message}`);
  }

  const collectionName = ["collection.anki21b", "collection.anki21", "collection.anki2"].find((n) => files[n]);
  if (!collectionName) throw new Error("not an Anki package (no collection inside)");
  const dbBytes = maybeZstd(files[collectionName]!);

  const db = new opts.sql.Database(dbBytes);
  try {
    const tables = new Set(rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => String(r.name)));
    const modern = tables.has("notetypes") && tables.has("templates");
    const notetypes = modern ? loadNotetypesModern(db) : loadNotetypesLegacy(db);
    const deckNames = loadDeckNames(db, modern);

    const notes = new Map<string, { mid: string; fields: string[]; tags: string[] }>();
    for (const r of rows(db, "SELECT id, mid, flds, tags FROM notes")) {
      notes.set(idStr(r.id), {
        mid: idStr(r.mid),
        fields: String(r.flds ?? "").split("\x1f"),
        tags: String(r.tags ?? "").trim().split(/\s+/).filter(Boolean),
      });
    }

    const mediaMap = loadMediaMap(files, warnings);
    const mediaByName = new Map<string, string>(); // real name -> zip entry
    for (const [entry, name] of mediaMap) mediaByName.set(name, entry);

    const decks = new Map<string, Deck>();
    let skippedEmpty = 0;
    let skippedBroken = 0;
    const cardRows = rows(db, "SELECT id, nid, did, ord, type, due FROM cards");
    // New cards keep Anki's new-card order (due = position); others follow by id.
    cardRows.sort((a, b) => {
      const pa = Number(a.type) === 0 ? Number(a.due) : Number.MAX_SAFE_INTEGER;
      const pb = Number(b.type) === 0 ? Number(b.due) : Number.MAX_SAFE_INTEGER;
      return pa - pb || Number(a.id) - Number(b.id);
    });

    let position = 0;
    for (const r of cardRows) {
      const note = notes.get(idStr(r.nid));
      const nt = note && notetypes.get(note.mid);
      if (!note || !nt) {
        skippedBroken++;
        continue;
      }
      const ord = Number(r.ord);
      const tmpl = nt.cloze ? nt.templates[0] : nt.templates[ord];
      if (!tmpl || !tmpl.qfmt) {
        skippedBroken++;
        continue;
      }
      const fields: Record<string, string> = {};
      nt.fields.forEach((name, i) => {
        if (name !== undefined) fields[name] = note.fields[i] ?? "";
      });
      const did = idStr(r.did);
      const deckName = deckNames.get(did) ?? "Imported";
      const { front, back } = renderCard(tmpl.qfmt, tmpl.afmt, {
        fields,
        tags: note.tags,
        deck: deckName,
        notetype: nt.name,
        cardName: tmpl.name,
        clozeOrd: nt.cloze ? ord + 1 : undefined,
      });
      if (isEmptyRender(front)) {
        skippedEmpty++;
        continue;
      }
      let deck = decks.get(did);
      if (!deck) {
        deck = { id: `anki-${did}`, name: deckName, importedAt: now, source: opts.fileName ?? "package.apkg", cards: [], styles: {}, media: {} };
        decks.set(did, deck);
      }
      deck.styles[nt.id] = nt.css;
      deck.cards.push({ id: `c${idStr(r.id)}`, noteId: `n${idStr(r.nid)}`, ord, front, back, styleId: nt.id, tags: note.tags, position: position++ });

      for (const name of referencedMedia(front + back)) {
        if (deck.media[name]) continue;
        const entry = mediaByName.get(name);
        const data = entry !== undefined ? files[entry] : undefined;
        if (!data) continue;
        deck.media[name] = { mime: mimeOf(name), data: bytesToB64(maybeZstd(data)) };
      }
    }

    if (skippedEmpty) warnings.push(`${skippedEmpty} card(s) skipped because their front side is empty`);
    if (skippedBroken) warnings.push(`${skippedBroken} card(s) skipped because their note type is missing or broken`);
    const result = [...decks.values()].filter((d) => d.cards.length > 0);
    if (result.length === 0) warnings.push("no cards found in this package");
    return { decks: result, warnings };
  } finally {
    db.close();
  }
}
