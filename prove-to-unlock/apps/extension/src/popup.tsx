import { render } from "preact";
import "@ptu/ui/ui.css";
import "./ext.css";
import { ext } from "./messages.js";
import { useExtState } from "./pages.js";

function Popup() {
  const [state] = useExtState(1500);
  if (!state) return <div class="popup">…</div>;
  const locked = state.lock.locked;
  const pending = state.lock.commitments.filter((c) => c.locked);
  return (
    <div class="popup">
      <h2>{locked ? "🔒 Locked" : "🔓 Unlocked"}</h2>
      {pending.map((c) => (
        <div key={c.commitment.id} class="ptu-hint">
          {c.commitment.title}: {c.requirements.filter((r) => !r.ok).map((r) => r.progress).join(", ")}
        </div>
      ))}
      {state.lock.emergencyUntil && <div class="ptu-note">Emergency until {new Date(state.lock.emergencyUntil).toLocaleTimeString()}</div>}
      <div class="ptu-row">
        {locked && (
          <button class="ptu-btn primary" onClick={() => void ext().tabs.create({ url: ext().runtime.getURL("lock.html") })}>
            Prove it
          </button>
        )}
        <button class="ptu-btn" onClick={() => ext().runtime.openOptionsPage()}>
          Settings
        </button>
      </div>
      {state.link?.error && <div class="ptu-fail">{state.link.error}</div>}
    </div>
  );
}

render(<Popup />, document.getElementById("app")!);
