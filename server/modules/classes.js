import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { uuidv7, shortCode } from '../lib/ids.js';
import { hashPassword } from '../lib/crypto.js';
import { normVi } from '../lib/norm.js';
import { ageBand } from '../lib/policy.js';
import { randomInt } from 'node:crypto';
import { SENSE_COLS, senseView } from './vocab.js';
import { insertUser, addMembership, initLearnerRows, grantConsent, notify, toBirthYm } from './common.js';
import { hmacHex, safeEqual } from '../lib/crypto.js';

const MAX_CLASS_SIZE = 200; // GIẢ THUYẾT
const BIRTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function register(r, d) {
  const { db, clock, config, audit } = d;

  const loadClass = (ctx) => {
    const c = db.get('SELECT * FROM classes WHERE id=?', ctx.params.id);
    if (!c) throw err('NOT_FOUND');
    return { tenantId: c.tenant_id, classId: c.id, hideExistence: true, row: c };
  };
  const logAccess = (tenantId, subjectId, viewer, role, what) =>
    db.run('INSERT INTO data_access_log(id,tenant_id,subject_id,viewer_id,viewer_role,what,created_at) VALUES(?,?,?,?,?,?,?)', uuidv7(), tenantId, subjectId, viewer, role, what, clock.iso());
  const classCode = () => { for (let i = 0; i < 10; i++) { const c = shortCode(6); if (!db.get('SELECT 1 FROM classes WHERE join_code=?', c)) return c; } throw new Error('class code exhaustion'); };
  const randomPin = () => String(randomInt(0, 1000000)).padStart(6, '0');
  const slug = (n) => normVi(n).replace(/[^a-z]/g, '').slice(0, 12) || 'hocsinh';

  // ---------- lớp ----------
  r.post('/teacher/classes', { action: 'class.create', body: s.object({ name: s.string({ min: 1, max: 80 }) }), rate: [{ name: 'class-create', by: 'user', limit: 20, windowSec: 3600 }] }, (ctx) => db.tx(() => {
    const id = uuidv7(), code = classCode();
    db.run('INSERT INTO classes(id,tenant_id,teacher_id,name,join_code,created_at) VALUES(?,?,?,?,?,?)', id, ctx.actor.tenantId, ctx.user.id, ctx.body.name, code, clock.iso());
    const ch = uuidv7();
    db.run("INSERT INTO chat_channels(id,tenant_id,kind,ref_id,created_at) VALUES(?,?,'class',?,?)", ch, ctx.actor.tenantId, id, clock.iso());
    db.run("INSERT INTO channel_members(tenant_id,channel_id,user_id,role) VALUES(?,?,?,'teacher')", ctx.actor.tenantId, ch, ctx.user.id);
    audit.write({ tenantId: ctx.actor.tenantId, actorId: ctx.user.id, action: 'class.create', targetType: 'class', targetId: id, requestId: ctx.requestId });
    return { status: 201, __raw: true, data: { id, name: ctx.body.name, joinCode: code } };
  }));

  r.get('/teacher/classes', { action: 'class.list' }, (ctx) => ({
    classes: db.all("SELECT c.id,c.name,c.join_code AS joinCode,c.status,(SELECT COUNT(*) FROM class_members m WHERE m.class_id=c.id AND m.status='active') AS students FROM classes c WHERE c.teacher_id=? AND c.tenant_id=? AND c.status='active' ORDER BY c.created_at DESC", ctx.user.id, ctx.actor.tenantId),
  }));

  const careHints = (uid, now) => {
    const hints = [];
    const last = db.get("SELECT MAX(received_at) AS t FROM review_events WHERE user_id=? AND source IN ('review','game')", uid).t;
    const days = last ? Math.floor((now - Date.parse(last)) / 86400e3) : null;
    if (days === null) hints.push({ key: 'not_started' }); else if (days >= 5) hints.push({ key: 'inactive_days', params: { days } });
    const leeches = db.get('SELECT COUNT(*) AS n FROM learner_sense_state WHERE user_id=? AND leech=1', uid).n;
    if (leeches >= 3) hints.push({ key: 'many_hard_words', params: { count: leeches } });
    const backlog = db.get("SELECT COUNT(*) AS n FROM learner_sense_state WHERE user_id=? AND state IN ('review','relearning','learning') AND due_at<=?", uid, new Date(now - 3 * 86400e3).toISOString()).n;
    if (backlog >= 15) hints.push({ key: 'backlog', params: { count: backlog } });
    return hints; // «gợi ý quan tâm» có lý do giải thích được; KHÔNG gán nhãn «yếu»
  };

  r.get('/teacher/classes/:id', { action: 'class.read', resource: loadClass }, (ctx) => {
    const c = ctx.resource.row, now = clock.ms();
    const members = db.all("SELECT u.id,u.display_name,u.username,u.birth_ym,m.role FROM class_members m JOIN users u ON u.id=m.user_id WHERE m.class_id=? AND m.status='active' ORDER BY u.display_name", c.id);
    const roster = members.map((u) => {
      const band = ageBand(u.birth_ym, clock.now());
      if (band !== '18p') logAccess(c.tenant_id, u.id, ctx.user.id, 'teacher', 'class_roster');
      return {
        id: u.id, displayName: u.display_name, username: u.username, ageBand: band, role: u.role,
        started: db.get('SELECT COUNT(*) AS n FROM learner_sense_state WHERE user_id=?', u.id).n,
        mastered: db.get("SELECT COUNT(*) AS n FROM learner_sense_state WHERE user_id=? AND state='review' AND stability>=21", u.id).n,
        streak: db.get('SELECT current FROM streaks WHERE user_id=?', u.id)?.current ?? 0,
        lastActive: db.get("SELECT MAX(received_at) AS t FROM review_events WHERE user_id=? AND source IN ('review','game')", u.id).t,
        hints: careHints(u.id, now),
      };
    });
    audit.write({ tenantId: c.tenant_id, actorId: ctx.user.id, action: 'class.view_roster', targetType: 'class', targetId: c.id, diff: { students: roster.length }, requestId: ctx.requestId });
    return { id: c.id, name: c.name, joinCode: c.join_code, roster };
  });

  // ---------- học viên do giáo viên cấp ----------
  const STUDENT = s.object({ displayName: s.string({ min: 1, max: 40 }), birthYm: s.string({ pattern: BIRTH_RE }), username: s.string({ min: 2, max: 30, pattern: /^[a-z0-9._-]+$/ }).optional() });
  r.post('/teacher/classes/:id/students', {
    action: 'class.manage_students', resource: loadClass,
    rate: [{ name: 'student-create', by: 'user', limit: 20, windowSec: 3600 }],
    body: s.object({ students: s.array(STUDENT, { min: 1, max: 60 }), attestation: s.boolean().default(false) }),
  }, async (ctx) => {
    const c = ctx.resource.row, b = ctx.body, now = clock.now();
    const hasMinor = b.students.some((x) => ageBand(toBirthYm(x.birthYm), now) !== '18p');
    if (hasMinor && !b.attestation) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ATTESTATION_REQUIRED' }); // D7: xác minh giám hộ qua tổ chức
    const size = db.get("SELECT COUNT(*) AS n FROM class_members WHERE class_id=? AND status='active'", c.id).n;
    if (size + b.students.length > MAX_CLASS_SIZE) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.CLASS_FULL', params: { max: MAX_CLASS_SIZE } });
    const pins = b.students.map(() => randomInt(0, 1000000)).map((n) => String(n).padStart(6, '0'));
    const hashes = [];
    for (const p of pins) hashes.push(await hashPassword(p));
    const out = db.tx(() => b.students.map((st, i) => {
      let username = st.username;
      if (username) { if (db.get('SELECT 1 FROM users WHERE home_tenant_id=? AND username=?', c.tenant_id, username)) throw err('CONFLICT', { messageKey: 'error.USERNAME_TAKEN', params: { username } }); }
      else { do { username = `${slug(st.displayName)}${randomInt(10, 999)}`; } while (db.get('SELECT 1 FROM users WHERE home_tenant_id=? AND username=?', c.tenant_id, username)); }
      const uid = insertUser(db, clock, { username, tenantId: c.tenant_id, passwordHash: hashes[i], birthYm: toBirthYm(st.birthYm), displayName: st.displayName, createdBy: ctx.user.id });
      addMembership(db, clock, c.tenant_id, uid, 'learner');
      initLearnerRows(db, clock, c.tenant_id, uid);
      grantConsent(db, clock, { tenantId: c.tenant_id, subjectId: uid, grantedBy: ctx.user.id, purpose: 'account', method: 'org_attestation', scope: { classId: c.id } });
      enrollInClass(c, uid);
      audit.write({ tenantId: c.tenant_id, actorId: ctx.user.id, action: 'student.create', targetType: 'user', targetId: uid, diff: { classId: c.id, attestation: !!b.attestation }, requestId: ctx.requestId });
      return { id: uid, displayName: st.displayName, username, pin: pins[i] };
    }));
    // Chứa PIN dùng một lần → KHÔNG qua idempotency store (UNIQUE username đã chống tạo trùng)
    return { status: 201, __raw: true, data: { classCode: c.join_code, credentials: out, note: 'pin_shown_once' }, headers: { 'Cache-Control': 'no-store' } };
  });

  function enrollInClass(c, uid) {
    db.run("INSERT INTO class_members(tenant_id,class_id,user_id,role,status,joined_at) VALUES(?,?,?,'learner','active',?) ON CONFLICT(class_id,user_id) DO UPDATE SET status='active'", c.tenant_id, c.id, uid, clock.iso());
    const ch = db.get("SELECT id FROM chat_channels WHERE kind='class' AND ref_id=?", c.id);
    if (ch) db.run("INSERT OR IGNORE INTO channel_members(tenant_id,channel_id,user_id,role) VALUES(?,?,?,'member')", c.tenant_id, ch.id, uid);
    for (const a of db.all("SELECT * FROM assignments WHERE class_id=? AND status='active'", c.id)) giveAssignment(a, uid, false);
  }

  r.post('/teacher/classes/:id/students/:uid/reset-pin', { action: 'class.manage_students', resource: loadClass, rate: [{ name: 'pin-reset', by: 'user', limit: 30, windowSec: 3600 }] }, async (ctx) => {
    const c = ctx.resource.row;
    const m = db.get("SELECT u.* FROM class_members m JOIN users u ON u.id=m.user_id WHERE m.class_id=? AND m.user_id=? AND m.status='active' AND u.created_by IS NOT NULL", c.id, ctx.params.uid);
    if (!m) throw err('NOT_FOUND');
    const pin = String(randomInt(0, 1000000)).padStart(6, '0');
    const h = await hashPassword(pin);
    db.tx(() => {
      db.run('UPDATE users SET password_hash=? WHERE id=?', h, m.id);
      db.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', clock.iso(), m.id);
      audit.write({ tenantId: c.tenant_id, actorId: ctx.user.id, action: 'student.reset_pin', targetType: 'user', targetId: m.id, requestId: ctx.requestId });
    });
    return { username: m.username, pin, __secret: true };
  });

  r.delete('/teacher/classes/:id/students/:uid', { action: 'class.manage_students', resource: loadClass }, (ctx) => db.tx(() => {
    const c = ctx.resource.row;
    const n = db.run("UPDATE class_members SET status='removed' WHERE class_id=? AND user_id=? AND status='active'", c.id, ctx.params.uid).changes;
    if (!n) throw err('NOT_FOUND');
    // thu hồi quyền có hiệu lực ngay: bài giao thành kho tự chọn đã lưu trữ (lịch sử ôn giữ nguyên); rút khỏi kênh lớp; thu hồi phiên
    const cols = db.all("SELECT lc.id FROM learner_collections lc JOIN assignments a ON a.id=lc.assignment_id WHERE a.class_id=? AND lc.owner_id=? AND lc.locked=1", c.id, ctx.params.uid);
    for (const col of cols) {
      db.run("UPDATE learner_collections SET source='self', locked=0, assignment_id=NULL WHERE id=?", col.id);
      db.run("UPDATE learner_collections SET status='archived', version=version+1 WHERE id=?", col.id);
    }
    db.run('DELETE FROM channel_members WHERE user_id=? AND channel_id IN (SELECT id FROM chat_channels WHERE kind=\'class\' AND ref_id=?)', ctx.params.uid, c.id);
    db.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', clock.iso(), ctx.params.uid);
    audit.write({ tenantId: c.tenant_id, actorId: ctx.user.id, action: 'class.remove_student', targetType: 'user', targetId: ctx.params.uid, diff: { classId: c.id }, requestId: ctx.requestId });
    return { removed: true };
  }));

  r.get('/teacher/classes/:id/students/:uid/progress', { action: 'student.read_progress', resource: (ctx) => {
    const base = loadClass(ctx);
    const m = db.get("SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND status='active'", ctx.params.id, ctx.params.uid);
    if (!m) throw err('NOT_FOUND');
    return { ...base, ownerId: ctx.params.uid };
  } }, (ctx) => {
    const uid = ctx.params.uid, c = ctx.resource.row;
    logAccess(c.tenant_id, uid, ctx.user.id, 'teacher', 'student_progress');
    audit.write({ tenantId: c.tenant_id, actorId: ctx.user.id, action: 'student.view_progress', targetType: 'user', targetId: uid, requestId: ctx.requestId });
    const by = Object.fromEntries(db.all('SELECT state, COUNT(*) AS n FROM learner_sense_state WHERE user_id=? GROUP BY state', uid).map((x) => [x.state, x.n]));
    const u = db.get('SELECT display_name FROM users WHERE id=?', uid);
    return { displayName: u.display_name, totals: by, streak: db.get('SELECT current,best FROM streaks WHERE user_id=?', uid), hints: careHints(uid, clock.ms()), attempts: db.all("SELECT a.id, s.title, g.score, g.max_score AS maxScore, a.submitted_at AS submittedAt FROM attempts a JOIN assessments s ON s.id=a.assessment_id LEFT JOIN grading_results g ON g.attempt_id=a.id WHERE a.user_id=? AND s.class_id=? AND a.state='GRADED' ORDER BY a.submitted_at DESC LIMIT 20", uid, c.id) };
  });

  // ---------- bài giao ----------
  function giveAssignment(a, uid, notifyIt = true) {
    if (db.get('SELECT 1 FROM learner_collections WHERE assignment_id=? AND owner_id=?', a.id, uid)) return;
    const col = uuidv7(), now = clock.iso();
    db.run("INSERT INTO learner_collections(id,tenant_id,owner_id,title,source,assignment_id,locked,visibility,status,created_at,updated_at) VALUES(?,?,?,?,'teacher',?,1,'private','active',?,?)", col, a.tenant_id, uid, a.title, a.id, now, now);
    db.run('INSERT INTO collection_items(tenant_id,collection_id,sense_id,position,added_at) SELECT ?,?,sense_id,position,? FROM assignment_items WHERE assignment_id=?', a.tenant_id, col, now, a.id);
    if (notifyIt) notify(db, clock, { tenantId: a.tenant_id, userId: uid, kind: 'assignment_new', params: { title: a.title, dueAt: a.due_at } });
  }

  r.post('/teacher/classes/:id/assignments', {
    action: 'class.assign', resource: loadClass, idem: true,
    body: s.object({ title: s.string({ min: 1, max: 80 }), dueAt: s.iso().optional(), senseIds: s.array(s.uuid(), { max: 300 }).optional(), lemmas: s.array(s.string({ min: 1, max: 40 }), { max: 300 }).optional(), csv: s.string({ max: 20000 }).optional(), fromTopic: s.string({ max: 30 }).optional(), cefr: s.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']).optional(), limit: s.int({ min: 1, max: 200 }).optional() }),
  }, (ctx) => db.tx(() => {
    const c = ctx.resource.row, b = ctx.body;
    const ids = new Set(), unknown = [];
    for (const id of b.senseIds || []) { if (db.get("SELECT 1 FROM senses WHERE id=? AND status='published' AND (owner_tenant_id IS NULL OR owner_tenant_id=?)", id, c.tenant_id)) ids.add(id); else unknown.push(id); }
    const words = [...(b.lemmas || [])];
    if (b.csv) for (const line of b.csv.split(/\r?\n/)) { const w = line.split(/[,;\t]/)[0].trim(); if (w) words.push(w); }
    for (const w of words) { const row = db.get("SELECT s.id FROM senses s JOIN lexemes l ON l.id=s.lexeme_id WHERE l.lemma_norm=? AND s.status='published' AND (s.owner_tenant_id IS NULL OR s.owner_tenant_id=?) LIMIT 1", normVi(w), c.tenant_id); if (row) ids.add(row.id); else unknown.push(w); }
    if (b.fromTopic) db.all(`SELECT s.id FROM sense_topics t JOIN senses s ON s.id=t.sense_id JOIN lexemes l ON l.id=s.lexeme_id WHERE t.topic=? AND s.status='published' AND s.owner_tenant_id IS NULL ${b.cefr ? 'AND l.cefr=?' : ''} ORDER BY l.cefr, l.lemma LIMIT ?`, ...(b.cefr ? [b.fromTopic, b.cefr, b.limit || 30] : [b.fromTopic, b.limit || 30])).forEach((x) => ids.add(x.id));
    if (!ids.size) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ASSIGNMENT_EMPTY', details: unknown.map((u) => ({ unknown: u })) });
    const id = uuidv7();
    db.run('INSERT INTO assignments(id,tenant_id,class_id,title,due_at,created_by,created_at) VALUES(?,?,?,?,?,?,?)', id, c.tenant_id, c.id, b.title, b.dueAt ?? null, ctx.user.id, clock.iso());
    [...ids].forEach((sid, i) => db.run('INSERT INTO assignment_items(assignment_id,sense_id,position) VALUES(?,?,?)', id, sid, i + 1));
    const a = db.get('SELECT * FROM assignments WHERE id=?', id);
    const members = db.all("SELECT user_id FROM class_members WHERE class_id=? AND status='active' AND role='learner'", c.id);
    members.forEach((m) => giveAssignment(a, m.user_id));
    audit.write({ tenantId: c.tenant_id, actorId: ctx.user.id, action: 'assignment.create', targetType: 'assignment', targetId: id, diff: { words: ids.size, recipients: members.length }, requestId: ctx.requestId });
    return { status: 201, __raw: true, data: { id, title: b.title, words: ids.size, recipients: members.length, unknown } };
  }));

  r.get('/teacher/classes/:id/assignments', { action: 'class.read', resource: loadClass }, (ctx) => {
    const rows = db.all("SELECT * FROM assignments WHERE class_id=? ORDER BY created_at DESC", ctx.params.id);
    return { assignments: rows.map((a) => {
      const total = db.get('SELECT COUNT(*) AS n FROM assignment_items WHERE assignment_id=?', a.id).n;
      const cols = db.all("SELECT lc.owner_id FROM learner_collections lc WHERE lc.assignment_id=?", a.id);
      const perStudent = cols.map((c) => ({
        started: db.get('SELECT COUNT(*) AS n FROM assignment_items ai JOIN learner_sense_state st ON st.sense_id=ai.sense_id AND st.user_id=? WHERE ai.assignment_id=?', c.owner_id, a.id).n,
        mastered: db.get("SELECT COUNT(*) AS n FROM assignment_items ai JOIN learner_sense_state st ON st.sense_id=ai.sense_id AND st.user_id=? AND st.state='review' AND st.stability>=21 WHERE ai.assignment_id=?", c.owner_id, a.id).n,
      }));
      const avg = (k) => (perStudent.length && total ? Math.round((perStudent.reduce((x, p) => x + p[k], 0) / (perStudent.length * total)) * 100) : 0);
      return { id: a.id, title: a.title, dueAt: a.due_at, status: a.status, words: total, recipients: cols.length, startedPct: avg('started'), masteredPct: avg('mastered'), hardReports: db.get('SELECT COUNT(*) AS n FROM hard_reports h JOIN learner_collections lc ON lc.id=h.collection_id WHERE lc.assignment_id=?', a.id).n };
    }) };
  });

  r.get('/me/assignments', { action: 'assignment.mine' }, (ctx) => ({
    assignments: db.all(`SELECT lc.id AS collectionId, lc.title, lc.status, a.due_at AS dueAt, a.class_id AS classId, c.name AS className,
        (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id=lc.id) AS words,
        (SELECT COUNT(*) FROM collection_items ci JOIN learner_sense_state st ON st.sense_id=ci.sense_id AND st.user_id=lc.owner_id WHERE ci.collection_id=lc.id) AS started
      FROM learner_collections lc JOIN assignments a ON a.id=lc.assignment_id JOIN classes c ON c.id=a.class_id WHERE lc.owner_id=? AND lc.locked=1 ORDER BY a.due_at IS NULL, a.due_at`, ctx.user.id),
  }));

  r.get('/teacher/hard-reports', { action: 'class.list' }, (ctx) => ({
    reports: db.all(`SELECT h.id, h.note, h.created_at AS createdAt, lc.title, u.display_name AS student FROM hard_reports h JOIN learner_collections lc ON lc.id=h.collection_id JOIN assignments a ON a.id=lc.assignment_id JOIN classes c ON c.id=a.class_id JOIN users u ON u.id=h.user_id WHERE c.teacher_id=? ORDER BY h.created_at DESC LIMIT 50`, ctx.user.id),
  }));

  // ---------- buổi học online (S8): nhà cung cấp video qua adapter «liên kết ngoài» ----------
  const httpsUrl = s.string({ max: 300, pattern: /^https:\/\/[^\s]+$/ });
  r.post('/teacher/classes/:id/sessions', {
    action: 'classroom.manage', resource: loadClass,
    body: s.object({ title: s.string({ min: 1, max: 80 }), startsAt: s.iso(), durationMin: s.int({ min: 5, max: 240 }), roomUrl: httpsUrl.optional(), fallbackUrl: httpsUrl.optional() }),
  }, (ctx) => {
    const c = ctx.resource.row, id = uuidv7();
    db.run('INSERT INTO classroom_sessions(id,tenant_id,class_id,teacher_id,title,starts_at,duration_min,room_url,fallback_url,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, c.tenant_id, c.id, ctx.user.id, ctx.body.title, ctx.body.startsAt, ctx.body.durationMin, ctx.body.roomUrl ?? null, ctx.body.fallbackUrl ?? null, clock.iso());
    audit.write({ tenantId: c.tenant_id, actorId: ctx.user.id, action: 'classroom.create', targetType: 'session', targetId: id, requestId: ctx.requestId });
    for (const m of db.all("SELECT user_id FROM class_members WHERE class_id=? AND status='active'", c.id)) notify(db, clock, { tenantId: c.tenant_id, userId: m.user_id, kind: 'session_scheduled', params: { title: ctx.body.title, startsAt: ctx.body.startsAt } });
    return { status: 201, __raw: true, data: { id, state: 'SCHEDULED' } };
  });

  const loadSession = (ctx) => {
    const x = db.get('SELECT * FROM classroom_sessions WHERE id=?', ctx.params.id);
    if (!x) throw err('NOT_FOUND');
    return { tenantId: x.tenant_id, classId: x.class_id, hideExistence: true, row: x };
  };
  const sessView = (x) => ({ id: x.id, classId: x.class_id, title: x.title, startsAt: x.starts_at, durationMin: x.duration_min, state: x.state, locked: !!x.locked, hasRoom: !!x.room_url, hasFallback: !!x.fallback_url, recording: false });

  r.get('/teacher/classes/:id/sessions', { action: 'class.read', resource: loadClass }, (ctx) => ({
    sessions: db.all('SELECT * FROM classroom_sessions WHERE class_id=? ORDER BY starts_at DESC LIMIT 50', ctx.params.id).map((x) => ({ ...sessView(x), roomUrl: x.room_url, fallbackUrl: x.fallback_url, present: db.get('SELECT COUNT(*) AS n FROM attendance_records WHERE session_id=? AND present=1', x.id).n, joinIntents: db.get('SELECT COUNT(*) AS n FROM attendance_records WHERE session_id=?', x.id).n })),
  }));

  r.post('/teacher/sessions/:id/transition', { action: 'classroom.manage', resource: loadSession, body: s.object({ to: s.enum(['READY', 'LIVE', 'ENDED', 'CANCELLED']), locked: s.boolean().optional() }) }, (ctx) => db.tx(() => {
    const x = ctx.resource.row;
    if (ctx.body.to === 'READY' && !x.room_url && !x.fallback_url) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ROOM_URL_REQUIRED' });
    const n = db.run('UPDATE classroom_sessions SET state=? WHERE id=? AND state=?', ctx.body.to, x.id, x.state).changes;
    if (n !== 1) throw err('INVALID_STATE_TRANSITION');
    if (ctx.body.locked !== undefined) db.run('UPDATE classroom_sessions SET locked=? WHERE id=?', ctx.body.locked ? 1 : 0, x.id);
    audit.write({ tenantId: x.tenant_id, actorId: ctx.user.id, action: 'classroom.transition', targetType: 'session', targetId: x.id, diff: { from: x.state, to: ctx.body.to }, requestId: ctx.requestId });
    return sessView(db.get('SELECT * FROM classroom_sessions WHERE id=?', x.id));
  }));
  r.post('/teacher/sessions/:id/lock', { action: 'classroom.manage', resource: loadSession, body: s.object({ locked: s.boolean() }) }, (ctx) => {
    db.run('UPDATE classroom_sessions SET locked=? WHERE id=?', ctx.body.locked ? 1 : 0, ctx.params.id);
    return { locked: ctx.body.locked };
  });
  r.put('/teacher/sessions/:id/attendance', { action: 'classroom.manage', resource: loadSession, body: s.object({ userId: s.uuid(), present: s.boolean() }) }, (ctx) => {
    const x = ctx.resource.row;
    if (!db.get("SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND status='active'", x.class_id, ctx.body.userId)) throw err('NOT_FOUND');
    db.run("INSERT INTO attendance_records(session_id,user_id,tenant_id,present,marked_by,source,marked_at) VALUES(?,?,?,?,?,'teacher',?) ON CONFLICT(session_id,user_id) DO UPDATE SET present=excluded.present, marked_by=excluded.marked_by, source='teacher', marked_at=excluded.marked_at", x.id, ctx.body.userId, x.tenant_id, ctx.body.present ? 1 : 0, ctx.user.id, clock.iso());
    return { ok: true };
  });
  r.get('/teacher/sessions/:id/attendance', { action: 'classroom.manage', resource: loadSession }, (ctx) => ({
    attendance: db.all("SELECT m.user_id AS userId, u.display_name AS displayName, a.join_intent_at AS joinIntentAt, COALESCE(a.present,0) AS present, a.source FROM class_members m JOIN users u ON u.id=m.user_id LEFT JOIN attendance_records a ON a.session_id=? AND a.user_id=m.user_id WHERE m.class_id=? AND m.status='active' ORDER BY u.display_name", ctx.params.id, ctx.resource.row.class_id),
  }));

  r.get('/me/sessions-upcoming', { action: 'assignment.mine' }, (ctx) => ({
    sessions: db.all(`SELECT x.* FROM classroom_sessions x JOIN class_members m ON m.class_id=x.class_id AND m.user_id=? AND m.status='active' WHERE x.state IN ('SCHEDULED','READY','LIVE') ORDER BY x.starts_at LIMIT 20`, ctx.user.id).map(sessView),
  }));
  // Lấy liên kết phòng: chỉ thành viên lớp, phòng READY/LIVE, không bị khoá. Bấm vào ≠ có mặt (chỉ ghi ý định).
  r.post('/classroom/sessions/:id/join', { action: 'classroom.join', resource: loadSession, rate: [{ name: 'join', by: 'user', limit: 20, windowSec: 60 }] }, (ctx) => {
    const x = ctx.resource.row;
    if (!['READY', 'LIVE'].includes(x.state)) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.SESSION_NOT_OPEN' });
    if (x.locked) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.SESSION_LOCKED' });
    db.run("INSERT INTO attendance_records(session_id,user_id,tenant_id,join_intent_at,present,source) VALUES(?,?,?,?,0,'teacher') ON CONFLICT(session_id,user_id) DO UPDATE SET join_intent_at=excluded.join_intent_at", x.id, ctx.user.id, x.tenant_id, clock.iso());
    return { roomUrl: x.room_url || x.fallback_url, fallbackUrl: x.fallback_url, reportAvailable: true };
  });

  // Webhook điểm danh từ nhà cung cấp: chữ ký HMAC + khử trùng (provider,event_id) (DI-014)
  r.post('/webhooks/video', {
    auth: 'public', rawBodyBuffer: true, rate: [{ name: 'webhook', by: 'ip', limit: 120, windowSec: 60 }],
    body: s.object({ eventId: s.string({ min: 1, max: 100 }), type: s.enum(['participant_joined', 'participant_left']), sessionId: s.uuid(), userId: s.uuid() }),
  }, (ctx) => {
    if (!config.videoWebhookSecret) throw err('DEPENDENCY_UNAVAILABLE');
    const sig = String(ctx.headers['x-signature'] || '');
    if (!safeEqual(sig, hmacHex(config.videoWebhookSecret, ctx.rawBuffer))) throw err('UNAUTHENTICATED');
    const b = ctx.body;
    return db.tx(() => {
      const ins = db.run('INSERT OR IGNORE INTO webhook_inbox(provider,event_id,received_at,payload) VALUES(?,?,?,?)', 'video', b.eventId, clock.iso(), JSON.stringify(b));
      if (!ins.changes) return { duplicate: true };
      const x = db.get('SELECT * FROM classroom_sessions WHERE id=?', b.sessionId);
      if (x && db.get("SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND status='active'", x.class_id, b.userId)) {
        db.run("INSERT INTO attendance_records(session_id,user_id,tenant_id,present,source,marked_at) VALUES(?,?,?,?, 'webhook', ?) ON CONFLICT(session_id,user_id) DO UPDATE SET present=excluded.present, source='webhook', marked_at=excluded.marked_at", x.id, b.userId, x.tenant_id, b.type === 'participant_joined' ? 1 : 0, clock.iso());
      }
      db.run('UPDATE webhook_inbox SET processed_at=? WHERE provider=? AND event_id=?', clock.iso(), 'video', b.eventId);
      return { processed: true };
    });
  });
}
