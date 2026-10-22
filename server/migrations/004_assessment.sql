-- 004: ngân hàng câu hỏi có version, dựng đề, attempt, chấm (S5, S6b)

CREATE TABLE questions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES organizations(id), created_by TEXT NOT NULL REFERENCES users(id),
  bank TEXT NOT NULL DEFAULT 'official' CHECK (bank IN ('official','practice')), created_at TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE TABLE question_versions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, question_id TEXT NOT NULL, version INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('mcq_single','fill_blank','matching')),
  body TEXT NOT NULL, answer_key TEXT NOT NULL, scoring TEXT NOT NULL,
  cefr TEXT CHECK (cefr IN ('A1','A2','B1','B2','C1','C2')), topic TEXT, target_sense_id TEXT REFERENCES senses(id),
  explanation_en TEXT, explanation_vi TEXT,
  source TEXT NOT NULL DEFAULT 'teacher' CHECK (source IN ('teacher','generated','ai')),
  status TEXT NOT NULL CHECK (status IN ('draft','in_review','approved','published','retired')),
  approved_by TEXT REFERENCES users(id),
  published_at TEXT, retired_at TEXT, created_at TEXT NOT NULL,
  UNIQUE (question_id, version),
  FOREIGN KEY (tenant_id, question_id) REFERENCES questions(tenant_id, id),
  CHECK (source <> 'ai' OR status IN ('draft','in_review') OR approved_by IS NOT NULL)   -- DI-012: AI chỉ qua sau duyệt người
);
CREATE INDEX qv_pool ON question_versions(tenant_id, status, type);

-- DI-002: sửa lỗi v26 – cho đúng MỘT chuyển published→retired với nội dung không đổi; chặn DELETE.
CREATE TRIGGER qv_no_delete BEFORE DELETE ON question_versions WHEN OLD.status IN ('published','retired')
BEGIN SELECT RAISE(ABORT,'published question version cannot be deleted'); END;
CREATE TRIGGER qv_guard BEFORE UPDATE ON question_versions
WHEN OLD.status IN ('published','retired') AND NOT (
  OLD.status='published' AND NEW.status='retired' AND NEW.question_id IS OLD.question_id AND NEW.version IS OLD.version
  AND NEW.type IS OLD.type AND NEW.body IS OLD.body AND NEW.answer_key IS OLD.answer_key AND NEW.scoring IS OLD.scoring)
BEGIN SELECT RAISE(ABORT,'published question version is immutable'); END;
CREATE TRIGGER qv_sm BEFORE UPDATE OF status ON question_versions
WHEN NEW.status <> OLD.status AND NOT EXISTS (SELECT 1 FROM state_transitions WHERE machine='qversion' AND from_state=OLD.status AND to_state=NEW.status)
BEGIN SELECT RAISE(ABORT,'INVALID_STATE_TRANSITION'); END;

CREATE TABLE exam_compositions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('practice','official')), blueprint TEXT NOT NULL, seed INTEGER NOT NULL,
  prng TEXT NOT NULL, bank_snapshot_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (tenant_id, id)
);
CREATE TABLE exam_composition_items (
  composition_id TEXT NOT NULL REFERENCES exam_compositions(id), position INTEGER NOT NULL,
  question_version_id TEXT NOT NULL REFERENCES question_versions(id),
  option_order TEXT,                                  -- thứ tự lựa chọn đã cân bằng vị trí đáp án (MCQ)
  PRIMARY KEY (composition_id, position)
);
-- Đề đã giao là snapshot bất biến.
CREATE TRIGGER eci_ro_u BEFORE UPDATE ON exam_composition_items BEGIN SELECT RAISE(ABORT,'composition items are immutable'); END;
CREATE TRIGGER eci_ro_d BEFORE DELETE ON exam_composition_items BEGIN SELECT RAISE(ABORT,'composition items are immutable'); END;

CREATE TABLE assessments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, class_id TEXT, composition_id TEXT NOT NULL REFERENCES exam_compositions(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80), kind TEXT NOT NULL CHECK (kind IN ('practice','official')),
  opens_at TEXT, closes_at TEXT, duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 1 AND 300),
  max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 20), show_answers INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','closed')),
  created_at TEXT NOT NULL, UNIQUE (tenant_id, id)
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  assessment_id TEXT NOT NULL REFERENCES assessments(id), composition_id TEXT NOT NULL REFERENCES exam_compositions(id),
  attempt_no INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CREATED','IN_PROGRESS','SUBMITTED','GRADING','GRADED','EXPIRED','INVALIDATED','GRADING_FAILED','CANCELLED')),
  order_seed INTEGER NOT NULL,                        -- xáo thứ tự câu theo attempt
  started_at TEXT, deadline_at TEXT, submitted_at TEXT, time_multiplier REAL NOT NULL DEFAULT 1.0,
  tab_blur_count INTEGER NOT NULL DEFAULT 0,          -- tín hiệu cho giáo viên, KHÔNG tự trừ điểm
  created_at TEXT NOT NULL,
  UNIQUE (assessment_id, user_id, attempt_no)
);
CREATE UNIQUE INDEX uq_attempt_open ON attempts(user_id, assessment_id) WHERE state IN ('CREATED','IN_PROGRESS');   -- DI-025
CREATE TRIGGER attempts_sm BEFORE UPDATE OF state ON attempts
WHEN NEW.state <> OLD.state AND NOT EXISTS (SELECT 1 FROM state_transitions WHERE machine='attempt' AND from_state=OLD.state AND to_state=NEW.state)
BEGIN SELECT RAISE(ABORT,'INVALID_STATE_TRANSITION'); END;

CREATE TABLE attempt_items (
  attempt_id TEXT NOT NULL REFERENCES attempts(id), position INTEGER NOT NULL, composition_position INTEGER NOT NULL,
  answer TEXT, answered_at TEXT,
  PRIMARY KEY (attempt_id, position)
);
CREATE TABLE grading_results (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), score REAL NOT NULL, max_score REAL NOT NULL,
  per_item TEXT NOT NULL, grader_version TEXT NOT NULL, graded_at TEXT NOT NULL
);
CREATE TRIGGER grading_ro_u BEFORE UPDATE ON grading_results BEGIN SELECT RAISE(ABORT,'grading_results is immutable'); END;
