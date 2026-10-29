import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { revokeConsent } from './common.js';

/**
 * Ẩn danh người dùng (không xoá cứng, DI-015): giữ khoá tham chiếu + audit + review_events (đã ẩn danh) + sổ cái;
 * xoá PII, phiên, MFA, hồ sơ, thông báo, mã bạn bè. Trả tóm tắt «đã làm / còn giữ» – KHÔNG nói «đã xoá hoàn toàn».
 */
export function anonymizeUser(db, clock, userId, actorId) {
  const u = db.get('SELECT * FROM users WHERE id=?', userId);
  if (!u) throw err('NOT_FOUND');
  if (u.status === 'anonymized') return { alreadyAnonymized: true, kept: [] };
  const now = clock.iso();
  const classes = db.get("SELECT COUNT(*) AS n FROM classes c WHERE c.teacher_id=? AND c.status='active' AND EXISTS (SELECT 1 FROM class_members m WHERE m.class_id=c.id AND m.status='active')", userId).n;
  if (classes > 0 && u.created_by === null) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.TRANSFER_CLASSES_FIRST' });
  if (u.platform_role === 'admin') throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ADMIN_CANNOT_DELETE' });
  db.tx(() => {
    db.run("UPDATE users SET email=NULL, username=NULL, password_hash=NULL, display_name='Đã ẩn danh', birth_ym='1970-01-01', friend_code=NULL, prefs='{}', status='anonymized', anonymized_at=?, email_verified_at=NULL WHERE id=?", now, userId);
    db.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', now, userId);
    db.run('DELETE FROM mfa_factors WHERE user_id=?', userId);
    db.run('DELETE FROM email_tokens WHERE user_id=?', userId);
    db.run('DELETE FROM notifications WHERE user_id=?', userId);
    db.run("UPDATE profiles SET bio=NULL, goal=NULL, avatar_key='av-fox', hat_key=NULL WHERE user_id=?", userId);
    db.run("UPDATE memberships SET status='revoked' WHERE user_id=?", userId);
    db.run("UPDATE class_members SET status='removed' WHERE user_id=?", userId);
    db.run("UPDATE friend_links SET state='removed', updated_at=? WHERE (user_a=? OR user_b=?) AND state<>'removed'", now, userId, userId);
    db.run('DELETE FROM channel_members WHERE user_id=?', userId);
    db.run("UPDATE messages SET body='[đã xoá]', hidden_at=COALESCE(hidden_at,?), hidden_reason=COALESCE(hidden_reason,'account_deleted') WHERE sender_id=?", now, userId);
    db.run("UPDATE guardian_links SET status='revoked' WHERE learner_id=? OR guardian_id=?", userId, userId);
    db.run("UPDATE consents SET state='REVOKED', revoked_at=? WHERE subject_id=? AND state IN ('REQUESTED','VERIFIED','GRANTED')", now, userId);
  });
  return { anonymized: true, kept: ['review_events_pseudonymous', 'economy_ledger', 'audit_logs', 'consent_records', 'moderation_evidence_if_any'], backups: 'removed_from_backups_per_retention_policy', actorId };
}

const INVENTORY = [
  { data: 'account', purpose: 'Đăng nhập, quản lý tài khoản', source: 'người dùng/giáo viên/giám hộ', sensitivity: 'high', who: 'chính chủ; giám hộ (con); giáo viên (học viên trong lớp)', where: 'CSDL chính', retention: 'đến khi xoá/ẩn danh', thirdParties: [] },
  { data: 'birth_month', purpose: 'Suy ra nhóm tuổi để áp dụng lớp bảo vệ', source: 'đăng ký', sensitivity: 'high', who: 'hệ thống; không hiển thị cho bạn học', where: 'CSDL chính', retention: 'đến khi xoá/ẩn danh', thirdParties: [] },
  { data: 'learning_events', purpose: 'Lịch ôn, tiến độ', source: 'hoạt động học', sensitivity: 'medium', who: 'chính chủ; giám hộ (tổng hợp); giáo viên lớp', where: 'CSDL chính', retention: 'lâu dài, ẩn danh khi xoá tài khoản', thirdParties: [] },
  { data: 'messages', purpose: 'Nhắn tin trong lớp/bạn bè (câu mẫu cho dưới 18)', source: 'người dùng', sensitivity: 'high', who: 'người trong kênh; kiểm duyệt khi có báo cáo', where: 'CSDL chính', retention: '12 tháng (theo chính sách tổ chức)', thirdParties: [] },
  { data: 'sessions_devices', purpose: 'Bảo mật phiên', source: 'trình duyệt', sensitivity: 'medium', who: 'chính chủ', where: 'CSDL chính (IP chỉ lưu dạng băm)', retention: 'hết hạn phiên + 30 ngày', thirdParties: [] },
  { data: 'audit_logs', purpose: 'Truy vết hành động nhạy cảm', source: 'hệ thống', sensitivity: 'low', who: 'quản trị nền tảng', where: 'CSDL chính (chỉ ID, không PII)', retention: '>= 1 năm', thirdParties: [] },
];

export function register(r, d) {
  const { db, clock, audit } = d;

  r.get('/me/privacy', { action: 'privacy.view' }, (ctx) => {
    const uid = ctx.user.id;
    const viewers = [
      ...db.all("SELECT 'guardian' AS role, u.display_name AS name FROM guardian_links g JOIN users u ON u.id=g.guardian_id WHERE g.learner_id=? AND g.status='active'", uid),
      ...db.all("SELECT 'teacher' AS role, u.display_name AS name FROM class_members m JOIN classes c ON c.id=m.class_id JOIN users u ON u.id=c.teacher_id WHERE m.user_id=? AND m.status='active'", uid),
    ];
    return {
      inventory: INVENTORY,
      counts: { reviewEvents: db.get('SELECT COUNT(*) AS n FROM review_events WHERE user_id=?', uid).n, collections: db.get('SELECT COUNT(*) AS n FROM learner_collections WHERE owner_id=?', uid).n, attempts: db.get('SELECT COUNT(*) AS n FROM attempts WHERE user_id=?', uid).n, messages: db.get('SELECT COUNT(*) AS n FROM messages WHERE sender_id=?', uid).n },
      canView: viewers, aiFeaturesUsed: [], aiNote: 'ai_disabled',
      consents: db.all('SELECT purpose,state,granted_at AS grantedAt,policy_version AS policyVersion FROM consents WHERE subject_id=? ORDER BY requested_at DESC', uid),
      requests: db.all('SELECT id,kind,state,created_at AS createdAt,completed_at AS completedAt,due_at AS dueAt FROM privacy_requests WHERE subject_id=? ORDER BY created_at DESC LIMIT 20', uid),
    };
  });

  const exportData = (uid) => {
    const u = db.get('SELECT id,email,username,display_name,birth_ym,locale,tz,created_at,prefs FROM users WHERE id=?', uid);
    return {
      exportedAt: clock.iso(), format: 'trs6-export-v1', user: u,
      consents: db.all('SELECT purpose,state,policy_version,granted_at,revoked_at FROM consents WHERE subject_id=?', uid),
      collections: db.all('SELECT id,title,source,status,created_at FROM learner_collections WHERE owner_id=?', uid).map((c) => ({ ...c, items: db.all('SELECT sense_id,added_at,removed_at FROM collection_items WHERE collection_id=?', c.id) })),
      reviewEvents: db.all('SELECT id,sense_id,rating,source,received_at FROM review_events WHERE user_id=? ORDER BY received_at', uid),
      state: db.all('SELECT sense_id,state,stability,difficulty,due_at,reps,lapses FROM learner_sense_state WHERE user_id=?', uid),
      wallet: db.all('SELECT delta,reason,created_at FROM economy_ledger WHERE user_id=? ORDER BY created_at', uid),
      attempts: db.all('SELECT a.id,a.assessment_id,a.state,a.submitted_at,g.score,g.max_score FROM attempts a LEFT JOIN grading_results g ON g.attempt_id=a.id WHERE a.user_id=?', uid),
      messagesSent: db.all('SELECT channel_id,body_kind,body,created_at FROM messages WHERE sender_id=? ORDER BY created_at', uid),
      friends: db.all("SELECT state,created_at FROM friend_links WHERE user_a=? OR user_b=?", uid, uid),
      notifications: db.all('SELECT kind,params,created_at FROM notifications WHERE user_id=?', uid),
    };
  };

  r.post('/me/data-export', { action: 'privacy.export', resource: (ctx) => ({ ownerId: ctx.user.id, tenantId: ctx.actor.tenantId }), rate: [{ name: 'export', by: 'user', limit: 3, windowSec: 3600 }] }, (ctx) => db.tx(() => {
    const id = uuidv7();
    db.run("INSERT INTO privacy_requests(id,tenant_id,subject_id,requested_by,kind,state,due_at,created_at) VALUES(?,?,?,?,'export','RECEIVED',?,?)", id, ctx.actor.tenantId, ctx.user.id, ctx.user.id, clock.iso(), clock.iso());
    db.run("UPDATE privacy_requests SET state='VERIFIED' WHERE id=?", id); // đã step-up
    const data = exportData(ctx.user.id);
    db.run("UPDATE privacy_requests SET state='COMPLETED', completed_at=? WHERE id=? AND state='VERIFIED'", clock.iso(), id);
    audit.write({ tenantId: ctx.actor.tenantId, actorId: ctx.user.id, action: 'privacy.export', targetType: 'user', targetId: ctx.user.id, requestId: ctx.requestId });
    return { __raw: true, status: 200, data: { requestId: id, data }, headers: { 'Cache-Control': 'no-store' } };
  }));

  r.post('/me/deletion-request', { action: 'privacy.delete', resource: (ctx) => ({ ownerId: ctx.user.id, tenantId: ctx.actor.tenantId }), body: s.object({ confirm: s.boolean() }) }, (ctx) => db.tx(() => {
    if (!ctx.body.confirm) throw err('VALIDATION_ERROR', { details: [{ path: 'confirm', code: 'required' }] });
    if (ctx.user.created_by) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.MANAGED_ACCOUNT_DELETE_VIA_GUARDIAN' });
    if (db.get("SELECT 1 FROM privacy_requests WHERE subject_id=? AND kind='deletion' AND state IN ('RECEIVED','VERIFIED','IN_PROGRESS')", ctx.user.id)) throw err('CONFLICT', { messageKey: 'error.REQUEST_PENDING' });
    const id = uuidv7(), due = new Date(clock.ms() + 7 * 86400e3).toISOString();
    db.run("INSERT INTO privacy_requests(id,tenant_id,subject_id,requested_by,kind,state,due_at,created_at) VALUES(?,?,?,?,'deletion','RECEIVED',?,?)", id, ctx.actor.tenantId, ctx.user.id, ctx.user.id, due, clock.iso());
    db.run("UPDATE privacy_requests SET state='VERIFIED' WHERE id=?", id);
    audit.write({ tenantId: ctx.actor.tenantId, actorId: ctx.user.id, action: 'privacy.deletion_request', targetType: 'privacy_request', targetId: id, requestId: ctx.requestId });
    return { status: 201, __raw: true, data: { id, state: 'VERIFIED', graceUntil: due, note: 'can_cancel_during_grace' } };
  }));
  r.post('/me/deletion-request/:id/cancel', { action: 'privacy.view' }, (ctx) => {
    const n = db.run("UPDATE privacy_requests SET state='REJECTED', note='cancelled_by_subject', completed_at=? WHERE id=? AND subject_id=? AND kind='deletion' AND state='VERIFIED'", clock.iso(), ctx.params.id, ctx.user.id).changes;
    if (!n) throw err('NOT_FOUND');
    return { cancelled: true };
  });
  r.post('/me/deletion-request/:id/execute', { action: 'privacy.delete', resource: (ctx) => ({ ownerId: ctx.user.id, tenantId: ctx.actor.tenantId }) }, (ctx) => db.tx(() => {
    const req = db.get("SELECT * FROM privacy_requests WHERE id=? AND subject_id=? AND kind='deletion' AND state='VERIFIED'", ctx.params.id, ctx.user.id);
    if (!req) throw err('NOT_FOUND');
    db.run("UPDATE privacy_requests SET state='IN_PROGRESS' WHERE id=? AND state='VERIFIED'", req.id);
    const summary = anonymizeUser(db, clock, ctx.user.id, ctx.user.id);
    db.run("UPDATE privacy_requests SET state='COMPLETED', completed_at=?, note=? WHERE id=?", clock.iso(), JSON.stringify(summary.kept), req.id);
    audit.write({ tenantId: ctx.actor.tenantId, actorId: ctx.user.id, action: 'privacy.deletion_executed', targetType: 'user', targetId: ctx.user.id, requestId: ctx.requestId });
    return summary;
  }));

  r.post('/me/consents/withdraw', { action: 'privacy.view', body: s.object({ purpose: s.enum(['social', 'weekly_report']) }) }, (ctx) => {
    if (ctx.actor.ageBand !== '18p') throw err('GUARDIAN_SCOPE_DENIED', { messageKey: 'error.CONSENT_VIA_GUARDIAN' });
    const n = revokeConsent(db, clock, ctx.actor.tenantId, ctx.user.id, ctx.body.purpose);
    audit.write({ tenantId: ctx.actor.tenantId, actorId: ctx.user.id, action: 'consent.withdraw', targetType: 'user', targetId: ctx.user.id, diff: { purpose: ctx.body.purpose }, requestId: ctx.requestId });
    return { withdrawn: n };
  });
}
