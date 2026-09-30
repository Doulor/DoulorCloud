-- 0086 自定义称号（徽章式，样式对标管理员/站长的 RoleBadge）
--
-- ⚠️ 线上 d1_migrations 为空，本文件只是变更记录 —— 线上要手工执行：
--   cd worker && npx wrangler d1 execute doulor-mail --remote --file migrations/0086_custom_titles.sql
-- （记得清代理变量直连）
--
-- 设计：
--   custom_titles  称号库（名称 + 渐变双色），与用户解耦，同一个称号可授予多人；
--   user_titles    授予关系。user_id 直接做主键 ⇒ 天然「一人最多一个自定义称号」，
--                  与 RoleBadge（admin/root）可并存、并排展示。
-- 颜色约定：#RRGGBB 六位 hex，color_from / color_to 相同即纯色。
-- 文字黑/白、描边流光色均由前端按亮度自动衍生，库里只存这两个主色。

CREATE TABLE IF NOT EXISTS custom_titles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color_from TEXT NOT NULL,
  color_to TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_titles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL REFERENCES custom_titles(id) ON DELETE CASCADE,
  granted_by TEXT,
  granted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_titles_title ON user_titles(title_id);
