// Dựng DOM an toàn: chỉ dùng textContent / thuộc tính, KHÔNG innerHTML, KHÔNG thuộc tính style (CSP không có unsafe-inline).
const SVG_NS = 'http://www.w3.org/2000/svg';
export function h(tag, props, ...kids) {
  const svg = tag.startsWith('svg:');
  const el = svg ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') { if (typeof v === 'object') Object.assign(el.style, v); }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (!svg && (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'indeterminate')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const mount = (el, ...kids) => { clear(el); add(el, kids); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
export const fmtDate = (iso, locale) => iso ? new Date(iso).toLocaleString(locale || undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
export const fmtDay = (iso, locale) => iso ? new Date(iso).toLocaleDateString(locale || undefined, { dateStyle: 'medium' }) : '';
