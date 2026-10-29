// useRoomSession (không gắn giao diện): đồng bộ trạng thái phòng bằng sự kiện có seq (resume theo lastSeq, P-12),
// dựng lưới WebRTC (mesh) qua tín hiệu của máy chủ, cleanup ĐÚNG và idempotent (P-08), luôn có đường lui không cam (P-10).
import { get, post } from './api.js';

const MAX_PEERS = 12;
export class RoomSession {
  constructor(roomId, { myId, token, iceServers = [], onState, onEvent, onStream, onScreen, onError }) {
    Object.assign(this, { roomId, myId, token, iceServers, onState, onEvent, onStream, onScreen, onError });
    this.seq = 0; this.pcs = new Map(); this.me = null; this.local = null; this.pollMs = 800; this.stopped = false; this.backoff = 0;
    this.pending = new Map(); this.remotes = new Map(); this.wanted = new Set();      // ICE tới trước khi có remoteDescription
  }
  start() {
    if (this.timer || this.stopped) return this;           // idempotent (Strict Mode / gọi hai lần)
    const loop = async () => {
      if (this.stopped) return;
      try { await this.poll(); this.backoff = 0; } catch (e) { this.backoff = Math.min(8, this.backoff + 1); this.onError?.(e); console.warn('room poll', e?.message || e); }
      if (!this.stopped) this.timer = setTimeout(loop, this.pollMs * (1 + this.backoff));
    };
    this.timer = setTimeout(loop, 0);
    this.renew = setInterval(() => this.refreshToken().catch(() => {}), 8 * 60 * 1000);   // token TTL 10 phút
    return this;
  }
  async refreshToken() { const s = await post(`/rooms/${this.roomId}/token`, {}); this.token = s.token; return s; }
  async poll() {
    const v = await get(`/rooms/${this.roomId}?after=${this.seq}`);
    this.me ||= v.you; this.seq = v.seq; this.state = v; this.screenId = v.screenBy && v.screenBy !== this.myId ? v.screenStream : null;
    for (const e of v.events) { await this.handle(e); this.onEvent?.(e); }
    this.sync(v);
    this.onState?.(v);
  }
  /** Quy tắc mesh: bên có userId nhỏ hơn gửi offer, tránh «glare». */
  sync(v) {
    if (!v.members || v.state === 'ENDED') return;
    // Phòng đông (≤30): chỉ dựng kết nối tới các khung ĐANG HIỆN (this.visible) và giới hạn tổng số kết nối ngang hàng.
    for (const m of v.members) {
      if (m.state !== 'admitted' || m.userId === this.myId || this.pcs.has(m.userId)) continue;
      if (this.visible && !this.visible.has(m.userId)) continue;
      if (this.pcs.size >= MAX_PEERS) break;
      if (this.myId < m.userId) this.connect(m.userId, true).catch(() => {});          // bên id nhỏ hơn luôn là bên gửi offer (không glare)
      else if (!this.wanted.has(m.userId)) { this.wanted.add(m.userId); this.signal(m.userId, 'want', {}).catch(() => this.wanted.delete(m.userId)); }
    }
    for (const id of [...this.pcs.keys()]) if (!v.members.some((m) => m.userId === id && m.state === 'admitted')) this.drop(id);
  }
  pc(peer, initiator = false) {
    let pc = this.pcs.get(peer);
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pcs.set(peer, pc);
    // Chỉ bên gửi offer tự thêm transceiver; bên trả lời dùng m-line của offer (tránh transceiver thừa).
    if (initiator) { pc.addTransceiver('audio', { direction: 'sendrecv' }); pc.addTransceiver('video', { direction: 'sendrecv' }); }
    pc.onicecandidate = (e) => { if (e.candidate) this.signal(peer, 'ice', e.candidate.toJSON()); };
    pc.ontrack = (e) => {                                   // gom audio + video của một peer vào MỘT stream (không ghi đè nhau)
      if (this.screenId && e.streams?.[0]?.id === this.screenId) { this.screenIn = e.streams[0]; this.onScreen?.(e.streams[0]); return; }    // luồng chia sẻ màn hình tách riêng
      let st = this.remotes.get(peer); if (!st) { st = new MediaStream(); this.remotes.set(peer, st); }
      if (!st.getTracks().includes(e.track)) st.addTrack(e.track);
      this.onStream?.(peer, st);
    };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) this.drop(peer, true); };
    pc.onnegotiationneeded = () => this.renegotiate(peer, pc);
    if (this.local) this.attach(pc);
    if (initiator && this.screenTrack) this.addScreen(pc);
    return pc;
  }
  /** Thương lượng lại (khi thêm luồng màn hình sau khi đã nối). Lần nối đầu do connect() lo, nên bỏ qua khi chưa ổn định. */
  async renegotiate(peer, pc) {
    if (this.stopped || pc.signalingState !== 'stable' || !pc.currentRemoteDescription || this.pcs.get(peer) !== pc) return;
    try { const o = await pc.createOffer(); if (pc.signalingState !== 'stable') return; await pc.setLocalDescription(o); await this.signal(peer, 'offer', { type: o.type, sdp: o.sdp }); } catch { /* thử lại ở lần thương lượng sau */ }
  }
  addScreen(pc) {
    if (!this.screenTrack) return;
    const have = pc.getSenders().find((x) => this.screenSenders?.has(x));
    if (have) { have.replaceTrack(this.screenTrack).catch(() => {}); return; }
    const sender = pc.addTrack(this.screenTrack, this.screenStream);
    (this.screenSenders ||= new WeakSet()).add(sender);
  }
  /** Bắt đầu chia sẻ màn hình (người dùng chọn cửa sổ/màn hình trong hộp thoại của trình duyệt). Trả về stream để xem trước. */
  async startScreen() {
    const media = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    const track = media.getVideoTracks()[0]; if (!track) throw new Error('no_screen_track');
    this.screenStream ||= new MediaStream();
    this.screenTrack = track; this.screenStream.getTracks().forEach((x) => this.screenStream.removeTrack(x)); this.screenStream.addTrack(track);
    track.addEventListener('ended', () => { if (this.screenTrack === track) this.onScreenEnded?.(); });     // người dùng bấm «Dừng chia sẻ» của trình duyệt
    try { await post(`/rooms/${this.roomId}/screen`, { on: true, streamId: this.screenStream.id }); }
    catch (e) { track.stop(); this.screenTrack = null; throw e; }
    for (const pc of this.pcs.values()) if (pc.currentRemoteDescription) this.addScreen(pc);
    return this.screenStream;
  }
  async stopScreen() {
    const t = this.screenTrack; this.screenTrack = null;
    if (t) { t.stop(); for (const pc of this.pcs.values()) for (const sd of pc.getSenders()) if (this.screenSenders?.has(sd)) sd.replaceTrack(null).catch(() => {}); }
    await post(`/rooms/${this.roomId}/screen`, { on: false }).catch(() => {});
  }
  async connect(peer, offer) {
    const pc = this.pc(peer, offer);
    if (!offer) return pc;
    const o = await pc.createOffer(); await pc.setLocalDescription(o);
    await this.signal(peer, 'offer', { type: o.type, sdp: o.sdp });
    return pc;
  }
  async signal(to, kind, data) { await post(`/rooms/${this.roomId}/signal`, { to, kind, data, token: this.token }); }
  setVisible(ids) { this.visible = new Set(ids); if (this.state) this.sync(this.state); }
  async handle(e) {
    if (e.kind !== 'signal') return;
    const from = e.actorId, { kind, data } = e.payload;
    if (kind === 'want') { if (!this.pcs.has(from) && this.myId < from) await this.connect(from, true); return; }
    const pc = this.pc(from);
    if (kind === 'offer') {
      if (pc.signalingState === 'have-local-offer') {            // glare: bên id nhỏ hơn giữ offer của mình (impolite), bên kia rollback (polite)
        if (this.myId < from) return;
        await pc.setLocalDescription({ type: 'rollback' });
      }
      await pc.setRemoteDescription(data); await this.flushIce(from, pc);
      const base = this.base(pc); for (const tr of base) if (tr.mid !== null) tr.direction = 'sendrecv';   // mặc định của transceiver tạo từ offer là recvonly
      this.attach(pc);
      const a = await pc.createAnswer(); await pc.setLocalDescription(a); await this.signal(from, 'answer', { type: a.type, sdp: a.sdp });
      if (this.screenTrack && !pc.getSenders().some((x) => this.screenSenders?.has(x))) this.addScreen(pc);      // người chia sẻ là bên trả lời: thêm luồng màn hình SAU khi đã trả lời
    } else if (kind === 'answer') { await pc.setRemoteDescription(data); await this.flushIce(from, pc); }
    else if (kind === 'ice') { if (pc.remoteDescription) await pc.addIceCandidate(data).catch(() => {}); else (this.pending.get(from) || this.pending.set(from, []).get(from)).push(data); }
  }
  async flushIce(peer, pc) { for (const c of this.pending.get(peer) || []) await pc.addIceCandidate(c).catch(() => {}); this.pending.delete(peer); }
  /** Bật/tắt thiết bị: chỉ khi người dùng bấm; thất bại → vẫn ở lại phòng (không cam). Trả { audio, video }. */
  async setDevices({ audio, video }) {
    const want = { audio: !!audio, video: !!video };
    if (!this.local) this.local = new MediaStream();
    for (const kind of ['audio', 'video']) {
      const have = this.local.getTracks().find((t) => t.kind === kind);
      if (want[kind] && !have) {
        try { const s = await navigator.mediaDevices.getUserMedia({ [kind]: true }); const tr = s.getTracks()[0]; this.local.addTrack(tr); }
        catch (e) { want[kind] = false; this.onError?.(Object.assign(e, { media: true })); }
      } else if (!want[kind] && have) { have.stop(); this.local.removeTrack(have); }
    }
    for (const pc of this.pcs.values()) this.attach(pc);
    this.onStream?.('local', this.local);
    return { audio: !!this.local.getAudioTracks().length, video: !!this.local.getVideoTracks().length };
  }
  /** Chỉ audio đầu và video đầu là «cam/mic»; các transceiver sau (màn hình) do addScreen quản lý. */
  base(pc) {
    const trs = pc.getTransceivers(), out = [];
    for (const kind of ['audio', 'video']) { const x = trs.find((t) => t.receiver.track?.kind === kind); if (x) out.push(x); }
    return out;
  }
  attach(pc) {
    for (const tr of this.base(pc)) {
      const kind = tr.receiver.track?.kind; const src = this.local?.getTracks().find((t) => t.kind === kind) || null;
      tr.sender.replaceTrack(src).catch(() => {});
    }
  }
  drop(peer, reconnect = false) {
    const pc = this.pcs.get(peer); if (pc) { pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null; try { pc.close(); } catch { /* đã đóng */ } }
    this.pcs.delete(peer); this.remotes.delete(peer); this.wanted.delete(peer); this.onStream?.(peer, null);
    if (reconnect && !this.stopped && this.myId && this.myId < peer) setTimeout(() => !this.stopped && this.connect(peer, true).catch(() => {}), 1500);
  }
  stop() {
    if (this.stopped) return; this.stopped = true;
    clearTimeout(this.timer); clearInterval(this.renew); this.timer = null;
    for (const id of [...this.pcs.keys()]) this.drop(id);
    this.local?.getTracks().forEach((t) => t.stop()); this.local = null;
    if (this.screenTrack) { this.screenTrack.stop(); this.screenTrack = null; }
  }
}
