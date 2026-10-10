import { useEffect, useState } from "preact/hooks";
import type { UiState } from "../shared/api.js";

export function useUiState(): UiState | null {
  const [s, setS] = useState<UiState | null>(null);
  useEffect(() => {
    let alive = true;
    void window.ptu.getState().then((x) => alive && setS(x));
    const off = window.ptu.onState((x) => alive && setS(x));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return s;
}

/** Run an async action, surfacing errors from the main process as a message. */
export function useAction(): [string, (fn: () => Promise<unknown>) => Promise<void>, (m: string) => void] {
  const [msg, setMsg] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setMsg("");
    try {
      await fn();
    } catch (e) {
      // Electron prefixes IPC errors with "Error invoking remote method ...: Error: "
      setMsg(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  return [msg, run, setMsg];
}
