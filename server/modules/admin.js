import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { notify } from './common.js';
import { rebuild } from './fsrs.js';
import { effectiveMs } from './learning.js';

export function register(r, d) {
  const { db, clock, config, audit } = d;

  // ---------- duyệt giáo viên ----------
  r.get('/admin/teachers', { action: 'admin.teacher_review', query: s.object({ state: s.enum(['SUBMITTED', 'EMAIL_VERIFIED', 'APPROVED', 'REJECTED', 'SUSPENDED']).optional() }, { strict: false }) }, (ctx) => {
    const rows = db.all(`SELECT t.user_id AS id, t.state, t.updated_at AS updatedAt, t.note, u.display_name AS displayName, u.email, u.email_verified_at AS emailVerifiedAt, o.name AS org
      FROM teacher_verifications t JOIN users u ON u.id=t.user_id JOIN organizations o ON o.id=t.tenant_id ${ctx.query.state ? 'WHERE t.state=?' : "WHERE t.state IN ('SUBMITTED','EMAIL_VERIFIED')"} ORDER BY t.updated_at LIMIT 200`, ...(ctx.query.state ? [ctx.query.state] : []));
    return { teachers: rows };
  });
  r.post('/admin/teachers/:id/decision', { action: 'admin.teacher_review', body: s.object({ decision: s.enum(['approve', 'reject', 'suspend', 'reinstate']), note: s.string({ max: 300 }).optional() }) }, (ctx) => db.tx(() => {
    const t = db.get('SELECT t.*, u.email_verified_at FROM teacher_verifications t JOIN users u ON u.id=t.user_id WHERE t.user_id=?', ctx.params.id);
    if (!t) throw err('NOT_FOUND');
    const d0 = ctx.body.decision;
    let from, to;
    if (d0 === 'approve') { if (!t.email_verified_at) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.TEACHER_EMAIL_UNVERIFIED' }); from = ['SUBMITTED', 'EMAIL_VERIFIED']; to = 'APPROVED'; }
    else if (d0 === 'reject') { from = ['SUBMITTED', 'EMAIL_VERIFIED']; to = 'REJECTED'; }
    else if (d0 === 'suspend') { from = ['APPROVED']; to = 'SUSPENDED'; }
    else { from = ['SUSPENDED']; to = 'APPROVED'; }
    const n = db.run(`UPDATE teacher_verifications SET state=?, note=?, decided_by=?, updated_at=? WHERE user_id=? AND state IN (${from.map(() => '?').join(',')})`, to, ctx.body.note ?? null, ctx.user.id, clock.iso(), t.user_id, ...from).changes;
    if (n !== 1) throw err('INVALID_STATE_TRANSITION', { params: { from: t.state, to } });
    if (to !== 'APPROVED') db.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND ?', clock.iso(), t.user_id, to === 'SUSPENDED' ? 1 : 0);
    notify(db, clock, { tenantId: t.tenant_id, userId: t.user_id, kind: `teacher_${to.toLowerCase()}`, params: {} });
    audit.write({ tenantId: t.tenant_id, actorId: ctx.user.id, action: `teacher.${d0}`, targetType: 'user', targetId: t.user_id, diff: { from: t.state, to }, requestId: ctx.requestId });
    return { id: t.user_id, state: to };
  }));

  // ---------- hàng đợi kiểm duyệt ----------
  const inScope = (ctx) => (ctx.actor.roles.includes('platform_admin') ? '' : ' AND r.tenant_id=?');
  r.get('/admin/moderation/reports', { action: 'admin.moderate', query: s.object({ state: s.enum(['RECEIVED', 'IN_REVIEW', 'ESCALATED', 'ACTIONED', 'DISMISSED']).optional() }, { strict: false }) }, (ctx) => {
    const st = ctx.query.state;
    const w = st ? 'r.state=?' : "r.state IN ('RECEIVED','IN_REVIEW','ESCALATED')";
    const rows = db.all(`SELECT r.id,r.tenant_id AS tenantId,r.target_type AS targetType,r.target_id AS targetId,r.reason,r.severity,r.state,r.sla_due_at AS slaDueAt,r.auto_flagged AS autoFlagged,r.created_at AS createdAt,r.evidence,
        (SELECT display_name FROM users WHERE id=r.reporter_id) AS reporter FROM reports r WHERE ${w}${inScope(ctx)} ORDER BY r.severity DESC, r.sla_due_at LIMIT 100`, ...(st ? [st] : []), ...(ctx.actor.roles.includes('platform_admin') ? [] : [ctx.actor.tenantId]));
    const now = clock.iso();
    return { reports: rows.map((x) => ({ ...x, evidence: JSON.parse(x.evidence), overdue: x.slaDueAt < now && ['RECEIVED', 'IN_REVIEW', 'ESCALATED'].includes(x.state) })), backlog: rows.length };
  });

  r.post('/admin/moderation/reports/:id/action', {
    action: 'admin.moderate', idem: true,
    resource: (ctx) => { const x = db.get('SELECT tenant_id FROM reports WHERE id=?', ctx.params.id); if (!x) throw err('NOT_FOUND'); return { tenantId: x.tenant_id, hideExistence: true }; },
    body: s.object({ action: s.enum(['start_review', 'escalate', 'hide_message', 'warn', 'suspend_user', 'notify_guardian', 'dismiss']), note: s.string({ max: 500 }).optional() }),
  }, (ctx) => db.tx(() => {
    const rep = db.get('SELECT * FROM reports WHERE id=?', ctx.params.id), a = ctx.body.action;
    const move = (to, froms) => { if (db.run(`UPDATE reports SET state=?, assigned_to=COALESCE(assigned_to,?) WHERE id=? AND state IN (${froms.map(() => '?').join(',')})`, to, ctx.user.id, rep.id, ...froms).changes !== 1) throw err('INVALID_STATE_TRANSITION', { params: { from: rep.state, to } }); };
    const target = rep.target_type === 'message' ? db.get('SELECT sender_id FROM messages WHERE id=?', rep.target_id)?.sender_id : rep.target_type === 'user' ? rep.target_id : null;
    if (a === 'start_review') move('IN_REVIEW', ['RECEIVED', 'ESCALATED']);
    else if (a === 'escalate') move('ESCALATED', ['RECEIVED', 'IN_REVIEW']);
    else if (a === 'dismiss') { if (rep.state === 'RECEIVED') move('IN_REVIEW', ['RECEIVED']); move('DISMISSED', ['IN_REVIEW', 'ESCALATED']); }
    else {
      if (rep.state === 'RECEIVED') move('IN_REVIEW', ['RECEIVED']);
      if (a === 'hide_message') { if (rep.target_type !== 'message') throw err('BUSINESS_RULE_VIOLATION'); db.run("UPDATE messages SET hidden_at=COALESCE(hidden_at,?), hidden_reason='moderated' WHERE id=?", clock.iso(), rep.target_id); }
      if (a === 'suspend_user') { if (!target) throw err('BUSINESS_RULE_VIOLATION'); db.run("UPDATE users SET status='suspended' WHERE id=? AND platform_role IS NULL", target); db.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', clock.iso(), target); }
      if (a === 'warn' && target) notify(db, clock, { tenantId: rep.tenant_id, userId: target, kind: 'moderation_warning', params: { reason: rep.reason } });
      if (a === 'notify_guardian' && target) for (const g of db.all("SELECT guardian_id FROM guardian_links WHERE learner_id=? AND status='active'", target)) db.run('INSERT INTO notifications(id,tenant_id,user_id,kind,params,created_at) VALUES(?,?,?,?,?,?)', uuidv7(), rep.tenant_id, g.guardian_id, 'moderation_guardian_notice', JSON.stringify({ reason: rep.reason }), clock.iso());
      move('ACTIONED', ['IN_REVIEW', 'ESCALATED']);
    }
    db.run('INSERT INTO moderation_actions(id,tenant_id,report_id,moderator_id,action,note,created_at) VALUES(?,?,?,?,?,?,?)', uuidv7(), rep.tenant_id, rep.id, ctx.user.id, a === 'start_review' ? 'escalate' : a, ctx.body.note ?? null, clock.iso());
    audit.write({ tenantId: rep.tenant_id, actorId: ctx.user.id, action: `moderation.${a}`, targetType: 'report', targetId: rep.id, diff: { from: rep.state }, requestId: ctx.requestId });
    return { id: rep.id, state: db.get('SELECT state FROM reports WHERE id=?', rep.id).state };
  }));

  // ---------- audit ----------
  r.get('/admin/audit', { action: 'admin.audit_read', query: s.object({ action: s.string({ max: 60 }).optional(), before: s.string({ max: 20 }).optional(), limit: s.string({ max: 3 }).default('50') }, { strict: false }) }, (ctx) => {
    const limit = Math.min(parseInt(ctx.query.limit, 10) || 50, 100);
    const rows = db.all(`SELECT seq,id,tenant_id AS tenantId,actor_id AS actorId,action,target_type AS targetType,target_id AS targetId,diff,created_at AS createdAt FROM audit_logs WHERE 1=1 ${ctx.query.action ? 'AND action LIKE ?' : ''} ${ctx.query.before ? 'AND seq<?' : ''} ORDER BY seq DESC LIMIT ?`,
      ...(ctx.query.action ? [`${ctx.query.action}%`] : []), ...(ctx.query.before ? [Number(ctx.query.before)] : []), limit + 1);
    return { entries: rows.slice(0, limit).map((x) => ({ ...x, diff: x.diff ? JSON.parse(x.diff) : null })), nextCursor: rows.length > limit ? String(rows[limit - 1].seq) : null };
  });
  r.get('/admin/audit/verify', { action: 'admin.audit_read' }, () => d.audit.verify());

  // ---------- Data Integrity Auditor (CHỈ ĐỌC) ----------
  function integrity() {
    const findings = [];
    const add = (id, severity, title, evidence, falsePositive = 'không') => findings.push({ id, severity, title, evidence, falsePositive });
    const led = db.all('SELECT a.user_id, a.balance, COALESCE((SELECT SUM(delta) FROM economy_ledger l WHERE l.user_id=a.user_id),0) AS total FROM economy_accounts a');
    led.filter((x) => x.balance !== x.total).forEach((x) => add('DI-003/ledger_drift', 'SEV1', 'balance lệch SUM(ledger)', { userId: x.user_id, balance: x.balance, ledger: x.total }));
    db.all("SELECT lc.id, lc.owner_id FROM learner_collections lc JOIN users u ON u.id=lc.owner_id WHERE lc.tenant_id<>u.home_tenant_id AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=lc.owner_id AND m.tenant_id=lc.tenant_id)").forEach((x) => add('DI-001/cross_tenant_ref', 'SEV1', 'kho thuộc tenant không có membership', x));
    const outbox = db.get('SELECT COUNT(*) AS n FROM outbox_events WHERE published_at IS NULL AND created_at<?', new Date(clock.ms() - 3600e3).toISOString()).n;
    if (outbox) add('DI-016/outbox_stuck', 'SEV2', 'outbox chưa giao > 1 giờ', { count: outbox });
    db.all("SELECT id FROM outbox_events WHERE dead_at IS NOT NULL LIMIT 20").forEach((x) => add('DI-016/outbox_dead', 'SEV2', 'sự kiện dead-letter', x));
    // derived state drift: kiểm mẫu ngẫu nhiên ≤ 200 cặp (user, sense)
    const sample = db.all("SELECT user_id, sense_id FROM learner_sense_state WHERE state<>'suspended' ORDER BY random() LIMIT 200");
    for (const x of sample) {
      const ev = db.all('SELECT id,rating,source,reverses_id,client_at,received_at FROM review_events WHERE user_id=? AND sense_id=? ORDER BY received_at, seq', x.user_id, x.sense_id).map((e) => ({ ...e, effective_ms: effectiveMs(e) }));
      const st = rebuild(ev, { userId: x.user_id, senseId: x.sense_id, retention: config.learning.desiredRetention, leechLapses: config.learning.leechLapses });
      const cur = db.get('SELECT stability,due_at,reps FROM learner_sense_state WHERE user_id=? AND sense_id=?', x.user_id, x.sense_id);
      if (st.due_at !== cur.due_at || st.reps !== cur.reps || Math.abs(st.stability - cur.stability) > 1e-9) add('DI-005/derived_drift', 'SEV2', 'learner_sense_state lệch rebuild_state', { ...x, rebuilt: { due: st.due_at, reps: st.reps }, stored: cur });
    }
    db.all("SELECT user_id FROM attempts WHERE state IN ('CREATED','IN_PROGRESS') GROUP BY user_id, assessment_id HAVING COUNT(*)>1").forEach((x) => add('DI-025/multi_open_attempt', 'SEV1', 'nhiều attempt đang mở', x));
    db.all("SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.role='learner' AND m.status='active' AND u.status='active' AND NOT EXISTS (SELECT 1 FROM consents c WHERE c.subject_id=u.id AND c.purpose='account' AND c.state='GRANTED') AND CAST(strftime('%Y','now') AS INT) - CAST(substr(u.birth_ym,1,4) AS INT) < 18").forEach((x) => add('DI-022/minor_without_consent', 'SEV1', 'học viên dưới 18 không có consent account hiệu lực', x, 'có thể là consent bị thu hồi có chủ đích'));
    const ck = d.audit.verify(); ck.mismatches.forEach((m) => add('DI-024/audit_checkpoint', 'SEV0', 'checkpoint audit lệch (lịch sử bị sửa?)', m));
    return { generatedAt: clock.iso(), readOnly: true, findings, checked: ['ledger', 'tenant_refs', 'outbox', 'derived_state_sample', 'open_attempts', 'minor_consent', 'audit_chain'] };
  }
  d.integrity = integrity;
  r.get('/admin/integrity', { action: 'admin.integrity' }, (ctx) => {
    audit.write({ actorId: ctx.user.id, action: 'admin.integrity_run', requestId: ctx.requestId });
    return integrity();
  });

  // ---------- SLI cơ bản (số đo, KHÔNG phải SLO – BASELINE_PENDING) ----------
  r.get('/admin/stats', { action: 'admin.stats' }, () => ({
    baseline: 'BASELINE_PENDING',
    users: db.get("SELECT COUNT(*) AS n FROM users WHERE status='active'").n,
    active7d: db.get("SELECT COUNT(DISTINCT user_id) AS n FROM review_events WHERE received_at>?", new Date(clock.ms() - 7 * 86400e3).toISOString()).n,
    reviewEvents: db.get('SELECT COUNT(*) AS n FROM review_events').n,
    attemptsGraded: db.get("SELECT COUNT(*) AS n FROM attempts WHERE state='GRADED'").n,
    reportsBacklog: db.get("SELECT COUNT(*) AS n FROM reports WHERE state IN ('RECEIVED','IN_REVIEW','ESCALATED')").n,
    reportsOverdue: db.get("SELECT COUNT(*) AS n FROM reports WHERE state IN ('RECEIVED','IN_REVIEW','ESCALATED') AND sla_due_at<?", clock.iso()).n,
    outboxPending: db.get('SELECT COUNT(*) AS n FROM outbox_events WHERE published_at IS NULL').n,
    pendingTeachers: db.get("SELECT COUNT(*) AS n FROM teacher_verifications WHERE state IN ('SUBMITTED','EMAIL_VERIFIED')").n,
  }));
}
