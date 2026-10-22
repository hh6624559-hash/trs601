import { h, mount, $ } from './dom.js';
import { t, errText } from './i18n.js';
import { post, session, setStepUpHandler } from './api.js';

let toastBox;
export function toast(msg, kind = '') {
  toastBox ||= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: ['toast', kind] }, msg);
  toastBox.append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 6000 : 3500);
}
export const toastErr = (e) => toast(errText(e), 'bad');

export function modal(title, bodyBuilder) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { 'aria-labelledby': 'dlg-t' });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(h('h2', { id: 'dlg-t' }, title), bodyBuilder(close));
    dlg.addEventListener('cancel', () => resolve(null));
    document.body.append(dlg); dlg.showModal();
    dlg.querySelector('input,button,select,textarea')?.focus();
  });
}
export const confirmBox = (msg, { danger } = {}) => modal(t('common.confirm'), (close) => h('div', { class: 'stack' }, h('p', {}, msg),
  h('div', { class: 'row' }, h('button', { class: ['btn', danger && 'danger'], onclick: () => close(true) }, t('common.yes')), h('button', { class: 'btn ghost', onclick: () => close(false) }, t('common.cancel')))));

export function promptBox(title, label, { type = 'text', pattern, hint } = {}) {
  return modal(title, (close) => {
    const input = h('input', { type, id: 'pb-i', autocomplete: 'off', pattern });
    return h('form', { class: 'stack', onsubmit: (ev) => { ev.preventDefault(); close(input.value); } },
      h('label', { for: 'pb-i' }, label), input, hint && h('p', { class: 'muted small' }, hint),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, t('common.ok')), h('button', { class: 'btn ghost', type: 'button', onclick: () => close(null) }, t('common.cancel'))));
  });
}

// step-up: hỏi lại mật khẩu (+ TOTP nếu bật) rồi gọi lại thao tác bị chặn
setStepUpHandler(async () => {
  const mfa = session.me?.user?.mfaEnabled;
  const res = await modal(t('stepup.title'), (close) => {
    const pw = h('input', { type: 'password', id: 'su-pw', autocomplete: 'current-password', required: true });
    const totp = mfa ? h('input', { id: 'su-totp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6 }) : null;
    const err = h('div', { class: 'field-err', role: 'alert' });
    return h('form', { class: 'stack', onsubmit: async (ev) => {
      ev.preventDefault();
      try { await post('/auth/step-up', { password: pw.value, ...(totp ? { totp: totp.value } : {}) }, { noRetryStepUp: true }); close(true); }
      catch (e) { mount(err, errText(e)); }
    } }, h('p', {}, t('stepup.why')), h('label', { for: 'su-pw' }, t('auth.password')), pw,
    totp && [h('label', { for: 'su-totp' }, t('auth.totp')), totp], err,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, t('common.ok')), h('button', { class: 'btn ghost', type: 'button', onclick: () => close(null) }, t('common.cancel'))));
  });
  if (!res) throw Object.assign(new Error('cancelled'), { code: 'STEP_UP_REQUIRED', status: 403, params: {}, details: [] });
});

export const spinner = () => h('div', { class: 'spinner', role: 'status', 'aria-label': t('common.loading') });
export const field = (id, label, input, hint) => h('div', {}, h('label', { for: id }, label), input, hint && h('div', { class: 'muted small' }, hint));
export const empty = (msg) => h('p', { class: 'muted center pad' }, msg); // thông điệp ngắn; trạng thái trống lớn dùng EmptyState (components.js)

/** Bao một nút: vô hiệu hóa khi đang chạy, hiện lỗi dạng toast. */
export function action(fn) {
  return async (ev) => {
    const b = ev.currentTarget; if (b.disabled) return;
    b.disabled = true;
    try { await fn(ev); } catch (e) { if (e?.message !== 'cancelled') toastErr(e); } finally { b.disabled = false; }
  };
}
export const bar = (v, max) => h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': v, 'aria-valuemax': max, 'aria-valuemin': 0 }, (() => { const i = h('i'); i.style.width = `${Math.min(100, max ? (v / max) * 100 : 0)}%`; return i; })());
export { $ };
