import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { uuidv7, shortCode } from '../lib/ids.js';
import { sha256hex } from '../lib/crypto.js';
import { ageBand } from '../lib/policy.js';
import { publish } from '../lib/outbox.js';
import { MODES, GRACE_MS, DISCONNECT_MS, FORFEIT_MS, REVEAL_MS, score, rankPlayers, buildQuestions, isCorrect, publicQuestion, revealOf } from './arena-core.js';

const READY_MS = 20000, STALE_LOBBY_MS = 30 * 60000;
const ACTIVE = ['joined', 'ready', 'disconnected'];

export function register(r, d) {
  const { db, clock, audit } = d;
  const now = () => clock.ms();
  const iso = (ms) => new Date(ms).toISOString();

  const person = (id) => {
    const u = db.get('SELECT id,birth_ym,display_name FROM users WHERE id=?', id);
    return u ? { id, name: u.display_name, ageBand: ageBand(u.birth_ym, clock.now()) } : null;
  };
  const hasConsent = (id, tenantId, purpose) => !!db.get("SELECT 1 FROM consents WHERE subject_id=? AND tenant_id=? AND purpose=? AND state='GRANTED' AND (expires_at IS NULL OR expires_at>?)", id, tenantId, purpose, clock.iso());
  const teacherOfClass = (uid, classId) => !!classId && !!db.get("SELECT 1 FROM classes WHERE id=? AND teacher_id=? AND status='active'", classId, uid);
  const memberOfClass = (uid, classId) => !!classId && !!db.get("SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND status='active'", classId, uid);
  const inClass = (uid, classId) => teacherOfClass(uid, classId) || memberOfClass(uid, classId);
  const friends = (a, b) => { const [x, y] = a < b ? [a, b] : [b, a]; return !!db.get("SELECT 1 FROM friend_links WHERE user_a=? AND user_b=? AND state='active'", x, y); };
  const blocked = (a, b) => !!db.get('SELECT 1 FROM user_blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)', a, b, b, a);
  const guardianOf = (g, l) => !!db.get("SELECT 1 FROM guardian_links WHERE guardian_id=? AND learner_id=? AND status='active'", g, l);

  const emit = (mid, type, payload = {}) => {
    const seq = db.get('SELECT COALESCE(MAX(seq),0)+1 AS n FROM arena_events WHERE match_id=?', mid).n;
    db.run('INSERT INTO arena_events(match_id,seq,type,payload,created_at) VALUES(?,?,?,?,?)', mid, seq, type, JSON.stringify(payload), clock.iso());
  };
  const setState = (m, state, extra = {}) => {
    const cols = Object.keys(extra);
    db.run(`UPDATE arena_matches SET state=?, last_activity_at=?${cols.map((c) => `, ${c}=?`).join('')} WHERE id=?`, state, clock.iso(), ...cols.map((c) => extra[c]), m.id);
    Object.assign(m, { state, ...extra });
  };
  const players = (mid) => db.all('SELECT p.*, u.display_name AS name FROM arena_players p JOIN users u ON u.id=p.user_id WHERE p.match_id=? ORDER BY p.joined_at, p.user_id', mid);

  /** Quy tắc §8.3 + §7.2: ai được vào trận. Trả { ok, reason }. */
  function joinCheck(me, m, spectate, viaCode) {
    const no = (reason) => ({ ok: false, reason });
    if (m.tenant_id !== me.tenantId) return no('tenant');
    if (blocked(me.id, m.host_id)) return no('blocked');
    const band = me.ageBand;
    if (band === 'u13' && !(m.visibility === 'class' && memberOfClass(me.id, m.class_id))) return no('under13_class_only');
    if (m.visibility === 'class' && !inClass(me.id, m.class_id)) return no('not_in_class');
    if (m.visibility === 'friends' && me.id !== m.host_id && !friends(me.id, m.host_id)) return no('not_friend');
    if (m.visibility === 'open_adults' && band !== '18p') return no('adults_only');
    if (m.visibility === 'private' && !viaCode && me.id !== m.host_id) return no('code_required');
    if (m.visibility !== 'class' && band === '13_17' && !hasConsent(me.id, me.tenantId, 'social')) return no('consent_social');
    // Người dưới 18 và người lớn chỉ chung trận khi cùng lớp của trận (giáo viên/HS) hoặc có liên kết giám hộ.
    for (const p of players(m.id)) {
      if (p.user_id === me.id) continue;
      const o = person(p.user_id);
      if (blocked(me.id, o.id)) return no('blocked');
      if ((band === '18p') !== (o.ageBand === '18p')) {
        const related = (m.class_id && inClass(me.id, m.class_id) && inClass(o.id, m.class_id)) || guardianOf(me.id, o.id) || guardianOf(o.id, me.id);
        if (!related) return no('adult_minor');
      }
    }
    return { ok: true };
  }

  // ---------- máy trạng thái điều khiển bằng đồng hồ server ----------
  function presence(m) {
    const t = now();
    for (const p of players(m.id)) {
      if (!ACTIVE.includes(p.state)) continue;
      const age = t - Date.parse(p.last_seen_at);
      if (age > FORFEIT_MS) {
        const lobby = m.state === 'LOBBY' || m.state === 'READY_CHECK';
        db.run('UPDATE arena_players SET state=? WHERE match_id=? AND user_id=?', lobby ? 'left' : 'forfeit', m.id, p.user_id);
        emit(m.id, lobby ? 'player_left' : 'forfeit', { userId: p.user_id });
      } else if (age > DISCONNECT_MS && p.state !== 'disconnected') {
        db.run("UPDATE arena_players SET state='disconnected' WHERE match_id=? AND user_id=?", m.id, p.user_id);
        emit(m.id, 'disconnected', { userId: p.user_id });
      }
    }
    // chủ phòng rớt → chuyển cho người chơi kế tiếp đang kết nối
    const host = db.get('SELECT * FROM arena_players WHERE match_id=? AND user_id=?', m.id, m.host_id);
    if (host && ['disconnected', 'forfeit', 'left'].includes(host.state)) {
      const next = players(m.id).find((p) => p.role === 'player' && ['joined', 'ready'].includes(p.state) && p.user_id !== m.host_id);
      if (next) { db.run('UPDATE arena_matches SET host_id=? WHERE id=?', next.user_id, m.id); m.host_id = next.user_id; emit(m.id, 'host_changed', { userId: next.user_id }); }
    }
  }
  const activePlayers = (m) => players(m.id).filter((p) => p.role === 'player' && ACTIVE.includes(p.state));

  function openRound(m, idx) {
    const t = now();
    db.run('UPDATE arena_rounds SET opened_at=? WHERE match_id=? AND idx=?', iso(t), m.id, idx);
    setState(m, 'ROUND_OPEN', { round_idx: idx, opens_at: iso(t), closes_at: iso(t + m.limit_ms), reveal_until: null });
    const q = JSON.parse(db.get('SELECT question FROM arena_rounds WHERE match_id=? AND idx=?', m.id, idx).question);
    emit(m.id, 'round_open', { idx, question: publicQuestion(q), opensAt: m.opens_at, closesAt: m.closes_at });
  }
  function reveal(m) {
    const t = now();
    const row = db.get('SELECT question FROM arena_rounds WHERE match_id=? AND idx=?', m.id, m.round_idx);
    const q = JSON.parse(row.question);
    db.run('UPDATE arena_rounds SET closed_at=? WHERE match_id=? AND idx=?', iso(t), m.id, m.round_idx);
    // điểm chỉ được cộng dồn ở bước reveal (từ bản ghi do server tạo) → không lộ đúng/sai sớm
    db.run(`UPDATE arena_players SET
      score=COALESCE((SELECT SUM(points) FROM arena_answers a WHERE a.match_id=arena_players.match_id AND a.user_id=arena_players.user_id),0),
      correct_count=COALESCE((SELECT SUM(correct) FROM arena_answers a WHERE a.match_id=arena_players.match_id AND a.user_id=arena_players.user_id),0),
      correct_ms=COALESCE((SELECT SUM(elapsed_ms) FROM arena_answers a WHERE a.match_id=arena_players.match_id AND a.user_id=arena_players.user_id AND a.correct=1),0)
      WHERE match_id=?`, m.id);
    setState(m, 'ROUND_REVEAL', { reveal_until: iso(t + REVEAL_MS) });
    const answers = db.all('SELECT user_id AS userId, answer, correct, points FROM arena_answers WHERE match_id=? AND idx=?', m.id, m.round_idx).map((a) => ({ ...a, answer: JSON.parse(a.answer), correct: !!a.correct }));
    emit(m.id, 'round_reveal', { idx: m.round_idx, ...revealOf(q), answers, scores: players(m.id).filter((p) => p.role === 'player').map((p) => ({ userId: p.user_id, score: p.score })) });
  }
  function finish(m, { winnerId = null, aborted = false } = {}) {
    if (aborted) { setState(m, 'ABORTED', { finished_at: clock.iso() }); emit(m.id, 'aborted', {}); return; }
    const all = players(m.id).filter((p) => p.role === 'player' && p.state !== 'left');
    const stay = all.filter((p) => p.state !== 'forfeit'), out = all.filter((p) => p.state === 'forfeit');
    let ranked = [...rankPlayers(stay.map((p) => ({ userId: p.user_id, score: p.score, correctMs: p.correct_ms }))), ...rankPlayers(out.map((p) => ({ userId: p.user_id, score: p.score, correctMs: p.correct_ms }))).map((x) => ({ ...x, rank: stay.length + 1 }))];
    if (winnerId) ranked = ranked.map((x) => ({ ...x, rank: x.userId === winnerId ? 1 : Math.max(2, x.rank) }));
    for (const x of ranked) db.run('UPDATE arena_players SET rank=? WHERE match_id=? AND user_id=?', x.rank, m.id, x.userId);
    setState(m, 'FINISHED', { finished_at: clock.iso() });
    emit(m.id, 'finished', { ranking: ranked.map((x) => ({ userId: x.userId, rank: x.rank, score: x.score })) });
    publish(db, clock, { aggregateType: 'arena_match', aggregateId: m.id, type: 'arena.finished', payload: { matchId: m.id } });
  }

  /** Đẩy máy trạng thái tới hiện tại theo đồng hồ server. Idempotent; gọi trước mỗi đọc/ghi và bởi job nền. */
  function tick(mid) {
    return db.tx(() => {
      const m = db.get('SELECT * FROM arena_matches WHERE id=?', mid);
      if (!m || ['FINISHED', 'ABORTED'].includes(m.state)) return m;
      for (let guard = 0; guard < 40; guard++) {
        const t = now();
        const before = `${m.state}:${m.round_idx}`;
        presence(m);
        if (m.state === 'LOBBY') {
          if (!players(m.id).some((p) => ACTIVE.includes(p.state)) || t - Date.parse(m.last_activity_at) > STALE_LOBBY_MS) finish(m, { aborted: true });
        } else if (m.state === 'READY_CHECK') {
          const act = activePlayers(m);
          if (act.every((p) => p.state === 'ready') && act.length >= m.min_players) openRound(m, 0);
          else if (t > Date.parse(m.closes_at)) {
            db.run("UPDATE arena_players SET state='left' WHERE match_id=? AND role='player' AND state IN ('joined','disconnected')", m.id);
            const left = activePlayers(m);
            if (left.length >= m.min_players && left.every((p) => p.state === 'ready')) openRound(m, 0);
            else { db.run("UPDATE arena_players SET state='joined' WHERE match_id=? AND state='ready'", m.id); setState(m, 'LOBBY', {}); emit(m.id, 'ready_check_failed', {}); }
          }
        } else if (m.state === 'ROUND_OPEN') {
          const act = activePlayers(m);
          const live = act.filter((p) => p.state !== 'disconnected');
          const answered = (uid) => !!db.get('SELECT 1 FROM arena_answers WHERE match_id=? AND idx=? AND user_id=?', m.id, m.round_idx, uid);
          const forfeited = players(m.id).some((p) => p.role === 'player' && p.state === 'forfeit');
          if (m.mode === 'duel' && forfeited) { const w = act[0]?.user_id; finish(m, w ? { winnerId: w } : { aborted: true }); }
          else if (!act.length) finish(m, { aborted: true });
          else if (t > Date.parse(m.closes_at) + GRACE_MS || (live.length && live.every((p) => answered(p.user_id)))) reveal(m);
        } else if (m.state === 'ROUND_REVEAL') {
          const act = activePlayers(m);
          const forfeited = players(m.id).some((p) => p.role === 'player' && p.state === 'forfeit');
          if (m.mode === 'duel' && forfeited) finish(m, act[0] ? { winnerId: act[0].user_id } : { aborted: true });
          else if (!act.length) finish(m, { aborted: true });
          else if (t >= Date.parse(m.reveal_until)) { if (m.round_idx + 1 >= m.rounds) finish(m); else openRound(m, m.round_idx + 1); }
        }
        if (`${m.state}:${m.round_idx}` === before) break;
      }
      return m;
    });
  }

  // ---------- trình bày ----------
  function view(m, uid, after = 0) {
    const ps = players(m.id);
    const me = ps.find((p) => p.user_id === uid);
    const out = {
      id: m.id, mode: m.mode, visibility: m.visibility, state: m.state, hostId: m.host_id, rounds: m.rounds, limitMs: m.limit_ms, roundIdx: m.round_idx,
      opensAt: m.opens_at, closesAt: m.closes_at, revealUntil: m.reveal_until, serverNow: clock.iso(), minPlayers: m.min_players, maxPlayers: m.max_players,
      strictRoom: !!m.strict_room, micLocked: !!m.strict_room && m.state === 'ROUND_OPEN',   // v29: server KHÔNG khóa mic theo giai đoạn trừ khi chủ phòng bật «Phòng thi nghiêm»
      you: me ? { role: me.role, state: me.state } : null,
      players: ps.filter((p) => p.state !== 'left').map((p) => ({ userId: p.user_id, name: p.name, role: p.role, state: p.state, score: p.score, rank: p.rank, tabHidden: m.host_id === uid ? !!p.tab_hidden : undefined,
        answered: m.state === 'ROUND_OPEN' ? !!db.get('SELECT 1 FROM arena_answers WHERE match_id=? AND idx=? AND user_id=?', m.id, m.round_idx, p.user_id) : undefined })),
    };
    if (['ROUND_OPEN', 'ROUND_REVEAL'].includes(m.state)) {
      const q = JSON.parse(db.get('SELECT question FROM arena_rounds WHERE match_id=? AND idx=?', m.id, m.round_idx).question);
      out.question = publicQuestion(q);                                      // KHÔNG có khóa đáp án
      if (m.state === 'ROUND_REVEAL') out.reveal = { ...revealOf(q), answers: db.all('SELECT user_id AS userId, answer, correct, points FROM arena_answers WHERE match_id=? AND idx=?', m.id, m.round_idx).map((a) => ({ ...a, answer: JSON.parse(a.answer), correct: !!a.correct })) };
    }
    const evs = db.all('SELECT seq,type,payload,created_at AS at FROM arena_events WHERE match_id=? AND seq>? ORDER BY seq LIMIT 200', m.id, after).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
    out.events = evs; out.seq = db.get('SELECT COALESCE(MAX(seq),0) AS n FROM arena_events WHERE match_id=?', m.id).n;
    return out;
  }

  const loadMatch = (id) => { const m = db.get('SELECT * FROM arena_matches WHERE id=?', id); if (!m) throw err('NOT_FOUND'); return m; };
  const asMember = (ctx) => {
    const m0 = loadMatch(ctx.params.id);
    if (m0.tenant_id !== ctx.actor.tenantId) throw err('NOT_FOUND');
    const m = tick(m0.id);
    const p = db.get('SELECT * FROM arena_players WHERE match_id=? AND user_id=?', m.id, ctx.user.id);
    if (!p || p.state === 'left') throw err('NOT_FOUND');
    return { m, p };
  };
  const touch = (m, uid) => db.run("UPDATE arena_players SET last_seen_at=?, state=CASE WHEN state='disconnected' THEN 'joined' ELSE state END WHERE match_id=? AND user_id=? AND state IN ('joined','ready','disconnected')", clock.iso(), m.id, uid);

  const flagOn = () => { const f = db.get("SELECT enabled FROM feature_flags WHERE key='arena'"); return !f || !!f.enabled; };

  function joinMatch(ctx, m, { spectate = false, viaCode = false } = {}) {
    const me = { id: ctx.user.id, tenantId: ctx.actor.tenantId, ageBand: ctx.actor.ageBand };
    return db.tx(() => {
      m = tick(m.id);
      const existing = db.get('SELECT * FROM arena_players WHERE match_id=? AND user_id=?', m.id, me.id);
      if (existing && existing.state !== 'left') { touch(m, me.id); return view(m, me.id); }      // join hai lần không tạo bản ghi thứ hai (DI-022)
      if (m.state !== 'LOBBY') throw err('INVALID_STATE_TRANSITION', { messageKey: 'error.ARENA_STARTED' });
      const chk = joinCheck(me, m, spectate, viaCode);
      if (!chk.ok) throw err(chk.reason === 'tenant' ? 'NOT_FOUND' : chk.reason === 'consent_social' ? 'CONSENT_REQUIRED' : 'AGE_POLICY_DENIED', { details: [{ reason: chk.reason }] });
      if (me.ageBand !== '18p' && !hasConsent(me.id, me.tenantId, 'account')) throw err('CONSENT_REQUIRED');
      const asSpectator = spectate || (m.class_id && teacherOfClass(me.id, m.class_id));
      if (!asSpectator && activePlayers(m).length >= m.max_players) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ARENA_FULL' });
      if (existing) db.run("UPDATE arena_players SET state='joined', role=?, last_seen_at=? WHERE match_id=? AND user_id=?", asSpectator ? 'spectator' : 'player', clock.iso(), m.id, me.id);
      else db.run('INSERT INTO arena_players(match_id,user_id,role,state,joined_at,last_seen_at) VALUES(?,?,?,?,?,?)', m.id, me.id, asSpectator ? 'spectator' : 'player', asSpectator ? 'joined' : 'joined', clock.iso(), clock.iso());
      if (me.ageBand !== '18p') db.run('UPDATE arena_matches SET has_minor=1 WHERE id=?', m.id);
      emit(m.id, 'player_joined', { userId: me.id, role: asSpectator ? 'spectator' : 'player' });
      db.run('UPDATE arena_matches SET last_activity_at=? WHERE id=?', clock.iso(), m.id);
      return view(loadMatch(m.id), me.id);
    });
  }

  // ---------- API ----------
  r.post('/arena/matches', {
    action: 'arena.create', idem: true, rate: [{ name: 'arena_create', by: 'user', limit: 10, windowSec: 600 }],
    body: s.object({ mode: s.enum(Object.keys(MODES)), visibility: s.enum(['private', 'class', 'friends', 'open_adults']), classId: s.uuid().optional(), rounds: s.int({ min: 3, max: 20 }).optional(), limitSec: s.int({ min: 5, max: 40 }).optional(), strictRoom: s.boolean().optional() }),
  }, (ctx) => {
    if (!flagOn()) throw err('FORBIDDEN', { messageKey: 'error.FEATURE_OFF' });
    const b = ctx.body, a = ctx.actor, isTeacher = a.roles.includes('teacher');
    if (a.ageBand === 'u13') throw err('AGE_POLICY_DENIED', { details: [{ reason: 'under13_cannot_create' }] });
    if (b.visibility === 'class') { if (!isTeacher || !teacherOfClass(a.id, b.classId)) throw err('AGE_POLICY_DENIED', { details: [{ reason: 'class_match_teacher_only' }] }); }
    else if (isTeacher) throw err('AGE_POLICY_DENIED', { details: [{ reason: 'teacher_class_only' }] });
    if (b.visibility === 'open_adults' && a.ageBand !== '18p') throw err('AGE_POLICY_DENIED', { details: [{ reason: 'adults_only' }] });
    if (b.visibility !== 'class' && a.ageBand === '13_17' && !hasConsent(a.id, a.tenantId, 'social')) throw err('CONSENT_REQUIRED');
    if (b.visibility !== 'class' && b.classId) throw err('VALIDATION_ERROR', { details: [{ path: 'classId', code: 'not_allowed' }] });
    const cfg = MODES[b.mode];
    const rounds = b.rounds ?? cfg.rounds, limitMs = (b.limitSec ?? cfg.limitSec) * 1000;
    const pool = db.all("SELECT s.id, l.lemma, s.ipa, s.definition_vi AS definitionVi FROM senses s JOIN lexemes l ON l.id=s.lexeme_id WHERE s.status='published' AND s.owner_tenant_id IS NULL AND s.definition_vi IS NOT NULL ORDER BY s.id");
    const id = uuidv7(), seed = shortCode(12), code = b.visibility === 'private' ? shortCode(6) : null;
    const qs = buildQuestions({ mode: b.mode, pool, seed, n: rounds });
    if (qs.length < rounds) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ARENA_POOL_SMALL' });
    return db.tx(() => {
      db.run(`INSERT INTO arena_matches(id,tenant_id,host_id,class_id,mode,visibility,state,code_hash,seed,rounds,limit_ms,created_at,last_activity_at,min_players,max_players,has_minor,strict_room)
        VALUES(?,?,?,?,?,?,'LOBBY',?,?,?,?,?,?,?,?,?,?)`, id, a.tenantId, a.id, b.classId ?? null, b.mode, b.visibility, code ? sha256hex(code) : null, seed, rounds, limitMs, clock.iso(), clock.iso(), cfg.min, cfg.max, a.ageBand !== '18p' ? 1 : 0, b.strictRoom ? 1 : 0);
      for (const q of qs) db.run('INSERT INTO arena_rounds(match_id,idx,question) VALUES(?,?,?)', id, q.idx, JSON.stringify(q));
      db.run('INSERT INTO arena_players(match_id,user_id,role,state,joined_at,last_seen_at) VALUES(?,?,?,?,?,?)', id, a.id, b.visibility === 'class' ? 'spectator' : 'player', 'joined', clock.iso(), clock.iso());
      emit(id, 'created', { mode: b.mode, strictRoom: !!b.strictRoom });
      audit.write({ tenantId: a.tenantId, actorId: a.id, action: 'arena.create', targetType: 'arena_match', targetId: id, diff: { mode: b.mode, visibility: b.visibility }, requestId: ctx.requestId });
      return { status: 201, __raw: true, data: { ...view(loadMatch(id), a.id), code } };   // mã chỉ trả MỘT LẦN, DB chỉ giữ băm
    });
  });

  r.post('/arena/join', { action: 'arena.join', idem: true, rate: [{ name: 'arena_code', by: 'user', limit: 10, windowSec: 300 }], body: s.object({ code: s.string({ min: 4, max: 12 }) }) }, (ctx) => {
    const m = db.get("SELECT * FROM arena_matches WHERE code_hash=? AND state='LOBBY'", sha256hex(ctx.body.code.toUpperCase()));
    if (!m) throw err('NOT_FOUND');
    return joinMatch(ctx, m, { viaCode: true });
  });
  r.post('/arena/matches/:id/join', { action: 'arena.join', idem: true, body: s.object({ spectate: s.boolean().optional() }) }, (ctx) => joinMatch(ctx, loadMatch(ctx.params.id), { spectate: !!ctx.body.spectate }));

  r.get('/arena/lobby', { action: 'arena.read' }, (ctx) => {
    const a = ctx.actor;
    const rows = db.all("SELECT * FROM arena_matches WHERE tenant_id=? AND state='LOBBY' ORDER BY created_at DESC LIMIT 50", a.tenantId);
    return { matches: rows.filter((m) => m.visibility !== 'private' && joinCheck({ id: a.id, tenantId: a.tenantId, ageBand: a.ageBand }, m, false, false).ok)
      .map((m) => ({ id: m.id, mode: m.mode, visibility: m.visibility, players: activePlayers(m).length, maxPlayers: m.max_players, host: person(m.host_id)?.name })) };
  });

  r.get('/arena/matches/:id', { action: 'arena.read', query: s.object({ after: s.string({ max: 10 }).optional() }, { strict: false }) }, (ctx) => {
    const { m } = asMember(ctx);
    db.tx(() => touch(m, ctx.user.id));
    return view(tick(m.id), ctx.user.id, parseInt(ctx.query.after, 10) || 0);
  });

  r.post('/arena/matches/:id/ready', { action: 'arena.play', idem: true }, (ctx) => db.tx(() => {
    const { m, p } = asMember(ctx);
    if (p.role !== 'player') throw err('FORBIDDEN');
    if (m.state !== 'READY_CHECK') throw err('INVALID_STATE_TRANSITION');
    db.run("UPDATE arena_players SET state='ready', last_seen_at=? WHERE match_id=? AND user_id=?", clock.iso(), m.id, p.user_id);
    emit(m.id, 'ready', { userId: p.user_id });
    return view(tick(m.id), ctx.user.id);
  }));

  r.post('/arena/matches/:id/start', { action: 'arena.host', idem: true }, (ctx) => db.tx(() => {
    const { m } = asMember(ctx);
    if (m.host_id !== ctx.user.id && !(m.class_id && teacherOfClass(ctx.user.id, m.class_id))) throw err('FORBIDDEN');
    if (m.state !== 'LOBBY') throw err('INVALID_STATE_TRANSITION');
    if (activePlayers(m).length < m.min_players) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ARENA_NEED_PLAYERS' });
    setState(m, 'READY_CHECK', { closes_at: iso(now() + READY_MS) });
    emit(m.id, 'ready_check', { until: m.closes_at });
    return view(m, ctx.user.id);
  }));

  r.post('/arena/matches/:id/answer', {
    action: 'arena.play', idem: true, rate: [{ name: 'arena_answer', by: 'user', limit: 40, windowSec: 10 }],
    body: s.object({ round: s.int({ min: 0, max: 50 }), choice: s.int({ min: 0, max: 7 }).optional(), text: s.string({ max: 60 }).optional() }),
  }, (ctx) => db.tx(() => {
    const received = now();                                                   // thời điểm nhận do SERVER ghi
    const { m, p } = asMember(ctx);
    if (p.role !== 'player') throw err('FORBIDDEN', { messageKey: 'error.SPECTATOR_CANNOT_ANSWER' });
    if (m.state !== 'ROUND_OPEN' || ctx.body.round !== m.round_idx) throw err('INVALID_STATE_TRANSITION', { messageKey: 'error.ARENA_ROUND_CLOSED' });
    if (received > Date.parse(m.closes_at) + GRACE_MS) throw err('INVALID_STATE_TRANSITION', { messageKey: 'error.ARENA_ROUND_CLOSED' });
    if (ctx.body.choice === undefined && ctx.body.text === undefined) throw err('VALIDATION_ERROR', { details: [{ path: 'choice', code: 'required' }] });
    if (db.get('SELECT 1 FROM arena_answers WHERE match_id=? AND idx=? AND user_id=?', m.id, m.round_idx, p.user_id)) throw err('CONFLICT', { messageKey: 'error.ARENA_ALREADY_ANSWERED' });
    const q = JSON.parse(db.get('SELECT question FROM arena_rounds WHERE match_id=? AND idx=?', m.id, m.round_idx).question);
    const ans = q.kind === 'mcq' ? { choice: ctx.body.choice } : { text: ctx.body.text };
    const ok = isCorrect(q, ans);
    const elapsed = Math.min(m.limit_ms, Math.max(0, received - Date.parse(m.opens_at)));
    db.run('INSERT INTO arena_answers(match_id,idx,user_id,answer,received_at,elapsed_ms,correct,points) VALUES(?,?,?,?,?,?,?,?)', m.id, m.round_idx, p.user_id, JSON.stringify(ans), iso(received), elapsed, ok ? 1 : 0, score(ok, elapsed, m.limit_ms));
    db.run('UPDATE arena_players SET last_seen_at=? WHERE match_id=? AND user_id=?', clock.iso(), m.id, p.user_id);
    emit(m.id, 'answer_received', { userId: p.user_id });
    tick(m.id);
    return { accepted: true };                                                // không trả đúng/sai trước reveal
  }));

  r.post('/arena/matches/:id/leave', { action: 'arena.play', idem: true }, (ctx) => db.tx(() => {
    const { m, p } = asMember(ctx);
    const inGame = ['ROUND_OPEN', 'ROUND_REVEAL'].includes(m.state) && p.role === 'player';
    db.run('UPDATE arena_players SET state=? WHERE match_id=? AND user_id=?', inGame ? 'forfeit' : 'left', m.id, p.user_id);
    emit(m.id, inGame ? 'forfeit' : 'player_left', { userId: p.user_id });
    tick(m.id);
    return { left: true };
  }));

  r.post('/arena/matches/:id/cancel', { action: 'arena.host', idem: true }, (ctx) => db.tx(() => {
    const { m } = asMember(ctx);
    if (m.host_id !== ctx.user.id && !(m.class_id && teacherOfClass(ctx.user.id, m.class_id))) throw err('FORBIDDEN');
    if (['FINISHED', 'ABORTED'].includes(m.state)) throw err('INVALID_STATE_TRANSITION');
    finish(m, { aborted: true });
    audit.write({ tenantId: m.tenant_id, actorId: ctx.user.id, action: 'arena.cancel', targetType: 'arena_match', targetId: m.id, requestId: ctx.requestId });
    return { cancelled: true };
  }));

  r.post('/arena/matches/:id/kick', { action: 'arena.host', idem: true, body: s.object({ userId: s.uuid() }) }, (ctx) => db.tx(() => {
    const { m } = asMember(ctx);
    if (m.host_id !== ctx.user.id && !(m.class_id && teacherOfClass(ctx.user.id, m.class_id))) throw err('FORBIDDEN');
    if (ctx.body.userId === ctx.user.id) throw err('BUSINESS_RULE_VIOLATION');
    const inGame = ['ROUND_OPEN', 'ROUND_REVEAL'].includes(m.state);
    const n = db.run("UPDATE arena_players SET state=? WHERE match_id=? AND user_id=? AND state IN ('joined','ready','disconnected')", inGame ? 'forfeit' : 'left', m.id, ctx.body.userId).changes;
    if (!n) throw err('NOT_FOUND');
    emit(m.id, 'kicked', { userId: ctx.body.userId });
    tick(m.id);
    return { kicked: true };
  }));

  // tín hiệu rời tab: chỉ báo cho chủ phòng (chống gian lận mức nhẹ)
  r.post('/arena/matches/:id/visibility', { action: 'arena.play', rate: [{ name: 'arena_vis', by: 'user', limit: 30, windowSec: 60 }], body: s.object({ hidden: s.boolean() }) }, (ctx) => {
    const { m, p } = asMember(ctx);
    db.run('UPDATE arena_players SET tab_hidden=? WHERE match_id=? AND user_id=?', ctx.body.hidden ? 1 : 0, m.id, p.user_id);
    return { ok: true };
  });

  return { tick };
}

/** Outbox consumer: XP sau trận qua sổ cái, idempotent theo (user, ref) và có trần XP. */
export function arenaFinishedHandler(db, clock, ledgerPost, xpFor) {
  return (p) => {
    const m = db.get('SELECT * FROM arena_matches WHERE id=?', p.matchId);
    if (!m || m.state !== 'FINISHED') return;
    const ps = db.all("SELECT * FROM arena_players WHERE match_id=? AND role='player' AND rank IS NOT NULL", m.id);
    for (const pl of ps) {
      if (!db.get('SELECT 1 FROM economy_accounts WHERE user_id=?', pl.user_id)) continue;
      const xp = xpFor({ correctCount: pl.correct_count, rank: pl.rank, players: ps.length });
      if (xp > 0) ledgerPost(db, clock, { tenantId: m.tenant_id, userId: pl.user_id, delta: xp, reason: 'arena', refType: 'arena_match', refId: m.id });
    }
  };
}
