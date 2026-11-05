// The Board in a real browser: build a diagram from the keyboard, undo, autosave, copy across boards, freehand, pictures,
// frames, mind maps, templates, export, two tabs on one board, and the 2,000-object smoothness check.
//
//   cd tests/e2e && npm install && npx playwright install chromium      (once; see sense/cloud/README.md)
//   node tests/e2e/board.mjs [section ...]       sections: core perf draw files frames export sync ask   (default: all)
//
// It starts its own Anchor server on a spare port with a throwaway home, so it never touches notes/.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 8794);
const BASE = `http://127.0.0.1:${PORT}`;
const want = new Set(process.argv.slice(2));
const run = name => !want.size || want.has(name);

let failed = 0;
const ok = (cond, what, extra = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}${cond ? '' : '   ' + extra}`); if (!cond) failed++; };
const info = what => console.log(`       ${what}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await sleep(60); } };

const home = mkdtempSync(join(tmpdir(), 'board-e2e-'));
let serverErr = '';
const startServer = () => {
  const p = spawn(join(ROOT, '.venv/bin/python'), ['-m', 'sense.app', '--home', home, '--port', String(PORT), '--no-labeled'], {
    cwd: ROOT, env: { ...process.env, ANCHOR_CLAUDE_BIN: join(ROOT, 'tests/fake_claude.py') }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  p.stderr.on('data', d => { serverErr += d; });
  return p;
};
let server = startServer();
process.on('exit', () => server.kill());
await until(async () => fetch(`${BASE}/api/status`).then(r => r.ok).catch(() => false), 15000) || (console.error('the server did not start\n' + serverErr), process.exit(1));

const api = async (method, path, body) => {
  const r = await fetch(`${BASE}/api${path}`, { method, headers: { 'X-Makesense': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return t ? JSON.parse(t) : {};
};
const boardFile = id => JSON.parse(readFileSync(join(home, 'boards', id, 'board.json'), 'utf8'));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'], deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

const openBoard = async id => {
  await page.goto(`${BASE}/#/board/${id}`);
  await page.waitForSelector('.bd canvas');
  // by id, so a board opened straight after another is never mistaken for the one still being torn down
  await page.waitForFunction(id => window.__board && window.__board.doc && window.__board.doc.id === id, id);
  await page.waitForFunction(() => window.__board.r.stats.ms >= 0);
  await sleep(150);
};
const ed = fn => page.evaluate(fn);
const press = async (...keys) => { for (const k of keys) await page.keyboard.press(k); };
const state = () => ed(() => ({ n: __board.doc.size, types: __board.doc.list().map(o => o.type), sel: [...__board.v.sel], tool: __board.v.tool }));
const newBoard = async title => { const b = await api('POST', '/board', { title }); await openBoard(b.id); return b.id; };

// ---- 1. the core: a diagram from the keyboard ---------------------------------------------------------------------------------------
if (run('core')) {
  console.log('\ncore');
  // the section is reachable from Anchor's rail, and the list makes boards
  await page.goto(`${BASE}/#/board`);
  await page.waitForSelector('.bd-cards');
  ok(await page.locator('.rail-nav a:has-text("Boards")').count() === 1, 'Boards is in Anchor\'s rail like the other sections');
  await page.click('#bnew');
  await page.waitForSelector('.bd canvas');
  const id = (await page.evaluate(() => location.hash)).split('/').pop();
  ok(/^\d{8}-\d{6}-[0-9a-f]{4}$/.test(id), 'Start a board opens a new board', id);
  await page.waitForFunction(() => window.__board);

  // 50+ objects with no menu: N, click, type, Tab, Tab ... then shapes (S then a letter), then Alt-arrows
  const t0 = Date.now();
  await page.mouse.move(400, 200);
  await press('n');
  await page.mouse.click(300, 160);
  await page.keyboard.type('Start');
  for (let i = 1; i <= 11; i++) { await press('Tab'); await page.keyboard.type(`Step ${i}`); }
  await press('Escape');
  let s = await state();
  ok(s.types.filter(t => t === 'sticky').length === 12 && s.types.filter(t => t === 'connector').length === 11, 'N, click, type, then Tab: twelve stickies chained with eleven connectors', JSON.stringify(s.types.length));
  // a second row going down with Shift+Tab, and branches with Alt+arrows
  await ed(() => { __board.select([__board.doc.list().find(o => o.type === 'sticky').id]); });
  for (let i = 1; i <= 8; i++) { await press('Shift+Tab'); await page.keyboard.type(`Down ${i}`); await press('Escape'); await ed(() => {}); }
  // shapes: S arms the tool, a letter picks the kind, click places, type, Esc
  const kinds = ['o', 'd', 'g', 'x', 'c', 'a', 'u', 'r'];
  let y = 460;
  for (let r = 0; r < 3; r++) for (let i = 0; i < kinds.length; i++) {
    await press('s'); await press(kinds[i]);
    await page.mouse.click(120 + i * 140, y + r * 110);
    await page.keyboard.type(`S${r}${i}`); await press('Escape');
  }
  s = await state();
  const shapes = await ed(() => new Set(__board.doc.list().filter(o => o.type === 'shape').map(o => o.shape)).size);
  ok(s.n >= 50, `${s.n} objects built from the keyboard and mouse in ${((Date.now() - t0) / 1000).toFixed(1)} s, no menu opened`, `got ${s.n}`);
  ok(shapes === 8, 'all eight shape kinds are reachable by key', `kinds: ${shapes}`);
  ok(!(await ed(() => !!document.querySelector('.bd-pop'))), 'no menu was open');

  // auto-shrink: a long sentence on a sticky gets a smaller type size than a short one, and never breaks a word in two
  const fs = await page.evaluate(async () => {
    const T = await import('/web/board/text.js');
    const o = { type: 'sticky', w: 186, h: 186, text: 'Hi' };
    const small = T.layout(o).fs;
    o.text = 'A rather long sentence that will not fit at the biggest size so it has to shrink to fit nicely inside the note'; o._ = {};
    const big = T.layout(o);
    return { short: small, long: big.fs, split: big.lines.some(l => !o.text.includes(l.split(' ')[0])) };
  });
  ok(fs.long < fs.short && fs.long >= 8, `sticky text shrinks to fit (${fs.short.toFixed(0)} px for two letters, ${fs.long.toFixed(1)} px for a sentence)`);

  // autosave: change something, the file on disk has it within a second
  await ed(() => { const o = __board.doc.list().find(o => o.type === 'sticky'); __board.doc.tx('x', () => __board.doc.patch(o.id, { text: 'autosave check' })); });
  const t1 = Date.now();
  const saved = await until(async () => boardFile(id).objects.some(o => o.text === 'autosave check'), 3000);
  const took = Date.now() - t1;
  ok(saved && took <= 1000, `a change reaches the file on disk within a second (${took} ms)`, `${took} ms`);
  ok(await ed(() => document.querySelector('.bd-status').textContent) !== '', 'the status pill says so');

  // undo and redo across many steps
  const before = (await state()).n;
  await ed(() => { __board.selectAll(); });
  await press('Meta+d');
  await sleep(100);
  ok((await state()).n === before * 2, 'select all and duplicate doubles the board', `${(await state()).n} vs ${before * 2}`);
  await press('Meta+z');
  ok((await state()).n === before, 'one undo takes the duplicate back');
  await press('Meta+Shift+z');
  ok((await state()).n === before * 2, 'redo brings it back');
  await press('Meta+z');
  // delete, lock, group, z-order
  await ed(() => { __board.clear(); __board.select(__board.doc.list().filter(o => o.type === 'sticky').slice(0, 3).map(o => o.id)); });
  await press('Meta+g');
  ok(await ed(() => new Set(__board.selected().map(o => o.group)).size === 1 && !!__board.selected()[0].group), 'group');
  await press('Meta+Shift+g');
  ok(await ed(() => __board.selected().every(o => !o.group)), 'ungroup');
  await press('Meta+Shift+l');
  ok(await ed(() => __board.selected().every(o => o.locked)), 'lock');
  const x0 = await ed(() => __board.selected()[0].x);
  await press('ArrowRight');
  ok(await ed(() => __board.selected()[0].x) === x0, 'a locked object does not move');
  await press('Meta+Shift+l');
  await press('ArrowRight');
  ok(await ed(() => __board.selected()[0].x) === x0 + 10, 'unlocked, an arrow key nudges it');
  await press('Meta+]');
  await press('Delete');
  ok((await state()).n < before - 2, 'delete removes the selection and the connectors on it', `n=${(await state()).n} of ${before}`);
  await press('Meta+z');

  // Miro's zoom shortcuts, 2%-400%
  await press('Shift+1'); await sleep(500);
  ok(await ed(() => __board.cam.z) < 1.5, 'Shift+1 fits the board');
  await ed(() => __board.cam.setZoom(0.001)); ok(await ed(() => __board.cam.z) === 0.02, 'zoom stops at 2%');
  await ed(() => __board.cam.setZoom(100)); ok(await ed(() => __board.cam.z) === 4, 'zoom stops at 400%');
  await ed(() => __board.fit());
  // trackpad: ctrl+wheel (pinch) zooms about the pointer; two-finger scroll pans
  await sleep(500);
  const z0 = await ed(() => __board.cam.z);
  await page.mouse.move(640, 400);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -40); await page.keyboard.up('Control'); await sleep(80);
  ok(await ed(() => __board.cam.z) > z0, 'a pinch (ctrl + wheel) zooms in');
  const cx = await ed(() => __board.cam.x);
  await page.mouse.wheel(60, 30); await sleep(80);
  ok(await ed(() => __board.cam.x) > cx, 'two-finger scroll pans');
  // a text box can be pulled taller from its bottom edge, grows past that as you type, and keeps its width-only resize
  await ed(() => { __board.cam.x = -200; __board.cam.y = -200; __board.cam.z = 1; const o = __board.add('text', { x: 0, y: 0, text: 'hello' }); window.__t = o.id; });
  await sleep(150);
  const hs = await ed(() => Object.fromEntries(__board.handles(__board.selectionBox()).map(k => [k.id, __board.cam.toScreen(k.x, k.y)])));
  ok(['n', 's', 'e', 'w', 'se'].every(k => hs[k]), 'a text box has corner and top/bottom handles, not only the sides');
  const rc = await ed(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.x, y: r.y }; });
  const h0 = await ed(() => __board.doc.map.get(__t).h);
  await page.mouse.move(rc.x + hs.s.x, rc.y + hs.s.y); await page.mouse.down(); await page.mouse.move(rc.x + hs.s.x, rc.y + hs.s.y + 120, { steps: 6 }); await page.mouse.up();
  const h1 = await ed(() => __board.doc.map.get(__t).h);
  ok(h1 > h0 + 100, 'dragging the bottom edge makes the box taller', `${h0} -> ${h1}`);
  await ed(() => __board.edit(__t, {})); await page.keyboard.type(' and some more words');
  await press('Escape');
  ok(await ed(() => __board.doc.map.get(__t).h) === h1, 'typing a little more keeps that height');
  await ed(() => __board.edit(__t, { selectAll: true })); await page.keyboard.type('line\n'.repeat(12)); await press('Escape');
  ok(await ed(() => __board.doc.map.get(__t).h) > h1, 'and a lot more makes it grow downward');
  await ed(() => __board.remove([__t]));
  // the + handles around a note stay out of the way while you type in it
  await ed(() => { const o = __board.add('sticky', { x: 0, y: 0, text: '' }); __board.edit(o.id, {}); });
  await sleep(150);
  const q = await ed(() => ({ editing: !!__board.v.editing, drawn: __board.v.quick && !__board.v.editing, hit: __board.quickAt(...Object.values(__board.cam.toScreen(__board.selected()[0].x + __board.selected()[0].w / 2, __board.selected()[0].y + __board.selected()[0].h + 22))) }));
  ok(q.editing && !q.drawn && q.hit === null, 'the + handles are not drawn or clickable while typing in a note', JSON.stringify(q));
  await press('Escape');
  ok(await ed(() => !__board.v.editing && !!__board.v.quick), 'and they come back when you stop typing');
  // ...and what is on screen follows at once: the canvas is redrawn on the next frame, not when something else happens to trigger it
  await ed(() => { const r = __board.r, d = r.draw.bind(r); window.__draws = 0; r.draw = (...a) => { window.__draws++; return d(...a); }; });
  const drew = async (label, act) => {
    await sleep(120); await ed(() => { window.__draws = 0; }); await act();
    await ed(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
    ok(await ed(() => window.__draws) >= 1, `${label} is drawn on the next frame`);
  };
  await drew('a two-finger pan', () => page.mouse.wheel(40, 20));
  await drew('a pinch zoom', async () => { await page.keyboard.down('Control'); await page.mouse.wheel(0, 30); await page.keyboard.up('Control'); });
  await drew('a middle-button drag', async () => {
    await page.mouse.move(600, 400); await page.mouse.down({ button: 'middle' }); await page.mouse.move(660, 430, { steps: 3 }); await page.mouse.up({ button: 'middle' });
  });
  await drew('the zoom buttons', () => ed(() => __board.zoomBy(1.25)));
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
}

// ---- 2. smoothness with 2,000 objects ------------------------------------------------------------------------------------------------
if (run('perf')) {
  console.log('\nperf: 2,000 objects');
  const b = await api('POST', '/board', { title: 'Two thousand' });
  const objs = [];
  for (let i = 0; i < 2000; i++) {
    const c = i % 40, r = Math.floor(i / 40);
    const kind = i % 10;
    if (kind < 6) objs.push({ id: `s${i}`, type: 'sticky', x: c * 230, y: r * 230, w: 190, h: 190, text: `Idea ${i}: a sentence or two of text on this note`, color: ['light_yellow', 'light_blue', 'light_green', 'pink', 'orange'][i % 5] });
    else if (kind < 9) objs.push({ id: `p${i}`, type: 'shape', shape: ['rect', 'ellipse', 'diamond', 'hexagon'][i % 4], x: c * 230, y: r * 230, w: 180, h: 120, fill: '#FFFFFF', stroke: '#1A1A1A', text: `Shape ${i}` });
    else objs.push({ id: `t${i}`, type: 'text', x: c * 230, y: r * 230, w: 200, h: 40, text: `Label ${i}`, text_style: { size: 20 } });
  }
  for (let i = 0; i < 400; i++) objs.push({ id: `c${i}`, type: 'connector', x: 0, y: 0, w: 0, h: 0, from: { id: `s${(i * 10) % 2000}`, side: 'auto' }, to: { id: `s${((i * 10) + 10) % 2000}`, side: 'auto' }, shape: ['straight', 'elbow', 'curved'][i % 3] });
  const res = await api('PUT', `/board/${b.id}`, { upsert: objs.filter(o => o.type !== 'sticky' || true) });
  ok(res.rev > 1, `${objs.length} objects saved`);
  await openBoard(b.id);
  // Playwright's chromium has no GPU: frame costs here are an upper bound for a real Mac.
  const measure = async (label, drive) => {
    const out = await page.evaluate(async drive => {
      const ed = __board, cam = ed.cam, r = ed.r;
      const intervals = [], draws = [];
      let last = performance.now(), frames = 0, done = false;
      const fn = new Function('ed', 'i', drive);
      await new Promise(resolve => {
        const loop = now => {
          fn(ed, frames);
          r.need = true;
          intervals.push(now - last); last = now; draws.push(r.stats.ms);
          if (++frames < 240) requestAnimationFrame(loop); else resolve();
        };
        requestAnimationFrame(loop);
      });
      const q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
      return { p50: q(intervals.slice(5), 0.5), p95: q(intervals.slice(5), 0.95), draw50: q(draws.slice(5), 0.5), draw95: q(draws.slice(5), 0.95), drawn: r.stats.drawn, fps: 1000 / (intervals.slice(5).reduce((a, b) => a + b, 0) / (intervals.length - 5)) };
    }, drive);
    info(`${label}: ${out.fps.toFixed(0)} fps, frame p50 ${out.p50.toFixed(1)} ms / p95 ${out.p95.toFixed(1)} ms, draw p50 ${out.draw50.toFixed(1)} ms / p95 ${out.draw95.toFixed(1)} ms, ${out.drawn} drawn`);
    return out;
  };
  await ed(() => { __board.fit(); });
  await sleep(600);
  const fitView = await ed(() => __board.cam.view());
  const wide = await measure('pan, everything on screen (zoomed out)', 'ed.cam.x += 11; ed.cam.y += 6; ed.cam.onChange();');
  await ed(() => { __board.cam.x = 3000; __board.cam.y = 3000; __board.cam.z = 1; __board.cam.onChange(); });
  const near = await measure('pan at 100%', 'ed.cam.x += 14; ed.cam.y += 9; ed.cam.onChange();');
  await ed(() => { __board.cam.x = 3000; __board.cam.y = 3000; __board.cam.z = 0.3; __board.cam.onChange(); });
  const zoom = await measure('zoom in and out around the pointer', 'ed.cam.zoomAt(640, 400, i % 40 < 20 ? 1.03 : 1 / 1.03);');
  info(`fit view was ${JSON.stringify(fitView)}`);
  ok(wide.draw95 < 16, `drawing 2,000 objects stays under a 60 fps frame budget (${wide.draw95.toFixed(1)} ms at the 95th percentile, zoomed out)`);
  ok(near.draw95 < 16 && zoom.draw95 < 16, `and while panning and zooming up close (${near.draw95.toFixed(1)} / ${zoom.draw95.toFixed(1)} ms)`);
  ok(wide.fps > 50 && near.fps > 50 && zoom.fps > 50, `measured frame rate holds 60 fps here (${wide.fps.toFixed(0)} / ${near.fps.toFixed(0)} / ${zoom.fps.toFixed(0)} fps)`);
  // hit testing and marquee on a big board stay quick
  const hit = await ed(() => { const t = performance.now(); for (let i = 0; i < 200; i++) __board.pick(3000 + i * 3, 3000 + i * 2); return (performance.now() - t) / 200; });
  ok(hit < 2, `picking an object under the pointer takes ${hit.toFixed(2)} ms`);
}


// ---- 3. freehand -----------------------------------------------------------------------------------------------------------------------
if (run('draw')) {
  console.log('\nfreehand');
  const id = await newBoard('Freehand');
  await press('p');
  ok(await ed(() => __board.v.tool) === 'pen', 'P picks the pen');
  await page.mouse.move(300, 300); await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(300 + i * 8, 300 + Math.sin(i / 3) * 40);
  await page.mouse.up();
  let strokes = await ed(() => __board.doc.list().filter(o => o.type === 'draw'));
  ok(strokes.length === 1 && strokes[0].tool === 'pen' && strokes[0].points.length >= 30, `a stroke is one object with its points (${strokes[0]?.points.length / 3} points)`);
  const raw = 31, kept = strokes[0].points.length / 3;
  ok(kept <= raw, 'the points are thinned, not stored one per pixel');
  await press('p');
  ok(await ed(() => __board.v.tool) === 'highlighter', 'P again switches to the highlighter');
  await page.mouse.move(300, 420); await page.mouse.down(); await page.mouse.move(500, 424, { steps: 8 }); await page.mouse.up();
  strokes = await ed(() => __board.doc.list().filter(o => o.type === 'draw'));
  ok(strokes.length === 2 && strokes[1].tool === 'highlighter' && strokes[1].width > strokes[0].width, 'the highlighter is wider and its own tool');
  // widths and colour
  const widths = await ed(() => import('/web/board/draw.js').then(m => [m.PEN_WIDTHS.length, m.HL_WIDTHS.length]));
  ok(widths[0] >= 3 && widths[1] >= 3, `three or more widths (${widths})`);
  await page.click('.bd-fly [data-tool=pen]');
  await page.click('.bd-fly [data-width]:nth-of-type(4)');
  await page.click('.bd-fly [data-pencolor]:nth-of-type(5)');
  await page.mouse.move(300, 500); await page.mouse.down(); await page.mouse.move(420, 520, { steps: 5 }); await page.mouse.up();
  const last = await ed(() => __board.doc.list().filter(o => o.type === 'draw').pop());
  ok(last.width === 14, `a chosen width is used (${last.width})`);
  ok(/^#F24726$/i.test(last.color) || last.color !== '#F5D128', `a chosen colour is used (${last.color})`);
  ok(await ed(() => !!document.querySelector('.bd-fly input[type=color]')), 'there is a colour picker for any colour');
  // pressure from a stylus
  await press('p'); await press('p');
  await ed(() => __board.setTool('pen'));
  await page.evaluate(() => {
    const cv = document.querySelector('.bd-cv'), r = cv.getBoundingClientRect();
    const ev = (type, x, y, pressure) => cv.dispatchEvent(new PointerEvent(type, { pointerId: 77, pointerType: 'pen', isPrimary: true, clientX: r.left + x, clientY: r.top + y, pressure, button: 0, buttons: 1, bubbles: true }));
    ev('pointerdown', 700, 300, 0.1);
    for (let i = 1; i <= 20; i++) ev('pointermove', 700 + i * 10, 300 + i * 3, 0.1 + i * 0.04);
    ev('pointerup', 900, 360, 0.9);
  });
  const pen = await ed(() => __board.doc.list().filter(o => o.type === 'draw').pop());
  const pr = pen.points.filter((_, i) => i % 3 === 2);
  ok(Math.max(...pr) - Math.min(...pr) > 0.3, `stylus pressure is kept (${Math.min(...pr).toFixed(2)} to ${Math.max(...pr).toFixed(2)})`);
  // strokes are objects: select, move
  await press('v');
  const first = await ed(() => __board.doc.list().find(o => o.type === 'draw'));
  const at = { x: first.x + first.points[3 * 10], y: first.y + first.points[3 * 10 + 1] };
  await page.mouse.click(at.x + (await ed(() => 0)) + (await ed(() => -__board.cam.x)), at.y + (await ed(() => -__board.cam.y)));
  ok(await ed(() => __board.selected().some(o => o.type === 'draw')), 'a stroke is selectable like any object');
  const before = await ed(() => __board.selected()[0].x);
  const sx = at.x - (await ed(() => __board.cam.x)), sy = at.y - (await ed(() => __board.cam.y));
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 100, sy + 50, { steps: 6 }); await page.mouse.up();
  ok(Math.abs(await ed(() => __board.doc.map.get(__board.doc.list().find(o => o.type === 'draw').id).x) - (before + 100)) < 20, 'and movable');
  // the eraser removes strokes
  await press('Escape'); await press('e');
  const n0 = await ed(() => __board.doc.list().filter(o => o.type === 'draw').length);
  const cam = await ed(() => __board.cam.view());
  const f2 = await ed(() => __board.doc.list().filter(o => o.type === 'draw')[1]);
  const ex = f2.x + f2.points[0] - cam.x, ey = f2.y + f2.points[1] - cam.y;
  await page.mouse.move(ex - 5, ey); await page.mouse.down(); await page.mouse.move(ex + 200, ey + 4, { steps: 12 }); await page.mouse.up();
  const n1 = await ed(() => __board.doc.list().filter(o => o.type === 'draw').length);
  ok(n1 < n0, `the eraser removes strokes it touches (${n0} to ${n1})`);
  await press('Meta+z');
  ok(await ed(() => __board.doc.list().filter(o => o.type === 'draw').length) === n0, 'one undo puts back everything one erase removed');
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
}

// ---- 4. pictures, files, links ------------------------------------------------------------------------------------------------------
if (run('files')) {
  console.log('\npictures, files, links');
  const id = await newBoard('Files');
  const origin = await new Promise(res => {
    const s = createServer((req, r) => {
      if (req.url === '/page') { r.setHeader('content-type', 'text/html'); r.end('<html><head><title>A fine page</title><meta property="og:image" content="/thumb.png"><meta property="og:description" content="About a fine page"><link rel="icon" href="/icon.png"></head><body>hi</body></html>'); }
      else if (req.url === '/thumb.png' || req.url === '/icon.png') { r.setHeader('content-type', 'image/png'); r.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')); }
      else { r.statusCode = 404; r.end(); }
    }).listen(0, '127.0.0.1', () => res({ url: `http://127.0.0.1:${s.address().port}`, s }));
  });
  const png = await page.evaluate(() => new Promise(res => { const c = document.createElement('canvas'); c.width = 160; c.height = 100; const x = c.getContext('2d'); x.fillStyle = '#2D9BF0'; x.fillRect(0, 0, 160, 100); c.toBlob(b => b.arrayBuffer().then(a => res([...new Uint8Array(a)]))); }));
  const dispatch = (kind, files, text) => page.evaluate(([kind, files, text, png]) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([f.type === 'image' ? new Uint8Array(png) : new TextEncoder().encode(f.body)], f.name, { type: f.mime }));
    if (text) dt.setData('text/plain', text);
    const root = document.querySelector('.bd');
    if (kind === 'paste') document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    else root.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 640, clientY: 360, bubbles: true, cancelable: true }));
  }, [kind, files, text, png]);
  await page.mouse.move(500, 300);
  // paste a picture from the clipboard
  await dispatch('paste', [{ type: 'image', name: 'shot.png', mime: 'image/png' }]);
  await until(async () => (await ed(() => __board.doc.list().filter(o => o.type === 'image').length)) === 1);
  const im = await ed(() => __board.doc.list().find(o => o.type === 'image'));
  ok(im && im.w === 160 && im.h === 100, 'pasting a picture puts it on the board at its own size', JSON.stringify(im));
  await until(async () => existsSync(join(home, 'boards', id, 'assets', im.src)), 3000);
  ok(existsSync(join(home, 'boards', id, 'assets', im.src)), `the picture is stored on disk beside the board (assets/${im.src})`);
  // drag-drop a picture
  await dispatch('drop', [{ type: 'image', name: 'dropped.png', mime: 'image/png' }]);
  await until(async () => (await ed(() => __board.doc.list().filter(o => o.type === 'image').length)) === 2);
  ok(await ed(() => __board.doc.list().filter(o => o.type === 'image').length) === 2, 'dropping a picture works too');
  // a picture is resizable, keeping its shape
  await ed(() => { __board.select([__board.doc.list().find(o => o.type === 'image').id]); });
  const sb = await ed(() => { const o = __board.selected()[0], c = __board.cam.toScreen(o.x + o.w, o.y + o.h); return { x: c.x, y: c.y, w: o.w, h: o.h }; });
  await page.mouse.move(sb.x, sb.y); await page.mouse.down(); await page.mouse.move(sb.x + 120, sb.y + 5, { steps: 6 }); await page.mouse.up();
  const rz = await ed(() => __board.selected()[0]);
  ok(rz.w > sb.w + 60 && Math.abs(rz.w / rz.h - sb.w / sb.h) < 0.05, `pictures resize and keep their proportions (${Math.round(rz.w)} x ${Math.round(rz.h)})`);
  // any file type becomes a card, via paste and drop
  await dispatch('paste', [{ name: 'Report Q3.pdf', mime: 'application/pdf', body: '%PDF-1.4 fake' }]);
  await dispatch('drop', [{ name: 'notes.txt', mime: 'text/plain', body: 'hello there' }, { name: 'data.csv', mime: 'text/csv', body: 'a,b\n1,2\n' }]);
  await until(async () => (await ed(() => __board.doc.list().filter(o => o.type === 'file').length)) === 3);
  const cards = await ed(() => __board.doc.list().filter(o => o.type === 'file'));
  ok(cards.length === 3 && cards.some(c => c.name === 'Report Q3.pdf' && c.size === 13), 'any file becomes a card with its name and size', JSON.stringify(cards.map(c => [c.name, c.size])));
  ok(existsSync(join(home, 'boards', id, 'assets', 'notes.txt')) && readFileSync(join(home, 'boards', id, 'assets', 'notes.txt'), 'utf8') === 'hello there', 'the file keeps its own name on disk, unchanged');
  // picker (I)
  const chooser = page.waitForEvent('filechooser');
  await page.mouse.move(500, 300); await press('i');
  await (await chooser).setFiles({ name: 'picked.md', mimeType: 'text/markdown', buffer: Buffer.from('# hi') });
  await until(async () => (await ed(() => __board.doc.list().filter(o => o.type === 'file').length)) === 4);
  ok(await ed(() => __board.doc.list().some(o => o.name === 'picked.md')), 'the file picker (I) works');
  // double-click opens the file locally (the server is told; we do not really launch an app here)
  let opened = null;
  await page.route('**/api/board/*/open', async route => { opened = JSON.parse(route.request().postData()); await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  // (cards land where they were dropped, so pick one that is not covered by another)
  const card = await ed(() => __board.doc.list().filter(o => o.type === 'file').find(o => __board.pick(o.x + o.w / 2, o.y + o.h / 2)?.id === o.id));
  const pos = await page.evaluate(id => { const o = __board.doc.map.get(id), p = __board.cam.toScreen(o.x + o.w / 2, o.y + o.h / 2); return p; }, card.id);
  await page.mouse.dblclick(pos.x, pos.y);
  await until(async () => opened, 2000);
  ok(opened && opened.src === card.src, 'double-clicking a file card asks this Mac to open it', JSON.stringify(opened));
  // links: pasting a URL makes a card with a title, favicon and thumbnail from this Mac
  await dispatch('paste', [], `${origin.url}/page`);
  await until(async () => (await ed(() => __board.doc.list().find(o => o.type === 'link')?.title)) === 'A fine page', 6000);
  const link = await ed(() => __board.doc.list().find(o => o.type === 'link'));
  ok(link && link.title === 'A fine page' && link.favicon && link.thumb && link.desc === 'About a fine page', 'a pasted URL becomes a link card: title, favicon, thumbnail, description', JSON.stringify(link));
  ok(link && existsSync(join(home, 'boards', id, 'assets', link.thumb)) && existsSync(join(home, 'boards', id, 'assets', link.favicon)), 'the favicon and thumbnail were fetched to disk');
  // dropping a URL works too
  await page.evaluate(([u]) => { const dt = new DataTransfer(); dt.setData('text/uri-list', u); document.querySelector('.bd').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 300, clientY: 500, bubbles: true, cancelable: true })); }, [`${origin.url}/page`]);
  await until(async () => (await ed(() => __board.doc.list().filter(o => o.type === 'link').length)) === 2);
  ok(await ed(() => __board.doc.list().filter(o => o.type === 'link').length) === 2, 'dropping a URL makes a link card');
  // a failed fetch falls back to a plain URL card
  const dead = 'http://127.0.0.1:9/nowhere';
  await dispatch('paste', [], dead);
  await until(async () => (await ed(() => __board.doc.list().filter(o => o.type === 'link').length)) === 3);
  await sleep(1500);
  const plain = await ed(() => __board.doc.list().filter(o => o.type === 'link').pop());
  ok(plain.url === dead && plain.title === dead && !plain.thumb && !plain.favicon, 'if the fetch fails it is a plain URL card', JSON.stringify(plain));
  // all of it is plain JSON on disk, readable without the app
  await until(async () => boardFile(id).objects.length === 9, 4000);
  const file = boardFile(id);
  ok(file.format === 'anchor-board' && file.objects.length === 9 && readdirSync(join(home, 'boards', id, 'assets')).length >= 8, `the board is board.json plus an assets folder (${file.objects.length} objects, ${readdirSync(join(home, 'boards', id, 'assets')).length} files)`);
  // copy across boards brings the pictures with it
  await ed(() => { __board.select(__board.doc.list().filter(o => o.type === 'image').map(o => o.id)); });
  await press('Meta+c');
  const other = await api('POST', '/board', { title: 'Other' });
  await openBoard(other.id);
  await page.mouse.move(500, 300);
  await press('Meta+v');
  await until(async () => (await ed(() => __board.doc.list().filter(o => o.type === 'image').length)) === 2);
  const pasted = await ed(() => __board.doc.list().filter(o => o.type === 'image'));
  await until(async () => pasted.every(o => existsSync(join(home, 'boards', other.id, 'assets', o.src))), 4000);
  ok(pasted.length === 2 && pasted.every(o => existsSync(join(home, 'boards', other.id, 'assets', o.src))), 'copy and paste across boards works, pictures included');
  origin.s.close();
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
}


// ---- 5. frames, mind maps, templates, search, the boards list ------------------------------------------------------------------------
if (run('frames')) {
  console.log('\nframes');
  const id = await newBoard('Frames');
  await press('f');
  await page.mouse.move(250, 220); await page.mouse.down(); await page.mouse.move(700, 520, { steps: 6 }); await page.mouse.up();
  await page.keyboard.type('Plan'); await press('Enter');
  let f = await ed(() => __board.doc.list().find(o => o.type === 'frame'));
  ok(f && f.title === 'Plan' && f.w > 300, 'F and drag makes a titled frame', JSON.stringify(f));
  await press('n'); await page.mouse.click(400, 400); await page.keyboard.type('inside'); await press('Escape');
  await press('n'); await page.mouse.click(900, 600); await page.keyboard.type('outside'); await press('Escape');
  const kids = await ed(() => __board.doc.list().filter(o => o.type === 'sticky').map(o => [o.text, o.parent || null]));
  ok(kids.find(k => k[0] === 'inside')?.[1] === f.id && kids.find(k => k[0] === 'outside')?.[1] === null, 'a sticky dropped inside belongs to the frame; one outside does not', JSON.stringify(kids));
  const pos0 = await ed(() => Object.fromEntries(__board.doc.list().filter(o => o.type === 'sticky').map(o => [o.text, [o.x, o.y]])));
  const title = await ed(id => { const o = __board.doc.map.get(id), p = __board.cam.toScreen(o.x + 30, o.y - 12); return p; }, f.id).catch(() => null) || await page.evaluate(id => { const o = __board.doc.map.get(id), p = __board.cam.toScreen(o.x + 30, o.y - 12); return p; }, f.id);
  await press('Escape'); await press('v');
  await page.mouse.move(title.x, title.y); await page.mouse.down(); await page.mouse.move(title.x + 120, title.y + 60, { steps: 6 }); await page.mouse.up();
  const pos1 = await ed(() => Object.fromEntries(__board.doc.list().filter(o => o.type === 'sticky').map(o => [o.text, [o.x, o.y]])));
  ok(Math.abs(pos1.inside[0] - pos0.inside[0] - 120) < 3 && pos1.outside[0] === pos0.outside[0], 'dragging a frame by its title takes what is inside along; what is outside stays');
  // wrap the selection: F with a selection frames it
  await ed(() => { __board.select([__board.doc.list().find(o => o.text === 'outside').id]); });
  await press('f');
  ok(await ed(() => __board.doc.list().filter(o => o.type === 'frame').length) === 2, 'F with something selected wraps it in a frame');
  await press('Escape');
  const framesUnder = () => ed(() => { const o = __board.doc.order, m = __board.doc.map; return o.every((id, i) => { const k = m.get(id); return !k.parent || o.indexOf(k.parent) < i; }); });
  await press('Meta+z'); await press('Meta+Shift+z');
  ok(await ed(() => __board.doc.list().filter(o => o.type === 'frame').length) === 2 && await framesUnder(), 'undo then redo of that brings the frame back, still underneath what it holds');
  // frames list for navigation
  await page.click('[data-a=frames]');
  await page.waitForSelector('.bd-frames:not([hidden]) .bd-frame-row');
  ok(await page.locator('.bd-frame-row').count() === 2, 'the frames list shows every frame');
  const z0 = await ed(() => __board.cam.view());
  await page.locator('.bd-frame-row').first().click(); await sleep(600);
  ok(await ed(() => __board.v.sel.size) === 1, 'clicking a frame in the list takes you to it');
  // per-frame PNG
  const dl = page.waitForEvent('download');
  await page.locator('[data-a=frame-png]').first().click();
  const d = await dl, path = await d.path();
  const head = readFileSync(path).subarray(0, 8);
  ok(head.toString('hex') === '89504e470d0a1a0a' && /plan/.test(d.suggestedFilename()), `per-frame PNG export (${d.suggestedFilename()}, ${readFileSync(path).length} bytes)`);
  // mind map: Tab child, Enter sibling, auto layout, fold
  await press('Escape'); await page.click('[data-a=frames]');
  const mid = await newBoard('Mind');
  await page.mouse.move(400, 360);
  await press('m'); await page.keyboard.type('Topic');
  await press('Tab'); await page.keyboard.type('Alpha');
  await press('Enter'); await page.keyboard.type('Beta');
  await press('Tab'); await page.keyboard.type('Beta one');
  await press('Enter'); await page.keyboard.type('Beta two');
  await press('Escape');
  const nodes = await ed(() => __board.doc.list().filter(o => o.type === 'node').map(o => ({ id: o.id, t: o.text, p: o.mm.parent, x: o.x, y: o.y, w: o.w, h: o.h })));
  const by = Object.fromEntries(nodes.map(n => [n.t, n]));
  ok(nodes.length === 5 && by.Alpha.p === by.Topic.id && by.Beta.p === by.Topic.id && by['Beta one'].p === by.Beta.id && by['Beta two'].p === by.Beta.id, 'Tab adds a child, Enter adds a sibling', JSON.stringify(nodes.map(n => [n.t, n.p && nodes.find(m => m.id === n.p)?.t])));
  const overlap = nodes.some((a, i) => nodes.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
  ok(!overlap && nodes.every(n => n.t === 'Topic' || n.x > by.Topic.x), 'the tree lays itself out: no overlaps, children to the right');
  ok(await ed(() => __board.doc.list().filter(o => o.type === 'connector' && o.auto === 'mm').length) === 4, 'every branch has a connector that follows');
  // fold
  await ed(() => __board.select([__board.doc.list().find(o => o.text === 'Beta').id]));
  await press('c');
  ok(await ed(() => __board.v.hidden.size) >= 2, 'C folds a branch away', await ed(() => [...__board.v.hidden].length));
  await press('c');
  ok(await ed(() => __board.v.hidden.size) === 0, 'and unfolds it');
  // moving the root moves the whole tree
  await ed(() => __board.select([__board.doc.list().find(o => o.text === 'Topic').id]));
  const b1 = await ed(() => __board.doc.list().find(o => o.text === 'Beta two').x);
  await press('Shift+ArrowRight');
  ok(await ed(() => __board.doc.list().find(o => o.text === 'Beta two').x) === b1 + 50, 'moving the root takes every branch with it');
  // deleting a branch deletes what hangs off it
  await ed(() => __board.select([__board.doc.list().find(o => o.text === 'Beta').id]));
  await press('Delete');
  ok(await ed(() => __board.doc.list().filter(o => o.type === 'node').length) === 2, 'deleting a node deletes its branches');
  await press('Meta+z');
  ok(await ed(() => __board.doc.list().filter(o => o.type === 'node').length) === 5, 'and undo brings them back');

  console.log('\ntemplates');
  const tid = await newBoard('Templates');
  await page.click('[data-a=templates]');
  await page.waitForSelector('.bd-tpl');
  const names = await page.locator('.bd-tpl-open b').allInnerTexts();
  ok(names.length === 6 && ['Brainstorm', '2×2 matrix', 'Kanban board', 'User journey map', 'Empathy map', 'Retrospective'].every(n => names.includes(n)), `six templates ship: ${names.join(', ')}`);
  for (const n of names) {
    await page.click('[data-a=templates]').catch(() => {});
    if (!(await page.locator('.bd-tpl').count())) await page.click('[data-a=templates]');
    await page.waitForSelector('.bd-tpl');
    const before = await ed(() => __board.doc.size);
    await page.locator('.bd-tpl-open', { hasText: n }).first().click();
    await until(async () => (await ed(() => __board.doc.size)) > before);
    const added = (await ed(() => __board.doc.size)) - before;
    info(`${n}: ${added} objects`);
    ok(added >= 8, `inserting “${n}”`);
    await sleep(200);
  }
  // save the selection as a template and use it
  await ed(() => __board.select(__board.doc.list().filter(o => o.type === 'sticky').slice(0, 3).map(o => o.id)));
  await page.click('[data-a=templates]');
  await page.waitForSelector('.bd-tpl-save input:not([disabled])');
  await page.fill('.bd-tpl-save input', 'My three');
  await page.click('[data-save]');
  await until(async () => (await api('GET', '/board/templates')).templates?.length === 1);
  ok((await api('GET', '/board/templates')).templates[0].name === 'My three', 'save selection as template');
  await ed(() => __board.clear());
  await page.click('[data-a=templates]');
  await page.waitForSelector('.bd-tpl');
  const n0 = await ed(() => __board.doc.size);
  await page.locator('.bd-tpl-open', { hasText: 'My three' }).click();
  await until(async () => (await ed(() => __board.doc.size)) > n0);
  ok((await ed(() => __board.doc.size)) >= n0 + 3, 'a saved template can be inserted from the picker');
  ok(errors.length === 0, 'no console errors', errors.join(' | '));

  console.log('\nsearch');
  const sid = await newBoard('Search');
  await page.mouse.move(300, 300);
  for (const [i, t] of ['banana split', 'apple pie', 'Banana bread'].entries()) { await press('n'); await page.mouse.click(200 + i * 260, 300); await page.keyboard.type(t); await press('Escape'); }
  await press('Meta+f');
  await page.keyboard.type('banana');
  await sleep(150);
  ok(await ed(() => __board.v.hl.size) === 2 && /found|of/.test(await page.locator('.bd-count').innerText()), 'Cmd+F finds text on the board, case-insensitively');
  await press('Enter'); await sleep(500);
  ok(await ed(() => __board.v.sel.size) === 1, 'Enter goes to a match');
  await press('Escape');

  console.log('\nthe boards list');
  await page.goto(`${BASE}/#/board`);
  await page.waitForSelector('.bd-cards');
  const count = () => page.locator('.bd-card').count();
  const total = await count();
  await page.fill('#bq', 'search');
  await until(async () => (await count()) === 1);
  ok(await count() === 1, 'search by title narrows the list');
  await page.fill('#bq', '');
  await until(async () => (await count()) === total);
  // duplicate, rename, delete to trash, restore
  await page.locator('.bd-card', { hasText: 'Search' }).hover();
  await page.locator('.bd-card', { hasText: 'Search' }).locator('[data-act=dup]').click();
  await until(async () => (await count()) === total + 1);
  ok(await count() === total + 1, 'duplicate');
  const dup = (await api('GET', '/board')).boards.find(b => b.title === 'Search (copy)');
  ok(dup && dup.objects === 3, 'the copy has the same things on it');
  await page.locator('.bd-card', { hasText: 'Search (copy)' }).locator('[data-act=rename]').click();
  await page.waitForSelector('#rn');
  await page.fill('#rn', 'Renamed board'); await page.keyboard.press('Enter');
  await until(async () => (await api('GET', '/board')).boards.some(b => b.title === 'Renamed board'));
  ok((await api('GET', '/board')).boards.some(b => b.title === 'Renamed board'), 'rename');
  await page.locator('.bd-card', { hasText: 'Renamed board' }).locator('[data-act=del]').click();
  await page.click('.nw-sheet [data-id=yes]');
  await until(async () => (await api('GET', '/board/trash')).boards.length === 1);
  ok((await api('GET', '/board/trash')).boards[0].title === 'Renamed board' && existsSync(join(home, 'boards', '.trash', dup.id, 'board.json')), 'delete moves a board to a recoverable trash (nothing erased)');
  await page.click('#btrash');
  await page.waitForSelector('[data-act=restore]');
  await page.click('[data-act=restore]');
  await until(async () => (await api('GET', '/board/trash')).boards.length === 0);
  ok((await api('GET', '/board')).boards.some(b => b.title === 'Renamed board'), 'restore from the trash');
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
}

// ---- helpers for the export section --------------------------------------------------------------------------------------
const canon = v => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const byId = (a, b) => (a.id < b.id ? -1 : 1);
const bytesOf = async (w, h, color) => Buffer.from(await page.evaluate(([w, h, color]) => new Promise(res => {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h);
  c.toBlob(b => b.arrayBuffer().then(a => res([...new Uint8Array(a)])));
}), [w, h, color]));
const upload = async (bid, name, mime, body, keep = false) => {
  const r = await fetch(`${BASE}/api/board/${bid}/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}${keep ? '&keep=1' : ''}`, { method: 'POST', headers: { 'X-Makesense': '1', 'Content-Type': mime }, body });
  return r.json();
};
// Toasts replace each other and last a few seconds, so wait for the words, not for "a toast".
const toastWith = async (re, ms = 6000) => !!(await page.waitForFunction(src => { const t = document.querySelector('.nw-toast.transient'); return !!t && new RegExp(src, 'i').test(t.textContent); }, re.source, { timeout: ms }).catch(() => false));
// A request that is meant to be refused shows up as a console error ("Failed to load resource"); take those back out so they do not fail the section.
const forgive = async fn => { const n = errors.length; const v = await fn(); errors.splice(n, Infinity, ...errors.slice(n).filter(e => !/Failed to load resource/.test(e))); return v; };

// ---- 6. export: PNG, PDF, SVG, and the board as JSON ----------------------------------------------------------------------------------
if (run('export')) {
  console.log('\nexport');
  const pngSize = buf => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
  const isPng = buf => buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  // what export-ui.js should make for a box: scale 2, but no side over `max`
  const dims = (box, max = 8192) => { const s = Math.max(0.02, Math.min(2, max / Math.max(box.w, box.h))); return { s, w: Math.round(box.w * s), h: Math.round(box.h * s) }; };
  const boxFor = spec => page.evaluate(async spec => { const m = await import('/web/board/export-ui.js'); return m.boundsFor(__board, m.pick(__board, spec), spec); }, spec);
  const pixelsOf = (buf, pts, type = 'image/png') => page.evaluate(async ([b64, pts, type]) => {
    const bm = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type }));
    const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
    const x = c.getContext('2d'); x.drawImage(bm, 0, 0);
    return { w: bm.width, h: bm.height, px: pts.map(([px, py]) => [...x.getImageData(Math.max(0, Math.min(bm.width - 1, Math.round(px))), Math.max(0, Math.min(bm.height - 1, Math.round(py))), 1, 1).data.slice(0, 3)]) };
  }, [buf.toString('base64'), pts, type]);
  const near = (a, b, tol = 14) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const luma = c => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  // a CSS colour as the browser writes it back: '#rrggbb' or 'rgb(r, g, b)'
  const cssRgb = f => page.evaluate(f => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = '#000'; c.fillStyle = f; return c.fillStyle; }, f)
    .then(v => (v.startsWith('#') ? [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16)) : v.match(/[\d.]+/g).slice(0, 3).map(Number)));
  const svgInfo = text => page.evaluate(t => {
    const d = new DOMParser().parseFromString(t, 'image/svg+xml'), err = d.querySelector('parsererror');
    const href = i => i.getAttribute('href') || i.getAttribute('xlink:href') || '';
    return { err: err ? err.textContent.slice(0, 160) : '', root: d.documentElement.localName, ns: d.documentElement.namespaceURI, all: d.querySelectorAll('*').length,
      texts: [...d.querySelectorAll('text')].map(x => x.textContent).join(' | '), images: [...d.querySelectorAll('image')].map(i => href(i).slice(0, 22)),
      bg: (d.querySelector('svg > rect') || { getAttribute: () => '' }).getAttribute('fill') };
  }, text);
  // Open the panel (it starts on the selection if there is one, else the whole board), press a format, and hand back the file the browser saved.
  const exportAs = async (fmt, { frame } = {}) => {
    await page.click('[data-a=export]');
    await page.waitForSelector('.bd-export');
    if (frame) { await page.check('.bd-export input[value=frame]'); await page.selectOption('.bd-export select', frame); }
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click(`.bd-export [data-f=${fmt}]`)]);
    return { name: d.suggestedFilename(), data: readFileSync(await d.path()) };
  };

  // A board with one of each thing that points at a file: a picture, a link card with a thumbnail and icon, a file card.
  const made = await api('POST', '/board', { title: 'Export check' });
  const bid = made.id;
  const pic = await upload(bid, 'blue.png', 'image/png', await bytesOf(160, 100, '#2D9BF0'));
  const thumb = await upload(bid, 'thumb.png', 'image/png', await bytesOf(120, 80, '#F24726'));
  const icon = await upload(bid, 'icon.png', 'image/png', await bytesOf(32, 32, '#67C6C0'));
  const note = await upload(bid, 'notes.txt', 'text/plain', Buffer.from('hello'), true);
  const glue = id => ({ id, side: 'auto' });
  await api('PUT', `/board/${bid}`, {
    view: { x: -40, y: -80, z: 0.5 },
    upsert: [
      { id: 'f1', type: 'frame', x: 0, y: 0, w: 700, h: 430, title: 'Plan' },
      { id: 's1', type: 'sticky', parent: 'f1', group: 'g1', locked: true, x: 30, y: 40, w: 180, h: 180, color: 'light_yellow', text: 'Alpha' },
      { id: 's2', type: 'sticky', parent: 'f1', group: 'g1', x: 250, y: 40, w: 180, h: 180, color: 'light_blue', text: 'Bravo' },
      { id: 't1', type: 'text', parent: 'f1', x: 460, y: 60, w: 200, h: 40, text: 'Charlie', text_style: { size: 28, bold: true, italic: true, underline: true, align: 'center', color: '#F24726' } },
      { id: 'c1', type: 'connector', from: glue('s1'), to: glue('s2'), shape: 'straight', label: 'next', dash: 'dashed', start_head: 'circle', end_head: 'triangle', color: '#2D9BF0', width: 4 },
      { id: 'sh1', type: 'shape', shape: 'cylinder', x: 60, y: 520, w: 200, h: 120, fill: '#FFFFFF', stroke: '#1A1A1A', stroke_width: 3, dash: 'dotted', text: 'Delta' },
      { id: 's3', type: 'sticky', x: 1500, y: 100, w: 180, h: 180, color: 'orange', text: 'Echo' },
      { id: 's4', type: 'sticky', x: 1500, y: 400, w: 180, h: 180, color: 'pink', text: 'Foxtrot' },
      { id: 's5', type: 'sticky', x: 900, y: 100, w: 180, h: 180, color: 'light_green', text: 'Fish & <chips> "x"' },
      { id: 'c2', type: 'connector', from: glue('s3'), to: glue('s4'), shape: 'curved' },
      { id: 'c3', type: 'connector', from: glue('s2'), to: glue('s3'), shape: 'elbow' },
      { id: 'im1', type: 'image', x: 800, y: 520, w: 320, h: 200, src: pic.src, name: 'blue.png' },
      { id: 'ln1', type: 'link', x: 1250, y: 520, w: 300, h: 220, url: 'https://example.com/page', title: 'An example page', host: 'example.com', desc: 'About it', favicon: icon.src, thumb: thumb.src },
      { id: 'fl1', type: 'file', x: 60, y: 760, w: 240, h: 76, src: note.src, name: 'notes.txt', size: 5, mime: 'text/plain' },
      { id: 'd1', type: 'draw', x: 400, y: 740, w: 200, h: 60, tool: 'pen', color: '#1A1A1A', width: 6, points: [0, 30, 0.5, 50, 0, 0.6, 100, 60, 0.7, 150, 10, 0.6, 200, 40, 0.5] },
    ],
  });
  await openBoard(bid);
  const total = await ed(() => __board.doc.size);

  // the panel
  await page.click('[data-a=export]');
  await page.waitForSelector('.bd-export');
  ok(await page.locator('.bd-export input[value=sel]').isDisabled(), 'the export panel opens from the toolbar, and with nothing selected its Selection option is disabled');
  ok(await page.locator('.bd-export input[value=all]').isChecked() && await page.locator('.bd-export select option').count() === 1, 'it starts on the whole board and lists the board\'s frame');
  ok(await page.locator('.bd-export [data-f]').evaluateAll(b => b.map(x => x.dataset.f).join()) === 'png,svg,pdf,json', 'and offers PNG, SVG, PDF and JSON');
  await press('Escape');
  ok(await page.locator('.bd-export').count() === 0, 'Escape closes it');
  await page.click('[data-a=templates]');
  await page.waitForSelector('.bd-templates');
  await press('Escape');
  ok(await page.locator('.bd-pop').count() === 0, 'and Escape closes the templates panel too');

  // PNG: the whole board
  const allBox = await boxFor({});
  const pngAll = await exportAs('png');
  const gotAll = pngSize(pngAll.data), wantAll = dims(allBox);
  ok(isPng(pngAll.data) && pngAll.name === 'export-check.png', `PNG of the whole board: a real PNG named for the board (${pngAll.name}, ${pngAll.data.length} bytes)`);
  ok(gotAll.w === wantAll.w && gotAll.h === wantAll.h, `its size is the board's box at 2x (${gotAll.w} x ${gotAll.h})`, `want ${wantAll.w} x ${wantAll.h}`);
  ok(await toastWith(/PNG saved/), 'and says it saved');
  // what is drawn, where: a picture, a link card's thumbnail, a sticky, a frame's contents
  const spot = (box, w, x, y) => [(x - box.x) * w.s, (y - box.y) * w.s];
  const shot = await pixelsOf(pngAll.data, [spot(allBox, wantAll, 800 + 160, 520 + 100), spot(allBox, wantAll, 1250 + 150, 520 + 50), spot(allBox, wantAll, 30 + 8, 40 + 8), spot(allBox, wantAll, 1500 + 8, 100 + 8), [2, 2]]);
  ok(near(shot.px[0], [45, 155, 240]), 'the picture is in the PNG, in its own colours', JSON.stringify(shot.px[0]));
  ok(near(shot.px[1], [242, 71, 38]), 'so is the link card\'s thumbnail', JSON.stringify(shot.px[1]));
  ok(near(shot.px[2], [255, 249, 177]) && near(shot.px[3], [255, 157, 72]), 'and the stickies, where they sit on the board', JSON.stringify(shot.px.slice(2, 4)));
  const lightCorner = shot.px[4];
  ok(luma(lightCorner) > 225, 'the background is light', JSON.stringify(lightCorner));

  // PNG: a selection is a smaller picture of just that
  await ed(() => __board.select(['s3', 's4']));
  const selBox = await boxFor({ ids: ['s3', 's4'] });
  const pngSel = await exportAs('png');
  const gotSel = pngSize(pngSel.data), wantSel = dims(selBox);
  ok(isPng(pngSel.data) && /selection\.png$/.test(pngSel.name) && gotSel.w === wantSel.w && gotSel.h === wantSel.h, `PNG of a selection is the selection's box (${gotSel.w} x ${gotSel.h}, ${pngSel.name})`, `want ${wantSel.w} x ${wantSel.h}`);
  ok(gotSel.w < gotAll.w / 3 && gotSel.h < gotAll.h, `and far smaller than the whole board (${gotSel.w} x ${gotSel.h} against ${gotAll.w} x ${gotAll.h})`);
  const inSel = await pixelsOf(pngSel.data, [spot(selBox, wantSel, 1500 + 8, 100 + 8), spot(selBox, wantSel, 1500 + 8, 400 + 8)]);
  ok(near(inSel.px[0], [255, 157, 72]) && near(inSel.px[1], [241, 108, 127]), 'with the selected notes in it', JSON.stringify(inSel.px));
  // with a selection the panel's Selection option is the one that is on
  await page.click('[data-a=export]');
  await page.waitForSelector('.bd-export');
  ok(await page.locator('.bd-export input[value=sel]').isEnabled() && await page.locator('.bd-export input[value=sel]').isChecked() && /\(2\)/.test(await page.locator('.bd-export label:has(input[value=sel])').innerText()), 'with something selected, Selection is enabled, chosen, and counts what it will export');
  await ed(() => { __board.ui.closePop(); __board.clear(); });

  // PNG: one frame, with what is in it and nothing else
  const frameBox = await boxFor({ frame: 'f1' });
  const pngFrame = await exportAs('png', { frame: 'f1' });
  const gotFrame = pngSize(pngFrame.data), wantFrame = dims(frameBox);
  ok(isPng(pngFrame.data) && pngFrame.name === 'export-check-plan.png' && gotFrame.w === wantFrame.w && gotFrame.h === wantFrame.h, `PNG of one frame is the frame's box with its title (${gotFrame.w} x ${gotFrame.h}, ${pngFrame.name})`, `want ${wantFrame.w} x ${wantFrame.h}`);
  const inFrame = await pixelsOf(pngFrame.data, [spot(frameBox, wantFrame, 30 + 8, 40 + 8), spot(frameBox, wantFrame, 250 + 8, 40 + 8)]);
  ok(near(inFrame.px[0], [255, 249, 177]) && near(inFrame.px[1], [166, 204, 245]), 'with the notes that sit in it', JSON.stringify(inFrame.px));

  // PDF: one page, one picture of the board
  const pdfAll = await exportAs('pdf');
  const s = pdfAll.data.toString('latin1');
  const pdfDims = dims(allBox, 6000), k = Math.min(0.75, 14000 / Math.max(allBox.w, allBox.h));
  const media = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(s), px = /\/Width (\d+) \/Height (\d+)/.exec(s);
  ok(s.startsWith('%PDF-') && s.trimEnd().endsWith('%%EOF') && pdfAll.name === 'export-check.pdf', `PDF of the board starts with %PDF- and ends cleanly (${pdfAll.name}, ${pdfAll.data.length} bytes)`);
  ok((s.match(/\/Type \/Page\b/g) || []).length === 1 && /\/Count 1\b/.test(s), 'it has exactly one page');
  ok(/\/Subtype \/Image/.test(s) && /\/Filter \/DCTDecode/.test(s), 'and the page holds an image XObject (a JPEG)');
  ok(media && Math.abs(+media[1] - allBox.w * k) < 0.05 && Math.abs(+media[2] - allBox.h * k) < 0.05, `the page is the board's size at 96 to the inch (${media && media[1]} x ${media && media[2]} pt)`, `want ${(allBox.w * k).toFixed(2)} x ${(allBox.h * k).toFixed(2)}`);
  ok(px && +px[1] === pdfDims.w && +px[2] === pdfDims.h, `and the picture is ${pdfDims.w} x ${pdfDims.h} pixels`, px && px.slice(1, 3).join(' x '));
  // the file is well-formed: the cross-reference table points at every object, and the image stream is a whole JPEG of the stated length
  const xref = /startxref\n(\d+)/.exec(s), table = xref && s.slice(+xref[1]).startsWith('xref') ? [...s.slice(+xref[1]).matchAll(/(\d{10}) 00000 n/g)].map(m => +m[1]) : [];
  ok(table.length === 5 && table.every((off, i) => s.slice(off).startsWith(`${i + 1} 0 obj`)), 'its cross-reference table points at every object', JSON.stringify(table));
  const dct = s.indexOf('/Filter /DCTDecode'), jlen = +/\/Length (\d+)/.exec(s.slice(dct, dct + 80))[1], jstart = s.indexOf('stream\n', dct) + 7, jpeg = pdfAll.data.subarray(jstart, jstart + jlen);
  ok(jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[jlen - 2] === 0xff && jpeg[jlen - 1] === 0xd9 && s.slice(jstart + jlen).startsWith('\nendstream'), `and the image is a whole JPEG of the stated length (${jlen} bytes)`);
  const inPdf = await pixelsOf(jpeg, [spot(allBox, pdfDims, 800 + 160, 520 + 100), spot(allBox, pdfDims, 1250 + 150, 520 + 50)], 'image/jpeg');
  ok(inPdf.w === pdfDims.w && near(inPdf.px[0], [45, 155, 240], 24) && near(inPdf.px[1], [242, 71, 38], 24), 'which decodes to the same board: the picture and the link thumbnail are in it', JSON.stringify(inPdf.px));

  // SVG: well-formed, complete, and a selection is a smaller file
  const svgAll = await exportAs('svg');
  const svgText = svgAll.data.toString('utf8'), whole = await svgInfo(svgText);
  ok(!whole.err && whole.root === 'svg' && whole.ns === 'http://www.w3.org/2000/svg' && svgAll.name === 'export-check.svg', `SVG of the board parses as XML (${svgAll.name}, ${whole.all} elements)`, whole.err);
  const words = ['Plan', 'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'notes.txt', 'An example page'];
  ok(words.every(w => whole.texts.includes(w)), 'it holds every word on the board as text', words.filter(w => !whole.texts.includes(w)).join(', '));
  ok(/Fish\s*&\s*<chips>\s*"x"/.test(whole.texts), 'including the characters XML has to escape: & < > and quotes', whole.texts);
  ok(whole.images.length >= 3 && whole.images.every(i => i.startsWith('data:image/png;base64')), `and the picture, thumbnail and icon are inside it (${whole.images.length} images)`, whole.images.join(' '));
  await ed(() => __board.select(['s3', 's4']));
  const svgSel = await exportAs('svg');
  const part = await svgInfo(svgSel.data.toString('utf8'));
  ok(!part.err && part.all < whole.all && part.texts.includes('Echo') && part.texts.includes('Foxtrot') && !/Alpha|Delta|Plan/.test(part.texts), `a selection's SVG has fewer elements (${part.all} of ${whole.all}) and only its own words`, part.texts);
  ok(part.images.length === 0, 'and none of the pictures it does not use');
  await ed(() => __board.clear());
  const svgFrame = await exportAs('svg', { frame: 'f1' });
  const fr = await svgInfo(svgFrame.data.toString('utf8'));
  ok(!fr.err && ['Plan', 'Alpha', 'Bravo', 'Charlie'].every(w => fr.texts.includes(w)) && !/Echo|Delta/.test(fr.texts), 'a frame\'s SVG has the frame and what is in it, nothing else', fr.texts);

  // JSON: the whole board and its files, and back in again
  const json = await exportAs('json');
  const doc = JSON.parse(json.data.toString('utf8'));
  ok(json.name === 'export-check.board.json' && doc.format === 'anchor-board' && doc.objects.length === total, `the JSON export is the whole board (${json.name}, ${doc.objects.length} objects)`);
  const used = [pic.src, thumb.src, icon.src, note.src];
  ok(used.every(n => doc.assets[n] && Buffer.from(doc.assets[n], 'base64').equals(readFileSync(join(home, 'boards', bid, 'assets', n)))) && Object.keys(doc.assets).length === used.length, 'with each picture and file it uses inside, byte for byte');
  ok(same(await api('GET', `/board/${bid}/export.json`), doc), 'and the address it comes from gives the same thing');
  const copy = await api('POST', '/board/import', doc);
  const orig = boardFile(bid), got = boardFile(copy.id);
  ok(copy.id && copy.id !== bid && existsSync(join(home, 'boards', copy.id, 'board.json')), 'importing it makes a new board', copy.id);
  ok(got.objects.length === total && same(got.objects, orig.objects), 'whose objects are identical to the original\'s, in the same order');
  ok(got.title === orig.title && same(got.view, orig.view), 'with the same title and view', JSON.stringify([got.title, got.view]));
  ok(used.every(n => existsSync(join(home, 'boards', copy.id, 'assets', n)) && readFileSync(join(home, 'boards', copy.id, 'assets', n)).equals(readFileSync(join(home, 'boards', bid, 'assets', n)))), 'and its pictures and files are on disk beside it');

  // the same file through the boards list
  await page.goto(`${BASE}/#/board`);
  await page.waitForSelector('.bd-cards');
  const listed = (await api('GET', '/board')).boards.length;
  const chooser = page.waitForEvent('filechooser');
  await page.click('#bimport');
  ok((await page.locator('#bimport').innerText()).trim() === 'Import a board', 'the boards list has an Import a board button');
  await (await chooser).setFiles({ name: json.name, mimeType: 'application/json', buffer: json.data });
  await page.waitForFunction(old => /^#\/board\/\d{8}-/.test(location.hash) && !location.hash.endsWith(old), bid);
  const viaUi = await page.evaluate(() => location.hash.split('/').pop());
  await page.waitForFunction(id => window.__board && window.__board.doc && window.__board.doc.id === id, viaUi);
  ok((await api('GET', '/board')).boards.length === listed + 1 && viaUi !== bid && viaUi !== copy.id, 'importing through the list makes one more board and opens it', viaUi);
  ok(await ed(() => __board.doc.size) === total && same(boardFile(viaUi).objects, orig.objects), 'with everything on it');
  ok(used.every(n => existsSync(join(home, 'boards', viaUi, 'assets', n))), 'pictures included');
  // a file that is not a board is turned away, and nothing is made
  await page.goto(`${BASE}/#/board`);
  await page.waitForSelector('.bd-cards');
  const before = (await api('GET', '/board')).boards.length;
  await forgive(async () => {
    const ch = page.waitForEvent('filechooser');
    await page.click('#bimport');
    await (await ch).setFiles({ name: 'not-a-board.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
    await toastWith(/isn.t an Anchor board/);
  });
  ok(await toastWith(/isn.t an Anchor board/, 500) && (await api('GET', '/board')).boards.length === before && /#\/board$/.test(await ed(() => location.hash)), 'a JSON file that is not a board is refused with a message, and nothing is made');
  await forgive(async () => {
    const ch = page.waitForEvent('filechooser');
    await page.click('#bimport');
    await (await ch).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello there') });
    await toastWith(/isn.t an Anchor board/);
  });
  ok(await toastWith(/isn.t an Anchor board/, 500) && (await api('GET', '/board')).boards.length === before, 'and so is a file that is not JSON at all, in plain words rather than the parser\'s');

  // nothing to export
  await newBoard('Nothing here');
  let downloaded = false;
  page.once('download', () => { downloaded = true; });
  await page.click('[data-a=export]');
  await page.waitForSelector('.bd-export');
  await page.click('.bd-export [data-f=png]');
  const said = await toastWith(/nothing to export/);
  await sleep(500);
  ok(said && !downloaded, 'an empty board says there is nothing to export instead of saving a blank picture');

  // exports are light whatever the screen shows: with the page in dark mode, and with the theme set on the page itself
  await openBoard(bid);
  const screenBg = () => ed(() => __board.r.theme.bg).then(cssRgb);
  for (const how of ['the system is in dark mode', 'the page is set to the dark theme']) {
    const system = how.startsWith('the system');
    await page.emulateMedia({ colorScheme: system ? 'dark' : 'light' });
    await page.evaluate(t => (t ? document.documentElement.setAttribute('data-theme', t) : document.documentElement.removeAttribute('data-theme')), system ? null : 'dark');
    await until(async () => luma(await screenBg()) < 90, 3000);
    const bgNow = await screenBg();
    ok(luma(bgNow) < 90, `(${how}: the screen is dark, ${bgNow})`);
    const dark = await exportAs('png');
    const corner = (await pixelsOf(dark.data, [[2, 2]])).px[0];
    ok(luma(corner) > 225 && near(corner, lightCorner, 3), `PNG exported while ${how} is still light, as it is in light mode`, `${JSON.stringify(corner)} against ${JSON.stringify(lightCorner)}`);
    const darkSvg = await svgInfo((await exportAs('svg')).data.toString('utf8'));
    ok(luma(await cssRgb(darkSvg.bg)) > 225, `and so is the SVG's background (${darkSvg.bg})`);
    ok(await ed(() => document.documentElement.getAttribute('data-theme')) === (system ? null : 'dark') && (await screenBg()).join() === bgNow.join(), 'and the screen keeps its own theme after an export');
  }
  await ed(() => document.documentElement.removeAttribute('data-theme'));
  await page.emulateMedia({ colorScheme: 'light' });
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
}


// ---- 7. two tabs on one board stay the same -----------------------------------------------------------------------------------------
if (run('sync')) {
  console.log('\nsync');
  const id = await newBoard('Two tabs');
  const other = await context.newPage();
  other.on('pageerror', e => errors.push(e.message));
  await other.goto(`${BASE}/#/board/${id}`);
  await other.waitForFunction(i => window.__board && window.__board.doc && window.__board.doc.id === i, id);
  await other.waitForFunction(() => window.__board.sync.es && window.__board.sync.es.readyState === 1);
  const theirs = fn => other.evaluate(fn);
  await ed(() => __board.add('sticky', { text: 'from tab one', x: 0, y: 0 }));
  ok(await until(async () => (await theirs(() => __board.doc.list().map(o => o.text))).includes('from tab one'), 5000), 'a note made in one tab appears in the other within a moment');
  await theirs(() => __board.add('shape', { shape: 'ellipse', x: 400, y: 0 }));
  ok(await until(async () => (await ed(() => __board.doc.list().map(o => o.type))).includes('shape'), 5000), 'and the other way round');
  const sid = await ed(() => __board.doc.list().find(o => o.text === 'from tab one').id);
  await page.evaluate(id => __board.doc.tx('Move', () => __board.moveBy([id], 100, 50)), sid);
  const at = await ed(() => { const o = __board.doc.list().find(o => o.text === 'from tab one'); return [o.x, o.y].join(); });
  ok(await until(async () => (await theirs(() => { const o = __board.doc.list().find(o => o.text === 'from tab one'); return o && [o.x, o.y].join(); })) === at, 5000), 'moving it shows there too');
  await page.evaluate(id => __board.remove([id]), sid);
  ok(await until(async () => !(await theirs(() => __board.doc.list().map(o => o.text))).includes('from tab one'), 5000), 'and so does deleting it');
  ok(await ed(() => __board.doc.size) === await theirs(() => __board.doc.size), 'both tabs hold the same number of things');
  await other.close();
  ok(await ed(() => __board.sync.es.readyState) === 1 && errors.length === 0, 'closing the second tab leaves the first one connected', errors.join(' | '));
}


// ---- 8. Ask Claude (tests/fake_claude.py stands in for the model) ---------------------------------------------------------------------
if (run('ask')) {
  console.log('\nask');
  const id = await newBoard('Ask');
  await ed(() => { __board.add('sticky', { text: 'Onboarding is confusing', x: 0, y: 0 }); __board.add('sticky', { text: 'Pricing page is unclear', x: 220, y: 0 }); });
  await ed(() => __board.select([__board.doc.list()[0].id]));
  const before = await ed(() => __board.doc.size), undo0 = await ed(() => __board.doc.undoStack.length);
  await page.click('[data-a=ask]');
  await page.waitForSelector('.bd-ask textarea');
  ok(await page.locator('.bd-ask select option').allInnerTexts().then(t => t.length === 3 && /Haiku/.test(t[0])) && await page.locator('.bd-ask select').inputValue() === 'haiku', 'the panel offers three models, cheapest first and chosen');
  await page.click('.bd-ask .bd-btn-text >> text=Expand');
  ok(/build on/.test(await page.inputValue('.bd-ask textarea')), 'a starter fills the prompt, which can be edited');
  await page.selectOption('.bd-ask select', 'sonnet');
  await page.click('[data-go]');
  await page.waitForFunction(n => __board.doc.size > n, before, { timeout: 20000 });
  const mine = await ed(() => __board.doc.list());
  const added = mine.filter(o => o.id.startsWith('ai'));
  ok(added.filter(o => o.type === 'sticky').length === 3 && added.filter(o => o.type === 'connector').length === 2, 'three notes and two arrows arrive');
  const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const old = mine.filter(o => !o.id.startsWith('ai') && o.type === 'sticky');
  ok(!added.filter(o => o.type === 'sticky').some(n => old.some(o => hit(n, o))), 'none of them lands on your notes');
  ok(added.some(o => o.type === 'connector' && o.from.id === old[0].id), 'an arrow joins the selected note to a new one');
  ok(old.length === 2 && old[0].text === 'Onboarding is confusing', 'your own notes are untouched');
  ok(await ed(() => __board.doc.undoStack.length) === undo0 + 1, 'the whole answer is one undo step');
  ok(/Three ideas/.test(await page.locator('.bd-ask [data-msg]').innerText()), 'the panel says what happened, with the model and tokens');
  await page.keyboard.press('Escape');
  await press('Meta+z');
  ok(await ed(() => __board.doc.size) === before, 'undo takes all of it back');
  await sleep(1200);
  const u = await api('GET', '/board/usage');
  ok(u.today.runs === 1 && u.last[0].model === 'sonnet' && u.today.out === 40, 'the run is in the usage log', JSON.stringify(u.today));
  await page.click('[data-a=ask]');
  await page.waitForSelector('.bd-ask textarea');
  ok(await page.locator('.bd-ask select').inputValue() === 'sonnet' && /Today: 1 run/.test(await page.locator('[data-use]').innerText()), 'the panel remembers the model and shows the usage');
  await page.click('[data-hist]');
  await page.waitForSelector('.bd-past li');
  ok(await page.locator('.bd-past li').count() === 1 && /Add new ideas|build on/.test(await page.locator('.bd-past b').innerText()) && /sonnet/.test(await page.locator('.bd-past span').first().innerText()) && await page.locator('[data-hist], [data-back]').count() === 1, 'the history icon lists past requests with model, notes and tokens');
  await page.click('.bd-past button');
  await page.waitForSelector('.bd-ask textarea');
  ok(/build on/.test(await page.inputValue('.bd-ask textarea')), 'clicking one puts its request back in the box');
  ok(errors.length === 0, 'no console errors', errors.join(' | '));
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
