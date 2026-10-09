-- 0140_lab_prompt_templates.sql
-- AI 实验室：**系统提示词模板**（2026-10-09）。
--
-- 背景：原先只有一个 `app_settings.lab_agent_prompt` 覆盖值 —— 要么用内置默认，
-- 要么全站换成另一份。站长要的是「多存几份、挑几份启用、用户自己切换」，
-- 一个字符串放不下，所以单独开表。
--
-- 与 `lab_agent_prompt` 的关系（**保留它做兜底**）：
--   · 有启用中的模板 → 用模板（用户可在实验室里切换）；
--   · 一个都没启用   → 退回到 `lab_agent_prompt`（非空则覆盖内置默认），再退回内置默认。
--   这样升级时不会有任何行为突变。
--
-- `content` 存的是**完整提示词正文**（不含站点能力索引那一段 ——
-- 那部分是 `buildSystemPrompt()` 每次拼接时追加的，不进模板，免得改一次忘一处）。
--
-- ⚠️ 不预置数据：内置默认提示词写在前端 `src/lib/lab-agent.ts` 的 `AGENT_SYSTEM`，
--    往表里复制一份就会有两个真相、改一处漏一处。
--    管理面板里有「把内置默认存为模板」按钮，需要时一键落库再改。

CREATE TABLE IF NOT EXISTS lab_prompt_templates (
  id         TEXT PRIMARY KEY,
  -- 展示名（用户端切换按钮上显示的就是它）
  name       TEXT NOT NULL,
  -- 完整提示词正文
  content    TEXT NOT NULL,
  -- 是否启用：只有启用的模板才会下发给用户端
  enabled    INTEGER NOT NULL DEFAULT 0,
  -- 排序权重（小的在前）；新建时取当前最大值 +1，保证稳定顺序
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 用户端只查「启用中的」，管理端要全部；这个索引覆盖前者
CREATE INDEX IF NOT EXISTS idx_lab_prompt_templates_enabled
  ON lab_prompt_templates (enabled, sort_order);
