import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Migration có checksum: sửa file đã chạy → báo lỗi (forward-fix bằng migration mới, B2.7). */
export function migrate(db, log = () => {}) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Map(db.all('SELECT version, checksum FROM schema_migrations').map((r) => [r.version, r.checksum]));
  let ran = 0;
  for (const f of files) {
    const sql = readFileSync(join(DIR, f), 'utf8');
    const sum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(f)) {
      if (applied.get(f) !== sum) throw new Error(`Migration ${f} đã chạy nhưng nội dung bị sửa (checksum lệch). Hãy tạo migration mới.`);
      continue;
    }
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.run('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?,?,?)', f, sum, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${f} lỗi: ${e.message}`);
    }
    ran++;
    log(`migrated ${f}`);
  }
  return { total: files.length, ran };
}
