-- 009: bộ từ do giáo viên nhập (CSV/TSV dán hoặc tải lên). Từ thuộc tổ chức (senses.owner_tenant_id) — tổ chức khác không thấy.
CREATE TABLE vocab_lists (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id), item_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX vocab_lists_tenant ON vocab_lists(tenant_id, created_at);
CREATE TABLE vocab_list_items (
  list_id TEXT NOT NULL REFERENCES vocab_lists(id), sense_id TEXT NOT NULL REFERENCES senses(id), position INTEGER NOT NULL,
  PRIMARY KEY (list_id, sense_id)
);
