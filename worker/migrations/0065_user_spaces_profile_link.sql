-- 0065_user_spaces_profile_link.sql
-- 空间页新增「跳转到名片」入口开关：用户有已发布名片时，空间页显示一个跳转按钮，
-- 这个开关让用户决定是否展示。默认开（1）。

ALTER TABLE user_spaces ADD COLUMN show_profile_link INTEGER NOT NULL DEFAULT 1;
