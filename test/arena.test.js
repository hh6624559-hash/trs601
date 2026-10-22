import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, registerAdult, makeAdmin, makeApprovedTeacher, makeClass } from './helpers.js';
import { score, rankPlayers, buildQuestions, isCorrect, xpFor, SCORE } from '../server/modules/arena-core.js';

let t, admin, teacher, klass;
before(async () => {
  t = await createTestApp();
  admin = await makeAdmin(t);
  teacher = await makeApprovedTeacher(t, admin);
  klass = await makeClass(t, teacher, [{ displayName: 'Nhỏ', birthYm: '2018-04' }, { displayName: 'Bé', birthYm: '2017-02' }, { displayName: 'Teen', birthYm: '2010-02' }]);
});
after(async () => { await t.close(); });

const correctFor = (mid, idx) => { const q = JSON.parse(t.db.get('SELECT question FROM arena_rounds WHERE match_id=? AND idx=?', mid, idx).question); return q.kind === 'mcq' ? { choice: q.key.correctIndex } : { text: q.key.accepted[0] }; };
const wrongFor = (mid, idx) => { const c = correctFor(mid, idx); return c.choice !== undefined ? { choice: (c.choice + 1) % 4 } : { text: 'zzz' }; };
async function classMatch(mode = 'duel', rounds = 3) {
  const m = teacher.must(await teacher.post('/arena/matches', { mode, visibility: 'class', classId: klass.cls.id, rounds, limitSec: 15 }), 201);
  return m.id;
}
async function startAll(mid, clients) {
  for (const c of clients) c.must(await c.post(`/arena/matches/${mid}/join`, {}));
  teacher.must(await teacher.post(`/arena/matches/${mid}/start`, {}));
  for (const c of clients) c.must(await c.post(`/arena/matches/${mid}/ready`, {}));
}

test('score: thuần, đơn điệu theo tốc độ, không vượt tối đa, sai = 0', () => {
  assert.equal(score(false, 0, 10000), 0);
  assert.equal(score(true, 0, 10000), SCORE.base + SCORE.speedMax);
  assert.equal(score(true, 10000, 10000), SCORE.base);
  assert.equal(score(true, 99999, 10000), SCORE.base);
  let prev = Infinity;
  for (let e = 0; e <= 10000; e += 250) { const v = score(true, e, 10000); assert.ok(v <= prev && v >= 100 && v <= 150); prev = v; }
});
test('hạng: hòa điểm → thời gian đúng nhỏ hơn thắng; vẫn hòa → chia sẻ hạng', () => {
  const r = rankPlayers([{ userId: 'a', score: 300, correctMs: 9000 }, { userId: 'b', score: 300, correctMs: 7000 }, { userId: 'c', score: 300, correctMs: 7000 }, { userId: 'd', score: 100, correctMs: 1 }]);
  assert.deepEqual(r.map((x) => x.rank), [1, 1, 3, 4].map((v, i) => (i === 0 || i === 1 ? 1 : v)).slice(0, 4).map((v, i) => [1, 1, 3, 4][i]));
  assert.equal(r.find((x) => x.userId === 'a').rank, 3);
});
test('seed tái tạo được: cùng seed + pool → cùng dãy câu; khác seed → khác', () => {
  const pool = t.db.all("SELECT s.id, l.lemma, s.ipa, s.definition_vi AS definitionVi FROM senses s JOIN lexemes l ON l.id=s.lexeme_id WHERE s.status='published' AND s.owner_tenant_id IS NULL ORDER BY s.id");
  const a = buildQuestions({ mode: 'duel', pool, seed: 'S1', n: 10 }), b = buildQuestions({ mode: 'duel', pool, seed: 'S1', n: 10 }), c = buildQuestions({ mode: 'duel', pool, seed: 'S2', n: 10 });
  assert.deepEqual(a, b); assert.notDeepEqual(a, c);
  assert.ok(a.every((q) => q.prompt.options.length === 4 && isCorrect(q, { choice: q.key.correctIndex }) && !isCorrect(q, { choice: (q.key.correctIndex + 1) % 4 })));
  assert.ok(xpFor({ correctCount: 99, rank: 1, players: 2 }) <= 30);
});

test('đấu đôi trong lớp: đủ vòng, không lộ đáp án trước reveal, điểm do server tính, XP qua outbox idempotent', async () => {
  const [a, b] = klass.students;
  const mid = await classMatch('duel', 3);
  await startAll(mid, [a, b]);
  for (let i = 0; i < 3; i++) {
    const v = a.must(await a.get(`/arena/matches/${mid}`));
    assert.equal(v.state, 'ROUND_OPEN'); assert.equal(v.roundIdx, i);
    assert.ok(!JSON.stringify(v.question).includes('correctIndex') && !('key' in v.question) && !v.reveal && !v.events.some((e) => e.type === 'round_reveal' && e.payload.idx === i), 'khóa đáp án lộ');
    const s0 = v.players.find((p) => p.userId === a.id).score;
    assert.equal(a.must(await a.post(`/arena/matches/${mid}/answer`, { round: i, ...correctFor(mid, i) })).accepted, true);
    const mid1 = b.must(await b.get(`/arena/matches/${mid}`));
    assert.ok(!mid1.reveal, 'chưa reveal'); assert.equal(mid1.players.find((p) => p.userId === a.id).score, s0, 'điểm chưa lộ trước reveal');
    b.must(await b.post(`/arena/matches/${mid}/answer`, { round: i, ...wrongFor(mid, i) }));
    const rv = a.must(await a.get(`/arena/matches/${mid}`));
    assert.equal(rv.state, 'ROUND_REVEAL'); assert.ok(rv.reveal && 'correctIndex' in rv.reveal || 'answer' in rv.reveal);
    t.clock.advance(3100);
  }
  const fin = a.must(await a.get(`/arena/matches/${mid}`));
  assert.equal(fin.state, 'FINISHED');
  const ra = fin.players.find((p) => p.userId === a.id), rb = fin.players.find((p) => p.userId === b.id);
  assert.equal(ra.rank, 1); assert.equal(rb.rank, 2); assert.ok(ra.score >= 300 && ra.score <= 450); assert.equal(rb.score, 0);
  const before = t.db.get('SELECT balance FROM economy_accounts WHERE user_id=?', a.id).balance;
  t.jobs.run('outbox'); t.jobs.run('outbox');
  const after1 = t.db.get('SELECT balance FROM economy_accounts WHERE user_id=?', a.id).balance;
  assert.ok(after1 > before && after1 - before <= 30);
  t.db.run("UPDATE outbox_events SET published_at=NULL WHERE type='arena.finished'"); t.jobs.run('outbox');
  assert.equal(t.db.get('SELECT balance FROM economy_accounts WHERE user_id=?', a.id).balance, after1, 'XP không cộng đôi');
});

test('client giả mạo điểm/thời gian bị từ chối; hai đáp án một vòng chỉ giữ một; trễ hạn bị từ chối; khán giả không trả lời được', async () => {
  const [a, b] = klass.students;
  const mid = await classMatch('duel', 3);
  await startAll(mid, [a, b]);
  const forged = await a.post(`/arena/matches/${mid}/answer`, { round: 0, ...correctFor(mid, 0), score: 9999, elapsedMs: 1 });
  assert.equal(forged.status, 400);
  a.must(await a.post(`/arena/matches/${mid}/answer`, { round: 0, ...correctFor(mid, 0) }));
  const dup = await a.post(`/arena/matches/${mid}/answer`, { round: 0, ...wrongFor(mid, 0) });
  assert.equal(dup.status, 409);
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM arena_answers WHERE match_id=? AND idx=0 AND user_id=?', mid, a.id).n, 1);
  assert.equal((await teacher.post(`/arena/matches/${mid}/answer`, { round: 0, choice: 0 })).status, 403);
  t.clock.advance(15000 + 301);                       // b không trả lời, hết hạn + ân hạn
  const late = await b.post(`/arena/matches/${mid}/answer`, { round: 0, ...correctFor(mid, 0) });
  assert.ok([409].includes(late.status), `status ${late.status}`);
  assert.throws(() => t.db.run("UPDATE arena_answers SET points=999 WHERE match_id=?", mid), /APPEND_ONLY/);
  assert.throws(() => t.db.run("UPDATE arena_matches SET state='LOBBY' WHERE id=?", mid), /INVALID_STATE_TRANSITION/);
});

test('mất kết nối: kết nối lại trong ân hạn; quá 60 giây → forfeit, đấu đôi người còn lại thắng', async () => {
  const [a, b] = klass.students;
  const mid = await classMatch('duel', 5);
  await startAll(mid, [a, b]);
  t.clock.advance(16000);
  a.must(await a.get(`/arena/matches/${mid}`));        // a còn kết nối; b im lặng
  const v1 = a.must(await a.get(`/arena/matches/${mid}`));
  assert.equal(v1.players.find((p) => p.userId === b.id).state, 'disconnected');
  const back = b.must(await b.get(`/arena/matches/${mid}`));
  assert.equal(back.players.find((p) => p.userId === b.id).state, 'joined');
  t.clock.advance(40000);
  a.must(await a.get(`/arena/matches/${mid}`));
  t.clock.advance(25000);
  a.must(await a.get(`/arena/matches/${mid}`));
  const fin = a.must(await a.get(`/arena/matches/${mid}`));
  assert.equal(fin.state, 'FINISHED');
  assert.equal(fin.players.find((p) => p.userId === a.id).rank, 1);
  assert.ok(fin.events.some((e) => e.type === 'forfeit'));
  const resume = a.must(await a.get(`/arena/matches/${mid}?after=${fin.seq - 1}`));
  assert.equal(resume.events.length, 1, 'resume bằng lastSeq chỉ trả sự kiện mới');
});

test('join hai lần không tạo bản ghi thứ hai; trận đã bắt đầu không cho vào thêm', async () => {
  const [a, b, c] = klass.students;
  const mid = await classMatch('blitz', 3);
  await Promise.all([a.post(`/arena/matches/${mid}/join`, {}), a.post(`/arena/matches/${mid}/join`, {})]);
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM arena_players WHERE match_id=? AND user_id=?', mid, a.id).n, 1);
  b.must(await b.post(`/arena/matches/${mid}/join`, {}));
  c.must(await c.post(`/arena/matches/${mid}/join`, {}));
  teacher.must(await teacher.post(`/arena/matches/${mid}/start`, {}));
  const late = await registerAdult(t, { role: 'learner' });
  assert.ok((await late.post(`/arena/matches/${mid}/join`, {})).status >= 400);
});

test('luật tuổi: <13 không tạo/không vào trận ngoài lớp; người lớn lạ không vào trận có trẻ; 13–17 không vào sảnh người lớn', async () => {
  const [kid, , teen] = klass.students;
  assert.equal((await kid.post('/arena/matches', { mode: 'duel', visibility: 'private' })).status, 403);
  assert.equal((await teen.post('/arena/matches', { mode: 'duel', visibility: 'open_adults' })).status, 403);
  const adultA = await registerAdult(t, { role: 'learner' }), adultB = await registerAdult(t, { role: 'learner' });
  const open = adultA.must(await adultA.post('/arena/matches', { mode: 'duel', visibility: 'open_adults' }), 201);
  assert.equal((await kid.post(`/arena/matches/${open.id}/join`, {})).status, 404, 'khác tổ chức → không lộ tồn tại');
  const lobby = adultB.must(await adultB.get('/arena/lobby'));
  assert.ok(Array.isArray(lobby.matches));
  const priv = adultA.must(await adultA.post('/arena/matches', { mode: 'duel', visibility: 'private' }), 201);
  assert.ok(priv.code && !JSON.stringify(t.db.all('SELECT * FROM arena_matches WHERE id=?', priv.id)).includes(priv.code), 'chỉ lưu băm mã');
  assert.equal((await adultB.post('/arena/matches/' + priv.id + '/join', {})).status >= 400, true, 'không có mã → không vào');
  assert.equal((await adultA.post('/arena/join', { code: 'WRONG1' })).status, 404);
  // trẻ chỉ dùng được trận lớp: tạo bằng giáo viên của lớp khác → không vào
  const t2 = await makeApprovedTeacher(t, admin, { email: 'gv2@example.com', name: 'Cô Lan' });
  const k2 = await makeClass(t, t2, [{ displayName: 'Khác', birthYm: '2016-01' }], 'Lớp 2B');
  const mid = await classMatch('duel', 3);
  assert.ok((await k2.students[0].post(`/arena/matches/${mid}/join`, {})).status >= 400);
  assert.ok((await adultA.post(`/arena/matches/${mid}/join`, {})).status >= 400);
});

test('30 người gửi đáp án cùng lúc: mỗi người đúng một bản ghi, điểm do server tính', async () => {
  const big = await makeClass(t, teacher, Array.from({ length: 30 }, (_, i) => ({ displayName: `HS${i}`, birthYm: '2016-05' })), 'Lớp đông');
  const m = teacher.must(await teacher.post('/arena/matches', { mode: 'blitz', visibility: 'class', classId: big.cls.id, rounds: 3, limitSec: 20 }), 201);
  for (const c of big.students) c.must(await c.post(`/arena/matches/${m.id}/join`, {}));
  teacher.must(await teacher.post(`/arena/matches/${m.id}/start`, {}));
  await Promise.all(big.students.map((c) => c.post(`/arena/matches/${m.id}/ready`, {})));
  assert.equal(t.db.get('SELECT state FROM arena_matches WHERE id=?', m.id).state, 'ROUND_OPEN');
  const res = await Promise.all(big.students.map((c) => c.post(`/arena/matches/${m.id}/answer`, { round: 0, ...correctFor(m.id, 0) })));
  assert.ok(res.every((r) => r.status === 200), JSON.stringify(res.map((r) => r.status)));
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM arena_answers WHERE match_id=? AND idx=0', m.id).n, 30);
  assert.equal(t.db.get('SELECT state FROM arena_matches WHERE id=?', m.id).state, 'ROUND_REVEAL');
  assert.ok(t.db.all('SELECT points FROM arena_answers WHERE match_id=?', m.id).every((x) => x.points >= 100 && x.points <= 150));
});

test('v29: server không khóa mic theo giai đoạn; chỉ «Phòng thi nghiêm» (mặc định tắt) báo micLocked lúc ROUND_OPEN', async () => {
  const [a, b] = klass.students;
  const plain = await classMatch('duel', 3);
  await startAll(plain, [a, b]);
  assert.equal(a.must(await a.get(`/arena/matches/${plain}`)).micLocked, false);
  const strict = teacher.must(await teacher.post('/arena/matches', { mode: 'duel', visibility: 'class', classId: klass.cls.id, rounds: 3, strictRoom: true }), 201);
  assert.equal(strict.strictRoom, true); assert.equal(strict.micLocked, false, 'chưa ROUND_OPEN');
  await startAll(strict.id, [a, b]);
  const v = a.must(await a.get(`/arena/matches/${strict.id}`));
  assert.equal(v.state, 'ROUND_OPEN'); assert.equal(v.micLocked, true);
});
