// Runs sense/cloud/web/sw.template.js against a fake cache and reports what it does with each request.
//   node tests/js/sw.mjs [folder]      folder: where the site lives on its domain: "/" (default) or e.g. "/anchor/app/"
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const folder = process.argv[2] || '/';
const origin = 'https://notes.example';
const scope = origin + folder;
const src = readFileSync(new URL('../../sense/cloud/web/sw.template.js', import.meta.url), 'utf8')
  .replace('__VERSION__', 'v1').replace('__FILES__', JSON.stringify(['', 'cloud/boot.js', 'config.json']));
const handlers = {}, stores = new Map();
const mkCache = name => { if (!stores.has(name)) stores.set(name, new Map()); const m = stores.get(name);
  const key = r => (typeof r === 'string' ? r : r.url);
  return { add: async r => { m.set(key(r), { body: 'cached:' + key(r).slice(origin.length) }); }, match: async r => m.get(key(r)), put: async (r, res) => { m.set(key(r), { body: await res.text() }); } }; };
let online = true, skipped = 0;
const sandbox = { self: { addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting: async () => { skipped++; }, clients: { claim: async () => {} }, registration: { scope } },
  caches: { open: async n => mkCache(n), keys: async () => [...stores.keys()], delete: async n => stores.delete(n) },
  Request: class { constructor(u) { this.url = new URL(u, origin).href; } }, URL,
  Response: class { constructor(b, o = {}) { this.b = b; this.ok = (o.status || 200) < 400; this.status = o.status || 200; this.headers = o.headers; } clone() { return this; } text() { return this.b; }
    static redirect(url, status) { return { redirect: url, status }; } },
  fetch: async r => { if (!online) throw new Error('offline'); return new sandbox.Response('network:' + new URL(r.url).pathname); } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const wait = []; await handlers.install({ waitUntil: p => wait.push(p) }); await Promise.all(wait);
const skippedAtInstall = skipped;
handlers.message({ data: 'something else' });
const skippedByStrangers = skipped;
handlers.message({ data: 'skip-waiting' });
const skippedWhenAsked = skipped;
stores.set('makesense-old', new Map()); stores.set('makesense-shared', new Map([['kept', { body: 'a photo' }]])); const w2 = []; await handlers.activate({ waitUntil: p => w2.push(p) }); await Promise.all(w2);
const ask = async (url, mode = 'cors', method = 'GET') => {
  let answer;
  handlers.fetch({ request: { url: url.startsWith('http') ? url : origin + url, method, mode }, respondWith: p => { answer = p; } });
  if (answer === undefined) return 'passed through';
  const r = await answer;
  return r.body ?? r.b;
};
const out = {
  precached: [...stores.get('makesense-v1').keys()].map(k => k.slice(origin.length)),
  oldCacheDropped: !stores.has('makesense-old'),
  navigation: await ask(folder, 'navigate'),
  asset: await ask(folder + 'cloud/boot.js'),
  otherSite: await ask('https://firestore.googleapis.com/v1/x'),
  authHelper: await ask(folder + '__/auth/handler'),
  post: await ask(folder + 'cloud/boot.js', 'cors', 'POST'),
  anotherPageOnTheDomain: await ask('/somewhere-else/page.html'),
};
out.updates = { skippedAtInstall, skippedByStrangers, skippedWhenAsked };
out.sharedPhotoSurvivesAnUpdate = stores.get('makesense-shared')?.has('kept');
// a photo shared to the app
const photo = (type, name) => ({ type, name });
const share = async (target, parts, method = 'POST') => {
  let answer;
  handlers.fetch({ request: { url: target, method, mode: 'navigate', formData: async () => ({ getAll: () => parts }) }, respondWith: p => { answer = p; } });
  return answer === undefined ? 'passed through' : await answer;
};
const res = await share(scope + 'share-target', [photo('image/jpeg', 'a.jpg'), photo('text/html', 'evil.html'), 'not a file', photo('image/png', 'b.png')]);
out.share = { redirectTo: res.redirect?.slice(origin.length), status: res.status, kept: [...stores.get('makesense-shared').keys()].map(k => k.slice(origin.length)) };
out.shareFromElsewhere = await share(origin + '/other/share-target', [photo('image/jpeg', 'a.jpg')]);
out.shareWithTooMany = Object.keys((await share(scope + 'share-target', Array.from({ length: 9 }, (_, i) => photo('image/jpeg', i + '.jpg')), 'POST'), Object.fromEntries(stores.get('makesense-shared')))).length;
online = false;
out.offlineShell = await ask(folder, 'navigate');
out.offlineUncached = await ask(folder + 'never-seen.js');
console.log(JSON.stringify(out));
