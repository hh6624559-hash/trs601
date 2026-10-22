import { watchJob } from '../aijob.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { get, post, session } from '../api.js';
import { action, toast, field, empty } from '../ui.js';
import { nav } from '../app.js';

/** Trình soạn đề luyện tập dùng chung: học sinh soạn cho mình, phụ huynh soạn cho con. 2 cách: tự nhập hoặc AI ra đề theo yêu cầu. */
async function builder({ endpoint, done, who }) {
  const ai = await get('/me/ai/status').catch(() => ({ flag: false, enabled: false, hasKey: false }));
  const list = []; // { stem, options, correctIndex, explanationEn, ai }
  let tab = 'manual';
  const root = h('div', {});
  const title = h('input', { id: 'pm-title', maxlength: 80, value: t('pm.defaultTitle') });

  const preview = h('div', { class: 'stack' });
  const drawList = () => mount(preview, list.length ? list.map((q, i) => h('div', { class: 'card' },
    h('p', {}, h('b', {}, `${i + 1}. ${q.stem}`), q.ai ? [' ', h('span', { class: 'badge warn' }, t('ai.badge'))] : null),
    h('ol', { class: 'small' }, q.options.map((o, k) => h('li', {}, o, k === q.correctIndex && ' ✓'))),
    h('button', { class: 'btn ghost small', type: 'button', onclick: () => { list.splice(i, 1); drawList(); } }, t('common.remove')))) : empty(t('pm.noneYet')));

  // --- tự nhập
  const stem = h('input', { id: 'pm-stem', maxlength: 400 });
  const opts = h('textarea', { id: 'pm-opts', rows: 4, placeholder: t('pm.optsPh') });
  const ans = h('input', { id: 'pm-ans', type: 'number', min: 1, max: 6, value: 1 });
  const exp = h('input', { id: 'pm-exp', maxlength: 600 });
  const add = () => {
    const o = opts.value.split('\n').map((x) => x.trim()).filter(Boolean), c = parseInt(ans.value, 10) - 1;
    if (stem.value.trim().length < 3) { toast(t('pm.needStem'), 'bad'); stem.focus(); return; }
    if (o.length < 2 || o.length > 6 || new Set(o.map((x) => x.toLowerCase())).size !== o.length) { toast(t('pm.needOpts'), 'bad'); opts.focus(); return; }
    if (!(c >= 0 && c < o.length)) { toast(t('pm.needAns'), 'bad'); ans.focus(); return; }
    list.push({ stem: stem.value.trim(), options: o, correctIndex: c, ...(exp.value.trim() ? { explanationEn: exp.value.trim() } : {}) });
    stem.value = ''; opts.value = ''; ans.value = 1; exp.value = ''; drawList(); stem.focus();
  };
  const manual = h('section', { class: 'card stack' }, h('h2', {}, t('pm.manualTitle')), field('pm-stem', t('q.stem'), stem), field('pm-opts', t('q.options'), opts, t('pm.optsHint')), field('pm-ans', t('pm.correctNo'), ans), field('pm-exp', t('q.explanation'), exp),
    h('p', {}, h('button', { class: 'btn', type: 'button', onclick: add }, t('pm.addQ'))));

  // --- AI
  const req = h('textarea', { id: 'pm-req', rows: 3, maxlength: 400, placeholder: t('pm.reqPh') });
  const cnt = h('input', { id: 'pm-n', type: 'number', min: 1, max: 1000, value: 5, inputmode: 'numeric', style: 'width:6em' });
  const lvl = h('select', { id: 'pm-lv' }, h('option', { value: '' }, t('qai.anyLevel')), ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map((x) => h('option', { value: x }, x)));
  const st = h('div', { 'aria-live': 'polite' });
  const minorBlocked = ai.ageBand === 'u13';            // học sinh dưới 13 tự dùng AI: bị chặn; phụ huynh là người lớn nên vẫn dùng được
  const ready = ai.flag && ai.enabled && ai.hasKey && !minorBlocked;
  const gen = action(async () => {
    if (req.value.trim().length < 5) { toast(t('qai.needReq'), 'bad'); req.focus(); return; }
    mount(st, h('p', { class: 'muted' }, t('qai.working')));
    const r = await post('/me/ai/practice-questions', { request: req.value.trim(), count: Math.min(1000, Math.max(1, Math.round(+cnt.value) || 5)), ...(lvl.value ? { cefr: lvl.value } : {}) });
    const add = (qs, rej) => { qs.forEach((q) => list.push({ stem: q.stem, options: q.options, correctIndex: q.correctIndex, ...(q.explanationEn ? { explanationEn: q.explanationEn } : {}), ai: true })); mount(st, h('p', {}, t('pm.aiDone', { n: qs.length, r: rej }))); drawList(); };
    if (r.jobId) { watchJob({ base: '/me/ai/jobs', jobId: r.jobId, into: st, onDone: (j) => add(j.questions || [], j.rejected) }); return; }
    r.questions.forEach((q) => list.push({ stem: q.stem, options: q.options, correctIndex: q.correctIndex, ...(q.explanationEn ? { explanationEn: q.explanationEn } : {}), ai: true }));
    mount(st, h('p', {}, t('pm.aiDone', { n: r.questions.length, r: r.rejected.length })));
    drawList();
  });
  const why = !ai.flag ? t('ai.flagOff') : minorBlocked ? t('pm.aiUnder13') : !ai.enabled ? t('pm.aiOff') : !ai.hasKey ? t('ai.notReady') : null;
  const aiPane = h('section', { class: 'card stack' }, h('h2', {}, t('pm.aiTitle'), ' ', h('span', { class: 'badge warn' }, t('ai.badge'))), h('p', { class: 'muted small' }, t('pm.aiHelp')),
    why ? h('p', { class: 'bad' }, why, ' ', ai.canManage && ai.flag && !minorBlocked ? h('a', { href: '#/ai-settings' }, t('qai.openSettings')) : null) : null,
    field('pm-req', t('qai.request'), req), h('div', { class: 'row' }, field('pm-n', t('qai.count'), cnt), field('pm-lv', t('qai.level'), lvl)),
    h('p', {}, h('button', { class: 'btn', type: 'button', disabled: !ready, onclick: gen }, t('pm.aiGen'))), st);

  const body = h('div', {});
  const tabBtn = (id, label) => h('button', { class: ['btn', tab === id ? '' : 'ghost'], type: 'button', role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; drawTabs(); } }, label);
  const tabs = h('div', { class: 'row', role: 'tablist', 'aria-label': t('qai.modeLabel') });
  const drawTabs = () => { mount(tabs, tabBtn('manual', t('qai.modeManual')), tabBtn('ai', t('qai.modeAi'))); mount(body, tab === 'ai' ? aiPane : manual); };
  drawTabs(); drawList();

  const make = action(async () => {
    if (!list.length) { toast(t('pm.needOne'), 'bad'); return; }
    const r = await post(endpoint, { title: title.value.trim() || t('pm.defaultTitle'), questions: list.map(({ stem, options, correctIndex, explanationEn }) => ({ stem, options, correctIndex, ...(explanationEn ? { explanationEn } : {}) })), fromAi: list.some((q) => q.ai) });
    toast(t('pm.created', { n: r.items })); done(r);
  });
  mount(root, h('p', { class: 'muted' }, t('pm.intro', { who })), tabs, body,
    h('section', { class: 'card stack' }, h('h2', {}, t('pm.yourSet')), field('pm-title', t('pm.setTitle'), title), preview, h('p', {}, h('button', { class: 'btn', type: 'button', onclick: make }, t('pm.create')))));
  return root;
}

export async function mine() {
  return h('div', {}, h('h1', {}, t('nav.makePractice')), await builder({ endpoint: '/me/practice/custom', who: t('pm.whoMe'), done: () => nav('/assignments') }));
}
export async function forChild({ params }) {
  const kids = await get('/guardian/children');
  const kid = (kids.children || []).find((c) => c.id === params.id);
  const name = kid?.displayName || '';
  return h('div', {}, h('p', {}, h('a', { href: `#/g/child/${params.id}` }, '← ', name)), h('h1', {}, t('pm.forChild', { name })),
    await builder({ endpoint: `/guardian/children/${params.id}/practice/custom`, who: name, done: () => { toast(t('pm.sentToChild', { name })); nav(`/g/child/${params.id}`); } }));
}
