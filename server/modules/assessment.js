import { createHash } from 'node:crypto';
import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { mulberry32, shuffle, PRNG_NAME, seedFrom } from '../lib/prng.js';
import { gradeAttempt, GRADER_VERSION } from './grading.js';
import { ledgerPost, wallet } from './economy.js';
import { notify } from './common.js';
import { randomInt } from 'node:crypto';

const TYPES = ['mcq_single', 'fill_blank', 'matching'];
const CEFRS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

export const BLUEPRINT = s.object({
  total: s.int({ min: 1, max: 100 }), durationMin: s.int({ min: 1, max: 300 }),
  types: s.object({ mcq_single: s.int({ min: 0, max: 100 }).default(0), fill_blank: s.int({ min: 0, max: 100 }).default(0), matching: s.int({ min: 0, max: 100 }).default(0) }),
  cefr: s.object(Object.fromEntries(CEFRS.map((c) => [c, s.number({ min: 0, max: 1 }).optional()]))).optional(),
  topics: s.array(s.string({ min: 1, max: 30 }), { max: 20 }).optional(),
  targetDifficulty: s.array(s.number({ min: 0, max: 1 }), { min: 2, max: 2 }).optional(),
  excludeRecentDays: s.int({ min: 0, max: 365 }).optional(), seed: s.int({ min: 0, max: 2 ** 32 - 1 }).nullable().optional(),
});

/** Kiểm schema nháp câu hỏi: thiếu trường hoặc đáp án mơ hồ → từ chối. */
export function validateQuestionDraft(type, body, answerKey) {
  const bad = (code, path) => err('VALIDATION_ERROR', { details: [{ path, code }] });
  const str = (x, n = 500) => typeof x === 'string' && x.trim().length > 0 && x.length <= n;
  if (type === 'mcq_single') {
    if (!str(body.stem)) throw bad('required', 'body.stem');
    if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 6 || !body.options.every((o) => str(o, 200))) throw bad('options.invalid', 'body.options');
    const norm = body.options.map((o) => o.trim().toLowerCase());
    if (new Set(norm).size !== norm.length) throw bad('options.duplicate', 'body.options'); // đáp án mơ hồ
    if (!Number.isInteger(answerKey.correctIndex) || answerKey.correctIndex < 0 || answerKey.correctIndex >= body.options.length) throw bad('correctIndex.invalid', 'answerKey.correctIndex');
  } else if (type === 'fill_blank') {
    if (!str(body.stem) || !body.stem.includes('___')) throw bad('stem.needs_blank', 'body.stem');
    if (!Array.isArray(answerKey.accepted) || !answerKey.accepted.length || answerKey.accepted.length > 10 || !answerKey.accepted.every((x) => str(x, 100))) throw bad('accepted.invalid', 'answerKey.accepted');
  } else if (type === 'matching') {
    const { left, right } = body;
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length < 2 || left.length > 8 || ![...left, ...right].every((x) => str(x, 120))) throw bad('matching.invalid', 'body');
    if (new Set(left.map((x) => x.toLowerCase())).size !== left.length || new Set(right.map((x) => x.toLowerCase())).size !== right.length) throw bad('matching.duplicate', 'body');
    // quy ước: left[i] ↔ right[i]
    answerKey.pairs = left.map((_, i) => [i, i]);
  } else throw bad('type.invalid', 'type');
}

const bandOf = (n) => n;

export function register(r, d) {
  const { db, clock, config, audit } = d;
  const L = (x) => x; // placeholder

  // ================= Ngân hàng câu hỏi =================
  const qvView = (v, withKey = true) => ({ id: v.id, questionId: v.question_id, version: v.version, type: v.type, body: JSON.parse(v.body), ...(withKey ? { answerKey: JSON.parse(v.answer_key) } : {}), cefr: v.cefr, topic: v.topic, explanationEn: v.explanation_en, explanationVi: v.explanation_vi, source: v.source, status: v.status, createdAt: v.created_at });

  const QDRAFT = s.object({
    type: s.enum(TYPES), body: s.json({ maxBytes: 4000 }), answerKey: s.json({ maxBytes: 2000 }).default({}),
    cefr: s.enum(CEFRS).optional(), topic: s.string({ max: 30 }).optional(), targetSenseId: s.uuid().optional(),
    explanationEn: s.string({ max: 600 }).optional(), explanationVi: s.string({ max: 600 }).optional(),
  });

  r.post('/teacher/questions', { action: 'question.manage', body: QDRAFT, idem: true }, (ctx) => db.tx(() => {
    const b = ctx.body;
    validateQuestionDraft(b.type, b.body, b.answerKey);
    const qid = uuidv7(), vid = uuidv7();
    db.run("INSERT INTO questions(id,tenant_id,created_by,bank,created_at) VALUES(?,?,?,'official',?)", qid, ctx.actor.tenantId, ctx.user.id, clock.iso());
    db.run("INSERT INTO question_versions(id,tenant_id,question_id,version,type,body,answer_key,scoring,cefr,topic,target_sense_id,explanation_en,explanation_vi,source,status,created_at) VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,'teacher','draft',?)",
      vid, ctx.actor.tenantId, qid, b.type, JSON.stringify(b.body), JSON.stringify(b.answerKey), JSON.stringify({ points: 1 }), b.cefr ?? null, b.topic ?? null, b.targetSenseId ?? null, b.explanationEn ?? null, b.explanationVi ?? null, clock.iso());
    return { status: 201, __raw: true, data: qvView(db.get('SELECT * FROM question_versions WHERE id=?', vid)) };
  }));

  const loadQv = (ctx) => {
    const v = db.get('SELECT qv.*, q.created_by FROM question_versions qv JOIN questions q ON q.id=qv.question_id WHERE qv.id=?', ctx.params.vid);
    if (!v) throw err('NOT_FOUND');
    return { tenantId: v.tenant_id, createdBy: v.created_by, state: v.status, hideExistence: true, row: v };
  };

  r.get('/teacher/questions', { action: 'question.manage', query: s.object({ status: s.enum(['draft', 'in_review', 'approved', 'published', 'retired']).optional(), type: s.enum(TYPES).optional() }, { strict: false }) }, (ctx) => {
    const w = ['qv.tenant_id=?', "q.bank='official'"], p = [ctx.actor.tenantId];
    if (ctx.query.status) { w.push('qv.status=?'); p.push(ctx.query.status); }
    if (ctx.query.type) { w.push('qv.type=?'); p.push(ctx.query.type); }
    return { questions: db.all(`SELECT qv.* FROM question_versions qv JOIN questions q ON q.id=qv.question_id WHERE ${w.join(' AND ')} ORDER BY qv.created_at DESC LIMIT 200`, ...p).map((v) => qvView(v)) };
  });

  // sửa nháp (published bất biến → tạo version mới)
  r.patch('/teacher/question-versions/:vid', { action: 'question.manage', resource: loadQv, body: QDRAFT.optional ? s.object({ body: s.json({ maxBytes: 4000 }).optional(), answerKey: s.json({ maxBytes: 2000 }).optional(), cefr: s.enum(CEFRS).optional(), topic: s.string({ max: 30 }).optional(), explanationEn: s.string({ max: 600 }).optional(), explanationVi: s.string({ max: 600 }).optional() }) : null }, (ctx) => {
    const v = ctx.resource.row;
    if (!['draft', 'in_review'].includes(v.status)) throw err('INVALID_STATE_TRANSITION', { messageKey: 'error.PUBLISHED_IMMUTABLE' });
    const body = ctx.body.body ?? JSON.parse(v.body), key = ctx.body.answerKey ?? JSON.parse(v.answer_key);
    validateQuestionDraft(v.type, body, key);
    db.run("UPDATE question_versions SET body=?, answer_key=?, cefr=COALESCE(?,cefr), topic=COALESCE(?,topic), explanation_en=COALESCE(?,explanation_en), explanation_vi=COALESCE(?,explanation_vi), status='draft' WHERE id=?",
      JSON.stringify(body), JSON.stringify(key), ctx.body.cefr ?? null, ctx.body.topic ?? null, ctx.body.explanationEn ?? null, ctx.body.explanationVi ?? null, v.id);
    return qvView(db.get('SELECT * FROM question_versions WHERE id=?', v.id));
  });

  r.post('/teacher/question-versions/:vid/new-version', { action: 'question.manage', resource: loadQv, idem: true }, (ctx) => db.tx(() => {
    const v = ctx.resource.row;
    const next = db.get('SELECT MAX(version)+1 AS n FROM question_versions WHERE question_id=?', v.question_id).n;
    const id = uuidv7();
    db.run("INSERT INTO question_versions(id,tenant_id,question_id,version,type,body,answer_key,scoring,cefr,topic,target_sense_id,explanation_en,explanation_vi,source,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'teacher','draft',?)",
      id, v.tenant_id, v.question_id, next, v.type, v.body, v.answer_key, v.scoring, v.cefr, v.topic, v.target_sense_id, v.explanation_en, v.explanation_vi, clock.iso());
    return { status: 201, __raw: true, data: qvView(db.get('SELECT * FROM question_versions WHERE id=?', id)) };
  }));

  const OTHER_APPROVERS = (tenantId, userId) => db.get("SELECT COUNT(*) AS n FROM memberships m JOIN teacher_verifications t ON t.user_id=m.user_id AND t.state='APPROVED' WHERE m.tenant_id=? AND m.role='teacher' AND m.status='active' AND m.user_id<>?", tenantId, userId).n > 0;

  r.post('/teacher/question-versions/:vid/transition', { action: 'question.manage', resource: loadQv, body: s.object({ to: s.enum(['in_review', 'approved', 'published', 'retired', 'draft']) }) }, (ctx) => db.tx(() => {
    const v = ctx.resource.row, to = ctx.body.to;
    if (to === 'approved' || to === 'published') {
      // duyệt/xuất bản cần quyền question.approve; nếu tổ chức có giáo viên khác đã duyệt, không tự duyệt câu của chính mình
      ctx.authorize('question.approve', { tenantId: v.tenant_id, createdBy: v.created_by }, { requireOtherApprover: OTHER_APPROVERS(v.tenant_id, ctx.user.id) });
    }
    let n;
    if (to === 'approved') n = db.run("UPDATE question_versions SET status='approved', approved_by=? WHERE id=? AND status='in_review'", ctx.user.id, v.id).changes;
    else if (to === 'published') n = db.run("UPDATE question_versions SET status='published', published_at=? WHERE id=? AND status='approved'", clock.iso(), v.id).changes;
    else if (to === 'retired') n = db.run("UPDATE question_versions SET status='retired', retired_at=? WHERE id=? AND status IN ('published','draft')", clock.iso(), v.id).changes;
    else n = db.run('UPDATE question_versions SET status=? WHERE id=? AND status=?', to, v.id, to === 'in_review' ? 'draft' : 'in_review').changes;
    if (n !== 1) throw err('INVALID_STATE_TRANSITION', { params: { from: v.status, to } });
    audit.write({ tenantId: v.tenant_id, actorId: ctx.user.id, action: `question.${to}`, targetType: 'question_version', targetId: v.id, diff: { from: v.status, to }, requestId: ctx.requestId });
    return qvView(db.get('SELECT * FROM question_versions WHERE id=?', v.id));
  }));

  // ================= Dựng đề (S6b) =================
  const itemStats = (tenantId) => {
    const m = new Map();
    for (const row of db.all(`SELECT eci.question_version_id AS id, COUNT(*) AS n, SUM(CASE WHEN json_extract(g.per_item, '$[' || ai.composition_position || '].correct') = 1 THEN 1 ELSE 0 END) AS ok
      FROM attempt_items ai JOIN attempts a ON a.id=ai.attempt_id AND a.state='GRADED' JOIN grading_results g ON g.attempt_id=a.id
      JOIN exam_composition_items eci ON eci.composition_id=a.composition_id AND eci.position=ai.composition_position WHERE a.tenant_id=? GROUP BY eci.question_version_id`, tenantId)) m.set(row.id, { n: row.n, p: row.n ? row.ok / row.n : null });
    return m;
  };

  /** Rút câu bằng PRNG xác định + seed lưu lại: cùng seed + cùng bank_snapshot_hash → cùng đề (DI-017). */
  function composeExam({ tenantId, createdBy, kind, blueprint, classId = null, bank = 'official' }) {
    const bp = { ...blueprint };
    const sumTypes = TYPES.reduce((x, t) => x + (bp.types[t] || 0), 0);
    if (sumTypes !== bp.total) throw err('VALIDATION_ERROR', { details: [{ path: 'types', code: 'types_sum_mismatch', params: { sum: sumTypes, total: bp.total } }] });
    const seed = bp.seed ?? randomInt(0, 2 ** 32);
    bp.seed = seed;
    let pool = db.all("SELECT qv.* FROM question_versions qv JOIN questions q ON q.id=qv.question_id WHERE qv.tenant_id=? AND qv.status='published' AND q.bank=? ORDER BY qv.id", tenantId, bank);
    if (bp.topics?.length) pool = pool.filter((q) => q.topic && bp.topics.includes(q.topic));
    if (bp.excludeRecentDays && classId) {
      const since = new Date(clock.ms() - bp.excludeRecentDays * 86400e3).toISOString();
      const recent = new Set(db.all('SELECT eci.question_version_id AS id FROM assessments a JOIN exam_composition_items eci ON eci.composition_id=a.composition_id WHERE a.class_id=? AND a.created_at>=?', classId, since).map((x) => x.id));
      pool = pool.filter((q) => !recent.has(q.id));
    }
    if (bp.targetDifficulty) {
      const stats = itemStats(tenantId), [lo, hi] = bp.targetDifficulty;
      pool = pool.filter((q) => { const st = stats.get(q.id); return !st || st.n < 30 || (st.p >= lo && st.p <= hi); }); // chưa đủ dữ liệu → không loại
    }
    const hash = createHash('sha256').update(pool.map((q) => q.id).join(',')).digest('hex');
    const rnd = mulberry32(`${seed}|${hash}`);
    const picked = [], shortages = [], used = new Set();
    for (const type of TYPES) {
      const need = bp.types[type] || 0;
      if (!need) continue;
      const ofType = pool.filter((q) => q.type === type);
      // phân bổ theo CEFR (largest remainder); không đủ → báo thiếu, KHÔNG âm thầm hạ tiêu chuẩn
      let buckets = [{ cefr: null, n: need }];
      if (bp.cefr) {
        const entries = Object.entries(bp.cefr).filter(([, v]) => v > 0);
        const tot = entries.reduce((x, [, v]) => x + v, 0) || 1;
        const raw = entries.map(([c, v]) => ({ cefr: c, exact: (need * v) / tot }));
        buckets = raw.map((x) => ({ cefr: x.cefr, n: Math.floor(x.exact), rem: x.exact - Math.floor(x.exact) }));
        let left = need - buckets.reduce((x, b) => x + b.n, 0);
        [...buckets].sort((a, b) => b.rem - a.rem || (a.cefr < b.cefr ? -1 : 1)).forEach((b) => { if (left > 0) { b.n += 1; left -= 1; } });
      }
      for (const b of buckets) {
        if (!b.n) continue;
        const cands = shuffle(ofType.filter((q) => (b.cefr ? q.cefr === b.cefr : true) && !used.has(q.id)), rnd);
        if (cands.length < b.n) shortages.push({ type, cefr: b.cefr, need: b.n, have: cands.length });
        cands.slice(0, b.n).forEach((q) => { used.add(q.id); picked.push(q); });
      }
    }
    if (shortages.length) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.BANK_SHORTAGE', details: shortages });
    const ordered = shuffle(picked, rnd);
    // cân bằng vị trí đáp án đúng cho MCQ: vị trí mục tiêu lấy vòng tròn từ hoán vị
    const slotCycle = {}; let mcqIdx = 0;
    const optOrders = ordered.map((q) => {
      if (q.type === 'mcq_single') {
        const body = JSON.parse(q.body), key = JSON.parse(q.answer_key), m = body.options.length;
        if (!slotCycle[m] || mcqIdx % m === 0) slotCycle[m] = shuffle([...Array(m).keys()], rnd);
        const slot = slotCycle[m][mcqIdx % m]; mcqIdx++;
        const others = shuffle([...Array(m).keys()].filter((i) => i !== key.correctIndex), rnd);
        const order = []; let o = 0;
        for (let i = 0; i < m; i++) order.push(i === slot ? key.correctIndex : others[o++]);
        return order;
      }
      if (q.type === 'matching') return shuffle([...Array(JSON.parse(q.body).right.length).keys()], rnd);
      return null;
    });
    const id = uuidv7();
    db.run('INSERT INTO exam_compositions(id,tenant_id,created_by,kind,blueprint,seed,prng,bank_snapshot_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, tenantId, createdBy, kind, JSON.stringify(bp), seed, PRNG_NAME, hash, clock.iso());
    ordered.forEach((q, i) => db.run('INSERT INTO exam_composition_items(composition_id,position,question_version_id,option_order) VALUES(?,?,?,?)', id, i, q.id, optOrders[i] ? JSON.stringify(optOrders[i]) : null));
    return { id, seed, hash, items: ordered.length };
  }

  const compView = (id) => {
    const c = db.get('SELECT * FROM exam_compositions WHERE id=?', id);
    const items = db.all('SELECT eci.position, eci.option_order, qv.* FROM exam_composition_items eci JOIN question_versions qv ON qv.id=eci.question_version_id WHERE eci.composition_id=? ORDER BY eci.position', id);
    return { id, kind: c.kind, seed: c.seed, bankSnapshotHash: c.bank_snapshot_hash, prng: c.prng, blueprint: JSON.parse(c.blueprint), items: items.map((i) => ({ position: i.position, optionOrder: i.option_order ? JSON.parse(i.option_order) : null, ...qvView(i) })) };
  };

  r.post('/teacher/exams/compose', { action: 'exam.compose', body: s.object({ blueprint: BLUEPRINT, classId: s.uuid().optional() }), idem: true, rate: [{ name: 'compose', by: 'user', limit: 30, windowSec: 3600 }] }, (ctx) => db.tx(() => {
    if (ctx.body.classId && !db.get("SELECT 1 FROM classes WHERE id=? AND teacher_id=? AND tenant_id=?", ctx.body.classId, ctx.user.id, ctx.actor.tenantId)) throw err('NOT_FOUND');
    const c = composeExam({ tenantId: ctx.actor.tenantId, createdBy: ctx.user.id, kind: 'official', blueprint: ctx.body.blueprint, classId: ctx.body.classId });
    return { status: 201, __raw: true, data: compView(c.id) };
  }));

  // ================= Bài thi / giao đề =================
  const loadClass = (ctx) => {
    const c = db.get('SELECT * FROM classes WHERE id=?', ctx.params.id);
    if (!c) throw err('NOT_FOUND');
    return { tenantId: c.tenant_id, classId: c.id, hideExistence: true, row: c };
  };
  r.post('/teacher/classes/:id/assessments', {
    action: 'assessment.manage', resource: loadClass, idem: true,
    body: s.object({ title: s.string({ min: 1, max: 80 }), blueprint: BLUEPRINT, opensAt: s.iso().optional(), closesAt: s.iso().optional(), maxAttempts: s.int({ min: 1, max: 20 }).default(1), showAnswers: s.boolean().default(true) }),
  }, (ctx) => db.tx(() => {
    const c = ctx.resource.row, b = ctx.body;
    const comp = composeExam({ tenantId: c.tenant_id, createdBy: ctx.user.id, kind: 'official', blueprint: b.blueprint, classId: c.id });
    const id = uuidv7();
    db.run("INSERT INTO assessments(id,tenant_id,class_id,composition_id,title,kind,opens_at,closes_at,duration_min,max_attempts,show_answers,created_by,created_at) VALUES(?,?,?,?,?,'official',?,?,?,?,?,?,?)",
      id, c.tenant_id, c.id, comp.id, b.title, b.opensAt ?? null, b.closesAt ?? null, b.blueprint.durationMin, b.maxAttempts, b.showAnswers ? 1 : 0, ctx.user.id, clock.iso());
    for (const m of db.all("SELECT user_id FROM class_members WHERE class_id=? AND status='active' AND role='learner'", c.id)) notify(db, clock, { tenantId: c.tenant_id, userId: m.user_id, kind: 'assessment_new', params: { title: b.title, closesAt: b.closesAt ?? null } });
    audit.write({ tenantId: c.tenant_id, actorId: ctx.user.id, action: 'assessment.create', targetType: 'assessment', targetId: id, diff: { compositionId: comp.id, seed: comp.seed }, requestId: ctx.requestId });
    return { status: 201, __raw: true, data: { id, compositionId: comp.id, seed: comp.seed, bankSnapshotHash: comp.hash, itemCount: comp.items } };
  }));

  r.get('/teacher/classes/:id/assessments', { action: 'class.read', resource: loadClass }, (ctx) => ({
    assessments: db.all(`SELECT a.id,a.title,a.opens_at AS opensAt,a.closes_at AS closesAt,a.duration_min AS durationMin,a.max_attempts AS maxAttempts,a.status,
      (SELECT COUNT(*) FROM attempts t WHERE t.assessment_id=a.id AND t.state='GRADED') AS graded,
      (SELECT ROUND(AVG(g.score*100.0/g.max_score),1) FROM attempts t JOIN grading_results g ON g.attempt_id=t.id WHERE t.assessment_id=a.id) AS avgPct
      FROM assessments a WHERE a.class_id=? AND a.kind='official' ORDER BY a.created_at DESC`, ctx.params.id),
  }));

  const loadAssessment = (ctx) => {
    const a = db.get('SELECT * FROM assessments WHERE id=?', ctx.params.id);
    if (!a) throw err('NOT_FOUND');
    return { tenantId: a.tenant_id, classId: a.class_id, ownerId: a.kind === 'practice' ? a.created_by : undefined, hideExistence: true, row: a };
  };

  r.get('/teacher/assessments/:id/results', { action: 'assessment.manage', resource: loadAssessment }, (ctx) => {
    const a = ctx.resource.row;
    return {
      assessment: { id: a.id, title: a.title },
      rows: db.all(`SELECT u.id AS userId, u.display_name AS displayName, t.id AS attemptId, t.attempt_no AS attemptNo, t.state, t.submitted_at AS submittedAt, t.tab_blur_count AS tabBlur, g.score, g.max_score AS maxScore
        FROM attempts t JOIN users u ON u.id=t.user_id LEFT JOIN grading_results g ON g.attempt_id=t.id WHERE t.assessment_id=? ORDER BY u.display_name, t.attempt_no`, a.id),
    };
  });

  /** Item analysis (B6.1): chỉ khi ≥ 30 phản hồi/câu; gắn cờ KHÔNG tự sửa; kèm cỡ mẫu. */
  r.get('/teacher/assessments/:id/analysis', { action: 'assessment.manage', resource: loadAssessment }, (ctx) => {
    const a = ctx.resource.row;
    const att = db.all("SELECT t.id, g.per_item, g.score FROM attempts t JOIN grading_results g ON g.attempt_id=t.id WHERE t.assessment_id=? AND t.state='GRADED'", a.id).map((x) => ({ id: x.id, per: JSON.parse(x.per_item), total: x.per_item ? JSON.parse(x.per_item).reduce((s2, p) => s2 + p.earned, 0) : 0 }));
    const items = db.all('SELECT eci.position, qv.id, qv.type, qv.body, qv.answer_key FROM exam_composition_items eci JOIN question_versions qv ON qv.id=eci.question_version_id WHERE eci.composition_id=? ORDER BY eci.position', a.composition_id);
    const out = items.map((it) => {
      const n = att.length;
      const base = { position: it.position, questionVersionId: it.id, type: it.type, n };
      if (n < 30) return { ...base, insufficientData: true, minSample: 30 };
      const xs = att.map((t) => t.per[it.position].earned / t.per[it.position].max), tot = att.map((t) => t.total);
      const p = xs.reduce((x, y) => x + y, 0) / n;
      const mean = tot.reduce((x, y) => x + y, 0) / n, sd = Math.sqrt(tot.reduce((x, y) => x + (y - mean) ** 2, 0) / n);
      const m1 = tot.filter((_, i) => xs[i] >= 1), m0 = tot.filter((_, i) => xs[i] < 1);
      const pb = sd > 0 && m1.length && m0.length ? ((m1.reduce((x, y) => x + y, 0) / m1.length - m0.reduce((x, y) => x + y, 0) / m0.length) / sd) * Math.sqrt((m1.length / n) * (m0.length / n)) : null;
      const flags = [];
      if (p < 0.15) flags.push('too_hard'); if (p > 0.95) flags.push('too_easy'); if (pb !== null && pb < 0.1) flags.push('low_discrimination');
      let distractors = null;
      if (it.type === 'mcq_single') {
        const opts = JSON.parse(it.body).options.length, counts = Array(opts).fill(0);
        for (const t of att) { const row = db.get('SELECT answer FROM attempt_items WHERE attempt_id=? AND composition_position=?', t.id, it.position); const ci = db.get('SELECT option_order FROM exam_composition_items WHERE composition_id=? AND position=?', a.composition_id, it.position); const ord = JSON.parse(ci.option_order || 'null'); if (row?.answer != null) { const shown = JSON.parse(row.answer); const orig = ord ? ord[shown] : shown; if (orig >= 0 && orig < opts) counts[orig]++; } }
        distractors = counts.map((c, i) => ({ option: i, rate: Math.round((c / n) * 1000) / 1000, correct: i === JSON.parse(it.answer_key).correctIndex }));
        if (distractors.some((x) => !x.correct && x.rate < 0.02)) flags.push('weak_distractor');
      }
      return { ...base, p: Math.round(p * 1000) / 1000, pointBiserial: pb === null ? null : Math.round(pb * 1000) / 1000, distractors, flags, note: 'flags_are_signals_not_verdicts' };
    });
    return { assessmentId: a.id, attempts: att.length, items: out };
  });

  // ================= Luyện tập tự dựng từ kho cá nhân (không chính thức) =================
  r.post('/me/practice/compose', {
    action: 'practice.compose', idem: true, rate: [{ name: 'practice', by: 'user', limit: 20, windowSec: 3600 }],
    body: s.object({ collectionId: s.uuid(), count: s.int({ min: 3, max: 30 }).default(10), seed: s.int({ min: 0, max: 2 ** 32 - 1 }).optional() }),
  }, (ctx) => db.tx(() => {
    const col = db.get("SELECT * FROM learner_collections WHERE id=? AND owner_id=? AND tenant_id=?", ctx.body.collectionId, ctx.user.id, ctx.actor.tenantId);
    if (!col) throw err('NOT_FOUND');
    const senses = db.all(`SELECT s.id, s.pos, s.definition_vi, s.definition_en, s.example_en, l.lemma, l.cefr FROM collection_items ci JOIN senses s ON s.id=ci.sense_id JOIN lexemes l ON l.id=s.lexeme_id WHERE ci.collection_id=? AND ci.removed_at IS NULL ORDER BY s.id`, col.id);
    if (senses.length < 4) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.NEED_MORE_WORDS', params: { min: 4 } });
    const seed = ctx.body.seed ?? randomInt(0, 2 ** 32), rnd = mulberry32(`practice|${seed}|${col.id}`);
    const pool = db.all("SELECT s.id, s.pos, s.definition_vi, l.lemma FROM senses s JOIN lexemes l ON l.id=s.lexeme_id WHERE s.status='published' AND s.owner_tenant_id IS NULL ORDER BY s.id");
    const chosen = shuffle(senses, rnd).slice(0, ctx.body.count);
    const mkQ = (type, body, key, sense) => {
      const qid = uuidv7(), vid = uuidv7();
      db.run("INSERT INTO questions(id,tenant_id,created_by,bank,created_at) VALUES(?,?,?,'practice',?)", qid, ctx.actor.tenantId, ctx.user.id, clock.iso());
      db.run("INSERT INTO question_versions(id,tenant_id,question_id,version,type,body,answer_key,scoring,cefr,target_sense_id,explanation_en,explanation_vi,source,status,published_at,created_at) VALUES(?,?,?,1,?,?,?,?,?,?,?,?, 'generated','published',?,?)",
        vid, ctx.actor.tenantId, qid, type, JSON.stringify(body), JSON.stringify(key), JSON.stringify({ points: 1 }), sense.cefr, sense.id, sense.definition_en, sense.definition_vi, clock.iso(), clock.iso());
      return vid;
    };
    const vids = [];
    const matchBatch = [];
    for (const sense of chosen) {
      const hasBlank = sense.example_en && new RegExp(`\\b${sense.lemma.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sense.example_en);
      const roll = rnd();
      if (hasBlank && roll < 0.35) {
        vids.push(mkQ('fill_blank', { stem: sense.example_en.replace(new RegExp(`\\b${sense.lemma.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), '___'), hint: sense.definition_vi }, { accepted: [sense.lemma] }, sense));
      } else if (roll < 0.8 || chosen.length < 4) {
        const wrong = shuffle(pool.filter((p) => p.id !== sense.id && p.definition_vi !== sense.definition_vi), rnd).slice(0, 3);
        const options = shuffle([sense.definition_vi, ...wrong.map((w) => w.definition_vi)], rnd);
        vids.push(mkQ('mcq_single', { stem: sense.lemma, options }, { correctIndex: options.indexOf(sense.definition_vi) }, sense));
      } else matchBatch.push(sense);
    }
    while (matchBatch.length >= 3) {
      const grp = matchBatch.splice(0, Math.min(4, matchBatch.length));
      vids.push(mkQ('matching', { left: grp.map((g) => g.lemma), right: grp.map((g) => g.definition_vi) }, { pairs: grp.map((_, i) => [i, i]) }, grp[0]));
    }
    matchBatch.forEach((sense) => { const wrong = shuffle(pool.filter((p) => p.id !== sense.id), rnd).slice(0, 3); const options = shuffle([sense.definition_vi, ...wrong.map((w) => w.definition_vi)], rnd); vids.push(mkQ('mcq_single', { stem: sense.lemma, options }, { correctIndex: options.indexOf(sense.definition_vi) }, sense)); });
    const compId = uuidv7(), hash = createHash('sha256').update(vids.join(',')).digest('hex');
    const order = shuffle(vids, rnd);
    db.run("INSERT INTO exam_compositions(id,tenant_id,created_by,kind,blueprint,seed,prng,bank_snapshot_hash,created_at) VALUES(?,?,?,'practice',?,?,?,?,?)", compId, ctx.actor.tenantId, ctx.user.id, JSON.stringify({ collectionId: col.id, count: order.length, seed }), seed, PRNG_NAME, hash, clock.iso());
    order.forEach((vid, i) => {
      const v = db.get('SELECT type, body FROM question_versions WHERE id=?', vid);
      const b = JSON.parse(v.body);
      const oo = v.type === 'matching' ? shuffle([...Array(b.right.length).keys()], rnd) : null;
      db.run('INSERT INTO exam_composition_items(composition_id,position,question_version_id,option_order) VALUES(?,?,?,?)', compId, i, vid, oo ? JSON.stringify(oo) : null);
    });
    const aid = uuidv7();
    db.run("INSERT INTO assessments(id,tenant_id,class_id,composition_id,title,kind,duration_min,max_attempts,show_answers,created_by,created_at) VALUES(?,?,NULL,?,?,'practice',?,20,1,?,?)", aid, ctx.actor.tenantId, compId, col.title, Math.max(5, Math.ceil(order.length * 0.75)), ctx.user.id, clock.iso());
    return { status: 201, __raw: true, data: { assessmentId: aid, items: order.length, official: false } };
  }));

  // ================= Attempt =================
  const attemptItemsView = (a, comp, showKeys) => {
    const rows = db.all('SELECT ai.position, ai.composition_position AS cpos, ai.answer FROM attempt_items ai WHERE ai.attempt_id=? ORDER BY ai.position', a.id);
    return rows.map((row) => {
      const it = db.get('SELECT eci.option_order, qv.* FROM exam_composition_items eci JOIN question_versions qv ON qv.id=eci.question_version_id WHERE eci.composition_id=? AND eci.position=?', a.composition_id, row.cpos);
      const body = JSON.parse(it.body), oo = it.option_order ? JSON.parse(it.option_order) : null;
      const view = { position: row.position, type: it.type, answer: row.answer == null ? null : JSON.parse(row.answer) };
      if (it.type === 'mcq_single') { view.stem = body.stem; view.options = oo ? oo.map((i) => body.options[i]) : body.options; }
      else if (it.type === 'fill_blank') { view.stem = body.stem; view.hint = body.hint ?? null; }
      else { view.left = body.left; view.right = oo ? oo.map((i) => body.right[i]) : body.right; }
      if (showKeys) {
        const key = JSON.parse(it.answer_key);
        view.explanationEn = it.explanation_en; view.explanationVi = it.explanation_vi;
        if (it.type === 'mcq_single') view.correctShownIndex = oo ? oo.indexOf(key.correctIndex) : key.correctIndex;
        else if (it.type === 'fill_blank') view.accepted = key.accepted;
        else view.correctShown = key.pairs.map(([l, rr]) => [l, oo ? oo.indexOf(rr) : rr]);
      }
      return view;
    });
  };

  const snapshotItems = (a) => db.all('SELECT eci.position, eci.option_order, qv.type, qv.answer_key, qv.scoring FROM exam_composition_items eci JOIN question_versions qv ON qv.id=eci.question_version_id WHERE eci.composition_id=? ORDER BY eci.position', a.composition_id)
    .map((x) => ({ type: x.type, answerKey: JSON.parse(x.answer_key), points: JSON.parse(x.scoring).points, optionOrder: x.option_order ? JSON.parse(x.option_order) : null }));

  /** SUBMITTED → GRADING → GRADED bằng UPDATE có điều kiện; chấm = hàm thuần trên snapshot đã chụp. */
  function gradeNow(a) {
    return db.tx(() => {
      const cur = db.get('SELECT state FROM attempts WHERE id=?', a.id);
      if (cur.state === 'GRADED') return false;
      if (db.run("UPDATE attempts SET state='GRADING' WHERE id=? AND state IN ('SUBMITTED','GRADING_FAILED')", a.id).changes !== 1) throw err('INVALID_STATE_TRANSITION');
      const snap = snapshotItems(a);
      const rows = db.all('SELECT position, composition_position AS cpos, answer FROM attempt_items WHERE attempt_id=? ORDER BY position', a.id);
      const answers = Array(snap.length).fill(null);
      for (const row of rows) answers[row.cpos] = row.answer == null ? null : JSON.parse(row.answer);
      const res = gradeAttempt(snap, answers);
      db.run('INSERT INTO grading_results(attempt_id,score,max_score,per_item,grader_version,graded_at) VALUES(?,?,?,?,?,?)', a.id, res.score, res.max, JSON.stringify(res.perItem), GRADER_VERSION, clock.iso());
      if (db.run("UPDATE attempts SET state='GRADED' WHERE id=? AND state='GRADING'", a.id).changes !== 1) throw err('INVALID_STATE_TRANSITION');
      const asm = db.get('SELECT kind FROM assessments WHERE id=?', a.assessment_id);
      if (res.max > 0) ledgerPost(db, clock, { tenantId: a.tenant_id, userId: a.user_id, delta: Math.max(1, Math.round((res.score / res.max) * (asm.kind === 'official' ? 20 : 10))), reason: 'attempt_graded', refType: 'attempt', refId: a.id });
      audit.write({ tenantId: a.tenant_id, actorId: null, action: 'attempt.graded', targetType: 'attempt', targetId: a.id, diff: { grader: GRADER_VERSION }, requestId: null });
      return true;
    });
  }

  /** Hết hạn lười + job nền: IN_PROGRESS quá deadline+grace → EXPIRED → SUBMITTED → chấm phần đã lưu. */
  function expireIfNeeded(a) {
    if (a.state !== 'IN_PROGRESS' || !a.deadline_at) return a;
    if (clock.ms() <= Date.parse(a.deadline_at) + config.graceSeconds * 1000) return a;
    db.tx(() => {
      db.run("UPDATE attempts SET state='EXPIRED' WHERE id=? AND state='IN_PROGRESS'", a.id);
      db.run("UPDATE attempts SET state='SUBMITTED', submitted_at=? WHERE id=? AND state='EXPIRED'", clock.iso(), a.id);
    });
    gradeNow(a);
    return db.get('SELECT * FROM attempts WHERE id=?', a.id);
  }
  d.expireAttempts = () => {
    let n = 0;
    for (const a of db.all("SELECT * FROM attempts WHERE state='IN_PROGRESS' AND deadline_at<?", new Date(clock.ms() - config.graceSeconds * 1000).toISOString())) { expireIfNeeded(a); n++; }
    for (const a of db.all("SELECT * FROM attempts WHERE state IN ('SUBMITTED','GRADING_FAILED')")) { try { gradeNow(a); n++; } catch { /* thử lại ở lượt sau */ } }
    return n;
  };

  const attemptView = (a, asm) => {
    const base = { id: a.id, assessmentId: a.assessment_id, title: asm.title, kind: asm.kind, state: a.state, attemptNo: a.attempt_no, startedAt: a.started_at, deadlineAt: a.deadline_at, serverNow: clock.iso(), durationMin: asm.duration_min };
    const graded = a.state === 'GRADED';
    const out = { ...base };
    if (['IN_PROGRESS', 'CREATED'].includes(a.state)) out.items = attemptItemsView(a, null, false);
    if (graded) {
      const g = db.get('SELECT * FROM grading_results WHERE attempt_id=?', a.id);
      out.result = { score: g.score, maxScore: g.max_score, percent: g.max_score ? Math.round((g.score / g.max_score) * 100) : 0, gradedAt: g.graded_at };
      if (asm.show_answers || asm.kind === 'practice') { out.items = attemptItemsView(a, null, true); out.perItem = JSON.parse(g.per_item).map((p, i) => ({ ...p })); }
      out.wallet = undefined;
    }
    return out;
  };

  r.get('/me/assessments', { action: 'assignment.mine' }, (ctx) => {
    const now = clock.iso();
    const rows = db.all(`SELECT a.id,a.title,a.kind,a.opens_at AS opensAt,a.closes_at AS closesAt,a.duration_min AS durationMin,a.max_attempts AS maxAttempts,c.name AS className
      FROM assessments a JOIN class_members m ON m.class_id=a.class_id AND m.user_id=? AND m.status='active' JOIN classes c ON c.id=a.class_id WHERE a.status='published' AND a.kind='official' ORDER BY a.created_at DESC LIMIT 50`, ctx.user.id);
    const practice = db.all("SELECT a.id,a.title,a.kind,a.duration_min AS durationMin,a.max_attempts AS maxAttempts, NULL AS className, NULL AS opensAt, NULL AS closesAt FROM assessments a WHERE a.kind='practice' AND a.created_by=? ORDER BY a.created_at DESC LIMIT 20", ctx.user.id);
    return { assessments: [...rows, ...practice].map((x) => {
      const att = db.all('SELECT t.id,t.state,t.attempt_no AS attemptNo,g.score,g.max_score AS maxScore FROM attempts t LEFT JOIN grading_results g ON g.attempt_id=t.id WHERE t.assessment_id=? AND t.user_id=? ORDER BY t.attempt_no', x.id, ctx.user.id);
      const status = x.opensAt && now < x.opensAt ? 'not_open' : x.closesAt && now > x.closesAt ? 'closed' : 'open';
      return { ...x, status, attempts: att };
    }) };
  });

  r.post('/assessments/:id/attempts', { action: 'attempt.start', resource: loadAssessment, idem: true, rate: [{ name: 'attempt-start', by: 'user', limit: 20, windowSec: 3600 }] }, (ctx) => db.tx(() => {
    const asm = ctx.resource.row, uid = ctx.user.id, now = clock.ms();
    if (asm.status !== 'published') throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ASSESSMENT_CLOSED' });
    if (asm.opens_at && now < Date.parse(asm.opens_at)) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ASSESSMENT_NOT_OPEN' });
    if (asm.closes_at && now > Date.parse(asm.closes_at)) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ASSESSMENT_CLOSED' });
    const open = db.get("SELECT * FROM attempts WHERE user_id=? AND assessment_id=? AND state IN ('CREATED','IN_PROGRESS')", uid, asm.id);
    if (open) { const a = expireIfNeeded(open); if (a.state === 'IN_PROGRESS') return attemptView(a, asm); }
    const used = db.get("SELECT COUNT(*) AS n FROM attempts WHERE user_id=? AND assessment_id=? AND state NOT IN ('CANCELLED','INVALIDATED')", uid, asm.id).n;
    if (used >= asm.max_attempts) throw err('ATTEMPT_LIMIT_REACHED', { params: { max: asm.max_attempts } });
    const no = db.get('SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM attempts WHERE user_id=? AND assessment_id=?', uid, asm.id).n;
    const id = uuidv7(), orderSeed = randomInt(0, 2 ** 32);
    let deadline = now + asm.duration_min * 60000;
    if (asm.closes_at) deadline = Math.min(deadline, Date.parse(asm.closes_at));
    db.run("INSERT INTO attempts(id,tenant_id,user_id,assessment_id,composition_id,attempt_no,state,order_seed,created_at) VALUES(?,?,?,?,?,?,'CREATED',?,?)", id, asm.tenant_id, uid, asm.id, asm.composition_id, no, orderSeed, clock.iso());
    const n = db.get('SELECT COUNT(*) AS n FROM exam_composition_items WHERE composition_id=?', asm.composition_id).n;
    shuffle([...Array(n).keys()], mulberry32(orderSeed)).forEach((cpos, i) => db.run('INSERT INTO attempt_items(attempt_id,position,composition_position) VALUES(?,?,?)', id, i, cpos));
    if (db.run("UPDATE attempts SET state='IN_PROGRESS', started_at=?, deadline_at=? WHERE id=? AND state='CREATED'", clock.iso(), new Date(deadline).toISOString(), id).changes !== 1) throw err('INVALID_STATE_TRANSITION');
    return { status: 201, __raw: true, data: attemptView(db.get('SELECT * FROM attempts WHERE id=?', id), asm) };
  }));

  const loadAttempt = (ctx) => {
    const a = db.get('SELECT t.*, s.class_id FROM attempts t JOIN assessments s ON s.id=t.assessment_id WHERE t.id=?', ctx.params.id);
    if (!a) throw err('NOT_FOUND');
    return { tenantId: a.tenant_id, ownerId: a.user_id, classId: a.class_id || undefined, state: a.state, hideExistence: true, row: a };
  };
  // Policy 'attempt.act' chỉ cho IN_PROGRESS/EXPIRED; đọc kết quả dùng 'attempt.read' (mọi trạng thái)
  r.get('/attempts/:id', { action: 'attempt.read', resource: loadAttempt }, (ctx) => {
    let a = ctx.resource.row;
    const asm = db.get('SELECT * FROM assessments WHERE id=?', a.assessment_id);
    if (a.user_id === ctx.user.id) a = expireIfNeeded(db.get('SELECT * FROM attempts WHERE id=?', a.id));
    else a = db.get('SELECT * FROM attempts WHERE id=?', a.id);
    const v = attemptView(a, asm);
    if (a.user_id !== ctx.user.id) { delete v.items; } // giáo viên xem kết quả tổng hợp ở /results
    return v;
  });

  r.put('/attempts/:id/answers/:position', {
    action: 'attempt.act', resource: loadAttempt, rate: [{ name: 'answer', by: (c) => `attempt:${c.params.id}`, limit: 60, windowSec: 60 }],
    body: s.object({ answer: s.json({ maxBytes: 600 }).nullable() }),
  }, (ctx) => db.tx(() => {
    let a = db.get('SELECT * FROM attempts WHERE id=?', ctx.params.id);
    a = expireIfNeeded(a);
    if (a.state !== 'IN_PROGRESS') throw err('INVALID_STATE_TRANSITION', { messageKey: 'error.ATTEMPT_NOT_OPEN', params: { state: a.state } });
    if (clock.ms() > Date.parse(a.deadline_at) + config.graceSeconds * 1000) throw err('INVALID_STATE_TRANSITION', { messageKey: 'error.ATTEMPT_EXPIRED' });
    const pos = Number(ctx.params.position);
    const row = db.get('SELECT composition_position AS cpos FROM attempt_items WHERE attempt_id=? AND position=?', a.id, pos);
    if (!row) throw err('NOT_FOUND');
    const it = db.get('SELECT qv.type, qv.body FROM exam_composition_items eci JOIN question_versions qv ON qv.id=eci.question_version_id WHERE eci.composition_id=? AND eci.position=?', a.composition_id, row.cpos);
    const ans = ctx.body.answer, body = JSON.parse(it.body);
    if (ans !== null) {
      if (it.type === 'mcq_single' && !(Number.isInteger(ans) && ans >= 0 && ans < body.options.length)) throw err('VALIDATION_ERROR', { details: [{ path: 'answer', code: 'invalid' }] });
      if (it.type === 'fill_blank' && !(typeof ans === 'string' && ans.length <= 100)) throw err('VALIDATION_ERROR', { details: [{ path: 'answer', code: 'invalid' }] });
      if (it.type === 'matching' && !(Array.isArray(ans) && ans.length === body.left.length && ans.every((x) => x === null || (Number.isInteger(x) && x >= 0 && x < body.right.length)))) throw err('VALIDATION_ERROR', { details: [{ path: 'answer', code: 'invalid' }] });
    }
    db.run('UPDATE attempt_items SET answer=?, answered_at=? WHERE attempt_id=? AND position=?', ans === null ? null : JSON.stringify(ans), clock.iso(), a.id, pos);
    return { saved: true, serverNow: clock.iso() };
  }));

  r.post('/attempts/:id/blur', { action: 'attempt.act', resource: loadAttempt }, (ctx) => {
    db.run("UPDATE attempts SET tab_blur_count=tab_blur_count+1 WHERE id=? AND state='IN_PROGRESS'", ctx.params.id); // tín hiệu cho giáo viên, không tự trừ điểm
    return { ok: true };
  });

  r.post('/attempts/:id/submit', { action: 'attempt.read', resource: loadAttempt, idem: true }, (ctx) => {
    let a = db.get('SELECT * FROM attempts WHERE id=?', ctx.params.id);
    if (a.user_id !== ctx.user.id) throw err('NOT_FOUND');
    const asm = db.get('SELECT * FROM assessments WHERE id=?', a.assessment_id);
    a = expireIfNeeded(a);
    if (a.state === 'IN_PROGRESS') {
      db.tx(() => {
        if (db.run("UPDATE attempts SET state='SUBMITTED', submitted_at=? WHERE id=? AND state='IN_PROGRESS'", clock.iso(), a.id).changes !== 1) throw err('INVALID_STATE_TRANSITION');
      });
      gradeNow(db.get('SELECT * FROM attempts WHERE id=?', a.id));
    } else if (['SUBMITTED', 'GRADING_FAILED'].includes(a.state)) gradeNow(a);
    else if (a.state !== 'GRADED') throw err('INVALID_STATE_TRANSITION');
    const out = attemptView(db.get('SELECT * FROM attempts WHERE id=?', a.id), asm);
    return { ...out, wallet: wallet(db, ctx.user.id) };
  });

  r.post('/teacher/attempts/:id/invalidate', { action: 'assessment.manage', resource: (ctx) => { const x = loadAttempt(ctx); return { ...x, ownerId: undefined }; }, body: s.object({ reason: s.string({ min: 1, max: 200 }) }) }, (ctx) => {
    const a = ctx.resource.row;
    if (db.run("UPDATE attempts SET state='INVALIDATED' WHERE id=? AND state IN ('IN_PROGRESS','EXPIRED','SUBMITTED','GRADING')", a.id).changes !== 1) throw err('INVALID_STATE_TRANSITION');
    audit.write({ tenantId: a.tenant_id, actorId: ctx.user.id, action: 'attempt.invalidate', targetType: 'attempt', targetId: a.id, diff: { reasonLen: ctx.body.reason.length }, requestId: ctx.requestId });
    return { invalidated: true };
  });
}
