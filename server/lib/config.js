import { randomBytes } from 'node:crypto';

/** Validate env lúc boot (B1.1). Thiếu/sai → dừng ngay, không chạy nửa vời. */
export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const errors = [];
  const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
  const int = (k, d, min, max) => {
    const raw = env[k];
    const v = raw === undefined || raw === '' ? d : Number(raw);
    if (!Number.isInteger(v) || v < min || v > max) errors.push(`${k} phải là số nguyên ${min}..${max}`);
    return v;
  };
  let secret = env.APP_SECRET;
  if (!secret) {
    if (prod) errors.push('APP_SECRET bắt buộc ở production (>= 32 ký tự ngẫu nhiên)');
    else secret = randomBytes(32).toString('hex'); // dev/test: bí mật tạm theo tiến trình
  } else if (secret.length < 32) errors.push('APP_SECRET phải >= 32 ký tự');
  const cfg = {
    env: env.NODE_ENV || 'development',
    prod,
    port: int('PORT', 8080, 0, 65535),
    host: env.HOST || '0.0.0.0',
    databasePath: env.DATABASE_PATH || (prod ? '/data/trs6.sqlite' : './data/trs6.sqlite'),
    secret,
    publicOrigins: (env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL || '').split(',').map((x) => x.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean),
    trustProxy: bool(env.TRUST_PROXY, prod),
    cookieSecure: bool(env.COOKIE_SECURE, prod),
    emailMode: env.EMAIL_MODE || 'console', // console | webhook
    emailWebhookUrl: env.EMAIL_WEBHOOK_URL || '',
    emailFrom: env.EMAIL_FROM || 'no-reply@trs6.local',
    appUrl: env.APP_URL || '',
    hibp: bool(env.HIBP_CHECK, false),
    freeTextTeen: bool(env.FREE_TEXT_TEEN, false), // D4: mặc định chỉ câu mẫu
    // DEMO_MODE: CHỈ để chạy thử. Giáo viên đăng ký được tự xác minh email và tự duyệt (bỏ qua bước duyệt của quản trị). KHÔNG dùng khi có học viên thật/trẻ em.
    // AUTO_APPROVE (mặc định BẬT ở production, tắt khi dev/test): mọi tài khoản mới/cũ tự được xác minh email và (giáo viên) tự duyệt. Đặt AUTO_APPROVE=false để quay lại quy trình duyệt thủ công.
    demoMode: bool(env.DEMO_MODE, false) || bool(env.AUTO_APPROVE, prod),
    openSignup: bool(env.OPEN_SIGNUP, true),
    videoWebhookSecret: env.VIDEO_WEBHOOK_SECRET || '',
    // Phòng học (§7): MediaProvider — 'p2p' (WebRTC mesh, tín hiệu qua máy chủ) | 'fake' (test/smoke). LiveKit: chưa cài (ADR-0012).
    mediaProvider: env.MEDIA_PROVIDER || 'p2p',
    mediaWebhookSecret: env.MEDIA_WEBHOOK_SECRET || '',
    // AI gateway (§9): TẮT mặc định (cờ ai.gateway + cài đặt theo tổ chức). Khoá hệ thống tuỳ chọn; tổ chức có thể dùng BYOK.
    ai: {
      gateway: env.AI_GATEWAY === undefined || env.AI_GATEWAY === '' ? null : bool(env.AI_GATEWAY, false), // bật/tắt cờ ai.gateway lúc khởi động; null = giữ nguyên trong DB
      fake: bool(env.AI_PROVIDER === 'fake' ? 'true' : 'false', false),
      keys: { openai: env.OPENAI_API_KEY || '', anthropic: env.ANTHROPIC_API_KEY || '', gemini: env.GEMINI_API_KEY || '' },
      models: { openai: env.AI_MODEL_OPENAI || 'gpt-4o-mini', anthropic: env.AI_MODEL_ANTHROPIC || 'claude-haiku-5-5', gemini: env.AI_MODEL_GEMINI || 'gemini-3.8-flash', geminiVerify: env.AI_MODEL_GEMINI_VERIFY || 'gemini-3.8-flash-lite' }, // tên model: UNVERIFIED
      retries: int('AI_RETRIES', 2, 0, 5), backoffMs: int('AI_BACKOFF_MS', 400, 0, 10000), cacheTtlMs: int('AI_CACHE_TTL_MS', 86400000, 0, 2592000000),
      breaker: { threshold: 5, windowMs: 60000, cooldownMs: 30000 },
    },
    iceServers: (() => { try { const v = JSON.parse(env.ICE_SERVERS || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(), // mặc định rỗng (riêng tư); đặt STUN/TURN khi triển khai thật
    roomMaxPeople: int('ROOM_MAX_PEOPLE', 20, 2, 30),
    // Tham số học tập: GIẢ THUYẾT (BASELINE_PENDING), cấu hình được
    learning: {
      newPerDay: int('LEARN_NEW_PER_DAY', 10, 0, 100),
      maxReviewsPerDay: int('LEARN_MAX_REVIEWS_PER_DAY', 200, 10, 2000),
      desiredRetention: Number(env.LEARN_RETENTION || 0.9),
      dayBoundaryHour: int('LEARN_DAY_BOUNDARY_HOUR', 4, 0, 12),
      leechLapses: int('LEARN_LEECH_LAPSES', 8, 2, 50),
    },
    sessionTtl: { learnerDays: 30, teacherHours: 12, adminHours: 2, adminIdleMin: 30 },
    maxBodyBytes: 1024 * 1024,
    idempotencyTtlHours: 48,
    graceSeconds: 5,
  };
  if (cfg.prod && cfg.publicOrigins.length === 0) errors.push('PUBLIC_ORIGIN bắt buộc ở production (ví dụ https://trs6.example.com)');
  if (cfg.emailMode === 'webhook' && !cfg.emailWebhookUrl) errors.push('EMAIL_WEBHOOK_URL bắt buộc khi EMAIL_MODE=webhook');
  if (errors.length) throw new Error(`Cấu hình không hợp lệ:\n - ${errors.join('\n - ')}`);
  return cfg;
}
