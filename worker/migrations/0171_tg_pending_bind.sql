-- 0171: TG 绑定「等待输入」状态
--
-- 背景（2026-10-22 站长反馈）：Telegram 菜单里点 `/bind` 只会把 `/bind` 本身发出去，
-- **不会带参数**，用户还得手动打「/bind 123456」。两种更顺的做法：
--   ① 深链 https://t.me/<bot>?start=<码> —— 点一下 bot 直接收到 `/start <码>`，零输入
--   ② `/bind` 无参时回一句「把 6 位码发给我」，进入等待状态，下一条纯数字消息当码处理
--
-- ②需要记住「这个 chat 正在等码」，所以单独一张极小的表（10 分钟过期，用完即删）。
-- 不塞进 tg_bind_tokens：那张表的语义是「码」，这里是「谁的等待状态」，混在一起以后必被误用。

CREATE TABLE IF NOT EXISTS tg_pending_binds (
  telegram_id TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tg_pending_binds_time ON tg_pending_binds(created_at DESC);
