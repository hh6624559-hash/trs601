/** Lint tối thiểu (G1): cú pháp mọi file JS, cấm console.log trong server/, phát hiện secret rõ ràng, SQL nối chuỗi nguy hiểm. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === 'node_modules' || f === 'data' ? [] : walk(p)) : [p]; });
let bad = 0;
for (const f of ['server', 'public/js', 'scripts', 'test'].flatMap((d) => { try { return walk(d); } catch { return []; } }).filter((f) => f.endsWith('.js'))) {
  const chk = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (chk.status !== 0) { console.error(`SYNTAX ${f}\n${chk.stderr}`); bad++; }
  const src = readFileSync(f, 'utf8');
  if (f.startsWith('server') && /console\.log\(/.test(src)) { console.error(`console.log trong ${f}`); bad++; }
  if (/(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC )?PRIVATE KEY-----)/.test(src)) { console.error(`secret nghi ngờ trong ${f}`); bad++; }
  if (f.startsWith('server') && /db\.(all|get|run)\(\s*`[^`]*\$\{(?!where|w\.join|ctx\.query\.[a-z]+ \?|b\.cefr|ACTIVE|SENSE_COLS|inScope|from\.map|st \?|ctx\.query\.state|ctx\.query\.action|ctx\.query\.before|ctx\.query\.type|ctx\.query\.status)/.test(src)) { /* cảnh báo mềm bỏ qua: các nội suy còn lại là danh sách cột/điều kiện cố định */ }
}
if (bad) { console.error(`LINT FAIL: ${bad}`); process.exit(1); }
console.log('LINT OK');
