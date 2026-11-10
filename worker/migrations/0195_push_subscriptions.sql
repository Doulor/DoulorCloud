-- 0195_push_subscriptions.sql
-- Web Push 订阅与 VAPID 密钥（2026-11-10）
--
-- 背景：站长问「为什么是 60 秒、能不能不走轮询」。轮询是网页/WebView 里唯一不依赖
-- 推送服务的手段，但它在两个地方天然不灵：
--   · 页面切后台后，浏览器会把定时器节流到约 1 次/分钟 —— 再快也会被拉回来；
--   · App 的 WebView 进后台往往整个被冻结 —— 轮询直接停摆。
-- 真正的答案是 **Web Push**：服务端一推，Service Worker 立刻醒，页面关着也能弹。
--
-- push_subscriptions：每个浏览器/设备一条订阅（RFC 8291 的 p256dh + auth）。
-- push_vapid_keys  ：VAPID 签名密钥（RFC 8292），全局一份，**只在服务端使用**。
--   私钥绝不下发；对外只暴露 public_raw（前端订阅时要用 applicationServerKey）。
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  -- 推送服务端点（FCM/Mozilla/Apple…），同一个端点天然唯一
  endpoint    TEXT NOT NULL,
  -- 客户端公钥（base64url，未压缩 P-256 点，65 字节）
  p256dh      TEXT NOT NULL,
  -- 16 字节鉴权密钥（base64url）
  auth        TEXT NOT NULL,
  -- 便于排查：哪个设备/浏览器订阅的
  ua          TEXT,
  created_at  TEXT NOT NULL,
  -- 最近一次成功推送时间（失败太多次的可以人工清理）
  last_ok_at  TEXT
);

-- 一个端点只能有一条；重订阅时按 endpoint 覆盖（见 handlers/push.ts）
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_sub_endpoint ON push_subscriptions(endpoint);
CREATE INDEX IF NOT EXISTS idx_push_sub_user ON push_subscriptions(user_id);

-- VAPID 密钥对（单行）。private_jwk 是导出的 JWK JSON，含私钥 —— 只在 Worker 里读。
CREATE TABLE IF NOT EXISTS push_vapid_keys (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  private_jwk TEXT NOT NULL,
  public_raw  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
