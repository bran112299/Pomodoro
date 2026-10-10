#!/usr/bin/env python3
"""Reference FSRS-5 vectors from the official py-fsrs implementation (pip install fsrs==4.1.1).

Writes spec/vectors/fsrs.json: review sequences with the expected card state after each review.
Both the TypeScript core and the Swift ProveCore test against this file, so all three agree.
"""
import json
import os
import random
from datetime import datetime, timedelta, timezone

from fsrs import Card, Rating, Scheduler, State

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "spec", "vectors", "fsrs.json")

STATE = {State.Learning: "learning", State.Review: "review", State.Relearning: "relearning"}


def ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def main() -> None:
    rng = random.Random(20261010)
    sched = Scheduler(enable_fuzzing=False)
    start = datetime(2026, 1, 5, 9, 0, tzinfo=timezone.utc)
    sequences = []
    for seq_i in range(60):
        card = Card()
        now = start + timedelta(minutes=seq_i)
        steps = []
        for _ in range(rng.randint(3, 14)):
            rating = Rating(rng.choices([1, 2, 3, 4], weights=[2, 2, 6, 1])[0])
            card, _log = sched.review_card(card, rating, now)
            steps.append(
                {
                    "at": ms(now),
                    "rating": int(rating),
                    "state": STATE[card.state],
                    "step": card.step if card.step is not None else 0,
                    "due": ms(card.due),
                    "stability": card.stability,
                    "difficulty": card.difficulty,
                }
            )
            # Review on time, early, or late, sometimes within the same day.
            gap = card.due - now
            factor = rng.choice([1.0, 1.0, 0.5, 1.7, 3.0])
            jitter = timedelta(minutes=rng.randint(0, 600)) if gap > timedelta(days=1) else timedelta(0)
            now = now + gap * factor + jitter
        sequences.append(steps)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(
            {
                "about": "py-fsrs 4.1.1 (FSRS-5), default parameters, learning steps [1m,10m], relearning [10m], no fuzz",
                "sequences": sequences,
            },
            f,
            indent=1,
        )
    print("wrote", OUT, sum(len(s) for s in sequences), "reviews")


if __name__ == "__main__":
    main()
