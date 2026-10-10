// "Do it here" flows on the computer: Anki reviews, focus sessions, live photos.

import { useEffect, useRef, useState } from "preact/hooks";
import { type AnkiRequirement, type Deck, type PhotoRequirement, type ReviewEvent, type Requirement, dHash, randomChallenge } from "@ptu/core";
import { type CapturedPhoto, FocusTimer, PhotoCapture, Review } from "@ptu/ui";
import type { Vision } from "@ptu/ui/vision";
import type { UiState } from "../shared/api.js";

export interface ProveTarget {
  kind: Requirement["kind"];
  commitmentId: string;
  requirementIndex: number;
}

export function requirementFor(state: UiState, t: ProveTarget): Requirement | undefined {
  const status = state.lock.commitments.find((c) => c.commitment.id === t.commitmentId);
  return status?.requirements[t.requirementIndex]?.requirement;
}

export function StudyPanel(props: { state: UiState; deckIds?: string[]; target?: number }) {
  const [data, setData] = useState<{ decks: Deck[]; events: ReviewEvent[] } | null>(null);
  useEffect(() => {
    void window.ptu.getStudyData().then(setData);
  }, [props.state.decks.length]);
  if (!data) return <div class="ptu-empty">Loading cards…</div>;
  return (
    <Review
      decks={data.decks}
      events={data.events}
      deviceId={props.state.device.id}
      newPerDay={props.state.settings.newCardsPerDay}
      minAnswerMs={props.state.config.policy.minAnswerMs}
      deckIds={props.deckIds}
      target={props.target}
      onReview={async (e) => {
        await window.ptu.addReview(e);
        setData((d) => (d ? { ...d, events: [...d.events, e] } : d));
      }}
    />
  );
}

let visionPromise: Promise<Vision> | null = null;
function loadVision(url: string): Promise<Vision> {
  if (!visionPromise) {
    visionPromise = import("@ptu/ui/vision").then((m) => m.Vision.load(url));
    visionPromise.catch(() => (visionPromise = null));
  }
  return visionPromise;
}

function analyze(state: UiState, photo: CapturedPhoto) {
  return loadVision(state.modelUrl).then((v) => {
    const r = v.analyze(photo.canvas);
    return { ...r, dhash: dHash({ width: photo.imageData.width, height: photo.imageData.height, data: photo.imageData.data }) };
  });
}

export function PhotoPanel(props: { state: UiState; target: ProveTarget; onDone: () => void }) {
  const req = requirementFor(props.state, props.target) as PhotoRequirement | undefined;
  const [challenge] = useState(() => (req?.challenge ? randomChallenge() : undefined));
  const [phase, setPhase] = useState<"camera" | "checking" | "confirm" | "result">("camera");
  const [captured, setCaptured] = useState<CapturedPhoto | null>(null);
  const [result, setResult] = useState<{ ok: boolean; failures: string[]; labels?: string[] } | null>(null);
  const preview = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (captured && preview.current) {
      preview.current.innerHTML = "";
      captured.canvas.style.maxWidth = "100%";
      captured.canvas.style.borderRadius = "12px";
      preview.current.appendChild(captured.canvas);
    }
  }, [captured, phase]);

  const submit = async (photo: CapturedPhoto, confirmed: boolean) => {
    setPhase("checking");
    try {
      const a = await analyze(props.state, photo);
      const r = await window.ptu.provePhoto({
        commitmentId: props.target.commitmentId,
        requirementIndex: props.target.requirementIndex,
        dhash: a.dhash,
        labels: a.labels,
        embedding: a.embedding,
        capturedAt: photo.capturedAt,
        challenge: challenge ? { prompt: challenge, confirmed } : undefined,
      });
      setResult({ ...r, labels: a.labels.map((l) => `${l.label} ${(l.confidence * 100).toFixed(0)}%`) });
    } catch (e) {
      setResult({ ok: false, failures: [(e as Error).message] });
    }
    setPhase("result");
  };

  if (!req) return <div class="ptu-empty">This requirement no longer exists.</div>;
  if (phase === "camera")
    return (
      <PhotoCapture
        challenge={challenge}
        onCapture={(p) => {
          setCaptured(p);
          if (challenge) setPhase("confirm");
          else void submit(p, false);
        }}
        onCancel={props.onDone}
      />
    );
  if (phase === "confirm" && captured)
    return (
      <div class="ptu-camera">
        <div ref={preview} />
        <p>
          Does this photo show: <b>{challenge}</b>?
        </p>
        <div class="ptu-row">
          <button class="ptu-btn primary" onClick={() => void submit(captured, true)}>
            Yes, submit
          </button>
          <button class="ptu-btn" onClick={() => setPhase("camera")}>
            Retake
          </button>
        </div>
      </div>
    );
  if (phase === "checking") return <div class="ptu-empty">Checking the photo on this computer…</div>;
  return (
    <div class="ptu-camera">
      <div ref={preview} />
      {result?.ok ? <h3 style="color:var(--ok)">Photo accepted</h3> : <h3 style="color:var(--bad)">Photo not accepted</h3>}
      {result?.failures.map((f) => (
        <div class="ptu-fail" key={f}>
          {f}
        </div>
      ))}
      {result?.labels && <p class="ptu-hint">Saw: {result.labels.join(", ")}</p>}
      <div class="ptu-row">
        {!result?.ok && (
          <button class="ptu-btn primary" onClick={() => setPhase("camera")}>
            Try again
          </button>
        )}
        <button class="ptu-btn" onClick={props.onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Take a few reference photos of "my place" so later proofs can be compared with them. */
export function ReferencePhotos(props: { state: UiState; commitmentId: string; requirementIndex: number; onDone: () => void }) {
  const [shots, setShots] = useState<number[][]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const need = 3;
  if (shots.length >= need) {
    return (
      <div class="ptu-camera">
        <h3>Saved {shots.length} reference photos</h3>
        <button class="ptu-btn primary" onClick={props.onDone}>
          Done
        </button>
      </div>
    );
  }
  return (
    <div>
      <p>
        Reference photo {shots.length + 1} of {need}: point the camera at your place from different angles.
      </p>
      {busy ? (
        <div class="ptu-empty">Analyzing…</div>
      ) : (
        <PhotoCapture
          onCapture={async (p) => {
            setBusy(true);
            try {
              const a = await analyze(props.state, p);
              const next = [...shots, a.embedding];
              setShots(next);
              if (next.length >= need) await window.ptu.setReferencePhotos(props.commitmentId, props.requirementIndex, next);
            } catch (e) {
              setErr((e as Error).message);
            }
            setBusy(false);
          }}
          onCancel={props.onDone}
        />
      )}
      {err && <div class="ptu-fail">{err}</div>}
    </div>
  );
}

export function ProvePanel(props: { state: UiState; target: ProveTarget; onDone: () => void }) {
  const req = requirementFor(props.state, props.target);
  const [msg, setMsg] = useState("");
  if (!req) return null;
  return (
    <div class="ptu-panel">
      <div class="ptu-row" style="justify-content:space-between;margin:0 0 12px">
        <h2 style="margin:0">{req.kind === "anki" ? "Study" : req.kind === "focus" ? "Focus" : req.kind === "photo" ? "Photo proof" : "Prove"}</h2>
        <button class="ptu-btn small" onClick={props.onDone}>
          Back
        </button>
      </div>
      {req.kind === "anki" && <StudyPanel state={props.state} deckIds={(req as AnkiRequirement).deckIds} target={(req as AnkiRequirement).mode === "count" ? (req as AnkiRequirement).count ?? 20 : undefined} />}
      {req.kind === "focus" && (
        <>
          <FocusTimer
            minutes={req.minutesPerSession ?? 25}
            onComplete={async (minutes) => {
              const r = await window.ptu.proveFocus(props.target.commitmentId, minutes);
              setMsg(r.ok ? `Session recorded (${minutes} min).` : r.failures.join(", "));
            }}
          />
          {msg && <p class="ptu-note">{msg}</p>}
        </>
      )}
      {req.kind === "photo" && <PhotoPanel state={props.state} target={props.target} onDone={props.onDone} />}
      {(req.kind === "presence" || req.kind === "altitude") && <div class="ptu-empty">This one needs your phone (location / barometer).</div>}
    </div>
  );
}

export const DESKTOP_CAPS = { anki: true, focus: true, photo: true, presence: false, altitude: false } as const;
