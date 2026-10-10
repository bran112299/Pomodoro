# prove-to-unlock

> **Prove with X you can do Y before unlocking Z.**

Nothing is locked forever. You get access by showing evidence that you can do something, not by asking for it.

## The pattern

| Slot | Role | Example |
|---|---|---|
| **X** | The evidence: something checkable | 4 finished Pomodoros, a passed quiz, a commit, a streak |
| **Y** | The ability the evidence shows | You can focus, you understand the material, you can be trusted |
| **Z** | The reward or access | Social media, the next level, more permissions, money |

The key move is that **Z depends on proof, not on promises.**
"I'll work after I check Twitter" turns into "Twitter opens after the work is done."

## Uses

1. **Focus → distractions (first use).** "Prove with 3 focused Pomodoros that you can concentrate before YouTube unlocks." Focus is the currency and distractions cost something.
2. **Learning and skill trees.** Pass a small quiz before the next lesson opens.
3. **Trust that grows over time.** Give new people, or AI agents, small permissions first, and more once they've shown they handle them well.
4. **Self-commitment contracts.** Lock your own savings, apps or treats behind goals you set for yourself.

## Core model

```
rule {
  evidence: X   // what must be submitted or observed
  proves:   Y   // the ability it stands for
  unlocks:  Z   // what opens, and for how long
}
```

An engine checks the evidence against the rules, records what has been proven, and grants unlocks, which can expire.

## Hard problems (where the real design work is)

- **X has to be hard to fake.** A timer can be left running while you scroll. Stronger proofs: checking which app is in front, a short recap of what you did, artifacts like commits.
- **Z has to be something people actually want.** Otherwise there's no reason to do the work.
- **Unlocks should expire.** Earned access runs out, so the loop repeats.
- **There needs to be an escape hatch.** Emergencies happen, but overriding should cost something and be logged.

## Roadmap

- [ ] Define the rule schema (X / Y / Z, expiry, override cost)
- [ ] Evidence verifiers: Pomodoro timer first
- [ ] Unlock adapters: website/app blocker first
- [ ] Ledger of proofs and unlocks
- [ ] Second use (quiz → lesson) to prove the engine is general
