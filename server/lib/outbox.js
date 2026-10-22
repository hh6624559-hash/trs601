import { uuidv7 } from './ids.js';

/** Ghi sự kiện vào outbox CÙNG transaction với nghiệp vụ (DI-016). Consumer idempotent, giả định at-least-once. */
export function publish(db, clock, { aggregateType, aggregateId, type, payload, correlationId = null }) {
  db.run('INSERT INTO outbox_events(id,aggregate_type,aggregate_id,type,payload,correlation_id,created_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?)', uuidv7(), aggregateType, aggregateId, type, JSON.stringify(payload), correlationId, clock.iso(), clock.iso());
}

/**
 * Relay: nhận từng lô bằng UPDATE có điều kiện (tương đương FOR UPDATE SKIP LOCKED); retry backoff + jitter;
 * dead-letter sau MAX_ATTEMPTS lần; dọn bản đã phát sau 7 ngày.
 */
export const MAX_ATTEMPTS = 8;
export function relay(db, clock, handlers, batch = 50) {
  const now = clock.iso();
  const rows = db.all('SELECT * FROM outbox_events WHERE published_at IS NULL AND dead_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at LIMIT ?', now, batch);
  let ok = 0, failed = 0;
  for (const ev of rows) {
    const claim = db.run('UPDATE outbox_events SET attempts=attempts+1 WHERE id=? AND published_at IS NULL AND attempts=?', ev.id, ev.attempts);
    if (claim.changes !== 1) continue; // worker khác đã nhận
    try {
      const h = handlers[ev.type];
      if (h) db.tx(() => h(JSON.parse(ev.payload), ev));
      db.run('UPDATE outbox_events SET published_at=?, last_error=NULL WHERE id=?', clock.iso(), ev.id);
      ok++;
    } catch (e) {
      failed++;
      const attempts = ev.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) db.run('UPDATE outbox_events SET dead_at=?, last_error=? WHERE id=?', clock.iso(), String(e.message).slice(0, 300), ev.id);
      else {
        const delay = Math.min(3600e3, 1000 * 2 ** attempts) * (0.5 + Math.random() * 0.5);
        db.run('UPDATE outbox_events SET last_error=?, next_attempt_at=? WHERE id=?', String(e.message).slice(0, 300), new Date(clock.ms() + delay).toISOString(), ev.id);
      }
    }
  }
  db.run('DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at<?', new Date(clock.ms() - 7 * 86400e3).toISOString());
  return { ok, failed };
}
