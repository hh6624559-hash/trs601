import { randomInt } from 'node:crypto';
import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { uuidv7, shortCode } from '../lib/ids.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { ageBand } from '../lib/policy.js';
import { learningDay } from '../lib/time.js';
import { insertUser, addMembership, initLearnerRows, grantConsent, revokeConsent, toBirthYm } from './common.js';
import { anonymizeUser } from './privacy.js';

const BIRTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function register(r, d) {
  const { db, clock, config, audit } = d;

  const loadLink = (ctx) => {
    const l = db.get("SELECT * FROM guardian_links WHERE guardian_id=? AND learner_id=? AND status='active'", ctx.user.id, ctx.params.id);
    if (!l) throw err('NOT_FOUND');
    if (l.tenant_id !== ctx.actor.tenantId) throw err('TENANT_MISMATCH', { messageKey: 'error.SWITCH_TENANT', params: { tenantId: l.tenant_id } });
    return { tenantId: l.tenant_id, ownerId: l.learner_id, hideExistence: true, row: l };
  };
  const logView = (tenantId, subjectId, viewerId, what) => db.run('INSERT INTO data_access_log(id,tenant_id,subject_id,viewer_id,viewer_role,what,created_at) VALUES(?,?,?,?,?,?,?)', uuidv7(), tenantId, subjectId, viewerId, 'guardian', what, clock.iso());

  function familyClass(tenantId, guardianId) {
    let c = db.get('SELECT * FROM classes WHERE tenant_id=? AND teacher_id=?', tenantId, guardianId);
    if (!c) {
      const id = uuidv7(); let code;
      do { code = shortCode(6); } while (db.get('SELECT 1 FROM classes WHERE join_code=?', code));
      db.run('INSERT INTO classes(id,tenant_id,teacher_id,name,join_code,created_at) VALUES(?,?,?,?,?,?)', id, tenantId, guardianId, 'Gia đình', code, clock.iso());
      c = db.get('SELECT * FROM classes WHERE id=?', id);
    }
    return c;
  }

  // Guardian tạo tài khoản cho con (dưới 18) trong tổ chức gia đình của mình; consent do chính giám hộ cấp
  r.post('/guardian/children', {
    action: 'guardian.create_child', rate: [{ name: 'child-create', by: 'user', limit: 10, windowSec: 3600 }],
    body: s.object({ displayName: s.string({ min: 1, max: 40 }), birthYm: s.string({ pattern: BIRTH_RE }), username: s.string({ min: 2, max: 30, pattern: /^[a-z0-9._-]+$/ }), pin: s.string({ min: 4, max: 8, pattern: /^\d{4,8}$/ }).optional() }),
  }, async (ctx) => {
    const org = db.get('SELECT * FROM organizations WHERE id=?', ctx.actor.tenantId);
    if (org.kind !== 'family') throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.FAMILY_ORG_REQUIRED' });
    const b = ctx.body;
    if (ageBand(toBirthYm(b.birthYm), clock.now()) === '18p') throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ADULTS_REGISTER_THEMSELVES' });
    const pin = b.pin || String(randomInt(0, 1000000)).padStart(6, '0');
    const hash = await hashPassword(pin);
    return db.tx(() => {
      if (db.get('SELECT 1 FROM users WHERE home_tenant_id=? AND username=?', org.id, b.username)) throw err('CONFLICT', { messageKey: 'error.USERNAME_TAKEN' });
      const uid = insertUser(db, clock, { username: b.username, tenantId: org.id, passwordHash: hash, birthYm: toBirthYm(b.birthYm), displayName: b.displayName, createdBy: ctx.user.id });
      addMembership(db, clock, org.id, uid, 'learner'); initLearnerRows(db, clock, org.id, uid);
      const consent = grantConsent(db, clock, { tenantId: org.id, subjectId: uid, grantedBy: ctx.user.id, purpose: 'account', method: 'guardian_account' });
      db.run("INSERT INTO guardian_links(tenant_id,guardian_id,learner_id,consent_id,status,created_at) VALUES(?,?,?,?, 'active', ?)", org.id, ctx.user.id, uid, consent, clock.iso());
      const fc = familyClass(org.id, ctx.user.id);
      db.run("INSERT INTO class_members(tenant_id,class_id,user_id,role,status,joined_at) VALUES(?,?,?,'learner','active',?)", org.id, fc.id, uid, clock.iso());
      audit.write({ tenantId: org.id, actorId: ctx.user.id, action: 'guardian.create_child', targetType: 'user', targetId: uid, requestId: ctx.requestId });
      return { status: 201, __raw: true, data: { id: uid, username: b.username, pin, familyCode: fc.join_code, note: 'pin_shown_once' }, headers: { 'Cache-Control': 'no-store' } };
    });
  });

  // Liên kết với học viên do giáo viên cấp bằng mã mời (xác minh qua tổ chức/giáo viên)
  r.post('/guardian/link', { action: 'guardian.create_child', rate: [{ name: 'guardian-link', by: 'user', limit: 5, windowSec: 3600 }], body: s.object({ code: s.string({ min: 6, max: 12 }) }) }, (ctx) => db.tx(() => {
    const inv = db.get('SELECT * FROM guardian_invites WHERE code=? AND used_at IS NULL AND expires_at>?', ctx.body.code.toUpperCase(), clock.iso());
    if (!inv) throw err('NOT_FOUND', { messageKey: 'error.INVITE_INVALID' });
    addMembership(db, clock, inv.tenant_id, ctx.user.id, 'guardian');
    const ex = db.get('SELECT * FROM guardian_links WHERE tenant_id=? AND guardian_id=? AND learner_id=?', inv.tenant_id, ctx.user.id, inv.learner_id);
    if (ex) db.run("UPDATE guardian_links SET status='active' WHERE tenant_id=? AND guardian_id=? AND learner_id=?", inv.tenant_id, ctx.user.id, inv.learner_id);
    else db.run("INSERT INTO guardian_links(tenant_id,guardian_id,learner_id,status,created_at) VALUES(?,?,?,'active',?)", inv.tenant_id, ctx.user.id, inv.learner_id, clock.iso());
    db.run('UPDATE guardian_invites SET used_at=?, used_by=? WHERE code=?', clock.iso(), ctx.user.id, inv.code);
    audit.write({ tenantId: inv.tenant_id, actorId: ctx.user.id, action: 'guardian.link', targetType: 'user', targetId: inv.learner_id, requestId: ctx.requestId });
    return { linked: true, learnerId: inv.learner_id, tenantId: inv.tenant_id };
  }));

  // Giáo viên phát mã mời cho giám hộ của học viên trong lớp mình
  r.post('/teacher/classes/:id/students/:uid/guardian-invite', {
    action: 'class.manage_students', resource: (ctx) => { const c = db.get('SELECT * FROM classes WHERE id=?', ctx.params.id); if (!c) throw err('NOT_FOUND'); return { tenantId: c.tenant_id, classId: c.id, hideExistence: true, row: c }; },
  }, (ctx) => {
    const c = ctx.resource.row;
    if (!db.get("SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND status='active'", c.id, ctx.params.uid)) throw err('NOT_FOUND');
    let code; do { code = shortCode(8); } while (db.get('SELECT 1 FROM guardian_invites WHERE code=?', code));
    const exp = new Date(clock.ms() + 7 * 86400e3).toISOString();
    db.run('INSERT INTO guardian_invites(code,tenant_id,learner_id,created_by,expires_at) VALUES(?,?,?,?,?)', code, c.tenant_id, ctx.params.uid, ctx.user.id, exp);
    audit.write({ tenantId: c.tenant_id, actorId: ctx.user.id, action: 'guardian.invite', targetType: 'user', targetId: ctx.params.uid, requestId: ctx.requestId });
    return { code, expiresAt: exp };
  });

  r.get('/guardian/children', { action: 'guardian.list' }, (ctx) => ({
    children: db.all("SELECT l.learner_id AS id, l.tenant_id AS tenantId, l.messaging_enabled AS messaging, u.display_name AS displayName, u.birth_ym, u.username, u.status FROM guardian_links l JOIN users u ON u.id=l.learner_id WHERE l.guardian_id=? AND l.status='active'", ctx.user.id)
      .map((c) => ({ id: c.id, tenantId: c.tenantId, displayName: c.displayName, username: c.username, status: c.status, ageBand: ageBand(c.birth_ym, clock.now()), messaging: !!c.messaging, social: !!db.get("SELECT 1 FROM consents WHERE subject_id=? AND tenant_id=? AND purpose='social' AND state='GRANTED'", c.id, c.tenantId), current: c.tenantId === ctx.actor.tenantId, familyCode: db.get('SELECT join_code FROM classes WHERE tenant_id=? AND teacher_id=?', c.tenantId, ctx.user.id)?.join_code ?? null })),
  }));

  /** Tóm tắt tuần: tổng hợp tích cực, không so sánh với bạn; Teen 13–17 không thấy chi tiết từng câu trả lời. */
  r.get('/guardian/children/:id/summary', { action: 'guardian.view_child', resource: loadLink }, (ctx) => {
    const l = ctx.resource.row, cid = l.learner_id;
    const u = db.get('SELECT display_name,tz,birth_ym,prefs FROM users WHERE id=?', cid);
    const day = learningDay(clock.ms(), u.tz, config.learning.dayBoundaryHour);
    const since = new Date(day.startMs - 6 * 86400e3).toISOString();
    const evs = db.all("SELECT received_at, duration_ms FROM review_events WHERE user_id=? AND source IN ('review','game') AND received_at>=?", cid, since);
    const byDay = {};
    for (const e of evs) { const k = learningDay(Date.parse(e.received_at), u.tz, config.learning.dayBoundaryHour).key; byDay[k] ||= { reviews: 0, ms: 0 }; byDay[k].reviews++; byDay[k].ms += Math.min(e.duration_ms || 0, 60000); }
    const days = [];
    for (let i = 6; i >= 0; i--) { const k = new Date(Date.parse(day.key + 'T00:00:00Z') - i * 86400e3).toISOString().slice(0, 10); days.push({ day: k, reviews: byDay[k]?.reviews || 0, minutes: Math.round((byDay[k]?.ms || 0) / 60000) }); }
    const goal = JSON.parse(u.prefs).dailyGoal ?? 10;
    const remembered = db.get("SELECT COUNT(*) AS n FROM learner_sense_state WHERE user_id=? AND state='review' AND stability>=21", cid).n;
    const newThisWeek = db.get('SELECT COUNT(*) AS n FROM learner_sense_state WHERE user_id=? AND introduced_at>=?', cid, since).n;
    logView(l.tenant_id, cid, ctx.user.id, 'weekly_summary');
    audit.write({ tenantId: l.tenant_id, actorId: ctx.user.id, action: 'guardian.view_summary', targetType: 'user', targetId: cid, requestId: ctx.requestId });
    return { child: { id: cid, displayName: u.display_name, ageBand: ageBand(u.birth_ym, clock.now()) }, days, totals: { reviews: days.reduce((x, y) => x + y.reviews, 0), minutes: days.reduce((x, y) => x + y.minutes, 0), daysMetGoal: days.filter((x) => x.reviews >= goal).length, goal, newWords: newThisWeek, remembered }, streak: db.get('SELECT current,best FROM streaks WHERE user_id=?', cid), scope: { aggregateOnly: true } };
  });

  r.get('/guardian/children/:id/settings', { action: 'guardian.view_child', resource: loadLink }, (ctx) => ({
    messaging: !!ctx.resource.row.messaging_enabled,
    consents: db.all('SELECT purpose,state,granted_at AS grantedAt,policy_version AS policyVersion FROM consents WHERE subject_id=? AND tenant_id=? ORDER BY requested_at DESC', ctx.params.id, ctx.resource.tenantId),
    friends: db.all("SELECT CASE WHEN f.user_a=? THEN f.user_b ELSE f.user_a END AS uid FROM friend_links f WHERE (f.user_a=? OR f.user_b=?) AND f.state='active'", ctx.params.id, ctx.params.id, ctx.params.id).map((x) => ({ displayName: db.get('SELECT display_name FROM users WHERE id=?', x.uid).display_name })),
  }));

  r.patch('/guardian/children/:id/settings', { action: 'guardian.manage_child', resource: loadLink, body: s.object({ messaging: s.boolean().optional(), social: s.boolean().optional() }) }, (ctx) => db.tx(() => {
    const l = ctx.resource.row, b = ctx.body;
    if (b.messaging !== undefined) db.run('UPDATE guardian_links SET messaging_enabled=? WHERE tenant_id=? AND guardian_id=? AND learner_id=?', b.messaging ? 1 : 0, l.tenant_id, l.guardian_id, l.learner_id); // hiệu lực ngay (kiểm ở mỗi lần gửi)
    if (b.social === true && !db.get("SELECT 1 FROM consents WHERE subject_id=? AND tenant_id=? AND purpose='social' AND state='GRANTED'", l.learner_id, l.tenant_id)) grantConsent(db, clock, { tenantId: l.tenant_id, subjectId: l.learner_id, grantedBy: ctx.user.id, purpose: 'social', method: 'guardian_account' });
    if (b.social === false) revokeConsent(db, clock, l.tenant_id, l.learner_id, 'social');
    audit.write({ tenantId: l.tenant_id, actorId: ctx.user.id, action: 'guardian.settings', targetType: 'user', targetId: l.learner_id, diff: { fields: Object.keys(b) }, requestId: ctx.requestId });
    return { ok: true };
  }));

  r.get('/guardian/children/:id/access-log', { action: 'guardian.view_child', resource: loadLink }, (ctx) => ({
    log: db.all(`SELECT d.viewer_role AS role, d.what, d.created_at AS at, u.display_name AS viewer FROM data_access_log d JOIN users u ON u.id=d.viewer_id WHERE d.subject_id=? ORDER BY d.created_at DESC LIMIT 100`, ctx.params.id),
  }));

  r.post('/guardian/children/:id/reset-pin', { action: 'guardian.manage_child', resource: loadLink, rate: [{ name: 'pin-reset-g', by: 'user', limit: 10, windowSec: 3600 }] }, async (ctx) => {
    if (!ctx.actor.stepUp) throw err('STEP_UP_REQUIRED');
    const pin = String(randomInt(0, 1000000)).padStart(6, '0');
    const h = await hashPassword(pin);
    db.tx(() => {
      db.run('UPDATE users SET password_hash=? WHERE id=?', h, ctx.params.id);
      db.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', clock.iso(), ctx.params.id);
      audit.write({ tenantId: ctx.resource.tenantId, actorId: ctx.user.id, action: 'guardian.reset_pin', targetType: 'user', targetId: ctx.params.id, requestId: ctx.requestId });
    });
    return { pin, note: 'pin_shown_once' };
  });

  // Rút/thu hồi đồng ý cho con (hiệu lực ngay: hành động cần consent bị chặn bởi CONSENT_REQUIRED)
  r.post('/guardian/children/:id/consents/revoke', { action: 'guardian.manage_child', resource: loadLink, body: s.object({ purpose: s.enum(['account', 'social', 'ai_tutor']) }) }, (ctx) => {
    const n = revokeConsent(db, clock, ctx.resource.tenantId, ctx.params.id, ctx.body.purpose);
    audit.write({ tenantId: ctx.resource.tenantId, actorId: ctx.user.id, action: 'consent.revoke', targetType: 'user', targetId: ctx.params.id, diff: { purpose: ctx.body.purpose, count: n }, requestId: ctx.requestId });
    return { revoked: n };
  });
  r.post('/guardian/children/:id/consents/grant', { action: 'guardian.manage_child', resource: loadLink, body: s.object({ purpose: s.enum(['account', 'social', 'ai_tutor']) }) }, (ctx) => db.tx(() => {
    const l = ctx.resource.row;
    if (!db.get("SELECT 1 FROM consents WHERE subject_id=? AND tenant_id=? AND purpose=? AND state='GRANTED'", l.learner_id, l.tenant_id, ctx.body.purpose)) grantConsent(db, clock, { tenantId: l.tenant_id, subjectId: l.learner_id, grantedBy: ctx.user.id, purpose: ctx.body.purpose, method: 'guardian_account' });
    audit.write({ tenantId: l.tenant_id, actorId: ctx.user.id, action: 'consent.grant', targetType: 'user', targetId: l.learner_id, diff: { purpose: ctx.body.purpose }, requestId: ctx.requestId });
    return { granted: true };
  }));

  // Xoá/ẩn danh tài khoản của con (cần step-up của giám hộ)
  r.post('/guardian/children/:id/delete', { action: 'privacy.delete_child', resource: loadLink, idem: true }, (ctx) => db.tx(() => {
    const l = ctx.resource.row;
    const reqId = uuidv7();
    db.run("INSERT INTO privacy_requests(id,tenant_id,subject_id,requested_by,kind,state,due_at,created_at) VALUES(?,?,?,?,'deletion','RECEIVED',?,?)", reqId, l.tenant_id, l.learner_id, ctx.user.id, clock.iso(), clock.iso());
    db.run("UPDATE privacy_requests SET state='VERIFIED' WHERE id=? AND state='RECEIVED'", reqId);
    db.run("UPDATE privacy_requests SET state='IN_PROGRESS' WHERE id=? AND state='VERIFIED'", reqId);
    const summary = anonymizeUser(db, clock, l.learner_id, ctx.user.id);
    db.run("UPDATE privacy_requests SET state='COMPLETED', completed_at=?, note=? WHERE id=? AND state='IN_PROGRESS'", clock.iso(), JSON.stringify(summary.kept), reqId);
    audit.write({ tenantId: l.tenant_id, actorId: ctx.user.id, action: 'privacy.delete_child', targetType: 'user', targetId: l.learner_id, diff: { requestId: reqId }, requestId: ctx.requestId });
    return { requestId: reqId, state: 'COMPLETED', ...summary };
  }));
}
