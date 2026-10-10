import Foundation

// Mirrors packages/core/src/types.ts field-for-field (JSON compatible both ways).

public typealias DayKey = String

public struct Place: Codable, Equatable, Identifiable, Hashable {
    public var id: String
    public var name: String
    public var lat: Double
    public var lon: Double
    public var radiusM: Double

    public init(id: String, name: String, lat: Double, lon: Double, radiusM: Double) {
        self.id = id
        self.name = name
        self.lat = lat
        self.lon = lon
        self.radiusM = radiusM
    }
}

public enum RequirementKind: String, Codable, CaseIterable {
    case photo, presence, altitude, anki, focus
}

public struct PhotoRequirement: Codable, Equatable {
    public var placeId: String?
    public var labelsAny: [String]?
    public var minLabelConfidence: Double?
    public var minReferenceSimilarity: Double?
    public var repeatMaxHamming: Int?
    public var challenge: Bool?
    public init(placeId: String? = nil, labelsAny: [String]? = nil, minLabelConfidence: Double? = nil, minReferenceSimilarity: Double? = nil, repeatMaxHamming: Int? = 8, challenge: Bool? = nil) {
        self.placeId = placeId
        self.labelsAny = labelsAny
        self.minLabelConfidence = minLabelConfidence
        self.minReferenceSimilarity = minReferenceSimilarity
        self.repeatMaxHamming = repeatMaxHamming
        self.challenge = challenge
    }
}

public struct PresenceRequirement: Codable, Equatable {
    public var placeId: String
    public var minutes: Double
    public init(placeId: String, minutes: Double) {
        self.placeId = placeId
        self.minutes = minutes
    }
}

public struct AltitudeRequirement: Codable, Equatable {
    public enum Direction: String, Codable { case down, up }
    public var direction: Direction
    public var floors: Double
    public var metersPerFloor: Double?
    public var toleranceM: Double?
    public init(direction: Direction, floors: Double, metersPerFloor: Double? = 3, toleranceM: Double? = 1) {
        self.direction = direction
        self.floors = floors
        self.metersPerFloor = metersPerFloor
        self.toleranceM = toleranceM
    }
}

public struct AnkiRequirement: Codable, Equatable {
    public enum Mode: String, Codable { case due, count }
    public var mode: Mode
    public var count: Int?
    public var deckIds: [String]?
    public init(mode: Mode, count: Int? = nil, deckIds: [String]? = nil) {
        self.mode = mode
        self.count = count
        self.deckIds = deckIds
    }
}

public struct FocusRequirement: Codable, Equatable {
    public var sessions: Int
    public var minutesPerSession: Double?
    public init(sessions: Int, minutesPerSession: Double? = 25) {
        self.sessions = sessions
        self.minutesPerSession = minutesPerSession
    }
}

public enum Requirement: Codable, Equatable {
    case photo(PhotoRequirement)
    case presence(PresenceRequirement)
    case altitude(AltitudeRequirement)
    case anki(AnkiRequirement)
    case focus(FocusRequirement)

    public var kind: RequirementKind {
        switch self {
        case .photo: return .photo
        case .presence: return .presence
        case .altitude: return .altitude
        case .anki: return .anki
        case .focus: return .focus
        }
    }

    private enum K: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        switch try c.decode(RequirementKind.self, forKey: .kind) {
        case .photo: self = .photo(try PhotoRequirement(from: decoder))
        case .presence: self = .presence(try PresenceRequirement(from: decoder))
        case .altitude: self = .altitude(try AltitudeRequirement(from: decoder))
        case .anki: self = .anki(try AnkiRequirement(from: decoder))
        case .focus: self = .focus(try FocusRequirement(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case let .photo(r): try r.encode(to: encoder)
        case let .presence(r): try r.encode(to: encoder)
        case let .altitude(r): try r.encode(to: encoder)
        case let .anki(r): try r.encode(to: encoder)
        case let .focus(r): try r.encode(to: encoder)
        }
        var c = encoder.container(keyedBy: K.self)
        try c.encode(kind, forKey: .kind)
    }

    /// Places this requirement depends on.
    public var placeIds: [String] {
        switch self {
        case let .photo(r): return r.placeId.map { [$0] } ?? []
        case let .presence(r): return [r.placeId]
        default: return []
        }
    }
}

public enum RequireMode: Codable, Equatable {
    case all
    case any(Int)

    private struct AnyBox: Codable { var any: Int }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self), s == "all" {
            self = .all
        } else {
            self = .any(try c.decode(AnyBox.self).any)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .all: try c.encode("all")
        case let .any(n): try c.encode(AnyBox(any: n))
        }
    }

    public func required(of n: Int) -> Int {
        switch self {
        case .all: return n
        case let .any(k): return max(0, min(k, n))
        }
    }
}

public struct AwayPolicy: Codable, Equatable {
    public var regionPlaceId: String
    public var requirements: [Requirement]
    public var require: RequireMode
    public init(regionPlaceId: String, requirements: [Requirement], require: RequireMode) {
        self.regionPlaceId = regionPlaceId
        self.requirements = requirements
        self.require = require
    }
}

public struct TimeWindow: Codable, Equatable {
    public var start: String
    public var end: String
    public init(start: String, end: String) {
        self.start = start
        self.end = end
    }
}

public struct Commitment: Codable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var enabled: Bool
    public var days: [Int]
    public var window: TimeWindow
    public var requirements: [Requirement]
    public var require: RequireMode
    public var away: AwayPolicy?
    public var createdAt: Millis

    public init(id: String, title: String, enabled: Bool = true, days: [Int], window: TimeWindow, requirements: [Requirement], require: RequireMode = .all, away: AwayPolicy? = nil, createdAt: Millis) {
        self.id = id
        self.title = title
        self.enabled = enabled
        self.days = days
        self.window = window
        self.requirements = requirements
        self.require = require
        self.away = away
        self.createdAt = createdAt
    }
}

public struct ExcusedDay: Codable, Equatable {
    public var day: DayKey
    public var createdAt: Millis
    public var reason: String?
    public init(day: DayKey, createdAt: Millis, reason: String? = nil) {
        self.day = day
        self.createdAt = createdAt
        self.reason = reason
    }
}

public struct Policy: Codable, Equatable {
    public var maxExcusedPerMonth: Int
    public var maxAwayDaysPerMonth: Int
    public var emergencyMinutes: Double
    public var awayOutsideFraction: Double
    public var awayMinHours: Double
    public var minAnswerMs: Double

    public static let `default` = Policy(maxExcusedPerMonth: 4, maxAwayDaysPerMonth: 10, emergencyMinutes: 15, awayOutsideFraction: 0.75, awayMinHours: 4, minAnswerMs: 1200)

    public init(maxExcusedPerMonth: Int, maxAwayDaysPerMonth: Int, emergencyMinutes: Double, awayOutsideFraction: Double, awayMinHours: Double, minAnswerMs: Double) {
        self.maxExcusedPerMonth = maxExcusedPerMonth
        self.maxAwayDaysPerMonth = maxAwayDaysPerMonth
        self.emergencyMinutes = emergencyMinutes
        self.awayOutsideFraction = awayOutsideFraction
        self.awayMinHours = awayMinHours
        self.minAnswerMs = minAnswerMs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Policy.default
        maxExcusedPerMonth = try c.decodeIfPresent(Int.self, forKey: .maxExcusedPerMonth) ?? d.maxExcusedPerMonth
        maxAwayDaysPerMonth = try c.decodeIfPresent(Int.self, forKey: .maxAwayDaysPerMonth) ?? d.maxAwayDaysPerMonth
        emergencyMinutes = try c.decodeIfPresent(Double.self, forKey: .emergencyMinutes) ?? d.emergencyMinutes
        awayOutsideFraction = try c.decodeIfPresent(Double.self, forKey: .awayOutsideFraction) ?? d.awayOutsideFraction
        awayMinHours = try c.decodeIfPresent(Double.self, forKey: .awayMinHours) ?? d.awayMinHours
        minAnswerMs = try c.decodeIfPresent(Double.self, forKey: .minAnswerMs) ?? d.minAnswerMs
    }
}

public struct Essentials: Codable, Equatable {
    public var apps: [String]
    public var sites: [String]
    public static let `default` = Essentials(apps: [], sites: ["accounts.google.com", "login.microsoftonline.com", "appleid.apple.com", "maps.google.com", "www.google.com/maps", "ankiweb.net"])
    public init(apps: [String], sites: [String]) {
        self.apps = apps
        self.sites = sites
    }
}

public struct Config: Codable, Equatable {
    public var rev: Int
    public var updatedAt: Millis
    public var commitments: [Commitment]
    public var places: [Place]
    public var excused: [ExcusedDay]
    public var policy: Policy
    public var essentials: Essentials

    public static func makeDefault(now: Millis = 0) -> Config {
        Config(rev: 0, updatedAt: now, commitments: [], places: [], excused: [], policy: .default, essentials: .default)
    }

    public init(rev: Int, updatedAt: Millis, commitments: [Commitment], places: [Place], excused: [ExcusedDay], policy: Policy, essentials: Essentials) {
        self.rev = rev
        self.updatedAt = updatedAt
        self.commitments = commitments
        self.places = places
        self.excused = excused
        self.policy = policy
        self.essentials = essentials
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rev = try c.decode(Int.self, forKey: .rev)
        updatedAt = try c.decodeIfPresent(Millis.self, forKey: .updatedAt) ?? 0
        commitments = try c.decodeIfPresent([Commitment].self, forKey: .commitments) ?? []
        places = try c.decodeIfPresent([Place].self, forKey: .places) ?? []
        excused = try c.decodeIfPresent([ExcusedDay].self, forKey: .excused) ?? []
        policy = try c.decodeIfPresent(Policy.self, forKey: .policy) ?? .default
        essentials = try c.decodeIfPresent(Essentials.self, forKey: .essentials) ?? .default
    }
}

// MARK: - Record bodies

public struct PhotoLabel: Codable, Equatable {
    public var label: String
    public var confidence: Double
    public init(label: String, confidence: Double) {
        self.label = label
        self.confidence = confidence
    }
}

public struct PhotoChallenge: Codable, Equatable {
    public var prompt: String
    public var confirmed: Bool
    public init(prompt: String, confirmed: Bool) {
        self.prompt = prompt
        self.confirmed = confirmed
    }
}

public struct PhotoDetail: Codable, Equatable {
    public var dhash: String
    public var labels: [PhotoLabel]
    public var referenceSimilarity: Double?
    public var placeId: String?
    public var insidePlace: Bool?
    public var live: Bool
    public var capturedAt: Millis
    public var challenge: PhotoChallenge?
    public init(dhash: String, labels: [PhotoLabel], referenceSimilarity: Double? = nil, placeId: String? = nil, insidePlace: Bool? = nil, live: Bool, capturedAt: Millis, challenge: PhotoChallenge? = nil) {
        self.dhash = dhash
        self.labels = labels
        self.referenceSimilarity = referenceSimilarity
        self.placeId = placeId
        self.insidePlace = insidePlace
        self.live = live
        self.capturedAt = capturedAt
        self.challenge = challenge
    }
}

public struct PresenceDetail: Codable, Equatable {
    public var placeId: String
    public var from: Millis
    public var to: Millis
    public init(placeId: String, from: Millis, to: Millis) {
        self.placeId = placeId
        self.from = from
        self.to = to
    }
}

public struct AltitudeDetail: Codable, Equatable {
    public var deltaM: Double
    public var samples: Int
    public var startedAt: Millis
    public var endedAt: Millis
    public init(deltaM: Double, samples: Int, startedAt: Millis, endedAt: Millis) {
        self.deltaM = deltaM
        self.samples = samples
        self.startedAt = startedAt
        self.endedAt = endedAt
    }
}

public struct AnkiDetail: Codable, Equatable {
    public var reviews: Int
    public var cleared: Bool
    public var deckIds: [String]
    public init(reviews: Int, cleared: Bool, deckIds: [String]) {
        self.reviews = reviews
        self.cleared = cleared
        self.deckIds = deckIds
    }
}

public struct FocusDetail: Codable, Equatable {
    public var sessions: Int
    public var minutes: Double
    public init(sessions: Int, minutes: Double) {
        self.sessions = sessions
        self.minutes = minutes
    }
}

public enum ProofDetail: Equatable {
    case photo(PhotoDetail)
    case presence(PresenceDetail)
    case altitude(AltitudeDetail)
    case anki(AnkiDetail)
    case focus(FocusDetail)

    public var kind: RequirementKind {
        switch self {
        case .photo: return .photo
        case .presence: return .presence
        case .altitude: return .altitude
        case .anki: return .anki
        case .focus: return .focus
        }
    }
}

public struct ProofBody: Codable, Equatable {
    public var cid: String
    public var day: DayKey
    public var at: Millis
    public var detail: ProofDetail
    public var kind: RequirementKind { detail.kind }

    public init(cid: String, day: DayKey, at: Millis, detail: ProofDetail) {
        self.cid = cid
        self.day = day
        self.at = at
        self.detail = detail
    }

    private enum K: String, CodingKey { case cid, day, kind, at, detail }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        cid = try c.decode(String.self, forKey: .cid)
        day = try c.decode(String.self, forKey: .day)
        at = try c.decode(Millis.self, forKey: .at)
        switch try c.decode(RequirementKind.self, forKey: .kind) {
        case .photo: detail = .photo(try c.decode(PhotoDetail.self, forKey: .detail))
        case .presence: detail = .presence(try c.decode(PresenceDetail.self, forKey: .detail))
        case .altitude: detail = .altitude(try c.decode(AltitudeDetail.self, forKey: .detail))
        case .anki: detail = .anki(try c.decode(AnkiDetail.self, forKey: .detail))
        case .focus: detail = .focus(try c.decode(FocusDetail.self, forKey: .detail))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(cid, forKey: .cid)
        try c.encode(day, forKey: .day)
        try c.encode(kind, forKey: .kind)
        try c.encode(at, forKey: .at)
        switch detail {
        case let .photo(d): try c.encode(d, forKey: .detail)
        case let .presence(d): try c.encode(d, forKey: .detail)
        case let .altitude(d): try c.encode(d, forKey: .detail)
        case let .anki(d): try c.encode(d, forKey: .detail)
        case let .focus(d): try c.encode(d, forKey: .detail)
        }
    }
}

public struct UnlockBody: Codable, Equatable {
    public var cid: String
    public var day: DayKey
    public var until: Millis
    public var proofIds: [String]
}

public struct EmergencyBody: Codable, Equatable {
    public var day: DayKey
    public var until: Millis
    public var reason: String?
    public init(day: DayKey, until: Millis, reason: String? = nil) {
        self.day = day
        self.until = until
        self.reason = reason
    }
}

public struct StatusBody: Codable, Equatable {
    public enum Region: String, Codable { case `in`, away }
    public var cid: String
    public var day: DayKey
    public var region: Region
    public var outsideFraction: Double
    public var spanHours: Double
    public init(cid: String, day: DayKey, region: Region, outsideFraction: Double, spanHours: Double) {
        self.cid = cid
        self.day = day
        self.region = region
        self.outsideFraction = outsideFraction
        self.spanHours = spanHours
    }
}
