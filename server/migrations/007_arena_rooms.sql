-- 007: Đấu trường (§8) + Phòng học (§7). Trạng thái và thời điểm do SERVER ghi; client chỉ gửi ý định.

CREATE TABLE rooms (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK (kind IN ('personal','group','class','arena')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80), host_id TEXT NOT NULL REFERENCES users(id),
  class_id TEXT REFERENCES classes(id), state TEXT NOT NULL CHECK (state IN ('SCHEDULED','WAITING','LIVE','ENDED','CANCELLED')),
  waiting_room INTEGER NOT NULL DEFAULT 1, locked INTEGER NOT NULL DEFAULT 0, max_people INTEGER NOT NULL DEFAULT 20 CHECK (max_people BETWEEN 2 AND 30),
  provider TEXT NOT NULL DEFAULT 'p2p', provider_room TEXT NOT NULL,           -- UUID ngẫu nhiên, KHÔNG phải mã công khai
  fallback_url TEXT, scheduled_for TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, last_activity_at TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE INDEX rooms_state ON rooms(state, last_activity_at);
CREATE TABLE room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id), user_id TEXT NOT NULL REFERENCES users(id),   -- DI-022: đúng một bản ghi / (phòng, người)
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('host','cohost','member')),
  state TEXT NOT NULL CHECK (state IN ('waiting','admitted','left','kicked','denied')),
  cam_allowed INTEGER NOT NULL DEFAULT 0, mic_allowed INTEGER NOT NULL DEFAULT 0, mic_muted_by_host INTEGER NOT NULL DEFAULT 0, hand_up INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (room_id, user_id)
);
CREATE TABLE room_invites (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL, max_uses INTEGER NOT NULL DEFAULT 20, uses INTEGER NOT NULL DEFAULT 0, revoked_at TEXT, created_at TEXT NOT NULL
);
-- Nhật ký sự kiện phòng (điểm danh, tín hiệu WebRTC, chat). seq tăng đơn điệu theo phòng → client resume bằng lastSeq (P-12).
CREATE TABLE room_events (
  room_id TEXT NOT NULL REFERENCES rooms(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, actor_id TEXT, to_user TEXT, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, seq)
);
CREATE TRIGGER room_sm BEFORE UPDATE OF state ON rooms
WHEN NEW.state <> OLD.state AND NOT EXISTS (SELECT 1 FROM state_transitions WHERE machine='room' AND from_state=OLD.state AND to_state=NEW.state)
BEGIN SELECT RAISE(ABORT,'INVALID_STATE_TRANSITION'); END;

CREATE TABLE arena_matches (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES organizations(id), host_id TEXT NOT NULL REFERENCES users(id), class_id TEXT REFERENCES classes(id),
  mode TEXT NOT NULL CHECK (mode IN ('duel','blitz','spelling')), visibility TEXT NOT NULL CHECK (visibility IN ('private','class','friends','open_adults')),
  state TEXT NOT NULL CHECK (state IN ('LOBBY','READY_CHECK','ROUND_OPEN','ROUND_REVEAL','FINISHED','ABORTED')),
  code_hash TEXT UNIQUE, seed TEXT NOT NULL, rounds INTEGER NOT NULL, limit_ms INTEGER NOT NULL, round_idx INTEGER NOT NULL DEFAULT -1,
  opens_at TEXT, closes_at TEXT, reveal_until TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, last_activity_at TEXT NOT NULL,
  min_players INTEGER NOT NULL, max_players INTEGER NOT NULL, has_minor INTEGER NOT NULL DEFAULT 0,
  strict_room INTEGER NOT NULL DEFAULT 0,           -- «Phòng thi nghiêm» (v29): khóa mic lúc ROUND_OPEN; mặc định TẮT
  UNIQUE (tenant_id, id)
);
CREATE TABLE arena_players (
  match_id TEXT NOT NULL REFERENCES arena_matches(id), user_id TEXT NOT NULL REFERENCES users(id),   -- đúng một bản ghi / (trận, người)
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player','spectator')),
  state TEXT NOT NULL DEFAULT 'joined' CHECK (state IN ('joined','ready','disconnected','forfeit','left')),
  score INTEGER NOT NULL DEFAULT 0, correct_count INTEGER NOT NULL DEFAULT 0, correct_ms INTEGER NOT NULL DEFAULT 0, rank INTEGER,
  joined_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, tab_hidden INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (match_id, user_id)
);
CREATE TABLE arena_rounds (
  match_id TEXT NOT NULL REFERENCES arena_matches(id), idx INTEGER NOT NULL, question TEXT NOT NULL, opened_at TEXT, closed_at TEXT, PRIMARY KEY (match_id, idx)
);
CREATE TABLE arena_answers (
  match_id TEXT NOT NULL, idx INTEGER NOT NULL, user_id TEXT NOT NULL, answer TEXT NOT NULL, received_at TEXT NOT NULL, elapsed_ms INTEGER NOT NULL,
  correct INTEGER NOT NULL, points INTEGER NOT NULL, PRIMARY KEY (match_id, idx, user_id),             -- DI-021: một đáp án / người / vòng
  FOREIGN KEY (match_id, idx) REFERENCES arena_rounds(match_id, idx)
);
CREATE TABLE arena_events (
  match_id TEXT NOT NULL REFERENCES arena_matches(id), seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, PRIMARY KEY (match_id, seq)
);
CREATE TRIGGER arena_sm BEFORE UPDATE OF state ON arena_matches
WHEN NEW.state <> OLD.state AND NOT EXISTS (SELECT 1 FROM state_transitions WHERE machine='match' AND from_state=OLD.state AND to_state=NEW.state)
BEGIN SELECT RAISE(ABORT,'INVALID_STATE_TRANSITION'); END;
CREATE TRIGGER arena_answers_no_update BEFORE UPDATE ON arena_answers BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
CREATE TRIGGER arena_answers_no_delete BEFORE DELETE ON arena_answers BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;

INSERT INTO state_transitions(machine, from_state, to_state) VALUES
 ('match','LOBBY','READY_CHECK'),('match','READY_CHECK','ROUND_OPEN'),('match','ROUND_OPEN','ROUND_REVEAL'),('match','ROUND_REVEAL','ROUND_OPEN'),('match','ROUND_REVEAL','FINISHED'),
 ('match','LOBBY','ABORTED'),('match','READY_CHECK','ABORTED'),('match','ROUND_OPEN','ABORTED'),('match','ROUND_REVEAL','ABORTED'),('match','ROUND_OPEN','FINISHED'),('match','READY_CHECK','LOBBY'),
 ('room','SCHEDULED','WAITING'),('room','SCHEDULED','CANCELLED'),('room','WAITING','LIVE'),('room','WAITING','ENDED'),('room','WAITING','CANCELLED'),('room','LIVE','ENDED'),('room','LIVE','WAITING'),('room','SCHEDULED','LIVE');
INSERT OR IGNORE INTO feature_flags(key, enabled, owner, purpose, expires_on) VALUES
 ('arena', 1, 'owner', 'Đấu trường (S7) – trận không cam/mic; lớp do giáo viên chủ trì', '2027-06-30'),
 ('rooms', 1, 'owner', 'Phòng học (S5) – mặc định cam/mic tắt', '2027-06-30'),
 ('rooms.peer_minors', 0, 'owner', 'Phòng ngang hàng cho người dưới 18 – CHỜ rà soát pháp lý/DPIA (runbook child-safety)', '2027-06-30');
