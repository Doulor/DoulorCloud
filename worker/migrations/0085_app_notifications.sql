-- 0085_app_notifications.sql
-- App 端「消息中心」推送所需的两个字段。
--
-- 背景：站长用 WebToApp（原生安卓 WebView 壳）把本站打成了 App，希望 App 能收消息中心的通知。
-- 该 App 内置一个「轮询前台服务」（NotificationPollingService），可以按固定间隔请求一个 URL，
-- 把返回的 JSON 数组逐条弹成系统通知 —— 这是不依赖 Firebase 的最省事路径。
-- 但它有两个特性决定了服务端必须配合（均已读源码确认）：
--   · 请求**不带 Cookie**，只能靠自定义请求头里的令牌认人；
--   · **完全不去重**（通知 id 用 System.currentTimeMillis() 拼），返回什么就弹什么。
--
-- ⚠️ D1 一次只执行一条语句，本文件两条，请逐条手工执行（不要用 --file）。

-- 1) 已推送游标：「最近一次已经推给 App 的通知时间」。
--    轮询请求每次都一样、不带游标，所以「只返回新的」只能由服务端记住。
--    少了它，同一条未读消息会每隔几分钟重复弹一次。
ALTER TABLE users ADD COLUMN notify_pushed_at TEXT;

-- 2) App 通知令牌：轮询请求不带 Cookie，只能靠 Bearer 令牌认人。
--    存明文不加密：它只能读自己的通知、权限极小，且需要在设置页反复展示供用户复制；
--    一键「重新生成」即可作废旧值（因此不采用「不可撤销的派生令牌」方案）。
ALTER TABLE users ADD COLUMN app_notify_token TEXT;
