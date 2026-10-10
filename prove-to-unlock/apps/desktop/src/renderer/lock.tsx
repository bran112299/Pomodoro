import { render } from "preact";
import { useState } from "preact/hooks";
import { EscHold, Status } from "@ptu/ui";
import "@ptu/ui/ui.css";
import "./app.css";
import { useAction, useUiState } from "./hooks.js";
import { DESKTOP_CAPS, ProvePanel, type ProveTarget } from "./proving.js";

const params = new URLSearchParams(location.search);
const primary = params.get("primary") !== "0";
const test = params.get("test") === "1";

function fmtTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function Lock() {
  const state = useUiState();
  const [target, setTarget] = useState<ProveTarget | null>(null);
  const [msg, run] = useAction();
  if (!state) return null;

  if (!primary) {
    return (
      <div class="lock-secondary">
        <div class="lock-glyph">🔒</div>
        <p>Locked. Use the main screen to unlock.</p>
      </div>
    );
  }

  const locked = state.lock.locked;
  const ends = state.lock.commitments.filter((c) => c.locked).map((c) => c.windowEnd);
  return (
    <div class="lock">
      {test && <div class="test-banner">TEST MODE: nothing is actually blocked. Close this window or press “Essentials only” to continue.</div>}
      <header class="lock-head">
        <div class="lock-glyph">{locked ? "🔒" : "🔓"}</div>
        <div>
          <h1>{locked ? "Locked to essentials" : "Unlocked"}</h1>
          <p class="ptu-sub">
            {locked ? `Prove today's commitment to unlock everything${ends.length ? ` · the lock ends at ${fmtTime(Math.min(...ends))} anyway` : ""}.` : "Nice work. Everything is open."}
          </p>
        </div>
      </header>

      {state.overlay.blockedApp && <div class="blocked">“{state.overlay.blockedApp}” isn't an essential app, so it was covered.</div>}

      <main class="lock-main">
        {target ? (
          <ProvePanel state={state} target={target} onDone={() => setTarget(null)} />
        ) : (
          <Status state={state.lock} caps={DESKTOP_CAPS} onProve={(kind, commitmentId, requirementIndex) => setTarget({ kind, commitmentId, requirementIndex })} />
        )}
      </main>

      <footer class="lock-foot">
        <button class="ptu-btn" onClick={() => void run(() => window.ptu.essentialsMode())}>
          Essentials only
        </button>
        <button class="ptu-btn" onClick={() => void run(() => window.ptu.showDashboard())}>
          Settings & devices
        </button>
        <span class="spacer" />
        <EscHold
          seconds={3}
          onTrigger={() => void run(() => window.ptu.emergency("Esc hold on lock screen"))}
          label={`Emergency: hold Esc 3s (${state.config.policy.emergencyMinutes} min, resets streak)`}
        />
      </footer>
      {msg && <div class="ptu-fail" style="text-align:center">{msg}</div>}
    </div>
  );
}

render(<Lock />, document.getElementById("app")!);
