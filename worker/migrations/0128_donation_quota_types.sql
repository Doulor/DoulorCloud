-- 0128_donation_quota_types.sql
--
-- 捐献额度发放的**用户级幂等标记**（2026-10-08）。
--
-- 背景：`applyDonationApproval` 原先用「这个用户还有没有**别的**同类型已批准单据」
-- 作为发额度的判据（`... AND id != ?`）。该判据问的不是「这个用户的这类额度发过
-- 没有」，而且 `id != ?` 把这行自己排除在外 ⇒ 只要审批那一刻库里没有别的 approved
-- 行，就再发一轮。实测可无限刷的四条路径（每条都有回归用例守着，
-- 见 worker/test/donation-quota-idempotency.test.ts）：
--   ① 单行反复覆盖重提：同一上游再提交会复用同一行 id 并重置 pending，自动审核
--      通过后闸门看不到「别的 approved」⇒ 10 轮把 invite_quota_bonus 从 2 刷到 20；
--   ② 撤销 → 重新批准同一单据：撤销把它置回 pending，闸门随之变假 ⇒ 再发一轮；
--   ③ 两条单据**同时**非 approved（都被撤销，或上游抖动使覆盖重提后转 pending）
--      ⇒ 逐条重批时「另一条」不是 approved ⇒ 每轮 +2，实测 4 轮 2→10；
--   ④ 撤销 → 用户删除那条 pending 单据（`cancelDonation` 是直接 DELETE）→ 重提
--      同一上游（`hasDuplicateUpstream` 只扫 pending/approved，扫不到已删的行）
--      ⇒ 新建一条 ⇒ 再发，实测 3 轮 2→8。
--
-- ⚠️ 为什么标记挂在**用户**上而不是单据上：④ 说明「行级标记」拦不住删除 ——
-- 行没了，标记跟着没了。而 H2 原本的语义（`applyDonationApproval` 的注释：
-- 「同一类型最多奖励一次 ⇒ 单个用户一生最多拿 3 份」）本来就是**用户级**的，
-- 用行级查询去表达它才是这批漏洞的共同来源。挂到 users 上，删除、撤销、
-- 覆盖重提都动不了它。
--
-- 语义：`{"ai":1,"proxy":1}` = 该用户的 AI / 代理额度已发放过。
--   键是**捐献类型**（与旧判据 `type = ?` 对齐；商汤不发额度、从不写键）。
--   值为 1 仅作存在性标记，不计数 —— 本表的意义是「发过没有」，不是「发了几次」。
--
-- 回填（必须）：不回填的话老账号的历史 approved 单据全无标记，判据会退化成
-- 「每笔新单据都发」，比修复前更宽松。按「有该类型 approved 单据的用户」标记，
-- 与旧闸门在「账号只有一条 approved」时的行为一致。
--
-- ⚠️ 线上 D1 **不要跑 migrations apply** —— 本仓库的 D1 由站长手工执行。
--   `--config wrangler.toml` 不能省：仓库用的是 wrangler.toml，而 wrangler 默认找
--   wrangler.jsonc，省略会直接报 `Couldn't find a D1 DB with the name or binding
--   'doulor-mail' in your wrangler.jsonc file`（已实测）。与 0127 的写法一致：
--   cd worker && npx wrangler d1 execute doulor-mail --remote --config wrangler.toml \
--     --file=./migrations/0128_donation_quota_types.sql
--
-- 执行顺序：**先跑本迁移，再合并/部署后端**。反过来的话，新代码在列还不存在的
-- 那一刻就会 `no such column` 打成 500（`applyDonationApproval` 的占位语句没有
-- 兜底 try/catch），捐献审批会全部失败。旧代码不读这一列，所以先跑迁移对线上零影响。
--
-- 只跑一次：`ALTER TABLE ADD COLUMN` 不幂等，重跑报 `duplicate column name`（已实测）。
-- 若只重跑下面三条 UPDATE（回填）则是幂等的，结果不变。
--
-- 本迁移**不回滚**：加列是纯增量，旧代码完全不读它。若要撤销这次修复，直接回退代码
-- 即可，这一列留着不会有任何影响。
--
-- ⚠️ 本列**不能**写进 schema.sql：ALTER 不幂等，写进基线会让
-- 「schema.sql + 迁移链」的测试环境重复加列而报错（见 schema.sql:415 的同类说明）。

ALTER TABLE users ADD COLUMN donation_quota_types TEXT;

-- 回填：凡有该类型 approved 单据的用户，视为该类额度已发放过。
-- 逐类型一条，避免在一条 SQL 里做复杂的 JSON 聚合。
UPDATE users
   SET donation_quota_types = json_set(
         CASE WHEN json_valid(donation_quota_types) THEN donation_quota_types ELSE '{}' END,
         '$.ai', 1)
 WHERE id IN (SELECT user_id FROM donations WHERE status = 'approved' AND type = 'ai');

UPDATE users
   SET donation_quota_types = json_set(
         CASE WHEN json_valid(donation_quota_types) THEN donation_quota_types ELSE '{}' END,
         '$.proxy', 1)
 WHERE id IN (SELECT user_id FROM donations WHERE status = 'approved' AND type = 'proxy');

UPDATE users
   SET donation_quota_types = json_set(
         CASE WHEN json_valid(donation_quota_types) THEN donation_quota_types ELSE '{}' END,
         '$.frp', 1)
 WHERE id IN (SELECT user_id FROM donations WHERE status = 'approved' AND type = 'frp');
