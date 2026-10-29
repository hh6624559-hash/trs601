import { h, mount, fmtDate } from '../dom.js';
import { t, getLocale } from '../i18n.js';
import { get, post, patch, session } from '../api.js';
import { action, toast, field, empty, confirmBox } from '../ui.js';
import { render, nav } from '../app.js';

export async function children() {
  const { children } = await get('/guardian/children');
  const isFamily = session.me.tenant.kind === 'family';
  const n = h('input', { id: 'gc-n', required: true, maxlength: 40 }), b = h('input', { id: 'gc-b', type: 'month', required: true }), u = h('input', { id: 'gc-u', required: true, pattern: '[a-z0-9._\\-]{2,30}', autocapitalize: 'none' });
  const code = h('input', { id: 'gl-c', maxlength: 12, autocapitalize: 'characters' });
  const out = h('div', {});
  return h('div', {}, h('h1', {}, t('guardian.title')), h('p', { class: 'muted' }, t('guardian.intro')),
    children.length ? h('div', { class: 'grid c2' }, children.map((c) => h('a', { class: 'card', href: `#/g/child/${c.id}` }, h('h3', {}, c.displayName), h('div', { class: 'muted small' }, '@', c.username, ' · ', t('age.' + c.ageBand)), c.familyCode && h('div', { class: 'small' }, t('auth.classCode'), ': ', h('b', {}, c.familyCode))))) : empty(t('guardian.none')),
    isFamily && h('form', { class: 'card', onsubmit: action(async (ev) => { ev.preventDefault(); const r = await post('/guardian/children', { displayName: n.value, birthYm: b.value, username: u.value }); mount(out, h('div', { class: 'banner', role: 'alert' }, h('p', {}, h('b', {}, t('teacher.pinsOnce'))), h('p', {}, t('auth.classCode'), ': ', h('b', {}, r.familyCode), ' · ', t('auth.username'), ': ', h('b', {}, r.username), ' · ', t('auth.pin'), ': ', h('code', {}, r.pin)))); }) },
      h('h2', {}, t('guardian.addChild')), field('gc-n', t('auth.displayName'), n), field('gc-b', t('auth.birthMonth'), b), field('gc-u', t('auth.username'), u), h('p', { class: 'muted small' }, t('guardian.consentNote')), h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('common.add'))), out),
    h('form', { class: 'card', onsubmit: action(async (ev) => { ev.preventDefault(); await post('/guardian/link', { code: code.value.trim() }); toast(t('guardian.linked')); const { loadMe } = await import('../api.js'); await loadMe(); render(); }) },
      h('h2', {}, t('guardian.linkTitle')), field('gl-c', t('guardian.inviteCode'), code), h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('guardian.link')))));
}

export async function child({ params }) {
  const id = params.id;
  const [s, st, log] = await Promise.all([get(`/guardian/children/${id}/summary`), get(`/guardian/children/${id}/settings`), get(`/guardian/children/${id}/access-log`)]);
  const toggle = (key, label) => { const i = h('input', { type: 'checkbox', id: 'gs-' + key, checked: !!st[key], onchange: action(async () => { await patch(`/guardian/children/${id}/settings`, { [key]: i.checked }); toast(t('common.saved')); }) }); return h('label', { class: 'check', for: 'gs-' + key }, i, h('span', {}, label)); };
  return h('div', {}, h('p', {}, h('a', { href: '#/g' }, '← ', t('guardian.title'))), h('h1', {}, s.child.displayName),
    h('div', { class: 'grid c3' }, Object.entries(s.totals).filter(([, v]) => typeof v === 'number').map(([k, v]) => h('div', { class: 'card' }, h('div', { class: 'stat' }, v), h('div', {}, t('gsum.' + k))))),
    h('div', { class: 'card table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, [h('th', {}, t('gsum.day')), h('th', {}, t('gsum.reviews')), h('th', {}, t('gsum.minutes'))])), h('tbody', {}, s.days.map((d) => h('tr', {}, h('td', {}, d.day), h('td', {}, d.reviews), h('td', {}, d.minutes)))))),
    h('p', { class: 'muted small' }, t('guardian.aggregateOnly')),
    h('section', { class: 'card' }, h('h2', {}, t('guardian.settings')), toggle('messaging', t('guardian.messaging')), toggle('social', t('guardian.social'))),
    h('section', { class: 'card' }, h('h2', {}, t('guardian.manage')), h('div', { class: 'row' },
      h('button', { class: 'btn ghost', onclick: action(async () => { const r = await post(`/guardian/children/${id}/reset-pin`, {}); toast(`${t('auth.pin')}: ${r.pin}`); }) }, t('teacher.resetPin')),
      h('a', { class: 'btn', href: `#/g/practice/${id}` }, t('pm.makeForChild')),
      h('button', { class: 'btn ghost', onclick: action(async () => { await post(`/guardian/children/${id}/consents/grant`, { purpose: 'ai_tutor' }); toast(t('common.saved')); }) }, t('guardian.grantAi')),
      h('button', { class: 'btn ghost', onclick: action(async () => { await post(`/guardian/children/${id}/consents/revoke`, { purpose: 'ai_tutor' }); toast(t('common.saved')); }) }, t('guardian.revokeAi')),
      h('button', { class: 'btn ghost', onclick: action(async () => { await post(`/guardian/children/${id}/consents/grant`, { purpose: 'social' }); toast(t('common.saved')); }) }, t('guardian.grantSocial')),
      h('button', { class: 'btn ghost', onclick: action(async () => { await post(`/guardian/children/${id}/consents/revoke`, { purpose: 'social' }); toast(t('common.saved')); }) }, t('guardian.revokeSocial')),
      h('button', { class: 'btn danger', onclick: action(async () => { if (await confirmBox(t('guardian.deleteConfirm'), { danger: true })) { await post(`/guardian/children/${id}/delete`, {}); nav('/g'); } }) }, t('guardian.delete')))),
    h('section', { class: 'card' }, h('h2', {}, t('guardian.accessLog')), h('p', { class: 'muted small' }, t('guardian.accessHint')),
      (log.entries || log.log || []).length ? h('ul', {}, (log.entries || log.log).map((x) => h('li', {}, fmtDate(x.createdAt || x.created_at, getLocale()), ' · ', x.viewerRole || x.viewer_role, ' · ', x.scope))) : empty(t('guardian.noAccess'))));
}
