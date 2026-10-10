// The contract between the Electron main process and its windows (exposed via preload as
// `window.ptu`). Everything crossing this boundary is plain JSON.

import type { Config, Deck, DeckSummary, LockState, PeerInfo, PhotoLabel, ReviewEvent } from "@ptu/core";

export interface PublicSettings {
  testMode: boolean;
  browsersEssential: boolean;
  quitBlockedApps: boolean;
  launchAtLogin: boolean;
  newCardsPerDay: number;
  onboarded: boolean;
  /** Number of reference photos per `${commitmentId}:${requirementIndex}`. */
  referenceCounts: Record<string, number>;
}

export interface PairingInfo {
  code: string;
  qr: string; // data: URL of the QR image
  qrText: string;
  fingerprint: string;
  expiresAt: number;
  hosts: string[];
  port: number;
}

export interface DiscoveredDeviceInfo {
  deviceId: string;
  name: string;
  fingerprint: string;
  hosts: string[];
  port: number;
  paired: boolean;
}

export interface LogEntry {
  at: number;
  msg: string;
}

export interface UiState {
  device: { id: string; name: string; platform: string; fingerprint: string; port: number; hosts: string[] };
  lock: LockState;
  config: Config;
  settings: PublicSettings;
  peers: PeerInfo[];
  decks: DeckSummary[];
  streaks: Record<string, number>;
  overlay: { visible: boolean; essentialsMode: boolean; blockedApp?: string };
  foregroundSupported: boolean;
  log: LogEntry[];
  modelUrl: string;
}

export interface PhotoSubmission {
  commitmentId: string;
  requirementIndex: number;
  dhash: string;
  labels: PhotoLabel[];
  embedding: number[];
  capturedAt: number;
  challenge?: { prompt: string; confirmed: boolean };
}

export interface ProofResult {
  ok: boolean;
  failures: string[];
}

export interface ImportResultInfo {
  imported: { id: string; name: string; cards: number }[];
  warnings: string[];
  cancelled?: boolean;
}

export interface PtuApi {
  getState(): Promise<UiState>;
  onState(cb: (s: UiState) => void): () => void;
  updateConfig(next: Config): Promise<Config>;
  updateSettings(patch: Partial<Omit<PublicSettings, "referenceCounts">>): Promise<void>;
  setDeviceName(name: string): Promise<void>;
  emergency(reason?: string): Promise<void>;
  getStudyData(): Promise<{ decks: Deck[]; events: ReviewEvent[] }>;
  addReview(e: ReviewEvent): Promise<void>;
  importDeck(): Promise<ImportResultInfo>;
  deleteDeck(id: string): Promise<void>;
  proveFocus(commitmentId: string, minutes: number): Promise<ProofResult>;
  provePhoto(p: PhotoSubmission): Promise<ProofResult>;
  setReferencePhotos(commitmentId: string, requirementIndex: number, embeddings: number[][]): Promise<void>;
  startPairing(): Promise<PairingInfo>;
  cancelPairing(): Promise<void>;
  discover(): Promise<DiscoveredDeviceInfo[]>;
  pairWith(hosts: string[], port: number, code: string): Promise<{ name: string }>;
  removePeer(deviceId: string): Promise<void>;
  syncNow(): Promise<void>;
  essentialsMode(): Promise<void>;
  showLockScreen(): Promise<void>;
  showDashboard(): Promise<void>;
}

declare global {
  interface Window {
    ptu: PtuApi;
  }
}
