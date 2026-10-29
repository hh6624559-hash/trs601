-- 008: AI gateway (§9) – cấu hình theo tổ chức, khoá BYOK (mã hoá cột), usage/ngân sách, cache, eval.
-- Mặc định TẮT: cờ 'ai.gateway'=0 và ai_settings.enabled=0. AI chỉ tạo NHÁP; người duyệt mới xuất bản (DI-012).
CREATE TABLE ai_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES organizations(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  monthly_token_budget INTEGER NOT NULL DEFAULT 200000 CHECK (monthly_token_budget BETWEEN 0 AND 100000000),
  user_daily_calls INTEGER NOT NULL DEFAULT 30 CHECK (user_daily_calls BETWEEN 0 AND 1000),
  routes TEXT,                                   -- JSON ghi đè bảng định tuyến: { task: [{provider,model}] }
  updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE ai_keys (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL CHECK (provider IN ('openai','anthropic','gemini')),
  key_enc TEXT NOT NULL,                         -- seal(APP_SECRET); KHÔNG bao giờ trả ra API/log/audit
  key_hint TEXT NOT NULL,                        -- 4 ký tự cuối để nhận diện
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE UNIQUE INDEX uq_ai_key_active ON ai_keys(tenant_id, provider) WHERE revoked_at IS NULL;
CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, task TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('ok','cached','error','blocked','invalid')),
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0,
  error_code TEXT, created_at TEXT NOT NULL
);
CREATE INDEX ai_usage_tenant ON ai_usage(tenant_id, created_at);
CREATE INDEX ai_usage_user ON ai_usage(user_id, created_at);
CREATE TABLE ai_cache (
  key TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, task TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE ai_eval_runs (
  id TEXT PRIMARY KEY, suite TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'NOT_CALIBRATED' CHECK (status IN ('NOT_CALIBRATED','CALIBRATED')),
  results TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO feature_flags(key, enabled, owner, purpose, expires_on) VALUES
 ('ai.gateway', 0, 'owner', 'AI gateway (§9) – tạo nháp câu hỏi, gợi ý gia sư. TẮT mặc định; API nhà cung cấp chưa kiểm chứng (UNVERIFIED_API)', '2027-06-30');
