-- 捐献节点归属 + 租用分成（2026-10-14）
--
-- 站长要求：租用者支付的积分按比例分成给**捐献者**，默认 10%，比例后台可改。
--
-- 为什么必须先加这一列：`frp_nodes` 里原本没有「这个节点是谁捐的」——
-- 只有一个 `source_donation_id` 间接指向捐献记录，而一键脚本捐进来的节点
-- 连捐献记录都没有（走的是 /api/frp/donate/register，不建 donations 行）。
-- 没有归属就无从分成。
--
-- 可空：平台自营节点（我自己的服务器）没有归属用户，NULL = 平台自营，
-- 这时租用收入全额销毁（不分成）。
--
-- 不加外键级联删除：用户注销后节点不该跟着消失 —— 那会把正在用这条隧道的
-- 租用者一起弄掉。保留成"无主节点"，由管理员处理。

ALTER TABLE frp_nodes ADD COLUMN owner_user_id TEXT;

-- 回填：老捐献流程（config.yml + 审核）进来的节点，通过捐献记录找回归属用户。
-- 一键脚本捐的节点在登记时直接写 owner_user_id，不依赖这一步。
UPDATE frp_nodes
SET owner_user_id = (
  SELECT d.user_id FROM donations d WHERE d.id = frp_nodes.source_donation_id
)
WHERE owner_user_id IS NULL
  AND source_donation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_frp_nodes_owner ON frp_nodes(owner_user_id);
