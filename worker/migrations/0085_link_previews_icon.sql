-- 0085: 链接卡片预览记录站点的图标地址
--
-- 背景：很多页面（典型如 QQ 群邀请页 `qm.qq.com/q/xxx`）**没有 og:image**，
-- 于是卡片就没有图，只剩几行干巴巴的文字。这里把页面声明的 favicon（或
-- 兜底 `<origin>/favicon.ico`）也存下来，前端在「没有大图」时用它补一个图标位。
--
-- 注意与 image 的区别：image 是 og:image（大图，铺满卡片左侧），
-- icon 是站点图标（小图，居中显示）。两者可能只有一个有值。
ALTER TABLE link_previews ADD COLUMN icon TEXT;
