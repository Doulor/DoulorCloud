-- 0141_lab_skills.sql
-- AI 实验室：**技能（skills）**（2026-10-10）。
--
-- 站长要求的触发方式：**渐进式披露**（同主流 agent）——
--   · 系统提示里只放每个技能的「名字 + 一句话说明」，占的 token 很少；
--   · 模型判断这个技能跟当前任务相关时，才输出 <lab_skill name="…"/> 去读正文；
--   · 正文由循环作为「工具结果」回喂，不进系统提示。
-- 这样技能再多也不会把上下文撑爆，也不会让模型在无关任务上被一堆说明书干扰。
--
-- 归属用 `owner_user_id` 一个字段表达两件事：
--   · NULL   = **站点默认技能**（管理面板维护，所有人可用）；
--   · 非 NULL = 某个用户自己导入的，只有他自己看得见。
-- 之所以不分两张表：字段完全一样、查询永远是「我的 ∪ 站点默认」，
-- 分表只会让每次查询都要 UNION，还得两处各写一遍清洗规则。
--
-- ⚠️ `name` 是模型用来引用的**标识符**（英文短横线风格，如 pdf-forms），
--    不是给人看的标题；给人看的标题放 `description` 里说清楚。
--    同一归属下 name 唯一（见下面的唯一索引），否则模型 <lab_skill name="x"/>
--    会歧义 —— 到底读谁的正文。

CREATE TABLE IF NOT EXISTS lab_skills (
  id            TEXT PRIMARY KEY,
  -- 站点默认技能固定用 'site'，用户技能固定用 'user'（便于两套约束各写各的）
  scope         TEXT NOT NULL DEFAULT 'site',
  -- 模型引用的标识符：小写字母/数字/短横线
  name          TEXT NOT NULL,
  -- 一句话说明：**这一句会进系统提示**，要写清「什么时候该用它」
  description   TEXT NOT NULL,
  -- 完整正文（SKILL.md 风格），只在模型主动读了之后才进上下文
  content       TEXT NOT NULL,
  -- 站点默认技能：是否下发；用户技能：恒为 1（用户自己导入就是要用）
  enabled       INTEGER NOT NULL DEFAULT 1,
  -- NULL = 站点默认；否则是拥有者 user id
  owner_user_id TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 用户端每次开一轮都要读「我的 + 站点默认」，这个索引覆盖它
CREATE INDEX IF NOT EXISTS idx_lab_skills_owner
  ON lab_skills (scope, owner_user_id, enabled, sort_order);

-- 同一归属下 name 不能重复（模型靠 name 引用，重复就有歧义）
CREATE UNIQUE INDEX IF NOT EXISTS idx_lab_skills_name
  ON lab_skills (name, IFNULL(owner_user_id, ''));

-- ⚠️ 不预置任何技能：内置的「怎么写网页」那套规矩已经在系统提示词里了，
--    做成技能反而每次都要多读一轮。管理面板里有入口，需要时再建。
