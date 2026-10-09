-- 网盘「目录分享」。
--
-- 背景：R2 里对象是扁平的 `<用户名>/<目录>/<文件名>`，目录只是 key 前缀，
-- 没有独立的目录表。用户希望把某个目录「一键分享」，于是需要一张表记录：
--   1. 分享的是谁（user_id）
--   2. 分享的是哪个目录（path，相对用户名根目录，'' = 根目录）
--   3. 公开访问用的随机 token（不可猜测，可随时停用/删除）
--
-- 目录本身不落表：空目录在 R2 里靠 `<key>/` 占位对象表示（MARKER_SUFFIX），
-- 建目录/列目录都以 R2 为准，避免「表里有、桶里没有」的两套账。
CREATE TABLE IF NOT EXISTS storage_shares (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- 公开访问令牌（base64url，随机）
  token TEXT NOT NULL UNIQUE,
  -- 相对该账号 prefix 的目录路径；'' 表示分享整个根目录
  path TEXT NOT NULL DEFAULT '',
  -- 可选展示名；为空时用目录名
  title TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_storage_shares_user ON storage_shares(user_id);
CREATE INDEX IF NOT EXISTS idx_storage_shares_token ON storage_shares(token);
