import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { schedule, rebuild, preview, NEW_STATE, SCHEDULER_VERSION } from './fsrs.js';
import { learningDay, daysBetween, isoWeekKey } from '../lib/time.js';
import { ledgerPost, wallet } from './economy.js';
import { lev } from '../lib/norm.js';
import { SENSE_COLS, senseView } from './vocab.js';
import { notify } from './common.js';

const ALGO = SCHEDULER_VERSION, SCHEMA_V = 1;
const MASTERED_STABILITY_DAYS = 21; // GIẢ THUYẾT (BASELINE_PENDING): «nhớ vững» = đã ôn thành công và độ ổn định >= 21 ngày
const MAX_CLIENT_FUTURE_MS = 5 * 60e3;
const UNDO_WINDOW_MS = 15e3;
const MAX_BACKDATE_MS = 7 * 86400e3;
const GAME_XP_DAILY_CAP = 30;

/** Thời điểm hiệu lực của một sự kiện: client_at kẹp trong [received-7d, received]; thiếu → received. */
export function effectiveMs(ev) {
  const rec = Date.parse(ev.received_at);
  if (!ev.client_at) return rec;
  const c = Date.parse(ev.client_at);
  return Math.min(rec, Math.max(rec - MAX_BACKDATE_MS, c));
}

/** Dựng lại trạng thái MỘT sense từ chuỗi sự kiện (received_at, seq) và ghi vào learner_sense_state. */
export function rebuildState(db, cfg, userId, senseId, tenantId) {
  const events = db.all('SELECT id,rating,source,reverses_id,client_at,received_at FROM review_events WHERE user_id=? AND sense_id=? ORDER BY received_at, seq', userId, senseId);
  const chain = events.map((e) => ({ ...e, effective_ms: effectiveMs(e) }));
  const st = rebuild(chain, { userId, senseId, retention: cfg.learning.desiredRetention, leechLapses: cfg.learning.leechLapses });
  const prev = db.get('SELECT row_version, state FROM learner_sense_state WHERE user_id=? AND sense_id=?', userId, senseId);
  if (st.state === 'new') { // chỉ có sự kiện game/undo: không có trạng thái lịch
    if (prev && prev.state !== 'suspended') db.run('DELETE FROM learner_sense_state WHERE user_id=? AND sense_id=?', userId, senseId);
    return null;
  }
  const suspended = prev?.state === 'suspended';
  db.run(`INSERT INTO learner_sense_state(tenant_id,user_id,sense_id,stability,difficulty,due_at,last_review_at,reps,lapses,leech,state,introduced_at,scheduler_version,row_version)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)
          ON CONFLICT(user_id,sense_id) DO UPDATE SET stability=excluded.stability, difficulty=excluded.difficulty, due_at=excluded.due_at, last_review_at=excluded.last_review_at,
            reps=excluded.reps, lapses=excluded.lapses, leech=excluded.leech, state=excluded.state, introduced_at=excluded.introduced_at, scheduler_version=excluded.scheduler_version, row_version=row_version+1`,
    tenantId, userId, senseId, st.stability, st.difficulty, st.due_at, st.last_review_at, st.reps, st.lapses, st.leech ? 1 : 0, suspended ? 'suspended' : st.state, st.introduced_at, ALGO);
  return st;
}

export function touchStreak(db, userId, dayKey) {
  const row = db.get('SELECT * FROM streaks WHERE user_id=?', userId);
  if (!row) return null;
  if (row.last_day === dayKey) return row;
  let { current, freeze_tokens: tokens, broken_value: broken } = row;
  const wk = isoWeekKey(dayKey);
  if (row.last_freeze_week !== wk) { tokens = Math.min(2, tokens + 1); } // token «đóng băng» hằng tuần, tối đa 2
  if (!row.last_day) current = 1;
  else {
    const gap = daysBetween(row.last_day, dayKey);
    if (gap <= 0) return row; // sự kiện đến muộn của ngày cũ: không đổi streak
    if (gap === 1) current += 1;
    else if (gap === 2 && tokens > 0) { tokens -= 1; current += 1; } // tự dùng token, không phạt
    else { broken = current; current = 1; }
  }
  db.run('UPDATE streaks SET current=?, best=MAX(best,?), last_day=?, freeze_tokens=?, last_freeze_week=?, broken_value=? WHERE user_id=?', current, current, dayKey, tokens, wk, broken, userId);
  return db.get('SELECT * FROM streaks WHERE user_id=?', userId);
}

const stickerThreshold = (st) => st.state === 'review' && st.stability >= MASTERED_STABILITY_DAYS && !st.leech;

export function register(r, d) {
  const { db, clock, config, audit } = d;
  const L = config.learning;

  const dayOf = (user, ms = clock.ms()) => learningDay(ms, user.tz, L.dayBoundaryHour);

  // Sense hợp lệ để học = nằm trong kho còn hoạt động của người dùng
  const ACTIVE_SENSE = `EXISTS (SELECT 1 FROM collection_items ci JOIN learner_collections c ON c.id=ci.collection_id
     WHERE ci.sense_id=st_sense AND c.owner_id=? AND c.status='active' AND ci.removed_at IS NULL)`;

  function todayCards(user, tenantId, limit) {
    const now = clock.ms();
    const day = dayOf(user, now);
    const doneToday = db.get("SELECT COUNT(*) AS n FROM review_events WHERE user_id=? AND source='review' AND received_at>=?", user.id, new Date(day.startMs).toISOString()).n;
    const newToday = db.get('SELECT COUNT(*) AS n FROM learner_sense_state WHERE user_id=? AND introduced_at>=?', user.id, new Date(day.startMs).toISOString()).n;
    const reviewsLeft = Math.max(0, L.maxReviewsPerDay - doneToday);
    const newLeft = Math.max(0, (user.prefsObj?.newPerDay ?? L.newPerDay) - newToday);
    const take = Math.min(limit, reviewsLeft);
    const due = db.all(`SELECT st.sense_id AS id, st.state, st.stability, st.difficulty, st.due_at, st.last_review_at, st.reps, st.lapses, st.leech, ${SENSE_COLS}
      FROM learner_sense_state st JOIN senses s ON s.id=st.sense_id JOIN lexemes l ON l.id=s.lexeme_id
      WHERE st.user_id=? AND st.state IN ('learning','relearning','review') AND st.due_at<=?
        AND ${ACTIVE_SENSE.replace('st_sense', 'st.sense_id')}
      ORDER BY CASE st.state WHEN 'review' THEN 1 ELSE 0 END, st.due_at LIMIT ?`, user.id, new Date(now).toISOString(), user.id, take);
    const newRows = take - due.length > 0 && newLeft > 0 ? db.all(`SELECT s.id, 'new' AS state, 0 AS stability, 0 AS difficulty, NULL AS due_at, NULL AS last_review_at, 0 AS reps, 0 AS lapses, 0 AS leech, ${SENSE_COLS}, MIN(ci.added_at) AS added
      FROM collection_items ci JOIN learner_collections c ON c.id=ci.collection_id JOIN senses s ON s.id=ci.sense_id JOIN lexemes l ON l.id=s.lexeme_id
      WHERE c.owner_id=? AND c.status='active' AND ci.removed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM learner_sense_state x WHERE x.user_id=? AND x.sense_id=s.id)
      GROUP BY s.id ORDER BY c.locked DESC, MIN(COALESCE(ci.position, 1000000)), added LIMIT ?`, user.id, user.id, Math.min(newLeft, take - due.length)) : [];
    const totalDue = db.get(`SELECT COUNT(*) AS n FROM learner_sense_state st WHERE st.user_id=? AND st.state IN ('learning','relearning','review') AND st.due_at<=? AND ${ACTIVE_SENSE.replace('st_sense', 'st.sense_id')}`, user.id, new Date(now).toISOString(), user.id).n;
    let cards = [...due, ...newRows].map((row) => {
      const st = row.state === 'new' ? NEW_STATE() : { state: row.state, stability: row.stability, difficulty: row.difficulty, due_at: row.due_at, last_review_at: row.last_review_at, reps: row.reps, lapses: row.lapses, leech: !!row.leech };
      return { ...senseView(row), state: row.state, isNew: row.state === 'new', leech: !!row.leech, lapses: row.lapses, preview: preview(st, now, { userId: user.id, senseId: row.id, retention: L.desiredRetention, leechLapses: L.leechLapses }) };
    });
    cards = separateConfusables(cards);
    return { cards, counts: { due: totalDue, newAvailable: newRows.length, reviewsToday: doneToday, newToday, newPerDay: user.prefsObj?.newPerDay ?? L.newPerDay, reviewsLeft, dailyGoal: user.prefsObj?.dailyGoal ?? 10 }, day: day.key };
  }

  /** Không đặt hai từ dễ nhầm liền nhau (B5.1): hoán đổi tham lam theo khoảng cách chỉnh sửa <= 2 hoặc cùng tiền tố 4 ký tự. */
  function separateConfusables(cards) {
    const confusable = (a, b) => a.lemma !== b.lemma && (lev(a.lemma.toLowerCase(), b.lemma.toLowerCase()) <= 2 || (a.lemma.length > 4 && a.lemma.slice(0, 4) === b.lemma.slice(0, 4)));
    const out = [...cards];
    for (let i = 1; i < out.length; i++) {
      if (!confusable(out[i - 1], out[i])) continue;
      const j = out.findIndex((c, k) => k > i && !confusable(out[i - 1], c) && (!out[i + 1] || k === i + 1 || !confusable(c, out[i + 1])));
      if (j > i) { const [x] = out.splice(j, 1); out.splice(i, 0, x); }
    }
    return out;
  }

  r.get('/learn/today', { action: 'learn.today', query: s.object({ limit: s.string({ max: 3 }).default('20') }, { strict: false }) }, (ctx) => {
    const user = { ...ctx.user, prefsObj: JSON.parse(ctx.user.prefs) };
    const limit = Math.min(Math.max(parseInt(ctx.query.limit, 10) || 20, 1), 100);
    return todayCards(user, ctx.actor.tenantId, limit);
  });

  // Gói offline: ≤100 thẻ đến hạn/mới, KHÔNG chứa đáp án bài thi (B4.5)
  r.get('/learn/pack', { action: 'learn.today' }, (ctx) => {
    const user = { ...ctx.user, prefsObj: JSON.parse(ctx.user.prefs) };
    const t = todayCards(user, ctx.actor.tenantId, 100);
    return { ...t, packExpiresAt: new Date(clock.ms() + 24 * 3600e3).toISOString(), schedulerVersion: ALGO };
  });

  const EVENT = s.object({
    id: s.uuid(), senseId: s.uuid(), rating: s.int({ min: 1, max: 4 }), clientAt: s.iso().optional(), durationMs: s.int({ min: 0, max: 3600000 }).optional(),
    source: s.enum(['review', 'game', 'undo']).default('review'), reversesId: s.uuid().optional(), deviceId: s.string({ max: 64 }).optional(),
  });

  r.post('/learn/reviews', {
    action: 'learn.review', rate: [{ name: 'sync', by: 'user', limit: 30, windowSec: 60 }],
    body: s.object({ events: s.array(EVENT, { min: 1, max: 200 }) }),
  }, (ctx) => {
    const { events } = ctx.body;
    const user = ctx.user, tenantId = ctx.actor.tenantId;
    return db.tx(() => { // MỘT transaction/batch/người dùng → tuần tự hóa (tương đương advisory lock, B1.7)
      const results = [], touched = new Set(), now = clock.ms(), nowIso = clock.iso();
      const day = dayOf(user, now);
      const owned = new Map();
      const senseAllowed = (id) => {
        if (!owned.has(id)) owned.set(id, !!db.get('SELECT 1 FROM collection_items ci JOIN learner_collections c ON c.id=ci.collection_id WHERE c.owner_id=? AND ci.sense_id=? LIMIT 1', user.id, id));
        return owned.get(id);
      };
      let seq = db.get('SELECT COALESCE(MAX(seq),0) AS m FROM review_events WHERE user_id=?', user.id).m;
      const accepted = [];
      for (const e of events) {
        if (!senseAllowed(e.senseId)) { results.push({ id: e.id, status: 'rejected', reason: 'sense_not_in_collection' }); continue; }
        if (e.clientAt && Date.parse(e.clientAt) > now + MAX_CLIENT_FUTURE_MS) { results.push({ id: e.id, status: 'rejected', reason: 'client_time_in_future' }); continue; }
        if (e.source === 'undo') {
          if (!e.reversesId) { results.push({ id: e.id, status: 'rejected', reason: 'undo_needs_reverses_id' }); continue; }
          const orig = db.get('SELECT * FROM review_events WHERE user_id=? AND id=?', user.id, e.reversesId);
          if (!orig || orig.sense_id !== e.senseId || orig.source === 'undo') { results.push({ id: e.id, status: 'rejected', reason: 'undo_target_invalid' }); continue; }
          if (db.get("SELECT 1 FROM review_events WHERE user_id=? AND reverses_id=? AND source='undo'", user.id, e.reversesId)) { results.push({ id: e.id, status: 'rejected', reason: 'undo_already_applied' }); continue; }
          const tOrig = orig.client_at ? Date.parse(orig.client_at) : Date.parse(orig.received_at);
          const tUndo = e.clientAt ? Date.parse(e.clientAt) : now;
          if (tUndo - tOrig > UNDO_WINDOW_MS || tUndo < tOrig) { results.push({ id: e.id, status: 'rejected', reason: 'undo_window_expired' }); continue; }
        } else if (e.reversesId) { results.push({ id: e.id, status: 'rejected', reason: 'reverses_id_only_for_undo' }); continue; }
        seq += 1;
        const ins = db.run('INSERT OR IGNORE INTO review_events(id,tenant_id,user_id,sense_id,rating,duration_ms,client_at,received_at,seq,source,reverses_id,device_id,algo_version,schema_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          e.id, tenantId, user.id, e.senseId, e.rating, e.durationMs ?? null, e.clientAt ?? null, nowIso, seq, e.source, e.reversesId ?? null, e.deviceId ?? null, ALGO, SCHEMA_V);
        if (ins.changes === 0) { results.push({ id: e.id, status: 'duplicate' }); seq -= 1; continue; }
        results.push({ id: e.id, status: 'accepted' });
        accepted.push(e); touched.add(e.senseId);
      }

      // dựng lại trạng thái từng sense bị ảnh hưởng (sự kiện đến muộn/hoàn tác → dựng lại từ chuỗi, không «last write wins»)
      const newStickers = [];
      for (const sid of touched) {
        const st = rebuildState(db, config, user.id, sid, tenantId);
        if (st && stickerThreshold(st)) {
          const ins = db.run('INSERT OR IGNORE INTO sticker_collection(user_id,sense_id,earned_at) VALUES(?,?,?)', user.id, sid, nowIso);
          if (ins.changes) newStickers.push(sid);
        } else if (!st || !stickerThreshold(st)) { /* sticker đã nhận không bị thu hồi */ }
      }

      // XP: chỉ từ sự kiện SERVER đã xác minh và có trần/ngày (DI-008 nhờ UNIQUE)
      let xp = 0;
      const dayStartIso = new Date(day.startMs).toISOString();
      let reviewXpToday = db.get("SELECT COUNT(*) AS n FROM economy_ledger WHERE user_id=? AND reason='review' AND created_at>=?", user.id, dayStartIso).n;
      let gameXpToday = db.get("SELECT COUNT(*) AS n FROM economy_ledger WHERE user_id=? AND reason='game' AND created_at>=?", user.id, dayStartIso).n;
      for (const e of accepted) {
        if (e.source === 'review' && reviewXpToday < L.maxReviewsPerDay) {
          if (ledgerPost(db, clock, { tenantId, userId: user.id, delta: 1, reason: 'review', refType: 'review_event', refId: e.id }).applied) { xp += 1; reviewXpToday += 1; }
        } else if (e.source === 'game' && e.rating >= 3 && gameXpToday < GAME_XP_DAILY_CAP) {
          if (ledgerPost(db, clock, { tenantId, userId: user.id, delta: 1, reason: 'game', refType: 'review_event', refId: e.id }).applied) { xp += 1; gameXpToday += 1; }
        } else if (e.source === 'undo') {
          const orig = db.get("SELECT id FROM economy_ledger WHERE user_id=? AND ref_type='review_event' AND ref_id=? AND reason='review'", user.id, e.reversesId);
          const bal = db.get('SELECT balance FROM economy_accounts WHERE user_id=?', user.id).balance;
          if (orig && bal >= 1) { if (ledgerPost(db, clock, { tenantId, userId: user.id, delta: -1, reason: 'review_undo', refType: 'review_event', refId: e.id, reversesId: orig.id }).applied) xp -= 1; }
        }
      }
      let streak = db.get('SELECT current,best,freeze_tokens FROM streaks WHERE user_id=?', user.id);
      if (accepted.some((e) => e.source !== 'undo')) streak = touchStreak(db, user.id, day.key) || streak;
      audit.write({ tenantId, actorId: user.id, action: 'learn.sync', targetType: 'user', targetId: user.id, diff: { accepted: accepted.length, total: events.length }, requestId: ctx.requestId });
      return { results, xpAwarded: xp, wallet: wallet(db, user.id), streak: { current: streak.current, best: streak.best, freezeTokens: streak.freeze_tokens }, newStickers, serverTime: nowIso };
    });
  });

  r.get('/learn/progress', { action: 'learn.progress' }, (ctx) => {
    const uid = ctx.user.id, day = dayOf(ctx.user);
    const by = Object.fromEntries(db.all('SELECT state, COUNT(*) AS n FROM learner_sense_state WHERE user_id=? GROUP BY state', uid).map((x) => [x.state, x.n]));
    const mastered = db.get("SELECT COUNT(*) AS n FROM learner_sense_state WHERE user_id=? AND state='review' AND stability>=?", uid, MASTERED_STABILITY_DAYS).n;
    const leeches = db.all(`SELECT st.sense_id AS id, st.lapses, ${SENSE_COLS} FROM learner_sense_state st JOIN senses s ON s.id=st.sense_id JOIN lexemes l ON l.id=s.lexeme_id WHERE st.user_id=? AND st.leech=1 LIMIT 20`, uid).map((x) => ({ ...senseView(x), lapses: x.lapses }));
    const since = new Date(day.startMs - 13 * 86400e3).toISOString();
    const evs = db.all("SELECT received_at, rating FROM review_events WHERE user_id=? AND source='review' AND received_at>=?", uid, since);
    const byDay = {};
    for (const e of evs) { const k = learningDay(Date.parse(e.received_at), ctx.user.tz, L.dayBoundaryHour).key; byDay[k] = (byDay[k] || 0) + 1; }
    const last14 = [];
    for (let i = 13; i >= 0; i--) { const k = new Date(Date.parse(day.key + 'T00:00:00Z') - i * 86400e3).toISOString().slice(0, 10); last14.push({ day: k, reviews: byDay[k] || 0 }); }
    const startIso = new Date(day.startMs).toISOString();
    const today = { reviews: db.get("SELECT COUNT(*) AS n FROM review_events WHERE user_id=? AND source='review' AND received_at>=?", uid, startIso).n, games: db.get("SELECT COUNT(*) AS n FROM review_events WHERE user_id=? AND source='game' AND received_at>=?", uid, startIso).n, newWords: db.get('SELECT COUNT(*) AS n FROM learner_sense_state WHERE user_id=? AND introduced_at>=?', uid, startIso).n };
    const total = db.get('SELECT COUNT(*) AS n FROM learner_sense_state WHERE user_id=?', uid).n;
    return { totals: { started: total, learning: (by.learning || 0) + (by.relearning || 0), review: by.review || 0, mastered, suspended: by.suspended || 0 }, today, last14, leeches, streak: db.get('SELECT current,best,freeze_tokens AS freezeTokens FROM streaks WHERE user_id=?', uid), wallet: wallet(db, uid), stickers: db.get('SELECT COUNT(*) AS n FROM sticker_collection WHERE user_id=?', uid).n, day: day.key };
  });

  // F3 Cứu Từ Khó: tạm dừng một từ (người học chọn) hoặc đặt lại để học lại từ đầu
  r.post('/learn/senses/:id/leech', {
    action: 'learn.review', idem: true, body: s.object({ action: s.enum(['suspend', 'resume', 'reset']) }),
  }, (ctx) => {
    const st = db.get('SELECT * FROM learner_sense_state WHERE user_id=? AND sense_id=?', ctx.user.id, ctx.params.id);
    if (!st) throw err('NOT_FOUND');
    if (ctx.body.action === 'suspend') db.run("UPDATE learner_sense_state SET state='suspended', row_version=row_version+1 WHERE user_id=? AND sense_id=?", ctx.user.id, ctx.params.id);
    else if (ctx.body.action === 'resume') { db.run("UPDATE learner_sense_state SET state='review', leech=0, row_version=row_version+1 WHERE user_id=? AND sense_id=? AND state='suspended'", ctx.user.id, ctx.params.id); }
    else db.run("UPDATE learner_sense_state SET leech=0, lapses=0, state='relearning', due_at=?, row_version=row_version+1 WHERE user_id=? AND sense_id=?", clock.iso(), ctx.user.id, ctx.params.id);
    return { ok: true };
  });

  // ---- streak + nhiệm vụ ngày (F5) ----
  r.get('/me/streak', { action: 'streak.manage' }, (ctx) => {
    const sr = db.get('SELECT * FROM streaks WHERE user_id=?', ctx.user.id);
    const day = dayOf(ctx.user);
    const month = day.key.slice(0, 7);
    return { current: sr.current, best: sr.best, lastDay: sr.last_day, freezeTokens: sr.freeze_tokens, canRepair: sr.broken_value > 0 && sr.last_day === day.key && sr.last_repair_month !== month };
  });
  r.post('/me/streak/repair', { action: 'streak.manage', idem: true }, (ctx) => db.tx(() => {
    const sr = db.get('SELECT * FROM streaks WHERE user_id=?', ctx.user.id);
    const day = dayOf(ctx.user), month = day.key.slice(0, 7);
    if (!(sr.broken_value > 0 && sr.last_day === day.key)) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.NOTHING_TO_REPAIR' });
    if (sr.last_repair_month === month) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.REPAIR_USED_THIS_MONTH' });
    const restored = sr.broken_value + sr.current;
    db.run('UPDATE streaks SET current=?, best=MAX(best,?), broken_value=0, last_repair_month=? WHERE user_id=?', restored, restored, month, ctx.user.id);
    return { current: restored };
  }));

  const questState = (user) => {
    const day = dayOf(user), startIso = new Date(day.startMs).toISOString(), uid = user.id;
    const goal = JSON.parse(user.prefs).dailyGoal ?? 10;
    const reviews = db.get("SELECT COUNT(*) AS n FROM review_events WHERE user_id=? AND source='review' AND received_at>=?", uid, startIso).n;
    const games = db.get("SELECT COUNT(*) AS n FROM review_events WHERE user_id=? AND source='game' AND received_at>=?", uid, startIso).n;
    const newWords = db.get('SELECT COUNT(*) AS n FROM learner_sense_state WHERE user_id=? AND introduced_at>=?', uid, startIso).n;
    const claimed = !!db.get("SELECT 1 FROM economy_ledger WHERE user_id=? AND reason='quest_daily' AND ref_id=?", uid, `${uid}:${day.key}`);
    const tasks = [{ key: 'review', done: reviews >= Math.min(goal, 5), progress: reviews, target: Math.min(goal, 5) }, { key: 'game', done: games >= 1, progress: games, target: 1 }, { key: 'new_word', done: newWords >= 1, progress: newWords, target: 1 }];
    return { day: day.key, tasks, complete: tasks.every((t) => t.done), claimed, reward: 5 };
  };
  r.get('/me/quests', { action: 'streak.manage' }, (ctx) => questState(ctx.user));
  r.post('/me/quests/claim', { action: 'streak.manage', idem: true }, (ctx) => db.tx(() => {
    const q = questState(ctx.user);
    if (!q.complete) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.QUEST_NOT_COMPLETE' });
    const res = ledgerPost(db, clock, { tenantId: ctx.actor.tenantId, userId: ctx.user.id, delta: q.reward, reason: 'quest_daily', refType: 'quest', refId: `${ctx.user.id}:${q.day}` });
    return { claimed: true, awarded: res.applied ? q.reward : 0, wallet: wallet(db, ctx.user.id) };
  }));

  r.get('/me/stickers', { action: 'learn.progress' }, (ctx) => {
    const rows = db.all(`SELECT sc.sense_id AS id, sc.earned_at AS earnedAt, ${SENSE_COLS},
       (SELECT group_concat(topic) FROM sense_topics WHERE sense_id=s.id) AS topics FROM sticker_collection sc JOIN senses s ON s.id=sc.sense_id JOIN lexemes l ON l.id=s.lexeme_id WHERE sc.user_id=? ORDER BY sc.earned_at DESC`, ctx.user.id);
    return { stickers: rows.map((x) => ({ ...senseView(x), earnedAt: x.earnedAt, topics: (x.topics || '').split(',') })) };
  });
}
