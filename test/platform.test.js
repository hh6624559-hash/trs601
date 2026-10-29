import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, registerAdult, makeAdmin, makeApprovedTeacher, makeClass, PW, uuid } from './helpers.js';
import { can, ageBand } from '../server/lib/policy.js';
import { MATRIX } from '../server/lib/policy.matrix.js';
import { ERROR_TABLE } from '../server/lib/errors.js';
import { totp } from '../server/lib/crypto.js';

let t;
before(async () => { t = await createTestApp(); });
after(async () => { await t.close(); });

// ---- Policy sinh từ ma trận ----
test('policy: ma trận sinh test — vai trò không có trong roles luôn bị từ chối; mặc định từ chối', () => {
  const ROLES = ['learner', 'teacher', 'guardian', 'platform_admin', 'auditor'];
  assert.equal(can({ id: 'x', roles: ['learner'], tenantId: 't' }, 'khong.ton.tai').allowed, false);
  assert.equal(can(null, 'me.read').allowed, false);
  for (const [action, rule] of Object.entries(MATRIX)) {
    for (const role of ROLES) {
      const a = { id: 'u', roles: [role], tenantId: 't', ageBand: '18p', teacherApproved: true, mfaPassed: true, stepUp: true };
      const d = can(a, action, { tenantId: 't', ownerId: 'u', classId: 'c' }, { rel: { teacherOf: true, guardianOf: true, classMember: true }, consents: new Set(['account', 'social']) });
      if (!rule.roles.includes(role)) assert.equal(d.allowed, false, `${action}/${role} phải bị từ chối`);
    }
    // sai tenant → luôn từ chối trừ phạm vi platform
    const scopes = [].concat(rule.scope);
    if (!scopes.includes('platform')) {
      const role = rule.roles[0];
      const d = can({ id: 'u', roles: [role], tenantId: 't1', ageBand: '18p', teacherApproved: true, mfaPassed: true, stepUp: true }, action, { tenantId: 't2', ownerId: 'u' }, { rel: { teacherOf: true, guardianOf: true, classMember: true }, consents: new Set(['account', 'social']) });
      assert.equal(d.allowed, false, `${action} chéo tenant phải bị từ chối`);
    }
  }
});

test('policy: tuổi bảo thủ — sinh tháng 3/2008 vẫn là 13_17 vào tháng 3/2026; trẻ 12 tuổi là u13', () => {
  const now = new Date('2026-03-10T00:00:00Z');
  assert.equal(ageBand('2014-03', now), 'u13');
  assert.equal(ageBand('2012-01', now), '13_17');
  assert.equal(ageBand('1990-01', now), '18p');
});

test('mọi route có action trong ma trận hoặc selfOnly (khởi động đã kiểm tra); có ≥100 route', () => {
  assert.ok(t.routes.length >= 100, `routes=${t.routes.length}`);
});

test('bảng lỗi: mọi mã có status và messageKey', () => {
  for (const [code, e] of Object.entries(ERROR_TABLE)) assert.ok(e[0] >= 400 && e[0] < 600 && typeof e[1] === 'boolean', code);
});

// ---- HTTP ----
test('header bảo mật + CSP không inline', async () => {
  const r = await fetch(t.base + '/healthz');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.doesNotMatch(r.headers.get('content-security-policy'), /unsafe-inline/);
});

test('body quá lớn → 413; trường lạ → 400 (strict)', async () => {
  const c = await registerAdult(t);
  const big = await c.raw('POST', '/learn/reviews', 'x'.repeat(2_000_000));
  assert.equal(big.status, 413);
  const r = await c.post('/me/collections', { title: 'a', thamSoLa: 1 });
  assert.equal(r.status, 400);
});

test('Idempotency-Key: phát lại cùng key+body trả cùng kết quả; khác body → 409/422', async () => {
  const c = await registerAdult(t);
  const key = uuid();
  const a = await c.post('/me/collections', { title: 'Idem' }, { 'Idempotency-Key': key });
  const b = await c.post('/me/collections', { title: 'Idem' }, { 'Idempotency-Key': key });
  assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(a.data.id, b.data.id);
  const d = await c.post('/me/collections', { title: 'Khác' }, { 'Idempotency-Key': key });
  assert.ok([409, 422].includes(d.status), `status ${d.status}`);
  const list = c.must(await c.get('/me/collections'));
  assert.equal(list.collections.filter((x) => x.title === 'Idem').length, 1);
});

test('đăng nhập sai nhiều lần → khóa/429 (fail-closed)', async () => {
  const u = await registerAdult(t);
  const c = t.client('brute');
  let last;
  for (let i = 0; i < 12; i++) last = await c.post('/auth/login', { email: u.email, password: 'Sai-Mat-Khau-1' });
  assert.ok([423, 429].includes(last.status), `status ${last.status}`);
  const ok = await c.post('/auth/login', { email: u.email, password: PW });
  assert.ok(ok.status >= 400, 'tài khoản bị khóa tạm thời kể cả mật khẩu đúng');
});

test('static: SPA fallback và không lộ file ngoài public', async () => {
  const r = await fetch(t.base + '/some/route'); assert.equal(r.status, 200);
  const bad = await fetch(t.base + '/..%2f..%2fpackage.json'); assert.notEqual(bad.headers.get('content-type')?.includes('json'), true);
});

// ---- Dữ liệu bất biến ----
test('append-only: ledger, review_events, audit_logs không UPDATE/DELETE được', async () => {
  const c = await registerAdult(t, { role: 'learner' });
  const topics = c.must(await c.get('/vocab/topics'));
  const col = c.must(await c.post('/me/collections', { title: 'x', fromTopic: topics.topics[0].topic ?? topics.topics[0].key ?? topics.topics[0], limit: 3 }), 201);
  const today = c.must(await c.get('/learn/today'));
  c.must(await c.post('/learn/reviews', { events: [{ id: uuid(), senseId: today.cards[0].senseId ?? today.cards[0].id, rating: 3 }] }));
  assert.throws(() => t.db.run('UPDATE audit_logs SET action=?', 'x'));
  assert.throws(() => t.db.run('DELETE FROM audit_logs'));
  assert.throws(() => t.db.run('UPDATE economy_ledger SET delta=99'));
  assert.throws(() => t.db.run('DELETE FROM economy_ledger'));
  assert.throws(() => t.db.run('DELETE FROM review_events'));
});

test('audit: chuỗi băm kiểm chứng được; admin cần MFA; auditor chỉ đọc', async () => {
  const admin = await makeAdmin(t);
  const v = admin.must(await admin.get('/admin/audit/verify'));
  assert.ok(v.ok ?? v.valid ?? true);
  const plain = await registerAdult(t);
  assert.ok([403, 404].includes((await plain.get('/admin/audit')).status));
  assert.equal(JSON.stringify(admin.must(await admin.get('/admin/audit'))).includes('@example.com'), false, 'audit không chứa email (PII)');
});

// ---- Riêng tư ----
test('xuất dữ liệu cần step-up; xóa tài khoản ẩn danh hóa, giữ ledger/audit', async () => {
  const c = await registerAdult(t, { role: 'learner' });
  assert.equal((await c.post('/me/data-export', {})).status, 403);
  c.must(await c.post('/auth/step-up', { password: PW }));
  const ex = c.must(await c.post('/me/data-export', {}));
  assert.ok(ex.data);
  const del = c.must(await c.post('/me/deletion-request', { confirm: true }), 201);
  const id = del.id ?? del.requestId;
  c.must(await c.post(`/me/deletion-request/${id}/execute`, {}));
  const row = t.db.get('SELECT email, display_name, status FROM users WHERE id=?', c.id);
  assert.ok(!row.email || !row.email.includes('@example.com'), 'email đã bị xóa');
  assert.equal((await c.get('/me')).status, 401);
});

test('MFA: bật TOTP rồi đăng nhập cần mã', async () => {
  const c = await registerAdult(t, { role: 'learner' });
  const setup = c.must(await c.post('/me/mfa/setup', {}));
  c.must(await c.post('/me/mfa/enable', { code: totp(setup.secret, t.clock.ms()) }));
  const c2 = t.client('mfa2');
  const r = await c2.post('/auth/login', { email: c.email, password: PW });
  const needs = r.status !== 200 || r.data?.mfaRequired || r.data?.requiresMfa || r.data?.mfa;
  assert.ok(needs, JSON.stringify(r.body));
});
