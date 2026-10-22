import { loadConfig } from '../server/lib/config.js';
import { openDb } from '../server/lib/db.js';
import { migrate } from '../server/lib/migrate.js';
import { seedVocabulary } from '../server/seed/load.js';
const cfg = loadConfig();
const db = openDb(cfg.databasePath);
migrate(db);
console.log(`Đã thêm ${seedVocabulary(db)} từ mới (idempotent).`);
db.close();
