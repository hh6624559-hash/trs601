/**
 * Giới hạn tần suất cửa sổ trượt, kho đếm = bảng rate_events (Postgres/SQLite giai đoạn đầu, B1.4).
 * Trả { allowed, retryAfter, remaining }. Người gọi quyết định fail-closed/fail-open khi limiter lỗi.
 */
export function makeLimiter(db, clock) {
  return {
    hit(key, limit, windowSec, cost = 1) {
      const now = clock.ms();
      const since = now - windowSec * 1000;
      const used = db.get('SELECT COALESCE(SUM(cost),0) AS n, MIN(ts) AS oldest FROM rate_events WHERE k=? AND ts>?', key, since);
      if (used.n + cost > limit) {
        const retryAfter = Math.max(1, Math.ceil(((used.oldest ?? now) + windowSec * 1000 - now) / 1000));
        return { allowed: false, retryAfter, remaining: 0 };
      }
      db.run('INSERT INTO rate_events(k,ts,cost) VALUES(?,?,?)', key, now, cost);
      return { allowed: true, retryAfter: 0, remaining: limit - used.n - cost };
    },
    reset(key) { db.run('DELETE FROM rate_events WHERE k=?', key); },
    prune(olderThanSec = 3600) { return db.run('DELETE FROM rate_events WHERE ts<?', clock.ms() - olderThanSec * 1000).changes; },
  };
}
