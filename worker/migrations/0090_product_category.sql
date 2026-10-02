-- 用户商品分类（2026-10-01 站长要求）：暂时只分 IT / 其他
--
-- 为什么要分：用户上架的东西越来越杂，买家找起来费劲；先分两类把结构立起来，
-- 以后要加分类只需扩这个 CHECK（前端的选择项同步加即可）。
--
-- 默认 'other' 而不是 'it'：IT 是特定类目，老商品（以及大多数非技术类）归「其他」更合理。
-- 存量数据不需要单独回填 —— ALTER 的 DEFAULT 会作用于所有既有行。

ALTER TABLE point_products ADD COLUMN category TEXT NOT NULL DEFAULT 'other';
