// The Board's SVG export (sense/web/board/svg.js) in a real browser: well-formed, complete, and drawn the way the canvas draws.
//
//   cd tests/e2e && npm install && npx playwright install chromium
//   node svg.mjs                       (from tests/e2e; OUT=/some/folder keeps the screenshots somewhere you choose)
//
// It starts the app by itself on port 8793 (PORT=... to change it) with a throwaway home folder, so it never touches your notes.
// text.js measures with a canvas, so the export only runs in a page: the script loads the app, imports svg.js there, and
//   1. exports a board holding one of every object type and checks the SVG is well-formed and has everything in it,
//   2. draws shapes, connectors, freehand and text twice, once the way render.js does on a canvas and once from the SVG, and compares pixels,
//   3. opens the same board in the real editor and compares its canvas with the SVG,
//   4. saves screenshots (light and dark) and the SVG itself to OUT, to look at.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT || 8793);
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.OUT || join(tmpdir(), 'board-svg-check');
const PY = process.env.PYTHON || (existsSync(join(ROOT, '.venv/bin/python')) ? join(ROOT, '.venv/bin/python') : 'python3');

let failed = 0;
const ok = (cond, what, extra = '') => { console.log(`${cond ? '  ok ' : '  FAIL'} ${what}${cond ? '' : '  ' + extra}`); if (!cond) failed++; };
const until = async (fn, ms = 30000) => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) return v; await new Promise(r => setTimeout(r, 150)); } };

mkdirSync(OUT, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'board-svg-home-'));
const server = spawn(PY, ['-m', 'sense.app', '--home', home, '--port', String(PORT), '--no-labeled'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });
let browser;

// --- the board to export ----------------------------------------------------------------------------------------------

const wave = (n, amp, step, pressure) => { const p = []; for (let i = 0; i < n; i++) p.push(Math.round(i * step * 10) / 10, Math.round((amp + Math.sin(i / 2.2) * amp) * 10) / 10, pressure(i, n)); return p; };
const glued = (id, side) => ({ id, side });
const FIXTURE = [
  { id: 'frame', type: 'frame', x: 0, y: 0, w: 700, h: 430, title: 'Planning' },
  { id: 's1', type: 'sticky', parent: 'frame', x: 30, y: 40, w: 190, h: 190, color: 'yellow', text: 'Ship the board export before Friday' },
  { id: 's2', type: 'sticky', parent: 'frame', x: 240, y: 40, w: 150, h: 150, color: 'light_pink', text: 'Call the printer', text_style: { bold: true, align: 'left', size: 18 } },
  { id: 't1', type: 'text', parent: 'frame', x: 420, y: 40, w: 250, h: 70, text: 'Bold, italic\nand underlined', text_style: { bold: true, italic: true, underline: true, align: 'center', size: 22 } },
  { id: 't2', type: 'text', parent: 'frame', x: 420, y: 130, w: 250, h: 50, fill: '#CA91D8', text: 'Filled note, right aligned', text_style: { align: 'right', size: 16 } },
  { id: 'sh1', type: 'shape', parent: 'frame', shape: 'round', x: 30, y: 260, w: 180, h: 100, fill: '#A6CCF5', stroke: '#2D9BF0', text: 'Rounded box' },
  { id: 'sh2', type: 'shape', parent: 'frame', shape: 'rect', x: 240, y: 260, w: 140, h: 100, stroke: '#F24726', stroke_width: 3, dash: 'dashed', text: 'Dashed' },
  { id: 'sh3', type: 'shape', parent: 'frame', shape: 'ellipse', x: 410, y: 260, w: 130, h: 100, dash: 'dotted', text: 'Dotted' },

  { id: 'dia', type: 'shape', shape: 'diamond', x: 20, y: 520, w: 120, h: 100, fill: '#FFF9B1', text: 'Yes?' },
  { id: 'tri', type: 'shape', shape: 'triangle', x: 200, y: 520, w: 110, h: 100, fill: '#D5F692', text: 'Up' },
  { id: 'hex', type: 'shape', shape: 'hexagon', x: 370, y: 520, w: 130, h: 100, fill: '#FFCEE0', text: 'Hex' },
  { id: 'cyl', type: 'shape', shape: 'cylinder', x: 560, y: 520, w: 100, h: 120, fill: '#A6CCF5', text: 'DB' },
  { id: 'arr', type: 'shape', shape: 'arrow', x: 720, y: 520, w: 140, h: 100, fill: '#F5D128', text: 'Go' },
  { id: 'c1', type: 'connector', shape: 'straight', from: glued('dia', 'r'), to: glued('tri', 'l'), end_head: 'arrow' },
  { id: 'c2', type: 'connector', shape: 'elbow', from: glued('tri', 'b'), to: glued('hex', 'b'), start_head: 'circle', end_head: 'triangle', color: '#2D9BF0', width: 3, label: 'elbow' },
  { id: 'c3', type: 'connector', shape: 'curved', from: glued('hex', 'r'), to: glued('cyl', 'l'), start_head: 'diamond', end_head: 'bar', dash: 'dashed' },
  { id: 'c4', type: 'connector', shape: 'elbow', from: glued('cyl', 'b'), to: glued('arr', 'b'), end_head: 'arrow', color: '#F24726', dash: 'dotted' },
  { id: 'c5', type: 'connector', shape: 'curved', from: { x: 20, y: 700 }, to: { x: 300, y: 780 }, end_head: 'triangle' },
  { id: 'c6', type: 'connector', shape: 'straight', from: glued('dia', 'b'), to: glued('gone', 't'), end_head: 'arrow' },   // its object is not in the list: left out

  { id: 'mroot', type: 'node', x: 940, y: 40, w: 160, h: 48, text: 'Mind map', mm: {} },
  { id: 'ma', type: 'node', x: 1170, y: 8, w: 150, h: 44, fill: '#93D275', text: 'Branch A', mm: { parent: 'mroot' } },
  { id: 'mb', type: 'node', x: 1170, y: 84, w: 150, h: 44, text: 'Branch B', mm: { parent: 'mroot', collapsed: true } },
  { id: 'mh', type: 'node', x: 1400, y: 84, w: 150, h: 44, text: 'Folded away', mm: { parent: 'mb' } },
  { id: 'mc1', type: 'connector', shape: 'curved', from: glued('mroot', 'r'), to: glued('ma', 'l'), end_head: 'none' },
  { id: 'mc2', type: 'connector', shape: 'curved', from: glued('mroot', 'r'), to: glued('mb', 'l'), end_head: 'none' },
  { id: 'mc3', type: 'connector', shape: 'curved', from: glued('mb', 'r'), to: glued('mh', 'l'), end_head: 'none' },

  { id: 'pen', type: 'draw', tool: 'pen', color: '#1A1A1A', width: 4, x: 940, y: 190, w: 190, h: 40, points: wave(24, 20, 8, () => 0.5) },
  { id: 'inkp', type: 'draw', tool: 'pen', color: '#5B7CE6', width: 8, x: 940, y: 270, w: 190, h: 40, points: wave(24, 20, 8, (i, n) => Math.round((0.1 + 0.9 * i / (n - 1)) * 100) / 100) },
  { id: 'hl-text', type: 'text', x: 940, y: 350, w: 200, h: 40, text: 'Highlight these words' },
  { id: 'hl', type: 'draw', tool: 'highlighter', color: '#F5D128', width: 24, x: 930, y: 364, w: 200, h: 4, points: [0, 0, 0.5, 100, 4, 0.5, 200, 0, 0.5] },
  { id: 'dot', type: 'draw', tool: 'pen', color: '#F24726', width: 14, x: 1155, y: 330, w: 1, h: 1, points: [0, 0, 0.5] },

  { id: 'img', type: 'image', x: 1180, y: 190, w: 240, h: 180, src: 'photo.png', name: 'photo.png' },
  { id: 'img2', type: 'image', x: 1450, y: 190, w: 120, h: 90, src: 'gone.png', name: 'gone.png' },
  { id: 'file', type: 'file', x: 940, y: 440, w: 280, h: 76, name: 'quarterly-budget-final-version-2.xlsx', size: 3400000, src: 'budget.xlsx' },
  { id: 'lk1', type: 'link', x: 940, y: 560, w: 300, h: 230, url: 'https://example.com/a/long/article', title: 'A long article title that wraps over a few lines of the card, so it is cut short', host: 'example.com', favicon: 'fav.png', thumb: 'thumb.png' },
  { id: 'lk2', type: 'link', x: 1280, y: 560, w: 280, h: 120, url: 'https://example.org/plain', title: 'A plain link', host: 'example.org' },
];

// --- start the app ------------------------------------------------------------------------------------------------------

try {
  const up = await until(async () => { if (server.exitCode !== null) throw new Error('server exited'); return (await fetch(`${BASE}/api/status`)).ok; });
  if (!up) throw new Error(`the app did not start on ${BASE}\n${log}`);
  // An SVG shown as an image cannot reach the page's fonts, so the export carries its own (the same Figtree the app uses).
  const fontCss = ['normal', 'italic'].map(s => `@font-face{font-family:Figtree;font-style:${s};font-weight:400 800;src:url(data:font/woff2;base64,${readFileSync(join(ROOT, `sense/static/fonts/Figtree-${s}.woff2`)).toString('base64')}) format('woff2')}`).join('');

  browser = await chromium.launch();
  const errors = [];

  /** A page with the app loaded, svg.js imported, the theme read the way the editor reads it, and three small pictures to use as assets. */
  async function open(colorScheme) {
    const context = await browser.newContext({ viewport: { width: 2000, height: 1150 }, colorScheme });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '/');
    const pngs = await page.evaluate(async () => {
      const { readTheme } = await import('/web/board/render.js');
      const T = await import('/web/board/text.js');
      const theme = readTheme();
      T.setFamily(theme.family);
      for (const f of ['600', 'italic 400', '400']) await document.fonts.load(`${f} 16px ${theme.family}`);
      await document.fonts.ready;
      const png = (w, h, paint) => { const c = document.createElement('canvas'); c.width = w; c.height = h; paint(c.getContext('2d'), w, h); return c.toDataURL('image/png'); };
      const pngs = {   // a photo (4:3), a wide thumbnail (3:1, so the crop shows), a favicon
        'photo.png': png(80, 60, (g, w, h) => { const l = g.createLinearGradient(0, 0, w, h); l.addColorStop(0, '#ff9d48'); l.addColorStop(1, '#5b7ce6'); g.fillStyle = l; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.beginPath(); g.arc(w / 2, h / 2, 14, 0, 7); g.fill(); }),
        'thumb.png': png(120, 40, (g, w, h) => { g.fillStyle = '#67c6c0'; g.fillRect(0, 0, w, h); g.fillStyle = '#c0392b'; g.fillRect(0, 0, 20, h); g.fillRect(w - 20, 0, 20, h); g.fillStyle = '#1a1a1a'; g.beginPath(); g.arc(w / 2, h / 2, 14, 0, 7); g.fill(); }),
        'fav.png': png(16, 16, g => { g.fillStyle = '#f24726'; g.fillRect(0, 0, 16, 16); g.fillStyle = '#fff'; g.fillRect(4, 4, 8, 8); }),
      };
      window.__x = { svg: await import('/web/board/svg.js'), theme, T, G: await import('/web/board/geom.js'), C: await import('/web/board/connectors.js'), P: await import('/web/board/palette.js'), assets: new Map(Object.entries(pngs)) };
      return pngs;
    });
    return { context, page, pngs };
  }

  // ---- 1. the whole board --------------------------------------------------------------------------------------------------
  console.log('\nchromium, the SVG export');
  const { context, page, pngs } = await open('light');
  ok(await page.evaluate(() => ['toSVG', 'boundsOf', 'svgPath'].every(k => typeof window.__x.svg[k] === 'function')), 'svg.js exports toSVG, boundsOf and svgPath');
  ok(await page.evaluate(() => { const { svgPath } = window.__x.svg; return svgPath('rect', 0, 0, 10, 20) === 'M0 0L10 0L10 20L0 20Z' && svgPath('diamond', 0, 0, 10, 20) === 'M5 0L10 10L5 20L0 10Z'; }), 'svgPath writes the same outline geom.trace draws');

  const whole = await page.evaluate(async ({ objects, fontCss }) => {
    const { svg, theme, assets } = window.__x;
    const objs = JSON.parse(JSON.stringify(objects));
    const out = svg.toSVG(objs, { assets, theme, css: fontCss });
    const doc = new DOMParser().parseFromString(out, 'image/svg+xml');
    const root = doc.documentElement;
    const q = s => [...doc.querySelectorAll(s)];
    const vb = (root.getAttribute('viewBox') || '').split(' ').map(Number);
    const text = t => [...t.querySelectorAll('tspan')].map(x => x.textContent).join(' ') || t.textContent;
    return {
      out, parseError: !!doc.querySelector('parsererror'), tag: root.localName, ns: root.namespaceURI, vb, w: root.getAttribute('width'), h: root.getAttribute('height'), b: svg.boundsOf(objs),
      bytes: out.length, images: q('image').length, hrefs: q('image').map(i => (i.getAttribute('xlink:href') || '').slice(0, 22)),
      clips: q('clipPath').length, ids: q('[id]').map(e => e.id), refs: [...out.matchAll(/url\(#([^)]+)\)/g)].map(m => m[1]),
      dashed: q('[stroke-dasharray]').length, bold: q('text[font-weight="600"]').length, italic: q('text[font-style="italic"]').length,
      middle: q('text[text-anchor="middle"]').length, endAnchor: q('text[text-anchor="end"]').length,
      bars: q('path').map(p => (p.getAttribute('d').match(/h[\d.]+v[\d.]+h-[\d.]+z/g) || []).length).filter(Boolean),
      lines: q('g[fill="none"][stroke-linejoin="round"][stroke-linecap="round"]').length, widths: new Set(q('g > path[stroke-width]').map(p => p.getAttribute('stroke-width'))).size,
      highlighter: q('path[opacity=".4"][stroke-linecap="butt"]').length, dots: q('circle').map(c => c.getAttribute('r')),
      words: q('text').map(text).join(' | '), family: root.getAttribute('font-family'), styles: q('style').length, hasFace: /font-face/.test(out),
    };
  }, { objects: FIXTURE, fontCss });

  ok(!whole.parseError, 'the SVG is well-formed XML');
  ok(whole.tag === 'svg' && whole.ns === 'http://www.w3.org/2000/svg', 'its root is an svg in the SVG namespace');
  ok(whole.vb.length === 4 && whole.vb.every(Number.isFinite) && String(whole.vb[2]) === whole.w && String(whole.vb[3]) === whole.h, 'it has a viewBox, and width and height to match', `${whole.vb} ${whole.w}x${whole.h}`);
  const [vx, vy, vw, vh] = whole.vb, b = whole.b;
  ok(vx <= b.x - 48 && vy <= b.y - 48 && vx + vw >= b.x + b.w + 48 && vy + vh >= b.y + b.h + 48, 'the viewBox holds every object with 48 around it', JSON.stringify({ vb: whole.vb, b }));
  ok(vx > b.x - 49 && vy > b.y - 49 && vx + vw < b.x + b.w + 49 && vy + vh < b.y + b.h + 49, '...and no more than that');
  ok(FIXTURE.filter(o => !['connector', 'draw'].includes(o.type) && o.id !== 'mh').every(o => o.x >= b.x && o.y >= b.y && o.x + o.w <= b.x + b.w && o.y + o.h <= b.y + b.h), 'boundsOf encloses every box on the board');
  ok(b.x <= 0 && b.y < 0 && b.x + b.w >= 1570 && b.y + b.h >= 790, 'and the frame title, the far link card and the free connector end (by their routes)', JSON.stringify(b));
  ok(new Set(whole.ids).size === whole.ids.length && whole.clips === 2 && whole.refs.length === 2 && whole.refs.every(r => whole.ids.includes(r)), 'two clip paths (frame title, link thumbnail), with unique ids, each used', JSON.stringify([whole.ids, whole.refs]));
  ok(whole.images === 3 && whole.hrefs.every(h => h.startsWith('data:image/png;base64')), 'three <image>s: the photo, the link thumbnail, the favicon (the missing asset is a grey box instead)', String(whole.images));
  ok(whole.dashed === 4, 'a dash pattern on the dashed shape, the dotted shape and the two non-solid connectors', String(whole.dashed));
  ok(whole.lines === 8, 'seven connectors and the stylus stroke (one has no object to join, one is folded away with its node)', String(whole.lines));
  ok(whole.bold >= 8 && whole.italic === 1 && whole.bars.join() === '2', 'bold text, one italic run, an underline bar under each of its two lines', JSON.stringify([whole.bold, whole.italic, whole.bars]));
  ok(whole.endAnchor === 1 && whole.middle >= 10, 'right- and centre-aligned text use text-anchor', JSON.stringify([whole.endAnchor, whole.middle]));
  ok(whole.widths >= 4, 'the stylus stroke has segments of several widths', String(whole.widths));
  ok(whole.highlighter === 1, 'the highlighter is 40% and butt-capped');
  ok(whole.dots.includes('7'), 'the single-point stroke is a dot of half the pen width', whole.dots.join());
  ok(['Planning', 'Ship the board export before Friday', 'Call the printer', 'Bold, italic and underlined', 'Filled note, right aligned', 'Mind map', 'Branch B', 'elbow', 'Highlight these words', 'quarterly-budget', 'XLSX', '3.2 MB', 'example.com', 'A plain link'].every(s => whole.words.includes(s)), 'the words are there', whole.words);
  ok(!whole.words.includes('Folded away') && whole.words.includes('| 1 |'), 'a collapsed mind-map node folds its child away and shows how many', whole.words);
  ok(/Figtree/.test(whole.family) && whole.styles === 1 && whole.hasFace, 'the font name goes on the root, and opts.css becomes a <style>');
  ok(whole.bytes < 200000, `and the whole thing is ${(whole.bytes / 1024).toFixed(0)} KB`, String(whole.bytes));
  writeFileSync(join(OUT, 'svg-light.svg'), whole.out);

  // the options, and what the export leaves alone
  const small = await page.evaluate(() => {
    const { svg, theme, T } = window.__x;
    const sticky = { id: 'a', type: 'sticky', x: 10, y: 20, w: 100, h: 100, color: 'blue', text: 'Hi' };
    const parse = s => new DOMParser().parseFromString(s, 'image/svg+xml');
    const none = parse(svg.toSVG([sticky], { theme, background: false, padding: 0 })), withBg = parse(svg.toSVG([sticky], { theme, padding: 10 }));
    const before = T.fontOf(10, false, false);
    svg.toSVG([sticky], { theme: { ...theme, family: 'Georgia, serif' } });
    const hostile = parse(svg.toSVG([{ id: 'x', type: 'sticky', x: 0, y: 0, w: 200, h: 100, color: 'blue', text: '<b>&"x"</b> \u0001\u0000 ok', text_style: { color: '"/><script>' } }, { id: 'y', type: 'mystery', x: 0, y: 0, w: 1, h: 1 }], { theme }));
    return { noneRects: none.querySelectorAll('rect').length, noneVb: none.documentElement.getAttribute('viewBox'), bgVb: withBg.documentElement.getAttribute('viewBox'), bgFill: withBg.querySelector('rect').getAttribute('fill') === theme.bg,
      keptFont: T.fontOf(10, false, false) === before, emptyOk: !parse(svg.toSVG([], { theme })).querySelector('parsererror'), nothing: svg.boundsOf([]),
      hostileOk: !hostile.querySelector('parsererror') && !hostile.querySelector('script'), hostileText: hostile.querySelector('text') && hostile.querySelector('text').textContent };
  });
  ok(small.noneRects === 2 && small.noneVb === '10 20 101 104', 'background: false leaves the backdrop out; padding 0 hugs the objects (shadow included)', JSON.stringify(small));
  ok(small.bgVb === '0 10 121 124' && small.bgFill, 'padding 10 and the backdrop in the theme colour', JSON.stringify(small));
  ok(small.keptFont, 'a different font for the export does not leave the editor measuring with it');
  ok(small.emptyOk && small.nothing.w === 0, 'an empty board is a valid, empty picture');
  ok(small.hostileOk && small.hostileText.includes('<b>&"x"</b>') && small.hostileText.endsWith('ok') && !/[\u0000-\u0008]/.test(small.hostileText), 'markup in text and colours is escaped, control characters dropped, unknown types skipped', small.hostileText);

  // ---- 2. the same pixels as a canvas ------------------------------------------------------------------------------------
  // For each case: draw it the way render.js does on a canvas, draw the SVG as an image, and count the pixels that differ.
  const tests = await page.evaluate(async ({ fontCss }) => {
    const { svg, theme, T, G, C, P } = window.__x;
    const parse = s => new DOMParser().parseFromString(s, 'image/svg+xml').documentElement;
    const toCanvas = async s => {
      const img = new Image(); img.src = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' })); await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); return c;
    };
    const px = c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const BG = (() => { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.fillStyle = theme.bg; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data]; })();
    const compare = (a, b) => {
      const A = px(a), B = px(b); let bad = 0, ink = 0;
      for (let i = 0; i < A.length; i += 4) {
        const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
        const a1 = Math.max(Math.abs(A[i] - BG[0]), Math.abs(A[i + 1] - BG[1]), Math.abs(A[i + 2] - BG[2])), b1 = Math.max(Math.abs(B[i] - BG[0]), Math.abs(B[i + 1] - BG[1]), Math.abs(B[i + 2] - BG[2]));
        if (a1 > 24 || b1 > 24) ink++;
        if (d > 64) bad++;
      }
      return { bad, ink, ratio: bad / Math.max(ink, 1) };
    };
    // a canvas the size of the SVG's viewBox, so both look at the same world rectangle; `shift` moves the canvas drawing, for the control
    let shift = 0;
    const oracle = (s, draw) => { const r = parse(s), vb = r.getAttribute('viewBox').split(' ').map(Number), c = document.createElement('canvas'); c.width = vb[2]; c.height = vb[3]; const g = c.getContext('2d'); g.fillStyle = theme.bg; g.fillRect(0, 0, c.width, c.height); g.translate(-vb[0] + shift, -vb[1]); draw(g); return c; };
    const dashes = (kind, w, dotted) => kind === 'dashed' ? [w * 4, w * 3] : kind === 'dotted' ? dotted : [];
    const opts = { theme, css: fontCss, padding: 14 };
    const cases = [];   // [group, name, svg, canvas drawing]

    // shapes: render.js shape() without the words
    for (const kind of ['rect', 'round', 'ellipse', 'diamond', 'triangle', 'hexagon', 'cylinder', 'arrow']) {
      for (const [w, h, dash, sw] of [[160, 110, undefined, 2], [60, 140, 'dashed', 3], [120, 50, 'dotted', 2]]) {
        const o = { id: 's', type: 'shape', shape: kind, x: 5, y: 7, w, h, fill: '#A6CCF5', stroke: '#F24726', stroke_width: sw, dash };
        cases.push(['shape', `${kind} ${w}x${h} ${dash || 'solid'}`, svg.toSVG([o], opts), g => {
          g.beginPath(); G.trace(g, o.shape, o.x, o.y, o.w, o.h); g.fillStyle = o.fill; g.fill();
          g.lineWidth = sw; g.strokeStyle = o.stroke; g.lineJoin = 'round'; g.setLineDash(dashes(dash, sw, [sw, sw * 2.2])); g.stroke();
          if (kind === 'cylinder') { g.beginPath(); G.lid(g, o.x, o.y, o.w, o.h); g.stroke(); }
        }]);
      }
    }

    // connectors: render.js connector() without the label
    const HEADS = [['none', 'none'], ['arrow', 'triangle'], ['diamond', 'circle'], ['bar', 'arrow'], ['circle', 'diamond'], ['triangle', 'bar']];
    let n = 0;
    for (const shape of ['straight', 'elbow', 'curved']) {
      for (const [a, b] of HEADS) {
        for (const dash of ['solid', 'dashed', 'dotted']) {
          if (n++ % 2 && dash !== 'solid') continue;   // enough variety without 54 images
          const w = 2 + n % 3;
          const o = { id: 'c', type: 'connector', shape, from: { x: 20, y: 30 }, to: { x: 210, y: 120 + (n % 4) * 20 }, start_head: a, end_head: b, width: w, dash, color: '#2D9BF0' };
          cases.push(['connector', `${shape} ${a}->${b} ${dash} w${w}`, svg.toSVG([o], opts), g => {
            const r = C.route(o, () => null);
            g.strokeStyle = g.fillStyle = o.color; g.lineWidth = w; g.lineCap = 'round'; g.lineJoin = 'round';
            g.setLineDash(dashes(dash, w, [w * 0.1, w * 2.4]));
            g.stroke(C.strokePath(o, r, w, a, b)); g.setLineDash([]);
            C.head(g, b, r.pts[r.pts.length - 1].x, r.pts[r.pts.length - 1].y, r.tip.x, r.tip.y, w);
            C.head(g, a, r.pts[0].x, r.pts[0].y, r.tail.x, r.tail.y, w);
          }]);
        }
      }
    }
    // glued ends, so the elbow takes its rounded corners and its stubs from the shapes
    for (const [sa, sb] of [['r', 'l'], ['b', 'b'], ['r', 't'], ['t', 'r']]) {
      const A = { id: 'a', type: 'shape', shape: 'rect', x: 0, y: 0, w: 90, h: 60, stroke: '#1a1a1a' }, B = { id: 'b', type: 'shape', shape: 'round', x: 170, y: 120, w: 90, h: 60, stroke: '#1a1a1a' };
      const o = { id: 'c', type: 'connector', shape: 'elbow', from: { id: 'a', side: sa }, to: { id: 'b', side: sb }, end_head: 'triangle', width: 2, color: '#F24726' };
      cases.push(['connector', `elbow glued ${sa}->${sb}`, svg.toSVG([A, B, o], opts), g => {
        for (const q of [A, B]) { g.beginPath(); G.trace(g, q.shape, q.x, q.y, q.w, q.h); g.lineWidth = 2; g.strokeStyle = q.stroke; g.lineJoin = 'round'; g.stroke(); }
        const r = C.route(o, id => ({ a: A, b: B })[id]);
        g.strokeStyle = g.fillStyle = o.color; g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round';
        g.stroke(C.strokePath(o, r, 2, 'none', 'triangle'));
        C.head(g, 'triangle', r.pts[r.pts.length - 1].x, r.pts[r.pts.length - 1].y, r.tip.x, r.tip.y, 2);
      }]);
    }

    // freehand: render.js stroke() and pressureStroke()
    const pen = { id: 'p', type: 'draw', tool: 'pen', color: '#1a1a1a', width: 6, x: 10, y: 10, w: 200, h: 60, points: [0, 0, 0.5, 30, 40, 0.5, 60, 5, 0.5, 90, 50, 0.5, 130, 20, 0.5, 190, 45, 0.5] };
    const strokes = [['pen', pen], ['highlighter', { ...pen, id: 'h', tool: 'highlighter', color: '#F5D128', width: 24 }],
      ['pressure', { ...pen, id: 'q', width: 10, points: pen.points.map((v, i) => i % 3 === 2 ? [0.1, 0.4, 0.8, 1, 0.6, 0.2][(i - 2) / 3] : v) }]];
    for (const [name, o] of strokes) {
      cases.push(['freehand', name, svg.toSVG([o], opts), g => {
        const pts = o.points, p = new Path2D(), cnt = pts.length / 3;
        p.moveTo(o.x + pts[0], o.y + pts[1]);
        for (let i = 1; i < cnt - 1; i++) p.quadraticCurveTo(o.x + pts[i * 3], o.y + pts[i * 3 + 1], o.x + (pts[i * 3] + pts[(i + 1) * 3]) / 2, o.y + (pts[i * 3 + 1] + pts[(i + 1) * 3 + 1]) / 2);
        p.lineTo(o.x + pts[(cnt - 1) * 3], o.y + pts[(cnt - 1) * 3 + 1]);
        g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = o.color;
        if (o.tool === 'highlighter') { g.globalAlpha = 0.4; g.lineCap = 'butt'; }
        if (name === 'pressure') {
          for (let i = 1; i < cnt; i++) { g.lineWidth = Math.max(0.6, o.width * (0.25 + (pts[i * 3 + 2] + pts[(i - 1) * 3 + 2]) / 2 * 1.1)); g.beginPath(); g.moveTo(o.x + pts[(i - 1) * 3], o.y + pts[(i - 1) * 3 + 1]); g.lineTo(o.x + pts[i * 3], o.y + pts[i * 3 + 1]); g.stroke(); }
        } else { g.lineWidth = o.width; g.stroke(p); }
      }]);
    }

    // words: text.draw() on a canvas
    const words = [
      ['sticky, auto size', { id: 'a', type: 'sticky', x: 5, y: 5, w: 190, h: 190, color: 'yellow', text: 'Ship the board export before Friday' }],
      ['sticky, left bold 18', { id: 'a', type: 'sticky', x: 5, y: 5, w: 150, h: 150, color: 'light_pink', text: 'Call the printer today', text_style: { bold: true, align: 'left', size: 18 } }],
      ['text, centre italic underline', { id: 'a', type: 'text', x: 5, y: 5, w: 250, h: 70, text: 'Bold, italic\nand underlined', text_style: { bold: true, italic: true, underline: true, align: 'center', size: 22 } }],
      ['text, right on a fill', { id: 'a', type: 'text', x: 5, y: 5, w: 250, h: 50, fill: '#CA91D8', text: 'Filled note, right aligned', text_style: { align: 'right', size: 16, underline: true } }],
      ['ellipse shape text', { id: 'a', type: 'shape', shape: 'ellipse', x: 5, y: 5, w: 200, h: 120, fill: '#FFF9B1', text: 'Words inside an ellipse that need to wrap' }],
      ['cylinder shape text', { id: 'a', type: 'shape', shape: 'cylinder', x: 5, y: 5, w: 120, h: 140, fill: '#D5F692', text: 'Database' }],
    ];
    for (const [name, o] of words) {
      cases.push(['words', name, svg.toSVG([o], opts), g => {
        if (o.type === 'sticky') { const f = P.stickyHex(o.color), ink = P.inkOn(f); g.globalAlpha = 0.14; g.fillStyle = theme.ink; g.fillRect(o.x + 1, o.y + 4, o.w, o.h); g.globalAlpha = 1; g.fillStyle = f; g.fillRect(o.x, o.y, o.w, o.h); g.fillStyle = ink; T.draw(g, o, null, ink, 1); }
        else if (o.type === 'text') { if (o.fill) { g.fillStyle = o.fill; g.beginPath(); g.roundRect(o.x, o.y, o.w, o.h, 4); g.fill(); } const col = o.fill ? P.inkOn(o.fill) : theme.fg; g.fillStyle = col; T.draw(g, o, null, col, 1); }
        else { g.beginPath(); G.trace(g, o.shape, o.x, o.y, o.w, o.h); g.fillStyle = o.fill; g.fill(); g.lineWidth = 2; g.strokeStyle = theme.fg; g.lineJoin = 'round'; g.stroke(); if (o.shape === 'cylinder') { g.beginPath(); G.lid(g, o.x, o.y, o.w, o.h); g.stroke(); } const col = P.inkOn(o.fill); g.fillStyle = col; T.draw(g, o, G.textArea(o.shape, o), col, 1); }
      }]);
    }

    const results = [];
    for (const [group, what, s, draw] of cases) results.push({ group, what, ...compare(oracle(s, draw), await toCanvas(s)) });
    // the control: the same comparison with the canvas drawing one pixel to the right must fail, or the comparison proves nothing
    shift = 1;
    const control = [];
    for (const [group, what, s, draw] of cases.filter(c => ['rect 160x110 solid', 'straight arrow->triangle solid w3', 'pen', 'sticky, auto size'].some(w => c[1].startsWith(w)))) control.push({ group, what, ...compare(oracle(s, draw), await toCanvas(s)) });
    return { results, control };
  }, { fontCss });

  const LIMIT = { shape: 0.005, connector: 0.02, freehand: 0.02, words: 0.03 };   // of the inked pixels; the control below is what these have to stay under
  for (const [group, limit] of Object.entries(LIMIT)) {
    const rs = tests.results.filter(t => t.group === group), worst = rs.reduce((a, c) => (c.ratio > a.ratio ? c : a)), least = Math.min(...rs.map(r => r.ink));
    ok(rs.every(r => r.ratio <= limit && r.ink > 100), `${group}: ${rs.length} cases match the canvas (worst ${(worst.ratio * 100).toFixed(2)}% of the inked pixels: ${worst.what}; none has fewer than ${least} inked pixels)`,
      rs.filter(r => r.ratio > limit || r.ink <= 100).map(r => `${r.what} ${(r.ratio * 100).toFixed(1)}% of ${r.ink}`).join('; '));
  }
  ok(tests.control.length === 4 && tests.control.every(c => c.ratio > LIMIT[c.group]), `the comparison can tell: with the canvas drawing a pixel to the side, the same cases differ by ${tests.control.map(c => (c.ratio * 100).toFixed(1) + '%').join(', ')}`, JSON.stringify(tests.control));

  // ---- 3. the real editor -----------------------------------------------------------------------------------------------------
  // The same board opened in the editor, its canvas against the SVG of its objects. Two known differences: the canvas leaves its line-cap
  // setting on round after a connector, so dashed shape outlines there get round dashes (the SVG draws the butt-capped dashes dash arrays are
  // written for), and an opaque canvas antialiases glyph edges a little differently. Neither is more than a sliver of the picture.
  const api = async (path, init = {}) => { const r = await fetch(`${BASE}/api${path}`, { ...init, headers: { 'X-Makesense': '1', ...(init.headers || {}) } }); if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`); return r.json(); };
  const board = await api('/board', { method: 'POST', body: JSON.stringify({ title: 'SVG check' }) });
  const srcOf = {};
  for (const [name, url] of Object.entries(pngs)) srcOf[name] = (await api(`/board/${board.id}/assets?name=${name}&mime=image/png`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from(url.split(',')[1], 'base64') })).src;
  await api(`/board/${board.id}`, { method: 'PUT', body: JSON.stringify({ upsert: FIXTURE.map(o => { const c = { ...o }; for (const k of ['src', 'thumb', 'favicon']) if (srcOf[c[k]]) c[k] = srcOf[c[k]]; return c; }) }) });
  await page.goto(`${BASE}/#/board/${board.id}`);
  await page.waitForFunction(() => window.__board && window.__board.doc && window.__board.doc.size > 0, null, { timeout: 15000 });
  const real = await page.evaluate(async ({ fontCss }) => {
    const ed = window.__board, { svg, theme } = window.__x;
    await document.fonts.ready;
    ed.r.refreshTheme(); for (const o of ed.doc.list()) if (o._) o._ = {};
    ed.r.grid = () => {};   // the dot grid is the editor's own, not part of an export
    const objs = ed.doc.list(), assets = new Map();
    for (const o of objs) for (const k of ['src', 'thumb', 'favicon']) {
      if (!o[k] || assets.has(o[k])) continue;
      const blob = await (await fetch(ed.assetUrl(o[k]))).blob();
      assets.set(o[k], await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); }));
    }
    const s = svg.toSVG(objs, { assets, theme, css: fontCss }), vb = s.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number), w = vb[2], h = vb[3];
    ed.cam.x = vb[0]; ed.cam.y = vb[1]; ed.cam.z = 1;
    for (let i = 0; i < 100 && !objs.every(o => [o.src, o.thumb, o.favicon].filter(Boolean).every(u => ed.r.image(u))); i++) await new Promise(r => setTimeout(r, 50));
    ed.r.need = true; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const img = new Image(); img.src = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' })); await img.decode();
    const a = document.createElement('canvas'), c = document.createElement('canvas'), d = document.createElement('canvas');
    a.width = c.width = d.width = w; a.height = c.height = d.height = h;
    a.getContext('2d').drawImage(ed.cv, 0, 0, w * ed.r.dpr, h * ed.r.dpr, 0, 0, w, h); c.getContext('2d').drawImage(img, 0, 0);
    const A = a.getContext('2d').getImageData(0, 0, w, h).data, B = c.getContext('2d').getImageData(0, 0, w, h).data, dg = d.getContext('2d'), D = dg.createImageData(w, h);
    let bad = 0, ink = 0;
    for (let i = 0; i < A.length; i += 4) {
      const diff = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
      const inked = Math.max(Math.abs(A[i] - A[0]), Math.abs(A[i + 1] - A[1]), Math.abs(A[i + 2] - A[2])) > 24 || Math.max(Math.abs(B[i] - A[0]), Math.abs(B[i + 1] - A[1]), Math.abs(B[i + 2] - A[2])) > 24;
      if (inked) ink++;
      if (diff > 64) { bad++; D.data.set([255, 0, 0, 255], i); } else D.data.set(inked ? [200, 200, 200, 255] : [245, 245, 245, 255], i);
    }
    dg.putImageData(D, 0, 0);
    return { w, h, bad, ink, n: objs.length, canvas: a.toDataURL(), svg: c.toDataURL(), diff: d.toDataURL() };
  }, { fontCss });
  for (const k of ['canvas', 'svg', 'diff']) writeFileSync(join(OUT, `editor-${k}.png`), Buffer.from(real[k].split(',')[1], 'base64'));
  ok(real.n === FIXTURE.length && real.ink > 100000 && real.bad / real.ink < 0.01, `the real editor and the SVG agree on ${(100 - 100 * real.bad / real.ink).toFixed(2)}% of the ${real.ink} inked pixels of the same ${real.w}x${real.h} view`, `${real.bad} differ`);
  await context.close();

  // ---- 4. look at it ---------------------------------------------------------------------------------------------------------
  for (const scheme of ['light', 'dark']) {
    const { context: ctx, page: pg } = await open(scheme);
    const bg = await pg.evaluate(async ({ objects, fontCss }) => {
      const { svg, theme, assets } = window.__x;
      const s = svg.toSVG(JSON.parse(JSON.stringify(objects)), { assets, theme, css: fontCss });
      const host = document.createElement('div');
      host.id = 'svg-check'; host.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#888';
      const img = new Image(); img.style.cssText = 'display:block'; img.src = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' }));
      host.append(img); document.body.append(host); await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0); const got = [...g.getImageData(2, 2, 1, 1).data];
      g.fillStyle = theme.bg; g.fillRect(0, 0, 1, 1); return { got, want: [...g.getImageData(0, 0, 1, 1).data] };
    }, { objects: FIXTURE, fontCss });
    await pg.screenshot({ path: join(OUT, `svg-${scheme}.png`) });
    ok(bg.got.join() === bg.want.join(), `${scheme} theme: the backdrop is the board's own background colour`, JSON.stringify(bg));
    await ctx.close();
  }
  console.log(`  screenshots in ${OUT}`);
  ok(errors.length === 0, 'no errors in the page', errors.join(' | '));
} catch (e) {
  failed++;
  console.log('  FAIL ' + (e && e.stack || e));
} finally {
  if (browser) await browser.close();
  server.kill();
  rmSync(home, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
