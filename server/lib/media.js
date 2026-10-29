import { randomUUID } from 'node:crypto';
import { hmacHex, safeEqual } from './crypto.js';

/**
 * Adapter MediaProvider (§7.4): createRoom · issueToken · updatePermissions · removeParticipant · endRoom · verifyWebhook · listParticipants.
 * Bản cài: P2PMediaProvider (WebRTC mesh; máy chủ chỉ cấp token + chuyển tín hiệu, KHÔNG thấy media) và FakeMediaProvider (test/smoke).
 * Chưa có LiveKitMediaProvider (cần máy chủ LiveKit + SDK từ npm — bị chặn ở môi trường dựng; xem docs/INTEGRATIONS.md, ADR-0012).
 */
export const TOKEN_TTL_SEC = 600; // GIẢ THUYẾT (spec §7.4); client tự gia hạn

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function makeP2PProvider({ secret, iceServers = [], webhookSecret = '', clock }) {
  const rooms = new Map(); // providerRoom → { participants:Map }
  return {
    id: 'p2p',
    async createRoom() { const name = randomUUID(); rooms.set(name, { participants: new Map() }); return { providerRoom: name }; },
    /** identity = ID nội bộ (không PII); tên phòng ở provider là UUID ngẫu nhiên, không phải mã công khai. */
    async issueToken({ roomName, userId, role, permissions, ttl = TOKEN_TTL_SEC }) {
      const exp = Math.floor(clock.ms() / 1000) + ttl;
      const body = b64({ r: roomName, u: userId, role, p: permissions, exp });
      return { token: `${body}.${hmacHex(secret, `media:${body}`)}`, expiresAt: new Date(exp * 1000).toISOString(), iceServers, permissions };
    },
    verifyToken(token) {
      const [body, sig] = String(token || '').split('.');
      if (!body || !sig || !safeEqual(sig, hmacHex(secret, `media:${body}`))) return null;
      try { const t = JSON.parse(Buffer.from(body, 'base64url').toString()); return t.exp * 1000 > clock.ms() ? t : null; } catch { return null; }
    },
    async updatePermissions() { return true; },     // P2P: quyền được áp bằng token mới + sự kiện; thực thi cuối cùng ở client/trình duyệt (giới hạn đã ghi ở STATE)
    async removeParticipant() { return true; },
    async endRoom(providerRoom) { rooms.delete(providerRoom); return true; },
    verifyWebhook(rawBody, headers) { return !!webhookSecret && safeEqual(String(headers['x-signature'] || ''), hmacHex(webhookSecret, rawBody)); },
    async listParticipants() { return []; },
  };
}

/** Provider giả: ghi lại lời gọi, có thể ép lỗi để test «provider sập → UI báo đúng». */
export function makeFakeProvider({ clock }) {
  const f = { id: 'fake', calls: [], failNext: 0, rooms: new Map() };
  const rec = (n, a) => { f.calls.push({ n, a }); if (f.failNext > 0) { f.failNext -= 1; throw new Error('fake provider failure'); } };
  Object.assign(f, {
    async createRoom() { rec('createRoom'); const name = randomUUID(); f.rooms.set(name, new Set()); return { providerRoom: name }; },
    async issueToken(a) { rec('issueToken', a); const exp = Math.floor(clock.ms() / 1000) + (a.ttl || TOKEN_TTL_SEC); return { token: `fake.${a.userId}.${exp}`, expiresAt: new Date(exp * 1000).toISOString(), iceServers: [], permissions: a.permissions }; },
    verifyToken(tok) { const [k, u, exp] = String(tok).split('.'); return k === 'fake' && Number(exp) * 1000 > clock.ms() ? { u, exp: Number(exp) } : null; },
    async updatePermissions(a) { rec('updatePermissions', a); return true; },
    async removeParticipant(a) { rec('removeParticipant', a); return true; },
    async endRoom(a) { rec('endRoom', a); return true; },
    verifyWebhook(raw, headers) { return headers['x-signature'] === 'fake-valid'; },
    async listParticipants() { return []; },
  });
  return f;
}
export const makeMediaProvider = (config, clock) => (config.mediaProvider === 'fake' ? makeFakeProvider({ clock }) : makeP2PProvider({ secret: config.secret, iceServers: config.iceServers, webhookSecret: config.mediaWebhookSecret, clock }));
