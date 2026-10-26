# Where these files come from

Everything in this folder except `build.py`, `prerender.mjs` and `SOURCE.md` is the **Noteworthy design
system**, copied so the app has no network dependency and so the shared files stay standalone.

| file | source |
|---|---|
| `noteworthy.tokens.css` | the design system artifact "Noteworthy" (Design System type): `tokens/*.css` and `components/bundle.css` |
| `noteworthy.components.css` | the same, the CSS inside `components/{core,forms,surfaces,feedback,navigation}/*.jsx` |
| `fonts/*.woff2` | the same, `fonts/` (Newsreader, Figtree, JetBrains Mono; SIL OFL) |
| `icons.json` | the same, the 50 Lucide glyphs in `components/core/Icon.jsx` (ISC) |
| `ds.js` | `~/Desktop/Prototypes/noteworthy/ds.js` at commit `f370a70`: the system's plain-JS port (shapes, moods, backdrops, scenes, bursts) |
| `noteworthy.motion.css` | that repo's `style.css`, section "ILLUSTRATION & MOTION": the rules `ds.js` markup relies on |
| `prerendered.json` | generated from `ds.js` by `prerender.mjs` |

Nothing here was edited by hand. To refresh after the system changes, run `build.py` (its docstring says how),
then `node prerender.mjs`.

The app's own rules (layout, the page viewer, the retyped page) live in `sense/ui.html`, `sense/canvas.py`
and `sense/share.py`, and use only the tokens above.
