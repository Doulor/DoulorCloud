-- 0145_lab_store.sql
-- AI 实验室：**作品的键值存储**（2026-10-10 站长要求）。
--
-- 解决什么：现在作品是「海报」—— 游客打了字、点了按钮，一刷新全没了，
-- 因为页面**没地方存**。有了这张表，留言板 / 计数器 / 待办 / 投票才真的能用。
--
-- ⚠️ 为什么用 D1 而不是 Cloudflare KV（2026-10-10 查实）：
--   KV 免费版 **每天只能写 1,000 次**（超了直接报错，不是降速），
--   且**同一个 key 每秒只能写 1 次**、还是**最终一致**（最长 60 秒才可见）。
--   而「留言板 / 计数器」恰恰全是写、还是热点 key —— KV 是最差的选择。
--   D1 免费版 10 万行/天写、500 万行/天读，我们已经在用。
--
-- 🔴 这是一张**对公网开放写入**的表（作品挂谁都能访问的域名上）。
--    配额与节流见下面两张表 —— 没有它们，一晚上就能被刷爆。

CREATE TABLE IF NOT EXISTS lab_project_kv (
  project_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);

-- 单项目最多 200 个键（够留言板/清单/计数）；超了报错而不是静默丢
CREATE INDEX IF NOT EXISTS idx_lab_project_kv_project ON lab_project_kv (project_id);

-- 写入节流：每项目每分钟一个计数桶。
-- ⚠️ 必须落库而不是放内存 —— Worker 是无状态的，内存计数在实例切换后就失效了。
CREATE TABLE IF NOT EXISTS lab_store_quota (
  project_id   TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,  -- 该分钟桶的起始（毫秒）
  count        INTEGER NOT NULL
);
