-- 内网穿透「租用化」（2026-10-13）
--
-- 背景：现有 frp_applications 是「用户提交申请 → 管理员人工审核 → 管理员去 frps-panel
-- 手工建号 → 回本站批准」的流程。改造目标是把「谁可以用、用到什么时候、占哪些端口」
-- 变成 D1 里的结构化数据，由服务器侧的 frp-agent 定时拉取并投影到 frps-panel。
-- 完整设计见 docs/内网穿透租用化改造方案.md。
--
-- 三个关键约束（都是实测得出的，别改）：
--   1. `frp_subscriptions` 是**唯一真值**。面板里的 users/ports 只是它的投影，
--      任何字段冲突都以 D1 为准。
--   2. `frp_user` 统一加 `dcfrp_` 前缀。面板里存在 46 个历史账号（人工建的，
--      comment 里手写到期日），agent 靠这个前缀区分「本站创建的账号」与历史账号，
--      从而**绝不会误删/误改别人的账号**。前缀必须在代码与 agent 两侧保持一致。
--   3. `frp_token` 只允许字母数字 —— 面板对 token 有格式校验，
--      实测带连字符的值会被拒（`operate failed, token [...] format error`）。
--
-- 本迁移全部是 CREATE TABLE / CREATE INDEX，不改动任何既有表。

-- ---------------------------------------------------------------------------
-- 套餐：可配置的「时长 × 积分」，例如 7 天 / 30 天 / 90 天
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS frp_plans (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  /** 租期天数 */
  days          INTEGER NOT NULL,
  /** 价格（积分） */
  price_points  INTEGER NOT NULL,
  /** 该套餐允许占用的端口数上限 */
  max_ports     INTEGER NOT NULL DEFAULT 1,
  /**
   * 该套餐可选的端口区间（JSON 数组，元素形如 [30001, 30020] 或 [30001, 30001]）。
   * 空数组表示「由系统从节点的可用池里自动分配」。
   */
  allow_ranges  TEXT NOT NULL DEFAULT '[]',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_frp_plans_node
  ON frp_plans(node_id, enabled, sort_order);

-- ---------------------------------------------------------------------------
-- 订阅：一个用户在一个节点上的一份租约
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS frp_subscriptions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  node_id       TEXT NOT NULL,
  /** 来源套餐；管理员手工开通的订阅可以为 NULL */
  plan_id       TEXT,
  /** 同步给面板的账号名，形如 dcfrp_a1b2c3d4（见文件头约束 2） */
  frp_user      TEXT NOT NULL,
  /** 同步给面板的 token，字母数字（见文件头约束 3） */
  frp_token     TEXT NOT NULL,
  /** 本订阅占用的端口，JSON 数组（真值在 frp_port_leases，这里是冗余快照便于展示） */
  ports         TEXT NOT NULL DEFAULT '[]',
  /** active | expired | cancelled | pending */
  status        TEXT NOT NULL DEFAULT 'pending',
  started_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  auto_renew    INTEGER NOT NULL DEFAULT 0,
  /** 本订阅实际消耗的积分（用于续费/退款计算） */
  price_points  INTEGER NOT NULL DEFAULT 0,
  /** agent 最近一次成功把本行投影到面板的时间 */
  synced_at     TEXT,
  /** pending | synced | error —— 管理端据此显示「期望 vs 实际」是否一致 */
  sync_state    TEXT NOT NULL DEFAULT 'pending',
  /** agent 回报的同步失败原因（可观测性，管理端直接展示） */
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 同一节点下账号名唯一（面板的 user 也是唯一键）
CREATE UNIQUE INDEX IF NOT EXISTS idx_frp_subs_node_user
  ON frp_subscriptions(node_id, frp_user);
-- 到期扫描（scheduled 每次触发都走这条）
CREATE INDEX IF NOT EXISTS idx_frp_subs_expiry
  ON frp_subscriptions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_frp_subs_user
  ON frp_subscriptions(user_id, status);

-- ---------------------------------------------------------------------------
-- 端口租约：把「谁占了哪个端口」做成主键约束，而不是靠扫 JSON
-- ---------------------------------------------------------------------------
-- 为什么单独一张表：端口冲突是这类服务最容易出事的地方（两个用户拿到同一个
-- 公网端口，先连上的那个能跑、后连上的静默失败，极难排查）。用主键把唯一性
-- 交给数据库，比在应用层「先查再插」可靠。
CREATE TABLE IF NOT EXISTS frp_port_leases (
  node_id     TEXT NOT NULL,
  port        INTEGER NOT NULL,
  /** 归属订阅；导入的历史占用（面板里人工作废的端口）此列为 NULL */
  sub_id      TEXT,
  /** rental | legacy —— legacy 表示从面板导入的历史占用，不参与租用回收 */
  kind        TEXT NOT NULL DEFAULT 'rental',
  note        TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (node_id, port)
);

CREATE INDEX IF NOT EXISTS idx_frp_leases_sub ON frp_port_leases(sub_id);

-- ---------------------------------------------------------------------------
-- agent 心跳：管理端「在线实况」读这里
-- ---------------------------------------------------------------------------
-- 为什么不放 app_settings：那个表的每个键都必须有服务端读取点（check-settings 护栏），
-- 而这是一台机器一条的记录，天然属于独立表。
CREATE TABLE IF NOT EXISTS frp_agent_state (
  node_id       TEXT PRIMARY KEY,
  last_seen_at  TEXT NOT NULL,
  /** agent 最近一次拉到的 revision，用于判断它是否卡在旧状态 */
  revision      TEXT,
  /** agent 看到的 frps 实况（JSON：clientCounts / proxyTypeCount / 流量等） */
  server_info   TEXT,
  last_error    TEXT,
  report_count  INTEGER NOT NULL DEFAULT 0
);
