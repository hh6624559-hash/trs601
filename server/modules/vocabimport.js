import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { normVi } from '../lib/norm.js';
import { parseVocab, MAX_ROWS } from '../lib/vocabparse.js';

const BODY = s.object({ text: s.string({ min: 1, max: 400000, trim: false }) });

export function register(r, d) {
  const { db, clock, audit } = d;
  const summary = (p) => ({ count: p.rows.length, sample: p.rows.slice(0, 8), errors: p.errors.slice(0, 50), errorCount: p.errors.length, delimiter: p.delimiter === '\t' ? 'tab' : p.delimiter, hasHeader: p.hasHeader, maxRows: MAX_ROWS });

  // Xem trước: không ghi gì.
  r.post('/teacher/vocab/preview', { action: 'vocab.import', body: BODY, rate: [{ name: 'vocab_preview', by: 'user', limit: 60, windowSec: 3600 }] }, (ctx) => summary(parseVocab(ctx.body.text)));

  r.post('/teacher/vocab/import', {
    action: 'vocab.import', idem: true, rate: [{ name: 'vocab_import', by: 'user', limit: 20, windowSec: 3600 }],
    body: s.object({ name: s.string({ min: 1, max: 80 }), text: s.string({ min: 1, max: 400000, trim: false }), attestation: s.boolean() }),
  }, (ctx) => db.tx(() => {
    if (!ctx.body.attestation) throw err('VALIDATION_ERROR', { details: [{ path: 'attestation', code: 'required' }] });
    const tid = ctx.actor.tenantId, p = parseVocab(ctx.body.text);
    if (!p.rows.length) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.VOCAB_EMPTY', details: p.errors.slice(0, 20) });
    const listId = uuidv7();
    db.run("INSERT INTO sources(id,name,license,url) VALUES(?,?,'user-supplied',NULL)", listId, `Import: ${ctx.body.name}`.slice(0, 100));
    db.run('INSERT INTO vocab_lists(id,tenant_id,name,created_by,item_count,created_at) VALUES(?,?,?,?,0,?)', listId, tid, ctx.body.name, ctx.user.id, clock.iso());
    let pos = 0, created = 0, reused = 0;
    for (const w of p.rows) {
      let lex = db.get("SELECT id FROM lexemes WHERE lang='en' AND lemma=?", w.lemma);
      if (!lex) { lex = { id: uuidv7() }; db.run("INSERT INTO lexemes(id,lemma,lemma_norm,lang,cefr,source_id,license) VALUES(?,?,?,'en',?,?,'user-supplied')", lex.id, w.lemma, normVi(w.lemma), w.cefr, listId); }
      let sense = db.get('SELECT id FROM senses WHERE lexeme_id=? AND owner_tenant_id=? AND pos=?', lex.id, tid, w.pos);
      if (sense) {
        db.run('UPDATE senses SET ipa=COALESCE(NULLIF(?,\'\'),ipa), definition_en=COALESCE(NULLIF(?,\'\'),definition_en), definition_vi=COALESCE(NULLIF(?,\'\'),definition_vi), definition_vi_norm=COALESCE(NULLIF(?,\'\'),definition_vi_norm), example_en=COALESCE(NULLIF(?,\'\'),example_en), example_vi=COALESCE(NULLIF(?,\'\'),example_vi) WHERE id=?',
          w.ipa, w.definitionEn, w.definitionVi, w.definitionVi ? normVi(w.definitionVi) : '', w.exampleEn, w.exampleVi, sense.id);
        reused++;
      } else {
        sense = { id: uuidv7() };
        db.run("INSERT INTO senses(id,lexeme_id,owner_tenant_id,pos,ipa,definition_en,definition_vi,definition_vi_norm,example_en,example_vi,status) VALUES(?,?,?,?,?,?,?,?,?,?,'published')",
          sense.id, lex.id, tid, w.pos, w.ipa || null, w.definitionEn, w.definitionVi || null, w.definitionVi ? normVi(w.definitionVi) : null, w.exampleEn || null, w.exampleVi || null);
        created++;
      }
      for (const t of w.topics) db.run('INSERT OR IGNORE INTO sense_topics(sense_id,topic) VALUES(?,?)', sense.id, t);
      db.run('INSERT OR IGNORE INTO vocab_list_items(list_id,sense_id,position) VALUES(?,?,?)', listId, sense.id, ++pos);
    }
    db.run('UPDATE vocab_lists SET item_count=? WHERE id=?', pos, listId);
    audit.write({ tenantId: tid, actorId: ctx.user.id, action: 'vocab.import', targetType: 'vocab_list', targetId: listId, diff: { words: pos, created, reused, skipped: p.errors.length }, requestId: ctx.requestId });
    return { status: 201, __raw: true, data: { list: { id: listId, name: ctx.body.name, count: pos }, created, reused, skipped: p.errors.slice(0, 50), skippedCount: p.errors.length } };
  }));

  r.get('/teacher/vocab/lists', { action: 'vocab.import' }, (ctx) => ({
    lists: db.all('SELECT id,name,item_count AS count,created_at AS createdAt FROM vocab_lists WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100', ctx.actor.tenantId),
  }));

  r.get('/teacher/vocab/lists/:id', { action: 'vocab.import', resource: (ctx) => {
    const l = db.get('SELECT * FROM vocab_lists WHERE id=?', ctx.params.id);
    if (!l) throw err('NOT_FOUND');
    return { tenantId: l.tenant_id, hideExistence: true, row: l };
  } }, (ctx) => ({
    list: { id: ctx.resource.row.id, name: ctx.resource.row.name, count: ctx.resource.row.item_count },
    items: db.all(`SELECT s.id AS senseId, l.lemma, s.pos, s.definition_vi AS definitionVi, s.definition_en AS definitionEn, s.example_en AS exampleEn
      FROM vocab_list_items i JOIN senses s ON s.id=i.sense_id JOIN lexemes l ON l.id=s.lexeme_id WHERE i.list_id=? ORDER BY i.position LIMIT 1000`, ctx.params.id),
  }));
  return {};
}
