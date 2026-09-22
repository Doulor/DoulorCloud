-- 个人名片：新增排版(layout)与音乐封面(music_cover)字段
--
-- layout: 单值字符串，存排版预设 id（与主题/动效/字体独立混搭）
--   可选值: center / side / split / plain
--     center = 居中卡片（传统 link-in-bio 纵向居中）
--     side   = 侧栏型（头像在左，信息在右，像个人主页）
--     split  = 分屏型（背景大图 + 浮层信息）
--     plain  = 极简列（无卡片容器，纯文字排版）
--
-- music_cover_key / music_cover_url: 音乐专辑封面（上传存 R2 / 或外链）
--   读取时优先 key（上传的），否则用 url。与头像、背景同机制。

ALTER TABLE profiles ADD COLUMN layout          TEXT NOT NULL DEFAULT 'center';
ALTER TABLE profiles ADD COLUMN music_cover_key TEXT;
ALTER TABLE profiles ADD COLUMN music_cover_url TEXT;
