// The Board's content colours. These are the user's data (a sticky's colour is saved in board.json), not the app's
// chrome, so they are the one place in the Board that names colours directly; every other colour comes from the
// Noteworthy tokens. Sticky names are Miro's. Keep STICKY in step with sense/board/schema.py.

export const STICKY = {
  gray: '#E6E6E6', light_yellow: '#FFF9B1', yellow: '#F5D128', orange: '#FF9D48', light_green: '#D5F692', green: '#C9DF56',
  dark_green: '#93D275', cyan: '#67C6C0', light_pink: '#FFCEE0', pink: '#F16C7F', violet: '#CA91D8', red: '#F24726',
  light_blue: '#A6CCF5', blue: '#2D9BF0', dark_blue: '#5B7CE6', black: '#1A1A1A',
};
export const STICKY_KEYS = Object.keys(STICKY);
export const STICKY_DEFAULT = 'light_yellow';

// Fill and line colours for shapes, text boxes, connectors, pens.
export const SWATCHES = ['#FFFFFF', '#E6E6E6', '#8F8A81', '#1A1A1A', '#F24726', '#FF9D48', '#F5D128', '#93D275', '#67C6C0', '#2D9BF0', '#5B7CE6', '#CA91D8', '#F16C7F'];
export const INK = '#1A1A1A';
export const PAPER = '#FFFFFF';
export const HIGHLIGHTER = '#F5D128';

// Text that sits on a sticky or a dark fill: pick black or white by luminance.
export function inkOn(hex) {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? INK : '#FFFFFF';
}

export const stickyHex = k => STICKY[k] || STICKY[STICKY_DEFAULT];

// Mind-map branches take these in turn; the root is INK.
export const BRANCH = ['#2D9BF0', '#CA91D8', '#93D275', '#FF9D48', '#F16C7F', '#67C6C0', '#F5D128', '#5B7CE6'];
