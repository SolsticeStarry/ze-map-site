-- P2：社区投稿队列
--
-- 应用方式：
--   npx wrangler d1 migrations apply ze-map-community --local    本地
--   npx wrangler d1 migrations apply ze-map-community --remote   线上
--
-- 设计要点：
-- * 投稿先进这里排队，**审核通过后才写回 git 的 data/community/<slug>.json**。
--   D1 只是「还没进仓库的东西」，随时可以清库重来而不丢已发布内容。
-- * status 四态：
--     pending   待审
--     approved  审核通过、还没写回 git
--     applied   已写回 git（commit_sha 记录了是哪个提交）
--     rejected  驳回（reject_note 是给投稿人看的理由）
-- * 不存明文 IP，只存加盐哈希（同 P1）。

CREATE TABLE IF NOT EXISTS submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  map_slug    TEXT    NOT NULL,              -- ze_flowering
  field       TEXT    NOT NULL,              -- shared/submission-fields.mjs 里的字段名
  value       TEXT    NOT NULL,              -- JSON 编码后的值
  note        TEXT,                          -- 投稿人给审核员看的理由/来源说明
  submitter   TEXT,                          -- 昵称（选填）
  contact     TEXT,                          -- QQ/邮箱（选填，便于追问）
  ip_hash     TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewer    TEXT,
  reject_note TEXT,
  commit_sha  TEXT,
  error       TEXT                           -- 写回 git 失败时的错误信息
);

CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions (status, created_at);
CREATE INDEX IF NOT EXISTS idx_sub_map    ON submissions (map_slug, field);

-- 封禁（滥用者）。ip_hash 与 P1 同一套算法，所以投票和投稿一起被封。
CREATE TABLE IF NOT EXISTS bans (
  ip_hash   TEXT PRIMARY KEY,
  reason    TEXT,
  banned_at INTEGER NOT NULL
);
