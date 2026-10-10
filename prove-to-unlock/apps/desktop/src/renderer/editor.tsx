// Commitment / places / rules editor. Edits a draft of the shared config; saving signs a new
// config record that syncs to every linked device.

import { useState } from "preact/hooks";
import { type Commitment, type Config, type Place, type Requirement, type RequireMode, randomId } from "@ptu/core";
import { describeRequirement } from "@ptu/ui";
import type { UiState } from "../shared/api.js";
import { ReferencePhotos } from "./proving.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const num = (v: string, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function defaultRequirement(kind: Requirement["kind"], places: Place[]): Requirement {
  switch (kind) {
    case "photo":
      return { kind, repeatMaxHamming: 8 };
    case "presence":
      return { kind, placeId: places[0]?.id ?? "", minutes: 30 };
    case "altitude":
      return { kind, direction: "down", floors: 1, metersPerFloor: 3, toleranceM: 1 };
    case "anki":
      return { kind, mode: "due" };
    case "focus":
      return { kind, sessions: 2, minutesPerSession: 25 };
  }
}

export const TEMPLATES: { name: string; make: () => Omit<Commitment, "id" | "createdAt"> }[] = [
  {
    name: "Go to the gym (photo + floors)",
    make: () => ({ title: "Go to the gym", enabled: true, days: [1, 2, 3, 4, 5], window: { start: "06:00", end: "24:00" }, requirements: [{ kind: "photo", challenge: true, repeatMaxHamming: 8 }, { kind: "altitude", direction: "down", floors: 2, metersPerFloor: 3, toleranceM: 1 }], require: "all" }),
  },
  { name: "Clear today's Anki cards", make: () => ({ title: "Anki before anything", enabled: true, days: [0, 1, 2, 3, 4, 5, 6], window: { start: "05:00", end: "24:00" }, requirements: [{ kind: "anki", mode: "due" }], require: "all" }) },
  { name: "Deep work (4 Pomodoros)", make: () => ({ title: "Deep work", enabled: true, days: [1, 2, 3, 4, 5], window: { start: "08:00", end: "18:00" }, requirements: [{ kind: "focus", sessions: 4, minutesPerSession: 25 }], require: "all" }) },
];

function RequirementEditor(props: { r: Requirement; places: Place[]; decks: UiState["decks"]; onChange: (r: Requirement) => void; onRemove: () => void; onReference?: () => void; refCount?: number }) {
  const { r, places } = props;
  const set = (patch: Partial<Requirement>) => props.onChange({ ...r, ...patch } as Requirement);
  const placeSelect = (value: string | undefined, onChange: (v: string | undefined) => void, allowNone: boolean) => (
    <select value={value ?? ""} onChange={(e) => onChange((e.target as HTMLSelectElement).value || undefined)}>
      {allowNone && <option value="">anywhere</option>}
      {places.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
  return (
    <div class="req-edit">
      <select value={r.kind} onChange={(e) => props.onChange(defaultRequirement((e.target as HTMLSelectElement).value as Requirement["kind"], places))}>
        <option value="photo">Photo</option>
        <option value="presence">Be at a place</option>
        <option value="altitude">Floors up/down</option>
        <option value="anki">Anki</option>
        <option value="focus">Focus sessions</option>
      </select>
      {r.kind === "photo" && (
        <>
          <label>at {placeSelect(r.placeId, (v) => set({ placeId: v }), true)}</label>
          <label>
            must show{" "}
            <input type="text" placeholder="e.g. dumbbell, barbell" value={(r.labelsAny ?? []).join(", ")} onChange={(e) => set({ labelsAny: (e.target as HTMLInputElement).value.split(",").map((s) => s.trim()).filter(Boolean) })} />
          </label>
          <label>
            <input type="checkbox" checked={!!r.challenge} onChange={(e) => set({ challenge: (e.target as HTMLInputElement).checked })} /> random challenge
          </label>
          <label>
            <input
              type="checkbox"
              checked={r.minReferenceSimilarity !== undefined}
              onChange={(e) => set({ minReferenceSimilarity: (e.target as HTMLInputElement).checked ? 0.6 : undefined })}
            />{" "}
            must look like my place
          </label>
          {r.minReferenceSimilarity !== undefined && props.onReference && (
            <button class="ptu-btn small" onClick={props.onReference}>
              {props.refCount ? `Retake reference photos (${props.refCount})` : "Take reference photos"}
            </button>
          )}
        </>
      )}
      {r.kind === "presence" && (
        <>
          <label>at {placeSelect(r.placeId, (v) => set({ placeId: v ?? "" }), false)}</label>
          <label>
            for <input type="number" min={1} max={600} value={r.minutes} onChange={(e) => set({ minutes: num((e.target as HTMLInputElement).value, 30) })} /> min
          </label>
        </>
      )}
      {r.kind === "altitude" && (
        <>
          <select value={r.direction} onChange={(e) => set({ direction: (e.target as HTMLSelectElement).value as "down" | "up" })}>
            <option value="down">down</option>
            <option value="up">up</option>
          </select>
          <label>
            <input type="number" min={1} max={100} value={r.floors} onChange={(e) => set({ floors: num((e.target as HTMLInputElement).value, 1) })} /> floor(s)
          </label>
          <label>
            × <input type="number" step="0.1" min={2} max={6} value={r.metersPerFloor ?? 3} onChange={(e) => set({ metersPerFloor: num((e.target as HTMLInputElement).value, 3) })} /> m
          </label>
        </>
      )}
      {r.kind === "anki" && (
        <>
          <select value={r.mode} onChange={(e) => set({ mode: (e.target as HTMLSelectElement).value as "due" | "count" })}>
            <option value="due">clear today's cards</option>
            <option value="count">do N reviews</option>
          </select>
          {r.mode === "count" && <input type="number" min={1} max={2000} value={r.count ?? 20} onChange={(e) => set({ count: num((e.target as HTMLInputElement).value, 20) })} />}
          <label>
            decks{" "}
            <select
              multiple
              onChange={(e) => set({ deckIds: Array.from((e.target as HTMLSelectElement).selectedOptions).map((o) => o.value) })}
            >
              {props.decks.map((d) => (
                <option key={d.id} value={d.id} selected={(r.deckIds ?? []).includes(d.id)}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <span class="ptu-hint">(none selected = all decks)</span>
        </>
      )}
      {r.kind === "focus" && (
        <>
          <input type="number" min={1} max={20} value={r.sessions} onChange={(e) => set({ sessions: num((e.target as HTMLInputElement).value, 1) })} />
          <label>
            sessions of <input type="number" min={5} max={180} value={r.minutesPerSession ?? 25} onChange={(e) => set({ minutesPerSession: num((e.target as HTMLInputElement).value, 25) })} /> min
          </label>
        </>
      )}
      <button class="ptu-btn small danger" onClick={props.onRemove} title="Remove">
        ✕
      </button>
    </div>
  );
}

function RequirementsBlock(props: {
  reqs: Requirement[];
  require: RequireMode;
  places: Place[];
  decks: UiState["decks"];
  onChange: (reqs: Requirement[], require: RequireMode) => void;
  onReference?: (i: number) => void;
  refCounts?: (i: number) => number;
}) {
  const { reqs } = props;
  return (
    <div class="reqs-block">
      {reqs.map((r, i) => (
        <RequirementEditor
          key={i}
          r={r}
          places={props.places}
          decks={props.decks}
          onChange={(nr) => props.onChange(reqs.map((x, j) => (j === i ? nr : x)), props.require)}
          onRemove={() => props.onChange(reqs.filter((_, j) => j !== i), props.require)}
          onReference={props.onReference ? () => props.onReference!(i) : undefined}
          refCount={props.refCounts?.(i)}
        />
      ))}
      <div class="ptu-row">
        <button class="ptu-btn small" onClick={() => props.onChange([...reqs, defaultRequirement("focus", props.places)], props.require)}>
          + Add requirement
        </button>
        <label>
          Need{" "}
          <select
            value={props.require === "all" ? "all" : String(props.require.any)}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              props.onChange(reqs, v === "all" ? "all" : { any: Number(v) });
            }}
          >
            <option value="all">all of them</option>
            {reqs.slice(0, -1).map((_, i) => (
              <option key={i} value={String(i + 1)}>
                any {i + 1}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

function CommitmentForm(props: { c: Commitment; config: Config; state: UiState; onSave: (c: Commitment) => void; onCancel: () => void }) {
  const [c, setC] = useState<Commitment>(structuredClone(props.c));
  const [refFor, setRefFor] = useState<number | null>(null);
  const places = props.config.places;
  if (refFor !== null) return <ReferencePhotos state={props.state} commitmentId={c.id} requirementIndex={refFor} onDone={() => setRefFor(null)} />;
  return (
    <div class="card form">
      <label class="field">
        Name <input type="text" value={c.title} onInput={(e) => setC({ ...c, title: (e.target as HTMLInputElement).value })} />
      </label>
      <div class="field">
        Days{" "}
        {DAYS.map((d, i) => (
          <label key={d} class="day">
            <input
              type="checkbox"
              checked={c.days.includes(i)}
              onChange={(e) => setC({ ...c, days: (e.target as HTMLInputElement).checked ? [...c.days, i].sort() : c.days.filter((x) => x !== i) })}
            />
            {d}
          </label>
        ))}
      </div>
      <div class="field">
        Locked from <input type="time" value={c.window.start} onChange={(e) => setC({ ...c, window: { ...c.window, start: (e.target as HTMLInputElement).value } })} /> until{" "}
        <input
          type="time"
          value={c.window.end === "24:00" ? "23:59" : c.window.end}
          onChange={(e) => {
            const v = (e.target as HTMLInputElement).value;
            setC({ ...c, window: { ...c.window, end: v === "23:59" ? "24:00" : v } });
          }}
        />{" "}
        <span class="ptu-hint">(or until proven)</span>
      </div>
      <h4>To unlock</h4>
      <RequirementsBlock
        reqs={c.requirements}
        require={c.require}
        places={places}
        decks={props.state.decks}
        onChange={(requirements, require) => setC({ ...c, requirements, require })}
        onReference={(i) => setRefFor(i)}
        refCounts={(i) => props.state.settings.referenceCounts[`${c.id}:${i}`] ?? 0}
      />
      <h4>
        <label>
          <input
            type="checkbox"
            checked={!!c.away}
            disabled={!places.length}
            onChange={(e) =>
              setC({ ...c, away: (e.target as HTMLInputElement).checked ? { regionPlaceId: places[0]!.id, requirements: [defaultRequirement("focus", places)], require: "all" } : undefined })
            }
          />{" "}
          When I'm away from my area, do something else instead
        </label>
      </h4>
      {!places.length && <p class="ptu-hint">Add a place (your city / reachable area) below to use this.</p>}
      {c.away && (
        <>
          <label class="field">
            My reachable area{" "}
            <select value={c.away.regionPlaceId} onChange={(e) => setC({ ...c, away: { ...c.away!, regionPlaceId: (e.target as HTMLSelectElement).value } })}>
              {places.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({(p.radiusM / 1000).toFixed(1)} km)
                </option>
              ))}
            </select>
          </label>
          <RequirementsBlock
            reqs={c.away.requirements}
            require={c.away.require}
            places={places}
            decks={props.state.decks}
            onChange={(requirements, require) => setC({ ...c, away: { ...c.away!, requirements, require } })}
          />
        </>
      )}
      <div class="ptu-row">
        <button class="ptu-btn primary" disabled={!c.title.trim() || !c.days.length || !c.requirements.length} onClick={() => props.onSave(c)}>
          Save
        </button>
        <button class="ptu-btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function PlacesEditor(props: { places: Place[]; onChange: (p: Place[]) => void }) {
  const set = (i: number, patch: Partial<Place>) => props.onChange(props.places.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div class="card">
      <p class="ptu-hint">Places are easiest to set on your phone's map (drop a pin, drag the radius). You can also enter coordinates here.</p>
      {props.places.map((p, i) => (
        <div class="req-edit" key={p.id}>
          <input type="text" value={p.name} onInput={(e) => set(i, { name: (e.target as HTMLInputElement).value })} />
          <label>
            lat <input type="number" step="0.00001" value={p.lat} onChange={(e) => set(i, { lat: num((e.target as HTMLInputElement).value, p.lat) })} />
          </label>
          <label>
            lon <input type="number" step="0.00001" value={p.lon} onChange={(e) => set(i, { lon: num((e.target as HTMLInputElement).value, p.lon) })} />
          </label>
          <label>
            radius <input type="number" min={10} max={500000} value={p.radiusM} onChange={(e) => set(i, { radiusM: num((e.target as HTMLInputElement).value, p.radiusM) })} /> m
          </label>
          <a href={`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=17/${p.lat}/${p.lon}`} target="_blank" rel="noreferrer">
            map
          </a>
          <button class="ptu-btn small danger" onClick={() => props.onChange(props.places.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button class="ptu-btn small" onClick={() => props.onChange([...props.places, { id: randomId(8), name: "New place", lat: 0, lon: 0, radiusM: 100 }])}>
        + Add place
      </button>
    </div>
  );
}

export function RulesEditor(props: { state: UiState; save: (c: Config) => Promise<void> }) {
  const config = props.state.config;
  const [editing, setEditing] = useState<Commitment | null>(null);
  const [excuseDay, setExcuseDay] = useState("");

  const saveCommitment = (c: Commitment) =>
    props.save({ ...config, commitments: config.commitments.some((x) => x.id === c.id) ? config.commitments.map((x) => (x.id === c.id ? c : x)) : [...config.commitments, c] }).then(() => setEditing(null));

  if (editing) return <CommitmentForm c={editing} config={config} state={props.state} onSave={(c) => void saveCommitment(c)} onCancel={() => setEditing(null)} />;

  return (
    <div class="stack">
      <section>
        <h2>Commitments</h2>
        {config.commitments.length === 0 && <p class="ptu-hint">No commitments yet. Start from a template:</p>}
        {config.commitments.map((c) => (
          <div class="card row" key={c.id}>
            <div>
              <b>{c.title}</b> <span class="ptu-hint">{c.days.map((d) => DAYS[d]).join(" ")} · {c.window.start}–{c.window.end}</span>
              <div class="ptu-hint">{c.requirements.map(describeRequirement).join(c.require === "all" ? " + " : " or ")}</div>
              {props.state.streaks[c.id] ? <div class="streak">🔥 {props.state.streaks[c.id]} day streak</div> : null}
            </div>
            <span class="spacer" />
            <label>
              <input type="checkbox" checked={c.enabled} onChange={(e) => void props.save({ ...config, commitments: config.commitments.map((x) => (x.id === c.id ? { ...x, enabled: (e.target as HTMLInputElement).checked } : x)) })} /> on
            </label>
            <button class="ptu-btn small" onClick={() => setEditing(c)}>
              Edit
            </button>
            <button class="ptu-btn small danger" onClick={() => confirm(`Delete "${c.title}"?`) && void props.save({ ...config, commitments: config.commitments.filter((x) => x.id !== c.id) })}>
              Delete
            </button>
          </div>
        ))}
        <div class="ptu-row">
          {TEMPLATES.map((t) => (
            <button key={t.name} class="ptu-btn small" onClick={() => setEditing({ ...t.make(), id: randomId(8), createdAt: Date.now() })}>
              + {t.name}
            </button>
          ))}
          <button
            class="ptu-btn small"
            onClick={() => setEditing({ id: randomId(8), title: "", enabled: true, days: [1, 2, 3, 4, 5], window: { start: "06:00", end: "24:00" }, requirements: [], require: "all", createdAt: Date.now() })}
          >
            + Blank
          </button>
        </div>
      </section>

      <section>
        <h2>Places</h2>
        <PlacesEditor places={config.places} onChange={(places) => void props.save({ ...config, places })} />
      </section>

      <section>
        <h2>Excused days</h2>
        <div class="card">
          <p class="ptu-hint">
            Sick or rest days must be set in advance (before the lock starts that day). Up to {config.policy.maxExcusedPerMonth} per month.
          </p>
          {config.excused
            .slice()
            .sort((a, b) => a.day.localeCompare(b.day))
            .map((e) => (
              <div key={e.day} class="ptu-row">
                {e.day} {e.reason && <span class="ptu-hint">{e.reason}</span>}
                <button class="ptu-btn small" onClick={() => void props.save({ ...config, excused: config.excused.filter((x) => x.day !== e.day) })}>
                  remove
                </button>
              </div>
            ))}
          <div class="ptu-row">
            <input type="date" value={excuseDay} onChange={(e) => setExcuseDay((e.target as HTMLInputElement).value)} />
            <button class="ptu-btn small" disabled={!excuseDay} onClick={() => void props.save({ ...config, excused: [...config.excused.filter((x) => x.day !== excuseDay), { day: excuseDay, createdAt: Date.now() }] }).then(() => setExcuseDay(""))}>
              Excuse this day
            </button>
          </div>
        </div>
      </section>

      <section>
        <h2>Rules</h2>
        <div class="card grid2">
          <label>
            Emergency unlock length (min) <input type="number" min={1} max={120} value={config.policy.emergencyMinutes} onChange={(e) => void props.save({ ...config, policy: { ...config.policy, emergencyMinutes: num((e.target as HTMLInputElement).value, 15) } })} />
          </label>
          <label>
            Excused days per month <input type="number" min={0} max={31} value={config.policy.maxExcusedPerMonth} onChange={(e) => void props.save({ ...config, policy: { ...config.policy, maxExcusedPerMonth: num((e.target as HTMLInputElement).value, 4) } })} />
          </label>
          <label>
            Away days per month <input type="number" min={0} max={31} value={config.policy.maxAwayDaysPerMonth} onChange={(e) => void props.save({ ...config, policy: { ...config.policy, maxAwayDaysPerMonth: num((e.target as HTMLInputElement).value, 10) } })} />
          </label>
          <label>
            Min. time reading an answer (ms) <input type="number" min={0} max={30000} step={100} value={config.policy.minAnswerMs} onChange={(e) => void props.save({ ...config, policy: { ...config.policy, minAnswerMs: num((e.target as HTMLInputElement).value, 1200) } })} />
          </label>
        </div>
      </section>

      <section>
        <h2>Essentials</h2>
        <div class="card grid2">
          <label class="col">
            Apps always allowed (one per line: app name, bundle id or .exe name)
            <textarea rows={6} value={config.essentials.apps.join("\n")} onChange={(e) => void props.save({ ...config, essentials: { ...config.essentials, apps: lines((e.target as HTMLTextAreaElement).value) } })} />
          </label>
          <label class="col">
            Websites always allowed (one per line)
            <textarea rows={6} value={config.essentials.sites.join("\n")} onChange={(e) => void props.save({ ...config, essentials: { ...config.essentials, sites: lines((e.target as HTMLTextAreaElement).value) } })} />
          </label>
        </div>
      </section>
    </div>
  );
}

function lines(s: string): string[] {
  return [...new Set(s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))];
}
