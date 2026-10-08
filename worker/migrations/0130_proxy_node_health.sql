-- 代理节点「探活」结果表（2026-10-08）。
--
-- 背景 —— 之前节点级健康信息是**过目即忘**的：
--   * `POST /api/proxy/check` 只探「订阅地址」本身能不能拉到，测不到任何一个具体节点；
--   * `POST /api/proxy/latency` 能对**逐节点**做 TCP 握手，但结果只回给那一次请求，
--     前端刷新就没了；列表顺序也只由 `proxy_subscriptions.sort_order` 决定。
--   于是「哪些节点是活的」这件事无法沉淀，也没法据此排序。
--
-- 这张表把逐节点探活结果按**节点指纹**（与 proxy_node_fingerprints 同口径：
-- `协议:服务器:端口`）沉淀下来，由每小时运维任务定期刷新（见
-- worker/src/handlers/proxy.ts 的 probeProxyNodeHealth），
-- 用户侧接口据此把节点重排为「可用 → 未知 → 不可用」。
--
-- 状态只有三态，**刻意没有「不可用」这种断言**（与 proxy-latency.ts 同一条原则：
-- 没能验证 ≠ 不可用 —— 握手失败完全可能是本站 Worker 出网被该节点挡了）：
--   up      = 本轮探活里连续握手成功（成功是硬证据：真的连上了）
--   down    = 连续多轮都握手失败（一轮失败不算，见 HANDSHAKE_FAIL_STREAK_TO_DOWN）
--   unknown = 证据不足：从未探过 / 时好时坏 / 该协议走 QUIC-UDP 探不了
--             未出现在本表里的节点一律按 unknown 处理，所以**不需要**为
--             不支持探活的协议（hysteria / hysteria2 / tuic）写行。
--
-- `ok_streak` / `fail_streak` 是迟滞（hysteresis）的依据：见 proxy-node-health.ts。
-- 主键是**复合的**（指纹 + 订阅源），不是单列指纹。
--
-- 为什么不用「指纹」单列做主键：
--   同一个节点（同 协议:服务器:端口）经常同时出现在多个订阅源里
--   （`getProxyOverview` 的「相同节点检测」就是为这件事写的，见 duplicateOf）。
--   若按指纹单列做主键，这些共用的节点只能留下一行、subscription_id 只记得
--   最后一个探过它的订阅源 —— 另几个订阅源按 subscription_id 查回来就查不到，
--   界面上会把一个刚探明「可用」的节点显示成「未知」。复合主键让每个订阅源
--   各自持有它那一份节点的健康结论，互相不串。
--
--   代价：共用节点会被重复探一次（每个订阅源各一次）。这是刻意的取舍 ——
--   每秒能省下的那点连接数，换不来「同一个节点在不同订阅源里状态不一致」的困惑。
CREATE TABLE IF NOT EXISTS proxy_node_health (
  fingerprint     TEXT NOT NULL,                 -- 协议:服务器:端口（与 proxy_node_fingerprints 同口径）
  subscription_id TEXT NOT NULL,                 -- 该节点来自哪个订阅源（订阅源删除时对称清理）
  status          TEXT NOT NULL DEFAULT 'unknown', -- up | down | unknown
  latency_ms      INTEGER,                       -- 最近一次握手成功时的耗时；失败为 NULL
  ok_streak       INTEGER NOT NULL DEFAULT 0,    -- 连续成功次数
  fail_streak     INTEGER NOT NULL DEFAULT 0,    -- 连续失败次数
  checked_at      TEXT,                          -- 最近一次探活时间（轮转排序依据）
  last_error      TEXT,                          -- 最近一次失败原因（中性措辞，面向用户）
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (fingerprint, subscription_id)
);

-- 按订阅源取全量健康行（overview 接口、订阅源删除时的清理）
CREATE INDEX IF NOT EXISTS idx_proxy_node_health_sub ON proxy_node_health(subscription_id);

-- 轮转：挑「最久没探过」的订阅源先探，保证长期没有用户访问的订阅源也会被覆盖到
CREATE INDEX IF NOT EXISTS idx_proxy_node_health_checked ON proxy_node_health(subscription_id, checked_at);

-- 订阅源级别的「上次探活时间」。
--
-- 为什么不直接用 proxy_node_health 的 MAX(checked_at) 来轮转：
--   一个订阅源里的节点可能**全是 QUIC/UDP**（hysteria2 / tuic）—— 这类节点探不了，
--   不会有任何行落库。若拿「有无健康行」当轮转依据，这种订阅源的排序键会永远是 NULL，
--   于是每一轮都被排在第一个、把预算吃光，后面的订阅源**永远轮不到**。
--   所以在订阅源上单独记一个「什么时候探过你」，与「探出什么结果」解耦。
--
-- 顺带也成了界面上的「上次探活：X 分钟前」。
ALTER TABLE proxy_subscriptions ADD COLUMN health_checked_at TEXT;
