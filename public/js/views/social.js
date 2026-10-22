import { h, mount } from '../dom.js';
import { t, getLocale } from '../i18n.js';
import { get, post, session } from '../api.js';
import { action, toast, field, empty, confirmBox } from '../ui.js';
import { render, nav } from '../app.js';

export async function friends() {
  const [prof, fr, ch] = await Promise.all([get('/social/profile'), (session.me.user.ageBand === 'u13' ? Promise.resolve(null) : get('/social/friends')).catch((e) => (e.code === 'CONSENT_REQUIRED' || e.status === 403 ? null : Promise.reject(e))), get('/social/channels').catch(() => ({ channels: [], presets: [] }))]);
  const code = h('input', { id: 'fr-code', maxlength: 12, autocapitalize: 'characters', autocomplete: 'off' });
  const dm = (id) => ch.channels.find((c) => c.kind === 'dm' && c.withUserId === id);
  const card = (f, btns) => h('div', { class: 'card row between' }, h('span', {}, h('b', {}, f.displayName), f.streak != null && ` 🔥${f.streak}`), h('span', { class: 'row' }, btns));
  return h('div', {}, h('h1', {}, t('social.title')),
    h('div', { class: 'card' }, h('p', {}, t('social.myCode'), ': ', h('b', { class: 'stat' }, prof.friendCode)), h('p', { class: 'muted small' }, t('social.codeHint'))),
    ch.channels.filter((c) => c.kind === 'class').length ? h('section', { class: 'card' }, h('h2', {}, t('social.classChat')), ch.channels.filter((c) => c.kind === 'class').map((c) => h('a', { class: 'btn ghost', href: `#/chat/${c.id}` }, '💬 ', c.title))) : null,
    session.me.user.ageBand === 'u13' ? h('div', { class: 'banner ok' }, t('social.kidMode')) : !fr ? h('div', { class: 'banner' }, t('social.needConsent')) : [
      h('form', { class: 'card', onsubmit: action(async (ev) => { ev.preventDefault(); await post('/social/friend-requests', { code: code.value.trim() }); toast(t('social.sent')); code.value = ''; render(); }) }, field('fr-code', t('social.addByCode'), code), h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('social.send')))),
      fr.incoming.length ? h('section', {}, h('h2', {}, t('social.incoming')), fr.incoming.map((f) => card(f, [h('button', { class: 'btn moss small', onclick: action(async () => { await post(`/social/friend-requests/${f.id}/respond`, { accept: true }); render(); }) }, t('social.accept')), h('button', { class: 'btn ghost small', onclick: action(async () => { await post(`/social/friend-requests/${f.id}/respond`, { accept: false }); render(); }) }, t('social.decline'))]))) : null,
      h('section', {}, h('h2', {}, t('social.friends')), fr.friends.length ? fr.friends.map((f) => card(f, [dm(f.id) && h('a', { class: 'btn small', href: `#/chat/${dm(f.id).id}` }, t('social.chat')),
        h('button', { class: 'btn ghost small', onclick: action(async () => { if (await confirmBox(t('social.blockConfirm', { name: f.displayName }), { danger: true })) { await post('/social/blocks', { userId: f.id }); render(); } }) }, t('social.block'))])) : empty(t('social.noFriends'))),
      fr.outgoing.length ? h('p', { class: 'muted' }, t('social.pending', { n: fr.outgoing.length })) : null]);
}

export async function chat({ params }) {
  const [{ messages }, { presets, channels }] = await Promise.all([get(`/social/channels/${params.id}/messages`), get('/social/channels')]);
  const ch = channels.find((c) => c.id === params.id);
  const me = session.me.user, minor = me.ageBand !== '18p';
  const lang = getLocale();
  const log = h('div', { class: 'chat', role: 'log', 'aria-live': 'polite' }, messages.map((m) => h('div', { class: ['msg', m.senderId === me.id && 'me'] }, h('div', { class: 'muted small' }, m.senderName), m.kind === 'preset' ? (presets.find((p) => p.key === m.presetKey)?.[lang] || m.body) : m.body,
    m.senderId !== me.id && h('button', { class: 'btn ghost small', 'aria-label': t('social.report'), onclick: action(async () => { if (await confirmBox(t('social.reportConfirm'))) { await post('/social/reports', { targetType: 'message', targetId: m.id, reason: 'inappropriate' }); toast(t('social.reported')); } }) }, '⚑'))));
  const send = async (body) => { await post(`/social/channels/${params.id}/messages`, body); render(); };
  const text = h('input', { id: 'ch-t', maxlength: 1000, autocomplete: 'off', 'aria-label': t('social.message') });
  const canFree = !minor || (session.me.flags['social.free_text_teen'] && me.ageBand === '13_17');
  setTimeout(() => { log.scrollTop = log.scrollHeight; }, 0);
  return h('div', {}, h('p', {}, h('a', { href: '#/friends' }, '← ', t('social.title'))), h('h1', {}, ch?.title || t('social.chat')), h('div', { class: 'card' }, log),
    h('div', { class: 'card' }, h('p', { class: 'muted small' }, t('social.presetHint')), h('div', { class: 'row' }, presets.map((p) => h('button', { class: 'btn ghost', onclick: action(() => send({ presetKey: p.key })) }, p[lang]))),
      canFree && h('form', { class: 'row', onsubmit: action(async (ev) => { ev.preventDefault(); if (text.value.trim()) await send({ text: text.value }); }) }, text, h('button', { class: 'btn', type: 'submit' }, t('social.send')))));
}
