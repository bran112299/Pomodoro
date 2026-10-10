# prove-to-unlock

> **Prove with X you can do Y before unlocking Z.**

Your Mac, PC or iPhone stays locked down to the essentials until you've done what you said you'd do today and proved it.

> "Go to the gym today." → take a fresh photo at the gym → everything unlocks.

Nothing is locked forever. You get access by showing evidence that you did something, not by asking for it.

## The pattern

| Slot | Role | Gym example | Anki example |
|---|---|---|---|
| **X** | The evidence | A new photo taken at the gym today | Today's due reviews finished |
| **Y** | What it proves | You actually went | You actually studied |
| **Z** | What it unlocks | Your full device | Your full device |

**Z depends on proof, not on promises.**

## How a day works

1. **Commit.** In the morning, say what today's task is: "Go to the gym today." The device locks to essentials only.
2. **Do it.** Go to the gym.
3. **Prove it.** Take a photo *inside the app* while you're there.
4. **Verify.** The app checks that the photo is new, real and from today (see below).
5. **Unlock.** Everything opens until the next commitment window.

## Verifying a photo (the anti-repeat check)

Layered checks. Each one makes cheating more work than just going.

| Check | What it catches |
|---|---|
| **Taken in the app, live camera only, no camera roll** | Old photos, downloaded photos. This matters most: EXIF is easy to edit, but a photo the app captured itself never passes through a file you could edit. |
| **Timestamp is today, within the commitment window** | Yesterday's photo |
| **GPS is inside the gym's geofence** (location set once at setup) | A photo taken at home |
| **Perceptual hash (pHash/dHash) compared with every past proof photo; a small Hamming distance means a repeat** | The same shot taken again, or a photo of a photo |
| **Image analysis: does it look like a gym? Is it a screen or a printout?** | A picture of a monitor showing an old photo |
| **Optional random challenge: "hold up 3 fingers," "include something blue"** | Pre-staged photos. A prompt you couldn't predict means the photo must be live. |

### Threat model: honest by design

This isn't meant to stop a determined attacker. It's meant to make **doing the task easier than faking it**. Someone who spoofs GPS and forges a live capture to skip the gym is only cheating themselves. The goal is enough friction that the honest path is always the lazy one.

## The lockdown

Block everything except an allowlist of essentials: phone, messages, maps, banking, the authenticator app, and the prove-to-unlock app itself.

| Platform | How | Notes |
|---|---|---|
| **iPhone / iPad** | Apple Screen Time API (`FamilyControls` + `ManagedSettings` shields + `DeviceActivity` schedules) | The supported, proven route; apps like Opal and one sec use it. Needs the Family Controls entitlement from Apple. Emergency calls/SOS can never be blocked, which is a built-in failsafe. |
| **Mac** | Screen Time API where available, otherwise a Network Extension content filter plus an app-launch blocker | Harder to make tamper-resistant against an admin user, so tie it to a separate admin account or a delay before settings can change. |
| **Windows PC** | Background service plus firewall/hosts rules plus a process blocker | The most bypassable. Fine for the "honest by design" goal. |

One account, synced across devices: proving on your phone unlocks the Mac too.

## Failsafe (required)

Being locked out of something important is worse than skipping the gym.

- **Always allowed:** calls, emergency SOS, messages, maps, banking, 2FA apps, and a user-editable allowlist.
- **Emergency unlock:** always available, but it **costs something**. Examples: a 10-minute wait, typing a long phrase, or giving up your streak. Every use is logged.
- **Excused days:** a sick or rest day is set *in advance*, not in the moment.
- **Dead-man switch:** if the app crashes or the server can't be reached for N hours, the device unlocks. The app must never brick a device.

## Other proof types (same engine)

- **Anki:** unlock when today's due reviews are done (checked via AnkiConnect on desktop). You have to actually answer honestly for this to be worth anything.
- **Pomodoro:** N finished focus sessions (the original seed, from this repo).
- **Steps or workouts:** Apple Health / HealthKit data.
- **Reading or writing:** a short summary of what you read, or a word count.

## Core model

```
rule {
  commitment: "Go to the gym today"
  evidence:   photo { live_capture, geofence: gym, window: today, unique_vs_history }
  unlocks:    device_full_access
  until:      next_commitment_window
  failsafe:   { allowlist, emergency_cost: "10 min delay + streak reset" }
}
```

## Roadmap

- [ ] iPhone MVP: Screen Time shields + allowlist + one rule (gym photo)
- [ ] Live-capture camera + timestamp + geofence check
- [ ] Perceptual-hash history and repeat detection
- [ ] Emergency unlock with cost + log; dead-man switch
- [ ] Image analysis: gym classifier + screen/printout detection
- [ ] Random challenge prompts
- [ ] Mac blocker + cross-device sync
- [ ] Anki and Pomodoro proof types
- [ ] Windows blocker
