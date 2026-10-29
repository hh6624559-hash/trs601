// Environment is validated at boot: invalid configuration => process refuses to start.
const bool = (x, d) => (x === undefined ? d : /^(1|true|yes|on)$/i.test(x));
const int = (x, d) => (x === undefined || x === '' ? d : Number.parseInt(x, 10));

export function loadConfig(env = process.env) {
  const errors = [];
  const nodeEnv = env.NODE_ENV || 'development';
  const prod = nodeEnv === 'production';
  const databaseUrl = env.DATABASE_URL || (prod ? '' : 'postgres://trs6:trs6dev@localhost:5432/trs6');
  if (!databaseUrl) errors.push('DATABASE_URL is required');
  const sessionSecret = env.SESSION_SECRET || (prod ? '' : 'dev-only-secret-change-me-dev-only-secret');
  if (!sessionSecret || sessionSecret.length < 32) errors.push('SESSION_SECRET must be set (>= 32 chars)');
  const cfg = {
    nodeEnv, prod,
    port: int(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    databaseUrl,
    poolMax: int(env.PG_POOL_MAX, 10),
    sessionSecret,
    publicUrl: env.PUBLIC_URL || '',
    cookieSecure: bool(env.COOKIE_SECURE, prod),
    trustProxy: bool(env.TRUST_PROXY, prod),
    adminEmail: env.ADMIN_EMAIL || '',
    adminPassword: env.ADMIN_PASSWORD || '',
    defaultTz: env.DEFAULT_TZ || 'Asia/Ho_Chi_Minh',
    dayBoundaryHour: int(env.DAY_BOUNDARY_HOUR, 4),
    deletionGraceDays: int(env.DELETION_GRACE_DAYS, 14),
    // learning (HYPOTHESES — BASELINE_PENDING)
    newPerDay: int(env.NEW_PER_DAY, 10), reviewCapPerDay: int(env.REVIEW_CAP_PER_DAY, 200), retention: Number(env.DESIRED_RETENTION || 0.9),
    leechThreshold: int(env.LEECH_THRESHOLD, 8),
    // AI gateway
    aiProvider: env.AI_PROVIDER || 'local', anthropicKey: env.ANTHROPIC_API_KEY || '', aiModel: env.AI_MODEL || 'claude-sonnet-4-5',
    aiDailyCallsPerTenant: int(env.AI_DAILY_CALLS_PER_TENANT, 200), aiHourlyPerUser: int(env.AI_HOURLY_PER_USER, 20),
    // video
    videoProvider: env.VIDEO_PROVIDER || 'jitsi', jitsiBase: env.JITSI_BASE_URL || 'https://meet.jit.si', videoWebhookSecret: env.VIDEO_WEBHOOK_SECRET || '',
    requireAssistantForU13: bool(env.REQUIRE_ASSISTANT_FOR_U13, true),
    // social safety
    freeChatTeen: bool(env.FREE_CHAT_TEEN, false), socialOpen: bool(env.SOCIAL_OPEN, false),
    registrationOpen: bool(env.REGISTRATION_OPEN, true),
    defaultOrgName: env.DEFAULT_ORG_NAME || 'Cộng đồng TRS6',
    logLevel: env.LOG_LEVEL || 'info',
  };
  if (errors.length) { const e = new Error('Invalid configuration:\n - ' + errors.join('\n - ')); e.fatal = true; throw e; }
  return cfg;
}
