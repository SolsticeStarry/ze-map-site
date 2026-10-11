-- 账号系统（2026-10-11）
--
-- ⚠️ 这份 SQL 是**给人看的记录**，线上不靠它建表：Worker 第一次跑到账号接口时会自己做
--    「懒建表」（见 worker/auth.ts 的 ensureSchema）—— 因为本机的 API token 只有 R2 权限，
--    跑不了 `wrangler d1 migrations apply --remote`。想手动执行也可以，语句是幂等的。
--
-- 设计取舍：
--   · 账号只用于「署名 / 我的投稿记录 / 等级权益」，**不登录也能投稿**（匿名通道完全保留）；
--   · 不存邮箱，只存选填的联系方式（QQ），找回口令走 QQ 群找站长 —— 与现有运营方式一致；
--   · 会话用**签名 Cookie**（无状态，每次请求不查库、不查 KV）；
--   · 口令只存 PBKDF2-SHA256 派生值（15 万次迭代 + 每用户随机盐），不存明文、不存可逆哈希。

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,               -- 昵称（展示用，可改）
  name_key    TEXT    NOT NULL UNIQUE,        -- name 的小写形式，唯一约束靠它（忽略大小写重名）
  pass_hash   TEXT    NOT NULL,               -- pbkdf2$迭代次数$盐$派生值
  pass_ver    INTEGER NOT NULL DEFAULT 1,     -- 改口令时 +1：旧 Cookie 立刻失效
  contact     TEXT,                           -- 选填：QQ / 其它联系方式，便于找回与追问
  created_at  INTEGER NOT NULL,
  last_login  INTEGER,
  banned      INTEGER NOT NULL DEFAULT 0,     -- 1 = 禁止登录与投稿（与 IP 封禁互补）
  approved    INTEGER NOT NULL DEFAULT 0,     -- 已通过（写回仓库）的投稿数
  rejected    INTEGER NOT NULL DEFAULT 0      -- 被驳回的投稿数
);

CREATE INDEX IF NOT EXISTS idx_users_name_key ON users(name_key);

-- 投稿关联到账号（匿名投稿保持 user_id = NULL）
-- SQLite 的 ALTER TABLE 不支持 IF NOT EXISTS，重复执行会报 duplicate column —— 忽略即可。
ALTER TABLE submissions ADD COLUMN user_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_sub_user ON submissions(user_id, created_at);
