-- P4：地图整页修订队列。
-- 玩家修订只写入 data/content/<slug>.json；research 仍只能走仓库编辑。

CREATE TABLE IF NOT EXISTS page_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  map_slug    TEXT    NOT NULL,
  user_id     INTEGER NOT NULL,
  submitter   TEXT    NOT NULL,
  payload     TEXT    NOT NULL,
  base_rev    TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewer    TEXT,
  reject_note TEXT,
  commit_sha  TEXT,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_page_revision_status ON page_revisions (status, created_at);
