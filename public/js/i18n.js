const dict = { vi: {}, en: {} };
let locale = 'vi';
const listeners = new Set();
export async function loadI18n() {
  const [vi, en] = await Promise.all(['vi', 'en'].map((l) => fetch(`/i18n/${l}.json`).then((r) => r.json())));
  dict.vi = vi; dict.en = en;
  const saved = (() => { try { return localStorage.getItem('locale'); } catch { return null; } })();
  setLocale(saved || ((navigator.language || 'vi').slice(0, 2) === 'en' ? 'en' : 'vi'), true);
}
export function setLocale(l, silent) {
  locale = l === 'en' ? 'en' : 'vi';
  document.documentElement.lang = locale;
  try { localStorage.setItem('locale', locale); } catch { /* bỏ qua */ }
  if (!silent) listeners.forEach((f) => f());
}
export const getLocale = () => locale;
export const onLocale = (f) => { listeners.add(f); return () => listeners.delete(f); };
/** t('key', {n: 3}) — thiếu khóa: trả về chính khóa (dễ thấy khi kiểm thử) và ghi cảnh báo. */
export function t(key, params = {}) {
  let s = dict[locale][key] ?? dict.vi[key];
  if (s === undefined) { if (!t.warned?.has(key)) { (t.warned ||= new Set()).add(key); console.warn('i18n: thiếu khóa', key); } return key; }
  if (typeof s === 'object') s = s[plural(params.n)] ?? s.other;
  return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ''));
}
const plural = (n) => (n === 1 ? 'one' : 'other');
export const errText = (e) => {
  const k = e?.messageKey || `error.${e?.code || 'INTERNAL_ERROR'}`;
  const out = t(k, e?.params || {});
  const base = out === k ? t('error.UNKNOWN') : out;
  const d = e?.code === 'DEPENDENCY_UNAVAILABLE' && e?.details?.[0];
  return d && (d.message || d.reason) ? `${base} [${[d.status, d.message || d.reason].filter(Boolean).join(': ')}]` : base;
};
