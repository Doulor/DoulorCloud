-- 社区「转发数」按用户去重
--
-- 背景（2026-10-01 用户反馈「社区的分享量可以无限刷，那个分享键可以一直点」）：
--   posts.share_count 原先是「接口被调一次就 +1」，一个脚本就能把它刷到任意大，
--   运营数据全部失真。2026-09-25 审计补过用户级限流（60 次 / 10 分钟），但那只是
--   降低了刷的速度 —— 同一个人照样能反复抬高同一条帖子的数字。
--   转发数的语义本就是「有多少人转过」，所以改成按 (帖子, 用户) 去重。
--
-- 只约束新增：历史 share_count 保留原值，不做回填（回填会把已有的运营数据改小，
-- 反而制造一次「数据凭空消失」的假象）。
CREATE TABLE IF NOT EXISTS post_shares (
  post_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

-- 删除用户时按 user_id 清理；按帖子取计数走主键前缀，不需要额外索引。
CREATE INDEX IF NOT EXISTS idx_post_shares_user ON post_shares(user_id);
