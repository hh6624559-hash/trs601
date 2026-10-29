import { createHash } from 'node:crypto';
import { uuidv7 } from './ids.js';

const PII_KEYS = new Set(['email', 'birth_ym', 'password', 'password_hash', 'display_name', 'username', 'body', 'pin', 'token', 'bio']);

/** Audit chỉ chứa tên trường + ID; PII/nội dung tin nhắn không bao giờ lọt vào (B2.5). */
export function assertNoPii(diff) {
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (PII_KEYS.has(k)) throw new Error(`audit diff chứa khoá PII: ${k}`);
      walk(v);
    }
  };
  walk(diff);
}

export function makeAudit(db, clock) {
  return {
    write({ tenantId = null, actorId = null, action, targetType = null, targetId = null, diff = null, requestId = null }) {
      if (diff) assertNoPii(diff);
      db.run('INSERT INTO audit_logs(id,tenant_id,actor_id,action,target_type,target_id,diff,request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        uuidv7(), tenantId, actorId, action, targetType, targetId, diff ? JSON.stringify(diff) : null, requestId, clock.iso());
    },
    /** Neo hash theo LÔ (không xâu chuỗi từng dòng): chain = sha256(prev || hash các dòng trong lô). */
    checkpoint() {
      const last = db.get('SELECT to_seq, chain_hash FROM audit_checkpoints ORDER BY to_seq DESC LIMIT 1');
      const from = (last?.to_seq ?? 0) + 1;
      const rows = db.all('SELECT seq,id,tenant_id,actor_id,action,target_type,target_id,diff,created_at FROM audit_logs WHERE seq>=? ORDER BY seq', from);
      if (!rows.length) return null;
      const chain = chainHash(last?.chain_hash || '', rows);
      const id = uuidv7();
      db.run('INSERT INTO audit_checkpoints(id,from_seq,to_seq,chain_hash,created_at) VALUES(?,?,?,?,?)', id, from, rows.at(-1).seq, chain, clock.iso());
      return { id, from, to: rows.at(-1).seq, chain };
    },
    /** Đối soát: tính lại mọi checkpoint; lệch → lịch sử đã bị sửa (DI-024). */
    verify() {
      const cps = db.all('SELECT * FROM audit_checkpoints ORDER BY from_seq');
      const bad = [];
      let prev = '';
      for (const c of cps) {
        const rows = db.all('SELECT seq,id,tenant_id,actor_id,action,target_type,target_id,diff,created_at FROM audit_logs WHERE seq BETWEEN ? AND ? ORDER BY seq', c.from_seq, c.to_seq);
        const h = chainHash(prev, rows);
        if (h !== c.chain_hash) bad.push({ checkpoint: c.id, from: c.from_seq, to: c.to_seq });
        prev = c.chain_hash;
      }
      return { checkpoints: cps.length, mismatches: bad };
    },
  };
}
function chainHash(prev, rows) {
  const h = createHash('sha256').update(prev);
  for (const r of rows) h.update(`${r.seq}|${r.id}|${r.tenant_id}|${r.actor_id}|${r.action}|${r.target_type}|${r.target_id}|${r.diff}|${r.created_at}\n`);
  return h.digest('hex');
}
