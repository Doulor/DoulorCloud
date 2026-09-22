-- Doulor Cloud Profile 名片
--
-- 设计要点：
--   * `slug` 是公开路径 /profile/<slug>，默认取用户名；独立于 users.username，
--     这样用户改名不会让已分享出去的名片链接失效。
--   * `published` 控制是否对外可见；关闭时公开页返回 404。
--   * 资源（头像/背景/音乐）有两种来源：
--       - 上传：存 R2，键名写在 *_key 字段
--       - 外链：直接存 URL 在 *_url 字段
--     两者互斥，读取时优先 key（上传的），否则用 url。
--   * `contacts` 是 JSON 数组，元素形如
--       {"type":"qq","value":"2737855297","label":"","visible":true}
--     由服务端在渲染时拼成链接，前端只存原始值。
--   * 自定义域名复用 subdomains 表，与网盘直链（storage_prefixes）互斥，
--     同一子域名只能绑定其中一种，绑定前会双向检查。

CREATE TABLE IF NOT EXISTS profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- 公开标识与开关
  slug         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  published    INTEGER NOT NULL DEFAULT 0,

  -- 基本资料
  display_name TEXT,
  bio          TEXT,                    -- 个性签名
  avatar_key   TEXT,                    -- R2: profiles/<username>/avatar.<ext>
  avatar_url   TEXT,                    -- 外链头像
  background_key TEXT,                  -- R2: profiles/<username>/background.<ext>
  background_url TEXT,
  music_key    TEXT,                    -- R2: profiles/<username>/music.<ext>
  music_url    TEXT,                    -- 外链音乐
  music_title  TEXT,
  music_autoplay INTEGER NOT NULL DEFAULT 0,

  -- 外观
  theme        TEXT NOT NULL DEFAULT 'minimal',
  accent       TEXT,                    -- 主题色（可选覆盖）

  -- 联系方式（JSON 数组，见文件头说明）
  contacts     TEXT NOT NULL DEFAULT '[]',

  -- 自定义域名（复用 subdomains；NULL = 仅用 /profile/<slug>）
  subdomain_id TEXT REFERENCES subdomains(id) ON DELETE SET NULL,
  fqdn         TEXT,

  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profiles_slug ON profiles(slug);
CREATE INDEX IF NOT EXISTS idx_profiles_subdomain ON profiles(subdomain_id);
CREATE INDEX IF NOT EXISTS idx_profiles_fqdn ON profiles(fqdn);

-- 注意：**不预建记录**。是否「已开通名片」以本表有无该用户的记录判断，
-- 与 storage_accounts / newapi_accounts 的做法完全一致：
-- 没有记录 → 前端显示开通引导页；用户点击开通后才插入。