import { h, fmtDate } from '../dom.js';
import { t, getLocale } from '../i18n.js';
import { get, post, session } from '../api.js';
import { action, toast, empty, confirmBox } from '../ui.js';
import { render } from '../app.js';

const dt = (x) => fmtDate(x, getLocale());
const mfaWarn = () => (session.me.user.mfaEnabled ? null : h('div', { class: 'banner bad' }, t('admin.mfaRequired'), ' ', h('a', { href: '#/profile' }, t('mfa.enable'))));

export async function stats() {
  const [s, i] = await Promise.all([get('/admin/stats'), get('/admin/integrity')]);
  const keys = ['users', 'active7d', 'reviewEvents', 'attemptsGraded', 'reportsBacklog', 'reportsOverdue', 'outboxPending', 'pendingTeachers'];
  return h('div', {}, h('h1', {}, t('admin.stats')), mfaWarn(), s.baseline === 'BASELINE_PENDING' && h('p', { class: 'banner' }, t('admin.baselinePending')),
    h('div', { class: 'grid c3' }, keys.map((k) => h('div', { class: 'card' }, h('div', { class: 'stat' }, s[k]), h('div', {}, t('admin.k.' + k))))),
    h('section', { class: 'card' }, h('h2', {}, t('admin.integrity')), h('p', { class: 'muted small' }, t('admin.integrityHint'), ' ', dt(i.generatedAt)), i.findings.length ? h('ul', {}, i.findings.map((f) => h('li', {}, JSON.stringify(f)))) : h('p', { class: 'badge' }, '✔ ', t('admin.noFindings'))));
}

export async function teachers() {
  const { teachers } = await get('/admin/teachers');
  const dec = (id, decision) => action(async () => { await post(`/admin/teachers/${id}/decision`, { decision }); render(); });
  return h('div', {}, h('h1', {}, t('admin.teachers')), mfaWarn(), teachers.length ? h('div', { class: 'card table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['teacher.name', 'auth.email', 'col.state', ''].map((k) => h('th', {}, t(k))))),
    h('tbody', {}, teachers.map((x) => h('tr', {}, h('td', {}, x.displayName ?? x.display_name), h('td', {}, x.email), h('td', {}, h('span', { class: 'badge' }, x.state)), h('td', {}, h('button', { class: 'btn moss small', onclick: dec(x.userId ?? x.id, 'approve') }, t('admin.approve')), h('button', { class: 'btn ghost small', onclick: dec(x.userId ?? x.id, 'reject') }, t('admin.reject')), h('button', { class: 'btn danger small', onclick: dec(x.userId ?? x.id, 'suspend') }, t('admin.suspend')))))))) : empty(t('admin.noTeachers')));
}

export async function moderation() {
  const { reports, backlog } = await get('/admin/moderation/reports');
  const act = (id, a) => action(async () => { await post(`/admin/moderation/reports/${id}/action`, { action: a }); render(); });
  return h('div', {}, h('h1', {}, t('admin.moderation')), mfaWarn(), h('p', { class: 'muted' }, t('admin.backlog', { n: backlog })),
    reports.length ? reports.map((r) => h('div', { class: 'card' }, h('div', { class: 'row between' }, h('b', {}, t('report.reason.' + r.reason)), h('span', { class: ['badge', r.severity >= 2 && 'bad'] }, r.state)), h('p', { class: 'muted small' }, dt(r.createdAt ?? r.created_at), r.slaDueAt ? ` · SLA ${dt(r.slaDueAt)}` : ''),
      h('pre', { class: 'small' }, typeof r.evidence === 'string' ? r.evidence : JSON.stringify(r.evidence, null, 1)),
      h('div', { class: 'row' }, ['start_review', 'escalate', 'hide_message', 'warn', 'notify_guardian', 'dismiss', 'suspend_user'].map((a) => h('button', { class: ['btn small', a === 'suspend_user' ? 'danger' : 'ghost'], onclick: act(r.id, a) }, t('admin.act.' + a)))))) : empty(t('admin.noReports')));
}

export async function audit() {
  const [a, v] = await Promise.all([get('/admin/audit'), get('/admin/audit/verify')]);
  return h('div', {}, h('h1', {}, t('admin.audit')), mfaWarn(), h('p', { class: ['banner', v.ok === false || v.valid === false ? 'bad' : 'ok'] }, v.ok === false || v.valid === false ? t('admin.chainBroken') : t('admin.chainOk')),
    h('div', { class: 'card table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['#', 'admin.when', 'admin.action', 'admin.target'].map((k) => h('th', {}, k === '#' ? k : t(k))))), h('tbody', {}, a.entries.map((e) => h('tr', {}, h('td', {}, e.seq), h('td', {}, dt(e.createdAt)), h('td', {}, e.action), h('td', {}, `${e.targetType || ''} ${e.targetId ? e.targetId.slice(0, 8) : ''}`)))))));
}
