"""An optional written summary: Gemini reads the typed outline (never the photo) and says what
the notes are about. Only used when GEMINI_API_KEY is set and you ask for it."""

from __future__ import annotations

import json

from baselines import gemini

from . import share

PROMPT = """\
Below are one person's handwritten notes from a single page, already transcribed and
structured as an outline. Nesting follows their arrows; a word before an arrow (like "TRY TO →")
labels it; "aside" marks a short side note; "[ ]" marks a to-do.

Write a title of at most 8 words and a summary of 2 to 3 sentences saying what the notes are
about and how the ideas connect. Use only what is in the notes. If a word looks like a
misreading, leave it out rather than guess.

"""

SCHEMA = {
    "type": "OBJECT",
    "properties": {"title": {"type": "STRING"}, "summary": {"type": "STRING"}},
    "required": ["title", "summary"],
    "propertyOrdering": ["title", "summary"],
}


def narrate(note: dict, hints: str, model: str, key: str) -> dict:
    body = {
        "contents": [{"role": "user", "parts": [{"text": PROMPT + hints + "\n\n" + share.to_markdown(
            {**note, "narration": None})}]}],
        "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json", "responseSchema": SCHEMA},
    }
    out = json.loads(gemini.post(body, model, key))
    return {"title": str(out["title"]).strip(), "summary": str(out["summary"]).strip()}
