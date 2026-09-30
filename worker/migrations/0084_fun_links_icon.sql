-- 0084: 「有趣的网页分享」记录条目自己的图标地址
--
-- 存的是**原始图标 URL**（可能是第三方域名）。工具页不直接用这个地址渲染，
-- 而是走 `GET /api/fun-links/icon/:id` 由 Worker 代理取回 —— 这样能避开
-- 「http 图标在 https 页面上被浏览器拦掉」和「第三方防盗链」两个坑。
--
-- 空串 = 没图标（前端回退成首字母头像）。
ALTER TABLE fun_links ADD COLUMN icon_url TEXT NOT NULL DEFAULT '';
