import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, registerAdult, PW } from './helpers.js';

let t;
before(async () => { t = await createTestApp({ env: { AI_PROVIDER: 'fake', AI_GATEWAY: 'true' }, extra: { aiSleep: async () => {} } }); });
after(async () => { await t.close(); });

const QS = [
  { stem: 'Capital of France?', options: ['Paris', 'Rome', 'Madrid'], correctIndex: 0 },
  { stem: '2 + 2 = ?', options: ['3', '4', '5', '6'], correctIndex: 1, explanationEn: 'Basic sum.' },
];

test('học sinh người lớn: tự soạn → bài luyện tập làm được và chấm đúng', async () => {
  const l = await registerAdult(t, { role: 'learner' });
  assert.equal((await l.post('/me/practice/custom', { title: 'Tự soạn', questions: [{ stem: 'x', options: ['a'], correctIndex: 0 }] })).status, 400);
  assert.equal((await l.post('/me/practice/custom', { title: 'Tự soạn', questions: [{ stem: 'Hello?', options: ['a', 'b'], correctIndex: 5 }] })).status, 400);
  const r = l.must(await l.post('/me/practice/custom', { title: 'Tự soạn', questions: QS }), 201);
  assert.equal(r.items, 2); assert.equal(r.official, false);
  const list = l.must(await l.get('/me/assessments')).assessments;
  assert.ok(list.some((a) => a.id === r.assessmentId));
  const att = l.must(await l.post(`/assessments/${r.assessmentId}/attempts`, {}), 201);
  const view = l.must(await l.get(`/attempts/${att.id}`));
  for (let p = 0; p < 2; p++) {
    const it = (view.items || view.questions || [])[p];
    const correct = it.stem.startsWith('Capital') ? 0 : 1;
    l.must(await l.put(`/attempts/${att.id}/answers/${p}`, { answer: correct }));
  }
  const done = l.must(await l.post(`/attempts/${att.id}/submit`, {}));
  assert.equal(done.score, done.maxScore ?? done.max_score);
});

test('AI luyện tập: tắt mặc định → bật bởi chủ tổ chức → sinh bản xem trước (không lưu) → tạo bài', async () => {
  const l = await registerAdult(t, { role: 'learner' });
  const st = l.must(await l.get('/me/ai/status')); assert.equal(st.flag, true); assert.equal(st.enabled, false); assert.equal(st.canManage, true);
  assert.equal((await l.post('/me/ai/practice-questions', { request: 'present perfect' })).status, 403);
  l.must(await l.post('/auth/step-up', { password: PW }));
  l.must(await l.put('/admin/ai/settings', { enabled: true }));
  const before = t.db.get('SELECT COUNT(*) n FROM question_versions').n;
  const g = l.must(await l.post('/me/ai/practice-questions', { request: 'present perfect, since vs for', count: 3 }));
  assert.equal(g.questions.length, 3); assert.equal(t.db.get('SELECT COUNT(*) n FROM question_versions').n, before);   // chưa lưu gì
  const r = l.must(await l.post('/me/practice/custom', { title: 'AI', questions: g.questions.map(({ stem, options, correctIndex, explanationEn }) => ({ stem, options, correctIndex, explanationEn })), fromAi: true }), 201);
  assert.equal(r.items, 3);
  const row = t.db.get("SELECT source,status,approved_by FROM question_versions ORDER BY created_at DESC LIMIT 1");
  assert.equal(row.source, 'ai'); assert.equal(row.status, 'published'); assert.equal(row.approved_by, l.id);
});

test('phụ huynh: soạn tay + AI cho con (cả con <13), con làm được; người khác không soạn được', async () => {
  const g = await registerAdult(t, { role: 'guardian', orgName: 'Nhà A' });
  const c = g.must(await g.post('/guardian/children', { displayName: 'Bé', birthYm: '2017-01', username: 'be.ai' }), 201);
  const other = await registerAdult(t, { role: 'guardian', orgName: 'Nhà B' });
  assert.equal((await other.post(`/guardian/children/${c.id}/practice/custom`, { title: 'x', questions: QS })).status, 404);
  const r = g.must(await g.post(`/guardian/children/${c.id}/practice/custom`, { title: 'Bài của mẹ', questions: QS }), 201);
  const kid = t.client('kid'); kid.must(await kid.post('/auth/login', { username: 'be.ai', pin: c.pin, familyCode: c.familyCode }).then((x) => (x.status === 200 ? x : kid.post('/auth/login-class', { classCode: c.familyCode, username: 'be.ai', pin: c.pin }))));
  const mine = kid.must(await kid.get('/me/assessments')).assessments;
  assert.ok(mine.some((a) => a.id === r.assessmentId), 'con thấy bài do phụ huynh soạn');
  kid.must(await kid.post(`/assessments/${r.assessmentId}/attempts`, {}), 201);
  // AI: phụ huynh (người lớn, chủ tổ chức gia đình) bật AI và ra đề cho con <13; con <13 tự gọi AI thì bị chặn
  g.must(await g.post('/auth/step-up', { password: PW })); g.must(await g.put('/admin/ai/settings', { enabled: true }));
  const q = g.must(await g.post('/me/ai/practice-questions', { request: 'animals vocabulary for kids', count: 2 }));
  assert.equal(q.questions.length, 2);
  const r2 = g.must(await g.post(`/guardian/children/${c.id}/practice/custom`, { title: 'AI cho con', questions: q.questions.map(({ stem, options, correctIndex, explanationEn }) => ({ stem, options, correctIndex, explanationEn })), fromAi: true }), 201);
  assert.equal(r2.items, 2);
  assert.equal((await kid.post('/me/ai/practice-questions', { request: 'animals vocabulary' })).status, 403);
  const aud = t.db.get("SELECT diff FROM audit_logs WHERE action='practice.custom_create' ORDER BY seq DESC LIMIT 1");
  assert.match(aud.diff, /"forOther":true/);
});
