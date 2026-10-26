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

**What works when the Mac is off:** opening every page and notebook you already have (and, once opened on a device, offline too), editing words,
writing and drawing in notebooks, exporting to HTML or Markdown, changing the profile. **What waits for the Mac:** reading a new photo (it sits as
"Waiting for your Mac", with its photo, and is read as soon as the Mac is on), reading a page again, and the profile learning from your edits.
The Mac is the only thing that can read handwriting, because Apple Vision only exists on macOS.

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

Built and tested against the emulators and in a browser; **not yet run against your real project**. Specifically untried: Google's own sign-in popup (the emulator signs in a made-up
account), the service worker that lets the page itself open with no connection at all (its logic is tested against a fake cache; the in-app browser I used cannot run service workers, so open the deployed
site once online, switch to airplane mode, and reload to check), the real Firestore's behaviour with the first push of all your pages, and Safari on iPhone. Things that are not built: summaries written by Gemini
(they need a key and stay on the Mac), and the words beside a photo you add straight onto a notebook (bring the page in from *Pages* for that).
