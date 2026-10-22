-- 002: từ vựng song ngữ, lịch ôn (append-only), kinh tế (S2a/S2b/S7)

CREATE TABLE lexemes (
  id TEXT PRIMARY KEY, lemma TEXT NOT NULL, lemma_norm TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'en',
  cefr TEXT CHECK (cefr IN ('A1','A2','B1','B2','C1','C2')), frequency_rank INTEGER,
  source_id TEXT, license TEXT NOT NULL,
  UNIQUE (lang, lemma)
);
CREATE INDEX lexemes_norm ON lexemes(lemma_norm);

CREATE TABLE senses (
  id TEXT PRIMARY KEY, lexeme_id TEXT NOT NULL REFERENCES lexemes(id),
  owner_tenant_id TEXT REFERENCES organizations(id),   -- NULL = nội dung hệ thống
  pos TEXT NOT NULL, ipa TEXT, definition_en TEXT NOT NULL, definition_vi TEXT, definition_vi_norm TEXT,
  example_en TEXT, example_vi TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','published','retired')),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX senses_lexeme ON senses(lexeme_id);
CREATE INDEX senses_vi_norm ON senses(definition_vi_norm);

CREATE TABLE sense_topics (sense_id TEXT NOT NULL REFERENCES senses(id), topic TEXT NOT NULL, PRIMARY KEY (sense_id, topic));
CREATE INDEX sense_topics_topic ON sense_topics(topic);

CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, license TEXT NOT NULL, url TEXT);

-- Append-only; PK (user_id,id) khử trùng theo (user, event id do client sinh).
CREATE TABLE review_events (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), sense_id TEXT NOT NULL REFERENCES senses(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  client_at TEXT,                                    -- không tin cậy
  received_at TEXT NOT NULL,                         -- cơ sở sắp xếp tin cậy
  seq INTEGER NOT NULL,                              -- thứ tự nhận (tie-break ổn định sau received_at)
  source TEXT NOT NULL DEFAULT 'review' CHECK (source IN ('review','game','undo')),
  reverses_id TEXT,                                  -- hoàn tác = sự kiện bù, không xoá
  device_id TEXT,
  algo_version TEXT NOT NULL, schema_version INTEGER NOT NULL,
  PRIMARY KEY (user_id, id),
  CHECK ((source = 'undo') = (reverses_id IS NOT NULL))
);
CREATE INDEX review_events_user_time ON review_events(user_id, received_at, seq);
CREATE INDEX review_events_user_sense ON review_events(user_id, sense_id, received_at, seq);
CREATE TRIGGER review_events_ro_u BEFORE UPDATE ON review_events BEGIN SELECT RAISE(ABORT,'review_events is append-only'); END;
CREATE TRIGGER review_events_ro_d BEFORE DELETE ON review_events BEGIN SELECT RAISE(ABORT,'review_events is append-only'); END;

CREATE TABLE learner_sense_state (
  tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), sense_id TEXT NOT NULL REFERENCES senses(id),
  stability REAL NOT NULL, difficulty REAL NOT NULL, due_at TEXT NOT NULL, last_review_at TEXT,
  reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, leech INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('new','learning','review','relearning','suspended')),
  introduced_at TEXT,
  scheduler_version TEXT NOT NULL, row_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, sense_id)
);
CREATE INDEX lss_due ON learner_sense_state(user_id, due_at) WHERE state <> 'suspended';

CREATE TABLE streaks (
  user_id TEXT PRIMARY KEY REFERENCES users(id), tenant_id TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 0, best INTEGER NOT NULL DEFAULT 0, last_day TEXT,
  freeze_tokens INTEGER NOT NULL DEFAULT 1 CHECK (freeze_tokens BETWEEN 0 AND 3), last_freeze_week TEXT,
  broken_value INTEGER NOT NULL DEFAULT 0, last_repair_month TEXT
);

CREATE TABLE economy_accounts (user_id TEXT PRIMARY KEY REFERENCES users(id), tenant_id TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0));
CREATE TABLE economy_ledger (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL CHECK (delta <> 0), reason TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
  reverses_id TEXT REFERENCES economy_ledger(id), created_at TEXT NOT NULL,
  UNIQUE (user_id, ref_type, ref_id, reason)
);
CREATE TRIGGER ledger_ro_u BEFORE UPDATE ON economy_ledger BEGIN SELECT RAISE(ABORT,'economy_ledger is append-only'); END;
CREATE TRIGGER ledger_ro_d BEFORE DELETE ON economy_ledger BEGIN SELECT RAISE(ABORT,'economy_ledger is append-only'); END;

CREATE TABLE shop_items (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('avatar','hat','theme','sticker_pack')), name_vi TEXT NOT NULL, name_en TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0), active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE inventory_items (user_id TEXT NOT NULL REFERENCES users(id), item_id TEXT NOT NULL REFERENCES shop_items(id), acquired_at TEXT NOT NULL, PRIMARY KEY (user_id, item_id));

CREATE TABLE sticker_collection (user_id TEXT NOT NULL REFERENCES users(id), sense_id TEXT NOT NULL REFERENCES senses(id), earned_at TEXT NOT NULL, PRIMARY KEY (user_id, sense_id));

INSERT INTO shop_items(id,kind,name_vi,name_en,price) VALUES
 ('av-fox','avatar','Cáo Cam','Orange Fox',30),('av-owl','avatar','Cú Đêm','Night Owl',30),('av-frog','avatar','Ếch Rêu','Moss Frog',30),('av-cat','avatar','Mèo Bút Chì','Pencil Cat',50),
 ('hat-beret','hat','Mũ nồi hoạ sĩ','Painter beret',20),('hat-grad','hat','Mũ tốt nghiệp','Graduation cap',40),
 ('th-night','theme','Giao diện Đêm sao','Starry night theme',60);
