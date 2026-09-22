-- Doulor Cloud D1 迁移：临时分享箱（tempbox）
-- 在 0015 之上执行（保持幂等）。
--
-- 设计要点：
--   * `tempbox_batches`：一次上传 = 一个批次，对应一个 4 位数字接收码。
--     文件存在 R2 的 `temporary/<code>/<filename>` 下（与网盘 / 名片等
--     明确隔离），本表只记批次元信息与过期时间。
--   * 接收码 0000-9999 范围内生成，碰撞则重试。
--   * 访问公开、上传需登录（`tempbox_upload_requires_login` 可关）。
--   * 过期清理采用「惰性删除」：下载/查询时发现已过期即删除该批次的
--     R2 对象并返回 404，不依赖定时任务。

CREATE TABLE IF NOT EXISTS tempbox_batches (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE COLLATE NOCASE, -- 4 位数字接收码
  creator_user_id TEXT,                              -- 上传者（登录上传）；NULL=允许匿名时
  expire_at     TEXT NOT NULL,                       -- 过期时间（ISO）
  file_count    INTEGER NOT NULL DEFAULT 0,
  total_bytes   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tempbox_expire ON tempbox_batches(expire_at);

-- 默认设置项
INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES
  ('tempbox_enabled', '1', datetime('now')),               -- 总开关
  ('tempbox_default_minutes', '30', datetime('now')),      -- 默认保存时长（分钟）
  ('tempbox_max_file_bytes', '268435456', datetime('now')),-- 单文件上限（256 MiB）
  ('tempbox_max_files', '20', datetime('now')),            -- 每批次文件数上限
  ('tempbox_upload_requires_login', '1', datetime('now')); -- 上传是否必须登录