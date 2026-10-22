import { build } from './app.js';
import { bootstrapAdminFromEnv } from './lib/bootstrap.js';

const ctx = build();
const { app, jobs, log, db, config } = ctx;
const addr = await app.listen();
log.info('listening', { port: addr.port, env: config.env, db: config.databasePath });
await bootstrapAdminFromEnv({ db, clock: ctx.clock, log });
jobs.start();
if (config.demoMode) log.warn('demo_mode_on', { hint: 'Tự duyệt mọi tài khoản (AUTO_APPROVE/DEMO_MODE). Đặt AUTO_APPROVE=false và DEMO_MODE=false để duyệt thủ công' });
if (config.emailMode === 'console' && config.prod) log.warn('email_console_in_production', { hint: 'Đặt EMAIL_MODE=webhook + EMAIL_WEBHOOK_URL để gửi email thật' });

let closing = false;
async function shutdown(sig) {
  if (closing) return; closing = true;
  log.info('shutdown', { sig });
  app.drain(); jobs.stop();
  const t = setTimeout(() => process.exit(1), 10000); t.unref();
  await app.close();
  try { ctx.audit.checkpoint(); } catch { /* bỏ qua */ }
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', { error: String(e?.message || e) }));
