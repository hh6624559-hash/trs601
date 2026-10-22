import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './lib/config.js';
import { openDb } from './lib/db.js';
import { migrate } from './lib/migrate.js';
import { SystemClock } from './lib/clock.js';
import { makeLogger } from './lib/log.js';
import { makeLimiter } from './lib/ratelimit.js';
import { makeAudit } from './lib/audit.js';
import { makeMailer } from './lib/mailer.js';
import { createApp } from './lib/http.js';
import { seedVocabulary } from './seed/load.js';
import { makeJobs } from './jobs.js';
import * as identity from './modules/identity.js';
import * as vocab from './modules/vocab.js';
import * as economy from './modules/economy.js';
import * as learning from './modules/learning.js';
import * as collections from './modules/collections.js';
import * as classes from './modules/classes.js';
import * as assessment from './modules/assessment.js';
import * as social from './modules/social.js';
import * as guardian from './modules/guardian.js';
import * as privacy from './modules/privacy.js';
import * as admin from './modules/admin.js';
import * as ai from './modules/ai.js';
import * as vocabimport from './modules/vocabimport.js';
import * as practice from './modules/practice.js';
import { makeGateway, makeFakeProvider } from './lib/llm.js';
import * as arena from './modules/arena.js';
import * as rooms from './modules/rooms.js';
import { makeMediaProvider } from './lib/media.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Ráp ứng dụng. Mọi phụ thuộc (db, clock, mailer…) tiêm được để test xác định. */
export function build(overrides = {}) {
  const config = overrides.config || loadConfig();
  const log = overrides.log || makeLogger(config.env === 'test' ? 'silent' : undefined);
  const clock = overrides.clock || new SystemClock();
  const db = overrides.db || openDb(config.databasePath);
  migrate(db, (m) => log.info('migration', { m }));
  const added = seedVocabulary(db);
  if (added) log.info('seed_vocabulary', { added });
  const limiter = makeLimiter(db, clock);
  const audit = makeAudit(db, clock);
  const mailer = overrides.mailer || makeMailer(config, log);
  const media = overrides.media || makeMediaProvider(config, clock);
  const deps = { config, db, clock, log, limiter, audit, mailer, media, publicDir: PUBLIC_DIR };
  deps.llmFake = overrides.llmFake || (config.ai.fake ? makeFakeProvider() : null);
  deps.llm = makeGateway({ db, clock, config, audit, fake: deps.llmFake, sleep: overrides.aiSleep, adapters: overrides.aiAdapters });
  if (config.ai.gateway !== null) db.run("UPDATE feature_flags SET enabled=? WHERE key='ai.gateway'", config.ai.gateway ? 1 : 0);
  const app = createApp(deps);
  deps.app = app;
  for (const m of [identity, vocab, economy, learning, collections, classes, assessment, social, guardian, privacy, admin, arena, rooms, ai, vocabimport, practice]) { const out = m.register(app.router, deps); if (m === arena) deps.arena = out; if (m === rooms) deps.rooms = out; }
  const jobs = makeJobs({ db, clock, log, limiter, audit, deps });
  return { ...deps, app, jobs, routes: app.router.routes };
}
