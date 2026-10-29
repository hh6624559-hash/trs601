import { createTestApp, registerAdult, makeAdmin, makeApprovedTeacher, makeClass, PW } from '../test/helpers.js';
import { writeFileSync } from 'node:fs';
const t = await createTestApp({ start: new Date().toISOString() });
const admin = await makeAdmin(t);
const teacher = await makeApprovedTeacher(t, admin, { email: 'gv@example.com', name: 'Cô Mai' });
const k = await makeClass(t, teacher, [{ displayName: 'An', birthYm: '2015-04' }, { displayName: 'Bình', birthYm: '2010-02' }]);
for (let i = 0; i < 6; i++) { const q = teacher.must(await teacher.post('/teacher/questions', { type: 'mcq_single', body: { stem: `Câu ${i + 1}`, options: ['a', 'b', 'c'] }, answerKey: { correctIndex: 1 } }), 201); for (const to of ['in_review', 'approved', 'published']) teacher.must(await teacher.post(`/teacher/question-versions/${q.id}/transition`, { to })); }
teacher.must(await teacher.post(`/teacher/classes/${k.cls.id}/assessments`, { title: 'Kiểm tra 15 phút', blueprint: { total: 5, durationMin: 15, types: { mcq_single: 5, fill_blank: 0, matching: 0 } } }), 201);
const g = await registerAdult(t, { role: 'guardian', orgName: 'Nhà Lan', email: 'ph@example.com' });
g.must(await g.post('/guardian/children', { displayName: 'Bé Na', birthYm: '2017-01', username: 'bena', pin: '123456' }), 201);
writeFileSync(process.argv[2], JSON.stringify({ base: t.base, adminEmail: admin.email, adminSecret: admin.totpSecret, classCode: k.classCode, cred: k.credentials[0], creds: k.credentials }));
console.log('ready', t.base);
setInterval(() => t.clock.advance(1000), 1000); // đồng hồ giả chạy theo thời gian thực để các hạn giờ (đấu trường) hoạt động
