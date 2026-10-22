import { h } from './dom.js';
import { t } from './i18n.js';
// Thành phần «Sổ tay giấy ấm» (Design Spec §11). P-03: mọi góc nghiêng/màu suy ra từ hash(id), không dùng ngẫu nhiên hay đồng hồ khi render.
export const hashStr = (s) => { let x = 2166136261; for (const c of String(s)) { x ^= c.codePointAt(0); x = Math.imul(x, 16777619); } return x >>> 0; };
export const hashAngle = (id, max = 2) => ((hashStr(id) % 2001) / 1000 - 1) * max;           // [-max, +max] độ, ổn định theo id
export const rotStyle = (id, max = 2) => `--rot:${hashAngle(id, max).toFixed(2)}deg`;
// Không dùng thuộc tính style (CSP): đặt biến CSS qua CSSOM.
export function withRot(el, id, max = 2) { el.style.setProperty('--rot', `${hashAngle(id, max).toFixed(2)}deg`); return el; }
const S = (tag, a, ...k) => h('svg:' + tag, a, ...k);
export const MOODS = ['vui', 'suy_nghi', 'an_mung', 'nghi_ngoi', 'dong_vien', 'ngac_nhien'];
const ALIAS = { idle: 'vui', happy: 'vui', thinking: 'suy_nghi', cheer: 'an_mung', sleepy: 'nghi_ngoi', sad: 'dong_vien', surprised: 'ngac_nhien' };
const INK = '#2F2118';
/** <Mascot mood> — Cú Mimi, nhân vật gốc (cú nâu cam, nhân vật placeholder do dev vẽ; chờ nghệ sĩ & chủ sở hữu duyệt). */
export function Mascot({ mood = 'vui', size = 96, label, anim = false } = {}) {
  const m = MOODS.includes(mood) ? mood : (ALIAS[mood] || 'vui');
  const closed = m === 'nghi_ngoi', joy = m === 'an_mung';
  const eye = (cx) => closed ? S('path', { d: `M${cx - 8} 54q8 7 16 0`, stroke: INK, 'stroke-width': 3.5, fill: 'none', 'stroke-linecap': 'round' })
    : joy ? S('path', { d: `M${cx - 8} 56q8-10 16 0`, stroke: INK, 'stroke-width': 3.5, fill: 'none', 'stroke-linecap': 'round' })
    : S('g', {}, S('circle', { cx, cy: 52, r: m === 'ngac_nhien' ? 13 : 11, fill: '#fff' }), S('circle', { cx: cx + (m === 'suy_nghi' ? 3 : 0), cy: m === 'suy_nghi' ? 48 : 52, r: m === 'ngac_nhien' ? 4 : 6, fill: INK }), S('circle', { cx: cx + 2, cy: 50, r: 1.8, fill: '#fff' }));
  const brow = m === 'dong_vien' ? S('path', { d: 'M30 40l12-4M90 40l-12-4', stroke: INK, 'stroke-width': 3, 'stroke-linecap': 'round' })
    : m === 'suy_nghi' ? S('path', { d: 'M74 36l14-4', stroke: INK, 'stroke-width': 3, 'stroke-linecap': 'round' }) : null;
  const beak = m === 'ngac_nhien' ? S('ellipse', { cx: 60, cy: 70, rx: 5, ry: 7, fill: '#F2B632' })
    : m === 'an_mung' ? S('path', { d: 'M52 66h16l-8 14z', fill: '#F2B632' })
    : m === 'dong_vien' ? S('path', { d: 'M53 68h14l-7 9z', fill: '#F2B632' }) : S('path', { d: 'M54 66h12l-6 11z', fill: '#F2B632' });
  const extra = joy ? S('g', { stroke: '#C4511F', 'stroke-width': 4, 'stroke-linecap': 'round' }, S('path', { d: 'M14 26l7 8M106 26l-7 8M60 4v10' }))
    : m === 'suy_nghi' ? S('g', { fill: '#6B5848' }, S('circle', { cx: 100, cy: 26, r: 3.5 }), S('circle', { cx: 108, cy: 14, r: 5.5 }))
    : closed ? S('text', { x: 92, y: 30, 'font-size': 18, 'font-weight': 700, fill: '#6B5848' }, 'z')
    : m === 'ngac_nhien' ? S('path', { d: 'M60 4v12M44 8l4 10M76 8l-4 10', stroke: '#C4511F', 'stroke-width': 3, 'stroke-linecap': 'round' }) : null;
  const wings = joy ? 'M22 74q-14-12-10-30M98 74q14-12 10-30' : m === 'dong_vien' ? 'M24 84q-4 12 6 20M96 84q4 12-6 20' : 'M22 76q-10 10-4 26M98 76q10 10 4 26';
  return S('svg', { class: ['mascot', anim && 'anim'], viewBox: '0 0 120 120', width: size, height: size, role: 'img', 'aria-label': label || t(`mascot.${m}`) },
    S('path', { d: 'M24 38 14 14l24 14M96 38l10-24-24 14', fill: '#8A3A12' }),
    S('ellipse', { cx: 60, cy: 72, rx: 42, ry: 42, fill: '#C4511F' }),
    S('ellipse', { cx: 60, cy: 86, rx: 26, ry: 24, fill: '#F8D9C6' }),
    S('path', { d: 'M42 92q4 4 8 0M56 98q4 4 8 0M70 92q4 4 8 0', stroke: '#C4511F', 'stroke-width': 2.5, fill: 'none', 'stroke-linecap': 'round' }),
    S('path', { d: wings, stroke: '#8A3A12', 'stroke-width': 9, fill: 'none', 'stroke-linecap': 'round' }),
    S('circle', { cx: 42, cy: 52, r: 16, fill: '#F8D9C6' }), S('circle', { cx: 78, cy: 52, r: 16, fill: '#F8D9C6' }),
    eye(42), eye(78), brow, beak, extra,
    S('path', { d: 'M48 112l-2 6M72 112l2 6', stroke: '#F2B632', 'stroke-width': 4, 'stroke-linecap': 'round' }));
}
export const mascot = (mood, o) => Mascot({ mood, ...o });
export function Sticker({ children, tone = '', id = '', ghost = false } = {}) {
  return withRot(h('span', { class: ['sticker', tone, ghost && 'ghost'] }, children), id || String(children), 3);
}
export const StatSticker = (n, label, id, tone) => Sticker({ id, tone, children: [h('span', { class: 'n' }, n), h('span', { class: 'small' }, label)] });
/** PaperCard: form = note | flashcard(wordcard) | scoreboard(score) | sticker(card thường). */
export function PaperCard({ form = 'sticker', id = '', clip = false, tag = 'div', class: cls, ...props } = {}, ...kids) {
  const c = { note: 'pcard note', flashcard: 'pcard wordcard', scoreboard: 'pcard score', sticker: 'pcard' }[form] || 'pcard';
  const el = h(tag, { class: [c, clip && 'clip', cls], ...props }, ...kids);
  return form === 'note' ? withRot(el, id || form, 1.6) : el;
}
export const PolaroidFrame = ({ id = '', caption = '', child, speaking = false } = {}) =>
  withRot(h('figure', { class: ['polaroid', speaking && 'speaking'], style: undefined }, h('div', { class: 'pic' }, child), h('figcaption', { class: 'cap' }, caption)), id, 2.2);
export const Stamp = (text, bad = false) => h('span', { class: ['stamp', bad && 'bad'], role: 'status' }, text);
export function HandUnderline(text) {
  return h('span', { class: 'hand' }, text, S('svg', { viewBox: '0 0 100 8', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, S('path', { d: 'M1 5C20 1 40 7 60 3s30 2 39 1', stroke: 'var(--primary)', 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' })));
}
export const StitchProgress = (value, max, label) => {
  const pct = max ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
  const bar = h('div', { class: 'stitch', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value, 'aria-label': label || null }, h('i', {}));
  bar.firstChild.style.width = pct + '%'; return bar;
};
/** Sợi chỉ đếm ngược — dựa trên mốc thời gian máy chủ, không tự đồng hồ ngẫu nhiên. */
export function CountdownThread(ms) { const i = h('i', {}); const w = h('div', { class: 'thread', 'aria-hidden': 'true' }, i); w.set = (frac) => { i.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`; }; w.set(1); return w; }
/** Gáy sách cho kệ. */
export function Spine({ id, title, sub, href, paused, locked }) {
  const a = h('a', { class: ['spine', 'sc' + (hashStr(id) % 6), paused && 'paused', locked && 'locked'], href, 'aria-label': `${title}${sub ? ' – ' + sub : ''}` }, h('span', { class: 't' }, title), h('span', { class: 'c' }, sub));
  return withRot(a, id, 2.5);
}
export const EmptyState = ({ mood = 'vui', title, text, action } = {}) => h('div', { class: 'pcard center', role: 'status' }, Mascot({ mood, size: 110 }), title && h('h3', {}, title), text && h('p', { class: 'muted' }, text), action);
