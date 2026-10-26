# Make sense on the web

The same app, at an address you can open on your phone anywhere, behind a Google sign-in that only lets in the accounts you list.

```
 phone / laptop                      Google (project anchor-notes-prineeth)                     this Mac
┌───────────────────┐   sign in    ┌──────────────────────────────┐  every ~15 s   ┌───────────────────────────┐
│ the website        │ ───────────▶ │ Firebase Auth (Google)       │                │ sense.cloud.worker        │
│  ui.html + canvas  │              │ Firestore  users/{you}/…     │ ◀───────────── │  reads queued photos with │
│  + the reading     │ ◀──────────▶ │ Hosting    (the static site) │ ──────────────▶│  Apple Vision + profile,  │
│  engine in JS      │  live data   └──────────────────────────────┘  results, edits│  learns from your edits   │
└───────────────────┘                                                                └───────────────────────────┘
```

**Two ways a photo gets read.** With a Gemini key saved on a device (*You → How pages are read*), that device reads the page itself, straight from the photo,
and the Mac is not involved: it works from anywhere with the Mac off, and it finds arrows and underlines. Without a key, a new photo waits as "Waiting for your Mac"
and the Mac reads it with Apple Vision when it is on (words only; you draw the arrows). Opening everything already read, editing words, writing in notebooks,
exporting and changing the profile never need the Mac.

## Reading with Gemini on the device

The browser asks Google directly (`generativelanguage.googleapis.com`; Google allows that from `prineethr.com`), with the key in a header. The key lives in that browser's
local storage under `makesense.gemini`, is never sent to Firestore, and each device needs its own. The answer is turned into a page by `reader.js`, a line-for-line port of
`baselines/gemini.py` held to the Python's output by tests; the instructions and the answer's shape come from the Python through the build (`reader.json`), so there is one copy.

- **Which model.** *Better* (the default) is `gemini-3.6-flash` with thinking set to low, falling back to `gemini-3.8-flash`, then `gemini-flash-latest`, if the key cannot use one.
  *Cheaper* is `gemini-3.5-flash-lite`. On the one sample page I scored, Better found about 90% of the arrows and Cheaper about 70 to 85%; both found over 90% of the words.
  That is one page and the results moved by 15 points between two runs of the same model, so treat them as a range. Never lower the photo's detail: it halved the arrows found.
- **What it costs.** Each page records its tokens and an estimate (`readUsd`, shown as "about ₹1.2" on the page and as a monthly total on *You*). At list prices that is roughly
  ₹1 to ₹2 a page on Better and ₹0.6 to ₹1 on Cheaper (rupees at an assumed ₹95 to the dollar); the Flash models' prices double on 1 January 2027. About 3 pages a day is ₹100 to ₹320 a month.
  Thinking is billed as output, which is why low thinking is five times cheaper than the default.
- **What Google sees.** Every page added on a device with a key goes to Google. On a free key Google may use that content to improve its products; a paid key is not used that way.
- **When it cannot read.** No connection, or no key: the page goes to the Mac's queue (and is read here once it has waited three minutes with the Mac off, if a key is saved).
  A wrong or refused key, no free requests left, a model the key cannot use, or Google being slow each say what happened on the page, with *Try again* and *Use my Mac*.
  A page left "reading" because the tab closed is picked up again after two and a half minutes. Two devices cannot read the same page: the take-over is a transaction.
- **Rotate and Read again.** Gemini says which way up the photo is, and the stored photo is turned to match. *Rotate* on a Gemini-read page turns it here without asking Google (free);
  *Read again* asks once more and costs the same as the first time; *Read with Gemini* does the same for a page the Mac read.
- **What it does not do yet.** The shorthand and misreadings the Mac has learned are not applied to a Gemini reading; the Mac only passes Gemini a paragraph about how you write
  (`hints`, published with the profile) and the Mac still learns from your corrections. Pages Gemini reads are brought to the Mac when it is next on, for that learning.

Test it without spending anything: `.venv/bin/python -m baselines.try_gemini` scores a model on the public sample page beside Apple Vision (with `--model`, `--thinking`, `--list-models`, and the tokens and cost per page).
The browser side is tested in node against a pretend Google (`tests/test_cloud_reader.py`) and in real Chromium and WebKit (`tests/e2e/reader.mjs`).

## Setting it up (once)

I have not touched your Firebase project or your repository. These steps are yours, in this order: 1 to 4 are clicks in the Firebase console, 5 to 7 are a few commands in a terminal.
Where it says *console*, that is <https://console.firebase.google.com> → `anchor-notes-prineeth`. The site is published with GitHub Pages, at `https://prineethr.com/anchor/app/`.

1. **Lock the database first.** Its rules are still the open "test mode" ones, which let anyone with the project id read and write everything until 25 Nov, and that id is in this public repository.
   Console → Firestore Database → *Rules* → replace everything with the contents of `firestore.rules` → *Publish*. After that nobody gets in unless they are signed in *and* on your list (step 4).
2. **Console → Authentication → Get started → Sign-in method → Google → Enable.** Pick your email as the support email.
3. **Console → Authentication → Settings → Authorized domains → Add domain → `prineethr.com`.** Without this Google refuses the sign-in with "unauthorized domain".
4. **Console → Firestore → Data → Start collection `allowed`**, with a document whose *Document ID* is your Google email in lowercase
   (no fields needed; add one called `ok` if the console insists). Add one for anyone else who should get in. Only the console can edit this list; the site cannot.
5. **Publish the site.** The repository has to stay public for Pages on a free GitHub plan ("What the Pages site shows", below, says what that exposes).

   ```bash
   .venv/bin/python -m sense.cloud.build --out app    # the site, in app/ (rebuild and repeat whenever the app changes)
   git add app && git commit -m "Publish the app" && git push
   ```

   A minute or two later it is at `https://prineethr.com/anchor/app/`. Open it on your phone, sign in once, and use *Add to Home Screen*
   (Safari: Share → Add to Home Screen; Chrome: ⋮ → Install app). If the sign-in says "This account isn't on the list", step 4 is not done or the email differs.
6. **Give the Mac a key.** Console → Project settings → Service accounts → *Generate new private key*. Save it **outside the repository**:

   ```bash
   mkdir -p ~/.config/anchor && mv ~/Downloads/anchor-notes-prineeth-*.json ~/.config/anchor/service-account.json && chmod 600 ~/.config/anchor/service-account.json
   ```

   This key can read and change everything in the project and ignores the rules, so treat it like a password. If it leaks, delete it in the same console page and make a new one.
7. **Start the Mac's side.** Either inside the local app (one process, and you also get the local website on port 8765):

   ```bash
   caffeinate -i .venv/bin/python -m sense.app --cloud you@gmail.com --key-file ~/.config/anchor/service-account.json
   ```

   or on its own, with no local window: `caffeinate -i .venv/bin/python -m sense.cloud.worker --email you@gmail.com --key-file …`. Not both: only one may run on a notes folder
   (it refuses a second one). The first round sends every page and notebook already in `notes/` to the site.
   `caffeinate -i` stops the Mac idling to sleep while it runs; closing a laptop's lid still sleeps it. `launchd.plist.example` starts the worker at login.

## Where the site lives, and what Pages shows

The build works from any folder of any domain (every path in it is relative, and tests fail if one is not), so the same files can be served by GitHub Pages or by Firebase Hosting.
Pages is what the steps above use. The one real cost: **every page on `prineethr.com` shares one browser address with the app**, and the browser keeps your sign-in under that address, so a script
on any other page there (an analytics tag, an embed) could in principle read it. If your other pages run nothing you did not write, that is a small risk; if you ever want it gone, give the app its own subdomain
(repository Settings → Pages → Custom domain, e.g. `anchor.prineethr.com`, plus a CNAME record at your DNS; note that this moves the README page too) and nothing else changes.
Firebase Hosting does not have this problem and can send security headers; to use it instead, `npx firebase-tools deploy --only hosting` (it builds `public/` first).

**What the Pages site shows.** Pages publishes *every file in the repository* at its own address, not only the README: `samples/page-01.jpg`, `data/labeled/page-01.json` (its transcript),
`examples/shared-page-example.html`, the Python source, `firestore.rules`. Hiding files from the website does not hide them on github.com while the repository is public, and removing them
from its history means rewriting it. The sample page and its transcript are public on purpose (decided 2026-10-26); your own notes in `notes/` are not in the repository (they are in `.gitignore`).

## What is where

| Firestore path (under `users/{uid}/`) | Holds | Written by |
|---|---|---|
| `pages/{id}` | one photographed page: title, `status` (`queued` → `ready` / `failed`), the page as JSON, counts, a small thumbnail, `rev` / `learnedRev` | site; Mac |
| `pages/{id}/files/flat` | its photo, JPEG under 1 MiB (what a Firestore document can hold) | site (the phone's own shrunk copy), then Mac (the straightened one) |
| `notebooks/{id}` | a notebook's small part: title, colour, `rev`, counts, a thumbnail picture | site; Mac |
| `notebooks/{id}/parts/body` | its items and arrows | site; Mac |
| `notebooks/{id}/files/{name}` | its photos | site; Mac |
| `profile/default` | what the Mac has learned: fixes, vocabulary, stats | Mac only |
| `profileEdits/{id}` | a profile change you asked for on the site, until the Mac applies it | site; Mac clears it |
| `state/mac` | when the Mac last said it was awake | Mac only |

Top level: `allowed/{email}` (the list, console only) and `users/{uid}` (who you are). Everything else is closed (`firestore.rules`, tested in `tests/test_cloud_rules.py`).
Photos are stored in Firestore itself, not Firebase Storage, so the free plan is enough.

The site's code is the Mac app's `sense/ui.html`, `canvas.js` and design system, unchanged in how they look, plus `sense/cloud/web/`:
`backend.js` answers the app's calls from Firestore where the Python server answers them from files, and `meaning.js`, `layout.js`, `render.js`, `notebook.js`, `pageclean.js`
are the reading engine's logic ported to JavaScript line for line. `tests/test_cloud_parity.py` runs several hundred cases through both and fails if they ever differ by a character.

## As an installed app

Open the site once, signed in, with a connection. After that it opens with no connection at all, from the device's copy of the app's files and of your notes. To install it: on Android or desktop Chrome,
*You → Install on this device* (or the browser menu → Install app); on iPhone, Share → Add to Home Screen. Installed, it opens full-screen, from its own icon, and the browser is much less likely to clear its offline copies
(the *You* page says whether this browser has agreed to keep them).

- **Offline** a small notice at the top says so, and your changes (words fixed, notebooks written in, photos added) are kept on the device and sent when the connection returns, then a note says they went.
  A photo added offline shows as "Not sent yet" until it is on the server, and only then waits for the Mac. Nothing is sent while the app is closed: it sends the next time you open it with a connection.
- **Take a photo** on a phone opens the camera straight away; *Choose from your library* is the other button.
- **Share to the app** (Android and desktop Chrome, once installed): share a photo from the gallery or camera and pick Make sense. The app shows it and asks before adding it to your pages, so nothing arrives unasked.
  iPhone does not let web apps receive shares; use *Choose from your library* there.
- **Updates** never swap files under a page that is open. A new version downloads quietly and a message offers *Reload*; until you accept, the version you are using keeps working. The app looks for one when you return to it after an hour away.
- **Not built:** a notification when the Mac has read a page (needs a push service and a permission prompt of its own), and sending queued photos while the app is closed (browsers only offer that on Android Chrome).

Checks, from cheapest to most real: `tests/test_cloud_build.py` (the manifest against what browsers require to install, every path relative), `tests/test_cloud_parity.py` (the service worker's rules, run against a fake cache),
and `tests/e2e/pwa.mjs`, which drives real Chromium and WebKit (Safari's engine) against the emulators: registers the worker in a folder, reloads with the network cut and finds the app and its data, writes offline and watches it arrive,
announces and accepts an update, receives a shared photo, and asks Chrome whether it is installable. See the header of that file for the five commands to run it.

## When two devices disagree

* **Notebooks** move forward one revision at a time (a security rule enforces it). If a device was offline while you changed the same notebook elsewhere, its save is refused when it
  reconnects and what you wrote is kept as a second notebook, "… (offline edits)", with a notice. Between the Mac and the site, if both changed, the site's version wins and the Mac's is kept as "… (Mac copy)".
* **Pages**: if you corrected the same page on the Mac and on the site, the site's version wins and the Mac's is saved as `notes/<id>/page.local-backup.json`.
* **Deleting** a page or notebook on one side deletes it on the other when the Mac next syncs; the photo and words leave the cloud immediately, only a marker stays until then.

## What it costs, and its limits

Free plan, as it is used: the Mac asks Firestore for changes every 15 s (about 3 reads, 17k a day against the 50k free), says it is awake once a minute (1.4k writes against 20k),
and your devices listen for changes. A photo is one 0.4–0.9 MB document; the free 1 GiB holds well over a thousand. Hosting is free at this size. Each notebook must fit in about 900 KB of text.
Set a budget alert in Google Cloud (Billing → Budgets) if you want to be told before it could ever matter.

## Running it locally, without touching your project

```bash
npx firebase-tools emulators:start --only auth,firestore,hosting --project demo-anchor-notes   # fake Google, fake database, site on http://127.0.0.1:5005
.venv/bin/python -m sense.cloud.build --emulator                                               # a build that talks to them (never deploy this one)
# in the browser console on the site:  await __signInAs('me@example.com')   (after adding allowed/me@example.com to the emulator's database)
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 .venv/bin/python -m sense.cloud.worker --email me@example.com --project demo-anchor-notes
```

The whole suite, including the rules and the worker against a fresh emulator, in one go:

```bash
npx firebase-tools emulators:exec --only auth,firestore --project demo-anchor-notes ".venv/bin/python -m unittest discover -s tests -p 'test_*.py'"
```

## Not yet verified on the real thing

Built and tested against the emulators, in a browser, and in real Chromium and WebKit (offline start, offline writes, updates, sharing, installability) served from a folder of a domain; **not yet run against your real project or domain**.
Still untried: Google's own sign-in popup (the emulator signs in a made-up account), an actual install to a phone's home screen, Safari on an iPhone itself (WebKit under Playwright is the same engine, not the same app),
a share from a real Android share sheet, and the real Firestore's behaviour with the first push of all your pages. Not built: summaries written by Gemini (they need a key and stay on the Mac), and the words beside a photo you add straight onto a notebook (bring the page in from *Pages* for that).
