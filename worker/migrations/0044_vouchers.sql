-- 0044_vouchers.sql
-- 「权限兑换码」：让**已经在站**的用户也能把码换成权限。
--
-- 背景：邀请码原本只有「拉新人」一条出路（注册时消耗），已在站的用户拿到码
-- 没地方用。用户要的是一个能补权限的凭证：
--   1. 首次捐献成功的奖励 —— 一张「自选权限」券，自己挑一个还没开的模块；
--   2. 别人给的邀请码 —— 用它的 permissions 补齐自己缺的那些模块。
--
-- 为什么另开一张表而不是给 invite_codes 加列：
--   invite_codes 的语义是「能拉几个人」（max_uses / used_count / 额度退还都围绕它），
--   而券是「一次性把权限给某个人」，混在一起会让 used_count、退还逻辑都变得含糊。
--
-- feature      指定权限（r2/ai/frp/proxy）；**NULL = 自选**，兑换时由用户挑一个
-- transferable 是否允许别人使用（默认只能持有者自己用）
-- source       来源标记：first_donation（首捐奖励）| admin（管理员发放）
--              first_donation 用来保证「一辈子只发一张」，撤销后重新批准不会重复发

CREATE TABLE IF NOT EXISTS vouchers (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source          TEXT NOT NULL DEFAULT 'admin',
  feature         TEXT,
  transferable    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'unused',  -- unused | used
  used_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  used_feature    TEXT,
  used_at         TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers(code COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_vouchers_owner ON vouchers(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_vouchers_owner_source ON vouchers(owner_user_id, source);
