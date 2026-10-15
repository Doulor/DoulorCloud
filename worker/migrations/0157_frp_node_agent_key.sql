-- 捐献节点专属的 agent 密钥（2026-10-14）
--
-- 背景：一键捐献的节点上要装一个 agent，它定时**拉取** D1 的期望状态并写进本地面板。
-- 拉取需要鉴权，密钥要交给捐献者。
--
-- 🔴 为什么不能继续用全局 `FRP_AGENT_SECRET`：
--    agent 的 `/frp/agent/desired?node=<id>` 是用 HMAC 签的，密钥就是身份的凭据。
--    如果所有捐献者共用全局密钥，任何一个人都能把 `node=` 换成别人的节点，
--    拉到**其他用户的 frp 令牌**（那等于面板账号的密码，是能直接顶掉别人隧道的凭据）。
--    每节点一把密钥，泄露半径就限于该节点自己。
--
-- 全局 `FRP_AGENT_SECRET` 继续保留，**只给我自己那台服务器**用（它管着 node-bj）。
-- 鉴权侧同时接受两者（见 handlers/frp-agent.ts 的 requireAgent）。
--
-- 本迁移只加一个可空列，不动既有数据。

ALTER TABLE frp_nodes ADD COLUMN agent_key TEXT;
