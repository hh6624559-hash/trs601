-- 001: danh tính, tenant, đồng ý, phiên, nền tảng (S1a). SQL chuẩn, đổi sang PostgreSQL theo ADR-0001.

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind TEXT NOT NULL CHECK (kind IN ('school','family','personal')),
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT COLLATE NOCASE UNIQUE,                 -- NULL với tài khoản Kid
  username TEXT,                                     -- đăng nhập Kid: mã lớp + username + PIN
  home_tenant_id TEXT NOT NULL REFERENCES organizations(id),
  password_hash TEXT,
  birth_ym TEXT NOT NULL CHECK (birth_ym GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-01'),  -- chỉ năm-tháng; nhóm tuổi SUY RA, không lưu
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  locale TEXT NOT NULL DEFAULT 'vi' CHECK (locale IN ('vi','en')),
  tz TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','anonymized')),
  platform_role TEXT CHECK (platform_role IN ('admin')),
  prefs TEXT NOT NULL DEFAULT '{}',                  -- jsonb có version: {"v":1,...}
  friend_code TEXT UNIQUE,
  email_verified_at TEXT,
  created_by TEXT REFERENCES users(id),
  anonymized_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (home_tenant_id, username),
  CHECK (email IS NOT NULL OR username IS NOT NULL OR status = 'anonymized')
);

CREATE TABLE memberships (
  tenant_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('learner','teacher','guardian','admin','owner')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, role)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                               -- sha256(token); token chỉ có ở cookie
  user_id TEXT NOT NULL REFERENCES users(id),
  tenant_id TEXT NOT NULL REFERENCES organizations(id),
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  idle_timeout_sec INTEGER,                          -- NULL = không có idle timeout
  stepup_until TEXT,
  mfa_passed INTEGER NOT NULL DEFAULT 0,
  ua TEXT,
  ip_hash TEXT,
  revoked_at TEXT
);
CREATE INDEX sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id),
  subject_id TEXT NOT NULL REFERENCES users(id),
  granted_by TEXT REFERENCES users(id),
  purpose TEXT NOT NULL,                             -- 'account','social','ai_tutor','weekly_report',...
  scope TEXT NOT NULL DEFAULT '{}',
  policy_version TEXT NOT NULL,
  verification_method TEXT NOT NULL DEFAULT 'org_attestation' CHECK (verification_method IN ('org_attestation','guardian_account','self_adult')),
  state TEXT NOT NULL CHECK (state IN ('REQUESTED','VERIFIED','GRANTED','REVOKED','EXPIRED')),
  requested_at TEXT NOT NULL, granted_at TEXT, revoked_at TEXT, expires_at TEXT,
  UNIQUE (tenant_id, id)
);
CREATE INDEX consents_subject ON consents(subject_id, purpose);

CREATE TABLE guardian_links (
  tenant_id TEXT NOT NULL,
  guardian_id TEXT NOT NULL REFERENCES users(id),
  learner_id TEXT NOT NULL REFERENCES users(id),
  consent_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  scope TEXT NOT NULL DEFAULT '{"progress":true,"messaging_toggle":true}',
  messaging_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, guardian_id, learner_id),
  FOREIGN KEY (tenant_id, consent_id) REFERENCES consents(tenant_id, id)
);
CREATE INDEX guardian_links_learner ON guardian_links(learner_id);

CREATE TABLE mfa_factors (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  secret_sealed TEXT NOT NULL,                       -- AES-GCM, khoá từ APP_SECRET
  enabled_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('verify','reset')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE teacher_verifications (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  tenant_id TEXT NOT NULL REFERENCES organizations(id),
  state TEXT NOT NULL CHECK (state IN ('SUBMITTED','EMAIL_VERIFIED','APPROVED','REJECTED','SUSPENDED')),
  note TEXT,
  decided_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE rate_events (k TEXT NOT NULL, ts INTEGER NOT NULL, cost INTEGER NOT NULL DEFAULT 1);
CREATE INDEX rate_events_k ON rate_events(k, ts);

CREATE TABLE idempotency_records (
  tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETED','FAILED')),
  response_status INTEGER, response_body TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, operation, key)
);
CREATE INDEX idempotency_exp ON idempotency_records(expires_at);

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, correlation_id TEXT, created_at TEXT NOT NULL,
  published_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_attempt_at TEXT, dead_at TEXT
);
CREATE INDEX outbox_pending ON outbox_events(created_at) WHERE published_at IS NULL AND dead_at IS NULL;

CREATE TABLE webhook_inbox (
  provider TEXT NOT NULL, event_id TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL, processed_at TEXT,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE audit_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT, actor_id TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT,
  diff TEXT,                                         -- chỉ tên trường + ID, KHÔNG PII/nội dung tin nhắn
  request_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE audit_checkpoints (
  id TEXT PRIMARY KEY, from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, chain_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER audit_logs_ro_u BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT,'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_ro_d BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT,'audit_logs is append-only'); END;
CREATE TRIGGER audit_ckpt_ro_u BEFORE UPDATE ON audit_checkpoints BEGIN SELECT RAISE(ABORT,'audit_checkpoints is append-only'); END;
CREATE TRIGGER audit_ckpt_ro_d BEFORE DELETE ON audit_checkpoints BEGIN SELECT RAISE(ABORT,'audit_checkpoints is append-only'); END;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, created_at);

CREATE TABLE feature_flags (
  key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, owner TEXT NOT NULL, purpose TEXT NOT NULL,
  expires_on TEXT, allow_tenants TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO feature_flags(key, enabled, owner, purpose, expires_on) VALUES
 ('social.friends', 1, 'owner', 'Kết bạn trong tổ chức (S9, nhóm kín)', '2027-06-30'),
 ('social.free_text_teen', 0, 'owner', 'Nhắn tin tự do 13–17 (D4: mặc định tắt)', '2027-06-30'),
 ('classroom.sessions', 1, 'owner', 'Lịch buổi học online (liên kết ngoài)', '2027-06-30'),
 ('ai.gateway', 0, 'owner', 'AI Gateway (S6) – chưa chọn nhà cung cấp (D2)', '2027-06-30');

-- Danh mục cột PII (thay COMMENT ON COLUMN của PostgreSQL); test quét đảm bảo không lọt vào audit/log.
CREATE TABLE pii_columns (tbl TEXT NOT NULL, col TEXT NOT NULL, level TEXT NOT NULL CHECK (level IN ('high','medium','low')), PRIMARY KEY (tbl, col));
INSERT INTO pii_columns(tbl,col,level) VALUES
 ('users','email','high'),('users','birth_ym','high'),('users','password_hash','high'),('users','display_name','medium'),
 ('users','username','medium'),('users','tz','low'),('messages','body','high'),('sessions','ip_hash','medium'),('sessions','ua','low');

CREATE TABLE privacy_requests (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject_id TEXT NOT NULL REFERENCES users(id), requested_by TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('export','deletion','rectification','withdraw_consent')),
  state TEXT NOT NULL CHECK (state IN ('RECEIVED','VERIFIED','IN_PROGRESS','COMPLETED','REJECTED')),
  note TEXT, due_at TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT
);

-- Bảng chuyển trạng thái = nguồn sự thật duy nhất (NT-6, DI-007); trigger DB chặn chuyển sai.
CREATE TABLE state_transitions (machine TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL, PRIMARY KEY (machine, from_state, to_state));
INSERT INTO state_transitions(machine, from_state, to_state) VALUES
 ('consent','REQUESTED','VERIFIED'),('consent','VERIFIED','GRANTED'),('consent','GRANTED','REVOKED'),('consent','GRANTED','EXPIRED'),('consent','REQUESTED','REVOKED'),('consent','VERIFIED','REVOKED'),
 ('teacher','SUBMITTED','EMAIL_VERIFIED'),('teacher','SUBMITTED','APPROVED'),('teacher','SUBMITTED','REJECTED'),('teacher','EMAIL_VERIFIED','APPROVED'),('teacher','EMAIL_VERIFIED','REJECTED'),('teacher','APPROVED','SUSPENDED'),('teacher','SUSPENDED','APPROVED'),
 ('privacy','RECEIVED','VERIFIED'),('privacy','RECEIVED','REJECTED'),('privacy','VERIFIED','IN_PROGRESS'),('privacy','VERIFIED','COMPLETED'),('privacy','IN_PROGRESS','COMPLETED'),('privacy','VERIFIED','REJECTED'),
 ('attempt','CREATED','IN_PROGRESS'),('attempt','IN_PROGRESS','SUBMITTED'),('attempt','SUBMITTED','GRADING'),('attempt','GRADING','GRADED'),
 ('attempt','IN_PROGRESS','EXPIRED'),('attempt','EXPIRED','SUBMITTED'),('attempt','GRADING','GRADING_FAILED'),('attempt','GRADING_FAILED','GRADING'),
 ('attempt','CREATED','CANCELLED'),('attempt','IN_PROGRESS','CANCELLED'),('attempt','SUBMITTED','INVALIDATED'),('attempt','GRADING','INVALIDATED'),('attempt','EXPIRED','INVALIDATED'),('attempt','IN_PROGRESS','INVALIDATED'),
 ('report','RECEIVED','IN_REVIEW'),('report','RECEIVED','ESCALATED'),('report','IN_REVIEW','ESCALATED'),('report','IN_REVIEW','ACTIONED'),('report','IN_REVIEW','DISMISSED'),('report','ESCALATED','ACTIONED'),('report','ESCALATED','DISMISSED'),('report','ESCALATED','IN_REVIEW'),
 ('classroom','SCHEDULED','READY'),('classroom','READY','LIVE'),('classroom','LIVE','ENDED'),('classroom','SCHEDULED','CANCELLED'),('classroom','READY','CANCELLED'),
 ('qversion','draft','in_review'),('qversion','in_review','draft'),('qversion','in_review','approved'),('qversion','approved','published'),('qversion','published','retired'),('qversion','draft','retired'),('qversion','approved','draft'),
 ('friend','pending','active'),('friend','pending','removed'),('friend','active','removed');

CREATE TRIGGER consents_sm BEFORE UPDATE OF state ON consents
WHEN NEW.state <> OLD.state AND NOT EXISTS (SELECT 1 FROM state_transitions WHERE machine='consent' AND from_state=OLD.state AND to_state=NEW.state)
BEGIN SELECT RAISE(ABORT,'INVALID_STATE_TRANSITION'); END;
CREATE TRIGGER teacher_sm BEFORE UPDATE OF state ON teacher_verifications
WHEN NEW.state <> OLD.state AND NOT EXISTS (SELECT 1 FROM state_transitions WHERE machine='teacher' AND from_state=OLD.state AND to_state=NEW.state)
BEGIN SELECT RAISE(ABORT,'INVALID_STATE_TRANSITION'); END;
CREATE TRIGGER privacy_sm BEFORE UPDATE OF state ON privacy_requests
WHEN NEW.state <> OLD.state AND NOT EXISTS (SELECT 1 FROM state_transitions WHERE machine='privacy' AND from_state=OLD.state AND to_state=NEW.state)
BEGIN SELECT RAISE(ABORT,'INVALID_STATE_TRANSITION'); END;
