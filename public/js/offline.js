// Hàng đợi ôn tập ngoại tuyến (IndexedDB). iOS không có Background Sync → đồng bộ khi mở app/quay lại/online (B4.5).
import { post } from './api.js';
const DB = 'trs6', QUEUE = 'queue', PACK = 'pack';
let dbp;
function open() {
  dbp ||= new Promise((res, rej) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => { rq.result.createObjectStore(QUEUE, { keyPath: 'id' }); rq.result.createObjectStore(PACK, { keyPath: 'k' }); };
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
  return dbp;
}
const tx = async (store, mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(store, mode); const r = fn(t.objectStore(store)); t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error); }); };
const mem = []; // dự phòng khi IndexedDB không dùng được (chế độ riêng tư)
export async function enqueue(ev) { try { await tx(QUEUE, 'readwrite', (s) => s.put(ev)); } catch { mem.push(ev); } emit(); }
export async function pending() { try { return (await tx(QUEUE, 'readonly', (s) => s.getAll())) || []; } catch { return [...mem]; } }
async function drop(ids) { try { await tx(QUEUE, 'readwrite', (s) => ids.forEach((i) => s.delete(i))); } catch { for (const i of ids) { const k = mem.findIndex((x) => x.id === i); if (k >= 0) mem.splice(k, 1); } } }
export async function savePack(pack) { try { await tx(PACK, 'readwrite', (s) => s.put({ k: 'today', pack, at: Date.now() })); } catch { /* bỏ qua */ } }
export async function loadPack() { try { return (await tx(PACK, 'readonly', (s) => s.get('today'))) || null; } catch { return null; } }
export async function clearAll() { try { await tx(QUEUE, 'readwrite', (s) => s.clear()); await tx(PACK, 'readwrite', (s) => s.clear()); } catch { /* bỏ qua */ } mem.length = 0; }

const subs = new Set();
export const onQueue = (f) => { subs.add(f); return () => subs.delete(f); };
const emit = async () => { const n = (await pending()).length; subs.forEach((f) => f(n)); };

let flushing = false;
/** Gửi tối đa 200 sự kiện/lô, theo thứ tự thời gian. Trả {sent, left, last}. Lỗi mạng → giữ nguyên hàng đợi. */
export async function flush() {
  if (flushing) return { sent: 0, left: (await pending()).length };
  flushing = true; let sent = 0, last = null;
  try {
    for (;;) {
      const q = (await pending()).sort((a, b) => (a.clientAt || '').localeCompare(b.clientAt || '')).slice(0, 200);
      if (!q.length) break;
      let r;
      try { r = await post('/learn/reviews', { events: q }); } catch (e) { if (e.status === 0 || e.retryable || e.status >= 500 || e.status === 429) break; if (e.status === 401 || e.status === 403) break; await drop(q.map((x) => x.id)); break; }
      await drop(q.map((x) => x.id)); // mọi kết quả (accepted/duplicate/rejected) đều là cuối cùng
      sent += q.length; last = r;
    }
  } finally { flushing = false; emit(); }
  return { sent, left: (await pending()).length, last };
}
export function startAutoSync() {
  window.addEventListener('online', () => flush());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush(); });
  setInterval(() => { if (navigator.onLine) flush(); }, 60000);
}
