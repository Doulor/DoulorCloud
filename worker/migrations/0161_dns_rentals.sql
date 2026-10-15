-- 0161_dns_rentals.sql
--
-- DNS 解析「积分租用」（2026 站长要求）：新增租约表，并把每用户记录数上限
-- 从「只有全局设置项」升级为「可按用户覆盖」。
--
-- ---------------------------------------------------------------------------
-- 1) 为什么要有 dns_rentals 这张表（而不是复用 frp_subscriptions）
-- ---------------------------------------------------------------------------
-- frp 的租约表（0153）里塞满了只有 frp 才有的东西：面板账号名 / 令牌 / 端口列表 /
-- 与 agent 的同步状态。DNS 这边一个都不需要 —— DNS 的落地是**直接调 Cloudflare**
-- （见 handlers/dns.ts 的 cfCreateDnsRecord），D1 里只有台账，没有「期望状态投影」
-- 这回事。硬塞进 frp_subscriptions 只会让那张表的列一半永远为 NULL，而两边的
-- 查询条件从此混在一起（frp 的每个列表都要多一个 `WHERE node_id IS NOT NULL`
-- 之类的补丁），得不偿失。
--
-- 但**做法**是照抄的（这是站长明确要求的）：一个用户在一个根域上至多一份有效租约、
-- 按年计价、到期自动失效、扣分一律走 points.ts 的 applyPoints（原子 + dedup_key）。
--
-- ---------------------------------------------------------------------------
-- 2) 为什么要给 users 加 max_dns_records
-- ---------------------------------------------------------------------------
-- 与 `max_subdomains`（见 handlers/subdomains.ts 的「用户级覆盖 > 全局设置」）
-- 是同一套思路：全局的 `app_settings.dns_records_per_user` 是给所有人定的线，
-- 但站长经常需要给**某一个人**临时放宽（他确实要用 30 条）或收紧（他在刷）。
-- 没有这一列的话，唯一办法是把全局上限抬高 —— 那等于对全站放宽。
--
-- NULL = 没有覆盖（沿用全局设置）。刻意不用 0 表示「不覆盖」：0 是一个合法的
-- 上限（一条都不许建），两者混淆会让「把这个用户锁死」变成一个静默失效的操作。
--
-- ---------------------------------------------------------------------------
-- 3) 状态机与「有效」的判据
-- ---------------------------------------------------------------------------
--   · active    —— 生效中；只有它 + expires_at > now 才真正解锁
--   · expired   —— 已到期（由每小时运维翻过来，见 handlers/dns-rental.ts）
--   · cancelled —— 管理员手工停用
--
-- 到期**不删行**：删了就查不出「他曾经买过、什么时候买的、花了多少分」，
-- 而这些正是站长排查「我明明买过为什么不能用」时唯一能看的东西。
--
-- ---------------------------------------------------------------------------
-- 4) 部分唯一索引：一个根域上只留一份**有效**租约
-- ---------------------------------------------------------------------------
-- `WHERE status = 'active'` 是刻意的：过期/停用的历史行必须留着（见上条），
-- 所以不能用普通唯一索引 —— 那会让用户「续费第二次」直接撞约束。
-- 有了它，「重复购买」在数据库层就是不可能的，代码只需要处理「已有有效租约 →
-- 引导去续期」这一种情况，不必担心并发下插出两行。
--
-- ⚠️ 与 frp 的差别（刻意的）：frp 靠 `WHERE user_id = ? AND node_id = ? AND
--    status != 'cancelled'` 的 SELECT 去查重，那中间有窗口。这里用索引兜住。
--
-- 幂等：建表 / 建索引都是 IF NOT EXISTS；ALTER TABLE 在同一库上重复执行会报
-- duplicate column，故本迁移只应执行一次（D1 的迁移表会记录已执行）。

CREATE TABLE IF NOT EXISTS dns_rentals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- 租的是**哪个根域**（小写域名，与 root_domains.name 同形）。
  -- 不做外键：root_domains 允许被删（管理端有 delete 动作），而历史租约必须留着可查。
  root_domain TEXT NOT NULL,
  -- 成交价快照（购买/续期时那一年的价）。不跟着 root_domains 的后续调价走 ——
  -- 对账要看的是「当时收了多少」，不是「现在值多少」。
  price_points INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- 到期前 24 小时内自动按当前年价续一期（用户可在面板上开关）
  auto_renew INTEGER NOT NULL DEFAULT 0,
  -- 自动续费失败的原因（积分不够时服务端会关掉开关并写在这里，用户在面板上能看到）
  last_error TEXT,
  -- 管理员手工开出来时记操作人；用户自己买则为 NULL
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dns_rentals_active
  ON dns_rentals(user_id, root_domain) WHERE status = 'active';

-- 运维与到期扫描都按 expires_at 走（每小时那条 cron 只扫「即将到期 / 已到期」）
CREATE INDEX IF NOT EXISTS idx_dns_rentals_expires ON dns_rentals(expires_at);

-- 每用户 DNS 记录数上限的用户级覆盖（NULL = 沿用 app_settings.dns_records_per_user）
ALTER TABLE users ADD COLUMN max_dns_records INTEGER;
