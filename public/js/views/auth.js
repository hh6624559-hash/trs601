import { h, mount } from '../dom.js';
import { t, errText } from '../i18n.js';
import { post, loadMe, session } from '../api.js';
import { field, action, toast } from '../ui.js';
import { mascot } from '../mascot.js';
import { nav, render } from '../app.js';

const wrap = (title, ...kids) => h('div', { class: 'auth' }, h('div', { class: 'center' }, mascot('happy', { size: 110 }), h('h1', {}, title)), h('div', { class: 'card' }, ...kids), links());
const links = () => h('p', { class: 'center small' }, h('a', { href: '#/login' }, t('auth.loginLink')), ' · ', h('a', { href: '#/class-login' }, t('auth.classLoginLink')), ' · ', h('a', { href: '#/register' }, t('auth.registerLink')));
const errBox = () => h('div', { class: 'field-err', role: 'alert' });
const done = async () => { await loadMe(); nav('/', true); render(); };
const detailMsg = (e) => { const d = e.details?.find((x) => x.path); return d ? `${errText(e)} (${d.path}: ${t('vcode.' + String(d.code).replace(/\./g, '_')) })` : errText(e); };

export function login() {
  const email = h('input', { id: 'l-email', type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { id: 'l-pw', type: 'password', autocomplete: 'current-password', required: true });
  const totp = h('input', { id: 'l-totp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6 });
  const totpRow = h('div', { class: 'hidden' }, field('l-totp', t('auth.totp'), totp, t('auth.totpHint')));
  const err = errBox();
  return wrap(t('auth.loginTitle'), h('form', { onsubmit: async (ev) => {
    ev.preventDefault(); mount(err);
    try { await post('/auth/login', { email: email.value, password: pw.value, ...(totp.value ? { totp: totp.value } : {}) }); await done(); }
    catch (e) { if (e.code === 'MFA_REQUIRED') { totpRow.classList.remove('hidden'); totp.focus(); mount(err, t('auth.mfaNeeded')); } else mount(err, errText(e)); }
  } }, field('l-email', t('auth.email'), email), field('l-pw', t('auth.password'), pw), totpRow, err,
  h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('auth.login'))), h('p', { class: 'small' }, h('a', { href: '#/forgot' }, t('auth.forgot')))));
}

export function classLogin() {
  const code = h('input', { id: 'c-code', autocomplete: 'off', required: true, maxlength: 12, autocapitalize: 'characters' });
  const user = h('input', { id: 'c-user', autocomplete: 'username', required: true, autocapitalize: 'none' });
  const pin = h('input', { id: 'c-pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', required: true, maxlength: 8 });
  const err = errBox();
  return wrap(t('auth.classTitle'), h('form', { onsubmit: async (ev) => {
    ev.preventDefault(); mount(err);
    try { await post('/auth/login-class', { classCode: code.value.trim().toUpperCase(), username: user.value.trim().toLowerCase(), pin: pin.value }); await done(); }
    catch (e) { mount(err, errText(e)); }
  } }, h('p', { class: 'muted' }, t('auth.classHint')), field('c-code', t('auth.classCode'), code), field('c-user', t('auth.username'), user), field('c-pin', t('auth.pin'), pin), err,
  h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('auth.login')))));
}

export function register() {
  const role = h('select', { id: 'r-role' }, ['learner', 'teacher', 'guardian'].map((r) => h('option', { value: r }, t(`role.${r}`))));
  const name = h('input', { id: 'r-name', required: true, maxlength: 40, autocomplete: 'name' });
  const email = h('input', { id: 'r-email', type: 'email', required: true, autocomplete: 'email' });
  const pw = h('input', { id: 'r-pw', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  const birth = h('input', { id: 'r-birth', type: 'month', required: true, max: new Date().toISOString().slice(0, 7) });
  const org = h('input', { id: 'r-org', maxlength: 80 });
  const terms = h('input', { id: 'r-terms', type: 'checkbox', required: true });
  const orgRow = h('div', { class: 'hidden' }, field('r-org', t('auth.orgName'), org));
  role.addEventListener('change', () => orgRow.classList.toggle('hidden', role.value === 'learner'));
  const err = errBox();
  return wrap(t('auth.registerTitle'), h('form', { onsubmit: async (ev) => {
    ev.preventDefault(); mount(err);
    try {
      await post('/auth/register', { role: role.value, email: email.value, password: pw.value, displayName: name.value, birthYm: birth.value, acceptTerms: true, ...(role.value !== 'learner' && org.value ? { orgName: org.value } : {}) });
      toast(t('auth.registered')); await done();
    } catch (e) { mount(err, detailMsg(e)); }
  } }, h('p', { class: 'banner' }, t('auth.adultsOnly')), field('r-role', t('auth.role'), role), field('r-name', t('auth.displayName'), name), field('r-email', t('auth.email'), email),
  field('r-pw', t('auth.password'), pw, t('auth.passwordHint')), field('r-birth', t('auth.birthMonth'), birth, t('auth.birthHint')), orgRow,
  h('label', { class: 'check', for: 'r-terms' }, terms, h('span', {}, t('auth.acceptTerms'))), err,
  h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('auth.register')))));
}

export function forgot() {
  const email = h('input', { id: 'f-email', type: 'email', required: true });
  const out = h('div', { role: 'status' });
  return wrap(t('auth.forgotTitle'), h('form', { onsubmit: async (ev) => { ev.preventDefault(); try { await post('/auth/password-reset/request', { email: email.value }); mount(out, h('p', { class: 'banner ok' }, t('auth.resetSent'))); } catch (e) { mount(out, errText(e)); } } },
    field('f-email', t('auth.email'), email), out, h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('auth.sendReset')))));
}

export function reset({ query }) {
  const pw = h('input', { id: 'rs-pw', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  const err = errBox();
  return wrap(t('auth.resetTitle'), h('form', { onsubmit: async (ev) => { ev.preventDefault(); try { await post('/auth/password-reset/confirm', { token: query.token || '', password: pw.value }); toast(t('auth.resetDone')); nav('/login'); } catch (e) { mount(err, detailMsg(e)); } } },
    field('rs-pw', t('auth.newPassword'), pw, t('auth.passwordHint')), err, h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('common.ok')))));
}

export async function verify({ query }) {
  let ok = false;
  try { await post('/auth/verify-email', { token: query.token || '' }); ok = true; if (session.me) await loadMe(); } catch { ok = false; }
  return wrap(t('auth.verifyTitle'), h('p', { class: ['banner', ok ? 'ok' : 'bad'] }, ok ? t('auth.verifyOk') : t('auth.verifyFail')), h('a', { class: 'btn', href: '#/' }, t('common.continue')));
}
