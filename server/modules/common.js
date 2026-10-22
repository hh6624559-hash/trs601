import { uuidv7, shortCode } from '../lib/ids.js';
import { err } from '../lib/errors.js';
import { ageBand } from '../lib/policy.js';
import { randomToken, sha256hex } from '../lib/crypto.js';

export const POLICY_VERSION = '2026-10-v1';
export const ymNow = (clock) => clock.iso().slice(0, 7);
export const toBirthYm = (ym) => `${ym}-01`;

export function newFriendCode(db) {
  for (let i = 0; i < 10; i++) { const c = shortCode(8); if (!db.get('SELECT 1 FROM users WHERE friend_code=?', c)) return c; }
  throw new Error('friend code exhaustion');
}

/** Tạo người dùng + hồ sơ + tài khoản kinh tế + streak trong MỘT transaction của người gọi. */
export function insertUser(db, clock, u) {
  const id = uuidv7();
  db.run(`INSERT INTO users(id,email,username,home_tenant_id,password_hash,birth_ym,display_name,locale,tz,created_by,friend_code,email_verified_at,created_at,prefs)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, u.email ?? null, u.username ?? null, u.tenantId, u.passwordHash ?? null, u.birthYm, u.displayName, u.locale || 'vi', u.tz || 'Asia/Ho_Chi_Minh',
    u.createdBy ?? null, newFriendCode(db), null, clock.iso(), JSON.stringify({ v: 1, dailyGoal: 10, hintMode: 'after_flip', readEasy: false, lite: false }));
  return id;
}
export function addMembership(db, clock, tenantId, userId, role) {
  db.run("INSERT OR IGNORE INTO memberships(tenant_id,user_id,role,status,created_at) VALUES(?,?,?,'active',?)", tenantId, userId, role, clock.iso());
}
export function initLearnerRows(db, clock, tenantId, userId) {
  db.run('INSERT OR IGNORE INTO profiles(user_id,tenant_id) VALUES(?,?)', userId, tenantId);
  db.run('INSERT OR IGNORE INTO economy_accounts(user_id,tenant_id,balance) VALUES(?,?,0)', userId, tenantId);
  db.run('INSERT OR IGNORE INTO streaks(user_id,tenant_id) VALUES(?,?)', userId, tenantId);
}

/** Vòng đời consent: REQUESTED → VERIFIED → GRANTED, mỗi bước qua UPDATE có điều kiện (DB trigger chặn chuyển sai). */
export function grantConsent(db, clock, { tenantId, subjectId, grantedBy, purpose, method, scope = {}, expiresAt = null }) {
  const id = uuidv7(), now = clock.iso();
  db.run("INSERT INTO consents(id,tenant_id,subject_id,granted_by,purpose,scope,policy_version,verification_method,state,requested_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'REQUESTED',?,?)",
    id, tenantId, subjectId, grantedBy, purpose, JSON.stringify(scope), POLICY_VERSION, method, now, expiresAt);
  db.run("UPDATE consents SET state='VERIFIED' WHERE id=? AND state='REQUESTED'", id);
  db.run("UPDATE consents SET state='GRANTED', granted_at=? WHERE id=? AND state='VERIFIED'", now, id);
  return id;
}
export function revokeConsent(db, clock, tenantId, subjectId, purpose) {
  return db.run("UPDATE consents SET state='REVOKED', revoked_at=? WHERE tenant_id=? AND subject_id=? AND purpose=? AND state IN ('REQUESTED','VERIFIED','GRANTED')", clock.iso(), tenantId, subjectId, purpose).changes;
}

/**
 * Thông báo in-app. Với trẻ < 13: thông báo CHỈ đi qua giáo viên/giám hộ (B1.5), không gửi thẳng cho trẻ.
 * Không dark pattern: không có kind nào gây sợ mất streak.
 */
export function notify(db, clock, { tenantId, userId, kind, params = {} }, now = clock.now()) {
  const u = db.get('SELECT birth_ym FROM users WHERE id=?', userId);
  let targets = [userId];
  if (u && ageBand(u.birth_ym, now) === 'u13') {
    targets = db.all("SELECT guardian_id AS id FROM guardian_links WHERE learner_id=? AND status='active'", userId).map((r) => r.id);
    targets.push(...db.all("SELECT c.teacher_id AS id FROM classes c JOIN class_members m ON m.class_id=c.id WHERE m.user_id=? AND m.status='active'", userId).map((r) => r.id));
    params = { ...params, aboutUserId: userId };
  }
  for (const t of new Set(targets)) db.run('INSERT INTO notifications(id,tenant_id,user_id,kind,params,created_at) VALUES(?,?,?,?,?,?)', uuidv7(), tenantId, t, kind, JSON.stringify(params), clock.iso());
}

export function sessionTtl(cfg, actorRoles) {
  const t = cfg.sessionTtl;
  if (actorRoles.includes('platform_admin')) return { ms: t.adminHours * 3600e3, idle: t.adminIdleMin * 60 };
  if (actorRoles.includes('teacher') || actorRoles.includes('admin') || actorRoles.includes('owner')) return { ms: t.teacherHours * 3600e3, idle: null };
  return { ms: t.learnerDays * 86400e3, idle: null };
}

export function createSession({ db, clock, config }, { userId, tenantId, roles, mfaPassed = false, ua = '', ipHash = '' }) {
  const token = randomToken(32), id = sha256hex(token), csrf = randomToken(24);
  const ttl = sessionTtl(config, roles);
  db.run('INSERT INTO sessions(id,user_id,tenant_id,csrf,created_at,last_seen_at,expires_at,idle_timeout_sec,mfa_passed,ua,ip_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    id, userId, tenantId, csrf, clock.iso(), clock.iso(), new Date(clock.ms() + ttl.ms).toISOString(), ttl.idle, mfaPassed ? 1 : 0, ua.slice(0, 200), ipHash);
  return { token, id, maxAge: Math.floor(ttl.ms / 1000) };
}

export function rolesOf(db, userId, tenantId) {
  const rows = db.all("SELECT role FROM memberships WHERE user_id=? AND tenant_id=? AND status='active'", userId, tenantId).map((r) => r.role);
  const u = db.get('SELECT platform_role FROM users WHERE id=?', userId);
  if (u?.platform_role === 'admin') rows.push('platform_admin');
  return rows;
}

export function pageParams(query) {
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
  return { limit, cursor: query.cursor || null };
}
export { err, uuidv7 };
