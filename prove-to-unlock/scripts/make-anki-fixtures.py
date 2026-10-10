#!/usr/bin/env python3
"""Generate real .apkg fixtures with the official Anki library (pip install anki).

Produces, in packages/core/test/fixtures/:
  modern.apkg  - Anki 2.1.50+ format (collection.anki21b, zstd + protobuf)
  legacy.apkg  - "support older Anki versions" format (collection.anki21 / anki2, JSON models)

Run:  python3 scripts/make-anki-fixtures.py
"""
import base64
import os
import shutil
import sys
import tempfile

from anki.collection import Collection, ExportAnkiPackageOptions

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "packages", "core", "test", "fixtures")

# 1x1 red PNG
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
)


def build(col_path: str, work: str) -> Collection:
    col = Collection(col_path)
    spanish = col.decks.id("Spanish::Verbs")
    geo = col.decks.id("Geography")

    img = os.path.join(work, "flag-red.png")
    with open(img, "wb") as f:
        f.write(PNG)
    fname = col.media.add_file(img)

    basic = col.models.by_name("Basic")
    for front, back in [("comer", "to eat"), ("beber", "to drink"), ("vivir", "to live")]:
        n = col.new_note(basic)
        n["Front"] = front
        n["Back"] = back
        n.tags = ["verbs", "spanish"]
        col.add_note(n, spanish)

    rev = col.models.by_name("Basic (and reversed card)")
    n = col.new_note(rev)
    n["Front"] = "Capital of France"
    n["Back"] = f'Paris <img src="{fname}">'
    col.add_note(n, geo)

    cloze = col.models.by_name("Cloze")
    n = col.new_note(cloze)
    n["Text"] = "{{c1::Canberra}} is the capital of {{c2::Australia::country}}."
    n["Back Extra"] = "Not Sydney!"
    col.add_note(n, geo)
    return col


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    work = tempfile.mkdtemp()
    try:
        col = build(os.path.join(work, "collection.anki2"), work)
        for legacy, name in [(False, "modern.apkg"), (True, "legacy.apkg")]:
            out = os.path.join(OUT, name)
            col.export_anki_package(
                out_path=out,
                options=ExportAnkiPackageOptions(
                    with_scheduling=False, with_deck_configs=False, with_media=True, legacy=legacy
                ),
                limit=None,
            )
            print("wrote", out, os.path.getsize(out), "bytes")
        col.close()
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
