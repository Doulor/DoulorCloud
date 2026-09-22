-- 个人名片：新增动效(effects)、开屏动画(intro)、字体(font)字段
--
-- effects: JSON 数组字符串，存独立勾选的动效 id 列表
--   示例: ["particles","tilt","glow"]
--   可选值: particles / tilt / glitch / glow / rain / sparkle
--   互斥规则在渲染层处理（particles 与 rain 不能共存，保留 particles）
--
-- intro: 单值字符串，存开屏动画 id
--   可选值: none / enter / portal / fade / slide
--   enter/portal 为交互式（点击进入），fade/slide 为非交互式（自动播放）
--
-- font: 单值字符串，存自托管字体 id
--   可选值: system / space / orbitron / jetbrains / audiowide / playfair / cinzel / poppins / bebas
--   字体文件托管在静态站点 /fonts/<id>.woff2，仅英文/拉丁字符，中文回退系统字体栈

ALTER TABLE profiles ADD COLUMN effects TEXT NOT NULL DEFAULT '[]';
ALTER TABLE profiles ADD COLUMN intro   TEXT NOT NULL DEFAULT 'none';
ALTER TABLE profiles ADD COLUMN font    TEXT NOT NULL DEFAULT 'system';
