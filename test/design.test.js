import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run } from '../scripts/check-contrast.js';
import { normAnswer } from '../server/modules/grading.js';

test('tương phản WCAG ≥ 4.5:1 cho mọi cặp token (sáng + tối)', () => {
  const res = run();
  const bad = res.filter((r) => !r.ok);
  assert.equal(bad.length, 0, JSON.stringify(bad));
});
test('P-05: NFC/NFD tiếng Việt so khớp; đ khác d', () => {
  assert.equal(normAnswer('Việt'.normalize('NFD')), normAnswer('VIỆT'.normalize('NFC')));
  assert.notEqual(normAnswer('đi'), normAnswer('di'));
});
test('P-03/P-04: không Math.random/Date.now trong view; có guard isComposing', () => {
  for (const f of ['components.js', 'views/collections.js']) assert.ok(!/Math\.random|Date\.now/.test(readFileSync(new URL('../public/js/' + f, import.meta.url), 'utf8')), f);
  assert.match(readFileSync(new URL('../public/js/views/review.js', import.meta.url), 'utf8'), /isComposing/);
});
test('P-09: SW không cache /api và có cơ chế cập nhật', () => {
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /\/api\//); assert.match(sw, /SKIP_WAITING/); assert.ok(!/self\.skipWaiting\(\)\)/.test(sw.split('install')[1]?.split('activate')[0] || ''));
});
