/**
 * Tạo quản trị nền tảng đầu tiên. KHÔNG có admin/mật khẩu mặc định (B3.2).
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='mật khẩu dài ≥10 ký tự' npm run create-admin
 * Lần đăng nhập đầu: bắt buộc bật MFA TOTP trước khi dùng các chức năng quản trị.
 */
import { loadConfig } from '../server/lib/config.js';
import { openDb } from '../server/lib/db.js';
import { migrate } from '../server/lib/migrate.js';
import { SystemClock } from '../server/lib/clock.js';
import { createPlatformAdmin } from '../server/lib/bootstrap.js';

const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
if (!email || !pw) { console.error('Thiếu ADMIN_EMAIL hoặc ADMIN_PASSWORD'); process.exit(1); }
const cfg = loadConfig(), db = openDb(cfg.databasePath), clock = new SystemClock();
migrate(db);
const r = await createPlatformAdmin(db, clock, email, pw);
if (!r.created) { console.error(`Không tạo được: ${r.reason}`); process.exit(1); }
console.log(`Đã tạo quản trị ${email}. Đăng nhập rồi bật MFA TOTP.`);
db.close();
