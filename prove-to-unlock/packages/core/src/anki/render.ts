// Anki card template rendering: {{Field}}, filters ({{text:F}}, {{cloze:F}}, {{hint:F}},
// {{furigana:F}}, {{kana:F}}, {{kanji:F}}, {{type:F}}), conditional sections ({{#F}}..{{/F}},
// {{^F}}..{{/F}}), {{FrontSide}} and the special fields Tags/Deck/Subdeck/Card/Type.

export interface RenderContext {
  fields: Record<string, string>;
  tags: string[];
  deck: string;
  notetype: string;
  cardName: string;
  /** 1-based cloze number for cloze notetypes (card ord + 1). */
  clozeOrd?: number;
}

type Node =
  | { t: "text"; v: string }
  | { t: "var"; v: string }
  | { t: "section"; name: string; inverted: boolean; children: Node[] };

function parse(tpl: string): Node[] {
  const root: Node[] = [];
  const stack: { name: string; children: Node[] }[] = [{ name: "", children: root }];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tpl))) {
    const top = stack[stack.length - 1]!;
    if (m.index > last) top.children.push({ t: "text", v: tpl.slice(last, m.index) });
    last = re.lastIndex;
    const tag = m[1]!.trim();
    if (tag.startsWith("#") || tag.startsWith("^")) {
      const node: Node = { t: "section", name: tag.slice(1).trim(), inverted: tag[0] === "^", children: [] };
      top.children.push(node);
      stack.push({ name: node.name, children: node.children });
    } else if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      // Close the matching section; tolerate mismatches the way Anki does (treat as text).
      const idx = stack.map((s) => s.name).lastIndexOf(name);
      if (idx > 0) stack.length = idx;
      else top.children.push({ t: "text", v: m[0] });
    } else if (tag.startsWith("!")) {
      // comment
    } else {
      top.children.push({ t: "var", v: tag });
    }
  }
  if (last < tpl.length) stack[stack.length - 1]!.children.push({ t: "text", v: tpl.slice(last) });
  return root;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function fieldNonEmpty(html: string | undefined): boolean {
  return !!html && stripHtml(html).replace(/\s+/g, "").length > 0;
}

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

export function clozeNumbers(text: string): number[] {
  const nums = new Set<number>();
  for (const m of text.matchAll(CLOZE_RE)) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

export function renderCloze(text: string, ord: number, side: "q" | "a"): string {
  return text.replace(CLOZE_RE, (_all, n: string, body: string, hint?: string) => {
    if (Number(n) !== ord) return body;
    if (side === "q") return `<span class="cloze">[${hint ? hint : "..."}]</span>`;
    return `<span class="cloze">${body}</span>`;
  });
}

function furigana(s: string, mode: "furigana" | "kana" | "kanji"): string {
  return s.replace(/ ?([^ >[\]]+?)\[(.+?)\]/g, (_a, base: string, reading: string) => {
    if (mode === "kana") return reading;
    if (mode === "kanji") return base;
    return `<ruby><rb>${base}</rb><rt>${reading}</rt></ruby>`;
  });
}

function applyVar(tag: string, ctx: RenderContext, side: "q" | "a", frontSide: string): string {
  const parts = tag.split(":");
  const name = parts.pop()!.trim();
  const filters = parts.map((f) => f.trim().toLowerCase());

  let value: string;
  switch (name) {
    case "FrontSide":
      value = frontSide;
      break;
    case "Tags":
      value = ctx.tags.join(" ");
      break;
    case "Deck":
      value = ctx.deck;
      break;
    case "Subdeck":
      value = ctx.deck.split("::").pop() ?? ctx.deck;
      break;
    case "Card":
      value = ctx.cardName;
      break;
    case "Type":
      value = ctx.notetype;
      break;
    default:
      value = ctx.fields[name] ?? "";
  }

  // Filters apply right-to-left ({{text:cloze:Field}} = text(cloze(Field))).
  for (const f of filters.reverse()) {
    if (f === "cloze") value = ctx.clozeOrd ? renderCloze(value, ctx.clozeOrd, side) : value;
    else if (f === "text") value = stripHtml(value);
    else if (f === "type") value = "";
    else if (f === "hint") value = fieldNonEmpty(value) ? `<details class="hint"><summary>Hint</summary>${value}</details>` : "";
    else if (f === "furigana" || f === "kana" || f === "kanji") value = furigana(value, f);
    // Unknown filters (e.g. add-on filters) pass the value through unchanged.
  }
  return value;
}

function renderNodes(nodes: Node[], ctx: RenderContext, side: "q" | "a", frontSide: string): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.v;
    else if (n.t === "var") out += applyVar(n.v, ctx, side, frontSide);
    else {
      let present: boolean;
      const clozeSection = /^c(\d+)$/.exec(n.name);
      if (clozeSection && ctx.clozeOrd !== undefined) present = Number(clozeSection[1]) === ctx.clozeOrd;
      else if (n.name === "Tags") present = ctx.tags.length > 0;
      else present = fieldNonEmpty(ctx.fields[n.name]);
      if (present !== n.inverted) out += renderNodes(n.children, ctx, side, frontSide);
    }
  }
  return out;
}

/** [sound:file.mp3] -> <audio>. Media src rewriting happens at display time. */
export function soundTags(html: string): string {
  return html.replace(/\[sound:([^\]]+)\]/g, (_a, f: string) => `<audio controls preload="none" src="${f.replace(/"/g, "&quot;")}"></audio>`);
}

export function renderCard(qfmt: string, afmt: string, ctx: RenderContext): { front: string; back: string } {
  const front = soundTags(renderNodes(parse(qfmt), ctx, "q", ""));
  const back = soundTags(renderNodes(parse(afmt), ctx, "a", front));
  return { front, back };
}

/** True when a rendered question is effectively empty (Anki wouldn't generate this card). */
export function isEmptyRender(html: string): boolean {
  return !/<img|<audio|<video/i.test(html) && stripHtml(html).replace(/\s+/g, "").length === 0;
}
