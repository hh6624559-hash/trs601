import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { normVi, escapeLike } from '../lib/norm.js';

export const senseView = (r) => ({ senseId: r.id, lemma: r.lemma, pos: r.pos, cefr: r.cefr, ipa: r.ipa, definitionEn: r.definition_en, definitionVi: r.definition_vi, exampleEn: r.example_en, exampleVi: r.example_vi });

export const SENSE_COLS = 's.id, l.lemma, l.cefr, s.pos, s.ipa, s.definition_en, s.definition_vi, s.example_en, s.example_vi';

export const GOALS = {
  exam: ['school', 'academic'], conversation: ['daily', 'family', 'food'], travel: ['travel', 'food', 'daily'], academic: ['academic', 'school', 'technology'], kids_fun: ['animals', 'food', 'nature', 'hobbies'], work: ['work', 'technology', 'academic'],
};

export function register(r, d) {
  const { db } = d;
  r.get('/vocab/topics', { action: 'vocab.read' }, () => ({
    topics: db.all('SELECT t.topic, COUNT(*) AS n FROM sense_topics t JOIN senses s ON s.id=t.sense_id WHERE s.status=\'published\' AND s.owner_tenant_id IS NULL GROUP BY t.topic ORDER BY n DESC'),
    goals: Object.entries(GOALS).map(([goal, topics]) => ({ goal, topics })),
  }));

  r.get('/vocab/search', {
    action: 'vocab.read',
    query: s.object({ q: s.string({ max: 60 }).default(''), cefr: s.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']).optional(), topic: s.string({ max: 30 }).optional(), limit: s.string({ max: 3 }).default('25'), cursor: s.string({ max: 20 }).optional() }, { strict: false }),
  }, (ctx) => {
    const q = normVi(ctx.query.q);
    const limit = Math.min(Math.max(parseInt(ctx.query.limit, 10) || 25, 1), 100);
    const offset = Math.max(parseInt(ctx.query.cursor || '0', 10) || 0, 0);
    const like = `%${escapeLike(q)}%`, pre = `${escapeLike(q)}%`;
    const where = ["s.status='published'", '(s.owner_tenant_id IS NULL OR s.owner_tenant_id = ?)'];
    const params = [ctx.actor.tenantId];
    if (q) { where.push("(l.lemma_norm LIKE ? ESCAPE '\\' OR s.definition_vi_norm LIKE ? ESCAPE '\\')"); params.push(like, like); }
    if (ctx.query.cefr) { where.push('l.cefr=?'); params.push(ctx.query.cefr); }
    if (ctx.query.topic) { where.push('EXISTS (SELECT 1 FROM sense_topics t WHERE t.sense_id=s.id AND t.topic=?)'); params.push(ctx.query.topic); }
    const rows = db.all(`SELECT ${SENSE_COLS},
        CASE WHEN l.lemma_norm = ? THEN 0 WHEN l.lemma_norm LIKE ? ESCAPE '\\' THEN 1 WHEN l.lemma_norm LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END AS rank
      FROM senses s JOIN lexemes l ON l.id=s.lexeme_id WHERE ${where.join(' AND ')}
      ORDER BY rank, l.lemma_norm, s.id LIMIT ? OFFSET ?`, q, pre, like, ...params, limit + 1, offset);
    const more = rows.length > limit;
    return { items: rows.slice(0, limit).map(senseView), nextCursor: more ? String(offset + limit) : null };
  });

  r.get('/vocab/senses/:id', {
    action: 'vocab.read',
    resource: (ctx) => ({}),
  }, (ctx) => {
    const row = db.get(`SELECT ${SENSE_COLS}, s.owner_tenant_id FROM senses s JOIN lexemes l ON l.id=s.lexeme_id WHERE s.id=? AND s.status='published'`, ctx.params.id);
    if (!row || (row.owner_tenant_id && row.owner_tenant_id !== ctx.actor.tenantId)) throw err('NOT_FOUND');
    return { ...senseView(row), topics: db.all('SELECT topic FROM sense_topics WHERE sense_id=?', row.id).map((t) => t.topic) };
  });
}
