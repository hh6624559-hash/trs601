import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, registerAdult, makeAdmin, makeApprovedTeacher, makeClass, PW } from './helpers.js';

let t, admin, teacher, klass;
before(async () => {
  t = await createTestApp();
  admin = await makeAdmin(t);
  teacher = await makeApprovedTeacher(t, admin);
  klass = await makeClass(t, teacher, [{ displayName: 'Nhỏ', birthYm: '2018-04' }, { displayName: 'Teen1', birthYm: '2010-02' }, { displayName: 'Teen2', birthYm: '2009-09' }]);
});
after(async () => { await t.close(); });

const [kid, teen1, teen2] = [0, 1, 2];
const code = async (c) => c.must(await c.get('/social/profile')).friendCode;

test('người lạ (người lớn ngoài tổ chức) không kết bạn được với trẻ vị thành niên', async () => {
  const stranger = await registerAdult(t, { role: 'learner' });
  const r = await stranger.post('/social/friend-requests', { code: await code(klass.students[teen1]) });
  assert.ok(r.status >= 400, `status ${r.status}`);
});

test('<13 không kết bạn / không nhắn tự do', async () => {
  const k = klass.students[kid];
  const r = await k.post('/social/friend-requests', { code: await code(klass.students[teen1]) });
  assert.ok(r.status >= 400);
  const ch = k.must(await k.get('/social/channels'));
  const cls = ch.channels.find((x) => x.kind === 'class');
  if (cls) {
    const free = await k.post(`/social/channels/${cls.id}/messages`, { text: 'xin chào' });
    assert.ok(free.status >= 400, 'trẻ <13 chỉ được dùng tin nhắn soạn sẵn');
    const p = ch.presets[0];
    const ok = await k.post(`/social/channels/${cls.id}/messages`, { presetKey: p.key });
    assert.ok([200, 201, 403].includes(ok.status));
  }
});

test('teen kết bạn cùng tổ chức, chặn hai chiều, báo cáo', async () => {
  const a = klass.students[teen1], b = klass.students[teen2];
  for (const st of [a, b]) {
    const inv = teacher.must(await teacher.post(`/teacher/classes/${klass.cls.id}/students/${st.id}/guardian-invite`, {}));
    const g = await registerAdult(t, { role: 'guardian' });
    g.must(await g.post('/guardian/link', { code: inv.code }));
    g.must(await g.post('/auth/switch-tenant', { tenantId: teacher.tenantId }));
    g.must(await g.post(`/guardian/children/${st.id}/consents/grant`, { purpose: 'social' }));
  }
  const req = await a.post('/social/friend-requests', { code: await code(b) });
  if (req.status >= 400) { console.log('friend req →', req.status, JSON.stringify(req.body)); }
  assert.ok(req.status < 300, 'teen cùng tổ chức phải gửi được lời mời (có thể cần đồng ý giám hộ)');
  const acc = await b.post(`/social/friend-requests/${a.id}/respond`, { accept: true });
  assert.ok(acc.status < 300, JSON.stringify(acc.body));
  const ch = b.must(await b.get('/social/channels'));
  const dm = ch.channels.find((x) => x.kind === 'dm');
  assert.ok(dm, 'có kênh DM sau khi kết bạn');
  b.must(await b.post('/social/blocks', { userId: a.id }));
  // bị chặn: DM biến mất ở cả hai phía
  assert.ok(!(a.must(await a.get('/social/channels'))).channels.some((x) => x.kind === 'dm'));
  assert.ok(!(b.must(await b.get('/social/channels'))).channels.some((x) => x.kind === 'dm'));
  const send = await a.post(`/social/channels/${dm.id}/messages`, { presetKey: ch.presets[0].key });
  assert.ok(send.status >= 400);
});

test('tin nhắn chứa liên hệ bị chặn/đánh dấu cho trẻ vị thành niên', async () => {
  const a = klass.students[teen1];
  const ch = a.must(await a.get('/social/channels'));
  const cls = ch.channels.find((x) => x.kind === 'class');
  if (!cls) return;
  const r = await a.post(`/social/channels/${cls.id}/messages`, { text: 'gọi tôi 0912345678 nhé' });
  assert.ok(r.status >= 400 || r.data?.flagged || r.data?.status === 'held', JSON.stringify(r.body));
});

test('guardian: không thấy được con của người khác (IDOR)', async () => {
  const g1 = await registerAdult(t, { role: 'guardian', orgName: 'Nhà A' });
  const g2 = await registerAdult(t, { role: 'guardian', orgName: 'Nhà B' });
  const c = g1.must(await g1.post('/guardian/children', { displayName: 'Bé', birthYm: '2017-01', username: 'be.a' }), 201);
  assert.ok(c.pin);
  assert.equal((await g2.get(`/guardian/children/${c.id}/summary`)).status, 404);
  g1.must(await g1.get(`/guardian/children/${c.id}/summary`));
});
