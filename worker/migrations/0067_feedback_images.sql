-- 0067_feedback_images.sql
-- 反馈支持上传图片。
--
-- feedback 表（用户首次提交）与 feedback_messages 表（对话追加 / 管理员回复）
-- 各加 images 列：存 R2 key 的 JSON 数组，形如
--   ["feedback/<userId>/<uuid>.webp", ...]
--
-- key 里带上上传者 userId（不是反馈 id）：图片在「提交反馈」之前就要先上传拿到
-- key（否则要等建单才有 id，体验割裂），所以不能用反馈 id 做前缀。userId 让图片
-- 读取时能 O(1) 鉴权 —— 只有上传者本人与管理员能看，反馈是私有工单，图片也必须私有。

ALTER TABLE feedback ADD COLUMN images TEXT;
ALTER TABLE feedback_messages ADD COLUMN images TEXT;
