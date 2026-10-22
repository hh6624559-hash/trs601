-- 003: kho cá nhân, lộ trình (S3); lớp, bài giao, buổi học (S4, S8)

CREATE TABLE classes (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES organizations(id), teacher_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80), join_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL, UNIQUE (tenant_id, id)
);
CREATE TABLE class_members (
  tenant_id TEXT NOT NULL, class_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'learner' CHECK (role IN ('learner','assistant')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (class_id, user_id),
  FOREIGN KEY (tenant_id, class_id) REFERENCES classes(tenant_id, id)
);
CREATE INDEX class_members_user ON class_members(user_id) WHERE status='active';

CREATE TABLE assignments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, class_id TEXT NOT NULL, title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  due_at TEXT, created_by TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, class_id) REFERENCES classes(tenant_id, id)
);
CREATE TABLE assignment_items (assignment_id TEXT NOT NULL REFERENCES assignments(id), sense_id TEXT NOT NULL REFERENCES senses(id), position INTEGER NOT NULL, PRIMARY KEY (assignment_id, sense_id));

CREATE TABLE learner_collections (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES organizations(id), owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  source TEXT NOT NULL CHECK (source IN ('self','teacher','shared','system')),
  assignment_id TEXT REFERENCES assignments(id), locked INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','friends','class')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  topic TEXT, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id),
  CHECK (source <> 'teacher' OR (assignment_id IS NOT NULL AND locked = 1))
);
CREATE INDEX collections_owner ON learner_collections(owner_id, status);
-- DI-018: chủ sở hữu không archive/pause được bộ có locked = 1 (bài giao bắt buộc).
CREATE TRIGGER forbid_locked_collection_archive BEFORE UPDATE OF status ON learner_collections
WHEN OLD.locked = 1 AND NEW.status IN ('archived','paused') AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT,'locked collection cannot be archived or paused'); END;
CREATE TRIGGER forbid_locked_collection_delete BEFORE DELETE ON learner_collections WHEN OLD.locked = 1
BEGIN SELECT RAISE(ABORT,'locked collection cannot be deleted'); END;

CREATE TABLE collection_items (
  tenant_id TEXT NOT NULL, collection_id TEXT NOT NULL, sense_id TEXT NOT NULL REFERENCES senses(id),
  position INTEGER, added_at TEXT NOT NULL, removed_at TEXT, note TEXT,
  PRIMARY KEY (collection_id, sense_id),
  FOREIGN KEY (tenant_id, collection_id) REFERENCES learner_collections(tenant_id, id)
);
CREATE TRIGGER forbid_locked_item_remove BEFORE UPDATE OF removed_at ON collection_items
WHEN NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL AND (SELECT locked FROM learner_collections WHERE id = OLD.collection_id) = 1
BEGIN SELECT RAISE(ABORT,'locked collection item cannot be removed'); END;

CREATE TABLE learning_paths (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  goal TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')), created_at TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE TABLE learning_path_steps (
  tenant_id TEXT NOT NULL, path_id TEXT NOT NULL, position INTEGER NOT NULL, collection_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','paused','done','replaced')),
  replaced_by_position INTEGER,
  PRIMARY KEY (path_id, position),
  FOREIGN KEY (tenant_id, path_id) REFERENCES learning_paths(tenant_id, id),
  FOREIGN KEY (tenant_id, collection_id) REFERENCES learner_collections(tenant_id, id)
);

CREATE TABLE hard_reports (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, collection_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  note TEXT CHECK (note IS NULL OR length(note) <= 300), created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, collection_id) REFERENCES learner_collections(tenant_id, id)
);

CREATE TABLE classroom_sessions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, class_id TEXT NOT NULL, teacher_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  starts_at TEXT NOT NULL, duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 240),
  provider TEXT NOT NULL DEFAULT 'external_link', room_url TEXT, fallback_url TEXT,
  locked INTEGER NOT NULL DEFAULT 0, recording INTEGER NOT NULL DEFAULT 0 CHECK (recording = 0),  -- không ghi hình mặc định
  state TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (state IN ('SCHEDULED','READY','LIVE','ENDED','CANCELLED')),
  created_at TEXT NOT NULL, UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, class_id) REFERENCES classes(tenant_id, id)
);
CREATE TRIGGER classroom_sm BEFORE UPDATE OF state ON classroom_sessions
WHEN NEW.state <> OLD.state AND NOT EXISTS (SELECT 1 FROM state_transitions WHERE machine='classroom' AND from_state=OLD.state AND to_state=NEW.state)
BEGIN SELECT RAISE(ABORT,'INVALID_STATE_TRANSITION'); END;
CREATE TABLE attendance_records (
  session_id TEXT NOT NULL REFERENCES classroom_sessions(id), user_id TEXT NOT NULL REFERENCES users(id), tenant_id TEXT NOT NULL,
  join_intent_at TEXT,                                -- tạo token/bấm vào ≠ có mặt
  present INTEGER NOT NULL DEFAULT 0, marked_by TEXT, source TEXT NOT NULL DEFAULT 'teacher' CHECK (source IN ('teacher','webhook')), marked_at TEXT,
  PRIMARY KEY (session_id, user_id)
);
