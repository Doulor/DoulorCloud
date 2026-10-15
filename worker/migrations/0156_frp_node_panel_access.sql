-- 捐献节点的「面板接入信息」（2026-10-14）
--
-- 为什么需要这两列：
--   捐献的服务器上跑着 frps + 面板，但**没有 agent**（agent 是"每台服务器自己拉 D1"的
--   模型，只适用于我们自己那台）。所以 DoulorCloud 必须能**主动把账号推**到捐献节点的
--   面板上，否则用户买了套餐，那台面板永远收不到账号 —— 用户拿着配置连不上。
--
--   要推就得知道：面板在哪个端口（panel_port），以及用什么密钥签名（panel_secret）。
--   面板的 /api/admin/* 走 HMAC 鉴权，密钥就是安装脚本自己生成的那个 agent_secret
--   （脚本已经通过上报接口交上来了，这里只是把它存下来）。
--
-- ⚠️ panel_secret 是**明文存储**的。这是有意为之，不是疏忽：
--   HMAC 签名需要原文，用摘要存就没法签名了。风险由这两点兜住：
--     · D1 本身只有 Worker 能访问，不对外；
--     · 这个密钥只能访问那一台捐献节点自己的面板，且面板只在回环之外提供
--       /api/admin/* 这一个管理面，泄露的爆炸半径限于该节点。
--   如果以后要把它的风险降下来，正确方向是给每个节点签发**可吊销的短期凭据**，
--   而不是在这里做加密 —— 加密的密钥还是得存在同一个地方，等于没加密。
--
-- 本迁移只做 ALTER TABLE ADD COLUMN（可空），不动既有数据。

ALTER TABLE frp_nodes ADD COLUMN panel_port INTEGER;
ALTER TABLE frp_nodes ADD COLUMN panel_secret TEXT;
-- 最近一次推送到该节点的结果，用于在管理端显示「期望 vs 实际」
ALTER TABLE frp_nodes ADD COLUMN last_push_at TEXT;
ALTER TABLE frp_nodes ADD COLUMN last_push_error TEXT;
