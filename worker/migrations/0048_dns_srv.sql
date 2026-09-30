-- 0048_dns_srv.sql
-- DNS 记录新增 SRV 类型。
--
-- 为什么需要：SRV 是「把服务名映射到主机:端口」的标准记录类型，Minecraft、
-- Matrix/Element、SIP、XMPP、邮件自动发现（_autodiscover._tcp）等都靠它。
-- 此前只支持 A/AAAA/CNAME/TXT/MX，用户想给自建服务配 SRV 只能去别处托管 DNS。
--
-- 为什么不把 SRV 塞进 content 一列就够了：Cloudflare 的 SRV 记录要么传
-- `content` 字符串（"priority weight port target"），要么传 `data` 对象。
-- 两者等价，但**结构化存**才能让「更新记录」时重建 data 对象
-- （updateDns 会这么做），也免得以后再想做编辑 UI 时去解析字符串。
--
--   srv_weight / srv_port / srv_target —— SRV 专有字段
--   priority 复用现有列（CF 对 MX 与 SRV 都叫 priority，语义相同：值小者优先）
--   content 仍写「渲染后的字符串」，让列表展示与现有 UI 无需改动
--
-- service / proto 不单独存：它们是 fqdn 的一部分（_sip._tcp.blog.example.com），
-- 拆出来反而要维护两份真相（name 与 fqdn 已经是这个关系，不再加一层）。

ALTER TABLE dns_records ADD COLUMN srv_weight INTEGER;
ALTER TABLE dns_records ADD COLUMN srv_port INTEGER;
ALTER TABLE dns_records ADD COLUMN srv_target TEXT;
