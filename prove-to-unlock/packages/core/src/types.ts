// Domain model shared by every platform. The Swift port (apps/ios/ProveCore) mirrors these
// shapes field-for-field; spec/protocol.md documents them.

/** "HH:MM", 24h, local time. "24:00" is allowed as an end time. */
export type TimeOfDay = string;
/** Local calendar day, "YYYY-MM-DD". */
export type DayKey = string;

/** A circle on the map (Life360-style pin + radius). */
export interface Place {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
}

export type RequirementKind = "photo" | "presence" | "altitude" | "anki" | "focus";

export interface PhotoRequirement {
  kind: "photo";
  /** Photo must be taken inside this place (GPS). */
  placeId?: string;
  /** At least one of these labels must be detected (case-insensitive substring match). */
  labelsAny?: string[];
  minLabelConfidence?: number;
  /** Similarity (0..1) to the reference photos of "my place" must be at least this. */
  minReferenceSimilarity?: number;
  /** A photo whose dHash is within this Hamming distance of an earlier proof photo is a repeat. */
  repeatMaxHamming?: number;
  /** Require a random challenge ("hold up 3 fingers") to be confirmed. */
  challenge?: boolean;
}

export interface PresenceRequirement {
  kind: "presence";
  placeId: string;
  minutes: number;
}

export interface AltitudeRequirement {
  kind: "altitude";
  direction: "down" | "up";
  floors: number;
  metersPerFloor?: number;
  toleranceM?: number;
}

export interface AnkiRequirement {
  kind: "anki";
  /** "due": clear today's queue. "count": do at least `count` honest reviews today. */
  mode: "due" | "count";
  count?: number;
  /** Restrict to these decks (all decks if omitted). */
  deckIds?: string[];
}

export interface FocusRequirement {
  kind: "focus";
  sessions: number;
  minutesPerSession?: number;
}

export type Requirement =
  | PhotoRequirement
  | PresenceRequirement
  | AltitudeRequirement
  | AnkiRequirement
  | FocusRequirement;

/** "all" or "at least N of the requirements". */
export type RequireMode = "all" | { any: number };

export interface AwayPolicy {
  /** The reachable region (big circle). Outside it for most of the day => "away". */
  regionPlaceId: string;
  /** Substitute requirements while away. Empty => away counts as excused (not recommended). */
  requirements: Requirement[];
  require: RequireMode;
}

export interface Commitment {
  id: string;
  title: string;
  enabled: boolean;
  /** Days of week this applies, 0 = Sunday .. 6 = Saturday. */
  days: number[];
  window: { start: TimeOfDay; end: TimeOfDay };
  requirements: Requirement[];
  require: RequireMode;
  away?: AwayPolicy;
  createdAt: number;
}

export interface ExcusedDay {
  day: DayKey;
  /** Must be before the commitment window starts on that day to count. */
  createdAt: number;
  reason?: string;
}

export interface Policy {
  maxExcusedPerMonth: number;
  maxAwayDaysPerMonth: number;
  /** Length of an emergency unlock. */
  emergencyMinutes: number;
  /** Fraction of location samples outside the region needed to count as away. */
  awayOutsideFraction: number;
  /** Minimum span of location samples (hours) before "away" can be claimed. */
  awayMinHours: number;
  /** Reviews answered faster than this (ms after the answer was shown) don't count. */
  minAnswerMs: number;
}

export interface Essentials {
  /** Desktop app names / bundle ids / exe names always allowed. */
  apps: string[];
  /** Hostnames always allowed in the browser. */
  sites: string[];
}

export interface Config {
  rev: number;
  updatedAt: number;
  commitments: Commitment[];
  places: Place[];
  excused: ExcusedDay[];
  policy: Policy;
  essentials: Essentials;
}

export const DEFAULT_POLICY: Policy = {
  maxExcusedPerMonth: 4,
  maxAwayDaysPerMonth: 10,
  emergencyMinutes: 15,
  awayOutsideFraction: 0.75,
  awayMinHours: 4,
  minAnswerMs: 1200,
};

export const DEFAULT_ESSENTIALS: Essentials = {
  apps: [],
  sites: [
    "accounts.google.com",
    "login.microsoftonline.com",
    "appleid.apple.com",
    "maps.google.com",
    "www.google.com/maps",
    "ankiweb.net",
  ],
};

// ---------------------------------------------------------------------------------------------
// Record bodies

export interface PhotoLabel {
  label: string;
  confidence: number;
}

export interface PhotoDetail {
  /** 64-bit difference hash, 16 hex chars. */
  dhash: string;
  labels: PhotoLabel[];
  referenceSimilarity?: number;
  placeId?: string;
  insidePlace?: boolean;
  /** Captured live by the app's own camera (no gallery). */
  live: boolean;
  capturedAt: number;
  challenge?: { prompt: string; confirmed: boolean };
}

export interface PresenceDetail {
  placeId: string;
  from: number;
  to: number;
}

export interface AltitudeDetail {
  deltaM: number;
  samples: number;
  startedAt: number;
  endedAt: number;
}

export interface AnkiDetail {
  reviews: number;
  cleared: boolean;
  deckIds: string[];
}

export interface FocusDetail {
  sessions: number;
  minutes: number;
}

export type ProofDetailMap = {
  photo: PhotoDetail;
  presence: PresenceDetail;
  altitude: AltitudeDetail;
  anki: AnkiDetail;
  focus: FocusDetail;
};

export type ProofBody = {
  [K in RequirementKind]: { cid: string; day: DayKey; kind: K; at: number; detail: ProofDetailMap[K] };
}[RequirementKind];

export interface UnlockBody {
  cid: string;
  day: DayKey;
  until: number;
  proofIds: string[];
}

export interface EmergencyBody {
  day: DayKey;
  until: number;
  reason?: string;
}

export type ConfigBody = Config;

export interface StatusBody {
  cid: string;
  day: DayKey;
  region: "in" | "away";
  outsideFraction: number;
  spanHours: number;
}
