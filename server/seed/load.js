import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normVi } from '../lib/norm.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), 'lexemes.txt');
const detId = (kind, key) => { const h = createHash('sha256').update(`trs6:${kind}:${key}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

/** Nạp bộ từ gốc (idempotent). Mỗi lexeme ghi source_id + license (B2.7). Trả số từ mới thêm. */
export function seedVocabulary(db) {
  const lines = readFileSync(FILE, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  db.run("INSERT OR IGNORE INTO sources(id,name,license,url) VALUES('trs6-seed-v1','TRS6 seed vocabulary (original)','CC0-1.0',NULL)");
  let added = 0;
  db.tx(() => {
    for (const line of lines) {
      const [lemma, pos, cefr, ipa, defEn, defVi, exEn, exVi, topics] = line.split('|');
      const lid = detId('lexeme', lemma), sid = detId('sense', `${lemma}|${pos}`);
      const r = db.run("INSERT OR IGNORE INTO lexemes(id,lemma,lemma_norm,lang,cefr,source_id,license) VALUES(?,?,?,'en',?,'trs6-seed-v1','CC0-1.0')", lid, lemma, normVi(lemma), cefr);
      if (r.changes) added++;
      db.run("INSERT OR IGNORE INTO senses(id,lexeme_id,owner_tenant_id,pos,ipa,definition_en,definition_vi,definition_vi_norm,example_en,example_vi,status) VALUES(?,?,NULL,?,?,?,?,?,?,?,'published')",
        sid, lid, pos, ipa, defEn, defVi, normVi(defVi), exEn, exVi);
      for (const t of topics.split(',')) db.run('INSERT OR IGNORE INTO sense_topics(sense_id,topic) VALUES(?,?)', sid, t.trim());
    }
  });
  return added;
}
