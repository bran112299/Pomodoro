import type { CommitmentStatus, LockState, Requirement } from "@ptu/core";

export function describeRequirement(r: Requirement): string {
  switch (r.kind) {
    case "photo":
      return r.placeId ? "Fresh photo at the place" : "Fresh photo";
    case "presence":
      return `Spend ${r.minutes} min at the place`;
    case "altitude":
      return `Go ${r.floors} floor${r.floors === 1 ? "" : "s"} ${r.direction}`;
    case "anki":
      return r.mode === "due" ? "Finish today's Anki cards" : `Do ${r.count ?? 20} Anki reviews`;
    case "focus":
      return `${r.sessions} focus session${r.sessions === 1 ? "" : "s"} (${r.minutesPerSession ?? 25} min)`;
  }
}

/** Which requirement kinds this device can prove itself. */
export type Capabilities = Partial<Record<Requirement["kind"], boolean>>;

export type ProveHandler = (kind: Requirement["kind"], commitmentId: string, requirementIndex: number) => void;

function CommitmentCard(props: { s: CommitmentStatus; caps: Capabilities; onProve?: ProveHandler }) {
  const { s } = props;
  const need = s.commitment.require === "all" ? "all of these" : `any ${s.commitment.require.any} of these`;
  return (
    <div class={`ptu-commitment ${s.locked ? "locked" : "open"}`}>
      <h3>
        {s.commitment.title}
        {s.mode === "away" && <span class="ptu-tag">away mode</span>}
      </h3>
      <p class="ptu-sub">{s.locked ? `To unlock, do ${need}:` : s.unlockedBy === "proven" ? "Done for today." : s.unlockedBy === "emergency" ? "Emergency unlock active." : s.unlockedBy === "excused" ? "Excused today." : ""}</p>
      <ul class="ptu-reqs">
        {s.requirements.map((r, i) => (
          <li key={i} class={r.ok ? "ok" : ""}>
            <span class="mark">{r.ok ? "✓" : "○"}</span>
            <span class="what">{describeRequirement(r.requirement)}</span>
            <span class="progress">{r.progress}</span>
            {!r.ok && props.onProve && props.caps[r.requirement.kind] && (
              <button class="ptu-btn small" onClick={() => props.onProve!(r.requirement.kind, s.commitment.id, i)}>
                Do it here
              </button>
            )}
            {!r.ok && !props.caps[r.requirement.kind] && <span class="ptu-hint">on your phone</span>}
            {r.failures.length > 0 && <div class="ptu-fail">{r.failures.join(" · ")}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Status(props: { state: LockState; caps: Capabilities; onProve?: ProveHandler }) {
  const active = props.state.commitments.filter((c) => c.unlockedBy !== "disabled" && c.unlockedBy !== "not-today" && c.unlockedBy !== "outside-window");
  if (active.length === 0) return <div class="ptu-empty">No commitments active right now.</div>;
  return (
    <div class="ptu-status">
      {active.map((s) => (
        <CommitmentCard key={s.commitment.id} s={s} caps={props.caps} onProve={props.onProve} />
      ))}
    </div>
  );
}
