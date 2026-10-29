import { h, mount } from '../dom.js';
import { t, setLocale, getLocale } from '../i18n.js';
import { get, post, patch, del, session, loadMe } from '../api.js';
import { action, toast, field, empty, confirmBox, modal } from '../ui.js';
import { render, nav } from '../app.js';
import { fmtDate } from '../dom.js';
import { clearAll } from '../offline.js';

export async function profile() {
  const me = session.me.user, role = session.me.tenants.find((x) => x.id === session.me.tenant.id)?.roles || [];
  const [ses, soc] = await Promise.all([get('/me/sessions'), role.includes('learner') ? get('/social/profile').catch(() => null) : null]);
  const name = h('input', { id: 'pf-n', value: me.displayName, maxlength: 40 });
  const goal = h('input', { id: 'pf-g', type: 'number', min: 1, max: 100, value: me.prefs.dailyGoal });
  const hint = h('select', { id: 'pf-h' }, ['after_flip', 'always', 'hidden'].map((x) => h('option', { value: x, selected: me.prefs.hintMode === x }, t('pref.hint.' + x))));
  const cb = (id, key, label) => { const i = h('input', { id, type: 'checkbox', checked: !!me.prefs[key] }); return [h('label', { class: 'check', for: id }, i, h('span', {}, label)), i]; };
  const [lEasy, iEasy] = cb('pf-e', 'readEasy', t('pref.readEasy')), [lLite, iLite] = cb('pf-l', 'lite', t('pref.lite')), [lMo, iMo] = cb('pf-m', 'reduceMotion', t('pref.reduceMotion'));
  const mfaBox = h('div', {});
  const drawMfa = () => mount(mfaBox, me.mfaEnabled
    ? [h('p', {}, '✅ ', t('mfa.on')), h('button', { class: 'btn ghost', onclick: action(async () => { const c = await modalCode(t('mfa.disable')); if (c) { await post('/me/mfa/disable', { code: c }); await loadMe(); render(); } }) }, t('mfa.disable'))]
    : h('button', { class: 'btn ghost', onclick: action(async () => { const s = await post('/me/mfa/setup', {}); const c = await modalCode(t('mfa.scan'), s.secret); if (c) { await post('/me/mfa/enable', { code: c }); toast(t('mfa.enabled')); await loadMe(); render(); } }) }, t('mfa.enable')));
  drawMfa();
  const bio = h('textarea', { id: 'pf-b', maxlength: 140 }, soc?.bio || '');
  return h('div', {}, h('h1', {}, t('profile.title')),
    h('form', { class: 'card', onsubmit: action(async (ev) => { ev.preventDefault();
      await patch('/me', { displayName: name.value, locale: getLocale(), prefs: { dailyGoal: +goal.value, hintMode: hint.value, readEasy: iEasy.checked, lite: iLite.checked, reduceMotion: iMo.checked } });
      if (soc) await patch('/social/profile', { bio: bio.value });
      document.documentElement.dataset.motion = iMo.checked ? 'reduce' : ''; await loadMe(); toast(t('common.saved')); render(); }) },
    h('h2', {}, t('profile.you')), field('pf-n', t('auth.displayName'), name), me.email && h('p', { class: 'muted' }, me.email, me.emailVerified ? '' : ` (${t('auth.unverified')})`),
    role.includes('learner') && [field('pf-g', t('pref.dailyGoal'), goal), field('pf-h', t('pref.hint'), hint), lEasy, lLite, lMo, soc && field('pf-b', t('profile.bio'), bio)],
    h('div', { class: 'row' }, h('label', { for: 'pf-lang', class: 'sr' }, t('profile.language')), h('select', { id: 'pf-lang', onchange: (e) => setLocale(e.target.value) }, ['vi', 'en'].map((l) => h('option', { value: l, selected: getLocale() === l }, l === 'vi' ? 'Tiếng Việt' : 'English'))) ),
    h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('common.save')))),
    me.email && h('section', { class: 'card' }, h('h2', {}, t('mfa.title')), h('p', { class: 'muted' }, t('mfa.hint')), mfaBox),
    h('section', { class: 'card' }, h('h2', {}, t('sessions.title')), h('ul', { class: 'stack' }, ses.sessions.map((s) => h('li', { class: 'row between' }, h('span', {}, s.device || '?', ' · ', fmtDate(s.lastSeenAt, getLocale()), s.current && h('span', { class: 'badge' }, t('sessions.current'))), !s.current && h('button', { class: 'btn ghost small', onclick: action(async () => { await del(`/me/sessions/${s.id}`); render(); }) }, t('sessions.revoke'))))),
      h('button', { class: 'btn ghost', onclick: action(async () => { await post('/auth/logout-all', {}); await clearAll(); session.me = null; nav('/login', true); render(); }) }, t('sessions.logoutAll'))),
    h('p', {}, h('a', { href: '#/privacy' }, t('privacy.title'))));
}
function modalCode(title, secret) {
  return modal(title, (close) => { const i = h('input', { id: 'mc', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code' });
    return h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); close(i.value); } }, secret && [h('p', {}, t('mfa.secretHint')), h('code', {}, secret)], field('mc', t('auth.totp'), i), h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, t('common.ok')), h('button', { class: 'btn ghost', type: 'button', onclick: () => close(null) }, t('common.cancel')))); });
}

export async function privacy() {
  const p = await get('/me/privacy');
  const exportBtn = h('button', { class: 'btn', onclick: action(async () => {
    const r = await post('/me/data-export', {});
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'trs6-du-lieu-cua-toi.json' }); document.body.append(a); a.click(); a.remove(); toast(t('privacy.exported'));
  }) }, t('privacy.export'));
  const open = p.requests.find((r) => r.kind === 'deletion' && ['RECEIVED', 'VERIFIED', 'IN_PROGRESS'].includes(r.state));
  return h('div', {}, h('h1', {}, t('privacy.title')), h('p', { class: 'muted' }, t('privacy.intro')),
    h('section', { class: 'card' }, h('h2', {}, t('privacy.inventory')), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['privacy.data', 'privacy.purpose', 'privacy.retention', 'privacy.who'].map((k) => h('th', {}, t(k))))),
      h('tbody', {}, p.inventory.map((i) => h('tr', {}, h('td', {}, i.data), h('td', {}, i.purpose), h('td', {}, i.retention), h('td', {}, i.who))))))),
    h('section', { class: 'card' }, h('h2', {}, t('privacy.consents')), p.consents.length ? h('ul', {}, p.consents.map((c) => h('li', {}, `${c.purpose}: ${c.state}`, ['social', 'weekly_report'].includes(c.purpose) && c.state === 'GRANTED' && h('button', { class: 'btn ghost small', onclick: action(async () => { await post('/me/consents/withdraw', { purpose: c.purpose }); render(); }) }, t('privacy.withdraw'))))) : empty(t('privacy.noConsents')),
      h('p', { class: 'muted small' }, t('privacy.ai'))),
    h('section', { class: 'card' }, h('h2', {}, t('privacy.yourData')), h('p', {}, t('privacy.counts', p.counts)), exportBtn),
    h('section', { class: 'card' }, h('h2', {}, t('privacy.delete')), h('p', {}, t('privacy.deleteHint')),
      open ? h('div', {}, h('p', { class: 'banner' }, t('privacy.pending', { d: fmtDate(open.dueAt || open.due_at, getLocale()) })), h('button', { class: 'btn ghost', onclick: action(async () => { await post(`/me/deletion-request/${open.id}/cancel`, {}); render(); }) }, t('privacy.cancelDelete')),
        h('button', { class: 'btn danger', onclick: action(async () => { if (await confirmBox(t('privacy.executeConfirm'), { danger: true })) { await post(`/me/deletion-request/${open.id}/execute`, {}); await clearAll(); session.me = null; nav('/login', true); render(); } }) }, t('privacy.executeNow')))
        : h('button', { class: 'btn danger', onclick: action(async () => { if (await confirmBox(t('privacy.deleteConfirm'), { danger: true })) { await post('/me/deletion-request', { confirm: true }); render(); } }) }, t('privacy.requestDelete'))));
}

export async function notifications() {
  const n = await get('/me/notifications');
  if (n.unread) post('/me/notifications/read', {}).catch(() => {});
  return h('div', {}, h('h1', {}, t('notif.title')), n.notifications.length ? n.notifications.map((x) => h('div', { class: ['card', !x.read_at && 'unread'] }, h('b', {}, t('notif.' + x.kind, x.params || {})), h('div', { class: 'muted small' }, fmtDate(x.created_at, getLocale())))) : empty(t('notif.none')));
}
