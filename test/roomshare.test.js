import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeAdmin, makeApprovedTeacher, makeClass } from './helpers.js';

let t, teacher, klass;
before(async () => {
  t = await createTestApp({ env: { MEDIA_PROVIDER: 'fake' } });
  const admin = await makeAdmin(t);
  teacher = await makeApprovedTeacher(t, admin);
  klass = await makeClass(t, teacher, [{ displayName: 'Nhỏ', birthYm: '2018-04' }, { displayName: 'Teen', birthYm: '2010-02' }]);
});
after(async () => { await t.close(); });
const stroke = (page = 0, extra = {}) => ({ page, tool: 'pen', color: '#d62828', width: 6, pts: [0.1, 0.1, 0.5, 0.5], ...extra });

test('bảng trắng: mở bảng → giáo viên vẽ → HS chỉ xem → cấp quyền → HS vẽ; undo/clear/trang; người đến sau tải được nét', async () => {
  const room = teacher.must(await teacher.post('/rooms', { kind: 'class', title: 'Bảng', classId: klass.cls.id }), 201);
  const [kid, teen] = klass.students;
  kid.must(await kid.post(`/rooms/${room.id}/join`, {}));
  assert.ok((await teacher.post(`/rooms/${room.id}/board/stroke`, stroke())).status >= 400, 'bảng chưa mở');
  assert.ok((await kid.post(`/rooms/${room.id}/board/open`, { on: true })).status >= 400, 'HS không mở được bảng');
  teacher.must(await teacher.post(`/rooms/${room.id}/board/open`, { on: true }));
  const s1 = teacher.must(await teacher.post(`/rooms/${room.id}/board/stroke`, stroke()));
  assert.equal(s1.n, 1);
  assert.equal((await kid.post(`/rooms/${room.id}/board/stroke`, stroke())).status, 403, 'HS chưa được cấp quyền');
  teacher.must(await teacher.post(`/rooms/${room.id}/board/grant`, { userId: kid.id, allowed: true }));
  const s2 = kid.must(await kid.post(`/rooms/${room.id}/board/stroke`, stroke(0, { tool: 'highlighter' })));
  assert.equal(s2.n, 2);
  assert.ok((await kid.post(`/rooms/${room.id}/board/stroke`, stroke(0, { pts: [0.1, 2, 0.3, 0.3] }))).status >= 400, 'toạ độ ngoài 0–1');
  assert.ok((await kid.post(`/rooms/${room.id}/board/stroke`, stroke(0, { pts: [0.1, 0.2, 0.3] }))).status >= 400, 'số toạ độ lẻ');
  assert.ok((await kid.post(`/rooms/${room.id}/board/stroke`, stroke(0, { color: 'red' }))).status >= 400);
  // HS hoàn tác chỉ nét của mình
  assert.equal(kid.must(await kid.post(`/rooms/${room.id}/board/undo`, { page: 0 })).undone, true);
  assert.equal(kid.must(await kid.post(`/rooms/${room.id}/board/undo`, { page: 0 })).undone, false);
  // người vào sau: tải toàn bộ bảng
  teen.must(await teen.post(`/rooms/${room.id}/join`, {}));
  const b = teen.must(await teen.get(`/rooms/${room.id}/board`));
  assert.equal(b.strokes.length, 1); assert.equal(b.strokes[0].c, '#d62828'); assert.equal(b.boardOn, true);
  // trang + xóa
  teacher.must(await teacher.post(`/rooms/${room.id}/board/page`, { page: 2 }));
  assert.equal(teen.must(await teen.get(`/rooms/${room.id}`)).boardPage, 2);
  assert.equal(teen.must(await teen.get(`/rooms/${room.id}/board`)).strokes.length, 0);
  teacher.must(await teacher.post(`/rooms/${room.id}/board/clear`, { page: 0 }));
  assert.equal(teen.must(await teen.get(`/rooms/${room.id}/board?page=0`)).strokes.length, 0);
  const evs = teen.must(await teen.get(`/rooms/${room.id}?after=0`)).events.filter((e) => e.kind === 'board').map((e) => e.payload.op);
  assert.ok(['stroke', 'undo', 'page', 'clear', 'open', 'grant'].every((o) => evs.includes(o)));
});

test('chia sẻ màn hình: chỉ người lớn có thẩm quyền; một người một lúc; rời phòng thì tự dừng; phòng kết thúc thì xoá trạng thái', async () => {
  const room = teacher.must(await teacher.post('/rooms', { kind: 'class', title: 'Màn hình', classId: klass.cls.id }), 201);
  const [kid] = klass.students;
  kid.must(await kid.post(`/rooms/${room.id}/join`, {}));
  assert.ok((await kid.post(`/rooms/${room.id}/screen`, { on: true, streamId: 'abcd-1234' })).status >= 400, 'HS không chia sẻ');
  assert.ok((await teacher.post(`/rooms/${room.id}/screen`, { on: true })).status >= 400, 'thiếu streamId');
  const v = teacher.must(await teacher.post(`/rooms/${room.id}/screen`, { on: true, streamId: '{abc-123}' }));
  assert.equal(v.screenBy, teacher.id); assert.equal(v.screenStream, '{abc-123}');
  assert.equal(kid.must(await kid.get(`/rooms/${room.id}`)).screenBy, teacher.id);
  assert.ok(kid.must(await kid.get(`/rooms/${room.id}?after=0`)).events.some((e) => e.kind === 'screen' && e.payload.on));
  teacher.must(await teacher.post(`/rooms/${room.id}/screen`, { on: false }));
  assert.equal(kid.must(await kid.get(`/rooms/${room.id}`)).screenBy, null);
  teacher.must(await teacher.post(`/rooms/${room.id}/screen`, { on: true, streamId: 'zzzz-1' }));
  teacher.must(await teacher.post(`/rooms/${room.id}/leave`, {}));
  assert.equal(t.db.get('SELECT screen_by FROM rooms WHERE id=?', room.id).screen_by, null);
});
