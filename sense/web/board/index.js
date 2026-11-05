// The Board section: the boards list and the editor. ui.html calls show() and nothing else.
//     const view = show(host, ctx, boardId);  await view.destroy();

import { Editor } from './editor.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { TextEdit } from './textedit.js';
import { Drawing } from './draw.js';
import { MindMaps } from './mindmap.js';
import { Sync } from './sync.js';
import { Minimap } from './minimap.js';
import { UI } from './ui.js';
import * as files from './files.js';
import * as T from './text.js';
import { mountBoards } from './list.js';

/** Lazy panels: they load the first time they are opened, so opening a board stays quick. */
function lazy(ed, file, fn) {
  let mod;
  return { open: async (anchor, ...a) => { mod = mod || await import(file); return mod[fn](ed, anchor, ...a); }, mod: () => mod };
}

function css() {
  if (!document.querySelector('link[href="web/board/board.css"]')) document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="web/board/board.css">');
}

export function show(host, ctx, id) {
  css();
  if (!id) return mountBoards(host, ctx);
  let ed = null, dead = false;
  const ready = (async () => {
    const data = await ctx.api('/board/' + id).catch(err => { ctx.oops(err); ctx.go('#/board'); return null; });
    if (!data || dead) return;
    ed = start(host, data, ctx);
  })();
  return { async destroy() { dead = true; await ready; if (ed) ed.destroy(); host.innerHTML = ''; } };
}

function start(host, data, ctx) {
  host.innerHTML = '<div class="bd" tabindex="0" aria-label="Board"><canvas class="bd-cv"></canvas></div>';
  const root = host.querySelector('.bd'), cv = host.querySelector('canvas');
  const ed = new Editor(root, data, ctx);
  ed.host = host; ed.cv = cv;
  ed.r = new Renderer(cv, ed);
  ed.r.refreshTheme();
  ed.te = new TextEdit(ed, root);
  ed.drawing = new Drawing(ed);
  ed.mm = new MindMaps(ed);
  ed.input = new Input(ed, root, cv);
  ed.mini = new Minimap(ed, root);
  ed.mini.show(ed.pref.minimap !== false);
  ed.openFile = o => files.openFile(ed, o);
  ed.templates = lazy(ed, './templates-ui.js', 'open');
  ed.exporter = {
    open: async (a) => { const m = await import('./export-ui.js'); return m.open(ed, a); },
    png: async spec => { const m = await import('./export-ui.js'); return m.png(ed, spec); },
  };
  ed.sync = new Sync(ed, { onStatus: (k, m) => ed.ui.status(k, m) });
  ed.ui = new UI(ed, root, ctx);
  ed.mm.refresh();

  // size, theme, fonts
  const size = () => {
    const r = root.getBoundingClientRect();
    ed.cam.resize(r.width, r.height); ed.r.resize(r.width, r.height);
    if (ed.te.open_) ed.te.place();
  };
  const ro = new ResizeObserver(size);
  ro.observe(root);
  size();
  if (!data.objects.length && data.view.x === 0 && data.view.y === 0 && data.view.z === 1) { ed.cam.x = -ed.cam.w / 2; ed.cam.y = -ed.cam.h / 2; }
  const dark = matchMedia('(prefers-color-scheme: dark)'), onTheme = () => { ed.r.refreshTheme(); ed.mini.key = ''; };
  dark.addEventListener('change', onTheme);
  const mo = new MutationObserver(onTheme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  document.fonts.load(`600 16px ${ed.r.theme.family}`).then(() => document.fonts.ready).then(() => { ed.r.refreshTheme(); for (const o of ed.doc.list()) if (o._) o._ = {}; ed.invalidate(); });

  // wiring
  ed.input.attach();
  ed.sync.start();
  const unfiles = files.attach(ed, root);
  ed.on(w => { if (w === 'doc' || w === 'selection') ed.mini.key = ''; });
  ed.on(w => { if (w && w.type === 'remotePatch' && ed.mm) ed.mm.refresh(); });

  // the frame loop
  let raf = 0;
  const loop = now => {
    if (ed.destroyed) return;
    ed.r.frame(now);
    ed.ui.tick();
    ed.mini.draw();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  root.focus({ preventScroll: true });
  window.__board = ed;   // for tests and for poking at from the console

  ed.destroy = async () => {
    ed.destroyed = true;
    cancelAnimationFrame(raf);
    ro.disconnect(); mo.disconnect(); dark.removeEventListener('change', onTheme);
    ed.input.detach(); unfiles();
    if (ed.te.open_) ed.te.close();
    await ed.sync.flush(true);
    ed.sync.stop();
    if (window.__board === ed) delete window.__board;
  };
  return ed;
}
