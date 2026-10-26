// Starts the website: loads its settings, asks you to sign in with Google, checks you are on the list, then hands the page its backend.
// ui.html waits for window.MS_BOOT before it draws anything.
import * as ds from '../static/ds.js';
import * as F from './lib/firebase.js';
import { createBackend } from './backend.js';
import { configure } from './render.js';
import * as pwa from './pwa.js';

window.MS_PWA = pwa;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function gate(html) {
  let g = document.getElementById('gate');
  if (!g) {
    g = document.createElement('div');
    g.id = 'gate';
    g.setAttribute('role', 'dialog');
    g.setAttribute('aria-label', 'Sign in');
    g.style.cssText = 'position:fixed;inset:0;z-index:var(--z-dialog);background:var(--bg-canvas);display:grid;place-items:center;padding:var(--gutter);overflow:auto';
    document.body.appendChild(g);
  }
  g.innerHTML = `<div style="max-width:30rem;display:flex;flex-direction:column;gap:var(--s-4);align-items:flex-start">${html}</div>`;
  return g;
}
const closeGate = () => document.getElementById('gate')?.remove();
const wordmark = '<p class="wordmark-link" style="margin:0">Make <em>sense</em></p>';

window.MS_BOOT = (async () => {
  gate(`${wordmark}<p class="lead">Opening your notes…</p>`);
  const [cfg, theme] = await Promise.all([fetch('config.json').then(r => r.json()), fetch('theme.json').then(r => r.json())]);
  configure(theme);
  const app = F.initializeApp(cfg.firebase);
  const auth = F.getAuth(app);
  let db;
  try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager(), cacheSizeBytes: F.CACHE_SIZE_UNLIMITED }) }); }
  catch (e) {   // a browser with no usable storage (some private windows): works, but nothing is kept for offline
    console.warn('no offline storage here', e);
    db = F.initializeFirestore(app, { localCache: F.memoryLocalCache() });
    window.MS_NO_OFFLINE = true;
  }
  if (cfg.emulator) {
    F.connectAuthEmulator(auth, `http://${cfg.emulator.auth}`, { disableWarnings: true });
    F.connectFirestoreEmulator(db, ...cfg.emulator.firestore.split(':').map((x, i) => (i ? +x : x)));
    // Only the emulator build has this: a way to sign in as a made-up Google account, for tests.
    window.__net = { off: () => F.disableNetwork(db), on: () => F.enableNetwork(db) };   // pretend to lose and regain the connection
    window.__signInAs = (email, verified = true) => F.signInWithCredential(auth, F.GoogleAuthProvider.credential(JSON.stringify({ sub: email, email, email_verified: verified })));
  }
  pwa.registerWorker();

  const signOut = async () => { await F.signOut(auth); location.reload(); };
  const first = await new Promise(res => { const off = F.onAuthStateChanged(auth, u => { off(); res(u); }); });
  F.getRedirectResult(auth).catch(() => {});

  const user = first || await new Promise(resolve => {
    const show = (msg = '') => {
      const g = gate(`${wordmark}
        <h1 class="page-h" style="margin:0">Your notes,<br><em>wherever you are</em></h1>
        <p class="lead">Sign in with Google to see your pages and notebooks.</p>
        <button class="nw-btn nw-btn--primary nw-btn--lg" id="gIn" type="button"><span>Sign in with Google</span></button>
        ${msg ? `<p class="hint" role="alert" style="color:var(--danger)">${esc(msg)}</p>` : ''}`);
      g.querySelector('#gIn').onclick = async e => {
        const b = e.currentTarget; b.disabled = true; b.firstElementChild.textContent = 'Opening Google…';
        try {
          const provider = new F.GoogleAuthProvider();
          provider.setCustomParameters({ prompt: 'select_account' });
          resolve((await F.signInWithPopup(auth, provider)).user);
        } catch (err) {
          if (err.code === 'auth/popup-blocked') { F.signInWithRedirect(auth, new F.GoogleAuthProvider()); return; }
          show(err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request' ? 'The sign-in window closed before it finished. Try again.'
            : err.code === 'auth/network-request-failed' ? "Couldn't reach Google. Check your connection and try again." : `Sign-in didn't work (${err.code || err.message}).`);
        }
      };
    };
    show();
    if (cfg.emulator) F.onAuthStateChanged(auth, u => u && resolve(u));   // the test hook above signs in without the button
  });

  // Signed in is not enough: the account's email has to be on the list (a document in `allowed`, added in the Firebase console).
  // Look on this device first, so opening the app with no connection is instant; ask the server only if this device has never seen the answer.
  const listed = F.doc(db, 'allowed', user.email.toLowerCase());
  let onList = false;
  try { onList = (await F.getDocFromCache(listed)).exists(); } catch { /* not kept on this device yet */ }
  if (!onList) {
    try { onList = (await F.getDoc(listed)).exists(); }
    catch (e) {
      if (e.code !== 'permission-denied') {
        const offline = e.code === 'unavailable' || navigator.onLine === false;
        gate(`${wordmark}<p class="lead">${offline ? 'You are offline. Connect once to open your notes here; after that they open with no connection.' : `Couldn't check your account: ${esc(e.message)}`}</p>
          <button class="nw-btn nw-btn--secondary" id="retry" type="button">Try again</button>`).querySelector('#retry').onclick = () => location.reload();
        await new Promise(() => {});
      }
    }
  }
  if (!onList) {
    gate(`${wordmark}
      <h1 class="page-h" style="margin:0">This account<br><em>isn't on the list</em></h1>
      <p class="lead">You're signed in as <b>${esc(user.email)}</b>, but these notes are private to the people listed in the project.</p>
      <p class="hint">If these are your notes, add a document named exactly <b>${esc(user.email.toLowerCase())}</b> to the <code>allowed</code> collection in the Firebase console, then reload.</p>
      <button class="nw-btn nw-btn--secondary" id="out" type="button"><span>Use a different account</span></button>`).querySelector('#out').onclick = signOut;
    await new Promise(() => {});    // nothing else loads
  }
  // Not awaited: with no connection a write only finishes when it reaches the server, and nothing here should wait for that.
  F.setDoc(F.doc(db, 'users', user.uid), { email: user.email, lastSeen: Date.now() }, { merge: true }).catch(() => {});

  window.MS_BACKEND = createBackend({ db, user, onSignOut: signOut });
  pwa.keepStorage();
  closeGate();
  return window.MS_BACKEND;
})();
