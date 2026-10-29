import { scrypt, randomBytes, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
const scryptP = promisify(scrypt);

const N = 2 ** 15, R = 8, P = 1;
/** Băm mật khẩu bằng scrypt (ADR-0003: Argon2id không có sẵn trong Node core; scrypt là KDF memory-hard chuẩn). */
export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scryptP(pw.normalize('NFKC'), salt, 32, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const key = await scryptP(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), 32, { N: +n, r: +r, p: +p, maxmem: 128 * +n * +r * 2 });
  const expect = Buffer.from(hash, 'base64');
  return key.length === expect.length && timingSafeEqual(key, expect);
}
/** Dùng khi tài khoản không tồn tại, để thời gian phản hồi đồng nhất (chống dò tài khoản). */
let dummy;
export async function dummyVerify(pw) { dummy ||= await hashPassword('dummy-password-for-timing'); await verifyPassword(pw, dummy); }

export const sha256 = (x) => createHash('sha256').update(x).digest();
export const sha256hex = (x) => createHash('sha256').update(x).digest('hex');
export const hmacHex = (key, data) => createHmac('sha256', key).update(data).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** AES-256-GCM cho bí mật cột (secret TOTP). Khoá suy ra từ APP_SECRET. */
const keyOf = (secret) => createHash('sha256').update(`trs6:colkey:${secret}`).digest();
export function seal(secret, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}
export function unseal(secret, blob) {
  const [v, iv, tag, enc] = blob.split('.');
  if (v !== 'v1') throw new Error('bad blob');
  const d = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

// ---- TOTP (RFC 6238) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function unbase32(str) {
  let bits = 0, val = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totp(secretB32, ms, step = 30, digits = 6) {
  const counter = Math.floor(ms / 1000 / step);
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', unbase32(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}
export function verifyTotp(secretB32, code, ms) {
  if (!/^\d{6}$/.test(String(code))) return false;
  for (const w of [-1, 0, 1]) if (safeEqual(totp(secretB32, ms + w * 30000), String(code))) return true;
  return false;
}

const COMMON = new Set(['password', '12345678', '123456789', '1234567890', 'qwertyuiop', 'iloveyou1', 'password1', 'password123', 'abcd1234', 'matkhau123', 'matkhau1234', '11111111', '00000000', 'letmein123', 'welcome123', 'admin12345', 'qwerty123', 'qwerty12345', 'tiengviet123', '1q2w3e4r5t', 'passw0rd12']);
/** Chính sách mật khẩu người lớn; trả mã lỗi hoặc null. HIBP k-anonymity là tuỳ chọn (cần mạng). */
export function weakPassword(pw, hints = []) {
  if (pw.length < 10) return 'password.too_short';
  if (pw.length > 200) return 'password.too_long';
  const low = pw.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(pw)) return 'password.common';
  if (hints.some((h) => h && h.length >= 4 && low.includes(String(h).toLowerCase()))) return 'password.contains_identity';
  return null;
}
export async function hibpPwned(pw) {
  try {
    const h = createHash('sha1').update(pw).digest('hex').toUpperCase();
    const r = await fetch(`https://api.pwnedpasswords.com/range/${h.slice(0, 5)}`, { signal: AbortSignal.timeout(2500), headers: { 'Add-Padding': 'true' } });
    if (!r.ok) return false;
    const t = await r.text();
    return t.split('\n').some((l) => { const [suf, n] = l.trim().split(':'); return suf === h.slice(5) && Number(n) > 0; });
  } catch { return false; } // fail-open + không chặn đăng ký
}
