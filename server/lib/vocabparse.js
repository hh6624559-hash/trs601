/**
 * vocabparse.js – đọc danh sách từ vựng từ văn bản dán/tải lên (CSV, TSV dán từ Excel, hoặc phân tách bằng ; |).
 * Thuần túy, không đụng DB. Trả { rows, errors, delimiter, hasHeader }.
 */
export const MAX_ROWS = 1000;
const POS_MAP = { n: 'noun', noun: 'noun', 'danh từ': 'noun', v: 'verb', verb: 'verb', 'động từ': 'verb', adj: 'adjective', adjective: 'adjective', 'tính từ': 'adjective', a: 'adjective',
  adv: 'adverb', adverb: 'adverb', 'trạng từ': 'adverb', prep: 'preposition', preposition: 'preposition', 'giới từ': 'preposition', pron: 'pronoun', pronoun: 'pronoun', 'đại từ': 'pronoun',
  conj: 'conjunction', conjunction: 'conjunction', 'liên từ': 'conjunction', interj: 'interjection', interjection: 'interjection', det: 'determiner', phrase: 'phrase', 'cụm từ': 'phrase', idiom: 'phrase' };
const HEADS = {
  lemma: ['lemma', 'word', 'vocab', 'vocabulary', 'english', 'tiếng anh', 'từ', 'từ vựng', 'tu', 'tu vung', 'tu tieng anh'],
  pos: ['pos', 'type', 'loại từ', 'loai tu', 'part of speech', 'từ loại', 'tu loai'],
  vi: ['vi', 'meaning', 'vietnamese', 'tiếng việt', 'nghĩa', 'nghia', 'nghĩa tiếng việt', 'definition_vi', 'meaning_vi', 'dịch', 'dich'],
  en: ['definition', 'definition_en', 'english definition', 'en', 'định nghĩa', 'dinh nghia', 'meaning_en'],
  exEn: ['example', 'example_en', 'ví dụ', 'vi du', 'sentence', 'example sentence'],
  exVi: ['example_vi', 'ví dụ tiếng việt', 'dịch ví dụ', 'vi du tieng viet'],
  cefr: ['cefr', 'level', 'cấp độ', 'cap do', 'trình độ'],
  ipa: ['ipa', 'phiên âm', 'phien am', 'pronunciation'],
  topic: ['topic', 'chủ đề', 'chu de', 'tag', 'unit'],
};
const norm = (x) => String(x ?? '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}_ ]/gu, '').trim();
const clean = (x, max) => String(x ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function detectDelimiter(lines) {
  const sample = lines.slice(0, 5).join('\n');
  const score = (d) => (sample.match(new RegExp(d === '\t' ? '\t' : `\\${d}`, 'g')) || []).length;
  const c = [['\t', score('\t')], [';', score(';')], ['|', score('|')], [',', score(',')]].sort((a, b) => b[1] - a[1])[0];
  return c[1] > 0 ? c[0] : ',';
}
/** Tách một dòng theo CSV có ngoặc kép. */
function splitLine(line, d) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"' && cur === '') q = true;
    else if (ch === d) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
const asPos = (x) => POS_MAP[norm(x)] || null;
const asCefr = (x) => { const v = String(x ?? '').trim().toUpperCase(); return /^(A1|A2|B1|B2|C1|C2)$/.test(v) ? v : null; };

export function parseVocab(text) {
  const errors = [];
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) return { rows: [], errors: [{ line: 0, reason: 'empty' }], delimiter: ',', hasHeader: false };
  const delimiter = detectDelimiter(lines);
  const cells = lines.map((l) => splitLine(l, delimiter));
  // Nhận dạng dòng tiêu đề: ít nhất 2 ô khớp tên cột đã biết
  const colOf = {}; let hasHeader = false;
  const first = cells[0].map(norm);
  let hits = 0; const tmp = {};
  first.forEach((c, i) => { for (const [k, names] of Object.entries(HEADS)) if (names.includes(c) && tmp[k] === undefined) { tmp[k] = i; hits++; break; } });
  if (hits >= 2 && tmp.lemma !== undefined) { Object.assign(colOf, tmp); hasHeader = true; }
  const body = hasHeader ? cells.slice(1) : cells;
  const rows = [], seen = new Set();
  body.forEach((c, idx) => {
    const line = idx + 1 + (hasHeader ? 1 : 0);
    if (rows.length >= MAX_ROWS) { if (rows.length === MAX_ROWS && !errors.some((e) => e.reason === 'too_many')) errors.push({ line, reason: 'too_many' }); return; }
    let r;
    if (hasHeader) {
      const g = (k) => (colOf[k] === undefined ? '' : c[colOf[k]] ?? '');
      r = { lemma: g('lemma'), pos: g('pos'), vi: g('vi'), en: g('en'), exEn: g('exEn'), exVi: g('exVi'), cefr: g('cefr'), ipa: g('ipa'), topic: g('topic') };
    } else {
      // Không có tiêu đề: từ | [loại từ] | nghĩa | ví dụ EN | ví dụ VI
      const hasPos = c.length >= 3 && asPos(c[1]);
      r = hasPos ? { lemma: c[0], pos: c[1], vi: c[2], exEn: c[3], exVi: c[4] } : { lemma: c[0], vi: c[1], exEn: c[2], exVi: c[3] };
    }
    const lemma = clean(r.lemma, 60);
    if (!lemma) { errors.push({ line, reason: 'no_word' }); return; }
    if (!/^[\p{L}][\p{L}\p{M} '’.\-]*$/u.test(lemma)) { errors.push({ line, reason: 'bad_word', value: lemma.slice(0, 30) }); return; }
    const vi = clean(r.vi, 300), en = clean(r.en, 300);
    if (!vi && !en) { errors.push({ line, reason: 'no_meaning', value: lemma }); return; }
    const pos = asPos(r.pos) || 'other';
    const key = `${lemma.toLowerCase()}|${pos}`;
    if (seen.has(key)) { errors.push({ line, reason: 'duplicate', value: lemma }); return; }
    seen.add(key);
    const L = /^\p{Lu}\p{Ll}+$/u.test(lemma) ? lemma.toLowerCase() : lemma;
    rows.push({ line, lemma: L, pos, definitionVi: vi, definitionEn: en, exampleEn: clean(r.exEn, 300), exampleVi: clean(r.exVi, 300), cefr: asCefr(r.cefr), ipa: clean(r.ipa, 60), topics: clean(r.topic, 60).split(/[,/]/).map((x) => clean(x, 30).toLowerCase()).filter(Boolean).slice(0, 3) });
  });
  return { rows, errors, delimiter, hasHeader };
}
