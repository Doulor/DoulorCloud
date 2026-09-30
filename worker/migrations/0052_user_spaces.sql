-- 个人空间（公开主页）：展示设置
--
-- 背景：社区广场里有头像和用户名，但点进去什么都没有 —— 看不到这个人是谁、
-- 做过什么。本次加一个「个人空间」页（/space/<用户名>），把**账号级**的数据
-- 汇总展示出来：称号、成就墙、统计、历史帖子、历史贡献。
--
-- 与「个人名片」（profiles）的区别：
--   · 名片是**手工编排**的展示页（主题、模块、背景音乐），未发布就只有自己看；
--   · 空间是**数据驱动**的自动首页（帖子/成就/贡献），每个账号都有，无需开通。
--   两者的入口不同，谁也不替代谁。
--
-- 这张表只存「展示设置」：各分区开关 + 一句话签名。
-- 其余内容全部实时从各业务表算出来（不冗余落库，避免数据不一致）。
--
-- 关于「历史贡献」的可见性：捐献记录里含 API Key / 订阅链接等凭据，
-- **任何情况下都不会下发**；接口只回传「类型 + 时间 + 计数」这类非敏感字段，
-- 且查看者缺少对应模块权限时由**服务端**直接打码（不靠 CSS 遮挡）。
-- show_contributions 是主人自己的开关（默认开），关掉后连打码记录都不出现。

CREATE TABLE IF NOT EXISTS user_spaces (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 分区开关（1=展示，0=隐藏）
  show_achievements  INTEGER NOT NULL DEFAULT 1,
  show_stats         INTEGER NOT NULL DEFAULT 1,
  show_posts         INTEGER NOT NULL DEFAULT 1,
  show_contributions INTEGER NOT NULL DEFAULT 1,
  -- 一句话签名（展示在空间头部，NULL/空 = 不显示）
  motto              TEXT,
  updated_at         TEXT NOT NULL
);
