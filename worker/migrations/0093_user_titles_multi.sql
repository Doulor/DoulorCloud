-- 称号支持「一人多个 + 自己选展示哪一个」（2026-10-01 站长要求）
--
-- 原来 `user_titles.user_id` 是**主键** ⇒ 设计上「一人最多一个自定义称号」，
-- 授予第二个会覆盖第一个。现在改成 (user_id, title_id) 联合主键 = 可持多个，
-- 并加 `is_display` 标记「当前对外展示的是哪一个」。
--
-- 唯一性保证：`is_display = 1` 的部分唯一索引 ⇒ 每人同时只能展示一个。
-- 存量数据：把原有的每行都标成 is_display = 1（原来一人就一个，行为不变）。
--
-- SQLite 改主键只能重建表（不能 ALTER PRIMARY KEY），所以走 新建→搬数据→换名。

CREATE TABLE IF NOT EXISTS user_titles_new (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id   TEXT NOT NULL REFERENCES custom_titles(id) ON DELETE CASCADE,
  /** 1 = 当前对外展示的称号（每人最多一个，见下面的部分唯一索引） */
  is_display INTEGER NOT NULL DEFAULT 0,
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, title_id)
);

INSERT INTO user_titles_new (user_id, title_id, is_display, granted_by, granted_at)
SELECT user_id, title_id, 1, granted_by, granted_at FROM user_titles;

DROP TABLE user_titles;

ALTER TABLE user_titles_new RENAME TO user_titles;

CREATE INDEX IF NOT EXISTS idx_user_titles_title ON user_titles(title_id);
-- 每人最多一个「展示中」：拿到两个称号也不会同时挂出去
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_titles_display ON user_titles(user_id) WHERE is_display = 1;
