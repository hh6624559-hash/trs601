import crypto from 'node:crypto';

/** UUIDv7 (time-ordered) generated in the application, per ADR-0001. */
export function uuidv7(now = Date.now()) {
  const b = crypto.randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const sha256 = (x) => crypto.createHash('sha256').update(x).digest();
export const sha256hex = (x) => crypto.createHash('sha256').update(x).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
export function timingSafeEqualStr(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
/** Human-friendly code without ambiguous characters. */
export function friendlyCode(len = 8) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = ''; const r = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += alphabet[r[i] % alphabet.length];
  return s;
}
/** Normalised text for accent-insensitive search (mirrors Postgres unaccent for Vietnamese). */
export function normText(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
}
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const systemClock = { now: () => new Date() };
