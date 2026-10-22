import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { get, post, put, del, session } from '../api.js';
import { action, toast, field, empty } from '../ui.js';
import { render } from '../app.js';

const MAX_FILE = 300 * 1024;

// ---------- Nhập từ vựng ----------
export async function vocabImport() {
  const { lists } = await get('/teacher/vocab/lists');
  const name = h('input', { id: 'vi-name', maxlength: 80, required: true, placeholder: t('vocabImp.namePh') });
  const text = h('textarea', { id: 'vi-text', rows: 10, spellcheck: false, placeholder: t('vocabImp.textPh') });
  const att = h('input', { id: 'vi-att', type: 'checkbox' });
  const out = h('div', { 'aria-live': 'polite' });
  const file = h('input', { id: 'vi-file', type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain' });
  file.addEventListener('change', async () => {
    const f = file.files[0]; if (!f) return;
    if (f.size > MAX_FILE) { toast(t('vocabImp.tooBig'), 'bad'); file.value = ''; return; }
    text.value = await f.text();
    if (!name.value) name.value = f.name.replace(/\.[^.]+$/, '').slice(0, 80);
    toast(t('vocabImp.loaded', { n: f.name }));
  });
  const errLine = (e) => h('li', {}, t('vocabImp.line', { n: e.line }), ': ', t('vocabImp.err.' + e.reason), e.value ? ` (${e.value})` : '');
  const showPreview = (p) => mount(out, h('div', { class: 'card' },
    h('p', {}, t('vocabImp.found', { n: p.count })), p.hasHeader ? h('p', { class: 'muted small' }, t('vocabImp.header')) : h('p', { class: 'muted small' }, t('vocabImp.noHeader')),
    p.count ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['vocabImp.col.word', 'vocabImp.col.pos', 'vocabImp.col.vi', 'vocabImp.col.example'].map((k) => h('th', {}, t(k))))),
      h('tbody', {}, p.sample.map((r) => h('tr', {}, h('td', {}, r.lemma), h('td', {}, r.pos), h('td', {}, r.definitionVi || r.definitionEn), h('td', {}, r.exampleEn)))))) : null,
    p.errorCount ? [h('p', { class: 'muted' }, t('vocabImp.skipped', { n: p.errorCount })), h('ul', { class: 'small' }, p.errors.slice(0, 10).map(errLine))] : null));
  const preview = action(async () => { if (!text.value.trim()) { toast(t('vocabImp.empty'), 'bad'); return; } showPreview(await post('/teacher/vocab/preview', { text: text.value })); });
  const doImport = action(async () => {
    if (!name.value.trim()) { toast(t('vocabImp.needName'), 'bad'); name.focus(); return; }
    if (!att.checked) { toast(t('vocabImp.needAttest'), 'bad'); return; }
    const r = await post('/teacher/vocab/import', { name: name.value.trim(), text: text.value, attestation: true });
    toast(t('vocabImp.done', { n: r.list.count }));
    render();
  });
  const row = (l) => h('tr', {}, h('td', {}, l.name), h('td', {}, l.count), h('td', {}, h('a', { class: 'btn ghost small', href: `#/t/ai?list=${l.id}` }, t('vocabImp.makeQuiz'))));
  return h('div', {}, h('h1', {}, t('nav.vocabImport')),
    h('form', { class: 'card stack', onsubmit: (ev) => ev.preventDefault() },
      h('h2', {}, t('vocabImp.title')), h('p', { class: 'muted small' }, t('vocabImp.help')),
      field('vi-name', t('vocabImp.name'), name), field('vi-file', t('vocabImp.file'), file, t('vocabImp.fileHint')), field('vi-text', t('vocabImp.paste'), text),
      h('p', {}, h('label', {}, att, ' ', t('vocabImp.attest'))),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: preview }, t('vocabImp.preview')), h('button', { class: 'btn', type: 'button', onclick: doImport }, t('vocabImp.import')))),
    out,
    h('section', { class: 'card' }, h('h2', {}, t('vocabImp.myLists')),
      lists.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['vocabImp.col.list', 'vocabImp.col.count', ''].map((k) => h('th', {}, k && t(k))))), h('tbody', {}, lists.map(row)))) : empty(t('vocabImp.noLists'))));
}

// ---------- Trợ lý AI: cài đặt + ra đề ----------
export async function aiPage({ query, role }) {
  const isTeacher = role === 'teacher';
  const flagOn = !!session.me?.flags?.['ai.gateway'];
  if (!flagOn) return h('div', {}, h('h1', {}, t('nav.ai')), h('section', { class: 'card' }, h('p', {}, t('ai.flagOff')), h('p', { class: 'muted small' }, t('ai.flagOffHow'))));
  const [cfg, usage, { lists }] = await Promise.all([get('/admin/ai'), get('/admin/ai/usage'), isTeacher ? get('/teacher/vocab/lists') : Promise.resolve({ lists: [] })]);
  const hasKey = cfg.keys.length > 0 || cfg.fake;

  // 1) Cài đặt
  const on = h('input', { id: 'ai-on', type: 'checkbox', checked: cfg.enabled, onchange: action(async () => { await put('/admin/ai/settings', { enabled: on.checked }); toast(t('common.saved')); render(); }) });
  const prov = h('select', { id: 'ai-p' }, cfg.providers.map((p) => h('option', { value: p, selected: p === 'gemini' }, p === 'gemini' ? 'Gemini (Google)' : p)));
  const key = h('input', { id: 'ai-k', type: 'password', autocomplete: 'off', minlength: 16, maxlength: 300, placeholder: 'AIza…' });
  const budget = h('input', { id: 'ai-b', type: 'number', min: 0, max: 100000000, value: cfg.monthlyTokenBudget });
  const calls = h('input', { id: 'ai-c', type: 'number', min: 0, max: 1000, value: cfg.userDailyCalls });
  const saveKey = action(async () => { if (key.value.trim().length < 16) { toast(t('ai.keyShort'), 'bad'); return; } await put(`/admin/ai/keys/${prov.value}`, { apiKey: key.value.trim() }); key.value = ''; toast(t('common.saved')); render(); });
  const saveLimits = action(async () => { await put('/admin/ai/settings', { enabled: on.checked, monthlyTokenBudget: +budget.value, userDailyCalls: +calls.value }); toast(t('common.saved')); render(); });
  const settings = h('section', { class: 'card stack' }, h('h2', {}, t('ai.settings'), ' ', h('span', { class: 'badge warn' }, t('ai.badge'))), h('p', { class: 'muted small' }, t('ai.note')),
    h('p', {}, h('label', {}, on, ' ', t('ai.enable'))),
    h('h3', {}, t('ai.keys')), h('p', { class: 'muted small' }, t('ai.keyHelp')),
    cfg.keys.length ? cfg.keys.map((k) => h('div', { class: 'row between' }, h('span', {}, k.provider, ' · ', t('ai.keyHint', { hint: k.keyHint })), h('button', { class: 'btn ghost small', onclick: action(async () => { await del(`/admin/ai/keys/${k.provider}`); render(); }) }, t('ai.revoke')))) : h('p', { class: 'muted' }, t('ai.noKey')),
    h('div', { class: 'row' }, field('ai-p', t('ai.provider'), prov), field('ai-k', t('ai.key'), key), h('button', { class: 'btn small', type: 'button', onclick: saveKey }, t('ai.keySave'))),
    h('h3', {}, t('ai.limits')), h('div', { class: 'row' }, field('ai-b', t('ai.budget'), budget), field('ai-c', t('ai.dailyCalls'), calls), h('button', { class: 'btn small', type: 'button', onclick: saveLimits }, t('common.save'))),
    h('p', { class: 'muted small' }, t('ai.used', { used: usage.used, budget: usage.budget })));

  // 2) Ra đề
  const sel = h('select', { id: 'ai-list' }, h('option', { value: '' }, t('ai.pickList')), lists.map((l) => h('option', { value: l.id, selected: l.id === query?.list }, `${l.name} (${l.count})`)));
  const words = h('div', { class: 'stack' });
  const picked = new Set();
  const loadWords = async () => {
    picked.clear(); mount(words);
    if (!sel.value) return;
    const { items } = await get(`/teacher/vocab/lists/${sel.value}`);
    const boxes = items.slice(0, 200).map((w) => { const cb = h('input', { type: 'checkbox', onchange: () => { cb.checked ? picked.add(w.senseId) : picked.delete(w.senseId); } }); return h('label', { class: 'row' }, cb, ' ', h('b', {}, w.lemma), ' ', h('span', { class: 'muted' }, w.definitionVi || w.definitionEn || '')); });
    const all = h('button', { class: 'btn ghost small', type: 'button', onclick: () => { boxes.forEach((l) => { const cb = l.querySelector('input'); cb.checked = true; cb.dispatchEvent(new Event('change')); }); } }, t('ai.selectAll'));
    mount(words, all, boxes, items.length > 200 ? h('p', { class: 'muted small' }, t('ai.first200')) : null);
  };
  sel.addEventListener('change', loadWords); if (sel.value) loadWords();
  const status = h('div', { 'aria-live': 'polite' });
  const gen = action(async () => {
    const ids = [...picked];
    if (ids.length < 2) { toast(t('ai.pickTwo'), 'bad'); return; }
    let made = 0, rej = 0, fail = 0;
    for (let i = 0; i < ids.length; i += 5) {
      const chunk = ids.slice(i, i + 5);
      if (chunk.length < 2) { chunk.push(ids[i - 1]); }              // lô cuối chỉ 1 từ: ghép thêm một từ để đủ tối thiểu
      mount(status, h('p', { class: 'muted' }, t('ai.working', { a: Math.min(i + 5, ids.length), b: ids.length })));
      try { const r = await post('/teacher/ai/question-drafts', { senseIds: chunk }); made += r.drafts.length; rej += r.rejected.length; } catch (e) { fail++; if (e.code === 'AI_BUDGET_EXCEEDED' || e.code === 'RATE_LIMITED' || e.code === 'FORBIDDEN') { mount(status, h('p', { class: 'bad' }, t('ai.stopped'))); throw e; } }
    }
    mount(status, h('p', {}, t('ai.draftDone', { n: made, r: rej }), fail ? ` ${t('ai.batchFail', { n: fail })}` : ''), h('p', {}, h('a', { class: 'btn', href: '#/t/questions' }, t('ai.reviewDrafts'))));
  });
  const make = h('section', { class: 'card stack' }, h('h2', {}, t('ai.draftTitle')), h('p', { class: 'muted small' }, t('ai.draftHow')),
    !hasKey || !cfg.enabled ? h('p', { class: 'bad' }, t('ai.notReady')) : null,
    field('ai-list', t('ai.pickList'), sel), words, h('p', {}, h('button', { class: 'btn', type: 'button', disabled: !cfg.enabled || !hasKey, onclick: gen }, t('ai.draftBtn'))), status);
  return h('div', {}, h('h1', {}, t('nav.ai')), isTeacher ? make : null, settings);
}
