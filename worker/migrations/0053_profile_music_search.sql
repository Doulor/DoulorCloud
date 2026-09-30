-- Doulor Cloud D1 迁移：名片音乐「按歌名搜索」
-- 在 0052 之上执行（保持幂等）。
--
-- 背景：此前名片音乐只支持「上传音频」或「粘贴外链」，用户得自己先找好音频文件。
-- 新增能力是「输入歌名 → 选中 → 自动填好音频/封面/歌词」，同时保留原有两条路径。
--
-- 两列的分工：
--   music_source  音乐来源标记，形如 'netease:1330348068'（provider:songId）。
--                 NULL = 用户自定义（上传到 R2 的 music_key，或外链 music_url）。
--                 有值时，播放地址由 Worker 在请求时实时解析得到，**不入库**。
--   music_lyrics  歌词全文（LRC 格式，含 [mm:ss.xx] 时间轴），供名片页做同步滚动。
--                 用户自定义音乐时也可以手填，所以不限定来源。
--
-- ⚠️ 为什么只存 id、不存播放链接（这是本迁移最重要的设计决定）：
--   音频源返回的是带时效签名的地址，形如
--     https://m701.music.126.net/20260925213236/.../xxx.mp3?vuutv=<长令牌>
--   路径里含时间戳、query 里含令牌，大约 20 分钟后就失效。
--   若把解析结果落库，几小时后所有名片的背景音乐都会变成死链
--   （同类事故参考：名片 QQ 按钮曾硬编码第三方 res.abeim.cn，该域名后来全线失联）。
--   所以播放地址必须每次实时解析；music_source 存的是稳定的「来源 + 歌曲 id」。
--
-- 存量数据不受影响：两列默认 NULL，所有已有名片继续走原有的 key/url 逻辑。

ALTER TABLE profiles ADD COLUMN music_source TEXT;
ALTER TABLE profiles ADD COLUMN music_lyrics TEXT;
