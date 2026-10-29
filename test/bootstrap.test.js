import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';
import { bootstrapAdminFromEnv } from '../server/lib/bootstrap.js';

test('bootstrap admin từ env: tạo một lần, không tạo lại, từ chối mật khẩu yếu', async () => {
  const t = await createTestApp();
  const log = { info() {} };
  const env = { BOOTSTRAP_ADMIN_EMAIL: 'Boss@Example.com', BOOTSTRAP_ADMIN_PASSWORD: 'Correct-Horse-9' };
  assert.equal(await bootstrapAdminFromEnv({ db: t.db, clock: t.clock, log, env: {} }), null);
  assert.match((await bootstrapAdminFromEnv({ db: t.db, clock: t.clock, log, env: { ...env, BOOTSTRAP_ADMIN_PASSWORD: '123' } })).reason, /^weak/);
  assert.equal((await bootstrapAdminFromEnv({ db: t.db, clock: t.clock, log, env })).created, true);
  assert.equal((await bootstrapAdminFromEnv({ db: t.db, clock: t.clock, log, env })).reason, 'admin_exists');
  const u = t.db.get("SELECT email, platform_role FROM users WHERE platform_role='admin'");
  assert.equal(u.email, 'boss@example.com');
  const c = t.client('a');
  const r = await c.post('/auth/login', { email: 'boss@example.com', password: 'Correct-Horse-9' });
  assert.ok(r.status === 200 || r.status === 403, `login status ${r.status}`);
  await t.close();
});

test('DEMO_MODE: giáo viên tự được duyệt; mặc định thì không', async () => {
  for (const [demo, want] of [[false, 'SUBMITTED'], [true, 'APPROVED']]) {
    const t = await createTestApp({ env: { DEMO_MODE: demo ? 'true' : 'false' } });
    const { registerAdult } = await import('./helpers.js');
    const tc = await registerAdult(t, { role: 'teacher' });
    assert.equal(t.db.get('SELECT state FROM teacher_verifications WHERE user_id=?', tc.id).state, want);
    if (demo) { await tc.refresh(); const r = await tc.get('/teacher/classes'); assert.equal(r.status, 200); }
    await t.close();
  }
});
test('DEMO_MODE: giáo viên đã đăng ký từ trước (đang chờ duyệt) được tự duyệt ngay khi mở /me', async () => {
  const t = await createTestApp({ env: { DEMO_MODE: 'true' } });
  const { registerAdult } = await import('./helpers.js');
  const tc = await registerAdult(t, { role: 'teacher' });
  t.db.run('DROP TRIGGER teacher_sm');                      // chỉ trong test: giả lập tài khoản cũ đang chờ duyệt
  t.db.run("UPDATE teacher_verifications SET state='SUBMITTED' WHERE user_id=?", tc.id); t.db.run('UPDATE users SET email_verified_at=NULL WHERE id=?', tc.id);
  assert.equal((await tc.get('/teacher/classes')).status, 403);
  const me = tc.must(await tc.get('/me'));
  assert.equal(me.user.emailVerified, true); assert.ok(!me.user.roles.includes('teacher_pending'));
  assert.equal((await tc.get('/teacher/classes')).status, 200);
  await t.close();
});
test('AUTO_APPROVE mặc định BẬT ở production dù DEMO_MODE=false; tắt được bằng AUTO_APPROVE=false', async () => {
  const { loadConfig } = await import('../server/lib/config.js');
  const base = { NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40), PUBLIC_ORIGIN: 'https://a.onrender.com' };
  assert.equal(loadConfig({ ...base, DEMO_MODE: 'false' }).demoMode, true);
  assert.equal(loadConfig({ ...base, AUTO_APPROVE: 'false' }).demoMode, false);
  assert.equal(loadConfig({ NODE_ENV: 'test', APP_SECRET: 'x'.repeat(40) }).demoMode, false);
});
test('PUBLIC_ORIGIN lấy từ RENDER_EXTERNAL_URL ở production', async () => {
  const { loadConfig } = await import('../server/lib/config.js');
  const c = loadConfig({ NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40), RENDER_EXTERNAL_URL: 'https://a.onrender.com' });
  assert.deepEqual(c.publicOrigins, ['https://a.onrender.com']);
});

test('kiểm tra Origin: đúng PUBLIC_ORIGIN (kể cả dấu / thừa, hoa thường) hoặc cùng host → qua; origin lạ → chặn', async () => {
  const t = await createTestApp({ env: { PUBLIC_ORIGIN: 'https://Thi-Fe.onrender.com/' } });
  const body = JSON.stringify({ email: 'x@example.com', password: 'Correct-Horse-9' });
  const post = (origin) => fetch(`${t.base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'Idempotency-Key': crypto.randomUUID() }, body });
  assert.notEqual((await post('https://thi-fe.onrender.com')).status, 403);
  assert.notEqual((await post(t.base)).status, 403);                 // cùng host
  const bad = await post('https://evil.example.com');
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).error.messageKey, 'error.BAD_ORIGIN');
  await t.close();
});
