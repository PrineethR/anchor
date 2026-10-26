// Pre-render the few design-system shapes that the Python side puts into server-built HTML
// (thread markers, the shared file's sign-off), using ds.js itself so they are the real shapes.
//
//     node sense/static/prerender.mjs        # writes prerendered.json
import { writeFileSync } from 'node:fs';
import * as ds from './ds.js';

// One shape and colour per thread. Sun is left out: it means "you underlined this".
const THREADS = [['circle', 'sky'], ['flower', 'blush'], ['arch', 'mint'], ['scallop', 'violet'], ['star', 'tangerine'], ['blob', 'berry']];

const out = {
    thread_shapes: THREADS.map(([shape, color]) => ({ shape, color, svg: ds.shape({ shape, color, size: 24 }) })),
    sign_off: ds.mood({ mood: 'calm', size: 44 }),
};
writeFileSync(new URL('./prerendered.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('wrote prerendered.json:', out.thread_shapes.length, 'thread shapes');
