// Shared bits for extension pages.

import { useEffect, useState } from "preact/hooks";
import { type ExtState, send } from "./messages.js";

export function useExtState(intervalMs = 1500): [ExtState | null, () => void] {
  const [s, setS] = useState<ExtState | null>(null);
  const refresh = () => void send<ExtState>({ type: "getState" }).then(setS, () => undefined);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, []);
  return [s, refresh];
}

export function useAction(after?: () => void): [string, (fn: () => Promise<unknown>) => Promise<void>, (m: string) => void] {
  const [msg, setMsg] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    }
    after?.();
  };
  return [msg, run, setMsg];
}

export const EXT_CAPS = { anki: true, focus: true, photo: false, presence: false, altitude: false } as const;
