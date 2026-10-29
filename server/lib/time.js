/** "Ngày học" theo IANA timezone người học, ranh giới 04:00 giờ địa phương (GIẢ THUYẾT, cấu hình được). */
export function tzOffsetMs(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}
export function learningDay(ms, tz, boundaryHour = 4) {
  const off = tzOffsetMs(ms, tz);
  const shifted = ms + off - boundaryHour * 3600e3;
  const d = new Date(shifted);
  const key = d.toISOString().slice(0, 10);
  const startLocalAsUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), boundaryHour);
  const startMs = startLocalAsUtc - off;
  return { key, startMs, endMs: startMs + 86400e3 };
}
export function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3); }
export function isoWeekKey(dayKey) {
  const d = new Date(dayKey + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const y = d.getUTCFullYear();
  const wk = 1 + Math.round(((d - Date.UTC(y, 0, 4)) / 86400e3 - 3 + ((new Date(Date.UTC(y, 0, 4)).getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(wk).padStart(2, '0')}`;
}
