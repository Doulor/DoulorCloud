-- 0083: 给「有趣的网页分享」加分类（唯美 / 工具）
--
-- 存量数据全部落 'tool'（当初放的基本都是工具类站点），站长可在管理面板逐条改。
-- 列名用短键而不是中文，前端负责显示「唯美 / 工具」。
ALTER TABLE fun_links ADD COLUMN category TEXT NOT NULL DEFAULT 'tool';
