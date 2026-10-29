import { h, mount } from '../dom.js';
import { t, getLocale } from '../i18n.js';
import { get, post, put } from '../api.js';
import { action, toast, empty, field, bar, confirmBox } from '../ui.js';
import { render, nav } from '../app.js';
import { mascot } from '../mascot.js';
import { fmtDate as fd } from '../dom.js';

export async function mine() {
  const [a, q] = await Promise.all([get('/me/assignments'), get('/me/assessments')]);
  return h('div', {}, h('h1', {}, t('quiz.title')),
    h('h2', {}, t('quiz.assignedWords')), a.assignments.length ? h('div', { class: 'grid c2' }, a.assignments.map((x) => h('a', { class: 'card', href: `#/collections/${x.collectionId}` }, h('h3', {}, '🔒 ', x.title), h('div', { class: 'muted small' }, x.className, x.dueAt ? ` · ${t('quiz.due')} ${fd(x.dueAt, getLocale())}` : ''), bar(x.started, x.words), h('div', { class: 'small' }, `${x.started}/${x.words}`)))) : empty(t('quiz.noAssignments')),
    h('h2', {}, t('quiz.tests')), q.assessments.length ? q.assessments.map((x) => h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h3', {}, x.title), h('span', { class: ['badge', x.status !== 'open' && 'warn'] }, t('quiz.status.' + x.status))),
      h('div', { class: 'muted small' }, x.className || t('quiz.practice'), ' · ', t('quiz.minutes', { n: x.durationMin }), x.closesAt ? ` · ${t('quiz.closes')} ${fd(x.closesAt, getLocale())}` : ''),
      h('ul', {}, x.attempts.map((at) => h('li', {}, at.state === 'GRADED' ? h('a', { href: `#/attempt/${at.id}` }, t('quiz.attemptScore', { n: at.attemptNo, s: at.score, m: at.maxScore })) : h('a', { href: `#/attempt/${at.id}` }, t('quiz.attemptState', { n: at.attemptNo, s: t('attempt.' + at.state) }))))),
      x.status === 'open' && x.attempts.length < x.maxAttempts && h('button', { class: 'btn', onclick: action(async () => { const at = await post(`/assessments/${x.id}/attempts`, {}); nav(`/attempt/${at.id}`); }) }, x.attempts.some((z) => z.state === 'IN_PROGRESS') ? t('quiz.resume') : t('quiz.start')))) : empty(t('quiz.noTests')));
}

export async function practice({ query }) {
  const { collections } = await get('/me/collections');
  const sel = h('select', { id: 'pr-c' }, collections.map((c) => h('option', { value: c.id, selected: c.id === query.c }, c.title)));
  const cnt = h('input', { id: 'pr-n', type: 'number', min: 3, max: 30, value: 10 });
  return h('div', {}, h('h1', {}, t('quiz.practice')), h('p', { class: 'muted' }, t('quiz.practiceHint')),
    h('form', { class: 'card', onsubmit: action(async (ev) => { ev.preventDefault(); const r = await post('/me/practice/compose', { collectionId: sel.value, count: +cnt.value }); const at = await post(`/assessments/${r.assessmentId}/attempts`, {}); nav(`/attempt/${at.id}`); }) },
      field('pr-c', t('quiz.fromCollection'), sel), field('pr-n', t('quiz.count'), cnt), h('p', {}, h('button', { class: 'btn', type: 'submit', disabled: !collections.length }, t('quiz.start')))));
}

export async function attempt({ params }) {
  const a = await get(`/attempts/${params.id}`);
  if (a.state === 'IN_PROGRESS') return runner(a);
  return resultView(a);
}

function runner(a) {
  const skew = Date.parse(a.serverNow) - Date.now();            // đồng hồ máy chủ là nguồn sự thật; client chỉ hiển thị
  const deadline = Date.parse(a.deadlineAt);
  const ans = a.items.map((i) => i.answer);
  let pos = 0, timer;
  const box = h('div', {}), clock = h('span', { class: 'badge warn', role: 'timer' });
  const left = () => Math.max(0, deadline - (Date.now() + skew));
  const tick = () => { const s = Math.ceil(left() / 1000); mount(clock, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`); if (s <= 0) { clearInterval(timer); submit(true); } };
  const save = async (p, v) => { ans[p] = v; try { await put(`/attempts/${a.id}/answers/${p}`, { answer: v }); } catch (e) { if (e.status !== 0) throw e; toast(t('quiz.offlineSave'), 'bad'); } };
  const submit = async (auto) => { clearInterval(timer); try { await post(`/attempts/${a.id}/submit`, {}); } catch (e) { if (e.status === 0) { toast(t('error.NETWORK'), 'bad'); timer = setInterval(tick, 1000); return; } throw e; } nav(`/attempt/${a.id}`, true); render(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden && document.body.contains(box)) post(`/attempts/${a.id}/blur`, {}).catch(() => {}); });
  function draw() {
    const it = a.items[pos];
    const body = [h('h2', {}, it.type === 'matching' ? t('quiz.matchTitle') : it.stem)];
    if (it.type === 'mcq_single') body.push(h('div', { role: 'radiogroup', 'aria-label': it.stem }, it.options.map((o, i) => h('button', { class: ['opt', ans[pos] === i && 'sel'], role: 'radio', 'aria-checked': String(ans[pos] === i), onclick: async () => { await save(pos, i); draw(); } }, o))));
    else if (it.type === 'fill_blank') { const inp = h('input', { 'aria-label': it.stem, value: ans[pos] ?? '', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', onchange: () => save(pos, inp.value) }); body.push(it.hint && h('p', { class: 'muted' }, it.hint), inp); }
    else {
      const cur = Array.isArray(ans[pos]) ? ans[pos] : it.left.map(() => null);
      body.push(it.left.map((l, li) => h('div', { class: 'row' }, h('b', { class: 'grow' }, l), h('select', { 'aria-label': l, onchange: async (e) => { const v = [...cur]; v[li] = e.target.value === '' ? null : +e.target.value; await save(pos, v); } }, h('option', { value: '' }, '—'), it.right.map((r, ri) => h('option', { value: ri, selected: cur[li] === ri }, r))))));
    }
    mount(box, h('div', { class: 'card' }, h('div', { class: 'row between' }, h('span', { class: 'muted' }, t('quiz.q', { a: pos + 1, b: a.items.length })), clock), body,
      h('div', { class: 'row between' }, h('button', { class: 'btn ghost', disabled: pos === 0, onclick: () => { pos -= 1; draw(); } }, t('common.back')),
        pos < a.items.length - 1 ? h('button', { class: 'btn', onclick: () => { pos += 1; draw(); } }, t('common.next'))
          : h('button', { class: 'btn moss', onclick: action(async () => { const un = ans.filter((x) => x == null).length; if (!un || await confirmBox(t('quiz.unanswered', { n: un }))) await submit(); }) }, t('quiz.submit')))),
      h('div', { class: 'row' }, a.items.map((_, i) => h('button', { class: ['btn small', i === pos ? '' : 'ghost'], 'aria-label': t('quiz.goto', { n: i + 1 }), onclick: () => { pos = i; draw(); } }, ans[i] != null ? '●' : String(i + 1)))));
    tick();
  }
  draw(); timer = setInterval(tick, 1000);
  return h('div', {}, h('h1', {}, a.title), box);
}

function resultView(a) {
  const r = a.result;
  return h('div', {}, h('p', {}, h('a', { href: '#/assignments' }, '← ', t('quiz.title'))), h('h1', {}, a.title),
    h('div', { class: 'card center' }, mascot(r && r.percent >= 70 ? 'cheer' : r ? 'happy' : 'sleepy', { size: 120 }),
      r ? [h('div', { class: 'stat' }, `${r.score}/${r.maxScore}`), h('p', {}, `${r.percent}%`)] : h('p', {}, t('attempt.' + a.state))),
    (a.items || []).map((it, i) => h('div', { class: 'card' }, h('h3', {}, `${i + 1}. ${it.stem || t('quiz.matchTitle')}`),
      it.type === 'mcq_single' ? it.options.map((o, oi) => h('div', { class: ['opt', oi === it.correctShownIndex && 'good', oi === it.answer && oi !== it.correctShownIndex && 'wrong'] }, o)) : null,
      it.type === 'fill_blank' ? [h('p', {}, t('quiz.yourAnswer'), ': ', h('b', {}, it.answer ?? '—')), h('p', { class: 'muted' }, t('quiz.accepted'), ': ', (it.accepted || []).join(' / '))] : null,
      (getLocale() === 'vi' ? it.explanationVi : it.explanationEn) && h('p', { class: 'muted' }, getLocale() === 'vi' ? it.explanationVi : it.explanationEn))));
}
