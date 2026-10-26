-- 匿名投稿撤回：提交时返回一次性撤回码，库里只存它的哈希
ALTER TABLE page_revisions ADD COLUMN withdraw_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_page_revision_withdraw ON page_revisions (withdraw_hash);
