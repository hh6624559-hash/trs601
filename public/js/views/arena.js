import { h, mount } from '../dom.js';
import { t, errText } from '../i18n.js';
import { get, post, session, roleOf } from '../api.js';
import { action, toast, field, empty } from '../ui.js';
import { nav } from '../app.js';
import { Mascot, PaperCard, Stamp, CountdownThread, Sticker } from '../components.js';

const MODES = ['duel', 'blitz', 'spelling'];
const POLL_MS = 1000;

/** Sảnh: tạo trận, vào bằng mã, danh sách trận mở. Dưới 13 tuổi chỉ thấy trận lớp (máy chủ quyết định). */
export async function lobby() {
  const me = session.me.user;
  const isTeacher = roleOf() === 'teacher';
  const classes = isTeacher ? (await get('/teacher/classes')).classes : [];
  const cls = h('select', { id: 'am-class' }, classes.map((c) => h('option', { value: c.id }, c.name)));
  const { matches } = await get('/arena/lobby');
  const mode = h('select', { id: 'am-mode' }, MODES.map((m) => h('option', { value: m }, t('arena.mode.' + m))));
  const vis = h('select', { id: 'am-vis' }, ['private', 'friends', 'open_adults'].map((v) => h('option', { value: v }, t('arena.vis.' + v))));
  const strict = h('input', { id: 'am-strict', type: 'checkbox' });
  const code = h('input', { id: 'am-code', maxlength: 12, autocomplete: 'off', autocapitalize: 'characters' });
  const canCreate = me.ageBand !== 'u13' && !isTeacher;
  return h('div', {}, h('h1', {}, t('arena.title')), h('p', { class: 'muted' }, t('arena.intro')),
    me.ageBand === 'u13' && PaperCard({ form: 'note', id: 'u13' }, h('p', {}, t('arena.under13'))),
    canCreate && h('section', { class: 'pcard' }, h('h2', {}, t('arena.create')),
      h('form', { onsubmit: action(async (ev) => { ev.preventDefault(); const m = await post('/arena/matches', { mode: mode.value, visibility: vis.value, strictRoom: strict.checked }); if (m.code) toast(t('arena.codeShare', { code: m.code })); nav(`/arena/${m.id}`); }) },
        field('am-mode', t('arena.mode'), mode), field('am-vis', t('arena.visibility'), vis), h('label', { class: 'check' }, strict, t('arena.strict')), h('p', { class: 'muted small' }, t('arena.strictHint')), h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('arena.create'))))),
    isTeacher && h('section', { class: 'pcard' }, h('h2', {}, t('arena.classMatch')),
      h('form', { onsubmit: action(async (ev) => { ev.preventDefault(); const m = await post('/arena/matches', { mode: mode.value, visibility: 'class', classId: cls.value, strictRoom: strict.checked }); nav(`/arena/${m.id}`); }) },
        field('am-class', t('teacher.className'), cls), field('am-mode', t('arena.mode'), mode), h('label', { class: 'check' }, strict, t('arena.strict')), h('p', { class: 'muted small' }, t('arena.strictHint')), h('p', {}, h('button', { class: 'btn', type: 'submit', disabled: !classes.length }, t('arena.create'))))),
    canCreate && h('section', { class: 'pcard' }, h('h2', {}, t('arena.joinCode')),
      h('form', { class: 'row', onsubmit: action(async (ev) => { ev.preventDefault(); const m = await post('/arena/join', { code: code.value.trim().toUpperCase() }); nav(`/arena/${m.id}`); }) },
        code, h('button', { class: 'btn', type: 'submit' }, t('arena.joinCode')))),
    h('h2', {}, t('arena.lobby')),
    matches.length ? h('div', { class: 'grid c2' }, matches.map((m) => PaperCard({ form: 'sticker' }, h('h3', {}, t('arena.mode.' + m.mode)), h('p', { class: 'muted small' }, `${m.host} · ${m.players}/${m.maxPlayers} · ${t('arena.vis.' + m.visibility)}`),
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: action(async () => { await post(`/arena/matches/${m.id}/join`, {}); nav(`/arena/${m.id}`); }) }, t('arena.join')),
        h('button', { class: 'btn small ghost', onclick: action(async () => { await post(`/arena/matches/${m.id}/join`, { spectate: true }); nav(`/arena/${m.id}`); }) }, t('arena.spectate')))))) : empty(t('arena.none')));
}

/** Màn trận: client chỉ hiển thị trạng thái do server gửi; đếm ngược chỉ để hiển thị (offset ước lượng từ serverNow — P-13). */
export async function match({ params }) {
  const id = params.id;
  const box = h('div', {});
  let seq = 0, last = null, offset = 0, answeredRound = -1, stopped = false, timer, tick;
  const thread = CountdownThread();
  const text = h('input', { id: 'arena-text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('arena.typeWord') });
  const sendAnswer = async (body) => {
    if (answeredRound === last.roundIdx) return;
    answeredRound = last.roundIdx;
    try { await post(`/arena/matches/${id}/answer`, { round: last.roundIdx, ...body }); } catch (e) { answeredRound = -1; toast(errText(e), 'bad'); }
    await refresh();
  };
  const alive = () => !stopped && document.body.contains(box);
  async function refresh() {
    clearTimeout(timer);
    try {
      const v = await get(`/arena/matches/${id}?after=${seq}`);
      seq = v.seq; offset = Date.parse(v.serverNow) - Date.now(); last = v; draw(v);
    } catch (e) { if (e.code === 'NOT_FOUND') { stopped = true; nav('/arena', true); return; } }
    if (alive() && !['FINISHED', 'ABORTED'].includes(last?.state)) timer = setTimeout(refresh, POLL_MS);
  }
  const hidden = () => post(`/arena/matches/${id}/visibility`, { hidden: document.hidden }).catch(() => {});
  document.addEventListener('visibilitychange', hidden);
  function draw(v) {
    clearInterval(tick);
    const isHost = v.hostId === session.me.user.id, spectator = v.you?.role === 'spectator';
    const roster = h('ul', { class: 'pill-list' }, v.players.map((p) => h('li', { class: 'sticker ghost' }, p.name, ' ', p.role === 'spectator' ? '👁' : h('b', {}, p.score), p.state === 'disconnected' ? ` (${t('arena.disconnected')})` : '', p.tabHidden ? ' 💤' : '')));
    const head = h('div', { class: 'row between' }, h('h1', {}, t('arena.mode.' + v.mode)), h('button', { class: 'btn ghost small', onclick: action(async () => { await post(`/arena/matches/${id}/leave`, {}); stopped = true; nav('/arena'); }) }, t('arena.leave')));
    if (v.state === 'LOBBY' || v.state === 'READY_CHECK') {
      return mount(box, head, PaperCard({ form: 'note', id }, Mascot({ mood: 'suy_nghi', size: 90 }), h('p', {}, v.state === 'LOBBY' ? t('arena.waiting') : t('arena.readyCheck'))), v.strictRoom ? h('div', { class: 'banner', role: 'status' }, t('arena.strictNotice')) : null, roster,
        v.state === 'LOBBY' && isHostOrTeacher(v) && h('button', { class: 'btn big', onclick: action(async () => { await post(`/arena/matches/${id}/start`, {}); await refresh(); }) }, t('arena.start')),
        v.state === 'READY_CHECK' && !spectator && v.you?.state !== 'ready' && h('button', { class: 'btn big moss', onclick: action(async () => { await post(`/arena/matches/${id}/ready`, {}); await refresh(); }) }, t('arena.ready')),
        isHostOrTeacher(v) && h('p', {}, h('button', { class: 'btn ghost danger small', onclick: action(async () => { await post(`/arena/matches/${id}/cancel`, {}); }) }, t('arena.cancel'))));
    }
    if (v.state === 'ABORTED') return mount(box, head, PaperCard({ form: 'note', id }, Mascot({ mood: 'dong_vien', size: 90 }), h('p', {}, t('arena.aborted')), h('a', { class: 'btn', href: '#/arena' }, t('common.back'))));
    if (v.state === 'FINISHED') {
      const ranked = [...v.players].filter((p) => p.role === 'player').sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
      const mine = ranked.find((p) => p.userId === session.me.user.id);
      return mount(box, head, PaperCard({ form: 'scoreboard' }, Mascot({ mood: mine?.rank === 1 ? 'an_mung' : 'vui', size: 110 }), h('h2', {}, t('arena.finished')), mine && Stamp(t('arena.rank', { n: mine.rank })),
        h('ol', { class: 'scoremargin' }, ranked.map((p) => h('li', {}, `${p.name} — ${t('arena.points', { n: p.score })}`))), h('p', { class: 'muted small' }, t('arena.practiceOnly'))), h('a', { class: 'btn', href: '#/arena' }, t('common.back')));
    }
    // ROUND_OPEN / ROUND_REVEAL
    const q = v.question, rv = v.reveal, mineAns = rv?.answers.find((a) => a.userId === session.me.user.id);
    const body = [];
    if (q.kind === 'mcq') {
      body.push(h('h2', { lang: 'en', class: 'center' }, q.prompt.lemma), h('p', { class: 'center muted' }, q.prompt.ipa || ''));
      q.prompt.options.forEach((o, i) => body.push(h('button', { class: ['opt', rv && i === rv.correctIndex && 'good', rv && mineAns?.answer.choice === i && i !== rv.correctIndex && 'wrong', mineAns === undefined && answeredRound === v.roundIdx && 'sel'], disabled: !!rv || spectator || answeredRound === v.roundIdx, onclick: () => sendAnswer({ choice: i }) }, h('span', { class: 'k' }, String.fromCharCode(65 + i)), o)));
    } else {
      body.push(h('h2', { class: 'center' }, q.prompt.definitionVi), h('p', { class: 'center muted' }, t('arena.hintLen', { n: q.prompt.length, c: q.prompt.firstLetter })));
      if (!spectator && !rv) body.push(h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); if (text.value.trim()) sendAnswer({ text: text.value }); } }, text, h('button', { class: 'btn', type: 'submit', disabled: answeredRound === v.roundIdx }, t('arena.send'))));
      if (rv) body.push(h('p', { class: 'center' }, t('arena.answerIs', { x: rv.answer })));
    }
    if (rv) body.push(h('p', { class: 'center' }, mineAns ? (mineAns.correct ? Stamp(t('arena.correct')) : Stamp(t('arena.wrong'), true)) : ''));
    mount(box, head, h('div', { class: 'board' }, v.micLocked ? h('p', { class: 'small', role: 'status' }, '🔇 ', t('arena.strictNotice')) : null, h('div', { class: 'row between' }, h('span', {}, t('arena.round', { a: v.roundIdx + 1, b: v.rounds })), answeredRound === v.roundIdx && !rv ? h('span', {}, t('arena.answered')) : ''), thread, ...body), spectator && h('p', { class: 'muted' }, t('arena.spectator')), roster);
    if (!rv) { const end = Date.parse(v.closesAt), total = v.limitMs; tick = setInterval(() => { if (!alive()) return clearInterval(tick); thread.set((end - (Date.now() + offset)) / total); }, 200); }
  }
  const isHostOrTeacher = (v) => v.hostId === session.me.user.id || roleOf() === 'teacher';
  refresh();
  const wrap = h('div', {}, box);
  new MutationObserver((_, o) => { if (!document.body.contains(wrap)) { stopped = true; clearTimeout(timer); clearInterval(tick); document.removeEventListener('visibilitychange', hidden); o.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
  return wrap;
}
