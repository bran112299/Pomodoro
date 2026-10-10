# Prove to Unlock

> **Prove with X you can do Y before unlocking Z.**

Your phone, computer and browser stay locked to the essentials until you've done what you
committed to today, like going to the gym, clearing your Anki cards or doing deep work, and
proved it. The original idea is in [docs/VISION.md](docs/VISION.md).

| Piece | What it is | Download (from the **ptu-latest** pre-release) |
|---|---|---|
| **Desktop app** | Lock screen on every display, essentials-only mode, Esc failsafe, Anki, focus, webcam photo proof, device linker | macOS `.dmg`/`.zip` · Windows installer `.exe` or portable `.exe` · Linux `.AppImage` |
| **Browser extension** | Blocks non-essential sites while locked; Anki + focus on the lock page | `prove-to-unlock-chrome-*.zip` · `prove-to-unlock-firefox-*.zip` |
| **iPhone app** | Screen Time lock, live photo proof (on-device AI), place geofences, barometer floors, Anki, QR linking | `ProveToUnlock-unsigned.ipa` (sideload, see below) |

Everything is built and tested in GitHub Actions on every push
(`.github/workflows/prove-to-unlock.yml`). The latest build is attached to the
**ptu-latest** pre-release on the repository's Releases page.

## How it works

1. **Commit.** Create a commitment: which days, the lock window (e.g. 06:00 until midnight), and
   what unlocks it: *all* or *any N* of these:
   - 📸 **Photo**: a live photo (no camera roll) that's new (perceptual-hash compared with every
     earlier proof photo), optionally at a place, showing certain things (on-device AI labels),
     looking like your reference photos of the place, with a random challenge ("hold up 3
     fingers").
   - 📍 **Presence**: time spent inside a place (map pin + radius).
   - 🏢 **Floors**: barometer descent or ascent, for "the gym is downstairs".
   - 🗂️ **Anki**: clear today's cards or do N *honest* reviews (FSRS-5 scheduling, real `.apkg`
     import).
   - ⏱️ **Focus**: N Pomodoro sessions.
2. **Locked.** Inside the window, non-essential apps and sites are covered or blocked on every
   linked device.
3. **Prove it** on whichever device can: photo, location and floors on the phone; Anki and focus
   anywhere; photos also by webcam.
4. **Unlocked everywhere.** The proof is signed and synced over your Wi-Fi; every device verifies
   it and unlocks.

**Away from your area?** Mark a big "reachable region" (your city). If the phone sees you
outside it for most of the day, a substitute task applies instead (capped per month). Driving just
past the line doesn't count.

**Failsafes** (by design, you can never be stuck):

- **Hold Esc for 3 s** on the lock screen (on the phone, hold the emergency button). It unlocks
  every device for 15 minutes. It always works, even offline. It's logged and resets your streak.
- Locks always lift at the end of the window, even if an app crashed or never opened. On iPhone,
  Screen Time schedules handle this without the app.
- Phone calls and SOS are never blocked. Excused days (sick or rest) must be set in advance.
- **Test mode** is on by default. Nothing is blocked until you turn it off, and it can't be turned
  back on while locked.
- While locked you can't edit your way out: locked commitments can't be changed or deleted,
  essentials can't grow and rules can't loosen.

**Linking without an account:** devices pair over the local network with a 6-digit code or QR
code and then trust each other's keys. There's no server. See [spec/protocol.md](spec/protocol.md).

## Install

### Desktop (macOS / Windows / Linux)

- **macOS**: open the `.dmg` and drag the app to Applications. The build is unsigned, so the
  first time, right-click the app and choose **Open**. Allow camera and local network access when
  asked.
- **Windows**: run the installer (or the portable `.exe`). SmartScreen will warn because it's
  unsigned: choose **More info**, then **Run anyway**. Allow it through the firewall on private
  networks so your phone can reach it.
- **Linux**: `chmod +x Prove-to-Unlock-*.AppImage && ./Prove-to-Unlock-*.AppImage`. App
  detection needs `xdotool` (X11); without it the lock screen simply stays up.

It starts in **test mode**. Create a commitment under **Rules**, try it, then turn test mode off
in **Settings** and turn on **Start at login**.

### Browser extension

- **Chrome / Edge / Brave**: unzip `prove-to-unlock-chrome-*.zip`, open `chrome://extensions`,
  turn on **Developer mode**, click **Load unpacked** and pick the folder.
- **Firefox**: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**
  and pick the zip (or its `manifest.json`). A permanent install needs the add-on signed by
  Mozilla (AMO).
- In the extension's settings, enter the **6-digit code** from the desktop app (**Devices →
  Show pairing code**). It also works standalone, with its own Anki and focus commitments.

### iPhone

The `.ipa` is unsigned because Apple requires its own signing. Options:

1. **Xcode** (recommended): `cd apps/ios && brew install xcodegen && xcodegen generate`, open
   `ProveToUnlock.xcodeproj`, choose your team under Signing for both targets, and run it on your
   phone.
2. **Sideloading tools** (e.g. Sideloadly or AltStore) can sign `ProveToUnlock-unsigned.ipa`
   with your Apple ID.

**Screen Time blocking needs Apple's Family Controls entitlement.** It works with a paid
developer account (the development entitlement), but free Apple IDs can't use it. Without it,
everything else still works (proofs, linking, Anki, unlocking your computer); only the phone's
own app blocking is missing. Publishing to the App Store needs Apple to grant the distribution
entitlement.

Link the phone under **Devices**: scan the QR code shown by the desktop app.

## Develop & test

```sh
npm install                         # workspaces: core, ui, desktop, extension
npm test                            # unit tests (core, desktop logic)
npm run typecheck
npm run test:e2e                    # real Electron app + real Chromium extension (needs a display / xvfb-run)
npm -w apps/desktop run fetch-model # MobileNet for webcam photo checks (14 MB)
npm -w apps/desktop start           # run the desktop app
npm run build:extension             # → apps/extension/dist/{chrome,firefox}
cd apps/ios/ProveCore && swift test # Swift core vs. the same vectors (macOS)
```

Test data is real, not mocked:

- FSRS is checked against **py-fsrs** reference vectors (`scripts/gen-fsrs-vectors.py`).
- Anki import is checked against packages made by the **official Anki library**
  (`scripts/make-anki-fixtures.py`).
- The Swift core is checked against vectors generated from the TypeScript core
  (`scripts/gen-vectors.ts`), and CI verifies Swift-signed records with TypeScript.
- The e2e tests pair a simulated phone with the real desktop app, sync a proof and check that it
  unlocks. They also import a real deck and review it, take a fake-camera photo and run it through
  MobileNet, check the Esc failsafe, and load the extension in Chromium to check that real page
  loads are blocked and unblocked.

```
packages/core        shared TypeScript: records, protocol, engine, FSRS, Anki import, geo, photo
packages/ui          shared Preact UI: review screen, Esc hold, focus timer, camera
apps/desktop         Electron app (main: linker, enforcer, proofs; renderer: dashboard + lock)
apps/extension       MV3 extension for Chrome and Firefox
apps/ios             SwiftUI app, Screen Time monitor extension, ProveCore Swift package
spec                 protocol.md + cross-language test vectors
```

## Honest limitations

This is **honest by design**: it makes doing the task easier than faking it. It doesn't stop a
determined attacker.

- An admin can kill the desktop app (Task Manager, Activity Monitor) or uninstall the extension.
  The lock is a commitment device, not parental controls.
- Photo checks can be fooled with real effort (e.g. GPS spoofing plus staged photos). Random
  challenges are confirmed by you, not by a hand-pose model.
- The phone only learns about proofs from your computer when it can reach it on the same Wi-Fi.
  Proofs made on the phone reach the computer the same way.
- The iPhone imports Anki's newer compressed decks through the computer (iOS has no built-in
  zstd); legacy-format `.apkg` files import directly.
- The browser extension can't take photo, location or floor proofs; those happen on the phone or
  computer.
