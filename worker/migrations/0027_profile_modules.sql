-- 个人名片：模块系统 + 中文字体栈
--
-- 背景（2026-09-23 美学重构）：
--   旧名片「主题只换 CSS 变量、结构只有一种」，不同用户搭出来的页面趋同。
--   本次把名片升级为「模块化的组装页」：除身份/联系方式/音乐外，新增
--   兴趣标签、名言、当前状态、大事记时间线、图片墙、访问统计等模块，
--   可开关、可排序；同时新增中文正文字体栈（旧 font 只管英文标题字）。
--
-- modules: JSON 数组字符串，每个元素形如
--   {"id":"tags","enabled":true,"items":["摄影","骑行"]}
--   {"id":"quote","enabled":true,"text":"……","author":"……"}
--   {"id":"status","enabled":true,"emoji":"🎧","text":"在听歌"}
--   {"id":"timeline","enabled":true,"items":[{"date":"2024","title":"……","desc":"……"}]}
--   {"id":"gallery","enabled":true,"items":[{"url":"https://…","caption":"……"}]}
--   {"id":"identity|links|music|stats","enabled":true}
--   数组顺序即展示顺序；identity 恒在头部、status 跟随身份区、stats 恒在页脚，
--   其余模块按数组顺序排列。缺省：identity/links/music/stats 启用，其余停用。
--
-- cjk_font: 单值字符串，中文正文字体栈 id
--   可选值: system（默认黑体）/ song（宋体系，书卷气）/ kai（楷体系，手写感）/ yuan（圆体系）
--   仅系统字体栈，不引入 CJK webfont（体积太大）；主题可自带默认，用户选择优先。

ALTER TABLE profiles ADD COLUMN modules  TEXT NOT NULL DEFAULT '[]';
ALTER TABLE profiles ADD COLUMN cjk_font TEXT NOT NULL DEFAULT 'system';
