import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, registerAdult, makeAdmin, makeApprovedTeacher, makeClass } from './helpers.js';

let t, admin, teacher, klass, P;
before(async () => {
  t = await createTestApp({ env: { MEDIA_PROVIDER: 'fake' } });
  admin = await makeAdmin(t);
  teacher = await makeApprovedTeacher(t, admin);
  P = []; for (let i = 0; i < 5; i++) P.push(await registerAdult(t, { role: 'learner' }));   // dùng lại: đăng ký bị giới hạn theo IP
  klass = await makeClass(t, teacher, [{ displayName: 'Nhỏ', birthYm: '2018-04' }, { displayName: 'Teen', birthYm: '2010-02' }]);
});
after(async () => { await t.close(); });
const mk = async (c, body) => c.must(await c.post('/rooms', body), 201);

test('phòng lớp: HS <13 vào thẳng (không phòng chờ), cam/mic mặc định tắt, giáo viên bật từng em, join hai lần = một bản ghi, có token', async () => {
  const room = await mk(teacher, { kind: 'class', title: 'Học buổi sáng', classId: klass.cls.id });
  const [kid, teen] = klass.students;
  const j = kid.must(await kid.post(`/rooms/${room.id}/join`, {}));
  assert.equal(j.status, 'ADMITTED'); assert.ok(j.session.token); assert.equal(j.you.camAllowed, false); assert.equal(j.you.micAllowed, false);
  kid.must(await kid.post(`/rooms/${room.id}/join`, {}));
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM room_members WHERE room_id=? AND user_id=?', room.id, kid.id).n, 1);
  teen.must(await teen.post(`/rooms/${room.id}/join`, {}));
  assert.equal(teacher.must(await teacher.post(`/rooms/${room.id}/media`, { userId: kid.id, cam: true, mic: true })).members.find((m) => m.userId === kid.id).camAllowed, true);
  assert.equal(kid.must(await kid.get(`/rooms/${room.id}`)).you.camAllowed, true);
  assert.equal((await kid.post(`/rooms/${room.id}/media`, { userId: kid.id, cam: true, mic: true })).status, 403, 'HS không tự bật quyền');
  const v = teacher.must(await teacher.get(`/rooms/${room.id}`));
  assert.equal(v.state, 'LIVE'); assert.equal(v.hasMinors, true);
  const tok = kid.must(await kid.post(`/rooms/${room.id}/token`, {}));
  assert.ok(tok.token && tok.expiresAt);
});

test('phòng có người <18 chỉ LIVE khi người lớn có thẩm quyền hiện diện; chat chỉ câu soạn sẵn', async () => {
  const room = await mk(teacher, { kind: 'class', title: 'Giờ tự học', classId: klass.cls.id });
  t.clock.advance(60000);                                  // giáo viên không còn hiện diện
  const kid = klass.students[0];
  kid.must(await kid.post(`/rooms/${room.id}/join`, {}));
  assert.equal(kid.must(await kid.get(`/rooms/${room.id}`)).state, 'WAITING');
  assert.equal(teacher.must(await teacher.get(`/rooms/${room.id}`)).state, 'LIVE');
  assert.equal((await kid.post(`/rooms/${room.id}/chat`, { text: 'xin chào' })).status, 403);
  kid.must(await kid.post(`/rooms/${room.id}/chat`, { presetKey: 'hello' }));
  const v = teacher.must(await teacher.get(`/rooms/${room.id}`));
  assert.ok(v.events.some((e) => e.kind === 'chat'));
  kid.must(await kid.post(`/rooms/${room.id}/hand`, { up: true }));
  assert.equal(teacher.must(await teacher.get(`/rooms/${room.id}`)).members.find((m) => m.userId === kid.id).hand, true);
});

test('phòng cá nhân giữa người lớn: mã mời → phòng chờ → duyệt → token; khóa, đuổi, kết thúc', async () => {
  const [a, b, c] = P;
  const room = await mk(a, { kind: 'personal', title: 'Học đôi' });
  assert.ok(room.inviteCode && !JSON.stringify(t.db.all('SELECT * FROM room_invites WHERE room_id=?', room.id)).includes(room.inviteCode), 'chỉ lưu băm');
  const w = b.must(await b.post('/rooms/join', { code: room.inviteCode }));
  assert.equal(w.status, 'WAITING_FOR_HOST'); assert.equal(w.members, undefined, 'người chờ chưa thấy ai');
  assert.equal((await b.post(`/rooms/${room.id}/signal`, { to: a.me.user.id, kind: 'offer', data: {}, token: 'x' })).status, 404, 'chưa được duyệt → không signal');
  const hv = a.must(await a.get(`/rooms/${room.id}`));
  assert.ok(hv.members.some((m) => m.state === 'waiting'));
  const bid = hv.members.find((m) => m.state === 'waiting').userId;
  assert.equal((await b.post(`/rooms/${room.id}/admit`, { userId: bid })).status, 404, 'không phải chủ phòng');
  a.must(await a.post(`/rooms/${room.id}/admit`, { userId: bid }));
  const ok = b.must(await b.post('/rooms/join', { code: room.inviteCode }));
  assert.equal(ok.status, 'ADMITTED'); assert.ok(ok.session.token);
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM room_members WHERE room_id=? AND user_id=?', room.id, bid).n, 1);
  // tín hiệu: token hợp lệ chuyển tới đúng người nhận; token của người khác bị từ chối
  const aid = a.me.user.id;
  b.must(await b.post(`/rooms/${room.id}/signal`, { to: aid, kind: 'offer', data: { sdp: 'x' }, token: ok.session.token }));
  const av = a.must(await a.get(`/rooms/${room.id}`));
  assert.ok(av.events.some((e) => e.kind === 'signal' && e.payload.kind === 'offer'));
  assert.ok(!b.must(await b.get(`/rooms/${room.id}`)).events.some((e) => e.kind === 'signal'), 'người khác không thấy tín hiệu');
  assert.equal((await a.post(`/rooms/${room.id}/signal`, { to: bid, kind: 'answer', data: {}, token: ok.session.token })).status, 401);
  // mute-all / khóa / đuổi
  a.must(await a.post(`/rooms/${room.id}/mute-all`, {}));
  assert.equal(b.must(await b.get(`/rooms/${room.id}`)).you.micAllowed, false);
  a.must(await a.post(`/rooms/${room.id}/lock`, { locked: true }));
  const inv2 = a.must(await a.post(`/rooms/${room.id}/invites`, { maxUses: 5 }));
  assert.equal((await c.post('/rooms/join', { code: inv2.code })).status, 403, 'phòng khóa');
  a.must(await a.post(`/rooms/${room.id}/lock`, { locked: false }));
  a.must(await a.post(`/rooms/${room.id}/kick`, { userId: bid }));
  assert.equal((await b.post('/rooms/join', { code: inv2.code })).status, 403, 'đã bị đuổi thì không vào lại');
  a.must(await a.post(`/rooms/${room.id}/end`, {}));
  assert.equal((await c.post('/rooms/join', { code: inv2.code })).status, 409, 'phòng đã kết thúc không cấp token mới (DI-024)');
  assert.equal(t.db.get('SELECT state FROM rooms WHERE id=?', room.id).state, 'ENDED');
});

test('liên kết mời: hết hạn / hết lượt / thu hồi đều không vào được, không lộ lý do', async () => {
  const a = P[0];
  const room = await mk(a, { kind: 'group', title: 'Nhóm ôn thi', waitingRoom: false });
  const i1 = a.must(await a.post(`/rooms/${room.id}/invites`, { maxUses: 1 })), i2 = a.must(await a.post(`/rooms/${room.id}/invites`, {})), i3 = a.must(await a.post(`/rooms/${room.id}/invites`, { expiresMin: 5 }));
  const [u1, u2, u3] = [P[1], P[2], P[3]];
  assert.equal(u1.must(await u1.post('/rooms/join', { code: i1.code })).status, 'ADMITTED');
  assert.equal((await u2.post('/rooms/join', { code: i1.code })).status, 404, 'hết lượt');
  a.must(await a.post(`/rooms/${room.id}/invites/revoke`, { inviteId: i2.inviteId }));
  assert.equal((await u2.post('/rooms/join', { code: i2.code })).status, 404, 'thu hồi');
  t.clock.advance(6 * 60000);
  assert.equal((await u3.post('/rooms/join', { code: i3.code })).status, 404, 'hết hạn');
  assert.equal((await u3.post('/rooms/join', { code: 'KHONGCO1' })).status, 404);
});

test('luật tuổi: <13 không tạo; teen không tạo phòng ngang hàng khi cờ tắt; người lớn lạ không vào phòng lớp; HS lớp khác không vào', async () => {
  const [kid, teen] = klass.students;
  assert.equal((await kid.post('/rooms', { kind: 'personal', title: 'x' })).status, 403);
  assert.equal((await teen.post('/rooms', { kind: 'personal', title: 'x' })).status, 403);
  assert.equal((await teen.post('/rooms', { kind: 'class', title: 'x', classId: klass.cls.id })).status, 403);
  const room = await mk(teacher, { kind: 'class', title: 'Lớp kín', classId: klass.cls.id });
  const stranger = P[4];
  assert.equal((await stranger.post(`/rooms/${room.id}/join`, {})).status, 404);
  const t2 = await makeApprovedTeacher(t, admin, { email: 'gv3@example.com', name: 'Cô Hoa' });
  const k2 = await makeClass(t, t2, [{ displayName: 'Khác', birthYm: '2016-01' }], 'Lớp 3C');
  assert.ok((await k2.students[0].post(`/rooms/${room.id}/join`, {})).status >= 400);
  t.db.run("UPDATE feature_flags SET enabled=1 WHERE key='rooms.peer_minors'");
  assert.equal((await teen.post('/rooms', { kind: 'personal', title: 'x' })).status, 403, 'teen cần consent social của giám hộ');
  t.db.run("UPDATE feature_flags SET enabled=0 WHERE key='rooms.peer_minors'");
});

test('provider media sập: join báo 503 kèm liên kết dự phòng; thử lại không tạo bản ghi thứ hai; webhook trùng bị bỏ', async () => {
  const [a, b] = [P[0], P[1]];
  const room = await mk(a, { kind: 'personal', title: 'Dự phòng', waitingRoom: false, fallbackUrl: 'https://meet.example.org/abc' });
  assert.equal((await a.post('/rooms', { kind: 'personal', title: 'bad', fallbackUrl: 'http://x.example' })).status, 400, 'chỉ https');
  t.media.failNext = 1;
  const f = await b.post('/rooms/join', { code: room.inviteCode });
  assert.equal(f.status, 503); assert.equal(f.body.error.details[0].fallbackUrl, 'https://meet.example.org/abc');
  assert.equal(b.must(await b.post('/rooms/join', { code: room.inviteCode })).status, 'ADMITTED');
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM room_members WHERE room_id=? AND user_id=?', room.id, b.me.user.id).n, 1);
  const prov = t.db.get('SELECT provider_room FROM rooms WHERE id=?', room.id).provider_room;
  const hook = { eventId: 'ev1', type: 'participant_joined', roomName: prov, userId: b.me.user.id };
  const send = (h) => fetch(`${t.base}/api/v1/webhooks/media`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(hook) });
  assert.equal((await send({ 'x-signature': 'sai' })).status, 401);
  assert.equal((await (await send({ 'x-signature': 'fake-valid' })).json()).data.processed, true);
  assert.equal((await (await send({ 'x-signature': 'fake-valid' })).json()).data.duplicate, true);
  assert.equal(t.db.get("SELECT COUNT(*) AS n FROM room_events WHERE room_id=? AND kind='attendance'", room.id).n, 1);
});

test('đóng tab giữa chừng: không còn «LIVE ma» sau khi job dọn chạy', async () => {
  const a = P[0];
  const room = await mk(a, { kind: 'personal', title: 'Ma' });
  a.must(await a.get(`/rooms/${room.id}`));
  assert.equal(t.db.get('SELECT state FROM rooms WHERE id=?', room.id).state, 'LIVE');
  t.clock.advance(3 * 60000);
  t.jobs.run('roomSweep');
  assert.equal(t.db.get('SELECT state FROM rooms WHERE id=?', room.id).state, 'ENDED');
  assert.throws(() => t.db.run("UPDATE rooms SET state='LIVE' WHERE id=?", room.id), /INVALID_STATE_TRANSITION/);
});

test('báo cáo trong phòng tạo bằng chứng và chuyển hàng đợi kiểm duyệt', async () => {
  const room = await mk(teacher, { kind: 'class', title: 'Báo cáo', classId: klass.cls.id });
  const kid = klass.students[0];
  kid.must(await kid.post(`/rooms/${room.id}/join`, {}));
  const rep = kid.must(await kid.post(`/rooms/${room.id}/report`, { reason: 'unsafe_contact', note: 'khó chịu' }));
  const row = t.db.get('SELECT * FROM reports WHERE id=?', rep.reportId);
  assert.equal(row.state, 'ESCALATED'); assert.ok(JSON.parse(row.evidence).members.length >= 2);
});

test('tải: phòng lớp đủ 30 người vào cùng lúc (media giả) — đúng một bản ghi mỗi người, vượt sức chứa bị từ chối, giáo viên vẫn vào', async () => {
  const big = await makeClass(t, teacher, Array.from({ length: 31 }, (_, i) => ({ displayName: `HS${i}`, birthYm: '2016-05' })), 'Lớp 30+');
  const room = await mk(teacher, { kind: 'class', title: 'Giảng đường', classId: big.cls.id, maxPeople: 30 });
  assert.equal(room.maxPeople, 30);
  assert.equal((await teacher.post('/rooms', { kind: 'class', title: 'x', classId: big.cls.id, maxPeople: 31 })).status, 400);
  const first = big.students.slice(0, 29);                 // 29 HS + giáo viên = 30 người (sức chứa tính cả chủ phòng)
  const res = await Promise.all(first.map((c) => c.post(`/rooms/${room.id}/join`, {})));
  assert.ok(res.every((r) => r.status === 200 && r.body.data.status === 'ADMITTED'), JSON.stringify(res.map((r) => r.status)));
  await Promise.all(first.map((c) => c.post(`/rooms/${room.id}/join`, {})));
  assert.equal(t.db.get("SELECT COUNT(*) AS n FROM room_members WHERE room_id=? AND state='admitted'", room.id).n, 30);   // 29 HS + giáo viên
  const extra = await big.students[29].post(`/rooms/${room.id}/join`, {});
  assert.equal(extra.status, 422, 'phòng đầy');
  const v = teacher.must(await teacher.get(`/rooms/${room.id}`));
  assert.equal(v.members.length, 30); assert.equal(v.state, 'LIVE');
  assert.ok(first.every((c) => t.media.calls.some((x) => x.n === 'issueToken' && x.a.userId === c.id)));
});

test('cấu hình mặc định: phòng 20 người, tối đa 30', async () => {
  const a = P[0];
  const room = await mk(a, { kind: 'personal', title: 'Mặc định' });
  assert.equal(room.maxPeople, 20);
});
