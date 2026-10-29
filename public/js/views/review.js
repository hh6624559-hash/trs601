import { h, mount, uuid } from '../dom.js';
import { t, getLocale } from '../i18n.js';
import { get, post, session } from '../api.js';
import { action } from '../ui.js';
import { enqueue, flush, savePack, loadPack } from '../offline.js';
import { mascot } from '../mascot.js';
import { render } from '../app.js';

export const fmtInterval = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 60) return t('time.min', { n: Math.max(1, m) });
  const hh = Math.round(m / 60); if (hh < 24) return t('time.hour', { n: hh });
  const d = Math.round(hh / 24); if (d < 30) return t('time.day', { n: d });
  const mo = Math.round(d / 30); return mo < 12 ? t('time.month', { n: mo }) : t('time.year', { n: Math.round(mo / 12) });
};
const deviceId = () => { try { let d = localStorage.getItem('deviceId'); if (!d) { d = uuid().slice(0, 18); localStorage.setItem('deviceId', d); } return d; } catch { return 'dev'; } };
export function speak(text, lang = 'en-US') {
  try { if (!('speechSynthesis' in window)) return false; const u = new SpeechSynthesisUtterance(text); u.lang = lang; u.rate = 0.9; speechSynthesis.cancel(); speechSynthesis.speak(u); return true; } catch { return false; }
}

export async function review() {
  let data;
  try { data = await get('/learn/today?limit=30'); await savePack(data); }
  catch (e) { if (e.status !== 0) throw e; const p = await loadPack(); if (!p) throw e; data = p.pack; }
  const cards = [...data.cards];
  const box = h('div', {});
  const stats = { done: 0, xp: 0, again: 0, start: Date.now(), streak: null };
  const hints = new Map();
  let idx = 0, flipped = false, shownAt = 0, lastEv = null, lastShown = 0, busy = false;
  let keyHandler;

  const finish = async () => {
    document.removeEventListener('keydown', keyHandler);
    const r = await flush().catch(() => null);
    if (r?.last) { stats.xp += r.last.xpAwarded || 0; stats.streak = r.last.streak; }
    const more = (data.counts.due + data.counts.newAvailable) > cards.length;
    mount(box, h('div', { class: 'card center' }, mascot(stats.done ? 'cheer' : 'sleepy', { size: 140 }), h('h1', {}, stats.done ? t('review.doneTitle') : t('review.nothing')),
      stats.done ? h('p', {}, t('review.summary', { n: stats.done, min: Math.max(1, Math.round((Date.now() - stats.start) / 60000)) })) : h('p', { class: 'muted' }, t('review.nothingHint')),
      stats.streak && h('p', {}, '🔥 ', t('home.streakDays', { n: stats.streak.current })),
      h('div', { class: 'row' }, more && h('a', { class: 'btn moss', href: '#/review', onclick: (e) => { e.preventDefault(); render(); } }, t('review.more')), h('a', { class: 'btn', href: '#/' }, t('common.home')))));
  };

  const rate = async (rating) => {
    if (!flipped || busy) return; busy = true;
    const c = cards[idx];
    const ev = { id: uuid(), senseId: c.senseId, rating, clientAt: new Date().toISOString(), durationMs: Math.min(3600000, Date.now() - shownAt), source: 'review', deviceId: deviceId() };
    await enqueue(ev); lastEv = ev; lastShown = Date.now();
    stats.done += 1; if (rating === 1) { stats.again += 1; if (cards.length < 400) cards.push(c); } // quên → gặp lại trong phiên
    idx += 1; flipped = false; busy = false;
    if (navigator.onLine && stats.done % 5 === 0) flush().then((r) => { if (r?.last) stats.xp += r.last.xpAwarded || 0; }).catch(() => {});
    draw();
  };
  const undo = async () => {
    if (!lastEv || Date.now() - lastShown > 14000 || busy) return;
    busy = true; const c = cards.find((x) => x.senseId === lastEv.senseId);
    await enqueue({ id: uuid(), senseId: lastEv.senseId, rating: 1, source: 'undo', reversesId: lastEv.id, clientAt: new Date().toISOString(), deviceId: deviceId() });
    if (lastEv.rating === 1) { const k = cards.lastIndexOf(c); if (k > idx) cards.splice(k, 1); }
    idx = Math.max(0, idx - 1); stats.done = Math.max(0, stats.done - 1); lastEv = null; flipped = false; busy = false; draw();
  };
  const flip = () => { if (flipped || idx >= cards.length) return; flipped = true; draw(); };

  const getHint = action(async (c) => { if (hints.has(c.senseId)) return; const r = await post('/ai/tutor-hint', { senseId: c.senseId }); hints.set(c.senseId, r.hint); draw(); });
  function draw() {
    if (idx >= cards.length) { finish(); return; }
    const c = cards[idx]; shownAt = shownAt && flipped ? shownAt : Date.now();
    const front = h('div', { class: 'flash-card', role: 'button', tabindex: 0, 'aria-label': t('review.flip'), onclick: flip, onkeydown: (e) => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') flip(); } },
      h('span', { class: 'badge brand' }, c.isNew ? t('review.new') : t('review.due')),
      h('div', { class: 'lemma', lang: 'en' }, c.lemma), c.ipa && h('div', { class: 'ipa' }, c.ipa), h('div', { class: 'muted small' }, c.pos, c.cefr ? ` · ${c.cefr}` : ''),
      h('button', { class: 'btn ghost small', onclick: (e) => { e.stopPropagation(); speak(c.lemma); }, 'aria-label': t('review.listen') }, '🔊 ', t('review.listen')),
      flipped ? [h('hr'), h('div', { class: 'def' }, getLocale() === 'vi' ? c.definitionVi : c.definitionEn), getLocale() === 'vi' && c.definitionEn && h('div', { class: 'muted small', lang: 'en' }, c.definitionEn),
        c.exampleEn && h('div', { class: 'ex', lang: 'en' }, c.exampleEn), c.exampleVi && getLocale() === 'vi' && h('div', { class: 'muted small' }, c.exampleVi)]
        : [h('div', { class: 'muted small' }, t('review.tapToFlip')),
          session.me?.flags?.['ai.gateway'] && navigator.onLine !== false && h('button', { class: 'btn ghost small', type: 'button', onclick: (e) => { e.stopPropagation(); getHint(c); } }, '💡 ', t('ai.hint')),
          hints.has(c.senseId) && h('p', { class: 'muted small', role: 'status', 'aria-label': t('ai.hintTitle') }, hints.get(c.senseId))]);
    const pv = c.preview || {};
    const labels = [['r1', t('review.again')], ['r2', t('review.hard')], ['r3', t('review.good')], ['r4', t('review.easy')]];
    mount(box, h('div', { class: 'row between' }, h('h1', {}, t('review.title')), h('span', { class: 'muted', 'aria-live': 'polite' }, t('review.progress', { a: Math.min(idx + 1, cards.length), b: cards.length }))),
      h('div', { class: 'flash' }, front),
      flipped ? h('div', { class: 'rate', role: 'group', 'aria-label': t('review.rateGroup') }, labels.map(([cls, lab], i) => h('button', { class: ['btn', cls], onclick: () => rate(i + 1), 'aria-keyshortcuts': String(i + 1) }, lab, h('small', {}, pv[i + 1] ? fmtInterval(pv[i + 1]) : '', ` [${i + 1}]`))))
        : h('div', { class: 'center' }, h('button', { class: 'btn', onclick: flip }, t('review.show'), ' [Space]')),
      h('div', { class: 'center' }, h('button', { class: 'btn ghost small', onclick: undo, disabled: !lastEv }, '↶ ', t('review.undo'), ' [Z]')),
      h('p', { class: 'muted small center' }, t('review.keys')));
    box.querySelector(flipped ? '.rate .r3' : '.center .btn')?.focus({ preventScroll: true });
  }
  keyHandler = (e) => {
    if (!document.body.contains(box)) { document.removeEventListener('keydown', keyHandler); return; }
    // P-04: bỏ qua phím khi đang gõ tổ hợp IME (Telex/VNI) — isComposing hoặc keyCode 229.
    if (e.isComposing || e.keyCode === 229 || e.target.matches('input,textarea,select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); flip(); } else if (['1', '2', '3', '4'].includes(e.key)) rate(+e.key); else if (e.key.toLowerCase() === 'z') undo();
  };
  document.addEventListener('keydown', keyHandler);
  if (!cards.length) { await finish(); return box; }
  draw();
  return box;
}
