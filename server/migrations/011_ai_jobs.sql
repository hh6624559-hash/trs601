-- 011: ra đề hàng loạt (tới 1000 câu) chạy nền + nới giới hạn hạn mức AI.
-- ai_settings: bỏ CHECK cũ (≤1000 lượt/ngày) bằng cách dựng lại bảng; nâng mặc định cho ra đề hàng loạt.
CREATE TABLE ai_settings_new (
  tenant_id TEXT PRIMARY KEY REFERENCES organizations(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  monthly_token_budget INTEGER NOT NULL DEFAULT 5000000 CHECK (monthly_token_budget BETWEEN 0 AND 1000000000),
  user_daily_calls INTEGER NOT NULL DEFAULT 3000 CHECK (user_daily_calls BETWEEN 0 AND 100000),
  routes TEXT,
  updated_by TEXT, updated_at TEXT NOT NULL
);
INSERT INTO ai_settings_new(tenant_id,enabled,monthly_token_budget,user_daily_calls,routes,updated_by,updated_at)
  SELECT tenant_id, enabled,
    CASE WHEN monthly_token_budget = 200000 THEN 5000000 ELSE monthly_token_budget END,
    CASE WHEN user_daily_calls IN (30, 200) THEN 3000 ELSE user_daily_calls END, routes, updated_by, updated_at FROM ai_settings;
DROP TABLE ai_settings;
ALTER TABLE ai_settings_new RENAME TO ai_settings;
CREATE TABLE ai_jobs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES organizations(id), user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('teacher','practice')),
  request TEXT NOT NULL, total INTEGER NOT NULL CHECK (total BETWEEN 1 AND 1000),
  done INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('RUNNING','DONE','FAILED','CANCELLED')), error TEXT, result TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX ai_jobs_user ON ai_jobs(user_id, created_at);
