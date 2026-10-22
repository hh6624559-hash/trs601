-- Chia sẻ bài giảng trong phòng: bảng trắng (nét vẽ chuẩn hoá 0–1) + chia sẻ màn hình (trạng thái; media đi P2P, máy chủ không thấy).
ALTER TABLE rooms ADD COLUMN screen_by TEXT REFERENCES users(id);
ALTER TABLE rooms ADD COLUMN screen_stream TEXT;
ALTER TABLE rooms ADD COLUMN board_on INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN board_page INTEGER NOT NULL DEFAULT 0 CHECK (board_page BETWEEN 0 AND 19);
ALTER TABLE room_members ADD COLUMN board_ok INTEGER NOT NULL DEFAULT 0;
CREATE TABLE room_board_strokes (
  room_id TEXT NOT NULL REFERENCES rooms(id), n INTEGER NOT NULL, page INTEGER NOT NULL CHECK (page BETWEEN 0 AND 19),
  user_id TEXT NOT NULL REFERENCES users(id), payload TEXT NOT NULL CHECK (length(payload) <= 8000), created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, n)
);
CREATE INDEX room_board_page ON room_board_strokes(room_id, page);
