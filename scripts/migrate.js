import { loadConfig } from '../server/lib/config.js';
import { openDb } from '../server/lib/db.js';
import { migrate } from '../server/lib/migrate.js';
const cfg = loadConfig();
const db = openDb(cfg.databasePath);
const r = migrate(db, (m) => console.log('  ✓', m));
console.log(`Migrations: ${r.ran} mới / ${r.total} tổng — ${cfg.databasePath}`);
db.close();
