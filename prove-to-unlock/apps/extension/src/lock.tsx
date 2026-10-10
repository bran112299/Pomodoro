import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { AnkiRequirement, Deck, FocusRequirement, Requirement, ReviewEvent } from "@ptu/core";
import { EscHold, FocusTimer, Review, Status } from "@ptu/ui";
import "@ptu/ui/ui.css";
import "./ext.css";
import { type ExtState, ext, send } from "./messages.js";
import { EXT_CAPS, useAction, useExtState } from "./pages.js";

interface Target {
  kind: Requirement["kind"];
  commitmentId: string;
  requirementIndex: number;
}

function Study(props: { state: ExtState; req: AnkiRequirement; refresh: () => void }) {
  const [data, setData] = useState<{ decks: Deck[]; events: ReviewEvent[] } | null>(null);
  useEffect(() => {
    void send<{ decks: Deck[]; events: ReviewEvent[] }>({ type: "getStudyData" }).then(setData);
  }, []);
  if (!data) return <div class="ptu-empty">Loading cards…</div>;
  return (
    <Review
      decks={data.decks}
      events={data.events}
      deviceId={props.state.device.id}
      newPerDay={20}
      minAnswerMs={props.state.config.policy.minAnswerMs}
      deckIds={props.req.deckIds}
      target={props.req.mode === "count" ? props.req.count ?? 20 : undefined}
      onReview={async (event) => {
        await send({ type: "addReview", event });
        setData((d) => (d ? { ...d, events: [...d.events, event] } : d));
        props.refresh();
      }}
    />
  );
}

function Lock() {
  const [state, refresh] = useExtState(1000);
  const [target, setTarget] = useState<Target | null>(null);
  const [msg, run, setMsg] = useAction(refresh);
  if (!state) return null;
  const locked = state.lock.locked;
  const reqStatus = target ? state.lock.commitments.find((c) => c.commitment.id === target.commitmentId)?.requirements[target.requirementIndex] : undefined;
  const req = reqStatus?.requirement;

  return (
    <div class="lock">
      <header class="lock-head">
        <div class="lock-glyph">{locked ? "🔒" : "🔓"}</div>
        <div>
          <h1>{locked ? "This site is blocked for now" : "Unlocked"}</h1>
          <p class="ptu-sub">{locked ? "Only essential sites work until you prove today's commitment." : "You can go back to browsing."}</p>
        </div>
      </header>

      {!locked && (
        <div class="ptu-row">
          <button class="ptu-btn primary" onClick={() => history.length > 1 ? history.back() : window.close()}>
            Go back
          </button>
        </div>
      )}

      {target && req ? (
        <div class="ptu-panel">
          <div class="ptu-row" style="justify-content:space-between;margin:0 0 12px">
            <h2 style="margin:0">{req.kind === "anki" ? "Study" : "Focus"}</h2>
            <button class="ptu-btn small" onClick={() => setTarget(null)}>
              Back
            </button>
          </div>
          {req.kind === "anki" && <Study state={state} req={req} refresh={refresh} />}
          {req.kind === "focus" && (
            <FocusTimer
              minutes={(req as FocusRequirement).minutesPerSession ?? 25}
              onComplete={(minutes) =>
                void run(async () => {
                  await send({ type: "proveFocus", commitmentId: target.commitmentId, minutes });
                  setMsg("Session recorded.");
                })
              }
            />
          )}
        </div>
      ) : (
        <Status state={state.lock} caps={EXT_CAPS} onProve={(kind, commitmentId, requirementIndex) => setTarget({ kind, commitmentId, requirementIndex })} />
      )}

      <footer class="lock-foot">
        <button class="ptu-btn" onClick={() => ext().runtime.openOptionsPage()}>
          Settings
        </button>
        <span class="spacer" />
        <EscHold
          onTrigger={() => void run(() => send({ type: "emergency", reason: "Esc hold in browser" }))}
          label={`Emergency: hold Esc 3s (${state.config.policy.emergencyMinutes} min, resets streak)`}
        />
      </footer>
      {msg && <p class="ptu-note">{msg}</p>}
    </div>
  );
}

render(<Lock />, document.getElementById("app")!);
