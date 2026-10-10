import { useEffect, useMemo, useState } from "preact/hooks";
import {
  type Deck,
  type Rating,
  type ReviewEvent,
  buildQueue,
  honestReviewsToday,
  preview,
  randomId,
} from "@ptu/core";
import { CardFrame } from "./CardFrame.js";

export interface ReviewProps {
  decks: Deck[];
  events: ReviewEvent[];
  deviceId: string;
  newPerDay: number;
  minAnswerMs: number;
  deckIds?: string[];
  tz?: string;
  onReview: (e: ReviewEvent) => void | Promise<void>;
  /** Shown as "N / target honest reviews today" when set. */
  target?: number;
}

function fmtInterval(ms: number): string {
  const m = ms / 60_000;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 31) return `${Math.round(d)}d`;
  if (d < 365) return `${(d / 30).toFixed(1)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

const LABELS: Record<Rating, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

export function Review(props: ReviewProps) {
  const [now, setNow] = useState(Date.now());
  const [shownAt, setShownAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const queue = useMemo(
    () => buildQueue(props.decks, props.events, now, { newPerDay: props.newPerDay, tz: props.tz, deckIds: props.deckIds }),
    [props.decks, props.events, now, props.newPerDay, props.tz, props.deckIds],
  );
  const current = queue.items[0];
  const honest = honestReviewsToday(props.events, now, { minAnswerMs: props.minAnswerMs, deviceId: props.deviceId, tz: props.tz, deckIds: props.deckIds });
  const deck = current ? props.decks.find((d) => d.id === current.deckId) : undefined;
  const css = current && deck ? deck.styles[current.card.styleId] : "";
  const intervals = useMemo(() => {
    if (!current || shownAt === null) return null;
    const t = Date.now();
    const p = preview(current.srs, t);
    return ([1, 2, 3, 4] as Rating[]).map((r) => fmtInterval(p[r].due - t));
  }, [current?.card.id, shownAt]);

  const showAnswer = () => {
    if (current && shownAt === null) setShownAt(Date.now());
  };

  const rate = async (r: Rating) => {
    if (!current || shownAt === null || busy) return;
    const at = Date.now();
    const fast = at - shownAt < props.minAnswerMs;
    setBusy(true);
    try {
      await props.onReview({ id: randomId(12), cardId: current.card.id, deckId: current.deckId, rating: r, at, answerShownAt: shownAt, deviceId: props.deviceId });
      setNote(fast ? "Too fast to count: read the answer before rating." : "");
    } finally {
      setShownAt(null);
      setBusy(false);
      setNow(Date.now());
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (shownAt === null && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        showAnswer();
      } else if (shownAt !== null && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        void rate(Number(e.key) as Rating);
      } else if (shownAt !== null && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        void rate(3);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (props.decks.length === 0) {
    return <div class="ptu-empty">No decks yet. Import an Anki <code>.apkg</code> file to study here.</div>;
  }

  return (
    <div class="ptu-review">
      <div class="ptu-counts">
        <span class="new">{queue.counts.new}</span>
        <span class="learn">{queue.counts.learning}</span>
        <span class="due">{queue.counts.review}</span>
        <span class="honest">
          {honest}
          {props.target ? ` / ${props.target}` : ""} honest reviews today
        </span>
      </div>
      {current ? (
        <>
          <CardFrame html={shownAt === null ? current.card.front : current.card.back} css={css} media={deck?.media} />
          {shownAt === null ? (
            <button class="ptu-btn primary wide" onClick={showAnswer}>
              Show answer <kbd>Space</kbd>
            </button>
          ) : (
            <div class="ptu-ratings">
              {([1, 2, 3, 4] as Rating[]).map((r) => (
                <button key={r} class={`ptu-btn rate r${r}`} disabled={busy} onClick={() => void rate(r)}>
                  <small>{intervals?.[r - 1]}</small>
                  {LABELS[r]} <kbd>{r}</kbd>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div class="ptu-empty">
          {queue.cleared ? "All caught up for today." : "Nothing due right now."}
          {queue.nextDueAt ? ` Next learning card in ${fmtInterval(queue.nextDueAt - now)}.` : ""}
        </div>
      )}
      {note && <div class="ptu-note">{note}</div>}
    </div>
  );
}
