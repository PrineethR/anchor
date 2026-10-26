// Get a phone photo ready to wait in Firestore: upright, no bigger than the reading engine looks at, and under a document's 1 MiB.

const LIMIT = 900 * 1024;   // a Firestore document holds 1 MiB in all; the rest of the document needs the remainder
const FULL_SIDE = 2400;     // the engine's working size (sense/engine.py MAX_SIDE): more pixels than this are never used
const THUMB_SIDE = 220;

async function bitmap(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }   // turns a sideways phone photo upright
  catch {
    return await new Promise((ok, no) => {
      const url = URL.createObjectURL(blob), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); ok(img); };
      img.onerror = () => { URL.revokeObjectURL(url); no(new Error("That file isn't a photo this browser can open. Try a JPEG or PNG.")); };
      img.src = url;
    });
  }
}

function draw(src, side) {
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  const k = Math.min(1, side / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);   // a PNG's see-through corners would turn black in a JPEG
  g.drawImage(src, 0, 0, w, h);
  return c;
}

const jpeg = (canvas, q) => new Promise((ok, no) => canvas.toBlob(b => (b ? ok(b) : no(new Error('This browser could not shrink the photo.'))), 'image/jpeg', q));
const bytes = async b => new Uint8Array(await b.arrayBuffer());

/** { full, thumb, w, h }: JPEG bytes under the limit, and a small one for lists. `side` caps the long edge. */
export async function preparePhoto(blob, { side = FULL_SIDE } = {}) {
  const src = await bitmap(blob);
  let s = side, out = null, c = null;
  for (let round = 0; round < 6 && !out; round++) {
    c = draw(src, s);
    for (const q of [0.82, 0.72, 0.62, 0.5]) {
      const b = await jpeg(c, q);
      if (b.size <= LIMIT) { out = b; break; }
    }
    if (!out) s = Math.round(s * 0.82);   // still too big at the lowest quality: fewer pixels
  }
  if (!out) throw new Error('That photo is too detailed to store. Try one with less in the frame.');
  const t = await jpeg(draw(src, THUMB_SIDE), 0.7);
  src.close?.();
  return { full: await bytes(out), thumb: await bytes(t), w: c.width, h: c.height };
}
