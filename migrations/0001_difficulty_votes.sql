-- P1：难度投票
--
-- 应用方式（建库后二选一）：
--   npx wrangler d1 migrations apply ze-map-community --local    本地
--   npx wrangler d1 migrations apply ze-map-community --remote   线上
--
-- 设计要点：
-- * (map_slug, ip_hash) 是主键 —— 天然实现「一个 IP 对一张图只有一票」，
--   重复投票走 UPSERT 改票，不新增行。
-- * ip_hash 是 sha256(盐 + IP)，**不存明文 IP**：够用来限流与封禁，
--   又不构成个人信息收集。
-- * 不存昵称/联系方式（那是 P2 投稿才需要的东西），P1 尽量少收数据。

CREATE TABLE IF NOT EXISTS difficulty_votes (
  map_slug   TEXT    NOT NULL,
  value      TEXT    NOT NULL,   -- 必须是 shared/difficulty.mjs 里的枚举值
  ip_hash    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (map_slug, ip_hash)
);

CREATE INDEX IF NOT EXISTS idx_votes_map ON difficulty_votes (map_slug);


-- 写入限流：按 (ip_hash, 小时) 计数。
-- 用 UPSERT + RETURNING 一条语句完成「自增并读回」，避免并发下的竞态。
CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash TEXT    NOT NULL,
  window  TEXT    NOT NULL,   -- ISO 小时，如 '2026-09-24T06'
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window)
);
