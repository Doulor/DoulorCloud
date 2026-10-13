-- 0148_collection_plugins.sql
-- 造物典藏（游戏大厅）—— 插件清单表（2026-10-11）。
--
-- 为什么要有这张表：造物典藏**不是一个硬编码的页面**，而是一个插件宿主。
-- 大厅里的每张卡片、每个入口、每个全屏界面，都由这里的一行描述。
-- 「在线投资」只是第一行 kind='builtin' 的记录。
--
-- ---
-- 内置插件 vs 用户插件（**同一套框架，只有授权范围不同**）
-- ---
--   kind='builtin' —— 本站维护的游戏（如在线投资）。可以带自己的数据表与
--                    完整服务端逻辑，前端是一个真实的 React 组件（runtime='react'）。
--   kind='user'    —— 将来开放给普通用户做的游戏。前端是用户写的 HTML，
--                     跑在与造物集作品**同一套** sandbox iframe 里（拿不到会话 cookie），
--                     runtime='sandbox'。服务端**只能**通过站内提供的受限能力
--                    （存档 / 排行榜 / 计数器 / 服务端随机数）访问数据，
--                    **永远不能跑任意服务端代码** —— 那等于把服务器交出去。
--
-- 两者的清单字段、入口路由（/dashboard/gallery/collection/<slug>）、
-- 宿主组件、配置面板、管理端分类**完全一致**。所以将来开放用户插件时，
-- 框架一行都不用改，只是多出 kind='user' 的行、并启用沙盒宿主。
--
-- ---
-- 字段说明
-- ---
-- runtime  ：react（内置组件）/ sandbox（用户 HTML）—— 宿主据此选择渲染方式
-- status   ：draft 草稿 / review 待审核 / published 已上架 / disabled 已下架
--            （v1 只有 published；其余三态是给将来用户插件的审核流预留的，
--              不留的话将来要改表 + 改所有查询条件）
-- capabilities：JSON 数组，声明这个插件需要哪些服务端能力。
--            内置插件可声明 'native'（自带表与 handler）；用户插件只允许白名单内的键。
-- config   ：JSON，插件自己的配置。内置插件的**玩法参数**刻意不放在这里 ——
--            那些是站点设置项（app_settings），要能被 check-settings.mjs 守护
--            「每个声明了的设置项都真的被读到」。这里只放展示性 / 插件元数据。
--
-- ⚠️ 内置插件的清单**以代码为权威源**（worker/src/collection-plugins.ts），
--    服务启动时（懒）upsert 进这张表。这样：
--      · 清单只有一条读取路径（查表），将来用户插件天然共用；
--      · 而插件定义跟着代码走，能进 git、能 review、能版本化。
--    如果反过来「以库为权威」，内置插件的名字/图标就只能靠手改库，一改环境就漂移。

CREATE TABLE IF NOT EXISTS collection_plugins (
  slug         TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  -- 卡片上的 emoji（与造物集作品一致：有封面图才用图，否则用 emoji）
  icon         TEXT    NOT NULL DEFAULT '',
  -- 一句话卖点（卡片副标题）
  tagline      TEXT    NOT NULL DEFAULT '',
  -- 更长的介绍（详情用）
  description  TEXT    NOT NULL DEFAULT '',
  -- 卡片主题色（hex，如 '#f59e0b'）；空 = 用站点默认灰。不是图片，只是强调色
  accent       TEXT    NOT NULL DEFAULT '',
  kind         TEXT    NOT NULL DEFAULT 'builtin',
  -- 用户插件的作者；NULL = 平台自有
  owner_id     TEXT,
  runtime      TEXT    NOT NULL DEFAULT 'react',
  status       TEXT    NOT NULL DEFAULT 'published',
  -- 大厅卡片排序（小的在前）
  sort_order   INTEGER NOT NULL DEFAULT 0,
  capabilities TEXT    NOT NULL DEFAULT '[]',
  config       TEXT    NOT NULL DEFAULT '{}',
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

-- 大厅只查 published，且按 sort_order 排 —— 索引与查询条件对齐。
CREATE INDEX IF NOT EXISTS idx_collection_plugins_hall
  ON collection_plugins(status, sort_order, slug);
-- 将来「我的游戏」列表按作者查
CREATE INDEX IF NOT EXISTS idx_collection_plugins_owner
  ON collection_plugins(owner_id, updated_at DESC);
