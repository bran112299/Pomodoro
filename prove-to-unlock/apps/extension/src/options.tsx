import { render } from "preact";
import { useState } from "preact/hooks";
import initSqlJs from "sql.js";
import { type Commitment, type Config, importApkg, randomId } from "@ptu/core";
import { describeRequirement } from "@ptu/ui";
import "@ptu/ui/ui.css";
import "./ext.css";
import { type ExtState, ext, send } from "./messages.js";
import { useAction, useExtState } from "./pages.js";

function Link(props: { state: ExtState; refresh: () => void }) {
  const [port, setPort] = useState("47123");
  const [code, setCode] = useState("");
  const [msg, run, setMsg] = useAction(props.refresh);
  const l = props.state.link;
  return (
    <section class="card">
      <h2>Desktop app</h2>
      {l ? (
        <>
          <p>
            Linked with <b>{l.name}</b> on port {l.port}. {l.lastSync ? `Last sync ${new Date(l.lastSync).toLocaleTimeString()}.` : ""}
          </p>
          {l.error && <p class="ptu-fail">{l.error}</p>}
          <div class="ptu-row">
            <button class="ptu-btn" onClick={() => void run(() => send({ type: "syncNow" }))}>
              Sync now
            </button>
            <button class="ptu-btn danger" onClick={() => confirm("Unlink from the desktop app?") && void run(() => send({ type: "unpair" }))}>
              Unlink
            </button>
          </div>
        </>
      ) : (
        <>
          <p class="ptu-hint">
            In the Prove to Unlock desktop app, open <b>Devices → Show pairing code</b>, then enter the 6-digit code here. The extension then follows the same commitments, and proofs from your phone unlock the browser too.
          </p>
          <div class="ptu-row">
            <input type="text" inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} />
            <label>
              port <input type="number" value={port} onInput={(e) => setPort((e.target as HTMLInputElement).value)} />
            </label>
            <button
              class="ptu-btn primary"
              disabled={!/^\d{6}$/.test(code.trim())}
              onClick={() =>
                void run(async () => {
                  const name = await send<string>({ type: "pair", port: Number(port), code });
                  setMsg(`Linked with ${name}.`);
                })
              }
            >
              Link
            </button>
          </div>
        </>
      )}
      {msg && <p class="ptu-note">{msg}</p>}
    </section>
  );
}

function Permissions(props: { state: ExtState; refresh: () => void }) {
  if (props.state.hostAccess) return null;
  return (
    <section class="card warn">
      <h2>One more step</h2>
      <p>The extension needs access to all sites so it can redirect blocked ones to the lock page and talk to the desktop app.</p>
      <button
        class="ptu-btn primary"
        onClick={() => void ext().permissions.request({ origins: ["<all_urls>"] }).then(props.refresh)}
      >
        Allow access
      </button>
    </section>
  );
}

function Decks(props: { state: ExtState; refresh: () => void }) {
  const [msg, run, setMsg] = useAction(props.refresh);
  return (
    <section class="card">
      <h2>Anki decks</h2>
      {props.state.link && <p class="ptu-hint">Decks imported in the desktop app sync here automatically.</p>}
      <label class="ptu-btn">
        Import .apkg
        <input
          type="file"
          accept=".apkg,.colpkg"
          style="display:none"
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (!f) return;
            void run(async () => {
              const SQL = await initSqlJs({ locateFile: (n: string) => ext().runtime.getURL(n) });
              const r = importApkg(new Uint8Array(await f.arrayBuffer()), { sql: SQL, fileName: f.name });
              await send({ type: "importDecks", decks: r.decks });
              setMsg([`Imported ${r.decks.map((d) => `${d.name} (${d.cards.length})`).join(", ") || "nothing"}.`, ...r.warnings].join(" "));
            });
          }}
        />
      </label>
      {props.state.decks.map((d) => (
        <div class="ptu-row" key={d.id}>
          <b>{d.name}</b> <span class="ptu-hint">{d.cards} cards</span>
          <span class="spacer" />
          <button class="ptu-btn small danger" onClick={() => void run(() => send({ type: "deleteDeck", id: d.id }))}>
            Remove
          </button>
        </div>
      ))}
      {msg && <p class="ptu-note">{msg}</p>}
    </section>
  );
}

const QUICK: { name: string; make: () => Omit<Commitment, "id" | "createdAt"> }[] = [
  { name: "20 Anki reviews before browsing", make: () => ({ title: "Anki before browsing", enabled: true, days: [0, 1, 2, 3, 4, 5, 6], window: { start: "05:00", end: "24:00" }, requirements: [{ kind: "anki", mode: "count", count: 20 }], require: "all" }) },
  { name: "Clear today's Anki cards", make: () => ({ title: "Clear Anki first", enabled: true, days: [0, 1, 2, 3, 4, 5, 6], window: { start: "05:00", end: "24:00" }, requirements: [{ kind: "anki", mode: "due" }], require: "all" }) },
  { name: "2 focus sessions before browsing", make: () => ({ title: "Focus first", enabled: true, days: [1, 2, 3, 4, 5], window: { start: "08:00", end: "18:00" }, requirements: [{ kind: "focus", sessions: 2, minutesPerSession: 25 }], require: "all" }) },
];

function Rules(props: { state: ExtState; refresh: () => void }) {
  const [msg, run] = useAction(props.refresh);
  const c = props.state.config;
  const save = (next: Config) => run(() => send({ type: "updateConfig", config: next }));
  const [sites, setSites] = useState(c.essentials.sites.join("\n"));
  return (
    <section class="card">
      <h2>Commitments</h2>
      {props.state.link ? (
        <p class="ptu-hint">Edit commitments in the desktop app; they sync here.</p>
      ) : (
        <p class="ptu-hint">Standalone mode. For photo, gym, location and floor proofs, use the desktop and phone apps.</p>
      )}
      {c.commitments.map((k) => (
        <div class="ptu-row" key={k.id}>
          <b>{k.title}</b>
          <span class="ptu-hint">
            {k.window.start}–{k.window.end} · {k.requirements.map(describeRequirement).join(" + ")}
          </span>
          <span class="spacer" />
          {!props.state.link && (
            <button class="ptu-btn small danger" onClick={() => void save({ ...c, commitments: c.commitments.filter((x) => x.id !== k.id) })}>
              Remove
            </button>
          )}
        </div>
      ))}
      {!props.state.link && (
        <div class="ptu-row">
          {QUICK.map((q) => (
            <button key={q.name} class="ptu-btn small" onClick={() => void save({ ...c, commitments: [...c.commitments, { ...q.make(), id: randomId(8), createdAt: Date.now() }] })}>
              + {q.name}
            </button>
          ))}
        </div>
      )}
      <h3>Always-allowed sites</h3>
      <textarea rows={6} value={sites} onInput={(e) => setSites((e.target as HTMLTextAreaElement).value)} disabled={!!props.state.link} />
      {!props.state.link && (
        <div class="ptu-row">
          <button class="ptu-btn small" onClick={() => void save({ ...c, essentials: { ...c.essentials, sites: [...new Set(sites.split(/\s+/).map((s) => s.trim()).filter(Boolean))] } })}>
            Save sites
          </button>
        </div>
      )}
      {msg && <p class="ptu-fail">{msg}</p>}
    </section>
  );
}

function Options() {
  const [state, refresh] = useExtState(2000);
  if (!state) return null;
  return (
    <div class="options">
      <h1>Prove to Unlock</h1>
      <p class="ptu-sub">
        {state.lock.locked ? "🔒 Locked: only essential sites work right now." : "🔓 Unlocked."} This browser: {state.device.name}
      </p>
      <Permissions state={state} refresh={refresh} />
      <Link state={state} refresh={refresh} />
      <Rules state={state} refresh={refresh} />
      <Decks state={state} refresh={refresh} />
    </div>
  );
}

render(<Options />, document.getElementById("app")!);
