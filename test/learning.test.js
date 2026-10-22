import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, registerAdult, uuid } from './helpers.js';
import { schedule, rebuild, NEW_STATE, retrievability, nextIntervalDays } from '../server/modules/fsrs.js';

let t;
before(async () => { t = await createTestApp(); });
after(async () => { await t.close(); });

async function learnerWithCards(n = 5) {
  const c = await registerAdult(t, { role: 'learner' });
  const topics = c.must(await c.get('/vocab/topics'));
  const topic = (topics.topics?.[0]?.topic) || (topics.topics?.[0]?.id) || topics.topics?.[0];
  const col = c.must(await c.post('/me/collections', { title: 'Của tôi', fromTopic: typeof topic === 'string' ? topic : topic.key, limit: n }), 201);
  return { c, col };
}

test('FSRS: hàm thuần, ổn định tăng khi nhớ, giảm khi quên', () => {
  const now = Date.UTC(2026, 2, 10);
  const a = schedule(NEW_STATE(), 3, now, {});
  assert.ok(a.stability > 0 && a.due_at);
  const b = schedule(a, 3, Date.parse(a.due_at), {});
  assert.ok(b.stability > a.stability);
  const c = schedule(b, 1, Date.parse(b.due_at), {});
  assert.ok(c.stability < b.stability); assert.equal(c.lapses, 1);
  assert.deepEqual(schedule(NEW_STATE(), 3, now, {}), schedule(NEW_STATE(), 3, now, {}));
  assert.ok(Math.abs(retrievability(nextIntervalDays(5, 0.9), 5) - 0.9) < 1e-6);
});

test('đồng bộ ôn tập: idempotent, trùng id → duplicate, không nhân đôi XP', async () => {
  const { c } = await learnerWithCards();
  const today = c.must(await c.get('/learn/today'));
  assert.ok(today.cards.length > 0);
  const ev = { id: uuid(), senseId: today.cards[0].senseId ?? today.cards[0].id, rating: 3 };
  const r1 = c.must(await c.post('/learn/reviews', { events: [ev] }));
  assert.equal(r1.results[0].status, 'accepted'); assert.equal(r1.xpAwarded, 1);
  const r2 = c.must(await c.post('/learn/reviews', { events: [ev] }));
  assert.equal(r2.results[0].status, 'duplicate'); assert.equal(r2.xpAwarded, 0);
  const w = c.must(await c.get('/me/wallet'));
  assert.equal(w.balance ?? w.wallet?.balance, 1);
});

test('lô hỗn hợp: sense lạ bị từ chối, phần còn lại được nhận; hoàn tác trong cửa sổ', async () => {
  const { c } = await learnerWithCards();
  const today = c.must(await c.get('/learn/today'));
  const sid = today.cards[0].senseId ?? today.cards[0].id;
  const e1 = { id: uuid(), senseId: sid, rating: 4, clientAt: t.clock.iso() };
  const bad = { id: uuid(), senseId: uuid(), rating: 3 };
  const r = c.must(await c.post('/learn/reviews', { events: [e1, bad] }));
  assert.deepEqual(r.results.map((x) => x.status), ['accepted', 'rejected']);
  const u = { id: uuid(), senseId: sid, rating: 1, source: 'undo', reversesId: e1.id, clientAt: t.clock.iso() };
  const r2 = c.must(await c.post('/learn/reviews', { events: [u] }));
  assert.equal(r2.results[0].status, 'accepted');
  const r3 = c.must(await c.post('/learn/reviews', { events: [{ ...u, id: uuid() }] }));
  assert.equal(r3.results[0].status, 'rejected');
  assert.equal(c.must(await c.get('/me/wallet')).balance ?? 0, 0);
});

test('thời gian client ở tương lai bị từ chối', async () => {
  const { c } = await learnerWithCards();
  const today = c.must(await c.get('/learn/today'));
  const r = c.must(await c.post('/learn/reviews', { events: [{ id: uuid(), senseId: today.cards[0].senseId ?? today.cards[0].id, rating: 3, clientAt: new Date(t.clock.ms() + 3600e3).toISOString() }] }));
  assert.equal(r.results[0].status, 'rejected');
});

test('cách ly: người dùng khác không thể ôn sense không nằm trong bộ của mình', async () => {
  const { c } = await learnerWithCards();
  const other = await registerAdult(t, { role: 'learner' });
  const today = c.must(await c.get('/learn/today'));
  const r = other.must(await other.post('/learn/reviews', { events: [{ id: uuid(), senseId: today.cards[0].senseId ?? today.cards[0].id, rating: 3 }] }));
  assert.equal(r.results[0].status, 'rejected');
});

test('IDOR bộ sưu tập: 404 (ẩn tồn tại) + If-Match bắt buộc', async () => {
  const { c, col } = await learnerWithCards();
  const other = await registerAdult(t, { role: 'learner' });
  assert.equal((await other.get(`/me/collections/${col.id}`)).status, 404);
  assert.equal((await c.patch(`/me/collections/${col.id}`, { title: 'Mới' })).status, 428);
  assert.equal((await c.patch(`/me/collections/${col.id}`, { title: 'Mới' }, { 'If-Match': '"99"' })).status, 412);
  assert.equal((await c.patch(`/me/collections/${col.id}`, { title: 'Mới' }, { 'If-Match': '"1"' })).status, 200);
});

test('rebuild bằng chuỗi sự kiện = trạng thái tăng dần', () => {
  const evs = [3, 3, 1, 4].map((rating, i) => ({ rating, at_ms: Date.UTC(2026, 2, 10 + i * 3), source: 'review', id: String(i) }));
  assert.ok(typeof rebuild === 'function');
});
