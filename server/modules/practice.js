import { createHash, randomInt } from 'node:crypto';
import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { mulberry32, shuffle, PRNG_NAME } from '../lib/prng.js';
import { validateQuestionDraft } from './assessment.js';

const Q = s.object({ stem: s.string({ min: 3, max: 400 }), options: s.array(s.string({ min: 1, max: 200 }), { min: 2, max: 6 }), correctIndex: s.int({ min: 0, max: 5 }), explanationEn: s.string({ max: 600 }).optional() });
const BODY = s.object({ title: s.string({ min: 1, max: 80 }), questions: s.array(Q, { min: 1, max: 1000 }), fromAi: s.boolean().default(false) });

/**
 * Bộ đề luyện tập tự soạn (không chính thức): học sinh tự soạn cho mình, hoặc phụ huynh soạn cho con.
 * Câu hỏi thuộc bank='practice' của CHỦ BÀI (ownerId); người soạn (byId) được ghi vào audit.
 * Nội dung AI đã được người dùng xem lại → ghi approved_by = người soạn (DI-012).
 */
export function register(r, d) {
  const { db, clock, audit } = d;

  function create({ tenantId, ownerId, byId, requestId }, body) {
    body.questions.forEach((q) => validateQuestionDraft('mcq_single', { stem: q.stem, options: q.options }, { correctIndex: q.correctIndex }));
    const source = body.fromAi ? 'ai' : 'teacher';
    const seed = randomInt(0, 2 ** 32), rnd = mulberry32(`custom|${seed}|${ownerId}`);
    const vids = body.questions.map((q) => {
      const qid = uuidv7(), vid = uuidv7();
      db.run("INSERT INTO questions(id,tenant_id,created_by,bank,created_at) VALUES(?,?,?,'practice',?)", qid, tenantId, ownerId, clock.iso());
      db.run("INSERT INTO question_versions(id,tenant_id,question_id,version,type,body,answer_key,scoring,explanation_en,source,status,approved_by,published_at,created_at) VALUES(?,?,?,1,'mcq_single',?,?,?,?,?,'published',?,?,?)",
        vid, tenantId, qid, JSON.stringify({ stem: q.stem, options: q.options }), JSON.stringify({ correctIndex: q.correctIndex }), JSON.stringify({ points: 1 }), q.explanationEn ?? null, source, byId, clock.iso(), clock.iso());
      return vid;
    });
    const order = shuffle(vids, rnd), compId = uuidv7(), hash = createHash('sha256').update(vids.join(',')).digest('hex');
    db.run("INSERT INTO exam_compositions(id,tenant_id,created_by,kind,blueprint,seed,prng,bank_snapshot_hash,created_at) VALUES(?,?,?,'practice',?,?,?,?,?)", compId, tenantId, ownerId, JSON.stringify({ custom: true, count: order.length, seed, ai: !!body.fromAi }), seed, PRNG_NAME, hash, clock.iso());
    order.forEach((vid, i) => db.run('INSERT INTO exam_composition_items(composition_id,position,question_version_id,option_order) VALUES(?,?,?,NULL)', compId, i, vid));
    const aid = uuidv7();
    db.run("INSERT INTO assessments(id,tenant_id,class_id,composition_id,title,kind,duration_min,max_attempts,show_answers,created_by,created_at) VALUES(?,?,NULL,?,?,'practice',?,20,1,?,?)", aid, tenantId, compId, body.title, Math.max(5, Math.ceil(order.length * 0.75)), ownerId, clock.iso());
    audit.write({ tenantId, actorId: byId, action: 'practice.custom_create', targetType: 'assessment', targetId: aid, diff: { items: order.length, ai: !!body.fromAi, forOther: ownerId !== byId }, requestId });
    return { assessmentId: aid, items: order.length, official: false };
  }

  r.post('/me/practice/custom', { action: 'practice.compose', idem: true, rate: [{ name: 'practice_custom', by: 'user', limit: 20, windowSec: 3600 }], body: BODY },
    (ctx) => db.tx(() => ({ status: 201, __raw: true, data: create({ tenantId: ctx.actor.tenantId, ownerId: ctx.user.id, byId: ctx.user.id, requestId: ctx.requestId }, ctx.body) })));

  const loadLink = (ctx) => {
    const l = db.get("SELECT * FROM guardian_links WHERE guardian_id=? AND learner_id=? AND status='active'", ctx.user.id, ctx.params.id);
    if (!l) throw err('NOT_FOUND');
    if (l.tenant_id !== ctx.actor.tenantId) throw err('TENANT_MISMATCH', { messageKey: 'error.SWITCH_TENANT', params: { tenantId: l.tenant_id } });
    return { tenantId: l.tenant_id, ownerId: l.learner_id, hideExistence: true, row: l };
  };
  r.post('/guardian/children/:id/practice/custom', { action: 'guardian.manage_child', resource: loadLink, idem: true, rate: [{ name: 'practice_custom_g', by: 'user', limit: 20, windowSec: 3600 }], body: BODY },
    (ctx) => db.tx(() => ({ status: 201, __raw: true, data: create({ tenantId: ctx.resource.tenantId, ownerId: ctx.resource.ownerId, byId: ctx.user.id, requestId: ctx.requestId }, ctx.body) })));
  return {};
}
