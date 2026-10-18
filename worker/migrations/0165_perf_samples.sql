-- 0146: 前端性能样本（RUM，Real User Monitoring）
--
-- 背景：站点功能越来越多，「哪个页面卡」只能靠用户反馈猜。这里落一份
-- 真实用户性能样本：前端 src/lib/perf-collect.ts 在每次页面加载后采集
-- 加载耗时指标（TTFB / DCL / LCP），路由切换时长，以及长任务计数，
-- sendBeacon 上报到这里。管理面板「性能监控」工具（scope=perf）聚合成
-- 按页面 / 按指标的分布，用于定位「哪个功能导致的卡顿」。
--
-- 隐私边界（与 analytics_events 同一口径）：不存 IP、不存 UA、不存任何身份
-- —— user_id 仅用于「按用户维度看自己是否异常」，管理员界面不展示用户名。
--
-- 写入侧限流：每用户每 10 分钟最多 120 条（见 handlers/perf.ts），打满即静默丢。
-- 保留期 14 天（maintenance.ts 的 PERF_RETENTION_DAYS），过期整行删。
--
-- 部署顺序：先跑本迁移，再部署后端。

CREATE TABLE IF NOT EXISTS perf_samples (
  id TEXT PRIMARY KEY,
  /** 上报者（登录用户）；匿名会话上报者取不到时为空串 */
  user_id TEXT NOT NULL DEFAULT '',
  /** 页面标识：复用路由注册表的语义路径（如 /dashboard/points），限长 120 */
  page TEXT NOT NULL,
  /** 视口类别：desktop / mobile（≤ 768px），窄屏设备卡顿常由此定位 */
  device TEXT NOT NULL DEFAULT '',
  /** 首屏加载：TTFB（ms），无导航计时（SPA 内首帧）时为 NULL */
  ttfb_ms INTEGER,
  /** 首屏加载：DOMContentLoaded（ms） */
  dcl_ms INTEGER,
  /** 首屏加载：LCP（ms），PerformanceObserver 报告值 */
  lcp_ms INTEGER,
  /** 本次会话累计长任务数（>50ms 的任务，PerformanceObserver longtask） */
  long_tasks INTEGER,
  /** 该页面本次加载的 JS/资源错误数（window error 计数） */
  errors INTEGER,
  /** 路由切换耗时（ms）：从点击导航到新页面可交互，仅切换样本有 */
  nav_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_perf_samples_page
  ON perf_samples (page, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_perf_samples_created
  ON perf_samples (created_at DESC);
