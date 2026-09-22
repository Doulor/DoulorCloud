/**
 * 公开名片的 HTML 渲染。
 *
 * 为什么在 Worker 里拼 HTML 而不走 React SPA：
 *   1. 需求要求名片「全屏、不含 Doulor Cloud 外壳」——SPA 会带上站点布局；
 *   2. 自定义域名下地址栏要显示用户自己的域名，SPA 路由做不到干净的根路径；
 *   3. 独立 HTML 便于分享预览（微信/Twitter 抓取 og 标签）。
 *
 * 所有用户输入都必须转义（见 esc），否则名片字段会成为 XSS 入口。
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

/** 各主题的 CSS。用 CSS 变量减少重复，主题只改变量与个别布局。 */
function themeCss(theme: string, accent: string | null): string {
  const a = accent && /^#[0-9a-f]{3,8}$/i.test(accent) ? accent : null

  const base = `
:root{
  --accent:${a ?? "#6366f1"};
  --radius:16px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
  display:flex;align-items:center;justify-content:center;
  min-height:100vh;min-height:100dvh;padding:24px;
  overflow-x:hidden;
}
a{color:inherit;text-decoration:none}
.wrap{width:100%;max-width:420px;position:relative;z-index:1}
.avatar{width:96px;height:96px;border-radius:50%;object-fit:cover;display:block;margin:0 auto;border:3px solid rgba(255,255,255,.5)}
.avatar-fallback{width:96px;height:96px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto;font-size:36px;font-weight:600;background:var(--accent);color:#fff}
.name{font-size:22px;font-weight:650;text-align:center;margin-top:16px;letter-spacing:-.01em}
.bio{text-align:center;margin-top:8px;font-size:14px;line-height:1.6;opacity:.75;white-space:pre-wrap;word-break:break-word}
.links{margin-top:28px;display:flex;flex-direction:column;gap:10px}
.link{display:flex;align-items:center;gap:12px;padding:13px 16px;border-radius:var(--radius);font-size:14px;
  transition:transform .16s ease,opacity .16s ease;will-change:transform}
.link:hover{transform:translateY(-2px)}
.link svg{width:18px;height:18px;flex-shrink:0}
.link .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.footer{margin-top:32px;text-align:center;font-size:11px;opacity:.4}
.bg{position:fixed;inset:0;z-index:0;background-size:cover;background-position:center}
.bg::after{content:"";position:absolute;inset:0;background:var(--overlay,rgba(0,0,0,.35))}
.player{display:flex;align-items:center;gap:10px;margin-top:22px;padding:10px 14px;border-radius:999px;font-size:12px}
.player button{width:30px;height:30px;border-radius:50%;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.player button svg{width:14px;height:14px}
.player .title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}
`

  const themes: Record<string, string> = {
    minimal: `body{background:#fafafa;color:#18181b}
.dark body{background:#09090b;color:#fafafa}
.link{background:#fff;border:1px solid #e4e4e7}
.dark .link{background:#18181b;border-color:#27272a}
.player{background:#fff;border:1px solid #e4e4e7}
.dark .player{background:#18181b;border-color:#27272a}
.player button{background:var(--accent);color:#fff}`,

    gradient: `body{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff}
.link{background:rgba(255,255,255,.16);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.22)}
.player{background:rgba(255,255,255,.16);backdrop-filter:blur(10px)}
.player button{background:#fff;color:#764ba2}
.avatar{border-color:rgba(255,255,255,.6)}`,

    glass: `body{background:#0f172a;color:#f8fafc}
.bg-blur{position:fixed;inset:0;z-index:0;background-size:cover;background-position:center;filter:blur(28px) saturate(1.4);transform:scale(1.15)}
.wrap{backdrop-filter:blur(20px);background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);
  border-radius:28px;padding:36px 26px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.link{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16)}
.player{background:rgba(255,255,255,.1)}
.player button{background:var(--accent);color:#fff}`,

    terminal: `body{background:#0c0c0c;color:#4ade80;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.name::before{content:"> ";opacity:.6}
.bio{color:#86efac}
.link{background:#111;border:1px solid #1f2937;border-radius:6px;font-size:13px}
.link:hover{border-color:#4ade80}
.link svg{color:#4ade80}
.player{background:#111;border:1px solid #1f2937;border-radius:6px}
.player button{background:#4ade80;color:#0c0c0c}
.avatar,.avatar-fallback{border-radius:8px}
.footer{color:#22c55e}`,

    card: `body{background:#f4f4f5;color:#18181b}
.dark body{background:#09090b;color:#fafafa}
.wrap{background:#fff;border-radius:24px;padding:36px 26px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.dark .wrap{background:#18181b}
.link{background:#fafafa;border:1px solid #e4e4e7}
.dark .link{background:#27272a;border-color:#3f3f46}
.player{background:#fafafa;border:1px solid #e4e4e7}
.dark .player{background:#27272a;border-color:#3f3f46}
.player button{background:var(--accent);color:#fff}`,

    dark: `body{background:#000;color:#e5e5e5}
body::before{content:"";position:fixed;inset:0;z-index:0;
  background:radial-gradient(600px circle at 50% 0%,color-mix(in srgb,var(--accent) 22%,transparent),transparent 70%)}
.link{background:#0a0a0a;border:1px solid #1f1f1f}
.link:hover{border-color:var(--accent)}
.player{background:#0a0a0a;border:1px solid #1f1f1f}
.player button{background:var(--accent);color:#fff}`,
  }

  return base + (themes[theme] ?? themes.minimal)
}

export function renderProfileHtml(p: PublicProfile): string {
  const avatar = safeUrl(p.avatar)
  const background = safeUrl(p.background)
  const music = safeUrl(p.music)
  const name = p.displayName || p.username
  const initial = name.slice(0, 1).toUpperCase()

  const links = p.contacts
    .map((c) => {
      const { href, label, icon: iconName } = contactLink(c)
      const inner = `${icon(iconName)}<span class="t">${esc(label)}</span>`
      // 无 href（如仅展示微信号）渲染成不可点击的条目，而不是死链接
      return href
        ? `<a class="link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
        : `<div class="link">${inner}</div>`
    })
    .join("")

  const player = music
    ? `<div class="player">
        <button id="pp" aria-label="播放/暂停">${icon("youtube")}</button>
        <span class="title">${esc(p.musicTitle || "背景音乐")}</span>
      </div>
      <audio id="bgm" src="${esc(music)}" loop ${p.musicAutoplay ? "autoplay" : ""} preload="none"></audio>`
    : ""

  const blurLayer =
    p.theme === "glass" && background
      ? `<div class="bg-blur" style="background-image:url('${esc(background)}')"></div>`
      : ""

  const bgLayer =
    background && p.theme !== "glass"
      ? `<div class="bg" style="background-image:url('${esc(background)}')"></div>`
      : ""

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
<meta name="theme-color" content="${esc(p.accent || "#6366f1")}">
<style>${themeCss(p.theme, p.accent)}</style>
</head>
<body class="${p.theme === "minimal" || p.theme === "card" ? "theme-" + p.theme : ""}">
${blurLayer}${bgLayer}
<div class="wrap">
  ${avatar ? `<img class="avatar" src="${esc(avatar)}" alt="${esc(name)}">` : `<div class="avatar-fallback">${esc(initial)}</div>`}
  <h1 class="name">${esc(name)}</h1>
  ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ""}
  ${links ? `<nav class="links">${links}</nav>` : ""}
  ${player}
</div>
<script>
(function(){
  var audio=document.getElementById('bgm'),btn=document.getElementById('pp');
  if(!audio||!btn)return;
  var playing=false;
  function sync(){btn.innerHTML=playing
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'}
  btn.addEventListener('click',function(){
    if(playing){audio.pause();playing=false}else{audio.play().then(function(){playing=true;sync()}).catch(function(){})}
    sync();
  });
  audio.addEventListener('pause',function(){playing=false;sync()});
  audio.addEventListener('play',function(){playing=true;sync()});
  sync();
})();
</script>
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
background:#fafafa;color:#71717a}
@media(prefers-color-scheme:dark){body{background:#09090b;color:#a1a1aa}}
div{text-align:center;padding:24px}
h1{font-size:17px;font-weight:600;margin:0 0 8px;color:#18181b}
@media(prefers-color-scheme:dark){h1{color:#fafafa}}
p{font-size:13px;margin:0}
</style></head>
<body><div><h1>名片不存在或未公开</h1><p>该用户可能尚未启用名片。</p></div></body></html>`
}