-- 订阅源标注「审核来源」，用于区分「自动审核」与「人工审核」（2026-10-03 站长要求）。
--
-- 为什么需要：过时订阅源自动标记「不可用」只能对**自动审核**的订阅源触发 ——
-- 人工审核是管理员亲眼看过、明确放行的，哪怕抓取失败也不能自动判死（可能只是临时故障），
-- 只能标成「未知」等管理员看。所以节点池要能记住每条订阅源当初是哪种来源。
--
--   review_source = 'auto'   —— 捐献自动审核通过后导入
--   review_source = 'manual' —— 管理员手工放行 / 手工添加
-- 存量默认 'manual'（历史数据大多是人工路径进来的）。

ALTER TABLE proxy_subscriptions ADD COLUMN review_source TEXT NOT NULL DEFAULT 'manual';
