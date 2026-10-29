// Ra đề hàng loạt (chạy nền ở máy chủ): thanh tiến độ + DANH SÁCH CÂU HỎI VÀ ĐÁP ÁN hiện ngay khi vừa tạo xong.
// Giữ trang mở để máy chủ (gói miễn phí) không ngủ.
import { h, mount } from './dom.js';
import { t, errText } from './i18n.js';
import { get, post } from './api.js';

const LETTERS = 'ABCDEF';
/** Một câu: đề + các lựa chọn, đáp án đúng được đánh dấu ✓ và tô nổi. */
export const questionCard = (q, n) => h('article', { class: 'qcard', 'data-q': n },
  h('p', {}, h('b', {}, `${n}. `), q.stem),
  h('ol', { class: 'qopts', type: 'A' }, q.options.map((o, i) => h('li', { class: i === q.correctIndex ? 'ok' : '', 'aria-label': i === q.correctIndex ? `${t('q.answer')}: ${o}` : null }, o, i === q.correctIndex ? h('span', { class: 'qtick' }, ` ✓ ${t('q.answer')} ${LETTERS[i]}`) : null))),
  q.explanationEn ? h('p', { class: 'muted small' }, q.explanationEn) : null);

/** Dùng cho kết quả tức thì (≤10 câu): đầu danh sách ghi rõ số câu. */
export const questionList = (qs, into) => mount(into, h('div', { class: 'stack' }, h('h3', {}, t('ai.job.listTitle', { n: qs.length })), qs.map((q, i) => questionCard(q, i + 1))));

export function watchJob({ base, jobId, into, onDone, showList = true }) {
  let stop = false, after = 0;
  const bar = h('progress', { max: 100, value: 0, 'aria-label': t('ai.job.title'), style: 'width:100%' });
  const line = h('p', { role: 'status', 'aria-live': 'polite', class: 'jobline' });
  const detail = h('p', { class: 'muted small', role: 'status' });
  const title = h('h3', {}, t('ai.job.listTitle', { n: 0 }));
  const list = h('div', { class: 'stack joblist' });
  const cancel = h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { cancel.disabled = true; try { await post(`${base}/${jobId}/cancel`, {}); } catch { /* sẽ tự dừng ở lần kiểm tra sau */ } } }, t('ai.job.cancel'));
  const head = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, t('ai.job.keepOpen')), bar, line, detail, cancel);
  mount(into, h('div', { class: 'stack' }, head, showList && title, showList && list));
  const tick = async () => {
    if (stop || !document.body.contains(into)) return;
    try {
      const j = await get(`${base}/${jobId}?after=${after}`);
      const ph = j.phase, partial = ph?.ph === 'verify' ? ph.k : 0;
      bar.max = j.total; bar.value = Math.min(j.total, j.done + partial);
      line.textContent = t('ai.job.progress', { done: j.done, total: j.total, ok: j.ok, rej: j.rejected });
      const secs = Math.max(0, Math.round((Date.parse(j.serverNow) - Date.parse(j.startedAt)) / 1000)), mm = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      const what = !ph ? '' : ph.ph === 'wait' ? t('ai.job.phaseWait', { s: ph.secs, k: ph.attempt }) : ph.ph === 'gen' ? t('ai.job.phaseGen', { a: ph.batchFrom + 1, b: ph.batchFrom + ph.batchN }) : t('ai.job.phaseVerify', { k: ph.k, n: ph.n });
      detail.textContent = [what, t('ai.job.elapsed', { t: mm }), t('ai.job.calls', { ok: j.calls?.ok ?? 0, bad: j.calls?.bad ?? 0 }), j.lastError ? t('ai.job.lastErr', { e: j.lastError }) : ''].filter(Boolean).join(' · ');
      if (showList) { j.questions.forEach((q) => list.append(questionCard(q, ++after))); title.textContent = t('ai.job.listTitle', { n: after }); }
      else after += j.questions.length;
      if (j.state !== 'RUNNING') {
        stop = true;
        mount(head, h('p', { class: j.state === 'FAILED' ? 'bad' : '', role: 'status' }, t(`ai.job.${j.state.toLowerCase()}`, { ok: j.ok, rej: j.rejected }), j.error ? ` (${j.error})` : ''));
        if (!showList) { const all = await get(`${base}/${jobId}`); j.questions = all.questions; }
        return onDone?.(j, head);
      }
    } catch (e) { if (e?.code === 'NOT_FOUND') { stop = true; mount(into, h('p', { class: 'bad' }, errText(e))); return; } }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 600);
  return () => { stop = true; };
}

/** Nút «Kiểm tra kết nối AI»: gọi thử 1 câu và hiện lý do thật nếu lỗi (khoá sai, hết hạn mức, model quá tải…). */
export function pingPanel() {
  const out = h('div', { class: 'stack', 'aria-live': 'polite' });
  const line = (okv, label, detail) => h('p', { class: okv ? '' : 'bad' }, `${okv ? '✓' : '✗'} ${label}: `, detail);
  const btn = h('button', { class: 'btn ghost small', type: 'button', onclick: async () => {
    btn.disabled = true; mount(out, h('p', { class: 'muted' }, t('ai.ping.running')));
    try {
      const r = await post('/teacher/ai/ping', {});
      const rows = [];
      if (!r.flag) rows.push(line(false, t('ai.ping.system'), t('ai.flagOff')));
      else if (!r.enabled) rows.push(line(false, t('ai.ping.system'), t('ai.ping.notEnabled')));
      else if (!r.hasKey) rows.push(line(false, t('ai.ping.system'), t('ai.notReady')));
      else {
        const fmt = (x) => (x.ok ? t('ai.ping.ok', { model: x.model }) : t('ai.ping.fail', { code: x.code, status: x.status ?? '-', message: x.message || '' }));
        if (r.gen) rows.push(line(r.gen.ok, t('ai.ping.gen'), fmt(r.gen)));
        if (r.verify) rows.push(line(r.verify.ok, t('ai.ping.verify'), fmt(r.verify)), ...(r.verify.ok && !r.verify.agrees ? [h('p', { class: 'muted small' }, t('ai.ping.disagree'))] : []));
        if (r.gen?.ok && r.verify?.ok) rows.push(h('p', {}, t('ai.ping.allOk')));
      }
      mount(out, rows);
    } catch (e) { mount(out, h('p', { class: 'bad' }, errText(e))); }
    btn.disabled = false;
  } }, t('ai.ping.btn'));
  return h('div', { class: 'stack' }, btn, out);
}
