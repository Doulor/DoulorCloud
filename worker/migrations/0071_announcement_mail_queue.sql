-- 0071_announcement_mail_queue.sql
-- 公告邮件群发改为「入队 + 分批异步发送」。
--
-- 背景：原先 createAnnouncement 里是一个 for 循环逐封 await sendMail，
-- 226 个收件人就是 226 次串行外部 HTTP 往返，全部堵在发布请求里。后果：
--   1. 前端点「发布」后按钮转很久（管理员以为卡死了）；
--   2. Worker 子请求数量有上限，越靠后的收件人越容易失败，且失败静默
--      （只 console.error + failed++，管理员根本不知道谁没收到）；
--   3. 一旦请求被中断，已发的部分和未发的部分没有记录，无法续跑。
--
-- 现在：发布时把收件人**快照**进队列表（一次 INSERT ... SELECT），
-- 请求立刻返回；实际发送由 ctx.waitUntil 在后台分批跑，批间留间隔保护送达率，
-- 每小时 cron 兜底续跑未完成的批次（进程被回收也不会丢）。
--
-- 为什么快照收件人而不是每次重查 users：公告一旦发布，收件人集合就该固定。
-- 若发送期间有人改了通知偏好或注销，重查会让「说好发 226 封」变成发 219 封，
-- 而且队列进度（sent/total）也会对不上。快照让进度可解释、可续跑。

CREATE TABLE IF NOT EXISTS announcement_mail_queue (
  id            TEXT PRIMARY KEY,
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  email         TEXT NOT NULL,
  -- pending | sent | failed
  status        TEXT NOT NULL DEFAULT 'pending',
  -- 失败原因（截断存储，供管理端排查；不存完整堆栈）
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT,
  created_at    TEXT NOT NULL
);

-- 发送时按「未发送」捞取，且要能按公告聚合进度
CREATE INDEX IF NOT EXISTS idx_amq_pending ON announcement_mail_queue(announcement_id, status);
-- 兜底扫描「所有还没发完的公告」用
CREATE INDEX IF NOT EXISTS idx_amq_status ON announcement_mail_queue(status, created_at);

-- 公告的群发状态：管理员需要在列表里看到「推送中 x/y」「推送完成」
ALTER TABLE announcements ADD COLUMN mail_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE announcements ADD COLUMN mail_total  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE announcements ADD COLUMN mail_sent   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE announcements ADD COLUMN mail_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE announcements ADD COLUMN mail_finished_at TEXT;
