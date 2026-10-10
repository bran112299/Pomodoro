// Messages between extension pages (lock / options / popup) and the background worker.

import type { Config, Deck, DeckSummary, LockState, ReviewEvent } from "@ptu/core";

export interface ExtState {
  device: { id: string; name: string };
  lock: LockState;
  config: Config;
  link: { name: string; host: string; port: number; lastSync?: number; error?: string } | null;
  decks: DeckSummary[];
  hostAccess: boolean;
}

export type Request =
  | { type: "getState" }
  | { type: "emergency"; reason?: string }
  | { type: "pair"; port: number; code: string }
  | { type: "unpair" }
  | { type: "syncNow" }
  | { type: "getStudyData" }
  | { type: "addReview"; event: ReviewEvent }
  | { type: "proveFocus"; commitmentId: string; minutes: number }
  | { type: "importDecks"; decks: Deck[] }
  | { type: "deleteDeck"; id: string }
  | { type: "updateConfig"; config: Config }
  | { type: "setName"; name: string };

export type Response<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

export function ext(): typeof chrome {
  return ((globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome) as typeof chrome;
}

export async function send<T>(req: Request): Promise<T> {
  const res = (await ext().runtime.sendMessage(req)) as Response<T> | undefined;
  if (!res) throw new Error("the extension background isn't responding");
  if (!res.ok) throw new Error(res.error);
  return res.value;
}
