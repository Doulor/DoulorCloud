-- 0145: 诊断日志（用户反馈可附带「问题发生时间段」内的前端运行记录）
--
-- 背景：用户提文字反馈后，站长没法 1:1 复现问题（设备/网络/操作序列都拿不到）。
-- 前端有一个常驻的环形缓冲记录器（src/lib/diag-log.ts，路由切换 / JS 报错 /
-- 接口失败 / 长任务 / 加载指标），用户提交反馈时可勾选「附上诊断日志」并选择
-- 时间窗（5 / 15 / 60 分钟），前端把窗口内的记录打包上传到这里。
--
-- 为什么独立成表而不塞进 feedback 行：
--   · payload 可达 64KB，feedback 表是高频读的列表表，塞大字段会拖累每一次列表查询；
--   · 日志有自己的保留期（14 天，见 maintenance.ts），到期整行删，不碰反馈本身。
--
-- feedback.diag_log_id：一条反馈至多附一份日志，管理端详情接口据此联查。
-- 用户删反馈不级联删日志（由保留期统一清理）；日志先于反馈过期时详情接口返回 null。
--
-- 部署顺序：先跑本迁移，再部署后端（旧后端不认识新列，INSERT 不带它不报错；
-- 新后端读旧库缺列才会 500，所以先迁移）。

CREATE TABLE IF NOT EXISTS diagnostic_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  /** 时间窗（分钟）：5 / 15 / 60，前端选择后原样记录 */
  window_minutes INTEGER NOT NULL,
  /** 实际打包的条目数（截断后） */
  entry_count INTEGER NOT NULL,
  /** 是否因超过体积上限被截断（截掉最旧的条目） */
  truncated INTEGER NOT NULL DEFAULT 0,
  /** 环形缓冲导出的 JSON（短键数组），上限 64KB */
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diag_logs_user
  ON diagnostic_logs (user_id, created_at DESC);

ALTER TABLE feedback ADD COLUMN diag_log_id TEXT;
