-- Doulor Cloud D1 迁移：内网穿透捐献改为「捐献一台 frps 服务端」
--
-- 背景（2026-09-25 改版）：
--   旧模型要求捐献者粘贴**客户端** config（frpc 的配置）。那东西对本站没用：
--   它里面只有捐献者自己在那台服务器上的账号（user / metadatas.token），
--   既拿不到服务端凭据、也没法给别的用户开端口，等于一条无法落地的死数据。
--
--   新模型：**服务器的主人**登记服务端信息（serverAddr / 端口范围 / 鉴权方式），
--   审核通过后由系统直接建出一条 frp_nodes，用户立刻可以申请账号与端口。
--
--   捐献者还要粘贴一份「能连上他这台服务器的 frpc.toml 示例」—— 这份样例会被
--   **参数化**（把他自己的 user / token 换成占位符）后存进 config_template，
--   用于给每个用户渲染配置。这样无论对端 frps 是裸的、还是加了鉴权插件，
--   我们都能生成正确配置，而不必把插件种类写死在代码里。

-- ============================================================
-- frp_nodes：记录鉴权方式与配置模板
-- ============================================================

-- 鉴权方式：
--   none       最基础的 frps，无任何鉴权
--   token      只有一个全局 auth.token
--   token_user 全局 auth.token + 每用户 user/metadatas.token（= 本站现有两台节点的形态）
--   custom     其它（依赖 config_template 里的自定义字段，如第三方鉴权插件）
ALTER TABLE frp_nodes ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'token';

-- 配置模板：由捐献者提供的 frpc.toml 样例**参数化**而来，已剥掉其个人凭据。
-- 占位符：{serverAddr} {serverPort} {authToken} {user} {password} {proxies}
-- 为空时前端回落到内置生成器（兼容本次改版前的老节点）。
ALTER TABLE frp_nodes ADD COLUMN config_template TEXT;

-- 来源捐献：批准时写入。撤销捐献时按这个反查，把节点停用掉。
-- 手工在管理面板建的节点此列为 NULL（不会被任何捐献的撤销动作波及）。
ALTER TABLE frp_nodes ADD COLUMN source_donation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_frp_nodes_source_donation
  ON frp_nodes(source_donation_id);

-- ============================================================
-- 说明：不需要改 donations 表
-- ============================================================
-- 捐献与节点的关联走 frp_nodes.source_donation_id 反查即可，
-- 不在 donations 上再加一列（少一列就少一处要手工补的线上 DDL）。
