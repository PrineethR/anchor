"""Draw what `meaning.make_sense` found, as HTML for the app and as a file to send someone.

`sense_html` is the one renderer: the app injects it, and `to_html` wraps it into a
standalone page (no script, no network; the Noteworthy fonts are inlined; the original photo
is embedded only if you ask). `to_markdown` is the same content for pasting into a message.

The look is the Noteworthy design system (static/, via theme.py): paper and ink, Newsreader for
what the notes say, Figtree for controls and labels, raised cards, one colour and one shape per
thread of ideas, and the system's highlight under what you underlined. Stdlib only.
"""

from __future__ import annotations

import base64
from datetime import datetime
from html import escape

from . import canvas, theme

ARROW = ('<svg class="nw-icon via-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
         'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
         '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>')

CSS = """
.sense { color: var(--fg-1); }
.sense h3 { font: var(--w-medium) var(--t-h3)/var(--lh-snug) var(--font-display); letter-spacing: 0; margin: var(--s-6) 0 var(--s-3); }
.sense h3:first-child { margin-top: 0; }
.sense ul { list-style: none; margin: 0; padding: 0; }
.thread { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: var(--s-3); margin: 0 0 var(--s-3); }
.thread-mark { padding-top: 4px; }
.thread-mark svg { display: block; width: 24px; height: 24px; }
.thread ul ul { margin: .15rem 0 .15rem .35rem; padding-left: 1rem; border-left: 1px solid var(--line-soft); }
.thread li { margin: .3rem 0; font: var(--w-regular) var(--t-body)/var(--lh-snug) var(--font-body); }
.thread > ul > li > .row { font-weight: var(--w-medium); font-size: 1.1875rem; }
.sense li[data-ids] > .row { border-radius: 6px; padding: 1px 4px; margin: 0 -4px; transition: background-color var(--dur) var(--ease-out); }
.sense li[data-ids]:hover > .row, .sense div[data-ids]:hover { background: var(--bg-sunken); }
.kt { background: linear-gradient(transparent 58%, var(--hl, color-mix(in srgb, var(--highlight) 78%, transparent)) 58%,
  var(--hl, color-mix(in srgb, var(--highlight) 78%, transparent)) 90%, transparent 90%); }
.caps { text-transform: uppercase; letter-spacing: .04em; font-family: var(--font-sans); font-weight: var(--w-semibold); font-size: .85em; }
.via { display: inline-flex; align-items: center; gap: .3em; margin-right: .5em; font: var(--w-semibold) var(--t-sm)/1 var(--font-ui);
  color: var(--ti, var(--fg-2)); white-space: nowrap; }
.via.aside { font-weight: var(--w-regular); font-style: italic; color: var(--fg-3); }
.via-arrow { flex: none; }
.ref { color: var(--fg-3); font-style: italic; }
.cb { display: inline-block; flex: none; width: 1.1em; height: 1.1em; border-radius: 50%; border: var(--stroke-bold) solid var(--line-strong);
  background: var(--bg-surface); vertical-align: -.15em; margin-right: .5em; }
.todos li { display: flex; align-items: flex-start; gap: .6rem; margin: .45rem 0; font: var(--w-regular) var(--t-body)/var(--lh-snug) var(--font-body); }
.todos .cb { margin: .2em 0 0; width: 1.25rem; height: 1.25rem; }
.todo > .cb { width: .95em; height: .95em; }
.tags { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.tag { display: inline-flex; align-items: center; gap: .5em; height: 32px; padding: 0 .9em; border-radius: var(--radius-pill);
  border: var(--stroke) solid var(--line-strong); background: var(--bg-surface); font: var(--w-medium) var(--t-sm)/1 var(--font-ui); }
.tag .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; background: var(--fg-1); }
.tag .dot.hl { background: var(--highlight); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink-900) 25%, transparent); }
.tag.caps-t { text-transform: uppercase; letter-spacing: .04em; font-weight: var(--w-semibold); }
.note-group { margin: 0 0 var(--s-3); }
.note-group div { font: var(--w-regular) var(--t-body)/var(--lh-body) var(--font-body); padding: 1px 0; }
.sense .empty { color: var(--fg-3); font: var(--w-regular) var(--t-ui)/1.4 var(--font-ui); margin: 0; }
"""


def _term(it: dict) -> str:
    """One outline entry as HTML: the text with your emphasis, preceded by how it was reached."""
    text = escape(it["text"])
    if it.get("underline"):
        text = f'<span class="kt">{text}</span>'
    if it.get("caps"):
        text = f'<span class="caps">{text}</span>'
    via = it.get("via")
    lead = ""
    if via:
        if via["kind"] == "hook":
            lead = '<span class="via aside">aside</span>'
        elif via["label"]:
            word = escape(via["label"])
            if via.get("caps"):
                word = f'<span class="caps">{word}</span>'
            if via.get("underline"):
                word = f'<span class="kt">{word}</span>'
            lead = f'<span class="via">{word}{ARROW}</span>'
    check = '<span class="cb" aria-hidden="true"></span>' if it.get("action") else ""
    cls = "row" + (" todo" if it.get("action") else "") + (" ref" if it.get("ref") else "")
    tail = ' <span class="ref">(see above)</span>' if it.get("ref") else ""
    return f'<span class="{cls}">{check}{lead}{text}{tail}</span>'


def _ul(items: list[dict]) -> str:
    rows = "".join(f'<li data-ids="{escape(" ".join(i["ids"]))}">{_term(i)}{_ul(i["children"]) if i["children"] else ""}</li>'
                   for i in items)
    return f"<ul>{rows}</ul>"


def sense_html(sense: dict, editable: bool = False, empty: str | None = None) -> str:
    """The threads, to-dos, key terms and loose notes. `editable` only changes what an empty page tells you to do;
    `empty` replaces that message."""
    out = ['<div class="sense">', "<h3>Threads</h3>"]
    for i, t in enumerate(sense["threads"]):
        out.append(f'<section class="nw-card nw-card--raised thread th{i % 6}" data-ids="{escape(" ".join(t["ids"]))}">'
                   f'<span class="thread-mark">{theme.thread_mark(i)}</span>{_ul(t["roots"])}</section>')
    if not sense["threads"]:
        out.append('<p class="empty">' + (empty or ("No arrows yet. Draw them in with Fix readings." if editable
                                                     else "No arrows were found on this page.")) + "</p>")
    if sense["actions"]:
        out.append('<h3>To-dos</h3><div class="nw-card nw-card--sunken"><ul class="todos">')
        out += [f'<li data-ids="{escape(a["id"])}"><span class="cb" aria-hidden="true"></span><span>{escape(a["text"])}</span></li>'
                for a in sense["actions"]]
        out.append("</ul></div>")
    if sense["key_terms"]:
        out.append('<h3>Key terms</h3><ul class="tags">')
        for k in sense["key_terms"]:
            marks = k["kind"] in ("caps", "both")
            out.append(f'<li class="tag{" caps-t" if marks else ""}" data-ids="{escape(k["id"])}">'
                       f'<span class="dot{" hl" if k["kind"] in ("underline", "both") else ""}"></span>{escape(k["text"])}</li>')
        out.append("</ul>")
    if sense["loose"]:
        out.append("<h3>Loose notes</h3>")
        for g in sense["loose"]:
            rows = "".join(f'<div data-ids="{escape(" ".join(i["ids"]))}">{_term(i)}</div>' for i in g["items"])
            out.append(f'<div class="nw-card nw-card--sunken nw-card--sm note-group">{rows}</div>')
    out.append("</div>")
    return "".join(out)


def to_html(note: dict, photo: bytes | None = None) -> str:
    sense, page = note["sense"], note["page"]
    when = datetime.fromisoformat(note["created"]).strftime("%-d %b %Y")
    photo_html = ""
    if photo:
        photo_html = ('<details class="photo"><summary>See the photo</summary><img alt="The handwritten page" '
                      'src="data:image/jpeg;base64,' + base64.b64encode(photo).decode() + '"></details>')
    summary = escape((note.get("narration") or {}).get("summary") or sense["summary"])
    px = bool(note.get("px"))  # a notebook: laid out at true scale, not squeezed to fit
    voice = {"kicker": "Typed up from handwriting", "section": "The page, <em>retyped</em>",
             "footer": "A machine read the handwriting and the writer checked it, so a word or two may still be off.",
             **note.get("voice", {})}
    lay = canvas.layout(page, thread_of={i: n for n, t in enumerate(sense["threads"]) for i in t["ids"]}, normalize=not px)
    drawing = canvas.render_html(lay)
    if px:
        s = max(min(1.0, 840 / lay["w"]), 0.45)
        drawing = (f'<div style="width:{lay["w"] * s:.0f}px;height:{lay["h"] * s:.0f}px"><div style="width:{lay["w"]:.0f}px;'
                   f'transform:scale({s:.3f});transform-origin:0 0">{drawing}</div></div>')
    css = theme.stylesheet(embed_fonts=True) + CSS + canvas.CSS
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(note["title"])}</title>
<style>{css}
body {{ background: var(--bg-canvas); }}
main {{ max-width: 56rem; margin: 0 auto; padding: var(--s-7) var(--gutter) var(--s-8); }}
.doc-head h1 {{ font: var(--w-regular) var(--t-h1)/var(--lh-tight) var(--font-display); letter-spacing: var(--ls-display); margin: var(--s-3) 0 var(--s-4); }}
.lead {{ font: var(--w-regular) var(--t-lead)/var(--lh-body) var(--font-body); color: var(--fg-1); max-width: 34rem; margin: 0; }}
section.page {{ margin: var(--s-7) 0 var(--s-6); }}
section.page h2 {{ font: var(--w-regular) var(--t-h2)/var(--lh-tight) var(--font-display); margin: 0 0 var(--s-3); }}
.frame {{ background: var(--bg-surface); border-radius: var(--radius-2xl); padding: 8px; box-shadow: var(--shadow-1); }}
.frame .scroll {{ overflow-x: auto; border-radius: var(--radius-xl); }}
.frame .canvas {{ background: var(--bg-canvas); }}
.frame.big .scroll {{ max-height: 75vh; overflow: auto; }}
details.photo {{ margin: var(--s-6) 0 0; }}
details.photo summary {{ cursor: pointer; font: var(--w-medium) var(--t-ui)/1.3 var(--font-ui); color: var(--fg-2); }}
details.photo img {{ display: block; max-width: 100%; margin-top: var(--s-3); border-radius: var(--radius-xl); box-shadow: var(--shadow-1); }}
footer {{ display: flex; gap: var(--s-4); align-items: center; margin-top: var(--s-8); padding-top: var(--s-5); border-top: 1px solid var(--line-soft);
  color: var(--fg-2); font: var(--w-regular) var(--t-sm)/1.45 var(--font-ui); }}
footer svg {{ flex: none; }}
.wordmark {{ font: var(--w-regular) 1.1em/1 var(--font-serif); letter-spacing: var(--ls-display); color: var(--fg-1); }}
.wordmark em {{ font-style: italic; }}
@media print {{ body {{ background: var(--paper-0); }} .frame .scroll {{ overflow: visible; }} }}
</style></head><body><main>
<header class="doc-head">
<p class="nw-label">{voice["kicker"]} · {when}</p>
<h1>{escape(note["title"])}</h1>
<p class="lead">{summary}</p>
</header>
<section class="page"><h2>{voice["section"]}</h2><div class="frame{" big" if px else ""}"><div class="scroll">{drawing}</div></div></section>
{sense_html(sense)}
{photo_html}
<footer>{theme.sign_off()}<p>Typed up with <span class="wordmark">Make <em>sense</em></span>. {voice["footer"]}</p></footer>
</main></body></html>"""


def _md_item(it: dict, depth: int) -> list[str]:
    text = it["text"]
    if it.get("underline"):
        text = f"**{text}**"
    via = it.get("via")
    lead = ""
    if via:
        lead = "(aside) " if via["kind"] == "hook" else (f"_{via['label']}_ → " if via["label"] else "")
    box = "[ ] " if it.get("action") else ""
    ref = " _(see above)_" if it.get("ref") else ""
    lines = ["  " * depth + f"- {box}{lead}{text}{ref}"]
    for c in it["children"]:
        lines += _md_item(c, depth + 1)
    return lines


def to_markdown(note: dict) -> str:
    sense = note["sense"]
    when = datetime.fromisoformat(note["created"]).strftime("%-d %B %Y")
    summary = (note.get("narration") or {}).get("summary") or sense["summary"]
    kicker = note.get("voice", {}).get("md", "Typed up from handwritten notes")
    out = [f"# {note['title']}", f"_{kicker} on {when}_", "", summary, ""]
    if sense["threads"]:
        out += ["## Threads", ""]
        for t in sense["threads"]:
            for r in t["roots"]:
                out += _md_item(r, 0)
            out.append("")
    if sense["actions"]:
        out += ["## To-dos", ""] + [f"- [ ] {a['text']}" for a in sense["actions"]] + [""]
    if sense["key_terms"]:
        out += ["## Key terms", "", ", ".join(k["text"] for k in sense["key_terms"]), ""]
    if sense["loose"]:
        out += ["## Loose notes", ""]
        for g in sense["loose"]:
            out += [f"- {g['items'][0]['text']}"] + [f"  {i['text']}" for i in g["items"][1:]]
        out.append("")
    return "\n".join(out).rstrip() + "\n"
