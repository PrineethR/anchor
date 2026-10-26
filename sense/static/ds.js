// ════════════════════════════════════════════════════════════════════
//  The Noteworthy design system, in plain JS.
//
//  A port of the React primitives in the Claude Design project
//  "Noteworthy" (components/shapes, core/Icon, core/Button's burst). Every
//  function returns markup as a string, so the app can drop it into
//  innerHTML the way it builds everything else. Styles and keyframes live
//  in style.css under ILLUSTRATION & MOTION.
// ════════════════════════════════════════════════════════════════════

export const SPECTRUM = ['blush', 'berry', 'violet', 'sky', 'cobalt', 'mint', 'forest', 'tomato', 'tangerine', 'sun'];
const DARK_FILLS = ['cobalt', 'forest'];

let seq = 0;
const uid = () => 'nw' + (++seq).toString(36);

/** Spectrum name → CSS colour. 'ink' and 'paper' follow the theme; anything else passes through. */
export function resolveColor(c) {
    if (!c || c === 'ink') return 'var(--fg-1)';
    if (c === 'paper') return 'var(--bg-surface)';
    if (SPECTRUM.includes(c)) return `var(--${c})`;
    return c;
}

/** Text/glyph colour that holds contrast on a given fill. */
export function onColor(c) {
    if (!c || c === 'ink') return 'var(--fg-inverse)';
    if (c === 'paper') return 'var(--fg-1)';
    return DARK_FILLS.includes(c) ? 'var(--paper-1)' : 'var(--ink-900)';
}

const f = (n) => +n.toFixed(2);
function roundPoly(pts, r) {
    let d = '';
    const n = pts.length;
    for (let i = 0; i < n; i++) {
        const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
        const v1 = [p0[0] - p1[0], p0[1] - p1[1]], v2 = [p2[0] - p1[0], p2[1] - p1[1]];
        const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1]);
        const a = [p1[0] + v1[0] / l1 * r, p1[1] + v1[1] / l1 * r];
        const b = [p1[0] + v2[0] / l2 * r, p1[1] + v2[1] / l2 * r];
        d += (i ? 'L' : 'M') + f(a[0]) + ' ' + f(a[1]) + 'Q' + p1[0] + ' ' + p1[1] + ' ' + f(b[0]) + ' ' + f(b[1]);
    }
    return d + 'Z';
}
function starPath(points, ro, ri) {
    const pts = [];
    for (let i = 0; i < points * 2; i++) {
        const a = (Math.PI * i) / points - Math.PI / 2, r = i % 2 ? ri : ro;
        pts.push([f(50 + Math.cos(a) * r), f(50 + Math.sin(a) * r)]);
    }
    return roundPoly(pts, 4);
}

/** 100×100 geometry. [path, faceX, faceY, faceScale] */
export const SHAPES = {
    circle: ['M50 2A48 48 0 1 1 49.99 2Z', 50, 50, 1],
    flower: ['M50 10.48A28 28 0 1 1 89.52 50A28 28 0 1 1 50 89.52A28 28 0 1 1 10.48 50A28 28 0 1 1 50 10.48Z', 50, 50, 1],
    stack: ['M22 6H78A15 15 0 0 1 81.84 35.5A15 15 0 0 1 81.84 64.5A15 15 0 0 1 78 94H22A15 15 0 0 1 18.16 64.5A15 15 0 0 1 18.16 35.5A15 15 0 0 1 22 6Z', 50, 50, 1],
    scallop: ['M6 32A14.67 14.67 0 0 1 35.33 32A14.67 14.67 0 0 1 64.67 32A14.67 14.67 0 0 1 94 32V72A22 22 0 0 1 72 94H28A22 22 0 0 1 6 72Z', 50, 58, 1],
    arch: ['M6 50A44 44 0 0 1 94 50V80A14 14 0 0 1 80 94H20A14 14 0 0 1 6 80Z', 50, 58, 1],
    hexagon: [roundPoly([[27, 8], [73, 8], [96, 50], [73, 92], [27, 92], [4, 50]], 9), 50, 50, 1],
    triangle: [roundPoly([[50, 6], [96, 90], [4, 90]], 11), 50, 64, 0.78],
    square: [roundPoly([[6, 6], [94, 6], [94, 94], [6, 94]], 16), 50, 50, 1],
    quarter: ['M8 94V20A12 12 0 0 1 20 8A86 86 0 0 1 94 82A12 12 0 0 1 82 94Z', 42, 58, 0.9],
    blob: ['M52 5C78 4 96 22 93 48C90 76 72 96 46 94C20 92 4 74 7 48C10 22 28 6 52 5Z', 50, 50, 1],
    star: [starPath(8, 48, 38), 50, 50, 0.9],
    diamond: [roundPoly([[50, 3], [97, 50], [50, 97], [3, 50]], 12), 50, 50, 0.85],
    pill: ['M32 20H68A30 30 0 0 1 68 80H32A30 30 0 0 1 32 20Z', 50, 50, 0.9],
};

const aria = (title) => title ? `role="img" aria-label="${title}"` : 'aria-hidden="true"';

/**
 * A brand shape. Finishes: fill · line · dashed · hatch · dots · clay (3D).
 * `inner` is extra SVG (faces, glyphs) in the same 100×100 space.
 */
export function shape({ shape = 'circle', color = 'ink', finish = 'fill', size = 96, outline = false, rotate = 0, title = '', cls = '', style = '', inner = '', x, y } = {}) {
    const id = uid();
    const d = (SHAPES[shape] || SHAPES.circle)[0];
    const c = resolveColor(color);
    const ink = 'var(--line-strong)';
    const lw = size < 48 ? 1.5 : 2;
    const common = `d="${d}" vector-effect="non-scaling-stroke" stroke-linejoin="round"`;
    let body;
    if (finish === 'line' || finish === 'dashed') {
        body = `<path ${common} fill="${color === 'ink' ? 'none' : c}" stroke="${ink}" stroke-width="${lw}"${finish === 'dashed' ? ' stroke-dasharray="6 5"' : ''}/>`;
    } else if (finish === 'hatch' || finish === 'dots') {
        const tint = color === 'ink' ? 'var(--fg-3)' : c;
        const pat = finish === 'hatch'
            ? `<pattern id="p${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="${tint}" stroke-width="1.1"/></pattern>`
            : `<pattern id="p${id}" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="0.9" fill="${tint}"/></pattern>`;
        body = `<defs>${pat}</defs><path ${common} fill="url(#p${id})" stroke="${ink}" stroke-width="${lw}" stroke-dasharray="6 5"/>`;
    } else if (finish === 'clay') {
        body = `<defs>
            <radialGradient id="g${id}" cx="38%" cy="30%" r="95%">
                <stop offset="0" style="stop-color:color-mix(in oklch, ${c} 38%, var(--paper-0))"/>
                <stop offset="0.55" style="stop-color:color-mix(in oklch, ${c} 58%, var(--paper-1))"/>
                <stop offset="1" style="stop-color:color-mix(in oklch, ${c} 72%, var(--paper-3))"/>
            </radialGradient>
            <clipPath id="c${id}"><path d="${d}"/></clipPath>
            <filter id="b${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
            <filter id="s${id}" x="-40%" y="-40%" width="180%" height="190%"><feDropShadow dx="0" dy="7" stdDeviation="8" style="flood-color:color-mix(in oklch, ${c} 55%, #1D1C1A)" flood-opacity="0.16"/></filter>
        </defs>
        <g filter="url(#s${id})">
            <path d="${d}" fill="url(#g${id})"/>
            <g clip-path="url(#c${id})">
                <ellipse cx="38" cy="26" rx="34" ry="20" fill="white" opacity="0.28" filter="url(#b${id})"/>
                <path d="${d}" fill="none" stroke="black" stroke-opacity="0.04" stroke-width="10" transform="translate(0 5)" filter="url(#b${id})"/>
            </g>
        </g>`;
    } else {
        body = `<path ${common} fill="${c}" stroke="${outline ? ink : 'none'}" stroke-width="${outline ? lw : 0}"/>`;
    }
    const pos = x != null ? ` x="${x}" y="${y}"` : '';
    const st = `${rotate ? `transform:rotate(${rotate}deg);` : ''}${style}`;
    return `<svg viewBox="-4 -4 108 108" width="${size}" height="${size}"${pos} class="nw-shape ${cls}" ${aria(title)}${st ? ` style="${st}"` : ''}>${body}${inner}</svg>`;
}

// ── Moods: a shape with a face ────────────────────────────────────────
export const MOODS = {
    calm: { shape: 'circle', color: 'sky', eyes: 'closed', mouth: 'smile' },
    joyful: { shape: 'flower', color: 'sun', eyes: 'closed', mouth: 'grin' },
    grateful: { shape: 'stack', color: 'blush', eyes: 'closed', mouth: 'smile' },
    energized: { shape: 'scallop', color: 'tangerine', eyes: 'open', mouth: 'grin', look: [0, -1] },
    dreamy: { shape: 'arch', color: 'violet', eyes: 'closed', mouth: 'small' },
    curious: { shape: 'hexagon', color: 'cobalt', eyes: 'open', mouth: 'none', look: [1, 0] },
    bored: { shape: 'blob', color: 'mint', eyes: 'open', mouth: 'none', look: [0.6, -1] },
    stressed: { shape: 'triangle', color: 'tomato', eyes: 'squint', mouth: 'flat' },
    annoyed: { shape: 'square', color: 'berry', eyes: 'half', mouth: 'flat' },
    unsure: { shape: 'pill', color: 'tangerine', eyes: 'open', mouth: 'o', look: [-1, 0] },
    tired: { shape: 'diamond', color: 'violet', eyes: 'closed', mouth: 'flat' },
    shy: { shape: 'quarter', color: 'blush', eyes: 'open', mouth: 'small', look: [-1, 0.6] },
};

function moodEyes(type, look = [0, 0]) {
    const ink = 'var(--ink-900)';
    const lx = look[0] * 3.5, ly = look[1] * 3.5;
    const st = `fill="none" stroke="${ink}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"`;
    if (type === 'closed') return `<g ${st}><path d="M33 44q6.5 6.5 13 0"/><path d="M54 44q6.5 6.5 13 0"/></g>`;
    if (type === 'squint') return `<g ${st}><path d="M34 39l10 5-10 5"/><path d="M66 39l-10 5 10 5"/></g>`;
    if (type === 'half') return `<g><path d="M29 42h18a9 9 0 0 1-18 0z" fill="#fff"/><path d="M53 42h18a9 9 0 0 1-18 0z" fill="#fff"/><circle cx="${38 + lx}" cy="45" r="4.4" fill="${ink}"/><circle cx="${62 + lx}" cy="45" r="4.4" fill="${ink}"/></g>`;
    return `<g><circle cx="38" cy="45" r="9.5" fill="#fff"/><circle cx="62" cy="45" r="9.5" fill="#fff"/><circle cx="${38 + lx}" cy="${45 + ly}" r="5.2" fill="${ink}"/><circle cx="${62 + lx}" cy="${45 + ly}" r="5.2" fill="${ink}"/></g>`;
}
function moodMouth(type) {
    const st = 'fill="none" stroke="var(--ink-900)" stroke-width="3.4" stroke-linecap="round"';
    if (type === 'smile') return `<path d="M40 58q10 8 20 0" ${st}/>`;
    if (type === 'grin') return `<path d="M33 55q17 15 34 0" ${st}/>`;
    if (type === 'flat') return `<path d="M44 62h12" ${st}/>`;
    if (type === 'small') return `<path d="M46 60q4 3.5 8 0" ${st}/>`;
    if (type === 'o') return '<circle cx="50" cy="63" r="3.6" fill="var(--ink-900)"/>';
    return '';
}

/** The Noteworthy character. */
export function mood({ mood = 'calm', shape: s, color, eyes, mouth, look, finish = 'fill', size = 96, alive = false, cls = '', title = '', x, y } = {}) {
    const p = MOODS[mood] || MOODS.calm;
    const sh = s || p.shape;
    const [, cx, cy, k] = SHAPES[sh] || SHAPES.circle;
    const inner = `<g transform="translate(${cx} ${cy}) scale(${k}) translate(-50 -50)"><g class="nw-mood__eyes">${moodEyes(eyes || p.eyes, look || p.look)}</g>${moodMouth(mouth || p.mouth)}</g>`;
    return shape({ shape: sh, color: color || p.color, finish, size, title, x, y, cls: `nw-mood${alive ? ' nw-mood--alive' : ''} ${cls}`, style: 'transform-origin:50% 90%;', inner });
}

// ── Icons: Lucide (ISC), 24px grid ────────────────────────────────────
const ICONS = {
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'pen-line': '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
    'book-open': '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
    lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
    calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    'message-circle': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    feather: '<path d="M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/>',
    notebook: '<path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M16 2v20"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    compass: '<path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/><circle cx="12" cy="12" r="10"/>',
    sprout: '<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    waypoints: '<circle cx="12" cy="4.5" r="2.5"/><path d="m10.2 6.3-3.9 3.9"/><circle cx="4.5" cy="12" r="2.5"/><path d="M7 12h10"/><circle cx="19.5" cy="12" r="2.5"/><path d="m13.8 17.7 3.9-3.9"/><circle cx="12" cy="19.5" r="2.5"/>',
    // Not Lucide: the half sun Days has always worn in the menu
    sunrise: '<path d="M3 18h18"/><path d="M7 18a5 5 0 0 1 10 0"/><path d="M12 6v3"/><path d="M5.6 10.6l1.8 1.4"/><path d="M18.4 10.6l-1.8 1.4"/>',
    // Not Lucide: the mic the Android app's Speak a note shortcut wears
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/>',
};

export function icon(name, { size = 20, sw = 1.75, color = 'currentColor', cls = '' } = {}) {
    const body = ICONS[name];
    if (!body) return '';
    return `<svg class="nw-icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Soft 3D icon: a clay shape with an embossed glyph. */
export function clayIcon({ icon: name = 'sparkles', color = 'sun', shape: sh = 'square', size = 72, glyph = 'auto', tilt = false, cls = '', title = '' } = {}) {
    const g = glyph === 'auto' ? (SPECTRUM.includes(color) ? `var(--${color}-ink-fixed, var(--${color}-ink))` : 'var(--ink-700)')
        : glyph === 'white' ? '#FFFFFF' : glyph === 'ink' ? 'var(--ink-900)' : glyph;
    return `<span class="nw-clay${tilt ? ' nw-clay--tilt' : ''} ${cls}" style="width:${size}px;height:${size}px" ${aria(title)}>${shape({ shape: sh, color, finish: 'clay', size })}<span class="nw-clay__glyph" style="transform:translateY(${-size * 0.02}px)">${icon(name, { size: Math.round(size * 0.42), sw: 2, color: g })}</span></span>`;
}

// ── Doodle marks ──────────────────────────────────────────────────────
function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const GLYPHS = {
    cross: (s) => `<path d="M${-s} 0h${s * 2}M0 ${-s}v${s * 2}"/>`,
    dot: (s) => `<circle r="${s * 0.45}" fill="currentColor" stroke="none"/>`,
    dash: (s) => `<path d="M${-s} 0h${s * 2}"/>`,
    ring: (s) => `<circle r="${s * 0.8}" fill="none"/>`,
    tri: (s) => `<path d="M0 ${-s}L${s} ${s * 0.8}H${-s}Z" fill="none"/>`,
    squiggle: (s) => `<path d="M${-s * 1.6} 0q${s * 0.4} ${-s} ${s * 0.8} 0t${s * 0.8} 0t${s * 0.8} 0t${s * 0.8} 0" fill="none"/>`,
};

/** Doodle confetti around a subject. Deterministic per seed. Returns an absolutely placed layer. */
export function scatter({ count = 22, seed = 7, color = 'ink', glyphs = Object.keys(GLYPHS), clear = 0.32, glyphSize = 6, cls = '' } = {}) {
    const r = rng(seed), out = [];
    let guard = 0;
    while (out.length < count && guard++ < count * 20) {
        const x = r() * 100, y = r() * 100;
        if (Math.hypot((x - 50) / 50, (y - 50) / 50) < clear * 1.4) continue;
        out.push({ x, y, g: glyphs[Math.floor(r() * glyphs.length)], rot: Math.floor(r() * 180), k: 0.7 + r() * 0.8, c: SPECTRUM[Math.floor(r() * SPECTRUM.length)], t: 5 + r() * 5 });
    }
    return `<svg class="nw-scatter ${cls}" width="100%" height="100%" aria-hidden="true">${out.map((it) =>
        `<svg x="${f(it.x)}%" y="${f(it.y)}%" overflow="visible"><g class="nw-scatter__mk" style="--r:${it.rot}deg;--t:${f(it.t)}s;color:${color === 'spectrum' ? resolveColor(it.c) : resolveColor(color)}" transform="rotate(${it.rot})" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none">${GLYPHS[it.g](glyphSize * it.k)}</g></svg>`).join('')}</svg>`;
}

// ── Backdrop: big soft shapes cropped at the edges, sparse doodles ────
const ANCHORS = [[-9, -8], [84, -10], [92, 40], [-12, 58], [26, 90], [70, 84], [46, -16], [-14, 26]];
const BD_SHAPES = ['flower', 'blob', 'arch', 'scallop', 'circle', 'star', 'hexagon', 'quarter', 'stack'];
const MARK = {
    cross: 'M-5 0h10M0 -5v10',
    ring: 'M4 0A4 4 0 1 1 -4 0A4 4 0 1 1 4 0',
    squiggle: 'M-8 0q2 -5 4 0t4 0t4 0t4 0',
    tri: 'M0 -5L5 4H-5Z',
    dash: 'M-5 0h10',
};

export function backdrop({ variant = 'shapes', seed = 3, count = 5, marks = 14, colors = ['sun', 'sky', 'blush', 'mint', 'violet'], scale = 1, animate = true, cls = '' } = {}) {
    const r = rng(seed * 97 + 13);
    const off = Math.floor(r() * ANCHORS.length);
    const items = Array.from({ length: Math.min(count, ANCHORS.length) }, (_, i) => {
        const [x, y] = ANCHORS[(i + off) % ANCHORS.length];
        return { x: x + r() * 6, y: y + r() * 6, shape: BD_SHAPES[Math.floor(r() * BD_SHAPES.length)], size: Math.round((170 + r() * 150) * scale), rot: Math.round(r() * 60 - 30), color: colors[i % colors.length], t: 18 + r() * 12, finish: i % 2 ? 'dots' : 'hatch' };
    });
    const keys = Object.keys(MARK);
    const dots = Array.from({ length: marks }, () => ({ x: 4 + r() * 92, y: 4 + r() * 92, k: keys[Math.floor(r() * keys.length)], rot: Math.round(r() * 180), t: 6 + r() * 6 }));
    const shapes = variant === 'confetti' ? '' : items.map((it) =>
        `<div class="nw-bd__it" style="left:${f(it.x)}%;top:${f(it.y)}%;--r:${it.rot}deg;--t:${f(it.t)}s">${variant === 'field'
            ? shape({ shape: it.shape, finish: it.finish, color: 'ink', size: it.size })
            : shape({ shape: it.shape, color: `var(--${it.color}-soft)`, size: it.size })}</div>`).join('');
    const mk = dots.map((d, i) =>
        `<svg class="nw-bd__mk" width="20" height="20" viewBox="-10 -10 20 20" style="left:${f(d.x)}%;top:${f(d.y)}%;--r:${d.rot}deg;--t:${f(d.t)}s"><path d="${MARK[d.k]}" fill="none" stroke="${variant === 'confetti' && i % 3 === 0 ? `var(--${colors[i % colors.length]})` : 'var(--ink-300)'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`).join('');
    return `<div class="nw-bd${animate ? ' nw-bd--alive' : ''} ${cls}" aria-hidden="true">${shapes}${mk}</div>`;
}

// ── Illustration: the 15 named scenes ─────────────────────────────────
const INK = 'var(--line-strong)';
const FACE = 'var(--ink-900)';
const PAPER = 'var(--bg-surface)';
const FAINT = 'var(--line)';

/** Animation attributes. o = view-box origin ('120px 80px'), fo = fill-box origin. */
function A(name, o = {}) {
    let st = '';
    if (o.d) st += `animation-delay:${o.d}s;`;
    if (o.t) st += `animation-duration:${o.t}s;`;
    if (o.o) st += `transform-box:view-box;transform-origin:${o.o};`;
    if (o.fo) st += `transform-origin:${o.fo};`;
    return ` class="nwi-a-${name}"${st ? ` style="${st}"` : ''}`;
}
const at = (x, y, inner) => `<g transform="translate(${x} ${y})">${inner}</g>`;

function shapeAt({ name = 'circle', x, y, s, fill, stroke = true, sw = 2.5 }) {
    const k = s / 100;
    return `<path d="${(SHAPES[name] || SHAPES.circle)[0]}" transform="translate(${x} ${y}) scale(${k})" fill="${fill}" stroke="${stroke ? INK : 'none'}" stroke-width="${f(sw / k)}" stroke-linejoin="round"/>`;
}

function face({ x, y, k = 1, eyes = 'dot', mouth = 'smile', look = [0, 0], lookAnim = false }) {
    const st = `fill="none" stroke="${FACE}" stroke-width="2.4" stroke-linecap="round"`;
    const lx = look[0] * 1.6, ly = look[1] * 1.6;
    const e = eyes === 'closed'
        ? `<g ${st}><path d="M-10 0q3 3 6 0"/><path d="M4 0q3 3 6 0"/></g>`
        : `<g fill="${FACE}"><circle cx="${-7 + lx}" cy="${ly}" r="2.5"/><circle cx="${7 + lx}" cy="${ly}" r="2.5"/></g>`;
    const m = mouth === 'grin' ? `<path d="M-7 6q7 7 14 0" ${st}/>`
        : mouth === 'o' ? `<circle cx="0" cy="8" r="2.2" fill="${FACE}"/>`
        : mouth === 'flat' ? `<path d="M-3 8h6" ${st}/>`
        : mouth === 'small' ? `<path d="M-2.5 7q2.5 2 5 0" ${st}/>`
        : `<path d="M-4.5 6q4.5 4 9 0" ${st}/>`;
    return `<g transform="translate(${x} ${y}) scale(${k})"><g${A(lookAnim ? 'look' : 'blink', { d: f((x % 7) * 0.3) })}>${e}</g>${m}</g>`;
}

const sparkle = (s) => `M0 ${-s}Q0 0 ${s} 0Q0 0 0 ${s}Q0 0 ${-s} 0Q0 0 0 ${-s}Z`;
function markEl({ t, x, y, s = 5, anim, d = 0, fill }) {
    let el;
    if (t === 'sparkle') el = `<path d="${sparkle(s)}" fill="${fill || INK}" stroke="none"/>`;
    else if (t === 'dot') el = `<circle r="${s * 0.45}" fill="${fill || INK}" stroke="none"/>`;
    else if (t === 'ring') el = `<circle r="${s * 0.8}" fill="none"/>`;
    else if (t === 'dash') el = `<path d="M${-s} 0h${s * 2}"/>`;
    else if (t === 'tri') el = `<path d="M0 ${-s}L${s} ${s * 0.8}H${-s}Z" fill="none"/>`;
    else if (t === 'squiggle') el = `<path d="M${-s * 1.6} 0q${s * 0.4} ${-s} ${s * 0.8} 0t${s * 0.8} 0t${s * 0.8} 0t${s * 0.8} 0" fill="none"/>`;
    else el = `<path d="M${-s} 0h${s * 2}M0 ${-s}v${s * 2}"/>`;
    return at(x, y, `<g${anim ? A(anim, { d }) : ''}>${el}</g>`);
}
const marks = (items) => `<g fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${items.map(markEl).join('')}</g>`;
const line = (inner, w = 2.5) => `<g fill="none" stroke="${INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
const CLOUD = 'M68 110A22 22 0 0 1 72 68A30 30 0 0 1 128 52A26 26 0 0 1 172 78A18 18 0 0 1 176 110Z';
const PUFF = 'M0 20A10 10 0 0 1 8 6A13 13 0 0 1 32 4A10 10 0 0 1 40 20Z';
const zz = (x0, y0) => line([0, 1].map((i) => `<path d="M0 0h8l-8 9h8" transform="translate(${x0 + i * 12} ${y0 - i * 12}) scale(${1 - i * 0.25})"${A('zz', { d: i * 1.2 })}/>`).join(''), 2.2);
const rays = (cx, cy, r1, r2, angles) => angles.map((a) => { const r = Math.PI * a / 180; return `<path d="M${f(cx + Math.cos(r) * r1)} ${f(cy + Math.sin(r) * r1)}L${f(cx + Math.cos(r) * r2)} ${f(cy + Math.sin(r) * r2)}"/>`; }).join('');

const SCENES = {
    'empty-notes': { color: 'sun', vb: [240, 180], draw: ({ c, s }) => `
        <path d="${SHAPES.blob[0]}" transform="translate(56 16) scale(1.28 1.12)" fill="${s}"/>
        ${marks([{ t: 'sparkle', x: 210, y: 36, s: 7, anim: 'twinkle' }, { t: 'cross', x: 28, y: 44 }, { t: 'dot', x: 216, y: 118, s: 6 }, { t: 'ring', x: 20, y: 112 }, { t: 'squiggle', x: 44, y: 22, s: 5 }])}
        ${line(`<path d="M34 156Q78 144 120 160Q162 144 206 156"/>
            <path d="M36 74Q78 60 120 74V152Q78 138 36 150Z" fill="${PAPER}"/>
            <path d="M120 74Q162 60 204 74V150Q162 138 120 152Z" fill="${PAPER}"/>
            <g stroke="${FAINT}" stroke-dasharray="5 6"><path d="M134 94Q162 86 190 92"/><path d="M134 110Q162 102 190 108"/><path d="M134 126Q150 121 168 123"/></g>`)}
        <g${A('bob', { d: 0.4 })}>${shapeAt({ name: 'flower', x: 52, y: 82, s: 46, fill: 'var(--blush)' })}${face({ x: 75, y: 104, k: 0.8, eyes: 'closed', mouth: 'smile' })}</g>
        <g transform="translate(160 46) rotate(-28)"><g${A('wiggle')}>${line(`
            <rect x="-44" y="-7" width="12" height="14" rx="3" fill="var(--blush)"/>
            <rect x="-32" y="-7" width="54" height="14" fill="${c}"/>
            <path d="M-32 0H22" stroke="var(--ink-900)" stroke-opacity=".25" stroke-width="1.5"/>
            <path d="M22 -7L40 0L22 7Z" fill="${PAPER}"/><path d="M34 -2.4L40 0L34 2.4Z" fill="${INK}"/>`)}</g></g>` },
    'empty-search': { color: 'sky', vb: [240, 180], draw: ({ c, s }) => `
        <circle cx="112" cy="84" r="60" fill="${s}"/>
        ${marks([{ t: 'sparkle', x: 196, y: 40, s: 6, anim: 'twinkle' }, { t: 'dash', x: 40, y: 40 }, { t: 'dot', x: 30, y: 128, s: 6 }, { t: 'cross', x: 206, y: 100 }, { t: 'squiggle', x: 186, y: 158, s: 5 }])}
        <g${A('sway', { o: '178px 150px', t: 4.2 })}>${line(`
            <path d="M142 112L176 146" stroke-width="16"/>
            <path d="M142 112L176 146" stroke="${c}" stroke-width="9"/>
            <circle cx="110" cy="80" r="44" fill="${PAPER}"/>
            <circle cx="110" cy="80" r="35" stroke="${FAINT}" stroke-width="1.5" stroke-dasharray="5 5"/>
            <path d="M84 60A32 32 0 0 1 98 50"/>`)}
            ${shapeAt({ name: 'hexagon', x: 92, y: 70, s: 38, fill: c })}
            ${face({ x: 111, y: 87, k: 0.85, eyes: 'dot', mouth: 'o', lookAnim: true })}</g>` },
    'all-done': { color: 'mint', vb: [240, 180], draw: ({ c, s }) => `
        <rect x="56" y="34" width="132" height="134" rx="22" fill="${s}" transform="rotate(-7 122 100)"/>
        ${marks([{ t: 'sparkle', x: 36, y: 50, s: 7, anim: 'twinkle' }, { t: 'sparkle', x: 206, y: 126, s: 5, anim: 'twinkle', d: 0.8 }, { t: 'tri', x: 30, y: 130 }, { t: 'cross', x: 210, y: 80 }, { t: 'dot', x: 52, y: 164, s: 6 }])}
        ${line(`<rect x="66" y="30" width="108" height="134" rx="14" fill="${PAPER}"/>
            <rect x="98" y="21" width="44" height="18" rx="6" fill="${PAPER}"/><circle cx="120" cy="27" r="2.5" fill="${INK}" stroke="none"/>
            ${[0, 1, 2].map((i) => `<g><rect x="82" y="${56 + i * 32}" width="18" height="18" rx="5" fill="${c}"/>
                <path d="M86 ${65 + i * 32}l4 4.5l7 -8.5" pathLength="1"${A('draw', { d: f(0.3 + i * 0.35) })}/>
                <path d="M110 ${65 + i * 32}H${[158, 150, 140][i]}" stroke="${FAINT}" stroke-width="3"/></g>`).join('')}`)}
        <g${A('bob', { d: 0.2 })}>${shapeAt({ name: 'star', x: 148, y: 6, s: 50, fill: 'var(--sun)' })}${face({ x: 173, y: 30, k: 0.8, eyes: 'closed', mouth: 'grin' })}</g>` },
    'empty-journal': { color: 'violet', vb: [240, 180], draw: ({ c, s }) => `
        <circle cx="120" cy="88" r="62" fill="${s}"/>
        ${marks([{ t: 'sparkle', x: 52, y: 42, s: 7, anim: 'twinkle' }, { t: 'sparkle', x: 198, y: 28, s: 5, anim: 'twinkle', d: 0.6 }, { t: 'sparkle', x: 210, y: 104, s: 6, anim: 'twinkle', d: 1.2 }, { t: 'dot', x: 36, y: 104, s: 5 }, { t: 'dot', x: 170, y: 22, s: 4 }])}
        <g${A('rise')}>${line(`<path d="M140 30A36 36 0 1 0 140 96A44 44 0 0 1 140 30Z" fill="${c}"/>`)}${face({ x: 110, y: 62, k: 0.85, eyes: 'closed', mouth: 'small' })}</g>
        ${zz(158, 58)}
        ${line(`<rect x="58" y="118" width="124" height="34" rx="8" fill="${PAPER}"/>
            <path d="M58 126a8 8 0 0 1 8 -8h14v34h-14a8 8 0 0 1 -8 -8Z" fill="${c}"/>
            <g stroke="${FAINT}"><path d="M90 130H170"/><path d="M90 140H170"/></g>
            <g transform="translate(152 150)"><g${A('sway', { o: '0px 0px', t: 3 })}><path d="M0 0v20l6 -5l6 5v-20" fill="${c}"/></g></g>`)}` },
    'kind-brainstorm': { color: 'tomato', vb: [240, 180], draw: ({ c, s }) => `
        <path d="${CLOUD}" transform="translate(7 7)" fill="${s}"/>
        ${marks([{ t: 'cross', x: 40, y: 150, anim: 'twinkle' }, { t: 'cross', x: 206, y: 140, anim: 'twinkle', d: 0.7 }, { t: 'sparkle', x: 196, y: 40, s: 6 }, { t: 'dot', x: 36, y: 60, s: 6 }, { t: 'squiggle', x: 60, y: 30, s: 5 }])}
        <g${A('wiggle', { t: 3.4 })}>${line(`<path d="${CLOUD}" fill="${PAPER}"/>`)}${face({ x: 122, y: 86, k: 1, eyes: 'dot', mouth: 'o', look: [0, 0.5] })}</g>
        ${line(`<g${A('flicker')}><path d="M104 116L92 142H106L96 168L126 132H111L120 116Z" fill="${c}"/></g>
            <g${A('flicker', { d: 1.1 })}><path d="M150 116L143 132H152L146 148L164 128H155L160 116Z" fill="${c}"/></g>
            <g stroke="${FAINT}"><path d="M74 124l-5 12"/><path d="M176 124l-5 12"/></g>`)}` },
    'kind-idea': { color: 'sun', vb: [240, 180], draw: ({ c, s }) => `
        <circle cx="128" cy="78" r="40" fill="${c}"/>
        ${marks([{ t: 'sparkle', x: 42, y: 110, s: 6, anim: 'twinkle' }, { t: 'sparkle', x: 202, y: 118, s: 5, anim: 'twinkle', d: 0.9 }, { t: 'dot', x: 214, y: 30, s: 5 }, { t: 'ring', x: 28, y: 36 }])}
        <g${A('pulse', { o: '120px 72px' })}>${line(rays(120, 72, 54, 66, [-160, -125, -90, -55, -20]))}</g>
        <g${A('bob', { t: 3.6 })}>${line(`
            <path d="M100 108C86 96 80 82 82 70A38 38 0 0 1 158 70C160 82 154 96 140 108V120H100Z" fill="${s}"/>
            <rect x="100" y="120" width="40" height="10" rx="4" fill="${PAPER}"/><rect x="104" y="130" width="32" height="10" rx="4" fill="${PAPER}"/><path d="M112 140v4h16v-4"/>`)}${face({ x: 120, y: 78, k: 1.05, eyes: 'closed', mouth: 'grin' })}</g>` },
    'kind-reference': { color: 'sky', vb: [240, 180], draw: ({ c, s }) => `
        <rect x="40" y="76" width="160" height="92" rx="24" fill="${s}"/>
        ${marks([{ t: 'sparkle', x: 186, y: 42, s: 7, anim: 'twinkle' }, { t: 'cross', x: 34, y: 50 }, { t: 'dot', x: 214, y: 92, s: 6 }, { t: 'dash', x: 50, y: 24 }])}
        ${line(`<rect x="52" y="134" width="136" height="22" rx="5" fill="${PAPER}"/><path d="M66 134v22M174 134v22"/>
            <rect x="66" y="112" width="112" height="22" rx="5" fill="${c}"/><path d="M84 112v22"/>
            <rect x="58" y="90" width="120" height="22" rx="5" fill="${PAPER}"/><path d="M160 90v22"/>
            <g transform="translate(146 90)"><g${A('sway', { o: '0px 0px', t: 3.2 })}><path d="M0 0v-18l6 5l6 -5v18" fill="var(--sun)"/></g></g>`)}
        <g${A('bob')}>${shapeAt({ name: 'circle', x: 80, y: 46, s: 42, fill: 'var(--blush)' })}
            ${face({ x: 101, y: 64, k: 0.8, eyes: 'dot', mouth: 'small', look: [0, 1] })}
            ${line(`<path d="M82 80Q91 75 100 80Q109 75 118 80V90Q109 85 100 90Q91 85 82 90Z" fill="${PAPER}"/><path d="M100 80V90"/>`)}</g>` },
    'kind-journal': { color: 'violet', vb: [240, 180], draw: ({ c, s }) => `
        <rect x="62" y="38" width="112" height="126" rx="12" fill="${s}" transform="rotate(5 118 100)"/>
        ${marks([{ t: 'sparkle', x: 200, y: 150, s: 6, anim: 'twinkle' }, { t: 'dot', x: 38, y: 60, s: 6 }, { t: 'cross', x: 34, y: 140 }, { t: 'ring', x: 206, y: 40 }])}
        <g transform="rotate(-5 110 100)">${line(`
            <rect x="54" y="38" width="112" height="126" rx="12" fill="${PAPER}"/>
            <g stroke="${FAINT}" stroke-dasharray="5 6"><path d="M70 66H150"/><path d="M70 84H150"/><path d="M70 102H136"/></g>
            <path d="M70 128q6 -10 12 0t12 0t12 0t12 0" pathLength="1"${A('write')}/>`)}</g>
        <g transform="translate(118 124)"><g${A('scribble', { o: '0px 0px' })}>${line(`
            <path d="M4 -6C0 -40 30 -84 74 -98C72 -56 46 -18 4 -6Z" fill="${c}"/>
            <path d="M0 2L58 -76"/><path d="M30 -38l14 -4M20 -24l12 -2" stroke="${PAPER}" stroke-width="2"/>`)}</g></g>` },
    'kind-task': { color: 'cobalt', vb: [240, 180], draw: ({ c, s }) => `
        ${[0, 1, 2].map((i) => `<rect x="58" y="${44 + i * 40}" width="136" height="30" rx="15" fill="${s}"/>`).join('')}
        ${marks([{ t: 'sparkle', x: 34, y: 40, s: 7, anim: 'twinkle' }, { t: 'dot', x: 212, y: 30, s: 5 }, { t: 'tri', x: 30, y: 150 }])}
        ${line(`${[0, 1, 2].map((i) => `<g><rect x="52" y="${38 + i * 40}" width="136" height="30" rx="15" fill="${PAPER}"/>
                <path d="M88 ${53 + i * 40}H${[150, 168, 128][i]}" stroke="${FAINT}" stroke-width="3"/></g>`).join('')}
            ${[0, 1].map((i) => `<g${A('pop', { d: f(0.2 + i * 0.35) })}><circle cx="70" cy="${53 + i * 40}" r="9" fill="${c}"/>
                <path d="M66 ${53 + i * 40}l3 3.5l5.5 -6.5" stroke="var(--paper-0)" stroke-width="2.4"/></g>`).join('')}
            <g${A('pulse')}><circle cx="70" cy="133" r="9" stroke-dasharray="4 3.5"/></g>`)}
        <g${A('bob', { d: 0.5 })}>${shapeAt({ name: 'square', x: 164, y: 96, s: 34, fill: 'var(--sun)' })}${face({ x: 181, y: 113, k: 0.7, eyes: 'dot', mouth: 'small', look: [-1, 0.4] })}</g>` },
    'hero-morning': { color: 'sun', vb: [240, 180], clay: true, draw: ({ uid: u }) => `
        <defs><clipPath id="h${u}"><rect x="-20" y="-20" width="280" height="184"/></clipPath></defs>
        <g${A('spin', { o: '120px 70px' })}>${line(rays(120, 70, 58, 68, Array.from({ length: 10 }, (_, i) => i * 36)), 2.2)}</g>
        <g clip-path="url(#h${u})">
            ${at(72, 22, `<g${A('rise')}>${mood({ mood: 'joyful', finish: 'clay', size: 96 })}</g>`)}
            ${at(-14, 86, shape({ shape: 'arch', color: 'mint', finish: 'clay', size: 128 }))}
            ${at(118, 96, shape({ shape: 'arch', color: 'sky', finish: 'clay', size: 136 }))}
        </g>
        ${line('<path d="M4 164H236"/>')}
        ${at(18, 34, `<g${A('drift')}>${line(`<path d="${PUFF}" fill="${PAPER}"/>`)}</g>`)}
        <g transform="translate(184 22) scale(.8)"><g${A('drift', { d: 1.6, t: 8 })}>${line(`<path d="${PUFF}" fill="${PAPER}"/>`)}</g></g>
        ${marks([{ t: 'sparkle', x: 206, y: 96, s: 5, anim: 'twinkle' }, { t: 'dot', x: 30, y: 86, s: 5 }])}` },
    'hero-evening': { color: 'violet', vb: [240, 180], clay: true, draw: ({ uid: u }) => `
        <defs><clipPath id="h${u}"><rect x="-20" y="-20" width="280" height="184"/></clipPath></defs>
        ${marks([{ t: 'sparkle', x: 36, y: 90, s: 6, anim: 'twinkle' }, { t: 'sparkle', x: 214, y: 30, s: 5, anim: 'twinkle', d: 0.7 }, { t: 'sparkle', x: 170, y: 20, s: 4, anim: 'twinkle', d: 1.4 }, { t: 'dot', x: 60, y: 22, s: 5 }, { t: 'dot', x: 200, y: 104, s: 4 }])}
        ${at(26, 26, `<g${A('twinkle', { t: 3 })}>${shape({ shape: 'star', color: 'sun', finish: 'clay', size: 34 })}</g>`)}
        ${at(180, 56, `<g${A('twinkle', { t: 3, d: 1 })}>${shape({ shape: 'star', color: 'sun', finish: 'clay', size: 24 })}</g>`)}
        <g clip-path="url(#h${u})">
            ${at(76, 20, `<g${A('rise', { t: 5.2 })}>${mood({ mood: 'calm', color: 'violet', finish: 'clay', eyes: 'closed', mouth: 'small', size: 88 })}</g>`)}
            ${at(-20, 90, shape({ shape: 'arch', color: 'cobalt', finish: 'clay', size: 132 }))}
            ${at(120, 84, shape({ shape: 'arch', color: 'blush', finish: 'clay', size: 140 }))}
        </g>
        ${zz(172, 38)}
        ${line('<path d="M4 164H236"/>')}` },
    saved: { color: 'mint', vb: [240, 180], clay: true, draw: () => `
        <g${A('burst', { o: '120px 82px' })}>${[['sun', 'square'], ['blush', 'circle'], ['sky', 'triangle'], ['tomato', 'circle'], ['violet', 'square'], ['tangerine', 'triangle'], ['cobalt', 'circle'], ['berry', 'square']].map(([col, sh], i) => {
            const a = (Math.PI * 2 * i) / 8 - Math.PI / 2 + 0.3, r = 80;
            return shapeAt({ name: sh, x: f(120 + Math.cos(a) * r - 6), y: f(82 + Math.sin(a) * r * 0.82 - 6), s: 12, fill: `var(--${col})`, stroke: false });
        }).join('')}</g>
        ${marks([{ t: 'sparkle', x: 44, y: 150, s: 6, anim: 'twinkle' }, { t: 'sparkle', x: 198, y: 150, s: 5, anim: 'twinkle', d: 0.6 }])}
        ${at(64, 26, `<g${A('pop')}>${shape({ shape: 'flower', color: 'mint', finish: 'clay', size: 112 })}
            <path d="M34 58l14 14l28 -30" transform="translate(4 -2)" fill="none" stroke="var(--mint-ink-fixed)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" pathLength="1"${A('draw', { d: 0.35 })}/></g>`)}` },
    loading: { color: 'sky', vb: [240, 130], draw: () => `
        ${[['circle', 'sky', 52], ['triangle', 'sun', 102], ['square', 'blush', 152]].map(([sh, col, x], i) => `<g>
            ${at(x + 18, 106, `<g${A('shadow', { d: f(i * 0.16) })}><ellipse rx="15" ry="3" fill="var(--ink-200)"/></g>`)}
            <g${A('hop', { d: f(i * 0.16), fo: '50% 100%' })}>${shapeAt({ name: sh, x, y: 62, s: 36, fill: `var(--${col})` })}${face({ x: x + 18, y: sh === 'triangle' ? 88 : 80, k: 0.6, eyes: 'dot', mouth: i === 1 ? 'o' : 'smile' })}</g></g>`).join('')}
        ${marks([{ t: 'sparkle', x: 36, y: 40, s: 5, anim: 'twinkle' }, { t: 'sparkle', x: 206, y: 36, s: 6, anim: 'twinkle', d: 0.8 }])}` },
    saving: { color: 'sky', vb: [240, 130], draw: ({ c }) => `
        ${line(`<path d="M16 108C60 110 72 62 102 72C132 82 114 110 94 100C74 90 118 54 164 58" stroke-dasharray="4 7"${A('march')}/>`, 2)}
        ${marks([{ t: 'dash', x: 150, y: 90 }, { t: 'dash', x: 132, y: 36, s: 4 }, { t: 'sparkle', x: 220, y: 96, s: 5, anim: 'twinkle' }, { t: 'dot', x: 34, y: 60, s: 5 }])}
        <g transform="translate(206 48) rotate(-14)"><g${A('fly')}>${line(`
            <path d="M0 0L-46 -18L-30 2Z" fill="${PAPER}"/>
            <path d="M0 0L-30 2L-40 18Z" fill="${c}"/>
            <path d="M-30 2L-34 10"/>`)}</g></g>` },
    peek: { color: 'sun', vb: [100, 64], draw: ({ c, uid: u, shape: sh }) => {
        const h = [...(sh || 'circle')].reduce((a, ch) => a + ch.charCodeAt(0), 0);
        const look = [[-0.8, -0.5], [0.8, -0.5], [0, -0.8], [-1, 0], [1, 0]][h % 5];
        return `<defs><clipPath id="p${u}"><rect x="-10" y="-20" width="120" height="72"/></clipPath></defs>
            <g clip-path="url(#p${u})"><g class="nwi-peek"><g${A('peek', { d: f((h % 4) * 0.4) })}>
                ${shapeAt({ name: sh || 'circle', x: 20, y: 12, s: 60, fill: c })}
                ${face({ x: 50, y: 34, k: 0.95, eyes: 'dot', mouth: 'small', look })}
            </g></g></g>
            ${line(`<ellipse cx="33" cy="52" rx="7" ry="5" fill="${c}"/><ellipse cx="67" cy="52" rx="7" ry="5" fill="${c}"/><path d="M31 49.5v4M35 49.5v4M65 49.5v4M69 49.5v4" stroke-width="1.5"/>`)}`;
    } },
};
export const ILLUSTRATION_NAMES = Object.keys(SCENES);

/** A named spot illustration. Animated unless still; honours reduced motion in CSS. */
export function illustration(name, { color, shape: sh, size, still = false, title = '', cls = '', style = '' } = {}) {
    const sc = SCENES[name] || SCENES['empty-notes'];
    const col = color || sc.color;
    const u = uid();
    const [w, h] = sc.vb;
    const width = size || w;
    const body = sc.draw({ c: `var(--${col})`, s: `var(--${col}-soft)`, k: `var(--${col}-ink)`, uid: u, shape: sh });
    return `<svg viewBox="0 0 ${w} ${h}" width="${width}" height="${f(width * h / w)}" class="nwi${still ? ' nwi--still' : ''} ${cls}" ${aria(title)}${style ? ` style="${style}"` : ''}>${body}</svg>`;
}

// ── Burst: spectrum doodles thrown from the click point ───────────────
const BURST = ['M-4 0h8M0 -4v8', 'M0 0m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0', 'M0 -4L4 3H-4Z', 'M-5 0q1.25 -3 2.5 0t2.5 0t2.5 0t2.5 0'];
const BURST_C = ['sun', 'blush', 'sky', 'mint', 'tangerine', 'violet', 'berry', 'tomato'];

// Drawn in a fixed layer at the tap, so a button whose container clips its
// overflow (most of them) still shows the whole burst.
export function burstAt(el, e, { count = 8, reach = 30 } = {}) {
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = el.getBoundingClientRect();
    const x = e && e.clientX ? e.clientX : r.left + r.width / 2;
    const y = e && e.clientY ? e.clientY : r.top + r.height / 2;
    for (let i = 0; i < count; i++) {
        const a = (Math.PI * 2 * i) / count + Math.random() * 0.5, d = reach + Math.random() * reach * 0.6;
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('viewBox', '-6 -6 12 12');
        s.setAttribute('class', 'nw-burst');
        s.setAttribute('aria-hidden', 'true');
        s.style.left = x + 'px';
        s.style.top = y + 'px';
        s.style.setProperty('--dx', Math.cos(a) * d + 'px');
        s.style.setProperty('--dy', Math.sin(a) * d + 'px');
        s.style.setProperty('--rot', Math.round(Math.random() * 180) + 'deg');
        const col = BURST_C[i % BURST_C.length];
        s.innerHTML = `<path d="${BURST[i % 4]}" fill="${i % 4 === 2 ? `var(--${col})` : 'none'}" stroke="var(--${col})" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
        document.body.appendChild(s);
        setTimeout(() => s.remove(), 700);
    }
}

/** Circular progress with centred content. */
export function progressRing({ value = 0, size = 56, thickness = 12, color = 'mint', inner = '' } = {}) {
    const r = 50 - thickness / 2 - 1;
    const c = 2 * Math.PI * r;
    const v = Math.max(0, Math.min(1, value));
    return `<div class="nw-ring" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(v * 100)}" style="width:${size}px;height:${size}px">
        <svg viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true"><circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--bg-sunken)" stroke-width="${thickness}"/><circle class="nw-ring__v" cx="50" cy="50" r="${r}" fill="none" stroke="${resolveColor(color)}" stroke-width="${thickness}" stroke-linecap="round" stroke-dasharray="${f(c)}" stroke-dashoffset="${f(c * (1 - v))}"/></svg>
        <div class="nw-ring__in">${inner}</div></div>`;
}
