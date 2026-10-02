-- 私信「聊天申请」关系表（2026-10-01，站长要求防骚扰）
--
-- 背景：私信上线时没有门槛，任何人可以给任何人连发消息。站长要求改成
--   「对方同意后才能自由发消息」，否则**只允许发一条**申请消息。
--
-- 方向性：owner_id = **收到申请的人**，peer_id = **发起申请的人**。
--   status = request  ：peer 已发过申请，owner 还没处理（此时 peer 不能再发）
--   status = accepted ：owner 同意了 → 双方自由互发
--   status = declined ：owner 拒绝了 → peer 不能再发
--
-- 免申请的情形（在应用层判断，不落这张表）：
--   ① 收件人是管理员 / 站长 —— 给管理团队发消息不该被拦；
--   ② 双方存在订单关系（买过 / 卖过）—— 交易本来就该能直接联系。

CREATE TABLE IF NOT EXISTS dm_contacts (
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, peer_id)
);

-- 「我收到的待处理申请」：DM 页顶部那块要按这个查
CREATE INDEX IF NOT EXISTS idx_dm_contacts_owner_status ON dm_contacts(owner_id, status);
-- 反查「我与某人是否已有关系」
CREATE INDEX IF NOT EXISTS idx_dm_contacts_peer ON dm_contacts(peer_id, status);
