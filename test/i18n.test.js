import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_TABLE } from '../server/lib/errors.js';

const vi = JSON.parse(readFileSync('public/i18n/vi.json', 'utf8')), en = JSON.parse(readFileSync('public/i18n/en.json', 'utf8'));
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = [...walk('public/js')].filter((f) => f.endsWith('.js'));
const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');
const server = walk('server').filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');

test('vi và en có cùng bộ khóa, không rỗng, cùng placeholder', () => {
  assert.deepEqual(Object.keys(vi).sort(), Object.keys(en).sort());
  for (const k of Object.keys(vi)) {
    assert.ok(vi[k].trim() && en[k].trim(), `rỗng: ${k}`);
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(ph(vi[k]), ph(en[k]), `placeholder lệch: ${k}`);
  }
});

test('mọi khóa tĩnh t("...") dùng trong frontend đều có bản dịch', () => {
  const keys = new Set([...src.matchAll(/\bt\('([A-Za-z0-9_.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.') && k.includes('.')));
  for (const m of src.matchAll(/'((?:admin\.target|privacy\.who|privacy\.data|privacy\.purpose|privacy\.retention)|[a-z]+\.[A-Za-z_.]+)'/g)) if (/^(teacher|auth|col|q|admin|privacy)\./.test(m[1]) && !m[1].endsWith('.')) keys.add(m[1]);
  const missing = [...keys].filter((k) => !(k in vi) && !/^(\/|\.)/.test(k));
  const real = missing.filter((k) => /^(common|nav|auth|home|review|col|quiz|games|social|teacher|guardian|admin|privacy|profile|pref|mfa|sessions|notif|stepup|shop|stickers|paths|vocab|offline|time|q|gsum|hint|report|role|mascot|age|attempt|topic|learnState|quest|error|vcode)\./.test(k));
  assert.deepEqual(real, [], 'thiếu khóa i18n');
});

test('khóa động: mọi giá trị enum có bản dịch', () => {
  const need = [
    ...['active', 'paused', 'archived'].map((x) => `col.status.${x}`), ...['new', 'learning', 'review', 'relearning', 'suspended'].map((x) => `learnState.${x}`),
    ...['CREATED', 'IN_PROGRESS', 'SUBMITTED', 'GRADED', 'EXPIRED', 'GRADING_FAILED', 'INVALIDATED', 'CANCELLED'].map((x) => `attempt.${x}`),
    ...['open', 'closed', 'not_open'].map((x) => `quiz.status.${x}`), ...['u13', '13_17', '18p'].map((x) => `age.${x}`),
    ...['draft', 'in_review', 'approved', 'published', 'retired'].map((x) => `q.status.${x}`), ...['bullying', 'unsafe_contact', 'self_harm', 'inappropriate', 'spam', 'other'].map((x) => `report.reason.${x}`),
    ...['daily', 'school', 'academic', 'food', 'travel', 'hobbies', 'body', 'family', 'nature', 'work', 'feelings', 'animals', 'technology', 'weather'].map((x) => `topic.${x}`),
    ...['idle', 'happy', 'thinking', 'cheer', 'sad', 'sleepy'].map((x) => `mascot.${x}`),
    ...['assessment_new', 'assignment_new', 'session_scheduled', 'moderation_warning', 'age_band_changed', 'age_band_changed_guardian'].map((x) => `notif.${x}`),
    ...['review', 'new_word', 'game'].map((x) => `quest.${x}`),
  ];
  assert.deepEqual(need.filter((k) => !(k in vi)), []);
});

test('mọi mã lỗi và messageKey của máy chủ có bản dịch', () => {
  const keys = new Set(Object.keys(ERROR_TABLE).map((c) => `error.${c}`));
  for (const m of server.matchAll(/messageKey: '(error\.[A-Z_]+)'/g)) keys.add(m[1]);
  assert.deepEqual([...keys].filter((k) => !(k in vi)), []);
});

test('frontend: không innerHTML/eval/style attr/inline handler (CSP)', () => {
  assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|\beval\(|new Function\(|document\.write/);
  assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]/);
  const html = readFileSync('public/index.html', 'utf8');
  assert.doesNotMatch(html, /\son\w+=|<style|style=|<script(?![^>]*\bsrc=)/);
});
