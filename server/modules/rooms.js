import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { uuidv7, shortCode } from '../lib/ids.js';
import { sha256hex } from '../lib/crypto.js';
import { ageBand } from '../lib/policy.js';
import { publish } from '../lib/outbox.js';
import { PRESETS } from './social.js';

const PRESENT_MS = 30000, GHOST_MS = 120000, MAX_LIVE_MS = 3 * 3600e3, IDLE_WAITING_MS = 3 * 3600e3, OPEN_BEFORE_MS = 10 * 60000, MAX_ROOMS_PER_TENANT = 20;
const REPORT_REASONS = ['bullying', 'unsafe_contact', 'self_harm', 'inappropriate', 'spam', 'other'];

export function register(r, d) {
  const { db, clock, config, audit, media } = d;
  const now = () => clock.ms();
  const flag = (k) => !!db.get('SELECT enabled FROM feature_flags WHERE key=?', k)?.enabled;
  const person = (id) => { const u = db.get('SELECT id,birth_ym,display_name FROM users WHERE id=?', id); return u ? { id, name: u.display_name, band: ageBand(u.birth_ym, clock.now()) } : null; };
  const hasConsent = (id, tenantId, purpose) => !!db.get("SELECT 1 FROM consents WHERE subject_id=? AND tenant_id=? AND purpose=? AND state='GRANTED' AND (expires_at IS NULL OR expires_at>?)", id, tenantId, purpose, clock.iso());
  const teacherOfClass = (uid, cid) => !!cid && !!db.get("SELECT 1 FROM classes WHERE id=? AND teacher_id=? AND status='active'", cid, uid);
  const memberOfClass = (uid, cid) => !!cid && !!db.get("SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND status='active'", cid, uid);
  const friends = (a, b) => { const [x, y] = a < b ? [a, b] : [b, a]; return !!db.get("SELECT 1 FROM friend_links WHERE user_a=? AND user_b=? AND state='active'", x, y); };
  const blocked = (a, b) => !!db.get('SELECT 1 FROM user_blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)', a, b, b, a);
  const guardianOf = (g, l) => !!db.get("SELECT 1 FROM guardian_links WHERE guardian_id=? AND learner_id=? AND status='active'", g, l);

  const emit = (roomId, kind, { actor = null, to = null, payload = {} } = {}) => {
    const seq = db.get('SELECT COALESCE(MAX(seq),0)+1 AS n FROM room_events WHERE room_id=?', roomId).n;
    db.run('INSERT INTO room_events(room_id,seq,kind,actor_id,to_user,payload,created_at) VALUES(?,?,?,?,?,?,?)', roomId, seq, kind, actor, to, JSON.stringify(payload), clock.iso());
  };
  const setRoom = (room, state, extra = {}) => {
    const cols = Object.keys(extra);
    db.run(`UPDATE rooms SET state=?, last_activity_at=?${cols.map((c) => `, ${c}=?`).join('')} WHERE id=?`, state, clock.iso(), ...cols.map((c) => extra[c]), room.id);
    Object.assign(room, { state, ...extra });
  };
  const members = (rid) => db.all('SELECT m.*, u.display_name AS name, u.birth_ym FROM room_members m JOIN users u ON u.id=m.user_id WHERE m.room_id=? ORDER BY m.joined_at, m.user_id', rid);
  const isAuthority = (room, uid) => room.host_id === uid || teacherOfClass(uid, room.class_id) || db.get("SELECT 1 FROM room_members WHERE room_id=? AND user_id=? AND role='cohost' AND state='admitted'", room.id, uid) !== undefined;
  const present = (m) => m.state === 'admitted' && now() - Date.parse(m.last_seen_at) <= PRESENT_MS;

  /** Cam/mic mặc định theo tuổi (§7.2). Client luôn bắt đầu với cam/mic TẮT bất kể quyền. */
  function mediaDefaults(room, uid, band) {
    if (band === '18p') return { cam: 1, mic: 1 };
    if (room.kind === 'class') return { cam: 0, mic: 0 };                                // giáo viên bật từng em
    const ok = hasConsent(uid, room.tenant_id, 'peer_video') ? 1 : 0;                      // ngang hàng cần consent peer_video của giám hộ
    return { cam: ok, mic: ok };
  }

  /** Phòng chuyển LIVE khi có người hiện diện; nếu có người <18 thì cần người lớn có thẩm quyền hiện diện (§7.2). */
  function recompute(room) {
    if (!['WAITING', 'LIVE'].includes(room.state)) return;
    const pres = members(room.id).filter(present);
    const minors = pres.some((m) => ageBand(m.birth_ym, clock.now()) !== '18p');
    const authority = pres.some((m) => isAuthority(room, m.user_id) || (ageBand(m.birth_ym, clock.now()) === '18p' && pres.some((o) => guardianOf(m.user_id, o.user_id))));
    const ok = pres.length >= 1 && (!minors || authority);
    if (room.state === 'WAITING' && ok) { setRoom(room, 'LIVE', { started_at: room.started_at || clock.iso() }); emit(room.id, 'live'); }
    else if (room.state === 'LIVE' && !ok) {
      setRoom(room, 'WAITING'); emit(room.id, 'paused', { payload: { reason: minors && !authority ? 'no_adult_authority' : 'empty' } });
    }
  }
  /** Dọn «LIVE ma», phòng treo, vượt thời lượng. Idempotent; gọi lười + bởi job. */
  function sweep(room) {
    const t = now();
    if (room.state === 'SCHEDULED' && room.scheduled_for && t >= Date.parse(room.scheduled_for) - OPEN_BEFORE_MS) { setRoom(room, 'WAITING'); emit(room.id, 'opened'); }
    if (room.state === 'LIVE') {
      const anyPresent = members(room.id).some(present);
      if ((!anyPresent && t - Date.parse(room.last_activity_at) > GHOST_MS) || t - Date.parse(room.started_at) > MAX_LIVE_MS) return endRoom(room, 'ghost_or_timeout');
    } else if (room.state === 'WAITING' && t - Date.parse(room.last_activity_at) > IDLE_WAITING_MS) return endRoom(room, 'idle');
    else if (room.state === 'SCHEDULED' && room.scheduled_for && t > Date.parse(room.scheduled_for) + 24 * 3600e3) { setRoom(room, 'CANCELLED'); }
  }
  function stopScreenIf(room, uid) {
    if (room.screen_by && room.screen_by === uid) { db.run('UPDATE rooms SET screen_by=NULL, screen_stream=NULL WHERE id=?', room.id); room.screen_by = null; emit(room.id, 'screen', { actor: uid, payload: { on: false } }); }
  }
  function endRoom(room, why) {
    if (['ENDED', 'CANCELLED'].includes(room.state)) return;
    db.run("UPDATE room_members SET state='left' WHERE room_id=? AND state IN ('admitted','waiting')", room.id);
    setRoom(room, 'ENDED', { ended_at: clock.iso(), screen_by: null, screen_stream: null });
    emit(room.id, 'ended', { payload: { why } });
    media.endRoom(room.provider_room).catch(() => {});
  }
  const loadRoom = (id) => { const x = db.get('SELECT * FROM rooms WHERE id=?', id); if (!x) throw err('NOT_FOUND'); return x; };
  const tickRoom = (id) => db.tx(() => { const room = loadRoom(id); sweep(room); recompute(room); return room; });
  const asMember = (ctx, { admitted = true } = {}) => {
    const room = tickRoom(loadRoom(ctx.params.id).id);                          // quyền truy cập = có bản ghi thành viên (người lớn có thể vào từ tổ chức khác bằng mã mời)
    const me = db.get('SELECT * FROM room_members WHERE room_id=? AND user_id=?', room.id, ctx.user.id);
    const endedRead = !admitted && room.state === 'ENDED' && me && me.state !== 'kicked';     // người đã ở trong phòng vẫn đọc được sự kiện «kết thúc»
    if (!me || (!endedRead && ['left', 'kicked', 'denied'].includes(me.state)) || (admitted && me.state !== 'admitted')) throw err('NOT_FOUND');
    return { room, me };
  };
  const needAuthority = (ctx) => { const x = asMember(ctx); if (!isAuthority(x.room, ctx.user.id)) throw err('FORBIDDEN'); return x; };

  function joinCheck(room, me, viaInvite) {
    const no = (reason) => ({ ok: false, reason });
    // Khác tổ chức chỉ được khi: có mã mời, phòng cá nhân/nhóm, và CẢ HAI là người lớn (phòng người lớn tự tạo). Phòng lớp luôn trong tổ chức.
    if (room.tenant_id !== me.tenantId && !(viaInvite && room.kind !== 'class' && me.ageBand === '18p' && person(room.host_id)?.band === '18p')) return no('tenant');
    if (['ENDED', 'CANCELLED'].includes(room.state)) return no('closed');                  // DI-024
    if (room.state === 'SCHEDULED' && room.host_id !== me.id) return no('not_open');
    const band = me.ageBand, isClass = room.kind === 'class';
    if (band === 'u13' && !(isClass && memberOfClass(me.id, room.class_id))) return no('under13_class_only');
    if (isClass && !(teacherOfClass(me.id, room.class_id) || memberOfClass(me.id, room.class_id))) return no('not_in_class');
    if (!isClass && room.host_id !== me.id && !viaInvite) return no('invite_required');
    if (!isClass && band === '13_17') {
      if (!flag('rooms.peer_minors')) return no('peer_rooms_disabled');                    // chờ rà soát pháp lý (runbook child-safety)
      if (room.host_id !== me.id && !friends(me.id, room.host_id)) return no('not_friend');
    }
    const others = [room.host_id, ...members(room.id).filter((m) => ['admitted', 'waiting'].includes(m.state)).map((m) => m.user_id)];
    for (const oid of new Set(others)) {
      if (oid === me.id) continue;
      if (blocked(me.id, oid)) return no('blocked');
      const o = person(oid);
      if (o && (band === '18p') !== (o.band === '18p')) {
        const related = (isClass && (teacherOfClass(me.id, room.class_id) || memberOfClass(me.id, room.class_id)) && (teacherOfClass(oid, room.class_id) || memberOfClass(oid, room.class_id))) || guardianOf(me.id, oid) || guardianOf(oid, me.id);
        if (!related) return no('adult_minor');
      }
    }
    if (room.locked && !isAuthority(room, me.id)) return no('locked');
    const n = members(room.id).filter((m) => m.state === 'admitted' && m.user_id !== me.id).length;
    if (n >= room.max_people && !isAuthority(room, me.id)) return no('full');
    return { ok: true };
  }
  const denyFor = (reason) => {
    if (reason === 'tenant') return err('NOT_FOUND');
    if (reason === 'closed') return err('INVALID_STATE_TRANSITION', { messageKey: 'error.ROOM_CLOSED' });
    if (reason === 'not_open') return err('INVALID_STATE_TRANSITION', { messageKey: 'error.ROOM_NOT_OPEN' });
    if (reason === 'locked') return err('FORBIDDEN', { messageKey: 'error.ROOM_LOCKED', details: [{ reason }] });
    if (reason === 'full') return err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ROOM_FULL' });
    return err('AGE_POLICY_DENIED', { details: [{ reason }] });
  };

  function view(room, uid, after = 0) {
    const ms = members(room.id), me = ms.find((m) => m.user_id === uid);
    const auth = isAuthority(room, uid), admitted = me?.state === 'admitted';
    const out = {
      id: room.id, kind: room.kind, title: room.title, state: room.state, hostId: room.host_id, classId: room.class_id, locked: !!room.locked, waitingRoom: !!room.waiting_room, maxPeople: room.max_people,
      serverNow: clock.iso(), fallbackUrl: room.fallback_url, isAuthority: auth,
      screenBy: room.screen_by || null, screenStream: room.screen_stream || null, boardOn: !!room.board_on, boardPage: room.board_page,
      you: me ? { role: me.role, state: me.state, camAllowed: !!me.cam_allowed, micAllowed: !!me.mic_allowed && !me.mic_muted_by_host, hand: !!me.hand_up, boardOk: !!me.board_ok } : null,
    };
    if (admitted) {
      out.members = ms.filter((m) => m.state === 'admitted' || (auth && m.state === 'waiting')).map((m) => ({ userId: m.user_id, name: m.name, role: m.role, state: m.state, camAllowed: !!m.cam_allowed, micAllowed: !!m.mic_allowed && !m.mic_muted_by_host, mutedByHost: !!m.mic_muted_by_host, hand: !!m.hand_up, boardOk: !!m.board_ok, present: present(m) }));
      out.hasMinors = ms.some((m) => m.state === 'admitted' && ageBand(m.birth_ym, clock.now()) !== '18p');
    }
    const evs = db.all('SELECT seq,kind,actor_id AS actorId,payload,created_at AS at FROM room_events WHERE room_id=? AND seq>? AND (to_user IS NULL OR to_user=?) ORDER BY seq LIMIT 200', room.id, after, uid)
      .filter((e) => admitted || e.kind === 'admitted' || e.kind === 'denied' || e.kind === 'ended' || e.kind === 'kicked').map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
    out.events = evs; out.seq = db.get('SELECT COALESCE(MAX(seq),0) AS n FROM room_events WHERE room_id=?', room.id).n;
    return out;
  }

  async function tokenFor(room, uid, m) {
    const perms = { canPublish: !!(m.cam_allowed || m.mic_allowed), canPublishAudio: !!m.mic_allowed && !m.mic_muted_by_host, canPublishVideo: !!m.cam_allowed, canPublishData: true, canSubscribe: true };
    try { return await media.issueToken({ roomName: room.provider_room, userId: uid, role: m.role, permissions: perms }); }
    catch { throw err('DEPENDENCY_UNAVAILABLE', { messageKey: 'error.MEDIA_UNAVAILABLE', details: [{ fallbackUrl: room.fallback_url || null }] }); }
  }

  function admit(room, uid, actorId) {
    const p = person(uid);
    const dflt = mediaDefaults(room, uid, p.band);
    db.run("UPDATE room_members SET state='admitted', cam_allowed=?, mic_allowed=?, last_seen_at=? WHERE room_id=? AND user_id=?", dflt.cam, dflt.mic, clock.iso(), room.id, uid);
    emit(room.id, 'admitted', { actor: actorId, payload: { userId: uid, name: p.name } });
  }

  async function joinRoom(ctx, room, viaInvite, invite) {
    const actor = { id: ctx.user.id, tenantId: ctx.actor.tenantId, ageBand: ctx.actor.ageBand };
    const result = db.tx(() => {
      sweep(room);
      const existing = db.get('SELECT * FROM room_members WHERE room_id=? AND user_id=?', room.id, actor.id);
      if (existing?.state === 'kicked' || existing?.state === 'denied') throw err('FORBIDDEN', { messageKey: 'error.ROOM_REMOVED' });
      if (existing && ['admitted', 'waiting'].includes(existing.state)) { db.run('UPDATE room_members SET last_seen_at=? WHERE room_id=? AND user_id=?', clock.iso(), room.id, actor.id); return { state: existing.state }; }  // DI-022
      const chk = joinCheck(room, actor, viaInvite);
      if (!chk.ok) throw denyFor(chk.reason);
      if (actor.ageBand !== '18p' && !hasConsent(actor.id, actor.tenantId, 'account')) throw err('CONSENT_REQUIRED');
      const auth = isAuthority(room, actor.id);
      if (invite) {
        const u = db.run('UPDATE room_invites SET uses=uses+1 WHERE id=? AND uses<max_uses', invite.id).changes;
        if (!u) throw err('NOT_FOUND');
      }
      const role = room.host_id === actor.id ? 'host' : 'member';
      if (existing) db.run("UPDATE room_members SET state='waiting', last_seen_at=? WHERE room_id=? AND user_id=?", clock.iso(), room.id, actor.id);
      else db.run("INSERT INTO room_members(room_id,user_id,role,state,joined_at,last_seen_at) VALUES(?,?,?,'waiting',?,?)", room.id, actor.id, role, clock.iso(), clock.iso());
      const waits = room.waiting_room && !auth && room.kind !== 'class';
      if (waits) { emit(room.id, 'waiting', { payload: { userId: actor.id, name: person(actor.id).name } }); }
      else admit(room, actor.id, actor.id);
      recompute(room);
      return { state: waits ? 'waiting' : 'admitted' };
    });
    if (result.state === 'waiting') return { status: 'WAITING_FOR_HOST', ...view(loadRoom(room.id), actor.id) };
    const m = db.get('SELECT * FROM room_members WHERE room_id=? AND user_id=?', room.id, actor.id);
    const session = await tokenFor(room, actor.id, m);
    return { status: 'ADMITTED', session, ...view(loadRoom(room.id), actor.id) };
  }

  // ---------- API ----------
  r.post('/rooms', {
    action: 'room.create', idem: true, rate: [{ name: 'room_create', by: 'user', limit: 10, windowSec: 600 }],
    body: s.object({ kind: s.enum(['personal', 'group', 'class']), title: s.string({ min: 1, max: 80 }), classId: s.uuid().optional(), waitingRoom: s.boolean().optional(), maxPeople: s.int({ min: 2, max: 30 }).optional(), scheduledFor: s.iso().optional(), fallbackUrl: s.string({ max: 300 }).optional() }),
  }, async (ctx) => {
    if (!flag('rooms')) throw err('FORBIDDEN', { messageKey: 'error.FEATURE_OFF' });
    const a = ctx.actor, b = ctx.body, isTeacher = a.roles.includes('teacher');
    if (a.ageBand === 'u13') throw err('AGE_POLICY_DENIED', { details: [{ reason: 'under13_cannot_create' }] });
    if (b.kind === 'class') { if (!isTeacher || !teacherOfClass(a.id, b.classId)) throw err('AGE_POLICY_DENIED', { details: [{ reason: 'class_room_teacher_only' }] }); }
    else {
      if (isTeacher) throw err('AGE_POLICY_DENIED', { details: [{ reason: 'teacher_class_only' }] });
      if (b.classId) throw err('VALIDATION_ERROR', { details: [{ path: 'classId', code: 'not_allowed' }] });
      if (a.ageBand === '13_17' && !flag('rooms.peer_minors')) throw err('AGE_POLICY_DENIED', { details: [{ reason: 'peer_rooms_disabled' }] });
      if (a.ageBand === '13_17' && !hasConsent(a.id, a.tenantId, 'social')) throw err('CONSENT_REQUIRED');
    }
    if (b.fallbackUrl && !/^https:\/\/[^\s]+$/i.test(b.fallbackUrl)) throw err('VALIDATION_ERROR', { details: [{ path: 'fallbackUrl', code: 'https_only' }] });
    const open = db.get("SELECT COUNT(*) AS n FROM rooms WHERE tenant_id=? AND state IN ('WAITING','LIVE','SCHEDULED')", a.tenantId).n;
    if (open >= MAX_ROOMS_PER_TENANT) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ROOM_LIMIT' });
    let provider;
    try { provider = await media.createRoom(); } catch { throw err('DEPENDENCY_UNAVAILABLE', { messageKey: 'error.MEDIA_UNAVAILABLE' }); }
    const id = uuidv7(), code = b.kind === 'class' ? null : shortCode(8);
    return db.tx(() => {
      const state = b.scheduledFor && Date.parse(b.scheduledFor) > now() + OPEN_BEFORE_MS ? 'SCHEDULED' : 'WAITING';
      db.run(`INSERT INTO rooms(id,tenant_id,kind,title,host_id,class_id,state,waiting_room,max_people,provider,provider_room,fallback_url,scheduled_for,created_at,last_activity_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, a.tenantId, b.kind, b.title, a.id, b.classId ?? null, state, b.waitingRoom === undefined ? (b.kind === 'class' ? 0 : 1) : (b.waitingRoom ? 1 : 0), b.maxPeople ?? config.roomMaxPeople, media.id, provider.providerRoom, b.fallbackUrl ?? null, b.scheduledFor ?? null, clock.iso(), clock.iso());
      db.run("INSERT INTO room_members(room_id,user_id,role,state,cam_allowed,mic_allowed,joined_at,last_seen_at) VALUES(?,?,'host','admitted',?,?,?,?)", id, a.id, 1, 1, clock.iso(), clock.iso());
      if (code) db.run('INSERT INTO room_invites(id,room_id,token_hash,created_by,expires_at,max_uses,created_at) VALUES(?,?,?,?,?,?,?)', uuidv7(), id, sha256hex(code), a.id, new Date(now() + 24 * 3600e3).toISOString(), 20, clock.iso());
      emit(id, 'created', { actor: a.id, payload: { kind: b.kind } });
      audit.write({ tenantId: a.tenantId, actorId: a.id, action: 'room.create', targetType: 'room', targetId: id, diff: { kind: b.kind }, requestId: ctx.requestId });
      return { status: 201, __raw: true, data: { ...view(loadRoom(id), a.id), inviteCode: code } };      // mã chỉ trả một lần; DB giữ băm
    });
  });

  r.get('/rooms', { action: 'room.read' }, (ctx) => {
    const a = ctx.actor;
    const rows = db.all(`SELECT DISTINCT r.* FROM rooms r LEFT JOIN room_members m ON m.room_id=r.id AND m.user_id=? WHERE r.tenant_id=? AND r.state IN ('WAITING','LIVE','SCHEDULED')
      AND (m.state IN ('admitted','waiting') OR (r.kind='class' AND (r.class_id IN (SELECT class_id FROM class_members WHERE user_id=? AND status='active') OR r.host_id=?))) ORDER BY r.created_at DESC LIMIT 50`, a.id, a.tenantId, a.id, a.id);
    return { rooms: rows.map((x) => ({ id: x.id, kind: x.kind, title: x.title, state: x.state, hostName: person(x.host_id)?.name, mine: x.host_id === a.id })) };
  });

  r.post('/rooms/join', { action: 'room.join', idem: true, rate: [{ name: 'room_code', by: 'user', limit: 10, windowSec: 300 }], body: s.object({ code: s.string({ min: 4, max: 12 }) }) }, async (ctx) => {
    const inv = db.get('SELECT * FROM room_invites WHERE token_hash=?', sha256hex(ctx.body.code.trim().toUpperCase()));
    // hết hạn / thu hồi / hết lượt → KHÔNG vào được và không phân biệt lý do (DI-025)
    if (!inv || inv.revoked_at || Date.parse(inv.expires_at) <= now()) throw err('NOT_FOUND');
    const room = loadRoom(inv.room_id);
    const already = db.get('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?', room.id, ctx.user.id);
    if (inv.uses >= inv.max_uses && !already) throw err('NOT_FOUND');
    return joinRoom(ctx, room, true, already ? null : inv);
  });
  r.post('/rooms/:id/join', { action: 'room.join', idem: true }, (ctx) => { const room = loadRoom(ctx.params.id); if (room.tenant_id !== ctx.actor.tenantId) throw err('NOT_FOUND'); return joinRoom(ctx, room, false, null); });

  r.get('/rooms/:id', { action: 'room.read', query: s.object({ after: s.string({ max: 10 }).optional() }, { strict: false }) }, (ctx) => {
    const { room } = asMember(ctx, { admitted: false });
    db.tx(() => { db.run('UPDATE room_members SET last_seen_at=? WHERE room_id=? AND user_id=?', clock.iso(), room.id, ctx.user.id); recompute(room); });
    return view(loadRoom(room.id), ctx.user.id, parseInt(ctx.query.after, 10) || 0);
  });

  r.post('/rooms/:id/token', { action: 'room.interact' }, async (ctx) => { const { room, me } = asMember(ctx); return tokenFor(room, ctx.user.id, me); });   // gia hạn

  r.post('/rooms/:id/signal', {
    action: 'room.interact', rate: [{ name: 'room_signal', by: 'user', limit: 200, windowSec: 10 }],
    body: s.object({ to: s.uuid(), kind: s.enum(['offer', 'answer', 'ice', 'want']), data: s.json({ maxBytes: 12000 }), token: s.string({ max: 600 }) }),
  }, (ctx) => {
    const { room } = asMember(ctx);
    const tk = media.verifyToken(ctx.body.token);
    if (!tk || tk.u !== ctx.user.id) throw err('UNAUTHENTICATED', { messageKey: 'error.MEDIA_TOKEN_INVALID' });
    const peer = db.get("SELECT 1 FROM room_members WHERE room_id=? AND user_id=? AND state='admitted'", room.id, ctx.body.to);
    if (!peer) throw err('NOT_FOUND');
    db.tx(() => emit(room.id, 'signal', { actor: ctx.user.id, to: ctx.body.to, payload: { kind: ctx.body.kind, data: ctx.body.data } }));
    return { ok: true };
  });

  const control = (path, schema, fn, { host = false } = {}) => r.post(`/rooms/:id/${path}`, { action: 'room.manage', idem: true, body: schema }, (ctx) => db.tx(() => {
    const x = needAuthority(ctx);
    if (host && x.room.host_id !== ctx.user.id) throw err('FORBIDDEN');
    const out = fn(ctx, x.room, ctx.body);
    audit.write({ tenantId: x.room.tenant_id, actorId: ctx.user.id, action: `room.${path}`, targetType: 'room', targetId: x.room.id, diff: ctx.body, requestId: ctx.requestId });
    return out ?? view(loadRoom(x.room.id), ctx.user.id);
  }));
  const target = (room, uid, states) => { const m = db.get('SELECT * FROM room_members WHERE room_id=? AND user_id=?', room.id, uid); if (!m || !states.includes(m.state)) throw err('NOT_FOUND'); return m; };
  const U = s.object({ userId: s.uuid() });
  control('admit', U, (ctx, room, b) => { target(room, b.userId, ['waiting']); const chk = joinCheck({ ...room, locked: 0 }, { id: b.userId, tenantId: room.tenant_id, ageBand: person(b.userId).band }, true); if (!chk.ok && chk.reason !== 'full') throw denyFor(chk.reason); admit(room, b.userId, ctx.user.id); recompute(room); });
  control('deny', U, (ctx, room, b) => { target(room, b.userId, ['waiting']); db.run("UPDATE room_members SET state='denied' WHERE room_id=? AND user_id=?", room.id, b.userId); emit(room.id, 'denied', { actor: ctx.user.id, payload: { userId: b.userId } }); });
  control('kick', U, (ctx, room, b) => {
    if (b.userId === room.host_id || b.userId === ctx.user.id) throw err('BUSINESS_RULE_VIOLATION');
    target(room, b.userId, ['admitted', 'waiting']); db.run("UPDATE room_members SET state='kicked' WHERE room_id=? AND user_id=?", room.id, b.userId);
    stopScreenIf(room, b.userId); emit(room.id, 'kicked', { actor: ctx.user.id, payload: { userId: b.userId } }); media.removeParticipant({ roomName: room.provider_room, userId: b.userId }).catch(() => {}); recompute(room);
  });
  control('lock', s.object({ locked: s.boolean() }), (ctx, room, b) => { db.run('UPDATE rooms SET locked=? WHERE id=?', b.locked ? 1 : 0, room.id); emit(room.id, b.locked ? 'locked' : 'unlocked', { actor: ctx.user.id }); });
  control('mute-all', s.object({}), (ctx, room) => { db.run("UPDATE room_members SET mic_muted_by_host=1 WHERE room_id=? AND role='member' AND state='admitted'", room.id); emit(room.id, 'mute_all', { actor: ctx.user.id }); });
  control('mute', s.object({ userId: s.uuid(), muted: s.boolean() }), (ctx, room, b) => { target(room, b.userId, ['admitted']); db.run('UPDATE room_members SET mic_muted_by_host=? WHERE room_id=? AND user_id=?', b.muted ? 1 : 0, room.id, b.userId); emit(room.id, 'mute', { actor: ctx.user.id, payload: { userId: b.userId, muted: b.muted } }); });
  control('media', s.object({ userId: s.uuid(), cam: s.boolean(), mic: s.boolean() }), (ctx, room, b) => {
    const m = target(room, b.userId, ['admitted']); const band = person(b.userId).band;
    // Chỉ lớp (giáo viên) được bật cam/mic cho người dưới 18; phòng ngang hàng phụ thuộc consent peer_video.
    if (band !== '18p' && room.kind !== 'class') throw err('FORBIDDEN', { messageKey: 'error.ROOM_MEDIA_BY_CONSENT' });
    db.run('UPDATE room_members SET cam_allowed=?, mic_allowed=? WHERE room_id=? AND user_id=?', b.cam ? 1 : 0, b.mic ? 1 : 0, room.id, m.user_id);
    emit(room.id, 'media', { actor: ctx.user.id, payload: { userId: b.userId, cam: b.cam, mic: b.mic } });
    media.updatePermissions({ roomName: room.provider_room, userId: b.userId, cam: b.cam, mic: b.mic }).catch(() => {});
  });
  control('cohost', U, (ctx, room, b) => { const m = target(room, b.userId, ['admitted']); if (person(b.userId).band !== '18p' && room.kind !== 'class') throw err('FORBIDDEN'); if (person(b.userId).band !== '18p') throw err('FORBIDDEN', { messageKey: 'error.ROOM_COHOST_ADULT' }); db.run("UPDATE room_members SET role='cohost' WHERE room_id=? AND user_id=?", room.id, m.user_id); emit(room.id, 'cohost', { actor: ctx.user.id, payload: { userId: b.userId } }); }, { host: true });
  control('end', s.object({}), (ctx, room) => { endRoom(room, 'host_ended'); });
  control('invites', s.object({ expiresMin: s.int({ min: 5, max: 1440 }).optional(), maxUses: s.int({ min: 1, max: 50 }).optional() }), (ctx, room, b) => {
    if (room.kind === 'class') throw err('BUSINESS_RULE_VIOLATION');
    const code = shortCode(8), id = uuidv7();
    db.run('INSERT INTO room_invites(id,room_id,token_hash,created_by,expires_at,max_uses,created_at) VALUES(?,?,?,?,?,?,?)', id, room.id, sha256hex(code), ctx.user.id, new Date(now() + (b.expiresMin ?? 60) * 60000).toISOString(), b.maxUses ?? 10, clock.iso());
    return { inviteId: id, code };
  });
  control('invites/revoke', s.object({ inviteId: s.uuid() }), (ctx, room, b) => { if (!db.run('UPDATE room_invites SET revoked_at=? WHERE id=? AND room_id=? AND revoked_at IS NULL', clock.iso(), b.inviteId, room.id).changes) throw err('NOT_FOUND'); return { revoked: true }; });

  // ---------- Chia sẻ bài giảng: bảng trắng + màn hình ----------
  const MAX_STROKES = 3000, MAX_PAGES = 20;
  const adult = (uid) => person(uid)?.band === '18p';
  const canDraw = (room, uid) => isAuthority(room, uid) || !!db.get("SELECT 1 FROM room_members WHERE room_id=? AND user_id=? AND state='admitted' AND board_ok=1", room.id, uid);
  const num01 = s.number({ min: 0, max: 1 });
  const needLive = (room) => { if (room.state !== 'LIVE' && room.state !== 'WAITING') throw err('INVALID_STATE_TRANSITION', { messageKey: 'error.ROOM_CLOSED' }); };

  r.get('/rooms/:id/board', { action: 'room.read', query: s.object({ page: s.string({ max: 3 }).optional() }, { strict: false }) }, (ctx) => {
    const { room } = asMember(ctx);
    const page = Math.min(MAX_PAGES - 1, Math.max(0, parseInt(ctx.query.page ?? room.board_page, 10) || 0));
    const strokes = db.all('SELECT n,user_id AS by,payload FROM room_board_strokes WHERE room_id=? AND page=? ORDER BY n', room.id, page).map((x) => ({ n: x.n, by: x.by, ...JSON.parse(x.payload) }));
    return { page, boardOn: !!room.board_on, current: room.board_page, strokes };
  });

  r.post('/rooms/:id/board/stroke', {
    action: 'room.interact', rate: [{ name: 'board_stroke', by: 'user', limit: 80, windowSec: 10 }],
    body: s.object({ page: s.int({ min: 0, max: MAX_PAGES - 1 }), tool: s.enum(['pen', 'highlighter', 'eraser']), color: s.string({ pattern: /^#[0-9a-fA-F]{6}$/ }), width: s.int({ min: 1, max: 40 }), pts: s.array(num01, { min: 2, max: 600 }) }),
  }, (ctx) => db.tx(() => {
    const { room } = asMember(ctx); needLive(room);
    if (!room.board_on) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.BOARD_OFF' });
    if (!canDraw(room, ctx.user.id)) throw err('FORBIDDEN', { messageKey: 'error.BOARD_READONLY' });
    const b = ctx.body;
    if (b.pts.length % 2) throw err('VALIDATION_ERROR', { details: [{ path: 'pts', code: 'even' }] });
    if (db.get('SELECT COUNT(*) AS n FROM room_board_strokes WHERE room_id=?', room.id).n >= MAX_STROKES) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.BOARD_FULL' });
    const n = db.get('SELECT COALESCE(MAX(n),0)+1 AS n FROM room_board_strokes WHERE room_id=?', room.id).n;
    const body = { tool: b.tool, c: b.color.toLowerCase(), w: b.width, pts: b.pts.map((v) => Math.round(v * 10000) / 10000) };
    db.run('INSERT INTO room_board_strokes(room_id,n,page,user_id,payload,created_at) VALUES(?,?,?,?,?,?)', room.id, n, b.page, ctx.user.id, JSON.stringify(body), clock.iso());
    emit(room.id, 'board', { actor: ctx.user.id, payload: { op: 'stroke', n, page: b.page, by: ctx.user.id, ...body } });
    db.run('UPDATE rooms SET last_activity_at=? WHERE id=?', clock.iso(), room.id);
    return { n };
  }));
  r.post('/rooms/:id/board/undo', { action: 'room.interact', rate: [{ name: 'board_undo', by: 'user', limit: 30, windowSec: 10 }], body: s.object({ page: s.int({ min: 0, max: MAX_PAGES - 1 }) }) }, (ctx) => db.tx(() => {
    const { room } = asMember(ctx); needLive(room);
    if (!canDraw(room, ctx.user.id)) throw err('FORBIDDEN', { messageKey: 'error.BOARD_READONLY' });
    const auth = isAuthority(room, ctx.user.id);       // người được cấp quyền chỉ hoàn tác nét của chính mình
    const row = auth ? db.get('SELECT n FROM room_board_strokes WHERE room_id=? AND page=? ORDER BY n DESC LIMIT 1', room.id, ctx.body.page)
      : db.get('SELECT n FROM room_board_strokes WHERE room_id=? AND page=? AND user_id=? ORDER BY n DESC LIMIT 1', room.id, ctx.body.page, ctx.user.id);
    if (!row) return { undone: false };
    db.run('DELETE FROM room_board_strokes WHERE room_id=? AND n=?', room.id, row.n);
    emit(room.id, 'board', { actor: ctx.user.id, payload: { op: 'undo', n: row.n, page: ctx.body.page } });
    return { undone: true };
  }));
  control('board/open', s.object({ on: s.boolean() }), (ctx, room, b) => { needLive(room); db.run('UPDATE rooms SET board_on=? WHERE id=?', b.on ? 1 : 0, room.id); emit(room.id, 'board', { actor: ctx.user.id, payload: { op: 'open', on: b.on } }); });
  control('board/page', s.object({ page: s.int({ min: 0, max: MAX_PAGES - 1 }) }), (ctx, room, b) => { needLive(room); db.run('UPDATE rooms SET board_page=? WHERE id=?', b.page, room.id); emit(room.id, 'board', { actor: ctx.user.id, payload: { op: 'page', page: b.page } }); });
  control('board/clear', s.object({ page: s.int({ min: 0, max: MAX_PAGES - 1 }) }), (ctx, room, b) => { needLive(room); db.run('DELETE FROM room_board_strokes WHERE room_id=? AND page=?', room.id, b.page); emit(room.id, 'board', { actor: ctx.user.id, payload: { op: 'clear', page: b.page } }); });
  control('board/grant', s.object({ userId: s.uuid(), allowed: s.boolean() }), (ctx, room, b) => {
    target(room, b.userId, ['admitted']); db.run('UPDATE room_members SET board_ok=? WHERE room_id=? AND user_id=?', b.allowed ? 1 : 0, room.id, b.userId);
    emit(room.id, 'board', { actor: ctx.user.id, payload: { op: 'grant', userId: b.userId, allowed: b.allowed } });
  });
  control('board/grant-all', s.object({ allowed: s.boolean() }), (ctx, room, b) => {
    db.run("UPDATE room_members SET board_ok=? WHERE room_id=? AND state='admitted'", b.allowed ? 1 : 0, room.id);
    emit(room.id, 'board', { actor: ctx.user.id, payload: { op: 'grant_all', allowed: b.allowed } });
  });
  /** Chia sẻ màn hình: chỉ người LỚN có thẩm quyền; một người chia sẻ một lúc; media đi P2P (máy chủ chỉ giữ trạng thái + id luồng). */
  control('screen', s.object({ on: s.boolean(), streamId: s.string({ max: 64, pattern: /^[A-Za-z0-9{}_.\-]{4,64}$/ }).optional() }), (ctx, room, b) => {
    needLive(room);
    if (!adult(ctx.user.id)) throw err('AGE_POLICY_DENIED', { details: [{ reason: 'screen_share_adults_only' }] });
    if (b.on) {
      if (!b.streamId) throw err('VALIDATION_ERROR', { details: [{ path: 'streamId', code: 'required' }] });
      if (room.screen_by && room.screen_by !== ctx.user.id) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.SCREEN_BUSY' });
      db.run('UPDATE rooms SET screen_by=?, screen_stream=? WHERE id=?', ctx.user.id, b.streamId, room.id);
      emit(room.id, 'screen', { actor: ctx.user.id, payload: { on: true, streamId: b.streamId, name: person(ctx.user.id).name } });
    } else {
      if (room.screen_by && room.screen_by !== ctx.user.id && room.host_id !== ctx.user.id) throw err('FORBIDDEN');     // chủ phòng được dừng chia sẻ của người khác
      db.run('UPDATE rooms SET screen_by=NULL, screen_stream=NULL WHERE id=?', room.id);
      emit(room.id, 'screen', { actor: ctx.user.id, payload: { on: false } });
    }
    room.screen_by = b.on ? ctx.user.id : null;
  });

  r.post('/rooms/:id/hand', { action: 'room.interact', idem: true, body: s.object({ up: s.boolean() }) }, (ctx) => db.tx(() => {
    const { room } = asMember(ctx);
    db.run('UPDATE room_members SET hand_up=? WHERE room_id=? AND user_id=?', ctx.body.up ? 1 : 0, room.id, ctx.user.id);
    emit(room.id, 'hand', { actor: ctx.user.id, payload: { userId: ctx.user.id, up: ctx.body.up } }); return { ok: true };
  }));
  r.post('/rooms/:id/chat', { action: 'room.interact', rate: [{ name: 'room_chat', by: 'user', limit: 20, windowSec: 10 }], body: s.object({ text: s.string({ max: 300 }).optional(), presetKey: s.string({ max: 30 }).optional() }) }, (ctx) => db.tx(() => {
    const { room } = asMember(ctx);
    const minors = members(room.id).some((m) => m.state === 'admitted' && ageBand(m.birth_ym, clock.now()) !== '18p');
    const b = ctx.body;
    let text;
    if (b.presetKey) { const p = PRESETS[b.presetKey]; if (!p) throw err('VALIDATION_ERROR', { details: [{ path: 'presetKey', code: 'unknown' }] }); text = p.vi; }
    else {
      if (minors) throw err('FORBIDDEN', { messageKey: 'error.ROOM_PRESET_ONLY' });          // phòng có người <18: chỉ câu soạn sẵn (kiểm duyệt theo tuổi)
      text = (b.text || '').trim(); if (!text) throw err('VALIDATION_ERROR', { details: [{ path: 'text', code: 'string.min' }] });
    }
    emit(room.id, 'chat', { actor: ctx.user.id, payload: { name: person(ctx.user.id).name, text, preset: b.presetKey || null } });
    return { ok: true };
  }));
  r.post('/rooms/:id/leave', { action: 'room.interact', idem: true }, (ctx) => db.tx(() => {
    const { room } = asMember(ctx, { admitted: false });
    if (room.host_id === ctx.user.id && room.kind !== 'class') { /* chủ phòng rời: phòng vẫn mở cho người khác cho tới khi hết giờ/ghost */ }
    db.run("UPDATE room_members SET state='left', hand_up=0 WHERE room_id=? AND user_id=?", room.id, ctx.user.id);
    stopScreenIf(room, ctx.user.id);
    emit(room.id, 'left', { actor: ctx.user.id, payload: { userId: ctx.user.id } }); recompute(room); return { left: true };
  }));
  r.post('/rooms/:id/report', { action: 'room.interact', idem: true, rate: [{ name: 'report', by: 'user', limit: 20, windowSec: 3600 }], body: s.object({ reason: s.enum(REPORT_REASONS), targetUserId: s.uuid().optional(), note: s.string({ max: 300 }).optional() }) }, (ctx) => db.tx(() => {
    const { room } = asMember(ctx, { admitted: false });
    const tgt = ctx.body.targetUserId || room.host_id;
    if (!db.get('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?', room.id, tgt)) throw err('NOT_FOUND');
    const evidence = { note: ctx.body.note ?? null, at: clock.iso(), room: { id: room.id, kind: room.kind, title: room.title }, members: members(room.id).map((m) => ({ userId: m.user_id, name: m.name, role: m.role, state: m.state })),
      recentChat: db.all("SELECT actor_id AS userId, payload, created_at AS at FROM room_events WHERE room_id=? AND kind='chat' ORDER BY seq DESC LIMIT 10", room.id).map((e) => ({ ...e, payload: JSON.parse(e.payload) })) };
    const severity = ctx.body.reason === 'self_harm' ? 3 : ctx.body.reason === 'unsafe_contact' ? 2 : 1, id = uuidv7();
    db.run("INSERT INTO reports(id,tenant_id,reporter_id,target_type,target_id,reason,evidence,severity,state,sla_due_at,created_at) VALUES(?,?,?,'user',?,?,?,?,'RECEIVED',?,?)", id, room.tenant_id, ctx.user.id, tgt, ctx.body.reason, JSON.stringify(evidence), severity, new Date(now() + ({ 1: 24, 2: 4, 3: 1 }[severity]) * 3600e3).toISOString(), clock.iso());
    if (severity >= 2) db.run("UPDATE reports SET state='ESCALATED' WHERE id=? AND state='RECEIVED'", id);
    publish(db, clock, { aggregateType: 'report', aggregateId: id, type: 'report.created', payload: { reportId: id, tenantId: room.tenant_id, severity } });
    return { reportId: id };
  }));

  // Webhook media: chữ ký trên raw body + khử trùng; điểm danh dựa trên SỰ KIỆN ĐÃ KÝ, không dựa trên việc tạo phòng.
  r.post('/webhooks/media', {
    auth: 'public', rawBodyBuffer: true, rate: [{ name: 'webhook', by: 'ip', limit: 120, windowSec: 60 }],
    body: s.object({ eventId: s.string({ min: 1, max: 100 }), type: s.enum(['participant_joined', 'participant_left']), roomName: s.string({ max: 80 }), userId: s.uuid() }),
  }, (ctx) => {
    if (!media.verifyWebhook(ctx.rawBuffer, ctx.headers)) throw err('UNAUTHENTICATED');
    const b = ctx.body;
    return db.tx(() => {
      if (!db.run('INSERT OR IGNORE INTO webhook_inbox(provider,event_id,received_at,payload) VALUES(?,?,?,?)', 'media', b.eventId, clock.iso(), JSON.stringify(b)).changes) return { duplicate: true };
      const room = db.get('SELECT * FROM rooms WHERE provider_room=?', b.roomName);
      if (room && db.get('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?', room.id, b.userId)) emit(room.id, 'attendance', { actor: b.userId, payload: { type: b.type } });
      db.run('UPDATE webhook_inbox SET processed_at=? WHERE provider=? AND event_id=?', clock.iso(), 'media', b.eventId);
      return { processed: true };
    });
  });

  return { sweepAll: () => { let n = 0; for (const x of db.all("SELECT id FROM rooms WHERE state IN ('SCHEDULED','WAITING','LIVE')")) { tickRoom(x.id); n++; } return n; } };
}
