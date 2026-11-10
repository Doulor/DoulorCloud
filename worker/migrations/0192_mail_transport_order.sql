-- 0192_mail_transport_order.sql
-- 发信通道重构（2026-11-08 站长要求）：Posta 下线 + 新增 cf-send
--
-- 背景：站长的发信链原为 brevo / posta / cf 三条，要求改成
--   brevo → cf-send（Cloudflare Email Sending REST API，可发任意邮箱）
-- 自建的 Posta 网关整体删除；`cf` 这个旧名也一并改成 `cf-routing`。
--
-- 为什么默认链里**没有 cf-routing**（同一天的第二个决定）：它发不了任意收件人，
-- 唯一的独立价值是"已验证地址免费不限量"，而那批地址已经由 mail_cf_targets
-- 白名单直接接管。放进回退链只会让每封普通邮件先白失败一次。
--
-- 为什么 CF 排在 Brevo 后面：Brevo 超额度只是发不出去（不扣费），
-- Cloudflare 超了 3,000 封/月要真扣钱（见 0193 + 设置项 cf_send_monthly_cap）。
UPDATE app_settings
   SET value = 'brevo,cf-send',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE key = 'mail_transport_order'
   AND (
        value LIKE '%posta%'
     OR value = 'cf'
     OR value LIKE 'cf,%'
     OR value LIKE '%,cf'
     OR value LIKE '%,cf,%'
     OR value = 'brevo,cf-send,cf-routing'
   );

-- 公告群发的首选通道：旧默认值是 posta，现在默认 brevo（同样是读取侧也会兜底）
UPDATE app_settings
   SET value = 'brevo',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE key = 'announcement_mail_transport'
   AND value = 'posta';

-- 清掉 Posta 的三条孤儿配置。留着它们只会在「设置」里显示成读不懂的项，
-- 而且没有任何代码再读取它们（通道已删除）。
DELETE FROM app_settings WHERE key IN ('posta_url', 'posta_key', 'posta_from');

-- 注：曾有一条把 cf_send_from 从 no-reply@doulor.cn 改成 mail.doulor.cn 的 UPDATE，
-- 已删除 —— 站长 2026-11-08 确认发送域名是**根域 doulor.cn**（mail.doulor.cn 是
-- Brevo 的品牌域，CF 侧没有 Onboard 它），改过去反而会发不出去。
