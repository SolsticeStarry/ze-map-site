-- 单项 / 整页修订共用一张队列：mode = single | full
ALTER TABLE page_revisions ADD COLUMN mode TEXT NOT NULL DEFAULT 'full';
CREATE INDEX IF NOT EXISTS idx_page_revision_mode ON page_revisions(mode, status, created_at);
