-- 「用户可分配根域」注册表（2026-10-01 站长要求）
--
-- 背景：站内发给用户的子域名与邮箱原先硬编码在 `env.ROOT_DOMAIN`（doulor.cn）。
-- 但 doulor.cn 同时是**站点主域**（cloud.doulor.cn、密码重置链接、OAuth issuer
-- 都从它拼），把用户邮箱/子域名全挂上去，等于把所有用户的滥用风险都记在主域声誉上；
-- 而主域还承担「给用户发验证码 / 找回密码」的发件人角色 —— 声誉一脏，这些关键邮件
-- 就会开始进垃圾箱。所以把「站点域名」与「发给用户的域名」拆成两件事。
--
-- `zone_id` 必须按域存：DNS 记录、Worker Route 都是**按 zone** 操作的，
-- Cloudflare 的 API 路径里直接带 zone id。缺省时由 Worker 调
-- `GET /zones?name=<name>` 解析一次并回填（见 src/root-domains.ts）。
--
-- `requires_feature` 指向 permissions.ts 的 Feature；非空表示「必须先解锁该权限
-- 才能把子域名/邮箱建在这个域下」。当前 doulor.cn 挂 `doulor`，默认不放开。
--
-- 注意：线上 `d1_migrations` 为空，迁移一律**手工执行**：
--   npx wrangler d1 execute doulor-mail --remote --file=./worker/migrations/0095_root_domains.sql
CREATE TABLE IF NOT EXISTS root_domains (
  name             TEXT PRIMARY KEY,           -- 主域名（小写），如 doulor.cn / tyu.me
  zone_id          TEXT,                       -- Cloudflare zone id（可空，首次使用时解析并回填）
  label            TEXT,                       -- 展示名（可空，前端回落到 name）
  requires_feature TEXT,                       -- 需要哪个权限才能选它（NULL = 人人可用）
  is_default       INTEGER NOT NULL DEFAULT 0, -- 新用户注册 / 新建时的默认域（全局只应有一行为 1）
  enabled          INTEGER NOT NULL DEFAULT 1, -- 关掉后不再出现在可选列表里
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_root_domains_default ON root_domains(is_default, enabled);
