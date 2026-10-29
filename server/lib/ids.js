import { randomBytes } from 'node:crypto';

/** UUIDv7 sinh ở ứng dụng (B2.1): 48-bit ms + ngẫu nhiên, sắp xếp được theo thời gian. */
export function uuidv7(ms = Date.now()) {
  const b = randomBytes(16);
  b[0] = (ms / 2 ** 40) & 0xff;
  b[1] = (ms / 2 ** 32) & 0xff;
  b[2] = (ms / 2 ** 24) & 0xff;
  b[3] = (ms / 2 ** 16) & 0xff;
  b[4] = (ms / 2 ** 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mã ngắn dễ đọc (không có ký tự dễ nhầm 0/O/1/I). */
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function shortCode(len = 6) {
  const b = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
}
