# Anchor — paper-to-structure capture rig

v1 = markers → settle/diff → ink + stroke classes → text/arrows/link-verify → overlay viewer.
Status: **test harness, baselines, markers and settle/diff capture, and the make-sense app for notebook photos.** Vision baseline scored; Gemini baseline waiting on an API key. No recognition features until baseline scores are reported (the app below adds none: it reads with the baselines).

Decisions so far:
- Phone is a dumb camera streaming to the Mac; all processing runs in Python on the Mac. An ESP32-S3 camera is being tried in the same role (`--url`).
- Models: hybrid. Local OCR on the Mac first; Gemini API for low-confidence text and link verification.
- Page orientation: 4 ArUco markers at the A4 corners (`anchor/template.py`).

## Layout

```
harness/schema.py   page-structure JSON format (gold + predictions), loader, validator
harness/score.py    matching + metrics
harness/run.py      CLI: score data/preds against data/labeled, write reports/
harness/draw.py     draw a page JSON over its image (label check / overlay)
harness/view.py     HTML results viewer: scores across sources, overlays, misses
anchor/template.py  printable A4 capture sheet with ArUco corner markers (PDF)
anchor/flatten.py   warp a photo to flat A4: by markers, else by the sheet's edges
anchor/capture.py   grab frames from a camera or ESP32; save a flattened still each time the page settles
sense/              the make-sense app: a photo of a notebook page -> notes you can read, fix and send
sense/static/       the Noteworthy design system, vendored: tokens, fonts, components, ds.js (see its SOURCE.md)
sense/notebooks.py  notebooks: the model, storage, import and export of an infinite canvas (an added section)
sense/web/          the canvas editor: canvas.js and canvas.css, served only when notebooks are on
baselines/gemini.py Gemini-only baseline: whole flattened page -> one prediction JSON
baselines/vision.py local OCR baseline: Apple Vision, text elements only (no links)
examples/           a worked gold file showing every field
data/labeled/       your hand-labeled pages: page-NN.json (+ page-NN.jpg)
data/preds/         pipeline output, same filenames
data/baselines/     baseline output, one folder per baseline
samples/            reference photos (page-01.jpg goes here)
templates/          the printable sheet
captures/           capture sessions
notes/              the make-sense app's library: one folder per page, plus profile.json (yours; not for sharing)
notes/notebooks/    one folder per notebook: notebook.json and the photos you put on it
```

## Capturing

1. Print the sheet at 100%: `python3 -m anchor.template` writes `templates/anchor-a4.pdf` (A4 landscape, a 20 mm marker in each corner; ids 0-3 clockwise from top-left).
2. Point a camera straight down at it from 30-40 cm, with light from the side away from your writing hand.
3. Find the camera: `python3 -m anchor.capture probe`. An iPhone on Continuity Camera shows up as an extra index.
4. One still: `python3 -m anchor.capture snap --camera 1`. A live session: `python3 -m anchor.capture watch --camera 1`, which saves a flattened still into `captures/<session>/` each time you lift your hand and the page holds still with new ink (`NNN.jpg`, plus `NNN.new.png` showing just the new ink).

Any 3 of the 4 markers are enough, in any orientation. Settles with a hand or object still on the sheet are skipped.

**ESP32-S3 camera** (e.g. XIAO ESP32S3 Sense): flash the esp32 Arduino core's `CameraWebServer` example (board XIAO_ESP32S3, PSRAM on, camera model `CAMERA_MODEL_XIAO_ESP32S3`, your Wi-Fi in the sketch). In its web page, set resolution to UXGA and JPEG quality to about 10, then use `--url http://<board-ip>/capture`. Once the picture looks right, turn off auto exposure, gain and white balance in that page, so the picture doesn't change when your hand comes in.

## Make sense: notebook photos

The same engine for a different job: take a photo of a page in your notebook, see what it says, fix what it got wrong, and send it to someone.

```bash
.venv/bin/python -m sense.app                  # http://127.0.0.1:8765, everything stays on this Mac
.venv/bin/python -m sense.app --host 0.0.0.0   # also reachable from your phone on the same Wi-Fi
.venv/bin/python -m sense.app --cloud you@gmail.com --key-file ~/.config/anchor/service-account.json   # and keep the website in step
```

There is no sign-in on the local server, so only use `--host 0.0.0.0` on a network you trust. Everything is processed locally on this Mac; Gemini is called only if `GEMINI_API_KEY` is set.

**From your phone, anywhere:** the same app as a website with Google sign-in, your pages and notebooks available whether or not the Mac is on, and photos you add read by the Mac when it is. Setup, how it works and what it costs: [`sense/cloud/README.md`](sense/cloud/README.md). (The old open `--sync` mirror, `sense/firestore_sync.py`, is superseded and off by default.)

1. **Add a page.** Drop a photo or take one on your phone. A sheet with the corner markers is flattened by them; any other photo has the page cut out by its edges, or is used whole (a button switches). The page is turned upright using the OCR itself: lines that come back wider than tall are running along the page. It can't tell upright from upside down, so when the photo was sideways it says so and offers *Rotate*.
2. **Read.** With a Gemini key: Gemini, given your checked pages as examples and a paragraph about how you write. Without: Apple Vision, which reads words only. No arrows, no underlines, so you draw those in.
3. **See it.** Drag the divider between your handwriting and the retyped page (same positions). Beside it: threads (your arrows as nested outlines, with the word on the arrow), to-dos (lines starting with your cues), key terms (what you underlined or capitalised), and loose notes (text no arrow touches, grouped by nearness).
4. **Fix readings.** Click a box to correct it, *Add a missed word* by dragging a box, *Draw an arrow* between two boxes. The outline updates as you type. Saving teaches the profile.
5. **Share.** A single `.html` file (no script, no network; the photo is included only if you tick it), or Markdown to paste into a message.

**What it learns about you** (`notes/profile.json`, shown under *How you write*): your shorthand (seeded: a lone `7` is `of`); to-do cues (`add`, `looking into`, ...); misreadings you corrected, kept per page so saving twice counts once and deleting a page forgets what it taught; and your vocabulary. A reading that is close to one of your words, and is not just an inflection of it, is snapped to it. Words you left alone only join the vocabulary when you tick *I've checked this page*, so the app never learns its own mistakes as yours. Words from `data/labeled/` count as yours.

**How it looks.** The whole app follows the Noteworthy design system, head to toe: the side rail and pill nav (a floating tab bar on phones), Noteworthy's buttons, segmented control, chips, cards, tiles, sheet and toast, Newsreader for what the notes say and Figtree for controls, its illustration scenes and backdrop, its voice (sentence case, verbs on buttons, past-tense feedback, an italic turn in headlines), and its dark theme, which follows the device. Each thread of ideas gets one of the system's shapes and colours, and that colour washes the same words on the retyped page; the system's highlight (sun) is reserved for what you underlined. The shared `.html` file has the same look and carries its own fonts (about 0.5 MB). Nothing is styled by hand: `sense/static/` is copied from the system (see `SOURCE.md` there for where, and `build.py` to refresh it), and `tests/test_sense_theme.py` fails if the app's own CSS uses a raw colour or font instead of a token.

## Notebooks: an endless page

A second way to use the same engine, beside the photo pages (which are unchanged). A notebook is one infinite canvas: write where you would write on paper, draw the arrows you'd draw, circle what belongs together, then ask it to make sense. Open **Notebooks** in the rail, or run `.venv/bin/python -m sense.app --no-notebooks` to get the app exactly as it was, photo pages only.

- **Write anywhere.** Double-click empty paper (or press `T`, then click) and type. Drag a note to move it, drag the handle on its right edge to change its width. Notes take your **Underlined** and **Capitals** like a photographed page does.
- **Arrows.** Select a note and drag from the dot beside it onto another note (or press `A` and drag anywhere). An arrow can end on empty paper, as arrows on paper do; that's a drawing, not a connection. Click an arrow to make it an *aside*, give it a word, underline or capitalise that word, or drag its middle to bend it.
- **Circle things** (`S`, then drag): words inside a shape become one idea, the same as the circled "core" on your Transition page.
- **Move around.** Drag empty paper, or scroll, to pan; pinch or ⌘-scroll to zoom; `F` fits everything; hold Space to pan while a tool is active. `⌘Z` / `⇧⌘Z` undo and redo. Everything autosaves, and a second tab can't silently overwrite the first.
- **Make sense** opens a drawer with the same threads, to-dos, key terms and loose notes the photo pages give you, and tints each note by its thread. Click a row to go to that note, or a thread's card to go to the whole thread.
- **Photos.** `P` adds a photo (it is read with the same engine; it also appears under Pages) or brings in a page you've already read: the photo lands on the canvas with its words beside it as ordinary notes you can move and fix. A page also has an *Add to a notebook* button.
- **Share** a notebook as one `.html` file (the canvas laid out at true scale, then every thread) or Markdown, the same as a photo page.

How it fits together: a notebook is stored in the page format (items and links), so `make_sense` runs on a canvas without change; arrows with a free end are drawn but never join threads. All of it lives in `sense/notebooks.py`, `sense/web/` and their tests, and `tests/test_sense_notebooks.py` has guards that the photo flow doesn't depend on any of it.

Not built yet: copy and paste, duplicating notes, multi-select resize, and learning your profile from corrections made on a canvas (the photo pages still do).

Limits worth knowing:
- The Gemini path (prompt, examples, rescaling, fallback) is covered by tests against canned answers but has **not been run against the live API**; there was no key when it was built.
- Vision reads this handwriting poorly (see `reports/vision/`). On `page-01` the profile snapped 4 of 21 lines to your own words with no wrong changes, but that page was also where the vocabulary came from, so it shows the mechanism works, not how well it generalises.
- The retyped page draws straight arrows, so one can cross a neighbouring word.

Tests that touch the app need OpenCV: `.venv/bin/python -m unittest`.

## Labeling a page

See `examples/gold-example.json`. One JSON per page:

- `page_size`: the extent of your coordinates, e.g. `[210, 297]` for mm, or the image's pixel size. Gold and predictions may use different units, because everything is normalized.
- `elements`:
  - `text`: one per word or phrase unit you'd treat as a node. Set `underline: true` for key terms and `caps: true` for emphasis.
  - `shape`: a closed shape. `contains` lists the ids inside it.
  - `doodle`: an illustration or stray drawing. Box it so the pipeline learns not to read it as text.
- `links`: every arrow, as `from` → `to` in the direction the arrowhead points.
  - `kind`: `flow` (concept → concept), `hook` (short curled "belongs to / elaborates" arrow; still label it in arrowhead direction), or `connector` (an inline arrow with a word on it; put the word in `label` and **don't** also label it as a text element). A connector's word can be any phrase, e.g. `Transition —TRY TO→ core`; set `caps` / `underline` on the link if the word has them.
  - An arrow can point at a shape.
- Granularity: one text element per node you'd want in the graph (a phrase like "mindset of posture" is one element). `underline: true` if any of it is underlined.
- Coordinates are in the **flattened** image (`python -m anchor.flatten`, or a `captures/` still), so gold and pipeline share a frame. Save that image as `page-NN.jpg` next to the label.
- Leave out sticky notes, desk, laptop and anything else that isn't ink.

Check your files with `python3 -m harness.run --validate`.

## Setup

The harness scorer is stdlib-only. Flattening and drawing need OpenCV:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

## Running

```bash
python3 -m harness.run
```

This writes `reports/report.md` (summary, per-page table, and every individual miss) and `reports/report.json`.

To see it all in one place, run `python3 -m harness.view` and open `reports/viewer.html`. It scores every folder in `data/baselines/` (and `data/preds/`, as "pipeline") side by side, then shows each page with gold (dashed) and a prediction drawn over it; hover a miss to highlight it on the page. The file embeds its images, so it can be shared on its own.

Metrics:
- **Text**: detection P/R/F1 (bbox IoU ≥ 0.3, or pred centre inside the gold box); CER on matched elements and end-to-end (missed text counts as fully wrong); exact-match rate.
- **Links**: top-1 P/R/F1 on (from, to) endpoints; top-2 recall (an ambiguous end whose 2nd candidate is right still counts); reversed arrows; kind accuracy; connector-label accuracy; mean confidence of right vs wrong links (a calibration check).
- **Emphasis**: underline and CAPS P/R/F1 over text elements and connector words (a missed link counts its emphasis as missed); shape F1; container-membership Jaccard.
- **Doodles**: detection F1, and how many doodles were read as text (should be 0).

Baselines (not pipeline features; they set the floor the pipeline has to beat):

```bash
export GEMINI_API_KEY=...
python3 -m baselines.gemini          # -> data/baselines/gemini/, raw answers in raw/
python3 -m harness.run --pred data/baselines/gemini --out reports/gemini

python3 -m baselines.vision          # -> data/baselines/vision/ (macOS; compiles a Swift helper on first run)
python3 -m harness.run --pred data/baselines/vision --out reports/vision
```

Gemini: `--model` (or `GEMINI_MODEL`) picks the model, `--only page-01` runs one page, `--force` re-runs pages that already have a prediction.
Vision: `--no-merge` keeps one element per OCR line instead of merging stacked lines into phrases; `--no-correction` turns off Vision's language correction, `--no-shorthand` skips expanding your shorthand (a lone "7" → "of"; the table is `SHORTHAND` in `baselines/vision.py`).

Tests: `python3 -m unittest`
