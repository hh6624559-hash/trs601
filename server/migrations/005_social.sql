-- 005: cộng đồng bạn học an toàn (S9) – chặn tách bảng riêng, báo cáo có bằng chứng chụp lại

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id), tenant_id TEXT NOT NULL, avatar_key TEXT NOT NULL DEFAULT 'av-fox',
  hat_key TEXT, bio TEXT CHECK (bio IS NULL OR length(bio) <= 140), goal TEXT,
  privacy TEXT NOT NULL DEFAULT '{"show_streak":true,"show_badges":true}'
);
CREATE TABLE friend_links (
  tenant_id TEXT NOT NULL, user_a TEXT NOT NULL REFERENCES users(id), user_b TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK (state IN ('pending','active','removed')), requested_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (user_a < user_b), PRIMARY KEY (user_a, user_b)
);
CREATE TRIGGER friend_sm BEFORE UPDATE OF state ON friend_links
WHEN NEW.state <> OLD.state AND NOT EXISTS (SELECT 1 FROM state_transitions WHERE machine='friend' AND from_state=OLD.state AND to_state=NEW.state)
  AND NOT (OLD.state='removed' AND NEW.state='pending')
BEGIN SELECT RAISE(ABORT,'INVALID_STATE_TRANSITION'); END;
CREATE TABLE user_blocks (
  tenant_id TEXT NOT NULL, blocker_id TEXT NOT NULL REFERENCES users(id), blocked_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, CHECK (blocker_id <> blocked_id), PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE chat_channels (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('dm','class')), ref_id TEXT, created_at TEXT NOT NULL,
  UNIQUE (tenant_id, id), UNIQUE (kind, ref_id)
);
CREATE TABLE channel_members (
  tenant_id TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member', muted_until TEXT, PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES chat_channels(tenant_id, id)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, channel_id TEXT NOT NULL, sender_id TEXT NOT NULL REFERENCES users(id),
  body_kind TEXT NOT NULL DEFAULT 'free' CHECK (body_kind IN ('free','preset')), preset_key TEXT,
  body TEXT NOT NULL CHECK (length(body) <= 1000), created_at TEXT NOT NULL, hidden_at TEXT, hidden_reason TEXT,
  CHECK (body_kind = 'free' OR preset_key IS NOT NULL),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES chat_channels(tenant_id, id)
);
CREATE INDEX messages_channel ON messages(channel_id, created_at);
CREATE TABLE reports (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, reporter_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('message','user','session')), target_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('bullying','unsafe_contact','self_harm','inappropriate','spam','other')),
  evidence TEXT NOT NULL,                              -- ảnh chụp nội dung tại thời điểm báo cáo
  severity INTEGER NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3), assigned_to TEXT, sla_due_at TEXT,
  state TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (state IN ('RECEIVED','IN_REVIEW','ESCALATED','ACTIONED','DISMISSED')),
  auto_flagged INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX reports_queue ON reports(state, severity, created_at);
CREATE TRIGGER reports_sm BEFORE UPDATE OF state ON reports
WHEN NEW.state <> OLD.state AND NOT EXISTS (SELECT 1 FROM state_transitions WHERE machine='report' AND from_state=OLD.state AND to_state=NEW.state)
BEGIN SELECT RAISE(ABORT,'INVALID_STATE_TRANSITION'); END;
CREATE TABLE moderation_actions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, report_id TEXT NOT NULL REFERENCES reports(id), moderator_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('hide_message','warn','suspend_user','notify_guardian','dismiss','escalate')), note TEXT, created_at TEXT NOT NULL
);
-- Nhật ký ai đã xem dữ liệu của trẻ (giám hộ/giáo viên/admin) – hiển thị cho giám hộ.
CREATE TABLE data_access_log (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject_id TEXT NOT NULL REFERENCES users(id), viewer_id TEXT NOT NULL REFERENCES users(id),
  viewer_role TEXT NOT NULL, what TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX dal_subject ON data_access_log(subject_id, created_at);
