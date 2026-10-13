-- 0147_game_market.sql
-- 造物典藏 ·「在线投资」多人 K 线合约（2026-10-11）—— 建表。
--
-- 设计要点（完整说明见 docs/superpowers/specs/2026-10-11-doulor-collection-market-design.md）：
--
--   1. 对手盘是**服务器做市池**，池子余额就是 game_market.pool_balance 一个整数。
--      刻意**不建「做市池」假用户** —— 那会在用户列表 / 邮箱 / 域名 / 排行榜里
--      到处漏出来，还要为它编造一堆 NULL 字段。整数 + 一张流水表，审计能力一样、副作用为零。
--
--   2. 积分守恒等式（由 worker/test/game-market.test.ts 随机模拟验证）：
--          Σ 用户积分余额 + pool_balance + Σ(在仓保证金) = 常量
--      保证金离开用户余额时进 game_positions.margin（托管），平仓/强平时释放。
--      池子的减法一律用 MAX(0, pool_balance + delta) 落地 —— 池子永不为负是本游戏的
--      「不凭空增发积分」保证；赔付以池子余额为上限（见 game-market.ts 的 settlePosition）。
--
--   3. K 线只存「已封闭的」历史（game_candles）；**当前正在走的那根**待在 game_market 的
--      candle_* 列上。这样每分钟一次的行情推进不需要写 game_candles，
--      只在跨分钟时落一根 —— D1 写入量差一个数量级。
--
--   4. 所有价格用 REAL、所有积分用 INTEGER。积分永远不做小数：
--      小数余额会让「花光了没有」变得难以判断（与 worker/src/points.ts 的口径一致）。
--
--   5. 表名统一 game_ 前缀。迁移号 0147 起（0146 已被造物集置顶占用）。

-- ---------------------------------------------------------------------------
-- 行情（单行表，id 恒为 1）
-- ---------------------------------------------------------------------------
--
-- ⚠️ **不在这里预置数据行**：seed 是随机数，SQL 里生成不了。由 ensureMarket()
--    懒创建（INSERT OR IGNORE），这样测试环境也不用额外造数。
--
-- CHECK (id = 1) 是单行表的硬保证：将来谁写了 `INSERT ... VALUES (2, ...)` 会直接报错，
-- 而不是悄悄多出一行「第二个市场」让行情分裂。
CREATE TABLE IF NOT EXISTS game_market (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  -- 最新成交价
  price            REAL    NOT NULL,
  -- 慢锚：均值回复的目标价，自身以极慢速度跟随 price（防止单边行情跑到 0 或无穷）
  anchor           REAL    NOT NULL,
  -- 做市池余额（对手盘资金）。**永不为负**，见文件头第 2 条
  pool_balance     INTEGER NOT NULL DEFAULT 0,
  -- tick 序号：单调递增，同时是「乐观锁的版本号」（UPDATE ... WHERE tick_seq = ?）
  tick_seq         INTEGER NOT NULL DEFAULT 0,
  -- 上一次推进到的时间点（ISO）。下一次从它 + tickMs 开始补算
  last_tick_at     TEXT    NOT NULL,
  -- PRNG 种子：价格噪声由 hash(seed, tick_seq) 决定 ⇒ 同一 tick 重算结果一致
  seed             TEXT    NOT NULL,
  -- 当前正在走的那根 K 线（封闭后写入 game_candles 并重置）
  candle_open_at   TEXT    NOT NULL,
  candle_open      REAL    NOT NULL,
  candle_high      REAL    NOT NULL,
  candle_low       REAL    NOT NULL,
  candle_close     REAL    NOT NULL,
  candle_volume    INTEGER NOT NULL DEFAULT 0,
  candle_trades    INTEGER NOT NULL DEFAULT 0,
  -- 当日 OHLC（前端顶栏的 24h 涨跌幅用；跨日时由 ensureMarket/advance 重置）
  day_open_at      TEXT    NOT NULL,
  day_open         REAL    NOT NULL,
  day_high         REAL    NOT NULL,
  day_low          REAL    NOT NULL,
  updated_at       TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- K 线（已封闭的历史）
-- ---------------------------------------------------------------------------
--
-- interval 目前只有 '1m' 会真正落库（tick 聚合出来的就是 1 分钟）；
-- 5m / 15m 由 SQL 聚合 1m 得到，不单独存 —— 少两张表的写入量与一致性问题。
-- 留这一列是为了将来真要存别的周期时不用改主键。
--
-- ⚠️ 列名不叫 `open` / `close`：那是 SQL 关键字/函数名，写 SQL 时到处要加引号。
CREATE TABLE IF NOT EXISTS game_candles (
  interval     TEXT    NOT NULL,
  open_at      TEXT    NOT NULL,
  open_price   REAL    NOT NULL,
  high_price   REAL    NOT NULL,
  low_price    REAL    NOT NULL,
  close_price  REAL    NOT NULL,
  volume       INTEGER NOT NULL DEFAULT 0,
  trades       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (interval, open_at)
);

-- ---------------------------------------------------------------------------
-- 持仓
-- ---------------------------------------------------------------------------
--
-- status 三态：
--   open       —— 在仓（margin 是托管中的保证金）
--   closed     —— 用户主动平仓，已结算
--   liquidated —— 被强平，保证金全额归池
--
-- order_no 是**下单幂等键**：前端每次下单生成一个，重放同一个 order_no 不会开两次仓。
-- UNIQUE 约束是这条保证的落地点（不是靠应用层查重 —— 并发下查重必漏）。
CREATE TABLE IF NOT EXISTS game_positions (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL,
  -- long / short
  side         TEXT    NOT NULL,
  leverage     INTEGER NOT NULL,
  -- 保证金（托管中的积分）
  margin       INTEGER NOT NULL,
  entry_price  REAL    NOT NULL,
  -- 名义规模 = margin × leverage（积分计价）。盈亏按它算
  size         REAL    NOT NULL,
  -- 强平价，开仓时按 (entry, leverage, 维持保证金率) 算好存下来，避免每 tick 重算
  liq_price    REAL    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'open',
  opened_at    TEXT    NOT NULL,
  -- 开仓时的 tick 序号（用于「同时刻开仓」的排序与排查）
  open_tick    INTEGER NOT NULL DEFAULT 0,
  closed_at    TEXT,
  close_price  REAL,
  -- 已实现盈亏（积分，正=赚）；未平仓为 NULL
  pnl          INTEGER,
  fee_open     INTEGER NOT NULL DEFAULT 0,
  fee_close    INTEGER NOT NULL DEFAULT 0,
  order_no     TEXT    NOT NULL,
  -- 平仓时的补充说明（如「赔付受池子上限限制」），直接给用户看
  note         TEXT
);

-- 强平扫描按 status 过滤，持仓列表按 (user_id, status) 过滤 —— 两条索引各司其职。
CREATE INDEX IF NOT EXISTS idx_game_positions_status ON game_positions(status, id);
CREATE INDEX IF NOT EXISTS idx_game_positions_user ON game_positions(user_id, status, opened_at DESC);
-- 幂等键
CREATE UNIQUE INDEX IF NOT EXISTS idx_game_positions_order ON game_positions(order_no);

-- ---------------------------------------------------------------------------
-- 成交流水（用户「交易记录」页）
-- ---------------------------------------------------------------------------
--
-- kind：open（开仓）/ close（平仓）/ liquidate（强平）
-- 开仓行的 pnl 恒为 0；平仓/强平行记已实现盈亏。
CREATE TABLE IF NOT EXISTS game_trades (
  id            TEXT    PRIMARY KEY,
  user_id       TEXT    NOT NULL,
  position_id   TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  side          TEXT    NOT NULL,
  leverage      INTEGER NOT NULL DEFAULT 1,
  price         REAL    NOT NULL,
  size          REAL    NOT NULL,
  margin        INTEGER NOT NULL DEFAULT 0,
  fee           INTEGER NOT NULL DEFAULT 0,
  pnl           INTEGER NOT NULL DEFAULT 0,
  -- 本次操作后的用户积分余额快照（展示用，避免前端再查一次）
  balance_after INTEGER,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_trades_user ON game_trades(user_id, created_at DESC);
-- 排行榜按时间窗口扫这张表（reason 口径都在这里，不去翻 point_transactions）
CREATE INDEX IF NOT EXISTS idx_game_trades_kind ON game_trades(kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- 池子流水（做市资金的审计账）
-- ---------------------------------------------------------------------------
--
-- kind：
--   seed_deposit —— 管理员划拨垫本（从管理员账户转入）
--   withdraw     —— 管理员抽回资金
--   fee          —— 手续费收入
--   payout       —— 赔付玩家盈利（负数）
--   intake       —— 玩家亏损 / 强平保证金归池
--   adjust       —— 管理员手工调整
--
-- ⚠️ 这张表是**审计账**，不是余额的来源 —— 余额唯一来源是 game_market.pool_balance。
--    两者对不上就是 bug，所以每条流水都带 balance_after，便于二分定位。
CREATE TABLE IF NOT EXISTS game_pool_ledger (
  id            TEXT    PRIMARY KEY,
  delta         INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  kind          TEXT    NOT NULL,
  user_id       TEXT,
  ref           TEXT,
  note          TEXT,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_pool_ledger_time ON game_pool_ledger(created_at DESC);
