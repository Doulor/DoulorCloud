/**
 * 公开名片的 HTML 渲染。
 *
 * 为什么在 Worker 里拼 HTML 而不走 React SPA：
 *   1. 需求要求名片「全屏、不含 Doulor Cloud 外壳」——SPA 会带上站点布局；
 *   2. 自定义域名下地址栏要显示用户自己的域名，SPA 路由做不到干净的根路径；
 *   3. 独立 HTML 便于分享预览（微信/Twitter 抓取 og 标签）。
 *
 * 所有用户输入都必须转义（见 esc），否则名片字段会成为 XSS 入口。
 *
 * 主题(theme) / 动效(effects) / 开屏动画(intro) / 字体(font) 四者独立混搭：
 *   - theme：6 个预设，用 CSS 变量驱动，只改变量
 *   - effects：独立勾选数组，CSS 动效输出样式、JS 动效输出 IIFE；particles/rain 互斥
 *   - intro：4 种开屏，交互式(enter/portal)需 click handler，非交互式(fade/slide)纯 CSS
 *   - font：自托管 woff2，仅英文/拉丁字符，中文回退系统字体栈
 */
import type { PublicProfile, Contact } from "./handlers/profile"

/**
 * 把联系方式拼成可点击链接。
 * 服务端拼接的好处：用户只需填原始值（QQ 号 / UID / 用户名），
 * 避免在前端各处重复实现拼接规则、也防止用户填出 javascript: 之类的危险协议。
 */
function contactLink(c: Contact): { href: string | null; label: string; icon: string } {
  const v = c.value.trim()
  switch (c.type) {
    case "email":
      return { href: `mailto:${v}`, label: c.label || v, icon: "mail" }
    case "qq":
      // 腾讯未提供个人主页跳转，走第三方名片页
      return {
        href: `https://res.abeim.cn/api/qq/?qq=${encodeURIComponent(v)}`,
        label: c.label || `QQ ${v}`,
        icon: "qq",
      }
    case "wechat":
      // 微信无跳转链接，值通常是二维码图片 URL 或微信号（作为文本展示）
      return {
        href: /^https?:\/\//i.test(v) ? v : null,
        label: c.label || `微信 ${v}`,
        icon: "wechat",
      }
    case "bilibili":
      return {
        href: `https://space.bilibili.com/${encodeURIComponent(v)}`,
        label: c.label || `Bilibili ${v}`,
        icon: "bilibili",
      }
    case "discord":
      // 支持两种填法：完整邀请链接，或仅邀请码
      return {
        href: /^https?:\/\//i.test(v)
          ? v
          : `https://discord.gg/${encodeURIComponent(v)}`,
        label: c.label || "Discord",
        icon: "discord",
      }
    case "telegram": {
      const handle = v.replace(/^@/, "")
      return {
        href: `https://t.me/${encodeURIComponent(handle)}`,
        label: c.label || `@${handle}`,
        icon: "telegram",
      }
    }
    case "youtube":
      return {
        href: /^https?:\/\//i.test(v)
          ? v
          : v.startsWith("@")
            ? `https://youtube.com/${encodeURIComponent(v)}`
            : `https://youtube.com/@${encodeURIComponent(v)}`,
        label: c.label || `YouTube ${v}`,
        icon: "youtube",
      }
    case "github":
      return {
        href: /^https?:\/\//i.test(v)
          ? v
          : `https://github.com/${encodeURIComponent(v)}`,
        label: c.label || `GitHub ${v}`,
        icon: "github",
      }
    case "x": {
      const handle = v.replace(/^@/, "")
      return {
        href: `https://x.com/${encodeURIComponent(handle)}`,
        label: c.label || `@${handle}`,
        icon: "x",
      }
    }
    case "custom":
    default:
      // 自定义链接：只允许 http(s)，挡掉 javascript: / data: 等
      return {
        href: /^https?:\/\//i.test(v) ? v : null,
        label: c.label || v,
        icon: "link",
      }
  }
}

/** HTML 转义——所有用户可控内容都必须过这里 */
function esc(s: string | null | undefined): string {
  if (s == null) return ""
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** 只允许安全的 URL 进入 src/href（再次兜底，防 javascript:） */
function safeUrl(u: string | null): string | null {
  if (!u) return null
  const t = u.trim()
  if (/^https?:\/\//i.test(t) || t.startsWith("/")) return t
  return null
}

/** hex 色 (#6366f1) → "99,102,241"，用于 rgba(var(--accent-rgb),.x) */
function hexToRgb(hex: string): string {
  const h = hex.replace(/^#/, "")
  if (h.length === 3) {
    return [h[0], h[1], h[2]]
      .map((c) => parseInt(c + c, 16))
      .join(",")
  }
  if (h.length === 6 || h.length === 8) {
    return [0, 1, 2]
      .map((i) => parseInt(h.slice(i * 2, i * 2 + 2), 16))
      .join(",")
  }
  return "99,102,241"
}

const ICONS: Record<string, string> = {
  mail: `<path d="M4 4h16v16H4z" fill="none"/><path d="M22 6l-10 7L2 6"/><rect x="2" y="4" width="20" height="16" rx="2"/>`,
  qq: `<circle cx="12" cy="12" r="9"/><path d="M8.5 15c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/>`,
  wechat: `<path d="M9 4C5 4 2 6.7 2 10c0 1.9 1 3.6 2.5 4.7L4 17l2.6-1.4c.8.2 1.6.3 2.4.3"/><path d="M22 13.5c0-2.8-2.7-5-6-5s-6 2.2-6 5 2.7 5 6 5c.7 0 1.4-.1 2-.3L20 19l-.4-1.6c1.5-.9 2.4-2.3 2.4-3.9z"/>`,
  bilibili: `<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M7 3l3 4M17 3l-3 4"/><path d="M9 12v3M15 12v3"/>`,
  discord: `<path d="M8 5.5C6 6 4.5 7 4 8.5 2.9 11 2.5 13.5 3 16c1.2 1.3 3 2 4.5 2l1-1.5c-1-.3-2-.8-2.7-1.4"/><path d="M16 5.5c2 .5 3.5 1.5 4 3 1.1 2.5 1.5 5 1 7.5-1.2 1.3-3 2-4.5 2l-1-1.5c1-.3 2-.8 2.7-1.4"/><circle cx="9.5" cy="12" r="1.2"/><circle cx="14.5" cy="12" r="1.2"/>`,
  telegram: `<path d="M21 4L3 11l5 2 2 6 3-4 5 4 3-15z"/><path d="M8 13l8-6-4 6"/>`,
  youtube: `<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3z"/>`,
  github: `<path d="M9 19c-4 1.5-4-2.5-6-3m12 5v-3.9a3.4 3.4 0 00-.9-2.6c3-.3 6-1.5 6-6.6a5 5 0 00-1.4-3.5 4.6 4.6 0 00-.1-3.5s-1.1-.3-3.7 1.4a12.6 12.6 0 00-6.6 0C5.7.6 4.6.9 4.6.9a4.6 4.6 0 00-.1 3.5A5 5 0 003 7.9c0 5 3 6.3 6 6.6a3.4 3.4 0 00-.9 2.6V21"/>`,
  x: `<path d="M4 3l7 9-7 9h2l6-7.7L18 21h3l-7.4-9.5L20.5 3h-2l-5.6 7.2L8 3z"/>`,
  link: `<path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/>`,
}

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ICONS.link}</svg>`
}

/**
 * 全部主题共享的 base CSS：布局、排版、组件骨架，全部用 CSS 变量驱动。
 * 主题只设 body.theme-xxx 下的变量，互不污染。
 */
const BASE_CSS = `
:root{
  --accent:#6366f1;
  --accent-rgb:99,102,241;
  --radius:16px;
  --bg:#000;
  --bg-overlay:rgba(0,0,0,.5);
  --text:#e5e5e5;
  --card-bg:transparent;
  --card-border:none;
  --card-radius:0;
  --card-padding:0;
  --card-shadow:none;
  --card-backdrop:none;
  --link-bg:rgba(255,255,255,.04);
  --link-border:1px solid rgba(255,255,255,.08);
  --link-radius:16px;
  --link-hover-bg:rgba(255,255,255,.08);
  --link-hover-border:1px solid rgba(255,255,255,.15);
  --link-hover-shadow:none;
  --avatar-size:96px;
  --avatar-radius:50%;
  --avatar-border:3px solid rgba(255,255,255,.15);
  --avatar-shadow:none;
  --player-bg:rgba(255,255,255,.04);
  --player-border:1px solid rgba(255,255,255,.08);
  --player-radius:999px;
  --player-btn-bg:var(--accent);
  --player-btn-color:#fff;
  --name-size:22px;
  --name-weight:650;
  --name-shadow:none;
  --font-display:inherit;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
  display:flex;align-items:center;justify-content:center;
  min-height:100vh;min-height:100dvh;padding:24px;
  overflow-x:hidden;
  background:var(--bg);color:var(--text);
}
a{color:inherit;text-decoration:none}
.wrap{
  width:100%;max-width:420px;position:relative;z-index:1;
  background:var(--card-bg);border:var(--card-border);
  border-radius:var(--card-radius);padding:var(--card-padding);
  box-shadow:var(--card-shadow);
  -webkit-backdrop-filter:var(--card-backdrop);
  backdrop-filter:var(--card-backdrop);
}
.avatar{width:var(--avatar-size);height:var(--avatar-size);border-radius:var(--avatar-radius);object-fit:cover;display:block;margin:0 auto;border:var(--avatar-border);box-shadow:var(--avatar-shadow)}
.avatar-fallback{width:var(--avatar-size);height:var(--avatar-size);border-radius:var(--avatar-radius);display:flex;align-items:center;justify-content:center;margin:0 auto;font-size:36px;font-weight:600;background:var(--accent);color:#fff;border:var(--avatar-border);box-shadow:var(--avatar-shadow)}
.name{font-size:var(--name-size);font-weight:var(--name-weight);text-align:center;margin-top:16px;letter-spacing:-.01em;font-family:var(--font-display);text-shadow:var(--name-shadow)}
.bio{text-align:center;margin-top:8px;font-size:14px;line-height:1.6;opacity:.75;white-space:pre-wrap;word-break:break-word;font-family:var(--font-display)}
.links{margin-top:28px;display:flex;flex-direction:column;gap:10px}
.link{display:flex;align-items:center;gap:12px;padding:13px 16px;border-radius:var(--link-radius);font-size:14px;background:var(--link-bg);border:var(--link-border);
  transition:transform .16s ease,background .16s ease,border .16s ease,box-shadow .16s ease;will-change:transform;font-family:var(--font-display)}
.link:hover{transform:translateY(-2px);background:var(--link-hover-bg);border:var(--link-hover-border);box-shadow:var(--link-hover-shadow)}
.link svg{width:18px;height:18px;flex-shrink:0}
.link .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.footer{margin-top:32px;text-align:center;font-size:11px;opacity:.4}
.bg{position:fixed;inset:0;z-index:0;background-size:cover;background-position:center}
.bg::after{content:"";position:absolute;inset:0;background:var(--bg-overlay)}
.player{display:flex;align-items:center;gap:12px;margin-top:22px;padding:10px 14px;border-radius:var(--player-radius);font-size:12px;background:var(--player-bg);border:var(--player-border)}
.player button{width:34px;height:34px;border-radius:50%;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:var(--player-btn-bg);color:var(--player-btn-color)}
.player button svg{width:14px;height:14px}
.player .title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}
.player .cover{width:42px;height:42px;border-radius:8px;flex-shrink:0;overflow:hidden;background:rgba(128,128,128,.15);display:flex;align-items:center;justify-content:center}
.player .cover img{width:100%;height:100%;object-fit:cover;display:block}
.player .cover .cover-fallback{width:18px;height:18px;opacity:.5}
.player .info{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.player .info .title{font-size:13px;font-weight:550;opacity:.95}
.player .progress{display:flex;align-items:center;gap:8px}
.player .track{flex:1;height:4px;border-radius:2px;background:rgba(128,128,128,.25);overflow:hidden;cursor:pointer}
.player .track .fill{height:100%;width:0;border-radius:2px;background:var(--accent);transition:width .1s linear}
.player .time{font-size:10px;opacity:.55;font-variant-numeric:tabular-nums;flex-shrink:0}
`

/** 6 个主题：只设 body.theme-xxx 下的 CSS 变量。accent 由 renderProfileHtml 注入 :root。 */
const THEME_CSS: Record<string, string> = {
  void: `
body.theme-void{
  --bg:#000;--bg-overlay:rgba(0,0,0,.65);--text:#e5e5e5;
  --card-bg:transparent;--card-border:none;--card-radius:0;--card-padding:0;--card-shadow:none;
  --link-bg:rgba(255,255,255,.03);--link-border:1px solid rgba(255,255,255,.06);
  --link-hover-bg:rgba(255,255,255,.06);--link-hover-border:1px solid rgba(255,255,255,.12);
  --avatar-border:3px solid rgba(var(--accent-rgb),.3);--avatar-shadow:0 0 20px rgba(var(--accent-rgb),.3);
  --name-shadow:0 0 30px rgba(var(--accent-rgb),.3);
}`,
  neon: `
body.theme-neon{
  --bg:#0a0a0f;--bg-overlay:rgba(0,0,0,.55);--text:#f5f5f7;
  --card-bg:rgba(10,10,15,.6);--card-border:1px solid rgba(var(--accent-rgb),.3);
  --card-radius:20px;--card-padding:36px 26px;--card-shadow:0 0 40px rgba(var(--accent-rgb),.15);
  --link-bg:transparent;--link-border:1px solid rgba(var(--accent-rgb),.4);--link-radius:12px;
  --link-hover-bg:rgba(var(--accent-rgb),.08);--link-hover-border:1px solid var(--accent);
  --link-hover-shadow:0 0 20px rgba(var(--accent-rgb),.2);
  --avatar-border:2px solid var(--accent);--avatar-shadow:0 0 15px rgba(var(--accent-rgb),.5);
  --player-border:1px solid rgba(var(--accent-rgb),.3);
}`,
  glass: `
body.theme-glass{
  --bg:#0f172a;--bg-overlay:rgba(15,23,42,.5);--text:#f8fafc;
  --card-bg:rgba(255,255,255,.08);--card-border:1px solid rgba(255,255,255,.14);
  --card-radius:28px;--card-padding:36px 26px;--card-shadow:0 20px 60px rgba(0,0,0,.4);
  --card-backdrop:blur(20px);
  --link-bg:rgba(255,255,255,.1);--link-border:1px solid rgba(255,255,255,.16);
  --link-hover-bg:rgba(255,255,255,.15);
  --avatar-border:3px solid rgba(255,255,255,.5);
  --player-bg:rgba(255,255,255,.1);--player-border:1px solid rgba(255,255,255,.16);
}`,
  aurora: `
body.theme-aurora{
  --bg:#0a0a14;--bg-overlay:rgba(0,0,0,.5);--text:#fff;
  --card-bg:rgba(10,10,20,.7);--card-border:1px solid rgba(255,255,255,.1);
  --card-radius:24px;--card-padding:36px 26px;--card-shadow:0 20px 60px rgba(0,0,0,.5);
  --card-backdrop:blur(10px);
  --link-bg:rgba(255,255,255,.12);--link-border:1px solid rgba(255,255,255,.1);
  --link-hover-bg:rgba(255,255,255,.2);
  --avatar-border:3px solid rgba(255,255,255,.6);--avatar-shadow:0 8px 24px rgba(0,0,0,.3);
}
body.theme-aurora::before{
  content:"";position:fixed;inset:-50%;z-index:0;
  background:conic-gradient(from 0deg,#6366f1,#ec4899,#f59e0b,#10b981,#6366f1);
  background-size:200% 200%;animation:aurora-shift 20s linear infinite;
  filter:blur(60px);opacity:.4;
}
@keyframes aurora-shift{to{transform:rotate(360deg)}}`,
  cyber: `
body.theme-cyber{
  --bg:#080812;--bg-overlay:rgba(8,8,18,.7);--text:#c7f9cc;
  --card-bg:rgba(8,8,18,.8);--card-border:1px solid rgba(var(--accent-rgb),.25);
  --card-radius:0;--card-padding:32px 24px;--card-shadow:0 0 30px rgba(var(--accent-rgb),.1);
  --link-bg:rgba(255,255,255,.03);--link-border:1px solid rgba(var(--accent-rgb),.2);--link-radius:4px;
  --link-hover-bg:rgba(var(--accent-rgb),.08);--link-hover-border:1px solid var(--accent);
  --avatar-radius:12px;--avatar-border:2px solid rgba(var(--accent-rgb),.4);
  --player-bg:rgba(255,255,255,.03);--player-border:1px solid rgba(var(--accent-rgb),.2);
  --name-size:20px;
}
body.theme-cyber .wrap{clip-path:polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px)}
body.theme-cyber .name::before{content:"> ";opacity:.6}
body.theme-cyber{background-image:
  repeating-linear-gradient(0deg,transparent,transparent 40px,rgba(var(--accent-rgb),.04) 40px,rgba(var(--accent-rgb),.04) 41px),
  repeating-linear-gradient(90deg,transparent,transparent 40px,rgba(var(--accent-rgb),.04) 40px,rgba(var(--accent-rgb),.04) 41px);}`,
  blossom: `
body.theme-blossom{
  --bg:#fdf2f8;--bg-overlay:rgba(253,242,248,.7);--text:#831843;
  --card-bg:#fff;--card-border:1px solid #fce7f3;--card-radius:24px;--card-padding:36px 26px;
  --card-shadow:0 4px 30px rgba(244,114,182,.12);
  --link-bg:#fff;--link-border:1px solid #fce7f3;--link-radius:12px;
  --link-hover-bg:#fff;--link-hover-border:1px solid #f9a8d4;--link-hover-shadow:0 4px 12px rgba(244,114,182,.15);
  --avatar-border:3px solid #fff;--avatar-shadow:0 4px 15px rgba(244,114,182,.2);
  --player-bg:#fff;--player-border:1px solid #fce7f3;
}`,
}

function themeCss(theme: string, accent: string | null): string {
  const a = accent && /^#[0-9a-f]{3,8}$/i.test(accent) ? accent : null
  return BASE_CSS.replace("--accent:#6366f1;--accent-rgb:99,102,241;", `--accent:${a ?? "#6366f1"};--accent-rgb:${hexToRgb(a ?? "#6366f1")};`) + (THEME_CSS[theme] ?? THEME_CSS.void)
}

/**
 * 4 种排版预设。只改 .wrap 的布局方式（flex 方向/对齐/背景层），
 * 与主题/动效/字体/开屏独立混搭。
 *   center = 居中卡片（纵向居中，头像在上）—— BASE_CSS 默认即此
 *   side   = 侧栏型（头像在左，信息在右，移动端回退纵向）
 *   split  = 分屏型（背景大图全屏，信息偏左下浮层）
 *   plain  = 极简列（无容器，左对齐纯文字）
 */
const LAYOUT_CSS: Record<string, string> = {
  // center：BASE_CSS 默认即为纵向居中，头像在 .avatar-wrap 里居中，main-col 居中文字
  side: `
body.layout-side .wrap{display:flex;flex-direction:row;align-items:center;gap:28px;text-align:left}
body.layout-side .avatar-wrap{flex-shrink:0}
body.layout-side .avatar,body.layout-side .avatar-fallback{margin:0}
body.layout-side .main-col{flex:1;min-width:0}
body.layout-side .name,body.layout-side .bio{text-align:left}
body.layout-side .links{margin-top:18px}
body.layout-side .player{margin-top:18px}
@media(max-width:560px){
  body.layout-side .wrap{flex-direction:column;text-align:center;gap:16px}
  body.layout-side .avatar,body.layout-side .avatar-fallback{margin:0 auto}
  body.layout-side .name,body.layout-side .bio{text-align:center}
}`,
  split: `
body.layout-split .bg{position:fixed;inset:0}
body.layout-split .wrap{max-width:480px;padding:36px 30px;background:rgba(0,0,0,.55);backdrop-filter:blur(16px);border-radius:20px;border:1px solid rgba(255,255,255,.1);text-align:center}
body.layout-split .avatar,body.layout-split .avatar-fallback{margin:0 auto}
body.layout-split .name,body.layout-split .bio{text-align:center}
body.layout-split .links{margin-top:22px}
@media(max-width:560px){body.layout-split .wrap{max-width:100%}}`,
  plain: `
body.layout-plain{align-items:flex-start;padding:48px 24px}
body.layout-plain .wrap{max-width:520px;background:transparent;border:0;border-radius:0;padding:0;box-shadow:none;backdrop-filter:none;text-align:left}
body.layout-plain .avatar-wrap{margin-bottom:18px}
body.layout-plain .avatar,body.layout-plain .avatar-fallback{margin:0;width:64px;height:64px}
body.layout-plain .name,body.layout-plain .bio{text-align:left}
body.layout-plain .name{font-size:26px}
body.layout-plain .links{margin-top:24px}
body.layout-plain .link{border:0;border-bottom:1px solid rgba(128,128,128,.15);border-radius:0;padding:10px 2px}
body.layout-plain .link:hover{transform:none;background:transparent;border-bottom-color:var(--accent)}
body.layout-plain .player{margin-top:24px}
@media(max-width:560px){body.layout-plain{padding:32px 20px}}`,
}

function layoutCss(layout: string): string {
  return LAYOUT_CSS[layout] ?? ""
}

/** 字体：自托管 woff2，仅英文/拉丁字符集，中文自动回退系统字体栈。 */
const FONT_FILES: Record<string, string> = {
  space: "space.woff2",
  orbitron: "orbitron.woff2",
  jetbrains: "jetbrains.woff2",
  audiowide: "audiowide.woff2",
  playfair: "playfair.woff2",
  cinzel: "cinzel.woff2",
  poppins: "poppins.woff2",
  bebas: "bebas.woff2",
}

function fontFaceCss(font: string, origin: string): string {
  if (font === "system" || !FONT_FILES[font]) return ""
  const file = FONT_FILES[font]
  const stack = `-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif`
  return `
@font-face{font-family:'DisplayFont';src:url('${esc(origin)}/fonts/${esc(file)}') format('woff2');font-display:swap;unicode-range:U+0020-007F,U+00A0-00FF,U+2000-206F}
:root{--font-display:'DisplayFont',${stack}}
`
}

/** particles 与 rain 互斥：共用 canvas 层，保留 particles（先出现优先）。 */
function resolveEffectConflicts(effects: string[]): string[] {
  if (effects.includes("particles") && effects.includes("rain")) {
    return effects.filter((e) => e !== "rain")
  }
  return effects
}

/** 动效 CSS：纯 CSS 类动效（glitch/glow/sparkle/tilt 的样式）+ canvas 容器。 */
function effectsCss(effects: string[]): string {
  let css = ""
  if (effects.includes("particles") || effects.includes("rain")) {
    css += `.fx-canvas{position:fixed;inset:0;z-index:0;pointer-events:none}`
  }
  if (effects.includes("tilt")) {
    css += `.wrap{transition:transform .15s ease-out;will-change:transform;transform-style:preserve-3d}`
  }
  if (effects.includes("glitch")) {
    css += `
@keyframes fx-glitch{
  0%,92%,100%{clip-path:inset(0 0 0 0);transform:translate(0);text-shadow:none}
  93%{clip-path:inset(20% 0 60% 0);transform:translate(-2px,0);text-shadow:2px 0 #ff00ff,-2px 0 #00ffff}
  96%{clip-path:inset(60% 0 10% 0);transform:translate(2px,0);text-shadow:-2px 0 #ff00ff,2px 0 #00ffff}
  98%{clip-path:inset(40% 0 40% 0);transform:translate(-1px,0);text-shadow:1px 0 #ff00ff,-1px 0 #00ffff}
}
.name.fx,.bio.fx{animation:fx-glitch 4s infinite steps(1)}`
  }
  if (effects.includes("glow")) {
    css += `
@keyframes fx-glow{
  0%,100%{box-shadow:0 0 5px rgba(var(--accent-rgb),.15)}
  50%{box-shadow:0 0 20px rgba(var(--accent-rgb),.4)}
}
.link.fx,.player.fx{animation:fx-glow 2.5s ease-in-out infinite}`
  }
  if (effects.includes("sparkle")) {
    css += `
.fx-sparkle{position:fixed;inset:0;z-index:0;pointer-events:none}
@keyframes fx-twinkle{0%,100%{opacity:0}50%{opacity:1}}
.fx-sparkle span{position:absolute;width:2px;height:2px;border-radius:50%;background:#fff;animation:fx-twinkle 3s infinite}`
  }
  return css
}

/** 动效需要插入 body 的 DOM（canvas / sparkle 层）。 */
function effectsHtml(effects: string[]): string {
  let html = ""
  if (effects.includes("particles") || effects.includes("rain")) {
    html += `<canvas class="fx-canvas" id="fx-canvas"></canvas>`
  }
  if (effects.includes("sparkle")) {
    // 30 个随机位置 span（服务端用确定性变量生成，不用 Math.random）
    let spans = ""
    for (let i = 0; i < 30; i++) {
      const left = ((i * 37) % 100)
      const top = ((i * 73) % 100)
      const delay = ((i * 0.13) % 3).toFixed(2)
      spans += `<span style="left:${left}%;top:${top}%;animation-delay:${delay}s"></span>`
    }
    html += `<div class="fx-sparkle">${spans}</div>`
  }
  return html
}

/** 动效 JS：每个独立 IIFE，统一检查 prefers-reduced-motion 与移动端降级。 */
function effectsJs(effects: string[]): string {
  let js = ""
  if (effects.includes("particles")) {
    js += `(function(){
      if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      var c=document.getElementById('fx-canvas');if(!c)return;
      var ctx=c.getContext('2d'),w,h,ps=[];
      function resize(){w=c.width=innerWidth;h=c.height=innerHeight}
      resize();addEventListener('resize',resize);
      var n=innerWidth<768?25:50;
      for(var i=0;i<n;i++)ps.push({x:Math.random()*w,y:Math.random()*h,vx:(Math.random()-.5)*.4,vy:(Math.random()-.5)*.4});
      var accent=getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()||'99,102,241';
      function loop(){
        ctx.clearRect(0,0,w,h);
        for(var i=0;i<ps.length;i++){
          var p=ps[i];p.x+=p.vx;p.y+=p.vy;
          if(p.x<0||p.x>w)p.vx*=-1;if(p.y<0||p.y>h)p.vy*=-1;
          ctx.beginPath();ctx.arc(p.x,p.y,1.5,0,6.28);ctx.fillStyle='rgba('+accent+',.6)';ctx.fill();
          for(var j=i+1;j<ps.length;j++){
            var q=ps[j],dx=p.x-q.x,dy=p.y-q.y,d=Math.sqrt(dx*dx+dy*dy);
            if(d<120){ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);
              ctx.strokeStyle='rgba('+accent+','+(.15*(1-d/120))+')';ctx.lineWidth=1;ctx.stroke()}
          }
        }
        requestAnimationFrame(loop)
      }
      loop();
    })();`
  }
  if (effects.includes("rain")) {
    js += `(function(){
      if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      var c=document.getElementById('fx-canvas');if(!c)return;
      var ctx=c.getContext('2d'),w,h,cols,drops,chars='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%';
      function resize(){
        w=c.width=innerWidth;h=c.height=innerHeight;
        cols=Math.floor(w/(innerWidth<768?14:16));
        drops=new Array(cols).fill(1);
      }
      resize();addEventListener('resize',resize);
      var accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#4ade80';
      function loop(){
        ctx.fillStyle='rgba(0,0,0,.08)';ctx.fillRect(0,0,w,h);
        ctx.fillStyle=accent;ctx.font=(innerWidth<768?12:14)+'px monospace';
        for(var i=0;i<drops.length;i++){
          var t=chars[Math.floor(Math.random()*chars.length)];
          ctx.fillText(t,i*16,drops[i]*16);
          if(drops[i]*16>h&&Math.random()>.975)drops[i]=0;
          drops[i]++;
        }
        requestAnimationFrame(loop)
      }
      loop();
    })();`
  }
  if (effects.includes("tilt")) {
    js += `(function(){
      if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      if(matchMedia('(pointer: coarse)').matches)return;
      var wrap=document.querySelector('.wrap');if(!wrap)return;
      var r=wrap.getBoundingClientRect();
      addEventListener('resize',function(){r=wrap.getBoundingClientRect()},{passive:true});
      addEventListener('mousemove',function(e){
        var cx=r.left+r.width/2,cy=r.top+r.height/2;
        var rx=((e.clientY-cy)/r.height)*-8,ry=((e.clientX-cx)/r.width)*8;
        wrap.style.transform='perspective(800px) rotateX('+rx+'deg) rotateY('+ry+'deg)';
      },{passive:true});
      addEventListener('mouseout',function(){wrap.style.transform=''},{passive:true});
    })();`
  }
  // glitch/glow/sparkle 是纯 CSS，给目标元素加 fx class 触发
  if (effects.includes("glitch") || effects.includes("glow")) {
    js += `(function(){
      var glow=${JSON.stringify(effects.includes("glow"))},glitch=${JSON.stringify(effects.includes("glitch"))};
      if(glow){document.querySelectorAll('.link,.player').forEach(function(el){el.classList.add('fx')});}
      if(glitch){document.querySelectorAll('.name,.bio').forEach(function(el){el.classList.add('fx')});}
    })();`
  }
  return js
}

/** 开屏动画 CSS。交互式用遮罩层，非交互式用 .wrap 的 CSS animation。 */
function introCss(intro: string): string {
  if (intro === "none") return ""
  let css = `.intro-overlay{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px;cursor:pointer}`
  css += `.intro-overlay.gone{opacity:0;pointer-events:none;transition:opacity .6s ease}`
  css += `.wrap{opacity:0}`
  css += `.wrap.visible{opacity:1;transition:opacity .8s ease}`
  if (intro === "enter") {
    css += `.intro-overlay{background:#000}`
    css += `.intro-overlay .intro-text{font-size:13px;letter-spacing:.3em;text-transform:uppercase;color:rgba(255,255,255,.6);animation:fx-pulse 2s ease-in-out infinite}`
    css += `@keyframes fx-pulse{0%,100%{opacity:.35}50%{opacity:1}}`
  } else if (intro === "portal") {
    css += `.intro-overlay{background:#000}`
    css += `.intro-portal{width:120px;height:120px;border-radius:50%;background:conic-gradient(from 0deg,var(--accent),transparent,var(--accent));animation:portal-spin 2s linear infinite;box-shadow:0 0 40px rgba(var(--accent-rgb),.4)}`
    css += `@keyframes portal-spin{to{transform:rotate(360deg)}}`
    css += `.intro-overlay.gone .intro-portal{animation-duration:.3s}`
    css += `.intro-overlay .intro-text{color:rgba(255,255,255,.6);font-size:12px;letter-spacing:.2em;text-transform:uppercase}`
  } else if (intro === "fade") {
    css += `@keyframes intro-fade{to{opacity:1}}`
    css += `.wrap{animation:intro-fade 1.5s ease forwards}`
  } else if (intro === "slide") {
    css += `@keyframes intro-slide{to{opacity:1;transform:translateY(0)}}`
    css += `.wrap{transform:translateY(40px);animation:intro-slide .8s ease forwards}`
  }
  return css
}

/** 交互式 intro 的遮罩 DOM。非交互式不需要 DOM（纯 CSS animation）。 */
function introHtml(intro: string): string {
  if (intro === "enter") {
    return `<div class="intro-overlay" id="intro"><span class="intro-text">Click to Enter</span></div>`
  }
  if (intro === "portal") {
    return `<div class="intro-overlay" id="intro"><div class="intro-portal"></div><span class="intro-text">Click to Enter</span></div>`
  }
  return ""
}

/** 交互式 intro 的 click handler。 */
function introJs(intro: string): string {
  if (intro !== "enter" && intro !== "portal") return ""
  return `(function(){
    var ov=document.getElementById('intro'),wrap=document.querySelector('.wrap');
    if(!ov||!wrap)return;
    ov.addEventListener('click',function(){
      ov.classList.add('gone');
      setTimeout(function(){wrap.classList.add('visible')},250);
      setTimeout(function(){ov.style.display='none'},700);
    });
  })();`
}

/** 背景音乐播放器 JS：播放/暂停 + 进度条 + 时间显示 + 点击跳转。 */
function musicPlayerJs(): string {
  return `(function(){
    var audio=document.getElementById('bgm'),btn=document.getElementById('pp');
    if(!audio||!btn)return;
    var fill=document.getElementById('pfill'),track=document.getElementById('ptrack'),time=document.getElementById('ptime');
    var playing=false;
    function fmt(s){if(!isFinite(s)||s<0)s=0;var m=Math.floor(s/60),sec=Math.floor(s%60);return m+':'+(sec<10?'0':'')+sec}
    function sync(){btn.innerHTML=playing
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'}
    btn.addEventListener('click',function(){
      if(playing){audio.pause();playing=false}else{audio.play().then(function(){playing=true;sync()}).catch(function(){})}
      sync();
    });
    audio.addEventListener('pause',function(){playing=false;sync()});
    audio.addEventListener('play',function(){playing=true;sync()});
    // 进度条 + 时间：timeupdate 在播放时高频触发，loadedmetadata 提供总时长
    function update(){
      if(!fill)return;
      var cur=audio.currentTime||0,dur=audio.duration||0;
      fill.style.width=(dur>0?(cur/dur*100):0)+'%';
      if(time)time.textContent=fmt(cur)+(dur>0?' / '+fmt(dur):'');
    }
    audio.addEventListener('timeupdate',update);
    audio.addEventListener('loadedmetadata',update);
    // 点击进度条跳转
    if(track){
      track.addEventListener('click',function(e){
        var dur=audio.duration||0;if(!dur)return;
        var r=track.getBoundingClientRect();
        audio.currentTime=((e.clientX-r.left)/r.width)*dur;
      });
    }
    sync();update();
  })();`
}

export function renderProfileHtml(p: PublicProfile): string {
  const avatar = safeUrl(p.avatar)
  const background = safeUrl(p.background)
  const music = safeUrl(p.music)
  const name = p.displayName || p.username
  const initial = name.slice(0, 1).toUpperCase()

  const fx = resolveEffectConflicts(p.effects)
  const intro = p.intro

  // 公开页资源走站内路径；自定义域名下也用相对路径 /p/<用户>/<kind>（同域，无跨域问题）
  const origin = "https://cloud.doulor.cn"

  const links = p.contacts
    .map((c) => {
      const { href, label, icon: iconName } = contactLink(c)
      const inner = `${icon(iconName)}<span class="t">${esc(label)}</span>`
      return href
        ? `<a class="link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
        : `<div class="link">${inner}</div>`
    })
    .join("")

  const musicCover = safeUrl(p.musicCover)
  const player = music
    ? `<div class="player">
        <div class="cover">${musicCover ? `<img src="${esc(musicCover)}" alt="${esc(p.musicTitle || "cover")}">` : `<svg class="cover-fallback" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/><path d="M9 18V5l12-2v13"/></svg>`}</div>
        <div class="info">
          <div class="title">${esc(p.musicTitle || "背景音乐")}</div>
          <div class="progress">
            <div class="track" id="ptrack"><div class="fill" id="pfill"></div></div>
            <span class="time" id="ptime">0:00</span>
          </div>
        </div>
        <button id="pp" aria-label="播放/暂停">${icon("youtube")}</button>
      </div>
      <audio id="bgm" src="${esc(music)}" loop ${p.musicAutoplay ? "autoplay" : ""} preload="metadata"></audio>`
    : ""

  // glass 主题用模糊背景层；其他主题用普通背景层
  const blurLayer =
    p.theme === "glass" && background
      ? `<div class="bg-blur" style="position:fixed;inset:0;z-index:0;background-image:url('${esc(background)}');background-size:cover;background-position:center;filter:blur(28px) saturate(1.4);transform:scale(1.15)"></div>`
      : ""
  const bgLayer =
    background && p.theme !== "glass"
      ? `<div class="bg" style="background-image:url('${esc(background)}')"></div>`
      : ""

  const fxLayer = effectsHtml(fx)
  const introLayer = introHtml(intro)

  // 交互式 intro：初始 .wrap 无 visible（JS 点击后加）；非交互式/none：CSS animation 或直接显示
  const wrapVisibleClass = intro === "enter" || intro === "portal" ? "" : " visible"

  const css =
    themeCss(p.theme, p.accent) +
    layoutCss(p.layout) +
    fontFaceCss(p.font, origin) +
    effectsCss(fx) +
    introCss(intro)

  const js = musicPlayerJs() + effectsJs(fx) + introJs(intro)

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(name)}</title>
<meta name="description" content="${esc(p.bio || `${name} 的个人名片`)}">
<meta property="og:title" content="${esc(name)}">
<meta property="og:description" content="${esc(p.bio || "")}">
${avatar ? `<meta property="og:image" content="${esc(avatar)}">` : ""}
${musicCover ? `<meta property="og:image" content="${esc(musicCover)}">` : ""}
<meta name="theme-color" content="${esc(p.accent || "#6366f1")}">
<style>${css}</style>
</head>
<body class="theme-${esc(p.theme)} layout-${esc(p.layout)}">
${blurLayer}${bgLayer}
${fxLayer}
${introLayer}
<div class="wrap${wrapVisibleClass}">
  <div class="avatar-wrap">${avatar ? `<img class="avatar" src="${esc(avatar)}" alt="${esc(name)}">` : `<div class="avatar-fallback">${esc(initial)}</div>`}</div>
  <div class="main-col">
    <h1 class="name">${esc(name)}</h1>
    ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ""}
    ${links ? `<nav class="links">${links}</nav>` : ""}
    ${player}
  </div>
</div>
<script>${js}</script>
</body>
</html>`
}

/** 名片不存在 / 未发布时的页面 */
export function renderNotFoundHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>名片不存在</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
background:#0a0a0a;color:#525252}
@media(prefers-color-scheme:dark){body{background:#000;color:#404040}}
div{text-align:center;padding:24px}
h1{font-size:17px;font-weight:600;margin:0 0 8px;color:#a3a3a3}
p{font-size:13px;margin:0}
</style></head>
<body><div><h1>404</h1><p>名片不存在或未公开</p></div></body></html>`
}
