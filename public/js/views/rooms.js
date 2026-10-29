import { h, mount } from '../dom.js';
import { t, errText } from '../i18n.js';
import { get, post, session, roleOf } from '../api.js';
import { action, toast, field, empty } from '../ui.js';
import { nav } from '../app.js';
import { Mascot, PaperCard, PolaroidFrame, Stamp, EmptyState } from '../components.js';
import { RoomSession } from '../roomsession.js';
import { createBoard } from '../board.js';

const PAGE = 9;                                  // v29: tối đa ~9–12 khung hiện cùng lúc

const KINDS = ['personal', 'group'];

/** Danh sách + tạo phòng + vào bằng mã. */
export async function list() {
  const me = session.me.user, isTeacher = roleOf() === 'teacher';
  const [{ rooms }, cls] = await Promise.all([get('/rooms'), isTeacher ? get('/teacher/classes') : { classes: [] }]);
  const title = h('input', { id: 'rm-title', maxlength: 80, required: true });
  const kind = h('select', { id: 'rm-kind' }, KINDS.map((k) => h('option', { value: k }, t('room.kind.' + k))));
  const klass = h('select', { id: 'rm-class' }, cls.classes.map((c) => h('option', { value: c.id }, c.name)));
  const wait = h('input', { id: 'rm-wait', type: 'checkbox', checked: true });
  const fb = h('input', { id: 'rm-fb', type: 'url', placeholder: 'https://', maxlength: 300 });
  const code = h('input', { id: 'rm-code', maxlength: 12, autocomplete: 'off', autocapitalize: 'characters' });
  const canCreate = me.ageBand !== 'u13';
  const create = isTeacher
    ? action(async (ev) => { ev.preventDefault(); const r = await post('/rooms', { kind: 'class', title: title.value, classId: klass.value }); nav(`/rooms/${r.id}`); })
    : action(async (ev) => { ev.preventDefault(); const body = { kind: kind.value, title: title.value, waitingRoom: wait.checked }; if (fb.value.trim()) body.fallbackUrl = fb.value.trim(); const r = await post('/rooms', body); if (r.inviteCode) { toast(t('room.inviteShown', { code: r.inviteCode })); sessionStorage.setItem?.('invite:' + r.id, r.inviteCode); } nav(`/rooms/${r.id}`); });
  return h('div', {}, h('h1', {}, t('room.title')), h('p', { class: 'muted' }, t('room.intro')),
    canCreate && h('section', { class: 'pcard' }, h('h2', {}, t('room.create')),
      h('form', { onsubmit: create }, field('rm-title', t('room.name'), title),
        isTeacher ? field('rm-class', t('room.class'), klass) : [field('rm-kind', t('room.kind'), kind), h('label', { class: 'check' }, wait, t('room.waitingRoom')), field('rm-fb', t('room.fallback'), fb)],
        h('p', {}, h('button', { class: 'btn', type: 'submit' }, t('room.create'))))),
    me.ageBand === '18p' && h('section', { class: 'pcard' }, h('h2', {}, t('room.joinCode')),
      h('form', { class: 'row', onsubmit: action(async (ev) => { ev.preventDefault(); const r = await post('/rooms/join', { code: code.value.trim().toUpperCase() }); nav(`/rooms/${r.id}`); }) }, code, h('button', { class: 'btn', type: 'submit' }, t('room.joinCode')))),
    h('h2', {}, t('room.mine')),
    rooms.length ? h('div', { class: 'grid c2' }, rooms.map((r) => PaperCard({ form: 'sticker' }, h('h3', {}, r.title), h('p', { class: 'muted small' }, `${t('room.kind.' + r.kind)} · ${r.hostName}`), r.state === 'LIVE' && h('span', { class: 'badge bad' }, t('room.live')), ' ',
      h('a', { class: 'btn small', href: `#/rooms/${r.id}` }, t('room.open'))))) : empty(t('room.none')));
}

/** Màn trước khi vào → (phòng chờ) → phòng. Cam/mic LUÔN tắt khi vào; người dùng tự bật (P-10: luôn có đường vào không cam). */
export async function room({ params }) {
  const id = params.id;
  const v0 = await get(`/rooms/${id}`).catch(async (e) => { if (e.code === 'NOT_FOUND') return null; throw e; });
  const root = h('div', {});
  if (!v0 || v0.you?.state === 'left' || !v0.you) return prejoin(root, id, null);
  if (v0.state === 'ENDED' || v0.state === 'CANCELLED') return mount(root, EmptyState({ mood: 'nghi_ngoi', title: t('room.ended'), action: h('a', { class: 'btn', href: '#/rooms' }, t('common.back')) }));
  if (v0.you.state === 'waiting') return waitingScreen(root, id);
  return prejoin(root, id, v0);
}

function prejoin(root, id, v0) {
  const video = h('video', { autoplay: true, playsinline: true, muted: true, 'aria-label': t('room.preview') });
  video.muted = true;
  let stream;
  const status = h('p', { class: 'muted', role: 'status' });
  const preview = h('button', { class: 'btn ghost', onclick: async () => {
    try { stream = await navigator.mediaDevices.getUserMedia({ video: true }); video.srcObject = stream; } catch { mount(status, t('room.noMedia')); }
  } }, t('room.preview'));
  const go = (withCam) => action(async () => {
    stream?.getTracks().forEach((x) => x.stop());
    const r = v0?.you?.state === 'admitted' ? { status: 'ADMITTED' } : await post(`/rooms/${id}/join`, {}).catch((e) => { if (e.code === 'DEPENDENCY_UNAVAILABLE') { mount(status, errText(e), e.details?.[0]?.fallbackUrl && h('a', { href: e.details[0].fallbackUrl, target: '_blank', rel: 'noopener noreferrer' }, ' ', t('room.fallbackOpen'))); throw new Error('cancelled'); } throw e; });
    if (r.status === 'WAITING_FOR_HOST') return waitingScreen(root, id);
    return live(root, id, { wantCam: withCam });
  });
  mount(root, h('h1', {}, t('room.prejoin')), h('p', { class: 'muted' }, t('room.prejoinHint')),
    h('div', { class: 'grid c2' }, PolaroidFrame({ id, caption: t('room.camOff'), child: video }), h('div', { class: 'stack' }, preview, status, h('p', { class: 'small muted' }, t('room.p2pNote')))),
    h('div', { class: 'row' }, h('button', { class: 'btn big', onclick: go(true) }, t('room.joinNow')), h('button', { class: 'btn big ghost', onclick: go(false) }, t('room.joinNoCam'))));
  return root;
}

function waitingScreen(root, id) {
  let stop = false;
  mount(root, PaperCard({ form: 'note', id }, Mascot({ mood: 'suy_nghi', size: 100 }), h('h2', {}, t('room.waitingTitle')), h('p', {}, t('room.waiting'))), h('button', { class: 'btn ghost', onclick: action(async () => { stop = true; await post(`/rooms/${id}/leave`, {}); nav('/rooms'); }) }, t('room.leave')));
  const poll = async () => {
    if (stop || !document.body.contains(root)) return;
    try {
      const v = await get(`/rooms/${id}`);
      if (v.you?.state === 'admitted') { const r = await post(`/rooms/${id}/join`, {}); return live(root, id, { wantCam: false, preset: r.session }); }
      if (v.you?.state === 'denied' || v.state === 'ENDED' || v.events.some((e) => e.kind === 'denied' || e.kind === 'ended')) { toast(t('room.ended'), 'bad'); return nav('/rooms'); }
    } catch (e) { if (e.code === 'NOT_FOUND') return nav('/rooms'); }
    setTimeout(poll, 1500);
  };
  setTimeout(poll, 1000);
  return root;
}

async function live(root, id, { wantCam }) {
  const me = session.me.user;
  const first = await post(`/rooms/${id}/join`, {});                     // idempotent: lấy token + trạng thái
  const tiles = new Map(), streams = new Map();
  const grid = h('div', { class: 'roomgrid' }), pager = h('div', {});
  let page = 0;
  const chatBox = h('div', { class: 'chat', role: 'log', 'aria-live': 'polite' });
  const side = h('div', { class: 'stack' });
  const head = h('div', { class: 'row between' });
  const banner = h('div', { role: 'status' });
  let mic = false, cam = false, state = first, rs;
  const micBtn = h('button', { class: 'iconbtn', 'aria-label': t('room.mic'), onclick: () => toggle('mic') }, '🎤');
  const camBtn = h('button', { class: 'iconbtn', 'aria-label': t('room.cam'), onclick: () => toggle('cam') }, '📷');
  const handBtn = h('button', { class: 'iconbtn', 'aria-label': t('room.hand'), 'aria-pressed': 'false', onclick: async () => { const up = handBtn.getAttribute('aria-pressed') !== 'true'; await post(`/rooms/${id}/hand`, { up }); handBtn.setAttribute('aria-pressed', String(up)); } }, '✋');
  const leaveBtn = h('button', { class: 'btn danger small', onclick: action(async () => { rs.stop(); await post(`/rooms/${id}/leave`, {}); nav('/rooms'); }) }, t('room.leave'));
  const board = createBoard({ roomId: id, myId: me.id, errText });
  const screenVideo = h('video', { id: 'rm-screen', class: 'screenvideo', autoplay: true, playsinline: true, 'aria-label': t('screen.view') });
  screenVideo.muted = true;
  const stage = h('section', { class: 'stage', id: 'rm-stage', 'aria-live': 'polite' });
  let stageView = null, sharing = false;                     // stageView: lựa chọn xem riêng (screen|board); sharing: mình đang chia sẻ
  const shareBtn = h('button', { class: 'btn small', id: 'rm-share', type: 'button', onclick: () => toggleShare().catch((e) => toast(e?.name === 'NotAllowedError' ? t('screen.cancelled') : errText(e), 'bad')) }, t('screen.share'));
  const boardBtn = h('button', { class: 'btn small ghost', id: 'rm-board', type: 'button', onclick: action(async () => { await post(`/rooms/${id}/board/open`, { on: !state.boardOn }); await rs.poll(); }) }, t('board.open'));
  async function toggleShare() {
    if (sharing) { await rs.stopScreen(); sharing = false; screenVideo.srcObject = null; await rs.poll(); return; }
    const st = await rs.startScreen(); sharing = true; screenVideo.srcObject = st; stageView = 'screen'; await rs.poll();
  }
  function drawStage(v) {
    const hasScreen = !!v.screenBy, hasBoard = v.boardOn;
    if (!hasScreen && sharing) { sharing = false; }
    if (stageView === 'screen' && !hasScreen) stageView = null; if (stageView === 'board' && !hasBoard) stageView = null;
    const mode = stageView || (hasScreen ? 'screen' : hasBoard ? 'board' : null);
    stage.hidden = !mode;
    if (!mode) return mount(stage);
    const who = v.members?.find((m) => m.userId === v.screenBy)?.name;
    mount(stage,
      h('div', { class: 'row between' },
        h('span', { class: 'badge' }, mode === 'screen' ? (v.screenBy === me.id ? t('screen.you') : t('screen.sharing', { name: who || '' })) : t('board.title')),
        hasScreen && hasBoard && h('span', { class: 'row' },
          h('button', { class: 'btn small ghost', 'aria-pressed': String(mode === 'screen'), onclick: () => { stageView = 'screen'; drawStage(state); } }, t('room.stage.screen')),
          h('button', { class: 'btn small ghost', 'aria-pressed': String(mode === 'board'), onclick: () => { stageView = 'board'; drawStage(state); } }, t('room.stage.board')))),
      mode === 'screen' ? h('div', { class: 'screenwrap' }, screenVideo) : board.el);
    if (mode === 'board') requestAnimationFrame(() => board.redraw());
    else screenVideo.play?.().catch(() => {});
  }
  const text = h('input', { id: 'rm-chat', maxlength: 300, placeholder: t('room.chatPh'), autocomplete: 'off' });
  const send = async (body) => { try { await post(`/rooms/${id}/chat`, body); } catch (e) { toast(errText(e), 'bad'); } };
  const refreshButtons = () => {
    const y = state.you || {};
    micBtn.classList.toggle('on', mic); camBtn.classList.toggle('on', cam);
    micBtn.disabled = !y.micAllowed; camBtn.disabled = !y.camAllowed;
    micBtn.title = camBtn.title = y.camAllowed || y.micAllowed ? '' : t('room.camBlocked');
  };
  async function toggle(what) {
    const y = state.you || {};
    if (what === 'mic' && !y.micAllowed) return mount(banner, h('div', { class: 'banner' }, state.members?.find((m) => m.userId === me.id)?.mutedByHost ? t('room.mutedByHost') : t('room.camBlocked')));
    if (what === 'cam' && !y.camAllowed) return mount(banner, h('div', { class: 'banner' }, t('room.camBlocked')));
    const next = { audio: what === 'mic' ? !mic : mic, video: what === 'cam' ? !cam : cam };
    const got = await rs.setDevices(next);
    if ((next.audio && !got.audio) || (next.video && !got.video)) mount(banner, h('div', { class: 'banner' }, t('room.noMedia')));
    mic = got.audio; cam = got.video; refreshButtons();
  }
  function tile(uid, name) {
    let el = tiles.get(uid);
    if (!el) { const v = h('video', { autoplay: true, playsinline: true }); if (uid === me.id) v.muted = true; el = { v, wrap: PolaroidFrame({ id: uid, caption: name, child: v }) }; tiles.set(uid, el); }
    return el;
  }
  const rs0 = (rs = new RoomSession(id, {
    myId: me.id, token: first.session?.token, iceServers: first.session?.iceServers || [],
    onScreen: (st) => { screenVideo.srcObject = st; stageView = 'screen'; drawStage(rs.state || state); },
    onStream: (uid, s) => { const key = uid === 'local' ? me.id : uid; if (s) streams.set(key, s); else streams.delete(key); const el = tiles.get(key); if (el) el.v.srcObject = streams.get(key) || null; },
    onState: (v) => { state = v; drawState(v); },
    onEvent: (e) => {
      if (e.kind === 'board') board.apply(e);
      if (e.kind === 'screen' && !e.payload.on && e.actorId !== me.id) { screenVideo.srcObject = null; if (stageView === 'screen') stageView = null; }
      if (e.kind === 'chat') { chatBox.append(h('div', { class: ['msg', e.actorId === me.id && 'me'] }, h('b', {}, e.payload.name), ': ', e.payload.text)); chatBox.scrollTop = chatBox.scrollHeight; }
      if (e.kind === 'mute_all' && e.actorId !== me.id && mic) toggle('mic').catch(() => {});
      if (e.kind === 'mute' && e.payload.userId === me.id && e.payload.muted && mic) toggle('mic').catch(() => {});
      if (e.kind === 'kicked' && e.payload.userId === me.id) { rs.stop(); toast(t('error.ROOM_REMOVED'), 'bad'); nav('/rooms'); }
      if (e.kind === 'ended') { rs.stop(); mount(root, EmptyState({ mood: 'nghi_ngoi', title: t('room.ended'), action: h('a', { class: 'btn', href: '#/rooms' }, t('common.back')) })); }
    },
    onError: (e) => { if (e.code === 'NOT_FOUND') { rs.stop(); nav('/rooms'); } else if (e.code === 'UNAUTHENTICATED') rs.refreshToken().catch(() => {}); },
  }));
  function drawState(v) {
    if (!v.members) return;
    mount(head, h('h1', {}, v.title), v.state === 'LIVE' ? h('span', { class: 'badge bad' }, t('room.live')) : h('span', { class: 'badge warn' }, t('room.paused')), v.locked && h('span', { class: 'badge' }, '🔒'));
    const adm = v.members.filter((m) => m.state === 'admitted').sort((a, b) => Number(b.hand) - Number(a.hand));     // người giơ tay lên trước
    const pages = Math.max(1, Math.ceil(adm.length / PAGE)); if (page >= pages) page = pages - 1;
    const shown = adm.slice(page * PAGE, page * PAGE + PAGE);
    rs.setVisible([...shown.map((m) => m.userId), ...adm.filter((m) => m.hand).map((m) => m.userId), v.screenBy, v.hostId].filter(Boolean));
    rs.pollMs = v.boardOn ? 400 : 800;
    board.setState({ boardOn: v.boardOn, boardPage: v.boardPage, draw: v.isAuthority || v.you.boardOk, authority: v.isAuthority });
    drawStage(v);
    boardBtn.hidden = !v.isAuthority; boardBtn.textContent = v.boardOn ? t('board.close') : t('board.open');
    shareBtn.hidden = !(v.isAuthority && me.ageBand === '18p' && navigator.mediaDevices?.getDisplayMedia);
    shareBtn.textContent = sharing ? t('screen.stop') : t('screen.share');
    mount(pager, pages > 1 && h('div', { class: 'row center' }, h('button', { class: 'btn small ghost', disabled: page === 0, onclick: () => { page -= 1; drawState(state); } }, '‹'), h('span', { class: 'muted small' }, t('room.page', { a: page + 1, b: pages, n: adm.length })), h('button', { class: 'btn small ghost', disabled: page >= pages - 1, onclick: () => { page += 1; drawState(state); } }, '›')));
    mount(grid, shown.map((m) => { const el = tile(m.userId, `${m.name}${m.hand ? ' ✋' : ''}${m.micAllowed ? '' : ' 🔇'}`); el.wrap.querySelector('.cap').firstChild.textContent = `${m.name}${m.hand ? ' ✋' : ''}`; el.v.srcObject = streams.get(m.userId) || null; return el.wrap; }));
    if (!shown.length) mount(grid, empty(t('room.none')));
    mount(side, v.hasMinors && h('p', { class: 'small muted' }, t('room.under18note')), v.isAuthority && hostPanel(v), memberList(v));
    handBtn.setAttribute('aria-pressed', String(!!v.you.hand));
    refreshButtons();
  }
  const adminPost = (path, body) => action(async () => { await post(`/rooms/${id}/${path}`, body); await rs.poll(); });
  const hostPanel = (v) => h('section', { class: 'pcard' }, h('h3', {}, t('room.waitingList')),
    v.members.filter((m) => m.state === 'waiting').map((m) => h('div', { class: 'row between' }, h('span', {}, m.name), h('span', { class: 'row' }, h('button', { class: 'btn small', onclick: adminPost('admit', { userId: m.userId }) }, t('room.admit')), h('button', { class: 'btn small ghost', onclick: adminPost('deny', { userId: m.userId }) }, t('room.deny'))))),
    h('div', { class: 'row' }, h('button', { class: 'btn small ghost', onclick: adminPost('lock', { locked: !v.locked }) }, v.locked ? t('room.unlock') : t('room.lock')), h('button', { class: 'btn small ghost', onclick: adminPost('mute-all', {}) }, t('room.muteAll')),
      h('button', { class: 'btn small danger', onclick: adminPost('end', {}) }, t('room.end'))),
    v.kind !== 'class' && h('button', { class: 'btn small ghost', onclick: action(async () => { const r = await post(`/rooms/${id}/invites`, { maxUses: 10 }); toast(t('room.inviteShown', { code: r.code })); }) }, t('room.inviteNew')));
  const memberList = (v) => h('section', { class: 'pcard' }, h('h3', {}, t('room.members')), v.members.filter((m) => m.state === 'admitted').map((m) => h('div', { class: 'row between' }, h('span', {}, m.name, m.role !== 'member' ? ` (${m.role})` : ''),
    h('span', { class: 'row' }, v.isAuthority && m.userId !== me.id && [
      h('button', { class: 'btn small ghost', 'data-grant': m.userId, 'aria-pressed': String(!!m.boardOk), title: m.boardOk ? t('board.revoke') : t('board.grant'), onclick: adminPost('board/grant', { userId: m.userId, allowed: !m.boardOk }) }, '✏️'),
      v.kind === 'class' && h('button', { class: 'btn small ghost', title: m.camAllowed ? t('room.denyCam') : t('room.allowCam'), onclick: adminPost('media', { userId: m.userId, cam: !m.camAllowed, mic: !m.camAllowed }) }, m.camAllowed ? '🚫' : '🎥'),
      m.userId !== v.hostId && h('button', { class: 'btn small ghost', onclick: adminPost('kick', { userId: m.userId }) }, t('room.kick'))],
    m.userId !== me.id && h('button', { class: 'btn small ghost', 'aria-label': t('room.report'), onclick: reportUser(m.userId) }, '⚑')))));
  const reportUser = (uid) => action(async () => { await post(`/rooms/${id}/report`, { reason: 'inappropriate', targetUserId: uid }); toast(t('room.reportSent')); });
  const onKey = (e) => {
    if (e.isComposing || e.keyCode === 229 || e.target.matches('input,textarea,select,button') || e.ctrlKey || e.metaKey || e.altKey) return;     // P-04
    if (!document.body.contains(root)) return document.removeEventListener('keydown', onKey);
    const k = e.key.toLowerCase(); if (k === 'm') toggle('mic'); else if (k === 'v') toggle('cam'); else if (k === 'h') handBtn.click();
  };
  document.addEventListener('keydown', onKey);
  const presets = ['hello', 'good_job', 'thanks'].map((k) => h('button', { class: 'btn small ghost', onclick: () => send({ presetKey: k }) }, { hello: '👋', good_job: '🌟', thanks: '💛' }[k]));
  rs.onScreenEnded = () => toggleShare().catch(() => {});
  mount(root, head, banner, stage, grid, pager,
    h('div', { class: 'controls' }, micBtn, camBtn, handBtn, shareBtn, boardBtn, leaveBtn), h('p', { class: 'muted small center' }, t('room.shortcuts')),
    h('div', { class: 'grid c2' }, h('section', { class: 'pcard' }, h('h3', {}, t('room.chat')), chatBox, h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); if (text.value.trim()) { send({ text: text.value }); text.value = ''; } } }, text, h('button', { class: 'btn small', type: 'submit' }, t('room.send'))), h('div', { class: 'row' }, presets)), side));
  rs.start();
  try { if (localStorage.getItem('debug') === '1') window.__rs = rs; } catch { /* bỏ qua */ }
  new MutationObserver((_, o) => { if (!document.body.contains(root)) { rs.stop(); document.removeEventListener('keydown', onKey); o.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
  if (wantCam && first.you?.camAllowed) toggle('cam').catch(() => {});
  return root;
}
