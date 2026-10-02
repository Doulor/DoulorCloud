-- GitHub star 活动的「用户名占用」表（2026-10-01，修漏洞）
--
-- 漏洞：核验只确认「填的 GitHub 用户名真的 star 过仓库」，没确认「这个名字
-- 只被领一次」。多个站内账号可以填**同一个** GitHub 用户名重复领奖
-- （star 名单是公开的，谁都能抄别人的名字 —— deity6 实测刷成功后报了这个洞）。
--
-- 修复：一个 GitHub 用户名在一个活动里只能被**一个**站内账号使用。
-- 主键 (event_id, github_username) 就是锁；user_id 存的是占用者，
-- 供管理端审计「这个名字被谁用了」。
--
-- ⚠️ github_username 一律**小写、去 @ 前缀**后存入：GitHub 用户名大小写不敏感，
-- 不归一化的话 Deity6 / deity6 就能绕过唯一键。

CREATE TABLE IF NOT EXISTS event_github_claims (
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  github_username TEXT NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimed_at      TEXT NOT NULL,
  PRIMARY KEY (event_id, github_username)
);

-- 审计用：看某活动里某个用户占了哪些名字
CREATE INDEX IF NOT EXISTS idx_event_github_user ON event_github_claims(user_id, event_id);
