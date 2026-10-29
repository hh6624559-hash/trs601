import { hashPassword, weakPassword } from './crypto.js';
import { uuidv7 } from './ids.js';
import { insertUser, addMembership } from '../modules/common.js';
import { makeAudit } from './audit.js';

/** Tạo quản trị nền tảng đầu tiên. Trả { created, reason }. Không ghi mật khẩu vào log. */
export async function createPlatformAdmin(db, clock, email, pw) {
  email = String(email || '').trim().toLowerCase();
  if (!email || !pw) return { created: false, reason: 'missing' };
  const weak = weakPassword(pw, [email.split('@')[0]]);
  if (weak) return { created: false, reason: `weak:${weak}` };
  if (db.get('SELECT 1 FROM users WHERE email=?', email)) return { created: false, reason: 'exists' };
  const hash = await hashPassword(pw);
  db.tx(() => {
    const org = uuidv7();
    db.run("INSERT INTO organizations(id,name,kind,created_at) VALUES(?,?,'personal',?)", org, 'Quản trị TRS6', clock.iso());
    const uid = insertUser(db, clock, { email, tenantId: org, passwordHash: hash, birthYm: '1990-01-01', displayName: 'Quản trị' });
    db.run("UPDATE users SET platform_role='admin', email_verified_at=? WHERE id=?", clock.iso(), uid);
    addMembership(db, clock, org, uid, 'owner'); addMembership(db, clock, org, uid, 'admin');
    makeAudit(db, clock).write({ tenantId: org, action: 'admin.bootstrap', targetType: 'user', targetId: uid });
  });
  return { created: true };
}

/** Khi khởi động: nếu đặt BOOTSTRAP_ADMIN_EMAIL/PASSWORD và chưa có quản trị nền tảng → tạo (dành cho nơi không có Shell). */
export async function bootstrapAdminFromEnv({ db, clock, log, env = process.env }) {
  const email = env.BOOTSTRAP_ADMIN_EMAIL, pw = env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !pw) return null;
  if (db.get("SELECT 1 FROM users WHERE platform_role='admin'")) return { created: false, reason: 'admin_exists' };
  const r = await createPlatformAdmin(db, clock, email, pw);
  log.info('bootstrap_admin', { created: r.created, reason: r.reason ?? null });
  return r;
}
