-- 0131_lab_projects.sql
-- 网页实验室：用户通过 AI 聊天生成的小网页（作品）。
--
-- 说明：
--   · files 是 JSON：{ "index.html": "…" }（一期只有单文件，结构上留好多文件的余地）
--   · visibility: private（默认，仅自己）→ pending（申请公开）→ public / rejected（二期接审核与托管）
--   · 对外托管（lab.tyu.me 等）在二期接通；本表先承载「聊天生成 → 保存作品」

CREATE TABLE IF NOT EXISTS lab_projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '🌐',
  files TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'private',
  review_note TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_lab_projects_user ON lab_projects (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lab_projects_public ON lab_projects (visibility, published_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lab_projects_slug ON lab_projects (user_id, slug);
