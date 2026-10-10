import { useEffect, useState } from "preact/hooks";

/**
 * A Pomodoro focus session. Uses wall-clock end time (not tick counting) so throttled background
 * timers can't drift. Leaving early cancels the session; only completed sessions count.
 */
export function FocusTimer(props: { minutes?: number; onComplete: (minutes: number) => void }) {
  const [minutes, setMinutes] = useState(props.minutes ?? 25);
  const [endAt, setEndAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (endAt === null) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= endAt) {
        setEndAt(null);
        props.onComplete(minutes);
      }
    }, 250);
    return () => clearInterval(t);
  }, [endAt, minutes]);

  if (endAt === null) {
    return (
      <div class="ptu-focus">
        <label>
          Session length{" "}
          <select value={minutes} onChange={(e) => setMinutes(Number((e.target as HTMLSelectElement).value))}>
            {[15, 25, 30, 45, 50, 60, 90].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>
        <button class="ptu-btn primary" onClick={() => setEndAt(Date.now() + minutes * 60_000)}>
          Start focus session
        </button>
      </div>
    );
  }
  const left = Math.max(0, endAt - now);
  const mm = String(Math.floor(left / 60_000)).padStart(2, "0");
  const ss = String(Math.floor((left % 60_000) / 1000)).padStart(2, "0");
  return (
    <div class="ptu-focus running">
      <div class="ptu-clock">
        {mm}:{ss}
      </div>
      <p>Work in your essential apps. The session counts when the timer reaches zero.</p>
      <button class="ptu-btn" onClick={() => setEndAt(null)}>
        Give up this session
      </button>
    </div>
  );
}
