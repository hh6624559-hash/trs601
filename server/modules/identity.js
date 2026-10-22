import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { hashPassword, verifyPassword, dummyVerify, weakPassword, hibpPwned, randomToken, sha256hex, base32, seal, unseal, verifyTotp } from '../lib/crypto.js';
import { randomBytes } from 'node:crypto';
import { ageBand } from '../lib/policy.js';
import { uuidv7 } from '../lib/ids.js';
import { insertUser, addMembership, initLearnerRows, grantConsent, createSession, rolesOf, toBirthYm } from './common.js';

const BIRTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TZ_OK = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const EMAIL_FAIL_KEY = (email, ip) => `loginfail:${sha256hex(email).slice(0, 16)}:${ip}`;

export function register(r, d) {
  const { db, clock, config, mailer, audit, limiter } = d;

  const setSessionCookie = (ctx, token, maxAge) => ctx.cookies.push(d.app.cookieStr(d.app.SESSION_COOKIE, token, { maxAge }));
  const clearCookie = (ctx) => ctx.cookies.push(d.app.cookieStr(d.app.SESSION_COOKIE, '', { maxAge: 0 }));
  const startSession = (ctx, user, tenantId, mfaPassed) => {
    // xoay phiên: huỷ phiên cũ nếu có cookie
    const old = d.app.parseCookies(ctx.req.headers.cookie)[d.app.SESSION_COOKIE];
    if (old) db.run('UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL', clock.iso(), sha256hex(old));
    const roles = rolesOf(db, user.id, tenantId);
    const ses = createSession(d, { userId: user.id, tenantId, roles, mfaPassed, ua: ctx.headers['user-agent'] || '', ipHash: d.app.ipHash(ctx.ip) });
    setSessionCookie(ctx, ses.token, ses.maxAge);
    return db.get('SELECT csrf FROM sessions WHERE id=?', ses.id).csrf;
  };

  /** DEMO_MODE: tài khoản giáo viên đăng ký TRƯỚC khi bật chế độ này (hoặc sau khi dịch vụ khởi động lại) cũng được tự duyệt. */
  const demoApprove = (user, session) => {
    if (!config.demoMode) return;
    db.tx(() => {
      if (!user.email_verified_at && user.email) { db.run('UPDATE users SET email_verified_at=? WHERE id=?', clock.iso(), user.id); user.email_verified_at = clock.iso(); }
      const tv = db.get('SELECT state FROM teacher_verifications WHERE user_id=?', user.id);
      if (!tv || ['APPROVED', 'REJECTED', 'SUSPENDED'].includes(tv.state)) return;
      db.run("UPDATE teacher_verifications SET state='APPROVED', updated_at=? WHERE user_id=?", clock.iso(), user.id);
      audit.write({ tenantId: session.tenant_id, actorId: user.id, action: 'teacher.demo_autoapprove', targetType: 'user', targetId: user.id });
    });
  };
  const meView = (user, session) => {
    demoApprove(user, session);
    const actor = d.app.buildActor(user, session);
    const tv = db.get('SELECT state FROM teacher_verifications WHERE user_id=?', user.id);
    const mfa = db.get('SELECT enabled_at FROM mfa_factors WHERE user_id=?', user.id);
    const org = db.get('SELECT id,name,kind FROM organizations WHERE id=?', session.tenant_id);
    const tenants = db.all("SELECT m.tenant_id AS id, o.name, o.kind, group_concat(m.role) AS roles FROM memberships m JOIN organizations o ON o.id=m.tenant_id WHERE m.user_id=? AND m.status='active' GROUP BY m.tenant_id", user.id);
    const consents = db.all("SELECT purpose FROM consents WHERE subject_id=? AND tenant_id=? AND state='GRANTED'", user.id, session.tenant_id).map((c) => c.purpose);
    const flags = Object.fromEntries(db.all('SELECT key, enabled FROM feature_flags').map((f) => [f.key, !!f.enabled]));
    return {
      user: { id: user.id, displayName: user.display_name, email: user.email, username: user.username, locale: user.locale, tz: user.tz, ageBand: actor.ageBand, roles: actor.roles, platformAdmin: user.platform_role === 'admin', emailVerified: !!user.email_verified_at, teacherState: tv?.state || null, mfaEnabled: !!mfa?.enabled_at, prefs: JSON.parse(user.prefs), friendCode: user.friend_code },
      tenant: org, tenants: tenants.map((t) => ({ ...t, roles: t.roles.split(',') })), consents, flags,
      session: { csrf: session.csrf, stepUp: actor.stepUp, mfaPassed: actor.mfaPassed, expiresAt: session.expires_at },
    };
  };

  const sendVerify = async (userId, email, ctx) => {
    const tok = randomToken(24);
    db.run("INSERT INTO email_tokens(token_hash,user_id,kind,expires_at) VALUES(?,?,'verify',?)", sha256hex(tok), userId, new Date(clock.ms() + 48 * 3600e3).toISOString());
    const link = `${config.appUrl || config.publicOrigins[0] || ''}/#/verify?token=${tok}`;
    await mailer.send({ to: email, subject: 'Xác minh email TRS6 / Verify your email', text: `Mở liên kết để xác minh email: ${link}`, kind: 'verify' });
  };

  // ---------- đăng ký người lớn ----------
  r.post('/auth/register', {
    auth: 'public',
    rate: [{ name: 'register', by: 'ip', limit: 10, windowSec: 3600 }],
    body: s.object({
      role: s.enum(['learner', 'teacher', 'guardian']), email: s.email(), password: s.string({ min: 1, max: 200, trim: false }),
      displayName: s.string({ min: 1, max: 40 }), birthYm: s.string({ pattern: BIRTH_RE }), locale: s.enum(['vi', 'en']).default('vi'),
      tz: s.string({ max: 60 }).default('Asia/Ho_Chi_Minh'), orgName: s.string({ min: 1, max: 120 }).optional(), acceptTerms: s.boolean(),
    }),
  }, async (ctx) => {
    if (!config.openSignup) throw err('FORBIDDEN', { messageKey: 'error.SIGNUP_CLOSED' });
    const b = ctx.body;
    if (!b.acceptTerms) throw err('VALIDATION_ERROR', { details: [{ path: 'acceptTerms', code: 'required' }] });
    if (!TZ_OK(b.tz)) throw err('VALIDATION_ERROR', { details: [{ path: 'tz', code: 'invalid' }] });
    if (ageBand(toBirthYm(b.birthYm), clock.now()) !== '18p') throw err('AGE_POLICY_DENIED', { messageKey: 'error.MINOR_NEEDS_GUARDIAN' });
    const weak = weakPassword(b.password, [b.email.split('@')[0], b.displayName]);
    if (weak) throw err('VALIDATION_ERROR', { details: [{ path: 'password', code: weak }] });
    if (config.hibp && (await hibpPwned(b.password))) throw err('VALIDATION_ERROR', { details: [{ path: 'password', code: 'password.pwned' }] });
    const hash = await hashPassword(b.password);
    const out = db.tx(() => {
      if (db.get('SELECT 1 FROM users WHERE email=?', b.email)) throw err('CONFLICT', { messageKey: 'error.EMAIL_TAKEN' });
      const orgId = uuidv7();
      const kind = b.role === 'teacher' ? 'school' : b.role === 'guardian' ? 'family' : 'personal';
      const orgName = b.role === 'teacher' ? (b.orgName || `Lớp của ${b.displayName}`) : b.role === 'guardian' ? `Gia đình ${b.displayName}` : `Học cá nhân – ${b.displayName}`;
      db.run('INSERT INTO organizations(id,name,kind,created_at) VALUES(?,?,?,?)', orgId, orgName, kind, clock.iso());
      const uid = insertUser(db, clock, { email: b.email, tenantId: orgId, passwordHash: hash, birthYm: toBirthYm(b.birthYm), displayName: b.displayName, locale: b.locale, tz: b.tz });
      addMembership(db, clock, orgId, uid, b.role); addMembership(db, clock, orgId, uid, 'owner');
      if (b.role === 'learner') { initLearnerRows(db, clock, orgId, uid); grantConsent(db, clock, { tenantId: orgId, subjectId: uid, grantedBy: uid, purpose: 'account', method: 'self_adult' }); }
      if (b.role === 'teacher') {
        db.run("INSERT INTO teacher_verifications(user_id,tenant_id,state,updated_at) VALUES(?,?,?,?)", uid, orgId, config.demoMode ? 'APPROVED' : 'SUBMITTED', clock.iso());
        if (config.demoMode) { db.run('UPDATE users SET email_verified_at=? WHERE id=?', clock.iso(), uid); audit.write({ tenantId: orgId, actorId: uid, action: 'teacher.demo_autoapprove', targetType: 'user', targetId: uid }); }
      } else if (config.demoMode && b.email) db.run('UPDATE users SET email_verified_at=? WHERE id=?', clock.iso(), uid);
      audit.write({ tenantId: orgId, actorId: uid, action: 'auth.register', targetType: 'user', targetId: uid, diff: { role: b.role }, requestId: ctx.requestId });
      return { uid, orgId };
    });
    const user = db.get('SELECT * FROM users WHERE id=?', out.uid);
    const csrf = startSession(ctx, user, out.orgId, false);
    await sendVerify(out.uid, b.email, ctx);
    return { status: 201, __raw: true, data: { csrf, ...meView(user, db.get('SELECT * FROM sessions WHERE csrf=?', csrf)) } };
  });

  // ---------- đăng nhập ----------
  async function finishLogin(ctx, user, tenantId, totpCode) {
    const mfa = db.get('SELECT * FROM mfa_factors WHERE user_id=? AND enabled_at IS NOT NULL', user.id);
    let mfaPassed = false;
    if (mfa) {
      if (!totpCode) throw err('MFA_REQUIRED');
      if (!verifyTotp(unseal(config.secret, mfa.secret_sealed), totpCode, clock.ms())) throw err('UNAUTHENTICATED', { messageKey: 'error.INVALID_CREDENTIALS' });
      mfaPassed = true;
    }
    const csrf = startSession(ctx, user, tenantId, mfaPassed);
    audit.write({ tenantId, actorId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, requestId: ctx.requestId });
    const ses = db.get('SELECT * FROM sessions WHERE csrf=?', csrf);
    return { __raw: true, status: 200, data: meView(user, ses) };
  }

  r.post('/auth/login', {
    auth: 'public',
    rate: [{ name: 'login-ip', by: 'ip', limit: 30, windowSec: 900 }],
    body: s.object({ email: s.email(), password: s.string({ min: 1, max: 200, trim: false }), totp: s.string({ max: 8 }).optional() }),
  }, async (ctx) => {
    const { email, password, totp } = ctx.body;
    const key = EMAIL_FAIL_KEY(email, d.app.ipHash(ctx.ip));
    const failures = db.get('SELECT COALESCE(SUM(cost),0) AS n FROM rate_events WHERE k=? AND ts>?', key, clock.ms() - 900e3).n;
    if (failures >= 5) throw err('RATE_LIMITED', { retryAfter: 900 });
    const user = db.get("SELECT * FROM users WHERE email=? AND status='active'", email);
    const ok = user ? await verifyPassword(password, user.password_hash) : (await dummyVerify(password), false);
    if (!ok) { db.run('INSERT INTO rate_events(k,ts,cost) VALUES(?,?,1)', key, clock.ms()); throw err('UNAUTHENTICATED', { messageKey: 'error.INVALID_CREDENTIALS' }); }
    const res = await finishLogin(ctx, user, user.home_tenant_id, totp);
    db.run('DELETE FROM rate_events WHERE k=?', key);
    return res;
  });

  // Kid/Teen/học viên do giáo viên cấp: mã lớp + tên đăng nhập + PIN
  r.post('/auth/login-class', {
    auth: 'public',
    rate: [{ name: 'loginc-ip', by: 'ip', limit: 40, windowSec: 900 }],
    body: s.object({ classCode: s.string({ min: 4, max: 12 }), username: s.string({ min: 2, max: 30 }), pin: s.string({ min: 4, max: 64, trim: false }) }),
  }, async (ctx) => {
    const { classCode, username, pin } = ctx.body;
    const code = classCode.toUpperCase(), uname = username.toLowerCase();
    const key = `loginfailc:${sha256hex(code + ':' + uname).slice(0, 16)}:${d.app.ipHash(ctx.ip)}`;
    const failures = db.get('SELECT COALESCE(SUM(cost),0) AS n FROM rate_events WHERE k=? AND ts>?', key, clock.ms() - 900e3).n;
    if (failures >= 5) throw err('RATE_LIMITED', { retryAfter: 900 });
    const row = db.get(`SELECT u.* FROM classes c JOIN class_members m ON m.class_id=c.id AND m.status='active' JOIN users u ON u.id=m.user_id
                        WHERE c.join_code=? AND c.status='active' AND u.username=? AND u.home_tenant_id=c.tenant_id AND u.status='active'`, code, uname);
    const ok = row ? await verifyPassword(pin, row.password_hash) : (await dummyVerify(pin), false);
    if (!ok) { db.run('INSERT INTO rate_events(k,ts,cost) VALUES(?,?,1)', key, clock.ms()); throw err('UNAUTHENTICATED', { messageKey: 'error.INVALID_CREDENTIALS' }); }
    const res = await finishLogin(ctx, row, row.home_tenant_id, null);
    db.run('DELETE FROM rate_events WHERE k=?', key);
    return res;
  });

  r.post('/auth/logout', { auth: 'session', selfOnly: true }, (ctx) => {
    db.run('UPDATE sessions SET revoked_at=? WHERE id=?', clock.iso(), ctx.session.id);
    clearCookie(ctx);
    return { signedOut: true };
  });
  r.post('/auth/logout-all', { auth: 'session', selfOnly: true }, (ctx) => {
    const n = db.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', clock.iso(), ctx.user.id).changes;
    audit.write({ tenantId: ctx.actor.tenantId, actorId: ctx.user.id, action: 'auth.logout_all', targetType: 'user', targetId: ctx.user.id, diff: { revoked: n }, requestId: ctx.requestId });
    clearCookie(ctx);
    return { revoked: n };
  });

  // step-up: nhập lại mật khẩu/PIN (+TOTP nếu có) cho thao tác nhạy cảm
  r.post('/auth/step-up', {
    auth: 'session', selfOnly: true,
    rate: [{ name: 'stepup', by: 'user', limit: 10, windowSec: 900 }],
    body: s.object({ password: s.string({ min: 1, max: 200, trim: false }), totp: s.string({ max: 8 }).optional() }),
  }, async (ctx) => {
    if (!(await verifyPassword(ctx.body.password, ctx.user.password_hash))) throw err('UNAUTHENTICATED', { messageKey: 'error.INVALID_CREDENTIALS' });
    const mfa = db.get('SELECT * FROM mfa_factors WHERE user_id=? AND enabled_at IS NOT NULL', ctx.user.id);
    if (mfa) {
      if (!ctx.body.totp) throw err('MFA_REQUIRED');
      if (!verifyTotp(unseal(config.secret, mfa.secret_sealed), ctx.body.totp, clock.ms())) throw err('UNAUTHENTICATED', { messageKey: 'error.INVALID_CREDENTIALS' });
      db.run('UPDATE sessions SET mfa_passed=1 WHERE id=?', ctx.session.id);
    }
    const until = new Date(clock.ms() + 10 * 60e3).toISOString();
    db.run('UPDATE sessions SET stepup_until=? WHERE id=?', until, ctx.session.id);
    return { stepUpUntil: until };
  });

  r.post('/auth/switch-tenant', { auth: 'session', selfOnly: true, body: s.object({ tenantId: s.uuid() }) }, (ctx) => {
    const m = db.get("SELECT 1 FROM memberships WHERE user_id=? AND tenant_id=? AND status='active'", ctx.user.id, ctx.body.tenantId);
    if (!m) throw err('NOT_FOUND');
    db.run('UPDATE sessions SET tenant_id=? WHERE id=?', ctx.body.tenantId, ctx.session.id);
    return meView(ctx.user, db.get('SELECT * FROM sessions WHERE id=?', ctx.session.id));
  });

  // ---------- email / mật khẩu ----------
  r.post('/auth/verify-email', { auth: 'public', rate: [{ name: 'verify', by: 'ip', limit: 20, windowSec: 3600 }], body: s.object({ token: s.string({ min: 10, max: 100 }) }) }, (ctx) => {
    const h = sha256hex(ctx.body.token);
    const out = db.tx(() => {
      const t = db.get("SELECT * FROM email_tokens WHERE token_hash=? AND kind='verify' AND used_at IS NULL AND expires_at>?", h, clock.iso());
      if (!t) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.TOKEN_INVALID' });
      db.run('UPDATE email_tokens SET used_at=? WHERE token_hash=?', clock.iso(), h);
      db.run('UPDATE users SET email_verified_at=? WHERE id=?', clock.iso(), t.user_id);
      db.run("UPDATE teacher_verifications SET state='EMAIL_VERIFIED', updated_at=? WHERE user_id=? AND state='SUBMITTED'", clock.iso(), t.user_id);
      return t;
    });
    return { verified: true, userId: out.user_id };
  });
  r.post('/auth/resend-verification', { auth: 'session', selfOnly: true, rate: [{ name: 'resend', by: 'user', limit: 3, windowSec: 3600 }] }, async (ctx) => {
    if (ctx.user.email && !ctx.user.email_verified_at) await sendVerify(ctx.user.id, ctx.user.email, ctx);
    return { sent: true };
  });

  r.post('/auth/password-reset/request', {
    auth: 'public', rate: [{ name: 'pwreset-ip', by: 'ip', limit: 10, windowSec: 3600 }, { name: 'pwreset-acct', by: (c) => sha256hex(c.body.email), limit: 3, windowSec: 3600 }],
    body: s.object({ email: s.email() }),
  }, async (ctx) => {
    const u = db.get("SELECT id,email FROM users WHERE email=? AND status='active'", ctx.body.email);
    if (u) {
      const tok = randomToken(24);
      db.run("INSERT INTO email_tokens(token_hash,user_id,kind,expires_at) VALUES(?,?,'reset',?)", sha256hex(tok), u.id, new Date(clock.ms() + 3600e3).toISOString());
      await mailer.send({ to: u.email, subject: 'Đặt lại mật khẩu TRS6', text: `Mở liên kết (hiệu lực 1 giờ): ${config.appUrl || config.publicOrigins[0] || ''}/#/reset?token=${tok}`, kind: 'reset' });
    }
    return { accepted: true }; // phản hồi đồng nhất, chống dò tài khoản
  });
  r.post('/auth/password-reset/confirm', {
    auth: 'public', rate: [{ name: 'pwreset-confirm', by: 'ip', limit: 10, windowSec: 3600 }],
    body: s.object({ token: s.string({ min: 10, max: 100 }), password: s.string({ min: 1, max: 200, trim: false }) }),
  }, async (ctx) => {
    const h = sha256hex(ctx.body.token);
    const t = db.get("SELECT * FROM email_tokens WHERE token_hash=? AND kind='reset' AND used_at IS NULL AND expires_at>?", h, clock.iso());
    if (!t) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.TOKEN_INVALID' });
    const weak = weakPassword(ctx.body.password);
    if (weak) throw err('VALIDATION_ERROR', { details: [{ path: 'password', code: weak }] });
    const hash = await hashPassword(ctx.body.password);
    db.tx(() => {
      db.run('UPDATE email_tokens SET used_at=? WHERE token_hash=?', clock.iso(), h);
      db.run('UPDATE users SET password_hash=? WHERE id=?', hash, t.user_id);
      db.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', clock.iso(), t.user_id); // thu hồi phiên khi đổi mật khẩu
      audit.write({ actorId: t.user_id, action: 'auth.password_reset', targetType: 'user', targetId: t.user_id, requestId: ctx.requestId });
    });
    return { reset: true };
  });

  r.post('/me/password', {
    action: 'me.update', rate: [{ name: 'pwchange', by: 'user', limit: 5, windowSec: 3600 }],
    body: s.object({ current: s.string({ min: 1, max: 200, trim: false }), next: s.string({ min: 1, max: 200, trim: false }) }),
  }, async (ctx) => {
    if (!ctx.actor.stepUp) throw err('STEP_UP_REQUIRED');
    if (!(await verifyPassword(ctx.body.current, ctx.user.password_hash))) throw err('UNAUTHENTICATED', { messageKey: 'error.INVALID_CREDENTIALS' });
    const isManaged = !ctx.user.email;
    const weak = isManaged ? (/^\d{4,8}$/.test(ctx.body.next) ? null : 'password.pin_format') : weakPassword(ctx.body.next, [ctx.user.display_name]);
    if (weak) throw err('VALIDATION_ERROR', { details: [{ path: 'next', code: weak }] });
    const hash = await hashPassword(ctx.body.next);
    db.tx(() => {
      db.run('UPDATE users SET password_hash=? WHERE id=?', hash, ctx.user.id);
      db.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL', clock.iso(), ctx.user.id, ctx.session.id);
      audit.write({ tenantId: ctx.actor.tenantId, actorId: ctx.user.id, action: 'auth.password_change', targetType: 'user', targetId: ctx.user.id, requestId: ctx.requestId });
    });
    return { changed: true };
  });

  // ---------- hồ sơ của tôi ----------
  r.get('/me', { action: 'me.read' }, (ctx) => meView(ctx.user, ctx.session));
  const PREFS = s.object({
    dailyGoal: s.int({ min: 1, max: 100 }).optional(), hintMode: s.enum(['after_flip', 'always', 'hidden']).optional(),
    readEasy: s.boolean().optional(), lite: s.boolean().optional(), reduceMotion: s.boolean().optional(), sound: s.boolean().optional(),
    quietStart: s.int({ min: 0, max: 23 }).optional(), quietEnd: s.int({ min: 0, max: 23 }).optional(),
  });
  r.patch('/me', {
    action: 'me.update', body: s.object({ displayName: s.string({ min: 1, max: 40 }).optional(), locale: s.enum(['vi', 'en']).optional(), tz: s.string({ max: 60 }).optional(), prefs: PREFS.optional() }),
  }, (ctx) => {
    const b = ctx.body;
    if (b.tz && !TZ_OK(b.tz)) throw err('VALIDATION_ERROR', { details: [{ path: 'tz', code: 'invalid' }] });
    db.tx(() => {
      if (b.displayName) db.run('UPDATE users SET display_name=? WHERE id=?', b.displayName, ctx.user.id);
      if (b.locale) db.run('UPDATE users SET locale=? WHERE id=?', b.locale, ctx.user.id);
      if (b.tz) db.run('UPDATE users SET tz=? WHERE id=?', b.tz, ctx.user.id);
      if (b.prefs) {
        const cur = JSON.parse(ctx.user.prefs);
        db.run('UPDATE users SET prefs=? WHERE id=?', JSON.stringify({ ...cur, ...b.prefs, v: 1 }), ctx.user.id);
      }
      audit.write({ tenantId: ctx.actor.tenantId, actorId: ctx.user.id, action: 'me.update', targetType: 'user', targetId: ctx.user.id, diff: { fields: Object.keys(b) }, requestId: ctx.requestId });
    });
    const u = db.get('SELECT * FROM users WHERE id=?', ctx.user.id);
    return meView(u, ctx.session);
  });

  // ---------- phiên / thiết bị ----------
  r.get('/me/sessions', { action: 'session.list' }, (ctx) => {
    const rows = db.all('SELECT id,created_at,last_seen_at,expires_at,ua FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY last_seen_at DESC', ctx.user.id, clock.iso());
    return { sessions: rows.map((x) => ({ id: x.id.slice(0, 16), current: x.id === ctx.session.id, createdAt: x.created_at, lastSeenAt: x.last_seen_at, expiresAt: x.expires_at, device: x.ua })) };
  });
  r.delete('/me/sessions/:id', {
    action: 'session.revoke',
    resource: (ctx) => {
      const row = db.get('SELECT user_id FROM sessions WHERE substr(id,1,16)=? AND user_id=?', ctx.params.id, ctx.user.id);
      if (!row) throw err('NOT_FOUND');
      return { ownerId: row.user_id };
    },
  }, (ctx) => {
    db.run('UPDATE sessions SET revoked_at=? WHERE substr(id,1,16)=? AND user_id=?', clock.iso(), ctx.params.id, ctx.user.id);
    return { revoked: true };
  });

  // ---------- MFA TOTP ----------
  r.post('/me/mfa/setup', { action: 'mfa.manage', rate: [{ name: 'mfa', by: 'user', limit: 10, windowSec: 3600 }] }, (ctx) => {
    if (db.get('SELECT 1 FROM mfa_factors WHERE user_id=? AND enabled_at IS NOT NULL', ctx.user.id)) throw err('CONFLICT', { messageKey: 'error.MFA_ALREADY_ENABLED' });
    const secret = base32(randomBytes(20));
    db.run('INSERT OR REPLACE INTO mfa_factors(user_id,secret_sealed,enabled_at,created_at) VALUES(?,?,NULL,?)', ctx.user.id, seal(config.secret, secret), clock.iso());
    const label = encodeURIComponent(ctx.user.email || ctx.user.username || ctx.user.id);
    return { secret, otpauth: `otpauth://totp/TRS6:${label}?secret=${secret}&issuer=TRS6&digits=6&period=30` };
  });
  r.post('/me/mfa/enable', { action: 'mfa.manage', rate: [{ name: 'mfa-en', by: 'user', limit: 10, windowSec: 900 }], body: s.object({ code: s.string({ min: 6, max: 6 }) }) }, (ctx) => {
    const f = db.get('SELECT * FROM mfa_factors WHERE user_id=? AND enabled_at IS NULL', ctx.user.id);
    if (!f) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.MFA_NOT_SETUP' });
    if (!verifyTotp(unseal(config.secret, f.secret_sealed), ctx.body.code, clock.ms())) throw err('VALIDATION_ERROR', { details: [{ path: 'code', code: 'invalid' }] });
    db.run('UPDATE mfa_factors SET enabled_at=? WHERE user_id=?', clock.iso(), ctx.user.id);
    db.run('UPDATE sessions SET mfa_passed=1 WHERE id=?', ctx.session.id);
    audit.write({ tenantId: ctx.actor.tenantId, actorId: ctx.user.id, action: 'mfa.enable', targetType: 'user', targetId: ctx.user.id, requestId: ctx.requestId });
    return { enabled: true };
  });
  r.post('/me/mfa/disable', { action: 'mfa.manage', body: s.object({ code: s.string({ min: 6, max: 6 }) }) }, (ctx) => {
    if (ctx.user.platform_role === 'admin') throw err('FORBIDDEN', { messageKey: 'error.ADMIN_MFA_MANDATORY' });
    if (!ctx.actor.stepUp) throw err('STEP_UP_REQUIRED');
    const f = db.get('SELECT * FROM mfa_factors WHERE user_id=? AND enabled_at IS NOT NULL', ctx.user.id);
    if (!f || !verifyTotp(unseal(config.secret, f.secret_sealed), ctx.body.code, clock.ms())) throw err('VALIDATION_ERROR', { details: [{ path: 'code', code: 'invalid' }] });
    db.run('DELETE FROM mfa_factors WHERE user_id=?', ctx.user.id);
    audit.write({ tenantId: ctx.actor.tenantId, actorId: ctx.user.id, action: 'mfa.disable', targetType: 'user', targetId: ctx.user.id, requestId: ctx.requestId });
    return { disabled: true };
  });

  // ---------- thông báo ----------
  r.get('/me/notifications', { action: 'notification.read' }, (ctx) => {
    const rows = db.all('SELECT id,kind,params,created_at,read_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50', ctx.user.id);
    return { notifications: rows.map((n) => ({ ...n, params: JSON.parse(n.params) })), unread: rows.filter((n) => !n.read_at).length };
  });
  r.post('/me/notifications/read', { action: 'notification.read' }, (ctx) => {
    db.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', clock.iso(), ctx.user.id);
    return { ok: true };
  });
}
