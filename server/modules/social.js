import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { ageBand, canInteract } from '../lib/policy.js';
import { publish } from '../lib/outbox.js';

export const PRESETS = {
  hello: { vi: 'Xin chào! 👋', en: 'Hello! 👋' }, good_job: { vi: 'Giỏi lắm! 🌟', en: 'Great job! 🌟' }, lets_study: { vi: 'Cùng học nhé! 📚', en: "Let's study together! 📚" },
  thanks: { vi: 'Cảm ơn bạn! 💛', en: 'Thank you! 💛' }, see_you: { vi: 'Hẹn gặp lại! 👋', en: 'See you! 👋' }, need_help: { vi: 'Mình cần giúp một chút.', en: 'I need a little help.' },
  nice_try: { vi: 'Cố lên, bạn làm được! 💪', en: 'Keep going, you can do it! 💪' }, smile: { vi: '😊', en: '😊' },
};
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/, LINK_RE = /(https?:\/\/|www\.|\b[\w-]+\.(com|net|org|vn|io|me)\b|@\w{3,})/i;
const SELF_HARM_RE = /(kill myself|suicide|want to die|self[- ]?harm|tự tử|muốn chết|tự hại|không muốn sống)/i;
const SLA_HOURS = { 1: 24, 2: 4, 3: 1 }; // GIẢ THUYẾT (BASELINE_PENDING)
export const FRIEND_REQ_PER_DAY = 10;

export function register(r, d) {
  const { db, clock, config, audit } = d;

  const flagOn = (key) => !!db.get('SELECT enabled FROM feature_flags WHERE key=?', key)?.enabled;
  const person = (id, tenantId) => {
    const u = db.get('SELECT id,birth_ym,display_name,status FROM users WHERE id=?', id);
    if (!u || u.status !== 'active') return null;
    const roles = db.all("SELECT role FROM memberships WHERE user_id=? AND tenant_id=? AND status='active'", id, tenantId).map((x) => x.role);
    return { id, tenantId, ageBand: ageBand(u.birth_ym, clock.now()), role: roles.includes('teacher') ? 'teacher' : 'learner', roles, name: u.display_name, inTenant: roles.length > 0 };
  };
  const blocked = (a, b) => !!db.get('SELECT 1 FROM user_blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)', a, b, b, a); // HAI CHIỀU
  const guardianOff = (...ids) => ids.some((id) => !!db.get("SELECT 1 FROM guardian_links WHERE learner_id=? AND status='active' AND messaging_enabled=0", id));
  const hasConsent = (id, tenantId, purpose) => !!db.get("SELECT 1 FROM consents WHERE subject_id=? AND tenant_id=? AND purpose=? AND state='GRANTED' AND (expires_at IS NULL OR expires_at>?)", id, tenantId, purpose, clock.iso());
  const needsConsent = (p) => p.ageBand !== '18p';
  const pair = (a, b) => (a < b ? [a, b] : [b, a]);
  const sharedClass = (a, b) => !!db.get("SELECT 1 FROM class_members x JOIN class_members y ON y.class_id=x.class_id AND y.status='active' WHERE x.user_id=? AND y.user_id=? AND x.status='active'", a, b)
    || !!db.get("SELECT 1 FROM classes c JOIN class_members m ON m.class_id=c.id AND m.status='active' WHERE (c.teacher_id=? AND m.user_id=?) OR (c.teacher_id=? AND m.user_id=?)", a, b, b, a);

  // ---------- hồ sơ ----------
  const profileView = (uid) => {
    const p = db.get('SELECT * FROM profiles WHERE user_id=?', uid);
    const u = db.get('SELECT display_name,friend_code FROM users WHERE id=?', uid);
    return { displayName: u.display_name, friendCode: u.friend_code, avatarKey: p.avatar_key, hatKey: p.hat_key, bio: p.bio, goal: p.goal, privacy: JSON.parse(p.privacy), inventory: db.all('SELECT item_id AS itemId FROM inventory_items WHERE user_id=?', uid).map((x) => x.itemId), stickers: db.get('SELECT COUNT(*) AS n FROM sticker_collection WHERE user_id=?', uid).n };
  };
  r.get('/social/profile', { action: 'social.profile' }, (ctx) => profileView(ctx.user.id));
  r.patch('/social/profile', { action: 'social.profile', body: s.object({ avatarKey: s.string({ max: 40 }).optional(), hatKey: s.string({ max: 40 }).nullable().optional(), bio: s.string({ max: 140 }).optional(), goal: s.string({ max: 30 }).optional(), privacy: s.object({ show_streak: s.boolean().optional(), show_badges: s.boolean().optional() }).optional() }) }, (ctx) => {
    const b = ctx.body, uid = ctx.user.id;
    const owned = (k) => k === 'av-fox' || !!db.get('SELECT 1 FROM inventory_items WHERE user_id=? AND item_id=?', uid, k);
    if (b.avatarKey && !owned(b.avatarKey)) throw err('FORBIDDEN', { messageKey: 'error.NOT_OWNED' });
    if (b.hatKey && !owned(b.hatKey)) throw err('FORBIDDEN', { messageKey: 'error.NOT_OWNED' });
    if (b.bio !== undefined && ctx.actor.ageBand !== '18p') throw err('AGE_POLICY_DENIED', { messageKey: 'error.NO_BIO_UNDER_18' }); // không văn bản tự do công khai cho < 18
    const cur = JSON.parse(db.get('SELECT privacy FROM profiles WHERE user_id=?', uid).privacy);
    db.run('UPDATE profiles SET avatar_key=COALESCE(?,avatar_key), hat_key=CASE WHEN ? THEN ? ELSE hat_key END, bio=COALESCE(?,bio), goal=COALESCE(?,goal), privacy=? WHERE user_id=?',
      b.avatarKey ?? null, b.hatKey !== undefined ? 1 : 0, b.hatKey ?? null, b.bio ?? null, b.goal ?? null, JSON.stringify({ ...cur, ...(b.privacy || {}) }), uid);
    return profileView(uid);
  });

  // ---------- bạn bè (không có tìm kiếm công khai; chỉ mã bạn bè) ----------
  const friendCard = (id) => {
    const u = db.get('SELECT display_name FROM users WHERE id=?', id), p = db.get('SELECT avatar_key,hat_key,privacy FROM profiles WHERE user_id=?', id);
    const priv = JSON.parse(p?.privacy || '{}');
    return { id, displayName: u.display_name, avatarKey: p?.avatar_key, hatKey: p?.hat_key, streak: priv.show_streak ? db.get('SELECT current FROM streaks WHERE user_id=?', id)?.current ?? 0 : null };
  };
  r.get('/social/friends', { action: 'social.profile' }, (ctx) => {
    const rows = db.all("SELECT * FROM friend_links WHERE (user_a=? OR user_b=?) AND state IN ('pending','active') AND tenant_id=?", ctx.user.id, ctx.user.id, ctx.actor.tenantId);
    const other = (x) => (x.user_a === ctx.user.id ? x.user_b : x.user_a);
    return {
      friends: rows.filter((x) => x.state === 'active' && !blocked(ctx.user.id, other(x))).map((x) => friendCard(other(x))),
      incoming: rows.filter((x) => x.state === 'pending' && x.requested_by !== ctx.user.id).map((x) => friendCard(other(x))),
      outgoing: rows.filter((x) => x.state === 'pending' && x.requested_by === ctx.user.id).map((x) => friendCard(other(x))),
    };
  });

  r.post('/social/friend-requests', {
    action: 'social.friend_request', body: s.object({ code: s.string({ min: 4, max: 12 }) }),
    rate: [{ name: 'friendreq-day', by: 'user', limit: FRIEND_REQ_PER_DAY, windowSec: 86400 }, { name: 'friendreq-min', by: 'user', limit: 5, windowSec: 60 }],
  }, (ctx) => db.tx(() => {
    if (!flagOn('social.friends')) throw err('FORBIDDEN', { messageKey: 'error.FEATURE_OFF' });
    const me = person(ctx.user.id, ctx.actor.tenantId);
    const t = db.get('SELECT id FROM users WHERE friend_code=?', ctx.body.code.toUpperCase());
    const them = t && person(t.id, ctx.actor.tenantId);
    const miss = () => err('NOT_FOUND', { messageKey: 'error.FRIEND_CODE_NOT_FOUND' }); // không lộ lý do (kể cả bị chặn/tuổi/khác tổ chức)
    if (!them || !them.inTenant) throw miss();
    if (them.id === me.id) throw err('VALIDATION_ERROR', { details: [{ path: 'code', code: 'self' }] });
    if (needsConsent(them) && !hasConsent(them.id, them.tenantId, 'social')) throw miss();
    const dec = canInteract(me, them, 'friend', { blocked: blocked(me.id, them.id), guardianMessagingOff: guardianOff(me.id, them.id) });
    if (!dec.allowed) throw miss();
    const [a, b] = pair(me.id, them.id);
    const ex = db.get('SELECT * FROM friend_links WHERE user_a=? AND user_b=?', a, b);
    if (ex && ex.state === 'active') throw err('CONFLICT', { messageKey: 'error.ALREADY_FRIENDS' });
    if (ex && ex.state === 'pending') {
      if (ex.requested_by !== me.id) { // họ đã gửi trước → chấp nhận luôn
        db.run("UPDATE friend_links SET state='active', updated_at=? WHERE user_a=? AND user_b=? AND state='pending'", clock.iso(), a, b);
        ensureDm(me, them);
        return { state: 'active' };
      }
      return { state: 'pending' };
    }
    if (ex) db.run("UPDATE friend_links SET state='pending', requested_by=?, updated_at=? WHERE user_a=? AND user_b=?", me.id, clock.iso(), a, b);
    else db.run("INSERT INTO friend_links(tenant_id,user_a,user_b,state,requested_by,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?)", ctx.actor.tenantId, a, b, me.id, clock.iso(), clock.iso());
    db.run('INSERT INTO notifications(id,tenant_id,user_id,kind,params,created_at) VALUES(?,?,?,?,?,?)', uuidv7(), ctx.actor.tenantId, them.id, 'friend_request', JSON.stringify({ from: me.name }), clock.iso());
    return { state: 'pending' };
  }));

  function ensureDm(a, b) {
    const ref = pair(a.id, b.id).join(':');
    let ch = db.get("SELECT id FROM chat_channels WHERE kind='dm' AND ref_id=?", ref);
    if (!ch) {
      const id = uuidv7();
      db.run("INSERT INTO chat_channels(id,tenant_id,kind,ref_id,created_at) VALUES(?,?,'dm',?,?)", id, a.tenantId, ref, clock.iso());
      for (const u of [a.id, b.id]) db.run("INSERT INTO channel_members(tenant_id,channel_id,user_id,role) VALUES(?,?,?,'member')", a.tenantId, id, u);
      ch = { id };
    }
    return ch.id;
  }

  r.post('/social/friend-requests/:userId/respond', { action: 'social.friend_respond', body: s.object({ accept: s.boolean() }) }, (ctx) => db.tx(() => {
    const [a, b] = pair(ctx.user.id, ctx.params.userId);
    const row = db.get("SELECT * FROM friend_links WHERE user_a=? AND user_b=? AND state='pending' AND requested_by<>? AND tenant_id=?", a, b, ctx.user.id, ctx.actor.tenantId);
    if (!row) throw err('NOT_FOUND');
    const me = person(ctx.user.id, ctx.actor.tenantId), them = person(ctx.params.userId, ctx.actor.tenantId);
    if (ctx.body.accept) {
      if (!them || !canInteract(me, them, 'friend', { blocked: blocked(me.id, them.id), guardianMessagingOff: guardianOff(me.id, them.id) }).allowed) throw err('NOT_FOUND');
      db.run("UPDATE friend_links SET state='active', updated_at=? WHERE user_a=? AND user_b=? AND state='pending'", clock.iso(), a, b);
      ensureDm(me, them);
    } else db.run("UPDATE friend_links SET state='removed', updated_at=? WHERE user_a=? AND user_b=? AND state='pending'", clock.iso(), a, b);
    return { state: ctx.body.accept ? 'active' : 'removed' };
  }));
  r.delete('/social/friends/:userId', { action: 'social.profile' }, (ctx) => {
    const [a, b] = pair(ctx.user.id, ctx.params.userId);
    const n = db.run("UPDATE friend_links SET state='removed', updated_at=? WHERE user_a=? AND user_b=? AND state IN ('active','pending') AND tenant_id=?", clock.iso(), a, b, ctx.actor.tenantId).changes;
    if (!n) throw err('NOT_FOUND');
    return { removed: true };
  });

  // ---------- chặn (hai chiều) ----------
  r.get('/social/blocks', { action: 'social.block' }, (ctx) => ({ blocks: db.all('SELECT blocked_id AS id FROM user_blocks WHERE blocker_id=? AND tenant_id=?', ctx.user.id, ctx.actor.tenantId).map((x) => friendCard(x.id)) }));
  r.post('/social/blocks', { action: 'social.block', body: s.object({ userId: s.uuid() }) }, (ctx) => db.tx(() => {
    if (ctx.body.userId === ctx.user.id) throw err('VALIDATION_ERROR', { details: [{ path: 'userId', code: 'self' }] });
    const other = person(ctx.body.userId, ctx.actor.tenantId);
    if (!other || !other.inTenant) throw err('NOT_FOUND');
    db.run('INSERT OR IGNORE INTO user_blocks(tenant_id,blocker_id,blocked_id,created_at) VALUES(?,?,?,?)', ctx.actor.tenantId, ctx.user.id, other.id, clock.iso());
    const [a, b] = pair(ctx.user.id, other.id);
    db.run("UPDATE friend_links SET state='removed', updated_at=? WHERE user_a=? AND user_b=? AND state IN ('active','pending')", clock.iso(), a, b);
    audit.write({ tenantId: ctx.actor.tenantId, actorId: ctx.user.id, action: 'social.block', targetType: 'user', targetId: other.id, requestId: ctx.requestId });
    return { blocked: true };
  }));
  r.delete('/social/blocks/:userId', { action: 'social.block' }, (ctx) => {
    const n = db.run('DELETE FROM user_blocks WHERE blocker_id=? AND blocked_id=? AND tenant_id=?', ctx.user.id, ctx.params.userId, ctx.actor.tenantId).changes;
    if (!n) throw err('NOT_FOUND');
    return { unblocked: true };
  });

  // ---------- kênh & tin nhắn ----------
  r.get('/social/channels', { action: 'social.message_read' }, (ctx) => {
    const rows = db.all(`SELECT ch.id, ch.kind, ch.ref_id FROM channel_members cm JOIN chat_channels ch ON ch.id=cm.channel_id WHERE cm.user_id=? AND ch.tenant_id=?`, ctx.user.id, ctx.actor.tenantId);
    const out = [];
    for (const ch of rows) {
      if (ch.kind === 'class') { const c = db.get('SELECT name FROM classes WHERE id=?', ch.ref_id); out.push({ id: ch.id, kind: 'class', title: c?.name || '?' }); }
      else {
        const [x, y] = ch.ref_id.split(':'); const other = x === ctx.user.id ? y : x;
        const [a, b] = pair(ctx.user.id, other);
        const fl = db.get("SELECT state FROM friend_links WHERE user_a=? AND user_b=?", a, b);
        if (fl?.state !== 'active' || blocked(ctx.user.id, other)) continue;
        out.push({ id: ch.id, kind: 'dm', title: db.get('SELECT display_name FROM users WHERE id=?', other).display_name, withUserId: other });
      }
    }
    return { channels: out, presets: Object.entries(PRESETS).map(([key, t]) => ({ key, ...t })) };
  });

  const loadChannel = (ctx) => {
    const ch = db.get('SELECT * FROM chat_channels WHERE id=?', ctx.params.id);
    if (!ch) throw err('NOT_FOUND');
    if (!db.get('SELECT 1 FROM channel_members WHERE channel_id=? AND user_id=?', ch.id, ctx.user.id)) throw err('NOT_FOUND');
    return { tenantId: ch.tenant_id, hideExistence: true, row: ch };
  };
  r.get('/social/channels/:id/messages', { action: 'social.message_read', resource: loadChannel, query: s.object({ before: s.string({ max: 40 }).optional() }, { strict: false }) }, (ctx) => {
    const ch = ctx.resource.row;
    const msgs = db.all(`SELECT m.id, m.sender_id AS senderId, u.display_name AS senderName, m.body_kind AS kind, m.preset_key AS presetKey, m.body, m.created_at AS createdAt FROM messages m JOIN users u ON u.id=m.sender_id
      WHERE m.channel_id=? AND m.hidden_at IS NULL ${ctx.query.before ? 'AND m.created_at<?' : ''} ORDER BY m.created_at DESC, m.id DESC LIMIT 50`, ...(ctx.query.before ? [ch.id, ctx.query.before] : [ch.id]));
    return { messages: msgs.filter((m) => m.senderId === ctx.user.id || !blocked(ctx.user.id, m.senderId)).reverse() };
  });

  const autoReport = ({ tenantId, reporterId, targetType, targetId, reason, severity, evidence }) => {
    const id = uuidv7();
    db.run("INSERT INTO reports(id,tenant_id,reporter_id,target_type,target_id,reason,evidence,severity,state,auto_flagged,sla_due_at,created_at) VALUES(?,?,?,?,?,?,?,?,'RECEIVED',1,?,?)", id, tenantId, reporterId, targetType, targetId, reason, JSON.stringify(evidence), severity, new Date(clock.ms() + SLA_HOURS[severity] * 3600e3).toISOString(), clock.iso());
    if (severity >= 2) db.run("UPDATE reports SET state='ESCALATED' WHERE id=? AND state='RECEIVED'", id);
    publish(db, clock, { aggregateType: 'report', aggregateId: id, type: 'report.created', payload: { reportId: id, tenantId, severity } });
    return id;
  };

  r.post('/social/channels/:id/messages', {
    action: 'social.message_send', resource: loadChannel, rate: [{ name: 'msg', by: 'user', limit: 20, windowSec: 60 }],
    body: s.object({ presetKey: s.string({ max: 30 }).optional(), text: s.string({ max: 1000 }).optional() }),
  }, (ctx) => db.tx(() => {
    const ch = ctx.resource.row, uid = ctx.user.id;
    const me = person(uid, ch.tenant_id);
    const { presetKey, text } = ctx.body;
    if ((presetKey ? 1 : 0) + (text ? 1 : 0) !== 1) throw err('VALIDATION_ERROR', { details: [{ path: 'text', code: 'one_of' }] });
    if (needsConsent(me) && !hasConsent(uid, ch.tenant_id, 'social')) throw err('CONSENT_REQUIRED');
    // quyền gửi theo loại kênh
    let free = false;
    if (ch.kind === 'class') {
      const inClass = !!db.get("SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND status='active'", ch.ref_id, uid) || !!db.get('SELECT 1 FROM classes WHERE id=? AND teacher_id=?', ch.ref_id, uid);
      if (!inClass) throw err('NOT_FOUND');
      if (me.role !== 'teacher' && guardianOff(uid)) throw err('GUARDIAN_SCOPE_DENIED', { messageKey: 'error.MESSAGING_OFF' });
      free = me.role === 'teacher' || me.ageBand === '18p';
    } else {
      const [x, y] = ch.ref_id.split(':'); const otherId = x === uid ? y : x;
      const other = person(otherId, ch.tenant_id);
      const [a, b] = pair(uid, otherId);
      const fl = db.get("SELECT state FROM friend_links WHERE user_a=? AND user_b=?", a, b);
      if (!other || fl?.state !== 'active') throw err('FORBIDDEN', { messageKey: 'error.NOT_FRIENDS' });
      const dec = canInteract(me, other, 'dm', { blocked: blocked(uid, otherId), guardianMessagingOff: guardianOff(uid, otherId) });
      if (!dec.allowed) throw err(dec.reason === 'guardian_toggle' ? 'GUARDIAN_SCOPE_DENIED' : 'FORBIDDEN', { messageKey: `error.SOCIAL_${dec.reason.toUpperCase()}` });
      if (needsConsent(other) && !hasConsent(otherId, ch.tenant_id, 'social')) throw err('FORBIDDEN', { messageKey: 'error.SOCIAL_CONSENT_OTHER' });
      free = me.ageBand === '18p' && other.ageBand === '18p' || (flagOn('social.free_text_teen') && config.freeTextTeen && me.ageBand === '13_17' && other.ageBand === '13_17');
    }
    if (presetKey) {
      if (!PRESETS[presetKey]) throw err('VALIDATION_ERROR', { details: [{ path: 'presetKey', code: 'unknown' }] });
      const id = uuidv7();
      db.run("INSERT INTO messages(id,tenant_id,channel_id,sender_id,body_kind,preset_key,body,created_at) VALUES(?,?,?,?, 'preset', ?,?,?)", id, ch.tenant_id, ch.id, uid, presetKey, PRESETS[presetKey].vi, clock.iso());
      return { status: 201, __raw: true, data: { id, kind: 'preset' } };
    }
    if (!free) throw err('AGE_POLICY_DENIED', { messageKey: 'error.PRESET_ONLY' }); // <18: chỉ câu mẫu (D4)
    const evidence = { channelId: ch.id, kind: ch.kind, text, senderId: uid, at: clock.iso() };
    if (SELF_HARM_RE.test(text)) {
      const id = uuidv7();
      db.run("INSERT INTO messages(id,tenant_id,channel_id,sender_id,body_kind,body,created_at,hidden_at,hidden_reason) VALUES(?,?,?,?, 'free', ?,?,?,'auto_self_harm')", id, ch.tenant_id, ch.id, uid, text, clock.iso(), clock.iso());
      autoReport({ tenantId: ch.tenant_id, reporterId: uid, targetType: 'message', targetId: id, reason: 'self_harm', severity: 3, evidence });
      return { status: 201, __raw: true, data: { id, kind: 'free', held: true, support: { messageKey: 'support.self_harm', verifiedByExpert: false } } }; // tài nguyên địa phương do chuyên gia xác nhận (B3.3)
    }
    const contact = PHONE_RE.test(text) || LINK_RE.test(text);
    if (contact && me.ageBand !== '18p') {
      autoReport({ tenantId: ch.tenant_id, reporterId: uid, targetType: 'user', targetId: uid, reason: 'unsafe_contact', severity: 2, evidence });
      throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.CONTACT_INFO_BLOCKED' });
    }
    const id = uuidv7();
    db.run("INSERT INTO messages(id,tenant_id,channel_id,sender_id,body_kind,body,created_at) VALUES(?,?,?,?, 'free', ?,?)", id, ch.tenant_id, ch.id, uid, text, clock.iso());
    return { status: 201, __raw: true, data: { id, kind: 'free', warnings: contact ? ['contact_info'] : [] } };
  }));

  // ---------- báo cáo (bằng chứng chụp lại) ----------
  r.post('/social/reports', {
    action: 'social.report', idem: true, rate: [{ name: 'report', by: 'user', limit: 20, windowSec: 3600 }],
    body: s.object({ targetType: s.enum(['message', 'user', 'session']), targetId: s.uuid(), reason: s.enum(['bullying', 'unsafe_contact', 'self_harm', 'inappropriate', 'spam', 'other']), note: s.string({ max: 300 }).optional() }),
  }, (ctx) => db.tx(() => {
    const b = ctx.body, tenantId = ctx.actor.tenantId;
    let evidence = { note: b.note ?? null, at: clock.iso() };
    if (b.targetType === 'message') {
      const m = db.get('SELECT m.*, u.display_name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=? AND m.tenant_id=?', b.targetId, tenantId);
      if (!m || !db.get('SELECT 1 FROM channel_members WHERE channel_id=? AND user_id=?', m.channel_id, ctx.user.id)) throw err('NOT_FOUND');
      const ctxMsgs = db.all('SELECT sender_id AS senderId, body, created_at AS at FROM messages WHERE channel_id=? AND created_at<=? ORDER BY created_at DESC LIMIT 5', m.channel_id, m.created_at);
      evidence = { ...evidence, message: { id: m.id, senderId: m.sender_id, body: m.body, createdAt: m.created_at }, context: ctxMsgs };
    } else if (b.targetType === 'user') {
      if (!db.get("SELECT 1 FROM memberships WHERE user_id=? AND tenant_id=? AND status='active'", b.targetId, tenantId)) throw err('NOT_FOUND');
    } else if (!db.get('SELECT 1 FROM classroom_sessions WHERE id=? AND tenant_id=?', b.targetId, tenantId)) throw err('NOT_FOUND');
    const severity = b.reason === 'self_harm' ? 3 : b.reason === 'unsafe_contact' ? 2 : 1;
    const id = uuidv7();
    db.run("INSERT INTO reports(id,tenant_id,reporter_id,target_type,target_id,reason,evidence,severity,state,sla_due_at,created_at) VALUES(?,?,?,?,?,?,?,?,'RECEIVED',?,?)", id, tenantId, ctx.user.id, b.targetType, b.targetId, b.reason, JSON.stringify(evidence), severity, new Date(clock.ms() + SLA_HOURS[severity] * 3600e3).toISOString(), clock.iso());
    if (severity >= 2) { // chặn tức thời phần vi phạm, giữ bằng chứng, chuyển ESCALATED
      if (b.targetType === 'message') db.run("UPDATE messages SET hidden_at=?, hidden_reason='reported' WHERE id=? AND hidden_at IS NULL", clock.iso(), b.targetId);
      db.run("UPDATE reports SET state='ESCALATED' WHERE id=? AND state='RECEIVED'", id);
    }
    publish(db, clock, { aggregateType: 'report', aggregateId: id, type: 'report.created', payload: { reportId: id, tenantId, severity } });
    audit.write({ tenantId, actorId: ctx.user.id, action: 'report.create', targetType: 'report', targetId: id, diff: { reason: b.reason, severity }, requestId: ctx.requestId });
    return { status: 201, __raw: true, data: { id, severity, support: b.reason === 'self_harm' ? { messageKey: 'support.self_harm', verifiedByExpert: false } : null } };
  }));
}
