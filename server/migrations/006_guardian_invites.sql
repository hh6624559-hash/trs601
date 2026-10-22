-- 006: mời giám hộ liên kết với học viên do giáo viên cấp (xác minh qua tổ chức, D7)
CREATE TABLE guardian_invites (
  code TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES organizations(id), learner_id TEXT NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT REFERENCES users(id)
);
