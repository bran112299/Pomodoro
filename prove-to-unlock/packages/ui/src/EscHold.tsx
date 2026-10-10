import { useEffect, useRef, useState } from "preact/hooks";

/**
 * The failsafe: hold Esc (or press and hold the button) for `seconds` to trigger an emergency
 * unlock. Holding (not tapping) prevents accidents; it never requires network or the phone.
 */
export function EscHold(props: { seconds?: number; onTrigger: () => void; label?: string; disabled?: boolean }) {
  const seconds = props.seconds ?? 3;
  const [progress, setProgress] = useState(0);
  const start = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const fired = useRef(false);

  const tick = () => {
    if (start.current === null) return;
    const p = Math.min(1, (performance.now() - start.current) / (seconds * 1000));
    setProgress(p);
    if (p >= 1) {
      if (!fired.current) {
        fired.current = true;
        props.onTrigger();
      }
      stop();
      return;
    }
    raf.current = requestAnimationFrame(tick);
  };

  const begin = () => {
    if (props.disabled || start.current !== null) return;
    fired.current = false;
    start.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  };

  const stop = () => {
    start.current = null;
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    setProgress(0);
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        begin();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", stop);
      stop();
    };
  }, [props.disabled, seconds]);

  const r = 16;
  const c = 2 * Math.PI * r;
  return (
    <button
      class="ptu-esc"
      disabled={props.disabled}
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      title={`Hold Esc for ${seconds} seconds`}
    >
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r={r} fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="4" />
        <circle
          cx="20"
          cy="20"
          r={r}
          fill="none"
          stroke="currentColor"
          stroke-width="4"
          stroke-dasharray={c}
          stroke-dashoffset={c * (1 - progress)}
          transform="rotate(-90 20 20)"
        />
      </svg>
      <span>{props.label ?? `Emergency: hold Esc ${seconds}s`}</span>
    </button>
  );
}
