import { h, mount } from '../dom.js';
import { t, getLocale } from '../i18n.js';
import { get, post, patch, del, api } from '../api.js';
import { action, toast, field, empty, confirmBox, promptBox } from '../ui.js';
import { render, nav } from '../app.js';
import { speak } from './review.js';
import { Spine, EmptyState } from '../components.js';

const def = (s) => (getLocale() === 'vi' ? s.definitionVi : s.definitionEn);
const TOPICS = ['daily', 'school', 'academic', 'food', 'travel', 'hobbies', 'body', 'family', 'nature', 'work', 'feelings'];

export async function list() {
  const [{ collections }, topics] = await Promise.all([get('/me/collections'), get('/vocab/topics')]);
  const title = h('input', { id: 'nc-t', required: true, maxlength: 80 });
  const topic = h('select', { id: 'nc-topic' }, h('option', { value: '' }, t('col.empty')), topics.topics.map((x) => h('option', { value: x.topic }, `${t('topic.' + x.topic)} (${x.n})`)));
  const csv = h('textarea', { id: 'nc-csv', placeholder: t('col.csvHint') });
  return h('div', {}, h('h1', {}, t('col.title')),
    collections.length ? h('div', { class: 'shelf' }, collections.map((c) => Spine({ id: c.id, title: c.title, sub: t('col.words', { n: c.items }), href: `#/collections/${c.id}`, paused: c.status !== 'active', locked: c.locked }))) : EmptyState({ mood: 'dong_vien', text: t('empty.shelf') }),
    h('section', { class: 'card' }, h('h2', {}, t('col.new')), h('form', { onsubmit: action(async (ev) => {
      ev.preventDefault();
      const body = { title: title.value }; if (topic.value) { body.fromTopic = topic.value; body.limit = 20; } if (csv.value.trim()) body.csv = csv.value;
      const c = await post('/me/collections', body); toast(t('col.created', { n: c.items })); if (c.unknown?.length) toast(t('col.unknown', { n: c.unknown.length })); nav(`/collections/${c.id}`);
    }) }, field('nc-t', t('col.name'), title), field('nc-topic', t('col.fromTopic'), topic), field('nc-csv', t('col.csv'), csv), h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('common.create'))))),
    h('p', {}, h('a', { href: '#/paths' }, t('nav.paths'))));
}

export async function detail({ params }) {
  const c = await get(`/me/collections/${params.id}`);
  const etag = `"${c.version}"`;
  const q = h('input', { id: 'ci-q', type: 'search', placeholder: t('vocab.searchPh'), autocomplete: 'off' });
  const res = h('div', { class: 'stack' });
  let timer;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(async () => {
    if (q.value.trim().length < 2) return mount(res);
    const r = await get(`/vocab/search?q=${encodeURIComponent(q.value.trim())}`);
    mount(res, r.items.map((s) => h('div', { class: 'row between' }, h('span', {}, h('b', { lang: 'en' }, s.lemma), ' ', h('span', { class: 'muted small' }, s.pos, ' · ', def(s))), h('button', { class: 'btn small', onclick: action(async () => { await post(`/me/collections/${c.id}/items`, { senseIds: [s.senseId] }); toast(t('col.added')); render(); }) }, '+'))));
  }, 250); });
  const active = c.items.filter((i) => !i.removed), removed = c.items.filter((i) => i.removed);
  return h('div', {}, h('p', {}, h('a', { href: '#/collections' }, '← ', t('col.title'))), h('h1', {}, c.locked ? '🔒 ' : '', c.title),
    h('div', { class: 'row' }, h('span', { class: 'badge' }, t('col.words', { n: active.length })), c.locked && h('span', { class: 'badge brand' }, t('col.lockedHint')),
      h('a', { class: 'btn small', href: '#/practice?c=' + c.id }, t('col.practice')),
      !c.locked && h('button', { class: 'btn ghost small', onclick: action(async () => { const v = await promptBox(t('col.rename'), t('col.name')); if (v) { await patch(`/me/collections/${c.id}`, { title: v }, { headers: { 'If-Match': etag } }); render(); } }) }, t('col.rename')),
      !c.locked && h('button', { class: 'btn ghost small', onclick: action(async () => { await patch(`/me/collections/${c.id}`, { status: c.status === 'archived' ? 'active' : 'archived' }, { headers: { 'If-Match': etag } }); nav('/collections'); }) }, c.status === 'archived' ? t('col.restore') : t('col.archive')),
      c.locked && h('button', { class: 'btn ghost small', onclick: action(async () => { await post(`/me/collections/${c.id}/report-hard`, {}); toast(t('col.reported')); }) }, t('col.reportHard'))),
    !c.locked && h('section', { class: 'card' }, h('h2', {}, t('col.addWords')), field('ci-q', t('vocab.search'), q), res),
    h('div', { class: 'card table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['col.word', 'col.meaning', 'col.state', ''].map((k) => h('th', {}, k && t(k))))),
      h('tbody', {}, active.map((i) => h('tr', {}, h('td', {}, h('b', { lang: 'en' }, i.lemma), h('div', { class: 'muted small' }, i.ipa)), h('td', {}, def(i), i.exampleEn && h('div', { class: 'muted small', lang: 'en' }, i.exampleEn)),
        h('td', {}, h('span', { class: ['badge', i.leech && 'warn'] }, t('learnState.' + i.learnState))),
        h('td', {}, h('button', { class: 'btn ghost small', 'aria-label': t('review.listen'), onclick: () => speak(i.lemma) }, '🔊'), !c.locked && h('button', { class: 'btn ghost small', 'aria-label': t('common.remove'), onclick: action(async () => { await del(`/me/collections/${c.id}/items/${i.senseId}`); render(); }) }, '✕')))))),
    removed.length ? h('details', {}, h('summary', {}, t('col.removed', { n: removed.length })), removed.map((i) => h('div', { class: 'row' }, i.lemma, h('button', { class: 'btn ghost small', onclick: action(async () => { await post(`/me/collections/${c.id}/items/${i.senseId}/restore`, {}); render(); }) }, t('col.restore'))))) : null));
}

export async function search() {
  const q = h('input', { id: 'vs-q', type: 'search', autocomplete: 'off', placeholder: t('vocab.searchPh') });
  const res = h('div', { class: 'stack', 'aria-live': 'polite' });
  let timer;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(async () => {
    if (q.value.trim().length < 1) return mount(res);
    const r = await get(`/vocab/search?q=${encodeURIComponent(q.value.trim())}`).catch(() => ({ items: [] }));
    mount(res, r.items.length ? r.items.map((s) => h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h3', { lang: 'en' }, s.lemma, ' ', h('span', { class: 'muted small' }, s.ipa)), h('button', { class: 'btn ghost small', onclick: () => speak(s.lemma), 'aria-label': t('review.listen') }, '🔊')), h('div', { class: 'muted small' }, s.pos, ' · ', s.cefr), h('p', {}, def(s)), s.exampleEn && h('p', { class: 'muted', lang: 'en' }, s.exampleEn))) : [empty(t('vocab.none'))]);
  }, 200); });
  return h('div', {}, h('h1', {}, t('vocab.title')), field('vs-q', t('vocab.search'), q), res);
}

export async function paths() {
  const [{ paths }, { collections }] = await Promise.all([get('/me/paths'), get('/me/collections')]);
  const name = h('input', { id: 'pa-n', required: true, maxlength: 80 });
  const sel = h('select', { id: 'pa-c', multiple: true, size: Math.min(6, Math.max(3, collections.length)) }, collections.map((c) => h('option', { value: c.id }, c.title)));
  return h('div', {}, h('h1', {}, t('nav.paths')), paths.length ? h('div', { class: 'grid c2' }, paths.map((p) => h('div', { class: 'card' }, h('h3', {}, p.name), h('div', { class: 'muted small' }, p.goal || '')))) : empty(t('paths.none')),
    h('section', { class: 'card' }, h('h2', {}, t('paths.new')), h('form', { onsubmit: action(async (ev) => { ev.preventDefault(); const ids = [...sel.selectedOptions].map((o) => o.value); if (!ids.length) return toast(t('paths.pick'), 'bad'); await post('/me/paths', { name: name.value, collectionIds: ids }); render(); }) },
      field('pa-n', t('col.name'), name), field('pa-c', t('paths.pickLabel'), sel), h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('common.create'))))));
}
