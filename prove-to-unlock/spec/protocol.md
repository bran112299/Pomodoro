# Prove to Unlock: linking protocol

How devices trust each other and share proofs **without accounts or a cloud**. Implemented in
`packages/core` (TypeScript) and `apps/ios/ProveCore` (Swift). Both are tested against
`spec/vectors/*.json`, so they agree exactly.

## Device identity

- Every device has an **ECDSA P-256** key pair. On iPhone the private key lives in the Secure
  Enclave when available.
- Public keys travel as **SPKI DER, base64**. CryptoKit's `derRepresentation` and WebCrypto's
  `spki` export are byte-for-byte identical (tested).
- **Device id** = first 8 bytes of SHA-256(SPKI), as hex (16 characters). Because the id comes
  from the key, a device can't claim someone else's id.
- **Fingerprint** = the same 8 bytes in upper-case groups (`3F9A-12CD-77B0-E415`), shown during
  pairing so a person can compare them.
- **Signatures** are raw `r||s` (64 bytes, IEEE P1363) over SHA-256.

## Signed records

Everything that changes the lock state is a record:

```
base64url(JSON payload) "." base64url(signature over the ASCII of the first part)
```

Payload:

```json
{ "v": 1, "typ": "proof|unlock|emergency|config|status", "id": "<random>", "iss": "<device id>", "iat": 1791810000000, "body": { } }
```

| typ | body | meaning |
|---|---|---|
| `proof` | `{cid, day, kind, at, detail}` | Evidence for one requirement of commitment `cid` on local day `day`. `kind` is `photo`, `presence`, `altitude`, `anki` or `focus`, and `detail` depends on it (see `types.ts`). |
| `emergency` | `{day, until, reason?}` | Unlock everything until `until`. Logged, and it resets the streak. |
| `config` | the full shared `Config` | Commitments, places, excused days, policy, essentials. The highest `rev` wins; ties go to the later `updatedAt`, then the higher record id. |
| `status` | `{cid, day, region, outsideFraction, spanHours}` | "Away" detected by the phone's location (switches to the substitute requirements). |
| `unlock` | `{cid, day, until, proofIds}` | Explicit unlock (reserved; devices normally re-derive unlocks from proofs). |

A record is accepted only if `iss` is a **trusted** device (this device or a paired one), the
signature verifies, and `iat` is no more than 5 minutes in the future. Records are kept
permanently: photo repeat detection compares against every earlier photo.

**Every device computes the lock state itself** from the shared config plus all verified
records, using the same rules (`evaluate()` / `Engine.evaluate`). Nothing is decided by a
server, and a relaying device can't forge or change a proof.

## Network

Computers run an HTTP server on port **47123** (or a random one if that's taken) and advertise
`_provetounlock._tcp` over mDNS with TXT `id=<device id>`, `fp=<fingerprint>`, `v=1`. Phones and
browser extensions are clients only.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/info` | none | `{deviceId, name, platform, publicKey, protocol, fingerprint, pairing}` |
| POST | `/v1/pair` | 6-digit code | `{code, device: DeviceHello, listen?: {hosts, port}}` → `{device}` |
| POST | `/v1/sync` | signed | `{records[], reviews[], since: {records, reviews}}` → `{records[], reviews[], cursor, accepted, rejected}` |
| GET | `/v1/trust` | signed | `{devices: DeviceHello[]}`: the extension adopts its computer's trusted devices |
| GET | `/v1/decks` | signed | `{decks: [{id, name, cards, importedAt}]}` |
| GET | `/v1/decks/<id>` | signed | one `Deck` with its media |

### Pairing

1. The computer shows a **6-digit code**, valid for 5 minutes, single use, and locked after 5
   wrong guesses. It also shows a QR code:
   `ptu://pair?v=1&h=<ip,ip>&p=<port>&id=<deviceId>&fp=<fingerprint>&c=<code>&n=<name>`
   (form-encoded, so spaces become `+`).
2. The other device POSTs `/v1/pair` with the code and its own `DeviceHello`. Both sides add each
   other as trusted. The phone also checks that the computer's fingerprint matches the QR code.

### Signed requests

```
Authorization: PTU1 deviceId=<id>,ts=<ms>,sig=<base64url>
signature over: "PTU1\n" METHOD "\n" path+query "\n" ts "\n" base64url(SHA-256(body))
```

The server rejects a request if its timestamp is more than 2 minutes off, if the device isn't
paired, or if the same signature was already used (replay).

### Sync

Each device keeps one increasing sequence number across its records and review events.
The caller sends everything newer than what it last *pushed* to this peer, plus the peer's cursor
of what it last *pulled*. The response contains everything the caller hasn't seen and the new
cursor. Both sides deduplicate records and reviews by id, so repeating a sync is harmless.

### Anki review sync

Review events (`{id, cardId, deckId, rating, at, answerShownAt, deviceId}`) form a merge-only
log. Card state is a **pure replay** of that log through FSRS-5, so every device computes the
same schedule. Reviews count toward a commitment only if the answer was visible for
`policy.minAnswerMs` before rating ("honest reviews"). Each device claims only its own reviews in
its proofs, so nothing is double-counted.
