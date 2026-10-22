import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, registerAdult, makeAdmin, makeApprovedTeacher, makeClass, tokenFrom, PW } from './helpers.js';

let t;
before(async () => { t = await createTestApp(); });
after(async () => { await t.close(); });

test('healthz/readyz', async () => {
  assert.equal((await fetch(t.base + '/healthz')).status, 200);
  assert.equal((await fetch(t.base + '/readyz')).status, 200);
});

test('401 envelope khi chưa đăng nhập', async () => {
  const c = t.client();
  const r = await c.get('/me');
  assert.equal(r.status, 401); assert.equal(r.body.success, false); assert.ok(r.body.requestId);
});

test('đăng ký người lớn, đăng nhập, /me, đăng xuất', async () => {
  const c = await registerAdult(t, { role: 'learner' });
  const me = c.must(await c.get('/me'));
  assert.equal(me.user.id, c.id);
  c.must(await c.post('/auth/logout', {}));
  assert.equal((await c.get('/me')).status, 401);
});

test('mật khẩu yếu bị từ chối; sai mật khẩu không lộ email tồn tại', async () => {
  const c = t.client();
  const r = await c.post('/auth/register', { role: 'learner', email: 'x1@example.com', password: 'password1', displayName: 'X', birthYm: '1990-05', acceptTerms: true });
  assert.ok(r.status >= 400 && r.status < 500);
  const a = await c.post('/auth/login', { email: 'nope@example.com', password: PW });
  const u = await registerAdult(t);
  const b = await c.post('/auth/login', { email: u.email, password: 'Wrong-Password-1' });
  assert.equal(a.status, b.status); assert.equal(a.error.code, b.error.code);
});

test('trẻ <18 không tự đăng ký', async () => {
  const c = t.client();
  const r = await c.post('/auth/register', { role: 'learner', email: 'kid@example.com', password: PW, displayName: 'K', birthYm: '2016-01', acceptTerms: true });
  assert.ok(r.status >= 400);
});

test('thiếu CSRF → 403', async () => {
  const c = await registerAdult(t);
  const r = await c.raw('POST', '/auth/logout', {}, { 'X-CSRF-Token': 'bad' });
  assert.equal(r.status, 403);
});

test('teacher + admin + lớp + học viên đăng nhập bằng PIN', async () => {
  const admin = await makeAdmin(t);
  const teacher = await makeApprovedTeacher(t, admin);
  const { students } = await makeClass(t, teacher);
  const me = students[0].must(await students[0].get('/me'));
  assert.equal(me.user.id, students[0].id);
});
