import { h, mount, uuid } from '../dom.js';
import { t, getLocale } from '../i18n.js';
import { get } from '../api.js';
import { enqueue, flush } from '../offline.js';
import { mascot } from '../mascot.js';
import { empty } from '../ui.js';

const shuffle = (a) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const def = (s) => (getLocale() === 'vi' ? s.definitionVi : s.definitionEn);
const dev = () => { try { return localStorage.getItem('deviceId') || 'dev'; } catch { return 'dev'; } };

/** Game chọn nghĩa: sự kiện gửi với source='game' (không đổi lịch FSRS, XP có trần/ngày do máy chủ quyết định). */
export async function games() {
  const pool = await get('/me/games/pool?size=8');
  if (pool.items.length < 4) return h('div', {}, h('h1', {}, t('games.title')), empty(t('games.need')));
  const box = h('div', {});
  let i = 0, score = 0; const items = shuffle(pool.items);
  const asked = new Set();
  function next() {
    if (i >= items.length) {
      flush().catch(() => {});
      return mount(box, h('div', { class: 'card center' }, mascot(score >= items.length * 0.7 ? 'cheer' : 'happy', { size: 130 }), h('h2', {}, t('games.result', { a: score, b: items.length })), h('p', { class: 'muted' }, t('games.noSrs')), h('a', { class: 'btn', href: '#/games', onclick: (e) => { e.preventDefault(); location.reload(); } }, t('games.again'))));
    }
    const q = items[i];
    const wrong = shuffle([...items.filter((x) => x.senseId !== q.senseId).map(def), ...pool.distractors.map((d) => d.definition_vi)].filter((x) => x && x !== def(q))).slice(0, 3);
    const opts = shuffle([def(q), ...wrong]);
    const fb = h('div', { role: 'status', 'aria-live': 'polite' });
    const btns = opts.map((o) => h('button', { class: 'opt', onclick: async () => {
      if (asked.has(i)) return; asked.add(i);
      const ok = o === def(q); if (ok) score += 1;
      btns.forEach((b) => { b.disabled = true; if (b.textContent === def(q)) b.classList.add('good'); else if (b === btns.find((x) => x.textContent === o)) b.classList.add('wrong'); });
      await enqueue({ id: uuid(), senseId: q.senseId, rating: ok ? 3 : 1, clientAt: new Date().toISOString(), source: 'game', deviceId: dev() });
      mount(fb, h('p', {}, ok ? t('games.right') : t('games.wrong')), h('button', { class: 'btn', onclick: () => { i += 1; next(); } }, t('common.continue')));
      fb.querySelector('button').focus();
    } }, o));
    mount(box, h('div', { class: 'card' }, h('div', { class: 'row between' }, h('span', { class: 'muted' }, `${i + 1}/${items.length}`), h('span', { class: 'badge' }, t('games.score', { n: score }))),
      h('h2', { lang: 'en', class: 'center' }, q.lemma), h('p', { class: 'center muted' }, q.ipa), h('div', {}, btns), fb));
  }
  next();
  return h('div', {}, h('h1', {}, t('games.title')), box);
}
