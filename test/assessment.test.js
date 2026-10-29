import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, registerAdult, makeAdmin, makeApprovedTeacher, makeClass, uuid } from './helpers.js';

let t, admin, teacher, klass;
before(async () => {
  t = await createTestApp();
  admin = await makeAdmin(t);
  teacher = await makeApprovedTeacher(t, admin);
  klass = await makeClass(t, teacher, [{ displayName: 'An', birthYm: '2015-04' }, { displayName: 'Bình', birthYm: '2014-02' }]);
});
after(async () => { await t.close(); });

async function publishMcq(i) {
  const q = teacher.must(await teacher.post('/teacher/questions', { type: 'mcq_single', body: { stem: `Câu ${i}: chọn đúng`, options: [`a${i}`, `b${i}`, `c${i}`, `d${i}`] }, answerKey: { correctIndex: 1 }, cefr: 'A1', topic: 'x' }), 201);
  for (const to of ['in_review', 'approved', 'published']) teacher.must(await teacher.post(`/teacher/question-versions/${q.id}/transition`, { to }));
  return q;
}

test('nháp câu hỏi mơ hồ bị từ chối', async () => {
  const r = await teacher.post('/teacher/questions', { type: 'mcq_single', body: { stem: 's', options: ['a', 'A'] }, answerKey: { correctIndex: 0 } });
  assert.equal(r.status, 400);
});

test('luồng thi đầy đủ + không rò đáp án + chấm thuần + phiên bản bất biến', async () => {
  const qs = []; for (let i = 0; i < 6; i++) qs.push(await publishMcq(i));
  const bp = { total: 5, durationMin: 20, types: { mcq_single: 5, fill_blank: 0, matching: 0 }, seed: 12345 };
  const asm = teacher.must(await teacher.post(`/teacher/classes/${klass.cls.id}/assessments`, { title: 'KT 1', blueprint: bp, maxAttempts: 2 }), 201);
  assert.equal(asm.itemCount, 5);
  // cùng seed + cùng ngân hàng → cùng đề (DI-017)
  const again = teacher.must(await teacher.post('/teacher/exams/compose', { blueprint: bp }), 201);
  const asmComp = teacher.must(await teacher.get(`/teacher/assessments/${asm.id}/results`));
  assert.equal(again.seed, 12345); assert.equal(again.bankSnapshotHash, asm.bankSnapshotHash);

  const s = klass.students[0];
  const att = s.must(await s.post(`/assessments/${asm.id}/attempts`, {}), 201);
  assert.ok(!JSON.stringify(att).includes('correctIndex'), 'đáp án không được rò trong lúc làm bài');
  for (let p = 0; p < 5; p++) s.must(await s.put(`/attempts/${att.id}/answers/${p}`, { answer: 0 }));
  const done = s.must(await s.post(`/attempts/${att.id}/submit`, {}));
  assert.equal(done.state, 'GRADED');
  // nộp lần hai: idempotent, không chấm lại
  const done2 = s.must(await s.post(`/attempts/${att.id}/submit`, {}));
  assert.equal(done2.state, 'GRADED');
  // bạn cùng lớp không đọc được bài làm của người khác (404)
  assert.equal((await klass.students[1].get(`/attempts/${att.id}`)).status, 404);
  // sau khi nộp: không sửa đáp án
  assert.ok((await s.put(`/attempts/${att.id}/answers/0`, { answer: 1 })).status >= 400);
  // phiên bản câu hỏi đã publish là bất biến (trigger DB)
  assert.throws(() => t.db.run("UPDATE question_versions SET body='{}' WHERE id=?", qs[0].id));
  const an = teacher.must(await teacher.get(`/teacher/assessments/${asm.id}/analysis`));
  assert.ok(an);
});

test('hết giờ: lazy expiry theo FakeClock', async () => {
  const bp = { total: 3, durationMin: 5, types: { mcq_single: 3, fill_blank: 0, matching: 0 } };
  const asm = teacher.must(await teacher.post(`/teacher/classes/${klass.cls.id}/assessments`, { title: 'KT 2', blueprint: bp }), 201);
  const s = klass.students[1];
  const att = s.must(await s.post(`/assessments/${asm.id}/attempts`, {}), 201);
  s.must(await s.put(`/attempts/${att.id}/answers/0`, { answer: 1 }));
  t.clock.advance(5 * 60000 + 60000);
  const r = await s.put(`/attempts/${att.id}/answers/1`, { answer: 1 });
  assert.ok(r.status >= 400);
  const fin = s.must(await s.post(`/attempts/${att.id}/submit`, {}));
  assert.ok(['EXPIRED', 'GRADED'].includes(fin.state));
});

test('thiếu câu hỏi → lỗi rõ ràng, không đề thiếu', async () => {
  const r = await teacher.post('/teacher/exams/compose', { blueprint: { total: 50, durationMin: 20, types: { mcq_single: 50, fill_blank: 0, matching: 0 } } });
  assert.ok(r.status >= 400 && r.status < 500); assert.ok(r.error);
});

test('học viên không tạo/duyệt câu hỏi và không giao bài', async () => {
  const s = klass.students[0];
  assert.equal((await s.post('/teacher/questions', { type: 'mcq_single', body: { stem: 's', options: ['a', 'b'] }, answerKey: { correctIndex: 0 } })).status, 403);
  assert.ok([403, 404].includes((await s.post(`/teacher/classes/${klass.cls.id}/assessments`, { title: 'x', blueprint: { total: 1, durationMin: 1, types: {} } })).status));
});

test('giáo viên khác không truy cập lớp (IDOR → 404)', async () => {
  const t2 = await makeApprovedTeacher(t, admin);
  assert.equal((await t2.get(`/teacher/classes/${klass.cls.id}`)).status, 404);
});
