import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Config } from "@ptu/core";
import { EscHold, Status } from "@ptu/ui";
import "@ptu/ui/ui.css";
import "./app.css";
import type { DiscoveredDeviceInfo, PairingInfo, UiState } from "../shared/api.js";
import { RulesEditor } from "./editor.js";
import { useAction, useUiState } from "./hooks.js";
import { DESKTOP_CAPS, ProvePanel, type ProveTarget, StudyPanel } from "./proving.js";

type Tab = "today" | "rules" | "cards" | "devices" | "settings" | "log";

function Today(props: { state: UiState }) {
  const [target, setTarget] = useState<ProveTarget | null>(null);
  const [msg, run] = useAction();
  const s = props.state;
  if (target) return <ProvePanel state={s} target={target} onDone={() => setTarget(null)} />;
  return (
    <div class="stack">
      <div class={`hero ${s.lock.locked ? "locked" : "open"}`}>
        <div class="lock-glyph">{s.lock.locked ? "🔒" : "🔓"}</div>
        <div>
          <h1>{s.lock.locked ? "Locked to essentials" : "Unlocked"}</h1>
          <p class="ptu-sub">{s.settings.testMode ? "Test mode is on: nothing is actually blocked." : s.lock.locked ? "Prove today's commitment to unlock." : "You're free."}</p>
        </div>
        <span class="spacer" />
        {s.lock.locked && (
          <button class="ptu-btn" onClick={() => void run(() => window.ptu.showLockScreen())}>
            Show lock screen
          </button>
        )}
      </div>
      <Status state={s.lock} caps={DESKTOP_CAPS} onProve={(kind, commitmentId, requirementIndex) => setTarget({ kind, commitmentId, requirementIndex })} />
      {s.lock.emergencyUntil && <p class="ptu-note">Emergency unlock until {new Date(s.lock.emergencyUntil).toLocaleTimeString()}.</p>}
      <div class="ptu-row">
        <EscHold onTrigger={() => void run(() => window.ptu.emergency("Esc hold on dashboard"))} label={`Emergency unlock: hold Esc 3s (${s.config.policy.emergencyMinutes} min)`} />
      </div>
      {msg && <div class="ptu-fail">{msg}</div>}
    </div>
  );
}

function Cards(props: { state: UiState }) {
  const [msg, run, setMsg] = useAction();
  const [studying, setStudying] = useState(false);
  if (studying)
    return (
      <div class="stack">
        <div class="ptu-row">
          <button class="ptu-btn small" onClick={() => setStudying(false)}>
            Back
          </button>
        </div>
        <StudyPanel state={props.state} />
      </div>
    );
  return (
    <div class="stack">
      <div class="ptu-row">
        <button
          class="ptu-btn primary"
          onClick={() =>
            void run(async () => {
              const r = await window.ptu.importDeck();
              if (!r.cancelled) setMsg([`Imported ${r.imported.map((d) => `${d.name} (${d.cards} cards)`).join(", ") || "nothing"}.`, ...r.warnings].join(" "));
            })
          }
        >
          Import Anki deck (.apkg)
        </button>
        <button class="ptu-btn" disabled={!props.state.decks.length} onClick={() => setStudying(true)}>
          Study now
        </button>
      </div>
      {msg && <p class="ptu-note">{msg}</p>}
      {props.state.decks.map((d) => (
        <div class="card row" key={d.id}>
          <b>{d.name}</b> <span class="ptu-hint">{d.cards} cards · imported {new Date(d.importedAt).toLocaleDateString()}</span>
          <span class="spacer" />
          <button class="ptu-btn small danger" onClick={() => confirm(`Remove deck "${d.name}"? Review history is kept.`) && void run(() => window.ptu.deleteDeck(d.id))}>
            Remove
          </button>
        </div>
      ))}
      {!props.state.decks.length && <p class="ptu-hint">Export a deck from Anki (File → Export → Anki Deck Package) and import it here. Review history syncs to your linked devices.</p>}
    </div>
  );
}

function Devices(props: { state: UiState }) {
  const s = props.state;
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [now, setNow] = useState(Date.now());
  const [found, setFound] = useState<DiscoveredDeviceInfo[]>([]);
  const [manual, setManual] = useState({ host: "", port: "47123", code: "" });
  const [codeFor, setCodeFor] = useState<DiscoveredDeviceInfo | null>(null);
  const [msg, run, setMsg] = useAction();
  const [name, setName] = useState(s.device.name);

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      void window.ptu.discover().then(setFound);
    }, 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (pairing && now > pairing.expiresAt) setPairing(null);
  }, [now]);
  const peersBefore = s.peers.length;
  useEffect(() => {
    if (pairing && s.peers.length > peersBefore) setPairing(null);
  }, [s.peers.length]);

  return (
    <div class="stack">
      <section class="card">
        <h3>This computer</h3>
        <div class="ptu-row">
          <input type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <button class="ptu-btn small" onClick={() => void run(() => window.ptu.setDeviceName(name))}>
            Rename
          </button>
        </div>
        <p class="ptu-hint">
          Fingerprint <code>{s.device.fingerprint}</code> · {s.device.hosts.join(", ") || "no network"} port {s.device.port}
        </p>
      </section>

      <section class="card">
        <h3>Link a phone, browser extension or computer</h3>
        <p class="ptu-hint">Linking works over your Wi-Fi only. No account and no cloud: devices trust each other's keys directly.</p>
        {pairing ? (
          <div class="pairing">
            <img src={pairing.qr} width={240} height={240} alt="pairing QR code" />
            <div>
              <p>
                Scan with the phone app, or enter this code in the extension / other computer:
              </p>
              <div class="code">{pairing.code}</div>
              <p class="ptu-hint">
                Fingerprint {pairing.fingerprint} · expires in {Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000))}s
              </p>
              <button class="ptu-btn small" onClick={() => void run(async () => (await window.ptu.cancelPairing(), setPairing(null)))}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button class="ptu-btn primary" onClick={() => void run(async () => setPairing(await window.ptu.startPairing()))}>
            Show pairing code
          </button>
        )}
      </section>

      <section class="card">
        <h3>Computers nearby</h3>
        {found.filter((d) => !d.paired).length === 0 && <p class="ptu-hint">Looking… (open Prove to Unlock on your other computer, same Wi-Fi)</p>}
        {found
          .filter((d) => !d.paired)
          .map((d) => (
            <div class="ptu-row" key={d.deviceId}>
              <b>{d.name}</b> <span class="ptu-hint">{d.fingerprint}</span>
              <button class="ptu-btn small" onClick={() => setCodeFor(d)}>
                Link…
              </button>
            </div>
          ))}
        {codeFor && (
          <div class="ptu-row">
            Code shown on {codeFor.name}: <input type="text" inputMode="numeric" maxLength={6} value={manual.code} onInput={(e) => setManual({ ...manual, code: (e.target as HTMLInputElement).value })} />
            <button
              class="ptu-btn small primary"
              onClick={() =>
                void run(async () => {
                  const r = await window.ptu.pairWith(codeFor.hosts, codeFor.port, manual.code);
                  setMsg(`Linked with ${r.name}.`);
                  setCodeFor(null);
                })
              }
            >
              Link
            </button>
          </div>
        )}
        <details>
          <summary>Enter an address instead</summary>
          <div class="ptu-row">
            <input type="text" placeholder="192.168.1.20" value={manual.host} onInput={(e) => setManual({ ...manual, host: (e.target as HTMLInputElement).value })} />
            <input type="number" value={manual.port} onInput={(e) => setManual({ ...manual, port: (e.target as HTMLInputElement).value })} />
            <input type="text" placeholder="6-digit code" value={manual.code} onInput={(e) => setManual({ ...manual, code: (e.target as HTMLInputElement).value })} />
            <button
              class="ptu-btn small primary"
              onClick={() =>
                void run(async () => {
                  const r = await window.ptu.pairWith([manual.host.trim()], Number(manual.port), manual.code);
                  setMsg(`Linked with ${r.name}.`);
                })
              }
            >
              Link
            </button>
          </div>
        </details>
      </section>

      <section class="card">
        <div class="ptu-row" style="margin-top:0">
          <h3 style="margin:0">Linked devices</h3>
          <span class="spacer" />
          <button class="ptu-btn small" onClick={() => void run(() => window.ptu.syncNow())}>
            Sync now
          </button>
        </div>
        {s.peers.length === 0 && <p class="ptu-hint">None yet.</p>}
        {s.peers.map((p) => (
          <div class="ptu-row" key={p.deviceId}>
            <span>{p.platform === "ios" ? "📱" : p.platform === "extension" ? "🧩" : "💻"}</span>
            <b>{p.name}</b>
            <span class="ptu-hint">last seen {p.lastSeenAt ? new Date(p.lastSeenAt).toLocaleString() : "never"}</span>
            <span class="spacer" />
            <button class="ptu-btn small danger" onClick={() => confirm(`Unlink ${p.name}? Its proofs stop counting here.`) && void run(() => window.ptu.removePeer(p.deviceId))}>
              Unlink
            </button>
          </div>
        ))}
      </section>
      {msg && <p class="ptu-note">{msg}</p>}
    </div>
  );
}

function Settings(props: { state: UiState }) {
  const s = props.state.settings;
  const [msg, run] = useAction();
  const toggle = (key: "testMode" | "browsersEssential" | "quitBlockedApps" | "launchAtLogin", label: string, hint: string) => (
    <label class="setting">
      <input type="checkbox" checked={s[key]} onChange={(e) => void run(() => window.ptu.updateSettings({ [key]: (e.target as HTMLInputElement).checked }))} />
      <div>
        <b>{label}</b>
        <div class="ptu-hint">{hint}</div>
      </div>
    </label>
  );
  return (
    <div class="stack card">
      {toggle("testMode", "Test mode", "Try everything without being blocked: the lock screen is a normal window and apps are only logged, not covered. Turn off to make it real. (Can't be turned back on while locked.)")}
      {toggle("launchAtLogin", "Start at login", "Needed for the lock to apply after a restart.")}
      {toggle("browsersEssential", "Browsers are essential", "Keep browsers usable; the browser extension blocks distracting sites instead.")}
      {toggle("quitBlockedApps", "Also quit blocked apps", "Politely ask non-essential apps to quit (they can still prompt you to save). Off = only cover them.")}
      <label class="setting">
        <input type="number" min={0} max={9999} value={s.newCardsPerDay} onChange={(e) => void run(() => window.ptu.updateSettings({ newCardsPerDay: Number((e.target as HTMLInputElement).value) }))} />
        <div>
          <b>New Anki cards per day</b>
        </div>
      </label>
      {!props.state.foregroundSupported && <p class="ptu-note">App detection isn't available on this system, so the lock screen stays up instead of allowing essential apps.</p>}
      {msg && <div class="ptu-fail">{msg}</div>}
    </div>
  );
}

function Log(props: { state: UiState }) {
  return (
    <div class="card log">
      {props.state.log
        .slice()
        .reverse()
        .map((l, i) => (
          <div key={i}>
            <span class="ptu-hint">{new Date(l.at).toLocaleTimeString()}</span> {l.msg}
          </div>
        ))}
    </div>
  );
}

function Onboarding(props: { state: UiState }) {
  return (
    <div class="card onboarding">
      <h2>Welcome to Prove to Unlock</h2>
      <ol>
        <li>Create a commitment (e.g. “Go to the gym” or “Clear my Anki cards”) under <b>Rules</b>.</li>
        <li>Link your phone under <b>Devices</b> so photo, location and floor proofs count here.</li>
        <li>
          You're in <b>test mode</b>: nothing is blocked yet. When you're happy, turn test mode off in <b>Settings</b>.
        </li>
        <li>Failsafe: hold <kbd>Esc</kbd> for 3 seconds on the lock screen for an emergency unlock. It always works, even offline.</li>
      </ol>
      <button class="ptu-btn primary" onClick={() => void window.ptu.updateSettings({ onboarded: true })}>
        Got it
      </button>
    </div>
  );
}

function Dashboard() {
  const state = useUiState();
  const [tab, setTab] = useState<Tab>("today");
  const [msg, run] = useAction();
  if (!state) return null;
  const save = (c: Config) => run(() => window.ptu.updateConfig(c));
  const tabs: [Tab, string][] = [
    ["today", "Today"],
    ["rules", "Rules"],
    ["cards", "Cards"],
    ["devices", "Devices"],
    ["settings", "Settings"],
    ["log", "Log"],
  ];
  return (
    <div class="dash">
      <nav>
        <div class="brand">Prove to Unlock</div>
        {tabs.map(([t, label]) => (
          <button key={t} class={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
        <span class="spacer" />
        {state.settings.testMode && <div class="test-pill">TEST MODE</div>}
      </nav>
      <main>
        {!state.settings.onboarded && <Onboarding state={state} />}
        {msg && <div class="ptu-fail banner">{msg}</div>}
        {tab === "today" && <Today state={state} />}
        {tab === "rules" && <RulesEditor state={state} save={save} />}
        {tab === "cards" && <Cards state={state} />}
        {tab === "devices" && <Devices state={state} />}
        {tab === "settings" && <Settings state={state} />}
        {tab === "log" && <Log state={state} />}
      </main>
    </div>
  );
}

render(<Dashboard />, document.getElementById("app")!);
