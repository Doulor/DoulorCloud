-- 0160_dns_rental_pricing.sql
--
-- DNS 解析改为「按根域定价、积分租用」：给 root_domains 加价格列。
--
-- 为什么价格要挂在**根域**上而不是全局设置里：
--   站长的定价就是按根域来的（tyu.me 便宜、7u.nz 贵）。同一个功能在不同根域下
--   成本不同（域名本身的持有成本、用户对后缀的偏好），价格是**每个根域自己的属性**。
--   放进全局设置就得写成 "tyu.me=200,7u.nz=500" 这种字符串解析，加一个根域要改两处、
--   删一个根域要记得清理残留，而且没法在管理端按行编辑。
--
-- 单位：积分 / 年。0 表示「不通过租用开放」（例如 doulor.cn 走 requires_feature 权限，
-- 不卖）。
--
-- 为什么 NOT NULL DEFAULT 0：存量三行必须立刻有确定值，不能让 NULL 表示「未定价」
--   再让代码去兜底 —— 那样「忘了定价」会静默变成免费。
--
-- 幂等：ALTER TABLE 在同一库上重复执行会报 duplicate column，故本迁移只应执行一次；
--   D1 的迁移表会记录已执行，重复 apply 不会重跑。数值用 UPDATE 写死，可安全重跑。

ALTER TABLE root_domains ADD COLUMN dns_price_per_year INTEGER NOT NULL DEFAULT 0;

-- tyu.me：站长定价 200 积分/年
UPDATE root_domains SET dns_price_per_year = 200 WHERE name = 'tyu.me';

-- 7u.nz：站长定价 500 积分/年（.nz 域名持有成本高，且是短后缀、更受欢迎）
UPDATE root_domains SET dns_price_per_year = 500 WHERE name = '7u.nz';

-- doulor.cn 保持 0：它是权限门控根域（requires_feature = 'doulor'），不参与租用售卖。
