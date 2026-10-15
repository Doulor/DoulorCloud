-- 代理节点「一键捐献」的令牌防重放（2026-10-14）
--
-- 背景：捐献流程改成「用户在捐献页领一枚令牌 → 在服务器上跑一键脚本 → 脚本自检通过
-- 后回调 /api/frp/donate/register 登记节点」。这个回调是**唯一不带浏览器会话却要写数据**
-- 的接口，所以令牌必须自己扛住攻击。
--
-- 为什么令牌本身不落库：
--   令牌是 HMAC 签名的 `<userId>.<expiresAt>.<sig>`，服务端只要有一把密钥就能离线验签。
--   落库明文的话，D1 一旦泄露，任何人都能伪造出合法令牌去注册节点。
--
-- 那这张表存什么：
--   只存**已用过令牌的签名摘要**，用来防重放。没有它的话，同一枚令牌可以被无限次提交，
--   把一个用户的节点列表刷爆（每次提交都建一条 frp_nodes）。
--
-- 为什么用 UNIQUE 而不是「先查再插」：
--   脚本可能因为网络重试并发提交两次。应用层的「先查再插」在并发下会双穿，
--   把唯一性交给数据库才可靠 —— 这一条和 frp_port_leases 用主键做端口唯一性是同一个理由。
--
-- 本迁移全是 CREATE TABLE / CREATE INDEX，不改动任何既有表。

CREATE TABLE IF NOT EXISTS frp_donate_used_tokens (
  id          TEXT PRIMARY KEY,
  /**
   * 令牌签名片段（尾部 24 字符）。用片段而非全串：既能唯一区分，又不至于
   * 让这张表本身变成「令牌存档」。
   * UNIQUE —— 并发重复提交时由数据库保证只有一条能进去。
   */
  token_sig   TEXT NOT NULL,
  /** 领令牌的用户；登记出来的节点挂在谁名下就靠它 */
  user_id     TEXT NOT NULL,
  /** 脚本自报的来源 IP，用于事后排查（如「同一个 IP 反复注册」） */
  ip          TEXT,
  created_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_frp_donate_token_sig
  ON frp_donate_used_tokens(token_sig);

CREATE INDEX IF NOT EXISTS idx_frp_donate_token_user
  ON frp_donate_used_tokens(user_id, created_at);
