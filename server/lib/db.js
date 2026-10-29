import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Lớp truy cập DB. SQLite WAL, foreign_keys ON, transaction IMMEDIATE (một writer, tuần tự hóa
 * cập nhật theo người dùng – tương đương advisory lock ở B1.7). SQL chuẩn để chuyển PostgreSQL bằng ADR-0001.
 */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA trusted_schema=OFF;');
  const cache = new Map();
  const stmt = (sql) => {
    let st = cache.get(sql);
    if (!st) { st = raw.prepare(sql); cache.set(sql, st); }
    return st;
  };
  const norm = (p) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x));
  let depth = 0;
  const db = {
    raw,
    all: (sql, ...p) => stmt(sql).all(...norm(p)).map((r) => ({ ...r })),
    get: (sql, ...p) => { const r = stmt(sql).get(...norm(p)); return r ? { ...r } : undefined; },
    run: (sql, ...p) => { const r = stmt(sql).run(...norm(p)); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
    exec: (sql) => raw.exec(sql),
    /** Transaction; lồng nhau dùng SAVEPOINT. Lỗi → rollback toàn bộ phần đó rồi ném lại. */
    tx(fn) {
      const name = `sp${depth}`;
      if (depth === 0) raw.exec('BEGIN IMMEDIATE'); else raw.exec(`SAVEPOINT ${name}`);
      depth++;
      try {
        const out = fn(db);
        depth--;
        if (depth === 0) raw.exec('COMMIT'); else raw.exec(`RELEASE ${name}`);
        return out;
      } catch (e) {
        depth--;
        try { if (depth === 0) raw.exec('ROLLBACK'); else raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); } catch { /* đã rollback */ }
        throw e;
      }
    },
    close() { try { raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* bỏ qua */ } raw.close(); },
    ready() { return db.get('SELECT 1 AS ok').ok === 1; },
  };
  return db;
}
