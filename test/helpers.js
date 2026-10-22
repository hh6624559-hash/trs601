import { build } from '../server/app.js';
import { loadConfig } from '../server/lib/config.js';
import { openDb } from '../server/lib/db.js';
import { FakeClock } from '../server/lib/clock.js';
import { hashPassword, totp } from '../server/lib/crypto.js';
import { uuidv7 } from '../server/lib/ids.js';
import { insertUser, addMembership } from '../server/modules/common.js';
import { randomUUID } from 'node:crypto';

export const PW = 'Correct-Horse-9';
export const adultBirth = '1990-05';

export async function createTestApp({ start = '2026-03-10T03:00:00.000Z', env = {}, extra = {} } = {}) {
  const clock = new FakeClock(start);
  const config = loadConfig({ NODE_ENV: 'test', APP_SECRET: 'a'.repeat(48), EMAIL_MODE: 'memory', OPEN_SIGNUP: 'true', PUBLIC_ORIGIN: '', ...env });
  const ctx = build({ config, clock, db: openDb(':memory:'), ...extra, log: { debug() {}, info() {}, warn() {}, error(m, f) { if (process.env.TEST_VERBOSE) console.error(m, f); } } });
  const addr = await ctx.app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const t = { ...ctx, clock, base, config };
  t.close = async () => { ctx.jobs.stop(); await ctx.app.close(); ctx.db.close(); };
  t.client = (name = 'c') => makeClient(t, name);
  return t;
}

export function makeClient(t, name) {
  const c = { name, cookie: '', csrf: '', me: null, ua: `test-${name}` };
  c.raw = async (method, path, body, headers = {}) => {
    t.clock.advance(400); // tránh chạm rate limit IP khi đồng hồ giả đứng yên
    const h = { 'Content-Type': 'application/json', 'User-Agent': c.ua, ...headers };
    if (c.cookie) h.Cookie = c.cookie;
    if (c.csrf && method !== 'GET' && h['X-CSRF-Token'] === undefined) h['X-CSRF-Token'] = c.csrf;
    if (method !== 'GET' && h['Idempotency-Key'] === undefined && !c.noAutoIdem) h['Idempotency-Key'] = randomUUID();
    const res = await fetch(`${t.base}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const sc = res.headers.getSetCookie?.() || [];
    for (const cookie of sc) { const [kv] = cookie.split(';'); const [k, v] = kv.split('='); if (/Max-Age=0/i.test(cookie)) c.cookie = ''; else c.cookie = `${k}=${v}`; }
    let json = null; try { json = await res.json(); } catch { /* không phải JSON */ }
    return { status: res.status, body: json, headers: res.headers, data: json?.data, error: json?.error };
  };
  const wrap = (m) => async (path, body, headers) => {
    const r = await c.raw(m, path, body, headers);
    if (r.data?.session?.csrf) { c.csrf = r.data.session.csrf; c.me = r.data; }
    return r;
  };
  c.get = wrap('GET'); c.post = wrap('POST'); c.put = wrap('PUT'); c.patch = wrap('PATCH'); c.del = wrap('DELETE');
  c.refresh = async () => { const r = await c.get('/me'); if (r.data?.session) { c.csrf = r.data.session.csrf; c.me = r.data; } return r; };
  c.must = (r, status = 200) => { if (r.status !== status) throw new Error(`expected ${status} got ${r.status}: ${JSON.stringify(r.body)}`); return r.data; };
  return c;
}

let counter = 0;
export const uniq = (p = 'u') => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function registerAdult(t, { role = 'learner', name, email, birthYm = adultBirth, orgName } = {}) {
  const c = t.client(name || uniq(role));
  email ||= `${uniq(role)}@example.com`;
  const r = await c.post('/auth/register', { role, email, password: PW, displayName: name || `Tester ${role}`, birthYm, acceptTerms: true, ...(orgName ? { orgName } : {}) });
  c.must(r, 201); c.email = email; c.id = r.data.user.id; c.tenantId = r.data.tenant.id;
  return c;
}

export function tokenFrom(t, kind) {
  const m = [...t.mailer.sent].reverse().find((x) => x.kind === kind);
  return m?.text.match(/token=([\w-]+)/)?.[1];
}

/** Admin nền tảng + MFA bật (không có admin mặc định: tạo trực tiếp trong DB giống script create-admin). */
export async function makeAdmin(t) {
  const email = `${uniq('admin')}@example.com`;
  const hash = await hashPassword(PW);
  const id = t.db.tx(() => {
    const org = uuidv7();
    t.db.run("INSERT INTO organizations(id,name,kind,created_at) VALUES(?,?,'personal',?)", org, 'Admin', t.clock.iso());
    const uid = insertUser(t.db, t.clock, { email, tenantId: org, passwordHash: hash, birthYm: '1990-01-01', displayName: 'Admin' });
    t.db.run("UPDATE users SET platform_role='admin', email_verified_at=? WHERE id=?", t.clock.iso(), uid);
    addMembership(t.db, t.clock, org, uid, 'owner'); addMembership(t.db, t.clock, org, uid, 'admin');
    return uid;
  });
  const c = t.client('admin'); c.email = email; c.id = id;
  c.must(await c.post('/auth/login', { email, password: PW }));
  const setup = c.must(await c.post('/me/mfa/setup', {}));
  c.must(await c.post('/me/mfa/enable', { code: totp(setup.secret, t.clock.ms()) }));
  c.totpSecret = setup.secret;
  await c.refresh();
  return c;
}

export async function makeApprovedTeacher(t, admin, opts = {}) {
  const teacher = await registerAdult(t, { role: 'teacher', ...opts });
  const tok = tokenFrom(t, 'verify');
  const pub = t.client('pub');
  pub.must(await pub.post('/auth/verify-email', { token: tok }));
  admin.must(await admin.post(`/admin/teachers/${teacher.id}/decision`, { decision: 'approve' }));
  await teacher.refresh();
  return teacher;
}

/** Tạo lớp + học viên; trả credentials và client đã đăng nhập cho từng học viên. */
export async function makeClass(t, teacher, students = [{ displayName: 'An', birthYm: '2015-04' }], name = 'Lớp 1A') {
  const cls = teacher.must(await teacher.post('/teacher/classes', { name }), 201);
  const made = teacher.must(await teacher.post(`/teacher/classes/${cls.id}/students`, { students, attestation: true }), 201);
  const clients = [];
  for (const cr of made.credentials) {
    const sc = t.client(cr.username);
    sc.must(await sc.post('/auth/login-class', { classCode: made.classCode, username: cr.username, pin: cr.pin }));
    sc.id = cr.id; sc.cred = cr; sc.classCode = made.classCode;
    clients.push(sc);
  }
  return { cls, classCode: made.classCode, students: clients, credentials: made.credentials };
}

export const uuid = () => randomUUID();
export const cleanup = async (t) => { await t.close(); };
