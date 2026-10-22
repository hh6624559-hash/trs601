// Kiểm tương phản WCAG cho mọi cặp chữ/nền trong bộ token (v28 §11.2). Dùng: node scripts/check-contrast.js
export const TOKENS = {
  light: { paper: '#FBF5E9', paper2: '#F3E9D6', ink: '#2F2118', ink2: '#6B5848', line: '#E2D3B8', primary: '#C4511F', primaryText: '#A2400F', primarySoft: '#F8D9C6', accent: '#3F6B4F', sun: '#F2B632', sky: '#2B6C9E', success: '#2F7D4F', warning: '#8A5A00', danger: '#B3261E', white: '#FFFFFF', inkOnSun: '#2F2118' },
  dark: { paper: '#1C1815', paper2: '#26211C', ink: '#F4EBDD', ink2: '#C9B9A6', line: '#3A322B', primary: '#F08A5D', primaryText: '#F08A5D', primarySoft: '#4A2E20', accent: '#8CC5A0', sun: '#F2B632', sky: '#7FB5D6', success: '#6FCF97', warning: '#F2C14E', danger: '#FF8A80', white: '#FFFFFF', inkOnSun: '#2F2118' },
};
// [chữ, nền, ngưỡng, ghi chú]
export const PAIRS = (m) => [
  ['ink', 'paper', 4.5], ['ink', 'paper2', 4.5], ['ink2', 'paper', 4.5], ['ink2', 'paper2', 4.5],
  [m === 'light' ? 'white' : 'paper', 'primary', 4.5], ['primaryText', 'paper', 4.5], ['primaryText', 'primarySoft', 4.5], ['ink', 'primarySoft', 4.5],
  ['accent', 'paper', 4.5], ['sky', 'paper', 4.5], ['success', 'paper', 4.5], ['warning', 'paper', 4.5], ['danger', 'paper', 4.5], ['inkOnSun', 'sun', 4.5],
];
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
export const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export function run() {
  const out = [];
  for (const mode of ['light', 'dark']) for (const [fg, bg, min] of PAIRS(mode)) { const r = ratio(TOKENS[mode][fg], TOKENS[mode][bg]); out.push({ mode, fg, bg, ratio: +r.toFixed(2), min, ok: r >= min }); }
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) { const r = run(); for (const x of r) console.log(`${x.ok ? 'OK  ' : 'FAIL'} ${x.mode} ${x.fg}/${x.bg} ${x.ratio} (>=${x.min})`); process.exit(r.every((x) => x.ok) ? 0 : 1); }
