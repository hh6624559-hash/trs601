// Theo dõi tiến độ ra đề hàng loạt (chạy nền ở máy chủ). Giữ trang mở để máy chủ (gói miễn phí) không ngủ.
import { h, mount } from './dom.js';
import { t, errText } from './i18n.js';
import { get, post } from './api.js';

export function watchJob({ base, jobId, into, onDone }) {
  let stop = false;
  const bar = h('progress', { max: 100, value: 0, 'aria-label': t('ai.job.title'), style: 'width:100%' });
  const line = h('p', { role: 'status', 'aria-live': 'polite' });
  const cancel = h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { cancel.disabled = true; try { await post(`${base}/${jobId}/cancel`, {}); } catch { /* sẽ tự dừng ở lần kiểm tra sau */ } } }, t('ai.job.cancel'));
  mount(into, h('div', { class: 'stack' }, h('p', { class: 'muted small' }, t('ai.job.keepOpen')), bar, line, cancel));
  const tick = async () => {
    if (stop || !document.body.contains(into)) return;
    try {
      const j = await get(`${base}/${jobId}`);
      bar.max = j.total; bar.value = j.done;
      line.textContent = t('ai.job.progress', { done: j.done, total: j.total, ok: j.ok, rej: j.rejected });
      if (j.state !== 'RUNNING') {
        stop = true;
        mount(into, h('p', { class: j.state === 'FAILED' ? 'bad' : '' }, t(`ai.job.${j.state.toLowerCase()}`, { ok: j.ok, rej: j.rejected }), j.error ? ` (${j.error})` : ''));
        return onDone?.(j);
      }
    } catch (e) { if (e?.code === 'NOT_FOUND') { stop = true; mount(into, h('p', { class: 'bad' }, errText(e))); return; } }
    setTimeout(tick, 2500);
  };
  setTimeout(tick, 800);
  return () => { stop = true; };
}
