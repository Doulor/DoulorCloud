-- 0074_points.sql
-- 积分系统：用户积分余额（user_points）+ 收支流水（point_transactions）。
--
-- 定位：积分是**落库的余额**，与「成就点」是两回事 ——
--   成就点（handlers/achievements.ts）是每次请求按当前数据实时算出来的荣誉值，
--   不落库、不能花；积分是能消费的资产（当前用途：按比例兑换中转站余额）。
--   两者刻意不打通：成就点是「你干了多少」，积分是「你拥有多少」。
--
-- 为什么余额要单独一张表而不是塞进 users：
--   积分会频繁增减（活动发放 / 兑换），塞进 users 会让每次积分变动都去写
--   那张宽表（牵连其它字段的更新时间与缓存）；单独一张窄表读写更干净，
--   也让「给用户加积分」这件事只有一个入口（points.ts 的 applyPoints）。

CREATE TABLE IF NOT EXISTS user_points (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 当前余额（整数积分；1 积分 = 1 元，默认 0）
  balance    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- 流水：每一笔增减都留痕，便于对账与用户自查「我的积分去哪了」。
-- delta 正数=增加、负数=减少；balance 是**变动后**的余额快照。
CREATE TABLE IF NOT EXISTS point_transactions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta      INTEGER NOT NULL,
  -- 变动后的余额快照（对账用；并发下可能略有偏差，余额本身以 user_points 为准）
  balance    INTEGER NOT NULL,
  -- 来源/去向：event=活动发放 / admin=管理员发放或扣减 / redeem=兑换余额
  reason     TEXT NOT NULL,
  -- 展示文案（用户在流水里看到的这一行）
  detail     TEXT,
  -- 幂等键：同一来源只记一次（如活动领取 event:<eventId>），NULL 表示不去重
  dedup_key  TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

-- 幂等去重（部分索引，排除 dedup_key IS NULL 的行）
CREATE UNIQUE INDEX IF NOT EXISTS idx_point_tx_dedup
  ON point_transactions(user_id, dedup_key) WHERE dedup_key IS NOT NULL;

-- 按用户查流水（用户端「最近记录」+ 管理员查某人）
CREATE INDEX IF NOT EXISTS idx_point_tx_user
  ON point_transactions(user_id, created_at DESC);

-- 管理端「积分总览」要按余额排序 / 统计发放总量，按 reason + 时间扫
CREATE INDEX IF NOT EXISTS idx_point_tx_reason
  ON point_transactions(reason, created_at DESC);
