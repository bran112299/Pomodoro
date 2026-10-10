# prove-to-unlock

> **Prove with X you can do Y before unlocking Z.**

Your Mac, PC or iPhone stays locked down to the essentials until you've done what you said you'd do today and proved it.

> "Go to the gym today." → take a fresh photo at the gym → everything unlocks.

**This isn't a fitness app.** The gym is just the first example. It's a general **commitment engine**: any task you can prove can be what unlocks your device, whether that's studying, work, chores, appointments, health or habits.

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

### On-device AI (photos never leave the device)

All image checks run on the device. That's private, works offline and costs nothing per check.

| Check | Apple (iOS + macOS), built in |
|---|---|
| "What's in this photo?" labels (gym, dumbbell, bed, book…) | Vision `VNClassifyImageRequest`, a built-in classifier with over 1,000 labels |
| "Is this *my* gym?" + "is this a repeat?" | Vision `VNGenerateImageFeaturePrintRequest`: compare feature-print distances with the reference photos (should be close) and past proofs (shouldn't be nearly identical) |
| Task-specific checks (made bed, a photo of a screen) | A custom Core ML model trained with Create ML |
| Written recaps | Apple's on-device Foundation Models framework (on supported devices) |

The same Vision APIs exist on macOS, so the Mac gets them for free.

**Windows: it doesn't need to verify anything.** Proof happens on the phone, and Windows only *enforces* the lock and listens for a synced "unlocked" signal. If Windows-side checks are needed later, run an open model (e.g. CLIP or MobileNet as ONNX) through ONNX Runtime / Windows ML, using the NPU on Copilot+ PCs.

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

## When you're not near the task area

### Setting places on a map

Places are set like Life360: drop a pin on a map, name it ("Gym," "Home," "Work") and drag a circle to set its radius. You can reuse places across tasks.

On iOS this maps directly onto Core Location region monitoring (`CLCircularRegion` / `CLMonitor`). It wakes the app when you enter or leave a place, even in the background, without draining the battery the way constant GPS tracking would. iOS allows about 20 monitored regions per app, which is plenty for personal places.

### Same building, different floor (e.g. the gym is downstairs)

GPS can't tell floors apart, because your apartment and the gym share the same map point, and GPS altitude is only accurate to about ±10 m. So floor-level places use other signals:

| Signal | How it works | Strength |
|---|---|---|
| **Barometer descent** (`CMAltimeter`) | The iPhone barometer measures *relative* height changes to within tens of centimeters. Tap "Heading to gym," walk down, take the photo: the app requires a drop of about N floors × 3 m. | Good. It uses relative change because absolute pressure drifts with the weather (about 8 m of "height" over a few hours), so you can't compare against a stored floor level. |
| **"Is this *my* gym" image match** | At setup, take a few reference photos of the gym. Proof photos must match them by image embedding similarity, while still not being a repeat of a past proof. | Good. It separates "my building's gym" from "my living room." |
| **Bluetooth beacon** (optional) | Stick a cheap iBeacon (around $15) in the gym. iOS region monitoring (`CLBeaconRegion`) knows when you're in the room. | Strongest. It works at room level even in the background. |

Default for a downstairs gym: **barometer descent + my-gym image match**, with the beacon as an upgrade.

You mark two things for each task:

- **Task area:** the exact place where proof is taken, like the gym's geofence.
- **Reachable region:** the wider area from which you could realistically get there, like your city within about 30 km.

| Where you are | What happens |
|---|---|
| **Inside the reachable region** | **Locked until you go.** "I'm home" isn't an excuse, because the gym is reachable. |
| **Outside the reachable region (traveling)** | **A substitute task, not a free pass.** Examples: a workout logged in Apple Health, or proof at any gym with stricter checks (new-location photo plus the random challenge). |
| **Can't do any version (sick, injured)** | A **pre-declared excused day.** These are limited per month and set in advance, not in the moment. |

**Why not just let you off the hook when you're away?** Because then "away" becomes the cheat: drive 31 km and you're free. So travel status needs to be:

- **Sustained:** outside the region for most of the commitment window, or overnight, not a quick trip past the line.
- **Ideally declared ahead:** "I'm in Chicago Thu–Sun" can be checked against location history.
- **Capped:** a set number of travel days per month before it counts as an excused day.

The rule stays the same everywhere: **the honest path is always easier than the cheat.**

## Beyond fitness: any commitment

The engine doesn't care what the task is. It only needs a **proof type** that can verify it.

### Proof types (the building blocks)

| Proof type | How it's verified |
|---|---|
| **Photo** | Live capture, timestamp, place, repeat check against history, AI checks what's in it |
| **Presence** | Being inside a marked place (pin + radius), on a given floor (barometer), or near a beacon, for N minutes |
| **App or data integration** | Reading real data: AnkiConnect, GitHub, Apple Health, calendar, Duolingo, etc. |
| **Focus time** | N Pomodoros finished with distracting apps closed |
| **Written recap** | A short summary of what you did, checked by AI for substance and compared with past recaps |
| **Witness** | A friend or accountability partner approves the proof |

### Example commitments

| Area | Commitment | Proof |
|---|---|---|
| Fitness | Go to the gym | Photo + presence + floor descent |
| Study | Clear today's Anki reviews | AnkiConnect: due count = 0 |
| Work | Ship something | GitHub: a commit or merged PR today |
| Deep work | 4 hours focused | 8 Pomodoros finished |
| Chores | Clean your room | Before/after photos, with AI comparison |
| Appointments | Go to class / the doctor | Presence at the place during the scheduled time |
| Reading | Read 20 pages | A recap that passes the AI check |
| Health | Sleep 7+ hours, take medication | Apple Health sleep data; photo of the pill organizer |
| Language | Daily practice | Duolingo or Anki streak data |
| Social | Call family | Call log duration (where the platform allows it) |

Commitments can be combined: "Gym **and** Anki before anything unlocks," or "any 2 of these 3."

## Similar apps and what's different here

Researched October 2026. The basic idea, earning screen time with proof, already exists:

- **Habit Doom:** habits unlock blocked apps; live photo checked on-device by AI. iOS and Android.
- **Lock In:** unlocks apps when you reach the gym or log a workout. It's the closest match, but it's a fitness-tracking app, so the gym is the only kind of commitment.
- **GymLock:** locks apps *while* you're at the gym (the opposite direction).
- **ProveIt / Accountable AI:** live photo proof checked by AI, no gallery uploads.
- **Time Out, RepKey, Replock:** unlock by steps or reps.

None of them combine:

1. **The whole device locked** down to essentials, **across Mac and iPhone**, unlocked by proof on either device.
2. **Repeat detection against all your past proof photos** (perceptual hash), not just "live and from today."
3. **Floor-level checks** (barometer descent, my-gym image match, beacon) for tasks in the same building.
4. **Two-circle location policy:** locked while the place is reachable, a substitute task when you're properly away.
5. **Not tied to fitness or one habit type:** one engine where any commitment (study, work, chores, appointments, health) plugs in as a rule with its own proof type.

**Strictness is what sets this apart:** cheating should be harder than doing the task.

## Core model

```
rule {
  commitment: "Go to the gym today"
  evidence:   photo { live_capture, geofence: gym, window: today, unique_vs_history }
  region:     { reachable: home_city_30km, away_policy: substitute(healthkit_workout | any_gym_strict) }
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
