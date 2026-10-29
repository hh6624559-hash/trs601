import { watchJob, questionList, pingPanel } from '../aijob.js';
import { h, mount, fmtDate } from '../dom.js';
import { t, getLocale } from '../i18n.js';
import { get, post, put, patch, del, session } from '../api.js';
import { action, toast, field, empty, confirmBox } from '../ui.js';
import { render, nav } from '../app.js';

const dt = (iso) => fmtDate(iso, getLocale());

export async function classes() {
  const { classes } = await get('/teacher/classes');
  const name = h('input', { id: 'tc-n', required: true, maxlength: 80 });
  return h('div', {}, h('h1', {}, t('teacher.classes')),
    classes.length ? h('div', { class: 'grid c2' }, classes.map((c) => h('a', { class: 'card', href: `#/t/class/${c.id}` }, h('h3', {}, c.name), h('div', { class: 'muted small' }, t('teacher.students', { n: c.students }), ' · ', t('teacher.joinCode'), ': ', h('b', {}, c.joinCode))))) : empty(t('teacher.noClasses')),
    h('form', { class: 'card', onsubmit: action(async (ev) => { ev.preventDefault(); const c = await post('/teacher/classes', { name: name.value }); nav(`/t/class/${c.id}`); }) }, h('h2', {}, t('teacher.newClass')), field('tc-n', t('teacher.className'), name), h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('common.create')))));
}

const HINT = { not_started: 'hint.not_started', inactive: 'hint.inactive', many_leeches: 'hint.many_leeches', streak_broken: 'hint.streak_broken', struggling: 'hint.struggling' };

export async function classDetail({ params }) {
  const id = params.id;
  const [c, asg, asm, ses] = await Promise.all([get(`/teacher/classes/${id}`), get(`/teacher/classes/${id}/assignments`), get(`/teacher/classes/${id}/assessments`), get(`/teacher/classes/${id}/sessions`)]);
  const learners = c.roster.filter((r) => r.role === 'learner');
  // thêm học viên
  const list = h('textarea', { id: 'st-l', placeholder: t('teacher.addPh'), rows: 4 });
  const att = h('input', { id: 'st-a', type: 'checkbox' });
  const creds = h('div', {});
  const addForm = h('form', { class: 'card', onsubmit: action(async (ev) => {
    ev.preventDefault();
    const students = list.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [displayName, birthYm] = l.split(/[,;\t]/).map((x) => x.trim()); return { displayName, birthYm }; });
    const r = await post(`/teacher/classes/${id}/students`, { students, attestation: att.checked });
    mount(creds, credsView(r)); list.value = ''; toast(t('teacher.created', { n: r.credentials.length }));
  }) }, h('h2', {}, t('teacher.addStudents')), field('st-l', t('teacher.addLabel'), list, t('teacher.addHint')),
  h('label', { class: 'check', for: 'st-a' }, att, h('span', {}, t('teacher.attest'))), h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('common.add'))), creds);
  // giao từ
  const at = h('input', { id: 'as-t', required: true, maxlength: 80 }), ac = h('textarea', { id: 'as-c', placeholder: t('teacher.wordsPh') }), ad = h('input', { id: 'as-d', type: 'datetime-local' });
  const assignForm = h('form', { class: 'card', onsubmit: action(async (ev) => {
    ev.preventDefault(); const body = { title: at.value, csv: ac.value }; if (ad.value) body.dueAt = new Date(ad.value).toISOString();
    const r = await post(`/teacher/classes/${id}/assignments`, body); toast(t('teacher.assigned', { n: r.recipients ?? learners.length })); render();
  }) }, h('h2', {}, t('teacher.assignWords')), field('as-t', t('col.name'), at), field('as-c', t('teacher.words'), ac), field('as-d', t('quiz.due'), ad), h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('teacher.assign'))));
  // đề thi
  const n = (idn, v, max = 100) => h('input', { id: idn, type: 'number', min: 0, max, value: v });
  const bt = h('input', { id: 'ex-t', required: true, maxlength: 80 }), b1 = n('ex-m', 5), b2 = n('ex-f', 0), b3 = n('ex-x', 0), bd = n('ex-d', 20, 300);
  const examForm = h('form', { class: 'card', onsubmit: action(async (ev) => {
    ev.preventDefault(); const types = { mcq_single: +b1.value, fill_blank: +b2.value, matching: +b3.value }; const total = types.mcq_single + types.fill_blank + types.matching;
    const a = await post(`/teacher/classes/${id}/assessments`, { title: bt.value, blueprint: { total, durationMin: +bd.value, types }, maxAttempts: 1, showAnswers: true });
    nav(`/t/assessment/${a.id}`);
  }) }, h('h2', {}, t('teacher.newExam')), field('ex-t', t('col.name'), bt), h('div', { class: 'grid c3' }, field('ex-m', t('q.type.mcq_single'), b1), field('ex-f', t('q.type.fill_blank'), b2), field('ex-x', t('q.type.matching'), b3)), field('ex-d', t('quiz.minutesLabel'), bd), h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('teacher.compose'))));
  // buổi học
  const st = h('input', { id: 'se-t', required: true, maxlength: 80 }), ss = h('input', { id: 'se-s', type: 'datetime-local', required: true }), su = h('input', { id: 'se-u', type: 'url', placeholder: 'https://' });
  const sesForm = h('form', { class: 'card', onsubmit: action(async (ev) => { ev.preventDefault(); await post(`/teacher/classes/${id}/sessions`, { title: st.value, startsAt: new Date(ss.value).toISOString(), durationMin: 45, ...(su.value ? { roomUrl: su.value } : {}) }); render(); }) },
    h('h2', {}, t('teacher.newSession')), field('se-t', t('col.name'), st), field('se-s', t('teacher.startsAt'), ss), field('se-u', t('teacher.roomUrl'), su, t('teacher.roomHint')), h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('common.create'))));

  return h('div', {}, h('p', {}, h('a', { href: '#/t' }, '← ', t('teacher.classes'))), h('h1', {}, c.name), h('p', {}, t('teacher.joinCode'), ': ', h('b', {}, c.joinCode)),
    h('section', { class: 'card' }, h('h2', {}, t('teacher.roster')), learners.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['teacher.name', 'teacher.username', 'teacher.started', 'teacher.mastered', 'teacher.streak', 'teacher.last', 'teacher.care', ''].map((k) => h('th', {}, k && t(k))))),
      h('tbody', {}, learners.map((r) => h('tr', {}, h('td', {}, r.displayName, r.ageBand !== '18p' && h('span', { class: 'badge brand' }, ' ', t('age.' + r.ageBand))), h('td', {}, r.username), h('td', {}, r.started), h('td', {}, r.mastered), h('td', {}, r.streak), h('td', {}, r.lastActive ? dt(r.lastActive) : '—'),
        h('td', {}, (r.hints || []).map((x) => h('span', { class: 'badge warn' }, t(HINT[x.key] || 'hint.other', x)))),
        h('td', {}, h('button', { class: 'btn ghost small', onclick: action(async () => { const p = await post(`/teacher/classes/${id}/students/${r.id}/reset-pin`, {}); mount(creds, credsView({ classCode: c.joinCode, credentials: [{ username: r.username, pin: p.pin, displayName: r.displayName }] })); window.scrollTo(0, document.body.scrollHeight); }) }, t('teacher.resetPin')),
          h('button', { class: 'btn ghost small', onclick: action(async () => { const g = await post(`/teacher/classes/${id}/students/${r.id}/guardian-invite`, {}); toast(`${t('teacher.guardianCode')}: ${g.code}`); }) }, t('teacher.guardianInvite')))))))) : empty(t('teacher.noStudents'))),
    h('section', { class: 'card' }, h('h2', {}, t('teacher.assignments')), asg.assignments.length ? h('ul', {}, asg.assignments.map((a) => h('li', {}, h('b', {}, a.title), ' · ', a.dueAt ? dt(a.dueAt) : t('teacher.noDue'), ` · ${a.recipients ?? ''}`))) : empty(t('teacher.noAssignments'))),
    h('section', { class: 'card' }, h('h2', {}, t('teacher.exams')), asm.assessments.length ? asm.assessments.map((a) => h('div', { class: 'row between' }, h('a', { href: `#/t/assessment/${a.id}` }, a.title), h('span', { class: 'muted small' }, t('teacher.graded', { n: a.graded }), a.avgPct != null ? ` · ${a.avgPct}%` : ''))) : empty(t('teacher.noExams'))),
    h('section', { class: 'card' }, h('h2', {}, t('teacher.sessions')), ses.sessions.length ? ses.sessions.map((s) => h('div', { class: 'row between' }, h('span', {}, h('b', {}, s.title), ' · ', dt(s.startsAt ?? s.starts_at)), h('span', { class: 'badge' }, s.state))) : empty(t('teacher.noSessions'))),
    h('div', { class: 'grid c2' }, addForm, assignForm, examForm, sesForm));
}

function credsView(r) {
  return h('div', { class: 'banner', role: 'alert' }, h('p', {}, h('b', {}, t('teacher.pinsOnce'))), h('p', {}, t('auth.classCode'), ': ', h('b', {}, r.classCode)),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, t('teacher.name')), h('th', {}, t('auth.username')), h('th', {}, t('auth.pin')))), h('tbody', {}, r.credentials.map((x) => h('tr', {}, h('td', {}, x.displayName || ''), h('td', {}, x.username), h('td', {}, h('code', {}, x.pin)))))),
    h('button', { class: 'btn small', onclick: () => window.print() }, t('common.print')));
}

export async function questions() {
  const [{ questions }, aiSt] = await Promise.all([get('/teacher/questions'), get('/teacher/ai/status').catch(() => ({ flag: false, enabled: false, hasKey: false }))]);
  const type = h('select', { id: 'qn-t' }, ['mcq_single', 'fill_blank', 'matching'].map((x) => h('option', { value: x }, t('q.type.' + x))));
  const stem = h('input', { id: 'qn-s', required: true, maxlength: 400 });
  const opts = h('textarea', { id: 'qn-o', placeholder: t('q.optsPh') });
  const ans = h('input', { id: 'qn-a', required: true });
  const expl = h('input', { id: 'qn-e', maxlength: 600 });
  const hintTxt = h('p', { class: 'muted small' });
  const upd = () => mount(hintTxt, t('q.hint.' + type.value)); type.addEventListener('change', upd); upd();
  const build = () => {
    const lines = opts.value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (type.value === 'mcq_single') return { body: { stem: stem.value, options: lines }, answerKey: { correctIndex: Math.max(0, parseInt(ans.value, 10) - 1) } };
    if (type.value === 'fill_blank') return { body: { stem: stem.value }, answerKey: { accepted: ans.value.split('|').map((x) => x.trim()).filter(Boolean) } };
    const pairs = lines.map((l) => l.split('=').map((x) => x.trim())); return { body: { left: pairs.map((p) => p[0]), right: pairs.map((p) => p[1] || '') }, answerKey: {} };
  };
  const stBadge = { draft: '', in_review: 'warn', approved: 'brand', published: '', retired: 'bad' };
  const next = { draft: ['in_review'], in_review: ['approved', 'draft'], approved: ['published'], published: ['retired'], retired: [] };
  const row = (q) => h('tr', {}, h('td', {}, q.body.stem || (q.body.left || []).join(', '), q.type === 'mcq_single' && h('ol', { class: 'small muted' }, (q.body.options || []).map((o, i) => h('li', {}, o, i === q.answerKey?.correctIndex && ' ✓')))), h('td', {}, t('q.type.' + q.type), ` v${q.version}`, q.source === 'ai' && [' ', h('span', { class: 'badge warn' }, t('ai.badge'))]),
    h('td', {}, h('span', { class: ['badge', stBadge[q.status]] }, t('q.status.' + q.status))),
    h('td', {}, next[q.status].map((to) => h('button', { class: 'btn ghost small', onclick: action(async () => { await post(`/teacher/question-versions/${q.id}/transition`, { to }); render(); }) }, t('q.to.' + to)))));
  const aiReady = aiSt.flag && aiSt.enabled && aiSt.hasKey;
  const reqText = h('textarea', { id: 'qa-req', rows: 4, maxlength: 600, placeholder: t('qai.reqPh') });
  const reqCount = h('input', { id: 'qa-n', type: 'number', min: 1, max: 1000, value: 5, inputmode: 'numeric', style: 'width:6em' });
  const reqCefr = h('select', { id: 'qa-lv' }, h('option', { value: '' }, t('qai.anyLevel')), ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map((x) => h('option', { value: x }, x)));
  const aiStatus = h('div', { 'aria-live': 'polite' });
  const aiGen = action(async () => {
    if (reqText.value.trim().length < 5) { toast(t('qai.needReq'), 'bad'); reqText.focus(); return; }
    mount(aiStatus, h('p', { class: 'muted' }, t('qai.working')));
    const r = await post('/teacher/ai/question-requests', { request: reqText.value.trim(), count: Math.min(1000, Math.max(1, Math.round(+reqCount.value) || 5)), ...(reqCefr.value ? { cefr: reqCefr.value } : {}) });
    const toBank = (head) => head.append(h('p', {}, h('button', { class: 'btn small', type: 'button', onclick: () => render() }, t('ai.job.openBank'))));
    if (r.jobId) { watchJob({ base: '/teacher/ai/jobs', jobId: r.jobId, into: aiStatus, onDone: (j, head) => { toast(t('ai.draftDone', { n: j.ok, r: j.rejected })); toBank(head); if (!j.ok) head.append(h('p', { class: 'bad' }, t('ai.zeroHint'))); } }); return; }
    questionList(r.drafts, aiStatus);
    if (!r.drafts.length) aiStatus.append(h('p', { class: 'bad' }, t('ai.zeroHint')));
    aiStatus.prepend(h('p', { role: 'status' }, t('ai.draftDone', { n: r.drafts.length, r: r.rejected.length })));
    aiStatus.append(h('p', {}, h('button', { class: 'btn small', type: 'button', onclick: () => render() }, t('ai.job.openBank'))));
    toast(t('ai.draftDone', { n: r.drafts.length, r: r.rejected.length }));
  });
  const aiPanel = h('section', { class: 'card stack' }, h('h2', {}, t('qai.title'), ' ', h('span', { class: 'badge warn' }, t('ai.badge'))), h('p', { class: 'muted small' }, t('qai.help')),
    !aiReady ? h('p', { class: 'bad' }, !aiSt.flag ? t('ai.flagOff') : t('ai.notReady'), ' ', h('a', { href: '#/t/ai' }, t('qai.openSettings'))) : null,
    field('qa-req', t('qai.request'), reqText), h('div', { class: 'row' }, field('qa-n', t('qai.count'), reqCount), field('qa-lv', t('qai.level'), reqCefr)),
    h('p', {}, h('button', { class: 'btn', type: 'button', disabled: !aiReady, onclick: aiGen }, t('qai.generate')), ' ', h('a', { class: 'btn ghost', href: '#/t/vocab' }, t('qai.fromWords'))), aiStatus, pingPanel());
  const manualForm = h('form', { class: 'card', onsubmit: action(async (ev) => { ev.preventDefault(); const b = build(); await post('/teacher/questions', { type: type.value, ...b, ...(expl.value ? { explanationVi: expl.value } : {}) }); toast(t('common.saved')); render(); }) },
    h('h2', {}, t('q.new')), field('qn-t', t('q.type'), type), hintTxt, field('qn-s', t('q.stem'), stem), field('qn-o', t('q.options'), opts), field('qn-a', t('q.answer'), ans), field('qn-e', t('q.explanation'), expl), h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('common.create'))));
  const modeKey = 'q-mode'; let mode0 = 'manual'; try { mode0 = sessionStorage.getItem(modeKey) || 'manual'; } catch { /* không có storage */ }
  const mkTab = (id, label) => h('button', { class: ['btn', mode0 === id ? '' : 'ghost'], type: 'button', role: 'tab', 'aria-selected': String(mode0 === id), onclick: () => { try { sessionStorage.setItem(modeKey, id); } catch { /* bỏ qua */ } render(); } }, label);
  const heads = ['q.stem', 'q.type', 'col.state', ''].map((k) => h('th', {}, k && t(k)));
  return h('div', {}, h('h1', {}, t('nav.questions')),
    h('div', { class: 'row', role: 'tablist', 'aria-label': t('qai.modeLabel') }, mkTab('manual', t('qai.modeManual')), mkTab('ai', t('qai.modeAi'))),
    mode0 === 'ai' ? aiPanel : manualForm,
    questions.length ? h('div', { class: 'card table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, heads)), h('tbody', {}, questions.map(row)))) : empty(t('q.none')));
}

export async function assessment({ params }) {
  const [r, an] = await Promise.all([get(`/teacher/assessments/${params.id}/results`), get(`/teacher/assessments/${params.id}/analysis`).catch(() => null)]);
  return h('div', {}, h('p', {}, h('a', { href: '#/t' }, '← ', t('teacher.classes'))), h('h1', {}, r.assessment.title),
    h('div', { class: 'card table-wrap' }, r.rows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['teacher.name', 'teacher.attempt', 'col.state', 'teacher.score', 'teacher.blur', ''].map((k) => h('th', {}, k && t(k))))),
      h('tbody', {}, r.rows.map((x) => h('tr', {}, h('td', {}, x.displayName), h('td', {}, x.attemptNo), h('td', {}, t('attempt.' + x.state)), h('td', {}, x.score != null ? `${x.score}/${x.maxScore ?? x.max_score}` : '—'), h('td', {}, x.tabBlur || 0),
        h('td', {}, x.state === 'GRADED' && h('button', { class: 'btn ghost small', onclick: action(async () => { if (await confirmBox(t('teacher.invalidateConfirm'), { danger: true })) { await post(`/teacher/attempts/${x.attemptId}/invalidate`, { reason: 'teacher' }); render(); } }) }, t('teacher.invalidate'))))))) : empty(t('teacher.noAttempts'))),
    an && h('section', { class: 'card' }, h('h2', {}, t('teacher.analysis')), h('p', { class: 'muted small' }, t('teacher.analysisHint')),
      h('ul', {}, (an.items || an.questions || []).map((i) => h('li', {}, `#${i.position + 1}: `, i.insufficientData ? t('teacher.needSample', { n: i.n, m: i.minSample }) : `p=${i.difficulty ?? i.p} · r=${i.discrimination ?? i.pointBiserial ?? '—'}`, (i.flags || []).map((f) => h('span', { class: 'badge warn' }, f)))))));
}

export async function hard() {
  const { reports } = await get('/teacher/hard-reports');
  return h('div', {}, h('h1', {}, t('nav.hard')), reports.length ? reports.map((x) => h('div', { class: 'card' }, h('b', {}, x.student), ' — ', x.title, x.note && h('p', { class: 'muted' }, x.note), h('div', { class: 'muted small' }, dt(x.createdAt)))) : empty(t('teacher.noHard')));
}
