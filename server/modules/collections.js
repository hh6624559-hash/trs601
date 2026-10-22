import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { SENSE_COLS, senseView, GOALS } from './vocab.js';
import { notify } from './common.js';
import { normVi } from '../lib/norm.js';

const MAX_COLLECTIONS = 50, MAX_ITEMS = 2000; // GIẢ THUYẾT (BASELINE_PENDING) – B5.2

export function register(r, d) {
  const { db, clock, audit } = d;

  const loadCol = (ctx) => {
    const c = db.get('SELECT * FROM learner_collections WHERE id=?', ctx.params.id);
    if (!c) throw err('NOT_FOUND');
    return { tenantId: c.tenant_id, ownerId: c.owner_id, state: c.status, hideExistence: true, row: c };
  };
  const ifMatch = (ctx, col) => {
    const h = ctx.headers['if-match'];
    if (!h) throw err('PRECONDITION_REQUIRED');
    if (h.replace(/^W\//, '').replace(/"/g, '') !== String(col.version)) throw err('PRECONDITION_FAILED', { messageKey: 'error.VERSION_MISMATCH', params: { current: col.version } });
  };
  const view = (c) => ({ id: c.id, title: c.title, source: c.source, locked: !!c.locked, visibility: c.visibility, status: c.status, topic: c.topic, version: c.version, assignmentId: c.assignment_id, createdAt: c.created_at, updatedAt: c.updated_at });
  const bump = (id) => db.run('UPDATE learner_collections SET version=version+1, updated_at=? WHERE id=?', clock.iso(), id);
  const counts = (id) => db.get('SELECT COUNT(*) AS total, SUM(CASE WHEN removed_at IS NULL THEN 1 ELSE 0 END) AS active FROM collection_items WHERE collection_id=?', id);

  /** Từ nhiều nguồn → danh sách sense hợp lệ (đã publish, của hệ thống hoặc của tổ chức). */
  function resolveSenses(tenantId, { senseIds = [], lemmas = [], csv, fromTopic, cefr, limit = 40 }) {
    const ids = new Set(), unknown = [];
    const okSense = (id) => db.get("SELECT s.id FROM senses s WHERE s.id=? AND s.status='published' AND (s.owner_tenant_id IS NULL OR s.owner_tenant_id=?)", id, tenantId);
    for (const id of senseIds) { if (okSense(id)) ids.add(id); else unknown.push(id); }
    const words = [...lemmas];
    if (csv) for (const line of csv.split(/\r?\n/)) { const w = line.split(/[,;\t]/)[0].trim(); if (w) words.push(w); }
    for (const w of words.slice(0, 500)) {
      const row = db.get("SELECT s.id FROM senses s JOIN lexemes l ON l.id=s.lexeme_id WHERE l.lemma_norm=? AND s.status='published' AND (s.owner_tenant_id IS NULL OR s.owner_tenant_id=?) ORDER BY s.owner_tenant_id IS NULL LIMIT 1", normVi(w), tenantId);
      if (row) ids.add(row.id); else unknown.push(w);
    }
    if (fromTopic) {
      const rows = db.all(`SELECT s.id FROM sense_topics t JOIN senses s ON s.id=t.sense_id JOIN lexemes l ON l.id=s.lexeme_id
        WHERE t.topic=? AND s.status='published' AND s.owner_tenant_id IS NULL ${cefr ? 'AND l.cefr=?' : ''} ORDER BY l.cefr, l.lemma LIMIT ?`, ...(cefr ? [fromTopic, cefr, limit] : [fromTopic, limit]));
      rows.forEach((x) => ids.add(x.id));
    }
    return { ids: [...ids], unknown };
  }
  const addItems = (tenantId, colId, ids) => {
    let pos = db.get('SELECT COALESCE(MAX(position),0) AS m FROM collection_items WHERE collection_id=?', colId).m;
    let added = 0;
    for (const id of ids) {
      const ex = db.get('SELECT removed_at FROM collection_items WHERE collection_id=? AND sense_id=?', colId, id);
      if (!ex) { db.run('INSERT INTO collection_items(tenant_id,collection_id,sense_id,position,added_at) VALUES(?,?,?,?,?)', tenantId, colId, id, ++pos, clock.iso()); added++; }
      else if (ex.removed_at) { db.run('UPDATE collection_items SET removed_at=NULL WHERE collection_id=? AND sense_id=?', colId, id); added++; }
    }
    return added;
  };

  const SRC = { senseIds: s.array(s.uuid(), { max: 500 }).optional(), lemmas: s.array(s.string({ min: 1, max: 40 }), { max: 500 }).optional(), csv: s.string({ max: 20000 }).optional() };

  r.get('/me/collections', { action: 'collection.list' }, (ctx) => {
    const rows = db.all("SELECT * FROM learner_collections WHERE owner_id=? ORDER BY locked DESC, status='archived', updated_at DESC", ctx.user.id);
    return { collections: rows.map((c) => ({ ...view(c), items: counts(c.id).active || 0 })) };
  });

  r.post('/me/collections', {
    action: 'collection.create', idem: true,
    body: s.object({ title: s.string({ min: 1, max: 80 }), topic: s.string({ max: 30 }).optional(), fromTopic: s.string({ max: 30 }).optional(), cefr: s.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']).optional(), limit: s.int({ min: 1, max: 200 }).optional(), ...SRC }),
  }, (ctx) => db.tx(() => {
    const n = db.get("SELECT COUNT(*) AS n FROM learner_collections WHERE owner_id=? AND status IN ('active','paused') AND source IN ('self','system')", ctx.user.id).n;
    if (n >= MAX_COLLECTIONS) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.COLLECTION_LIMIT', params: { max: MAX_COLLECTIONS } });
    const { ids, unknown } = resolveSenses(ctx.actor.tenantId, ctx.body);
    if (ids.length > MAX_ITEMS) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ITEM_LIMIT', params: { max: MAX_ITEMS } });
    const id = uuidv7(), now = clock.iso();
    db.run("INSERT INTO learner_collections(id,tenant_id,owner_id,title,source,locked,topic,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?,?)", id, ctx.actor.tenantId, ctx.user.id, ctx.body.title, ctx.body.fromTopic ? 'system' : 'self', ctx.body.topic || ctx.body.fromTopic || null, now, now);
    const added = addItems(ctx.actor.tenantId, id, ids);
    audit.write({ tenantId: ctx.actor.tenantId, actorId: ctx.user.id, action: 'collection.create', targetType: 'collection', targetId: id, diff: { items: added }, requestId: ctx.requestId });
    return { status: 201, __raw: true, data: { ...view(db.get('SELECT * FROM learner_collections WHERE id=?', id)), items: added, unknown }, headers: { ETag: '"1"' } };
  }));

  r.get('/me/collections/:id', { action: 'collection.read', resource: loadCol }, (ctx) => {
    const c = ctx.resource.row;
    const items = db.all(`SELECT ${SENSE_COLS}, ci.position, ci.removed_at, ci.note, st.state AS learnState, st.leech FROM collection_items ci JOIN senses s ON s.id=ci.sense_id JOIN lexemes l ON l.id=s.lexeme_id
      LEFT JOIN learner_sense_state st ON st.sense_id=s.id AND st.user_id=? WHERE ci.collection_id=? ORDER BY ci.removed_at IS NOT NULL, ci.position`, c.owner_id, c.id);
    return { __raw: true, status: 200, headers: { ETag: `"${c.version}"` }, data: { ...view(c), items: items.map((i) => ({ ...senseView(i), position: i.position, removed: !!i.removed_at, learnState: i.learnState || 'new', leech: !!i.leech })) } };
  });

  r.patch('/me/collections/:id', {
    action: 'collection.write', resource: loadCol,
    body: s.object({ title: s.string({ min: 1, max: 80 }).optional(), status: s.enum(['active', 'paused', 'archived']).optional(), visibility: s.enum(['private', 'friends', 'class']).optional() }),
  }, (ctx) => db.tx(() => {
    const c = db.get('SELECT * FROM learner_collections WHERE id=?', ctx.params.id);
    ifMatch(ctx, c);
    const b = ctx.body;
    if (c.locked && (b.status && b.status !== 'active')) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.LOCKED_COLLECTION' }); // DI-018
    if (c.locked && (b.title || b.visibility)) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.LOCKED_COLLECTION' });
    if (b.visibility && b.visibility !== 'private' && c.source === 'teacher') throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.LOCKED_COLLECTION' });
    if (b.title) db.run('UPDATE learner_collections SET title=? WHERE id=?', b.title, c.id);
    if (b.status) db.run('UPDATE learner_collections SET status=? WHERE id=?', b.status, c.id);
    if (b.visibility) db.run('UPDATE learner_collections SET visibility=? WHERE id=?', b.visibility, c.id);
    bump(c.id);
    const now = db.get('SELECT * FROM learner_collections WHERE id=?', c.id);
    audit.write({ tenantId: c.tenant_id, actorId: ctx.user.id, action: 'collection.update', targetType: 'collection', targetId: c.id, diff: { fields: Object.keys(b) }, requestId: ctx.requestId });
    return { __raw: true, status: 200, headers: { ETag: `"${now.version}"` }, data: view(now) };
  }));

  r.post('/me/collections/:id/restore', { action: 'collection.restore', resource: loadCol, idem: true }, (ctx) => {
    db.run("UPDATE learner_collections SET status='active' WHERE id=? AND status='archived'", ctx.params.id); bump(ctx.params.id);
    return view(db.get('SELECT * FROM learner_collections WHERE id=?', ctx.params.id));
  });

  r.post('/me/collections/:id/items', { action: 'collection.write', resource: loadCol, idem: true, body: s.object({ ...SRC }) }, (ctx) => db.tx(() => {
    const c = db.get('SELECT * FROM learner_collections WHERE id=?', ctx.params.id);
    if (c.locked) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.LOCKED_COLLECTION' });
    const { ids, unknown } = resolveSenses(ctx.actor.tenantId, ctx.body);
    if ((counts(c.id).active || 0) + ids.length > MAX_ITEMS) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.ITEM_LIMIT', params: { max: MAX_ITEMS } });
    const added = addItems(ctx.actor.tenantId, c.id, ids);
    bump(c.id);
    return { added, unknown, version: c.version + 1 };
  }));

  r.delete('/me/collections/:id/items/:senseId', { action: 'collection.write', resource: loadCol }, (ctx) => {
    const c = ctx.resource.row;
    if (c.locked) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.LOCKED_COLLECTION' });
    const n = db.run('UPDATE collection_items SET removed_at=? WHERE collection_id=? AND sense_id=? AND removed_at IS NULL', clock.iso(), c.id, ctx.params.senseId).changes; // lưu trữ, KHÔNG xoá lịch sử ôn
    if (!n) throw err('NOT_FOUND');
    bump(c.id);
    return { removed: true, reviewHistoryKept: true };
  });
  r.post('/me/collections/:id/items/:senseId/restore', { action: 'collection.write', resource: loadCol }, (ctx) => {
    const n = db.run('UPDATE collection_items SET removed_at=NULL WHERE collection_id=? AND sense_id=? AND removed_at IS NOT NULL', ctx.params.id, ctx.params.senseId).changes;
    if (!n) throw err('NOT_FOUND');
    bump(ctx.params.id);
    return { restored: true };
  });

  // Học sinh «báo khó» với bài giao bắt buộc: không gỡ được, nhưng nhắn giáo viên
  r.post('/me/collections/:id/report-hard', { action: 'collection.report_hard', resource: loadCol, idem: true, body: s.object({ note: s.string({ max: 300 }).optional() }) }, (ctx) => {
    const c = ctx.resource.row;
    if (!c.locked) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.NOT_LOCKED' });
    db.tx(() => {
      db.run('INSERT INTO hard_reports(id,tenant_id,collection_id,user_id,note,created_at) VALUES(?,?,?,?,?,?)', uuidv7(), c.tenant_id, c.id, ctx.user.id, ctx.body.note ?? null, clock.iso());
      const a = db.get('SELECT created_by, title FROM assignments WHERE id=?', c.assignment_id);
      if (a) db.run('INSERT INTO notifications(id,tenant_id,user_id,kind,params,created_at) VALUES(?,?,?,?,?,?)', uuidv7(), c.tenant_id, a.created_by, 'assignment_hard', JSON.stringify({ assignment: a.title, collectionId: c.id, studentId: ctx.user.id }), clock.iso());
    });
    return { reported: true };
  });

  // ---- La Bàn Mục Tiêu (F11) + lộ trình (R6) ----
  r.get('/me/compass', { action: 'collection.list', query: s.object({ goal: s.enum(Object.keys(GOALS)).optional() }, { strict: false }) }, (ctx) => {
    const goal = ctx.query.goal;
    const topics = goal ? GOALS[goal] : [...new Set(Object.values(GOALS).flat())];
    return { goals: Object.keys(GOALS), suggestions: topics.map((t) => ({ topic: t, count: db.get('SELECT COUNT(*) AS n FROM sense_topics WHERE topic=?', t).n, sample: db.all('SELECT l.lemma FROM sense_topics t JOIN senses s ON s.id=t.sense_id JOIN lexemes l ON l.id=s.lexeme_id WHERE t.topic=? ORDER BY l.cefr, l.lemma LIMIT 5', t).map((x) => x.lemma) })) };
  });

  const pathView = (p) => ({ id: p.id, name: p.name, goal: p.goal, status: p.status, steps: db.all('SELECT position,collection_id AS collectionId,status,replaced_by_position AS replacedBy, (SELECT title FROM learner_collections c WHERE c.id=collection_id) AS title FROM learning_path_steps WHERE path_id=? ORDER BY position', p.id) });
  r.get('/me/paths', { action: 'collection.list' }, (ctx) => ({ paths: db.all("SELECT * FROM learning_paths WHERE user_id=? AND status='active' ORDER BY created_at", ctx.user.id).map(pathView) }));
  r.post('/me/paths', { action: 'path.manage', idem: true, body: s.object({ name: s.string({ min: 1, max: 80 }), goal: s.string({ max: 30 }).optional(), collectionIds: s.array(s.uuid(), { min: 1, max: 20 }) }) }, (ctx) => db.tx(() => {
    for (const cid of ctx.body.collectionIds) if (!db.get('SELECT 1 FROM learner_collections WHERE id=? AND owner_id=? AND tenant_id=?', cid, ctx.user.id, ctx.actor.tenantId)) throw err('NOT_FOUND');
    const id = uuidv7();
    db.run('INSERT INTO learning_paths(id,tenant_id,user_id,name,goal,created_at) VALUES(?,?,?,?,?,?)', id, ctx.actor.tenantId, ctx.user.id, ctx.body.name, ctx.body.goal ?? null, clock.iso());
    ctx.body.collectionIds.forEach((cid, i) => db.run('INSERT INTO learning_path_steps(tenant_id,path_id,position,collection_id,status) VALUES(?,?,?,?,?)', ctx.actor.tenantId, id, i + 1, cid, i === 0 ? 'active' : 'planned'));
    return { status: 201, __raw: true, data: pathView(db.get('SELECT * FROM learning_paths WHERE id=?', id)) };
  }));
  const loadPath = (ctx) => {
    const p = db.get('SELECT * FROM learning_paths WHERE id=?', ctx.params.id);
    if (!p) throw err('NOT_FOUND');
    return { tenantId: p.tenant_id, ownerId: p.user_id, hideExistence: true };
  };
  // Thay bài: bước cũ -> replaced (tiến độ giữ nguyên, không tính «bỏ dở»)
  r.put('/me/paths/:id/steps/:pos/replace', { action: 'path.manage', resource: loadPath, idem: true, body: s.object({ collectionId: s.uuid() }) }, (ctx) => db.tx(() => {
    const step = db.get('SELECT * FROM learning_path_steps WHERE path_id=? AND position=?', ctx.params.id, Number(ctx.params.pos));
    if (!step || step.status === 'replaced' || step.status === 'done') throw err('NOT_FOUND');
    const oldCol = db.get('SELECT locked FROM learner_collections WHERE id=?', step.collection_id);
    if (oldCol?.locked) throw err('BUSINESS_RULE_VIOLATION', { messageKey: 'error.LOCKED_COLLECTION' });
    if (!db.get('SELECT 1 FROM learner_collections WHERE id=? AND owner_id=? AND tenant_id=?', ctx.body.collectionId, ctx.user.id, ctx.actor.tenantId)) throw err('NOT_FOUND');
    const next = db.get('SELECT MAX(position)+1 AS p FROM learning_path_steps WHERE path_id=?', ctx.params.id).p;
    db.run('INSERT INTO learning_path_steps(tenant_id,path_id,position,collection_id,status) VALUES(?,?,?,?,?)', ctx.actor.tenantId, ctx.params.id, next, ctx.body.collectionId, step.status);
    db.run("UPDATE learning_path_steps SET status='replaced', replaced_by_position=? WHERE path_id=? AND position=?", next, ctx.params.id, step.position);
    return pathView(db.get('SELECT * FROM learning_paths WHERE id=?', ctx.params.id));
  }));
  r.post('/me/paths/:id/steps/:pos/status', { action: 'path.manage', resource: loadPath, body: s.object({ status: s.enum(['active', 'paused', 'done']) }) }, (ctx) => {
    const n = db.run("UPDATE learning_path_steps SET status=? WHERE path_id=? AND position=? AND status<>'replaced'", ctx.body.status, ctx.params.id, Number(ctx.params.pos)).changes;
    if (!n) throw err('NOT_FOUND');
    return pathView(db.get('SELECT * FROM learning_paths WHERE id=?', ctx.params.id));
  });

  // Nhóm trò chơi dựng từ kho cá nhân (R2): luyện tập, không phải kết quả chính thức
  r.get('/me/games/pool', { action: 'collection.list', query: s.object({ size: s.string({ max: 3 }).default('8') }, { strict: false }) }, (ctx) => {
    const size = Math.min(Math.max(parseInt(ctx.query.size, 10) || 8, 4), 20);
    const rows = db.all(`SELECT DISTINCT ${SENSE_COLS} FROM collection_items ci JOIN learner_collections c ON c.id=ci.collection_id JOIN senses s ON s.id=ci.sense_id JOIN lexemes l ON l.id=s.lexeme_id
      WHERE c.owner_id=? AND c.status='active' AND ci.removed_at IS NULL ORDER BY random() LIMIT ?`, ctx.user.id, size);
    const distractors = db.all(`SELECT l.lemma, s.definition_vi FROM senses s JOIN lexemes l ON l.id=s.lexeme_id WHERE s.status='published' AND s.owner_tenant_id IS NULL ORDER BY random() LIMIT 12`);
    return { items: rows.map(senseView), distractors, official: false };
  });
}
