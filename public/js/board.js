// Bảng trắng cho phòng học: nét vẽ chuẩn hoá 0–1 (độc lập kích thước màn hình), đồng bộ qua sự kiện phòng.
// Không có công cụ gõ chữ tự do (an toàn trẻ em); bút/bút dạ/tẩy, 6 màu, 3 cỡ, nhiều trang, hoàn tác, xuất PNG.
import { h } from './dom.js';
import { t } from './i18n.js';
import { get, post } from './api.js';
import { toast, confirmBox } from './ui.js';

const COLORS = ['#1b1b1b', '#d62828', '#1d4ed8', '#15803d', '#d97706', '#7e22ce'];
const SIZES = [3, 6, 12];
const LOGICAL = 1000;                              // độ rộng logic: w tính theo đơn vị này

export function createBoard({ roomId, myId, errText }) {
  let strokes = [], page = 0, pages = 1, canDraw = false, isAuth = false, on = false;
  let tool = 'pen', color = COLORS[0], size = SIZES[1], cur = null;
  const pending = [];                              // nét của mình đã vẽ, chờ máy chủ gán số thứ tự n
  const canvas = h('canvas', { class: 'boardcanvas', role: 'img', 'aria-label': t('board.title'), tabindex: 0 });
  const ctx = canvas.getContext('2d');
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => redraw()) : null;
  ro?.observe(canvas);

  function fit() {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), hh = Math.max(1, Math.round(r.width * 9 / 16 * dpr));
    if (canvas.width !== w || canvas.height !== hh) { canvas.width = w; canvas.height = hh; }
  }
  function paint(s) {
    const W = canvas.width, H = canvas.height, k = W / LOGICAL, p = s.pts;
    if (!p || p.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.globalAlpha = s.tool === 'highlighter' ? 0.35 : 1;
    ctx.strokeStyle = s.tool === 'eraser' ? '#000' : s.c; ctx.lineWidth = s.w * k * (s.tool === 'highlighter' ? 2.5 : s.tool === 'eraser' ? 3 : 1);
    ctx.beginPath(); ctx.moveTo(p[0] * W, p[1] * H);
    if (p.length === 2) ctx.lineTo(p[0] * W + 0.01, p[1] * H);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * W, p[i + 1] * H);
    ctx.stroke(); ctx.restore();
  }
  function redraw() { fit(); ctx.clearRect(0, 0, canvas.width, canvas.height); strokes.forEach(paint); if (cur) paint(cur); }

  const at = (e) => { const r = canvas.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / (r.width * 9 / 16)))]; };
  canvas.addEventListener('pointerdown', (e) => {
    if (!canDraw || !on || e.button > 0) return;
    canvas.setPointerCapture?.(e.pointerId); e.preventDefault();
    cur = { tool, c: color, w: size, pts: at(e) }; redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!cur) return;
    const [x, y] = at(e), n = cur.pts.length;
    if (Math.abs(x - cur.pts[n - 2]) + Math.abs(y - cur.pts[n - 1]) < 0.002) return;
    cur.pts.push(x, y); paint({ ...cur, pts: cur.pts.slice(-4) });          // vẽ tăng dần, không vẽ lại cả nét
  });
  const finish = () => {
    if (!cur) return; const s = cur; cur = null;
    let pts = s.pts;
    if (pts.length > 600) { const keep = []; const step = (pts.length / 2) / 299; for (let i = 0; i < 299; i += 1) { const j = Math.round(i * step) * 2; keep.push(pts[j], pts[j + 1]); } keep.push(pts[pts.length - 2], pts[pts.length - 1]); pts = keep; }
    s.pts = pts.map((v) => Math.round(v * 10000) / 10000); s.by = myId; s.page = page; s.n = null;
    strokes.push(s); pending.push(s);
    post(`/rooms/${roomId}/board/stroke`, { page: s.page, tool: s.tool, color: s.c, width: s.w, pts: s.pts }).catch((e) => {
      const i = strokes.indexOf(s); if (i >= 0) strokes.splice(i, 1); const j = pending.indexOf(s); if (j >= 0) pending.splice(j, 1);
      redraw(); toast(errText(e), 'bad');
    });
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  const btn = (label, aria, fn, extra = {}) => h('button', { class: 'btn small ghost', type: 'button', 'aria-label': aria, title: aria, onclick: fn, ...extra }, label);
  const toolBtns = [['pen', '✏️', 'board.pen'], ['highlighter', '🖍️', 'board.highlighter'], ['eraser', '🧽', 'board.eraser']].map(([k, ic, key]) => btn(ic, t(key), () => { tool = k; sync(); }, { 'data-tool': k }));
  const colorBtns = COLORS.map((c) => h('button', { class: 'swatch', type: 'button', style: `background:${c}`, 'aria-label': `${t('board.color')} ${c}`, 'data-color': c, onclick: () => { color = c; if (tool === 'eraser') tool = 'pen'; sync(); } }));
  const sizeBtns = SIZES.map((z, i) => btn('●', `${t('board.size')} ${i + 1}`, () => { size = z; sync(); }, { 'data-size': z, style: `font-size:${10 + i * 5}px` }));
  const undoBtn = btn('↶', t('board.undo'), () => post(`/rooms/${roomId}/board/undo`, { page }).catch((e) => toast(errText(e), 'bad')));
  const clearBtn = btn('🗑️', t('board.clear'), async () => { if (await confirmBox(t('board.clearConfirm'), { danger: true })) post(`/rooms/${roomId}/board/clear`, { page }).catch((e) => toast(errText(e), 'bad')); });
  const exportBtn = btn('⬇️', t('board.export'), () => {
    const o = document.createElement('canvas'); o.width = canvas.width; o.height = canvas.height; const c = o.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, o.width, o.height); c.drawImage(canvas, 0, 0);
    o.toBlob((b) => { const a = h('a', { href: URL.createObjectURL(b), download: `bang-${page + 1}.png` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); });
  });
  const prev = btn('‹', t('board.prev'), () => setRemotePage(page - 1));
  const next = btn('›', t('board.next'), () => setRemotePage(page + 1));
  const add = btn('＋', t('board.add'), () => setRemotePage(pages));
  const label = h('span', { class: 'small muted', 'data-board-page': '' });
  const setRemotePage = (n) => { if (n < 0 || n > 19) return; post(`/rooms/${roomId}/board/page`, { page: n }).catch((e) => toast(errText(e), 'bad')); };
  const note = h('p', { class: 'small muted' });
  const tools = h('div', { class: 'row boardtools', role: 'toolbar', 'aria-label': t('board.title') }, toolBtns, colorBtns, sizeBtns, undoBtn, clearBtn, exportBtn);
  const pager = h('div', { class: 'row center' }, prev, label, next, add);
  const el = h('div', { class: 'boardwrap' }, tools, h('div', { class: 'boardpaper' }, canvas), pager, note);

  function sync() {
    toolBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    colorBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === color && tool !== 'eraser')));
    sizeBtns.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.size) === size)));
    tools.hidden = !canDraw; clearBtn.hidden = !isAuth; add.hidden = !isAuth; prev.hidden = next.hidden = !isAuth;
    exportBtn.hidden = false; tools.hidden = false;
    for (const b of [...toolBtns, ...colorBtns, ...sizeBtns, undoBtn]) b.hidden = !canDraw;
    canvas.style.cursor = canDraw ? 'crosshair' : 'default';
    label.textContent = t('board.page', { a: page + 1, b: Math.max(pages, page + 1) });
    note.textContent = canDraw ? '' : t('board.readonly');
  }
  return {
    el, canvas,
    /** Cập nhật từ trạng thái phòng. */
    setState({ boardOn, boardPage, draw, authority }) {
      on = boardOn; canDraw = !!draw && on; isAuth = !!authority;
      if (boardPage + 1 > pages) pages = boardPage + 1;
      if (boardPage !== page) { page = boardPage; strokes = []; pending.length = 0; load(); }
      sync();
    },
    async load() { return load(); },
    /** Áp dụng sự kiện 'board' từ phòng. */
    apply(e) {
      const p = e.payload;
      if (p.op === 'stroke') {
        if (p.page !== page) { if (p.page + 1 > pages) pages = p.page + 1; return; }
        if (strokes.some((s) => s.n === p.n)) return;
        if (p.by === myId && pending.length) { const s = pending.shift(); s.n = p.n; return; }
        const s = { n: p.n, by: p.by, tool: p.tool, c: p.c, w: p.w, pts: p.pts }; strokes.push(s); paint(s);
      } else if (p.op === 'undo') { if (p.page === page) { strokes = strokes.filter((s) => s.n !== p.n); redraw(); } }
      else if (p.op === 'clear') { if (p.page === page) { strokes = []; pending.length = 0; redraw(); } }
      sync();
    },
    redraw, destroy() { ro?.disconnect(); },
  };
  async function load() {
    try {
      const r = await get(`/rooms/${roomId}/board?page=${page}`);
      if (r.page !== page) return;
      strokes = r.strokes.map((s) => ({ n: s.n, by: s.by, tool: s.tool, c: s.c, w: s.w, pts: s.pts })); redraw();
    } catch { /* lần poll sau thử lại */ }
  }
}
