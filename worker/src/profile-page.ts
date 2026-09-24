/**
 * 公开名片的 HTML 渲染（2026-09-23 美学重构版）。
 *
 * 为什么在 Worker 里拼 HTML 而不走 React SPA：
 *   1. 名片要「全屏、不含 Doulor Cloud 外壳」；
 *   2. 自定义域名下地址栏要显示用户自己的域名；
 *   3. 独立 HTML 便于分享预览（微信/Twitter 抓取 og 标签）。
 *
 * 所有用户输入都必须转义（见 esc），否则名片字段会成为 XSS 入口。
 *
 * 设计系统（五个维度独立混搭，组合出截然不同的名片）：
 *   - theme   皮肤：11 套完整视觉语言，各自拥有配色/字体栈/按钮造型/装饰纹理
 *   - layout  结构：6 种页面骨架（center/side/split/plain/bento/banner）
 *   - modules 模块：页面由可开关、可排序的模块组装（身份/状态/标签/名言/
 *              联系方式/大事记/图片墙/音乐/统计）
 *   - font + cjkFont：英文标题字与中文正文字体栈，相互独立
 *   - effects / intro：动效与开屏，同前
 *
 * 皮肤不再只是「换色」：每个主题通过一整套 CSS 变量（surface / link / chip /
 * mod-title / name / pattern …）定义自己的材质语言，并附带独有装饰
 * （霓虹描边、终端扫描线、纸刊发丝线、水墨朱印、紫金描金框 …）。
 */
import type {
  PublicProfile,
  Contact,
  ProfileModule,
  TimelineItem,
  GalleryItem,
} from "./handlers/profile"

/**
 * 把联系方式拼成可点击链接。
 * 服务端拼接的好处：用户只需填原始值（QQ 号 / UID / 用户名），
 * 避免在前端各处重复实现拼接规则、也防止用户填出 javascript: 之类的危险协议。
 *
 * 显示文字统一为「平台名 + 值」（如 `QQ 123`、`Telegram @xx`、`邮箱 a@b.c`）；
 * 用户填了自定义 label 时以 label 优先；值是完整 URL 时只显示平台名，
 * 否则整条长链接会把按钮撑破。
 */
function contactLink(c: Contact): { href: string | null; label: string; icon: string } {
  const v = c.value.trim()
  const isUrl = /^https?:\/\//i.test(v)
  switch (c.type) {
    case "email":
      return { href: `mailto:${v}`, label: c.label || `邮箱 ${v}`, icon: "mail" }
    case "qq":
      return {
        href: `https://res.abeim.cn/api/qq/?qq=${encodeURIComponent(v)}`,
        label: c.label || `QQ ${v}`,
        icon: "qq",
      }
    case "wechat":
      return {
        href: isUrl ? v : null,
        label: c.label || (isUrl ? "微信" : `微信 ${v}`),
        icon: "wechat",
      }
    case "bilibili":
      return {
        href: `https://space.bilibili.com/${encodeURIComponent(v)}`,
        label: c.label || `Bilibili ${v}`,
        icon: "bilibili",
      }
    case "discord":
      return {
        href: isUrl ? v : `https://discord.gg/${encodeURIComponent(v)}`,
        label: c.label || (isUrl ? "Discord" : `Discord ${v}`),
        icon: "discord",
      }
    case "telegram": {
      const handle = v.replace(/^@/, "")
      return {
        href: `https://t.me/${encodeURIComponent(handle)}`,
        label: c.label || `Telegram @${handle}`,
        icon: "telegram",
      }
    }
    case "youtube":
      return {
        href: isUrl
          ? v
          : v.startsWith("@")
            ? `https://youtube.com/${encodeURIComponent(v)}`
            : `https://youtube.com/@${encodeURIComponent(v)}`,
        label: c.label || (isUrl ? "YouTube" : `YouTube ${v}`),
        icon: "youtube",
      }
    case "github":
      return {
        href: isUrl ? v : `https://github.com/${encodeURIComponent(v)}`,
        label: c.label || (isUrl ? "GitHub" : `GitHub ${v}`),
        icon: "github",
      }
    case "x": {
      const handle = v.replace(/^@/, "")
      return {
        href: `https://x.com/${encodeURIComponent(handle)}`,
        label: c.label || `X @${handle}`,
        icon: "x",
      }
    }
    case "custom":
    default:
      return {
        href: isUrl ? v : null,
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

/**
 * 转义后再把换行变成 <br>——用于名言等允许换行的多行文本。
 * 必须先 esc 再替换：这样用户输入的 < 已被转义，插入的 <br> 不会被二次转义。
 */
function escMultiline(s: string | null | undefined): string {
  return esc(s).replace(/\r\n|\r|\n/g, "<br>")
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

/** 各主题的默认 accent（用户未自定义时）。用户填了合法 hex 一律优先。 */
const THEME_DEFAULT_ACCENT: Record<string, string> = {
  void: "#6366f1",
  neon: "#22d3ee",
  glass: "#a78bfa",
  aurora: "#ec4899",
  cyber: "#4ade80",
  blossom: "#e868a8",
  paper: "#9d3b2e",
  ink: "#b3332b",
  terminal: "#33ff66",
  solar: "#dd6b20",
  royal: "#d4af6a",
}

const SANS_STACK = `-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif`
const SONG_STACK = `"Songti SC","STSong","Noto Serif SC","Source Han Serif SC","SimSun",serif`
const KAI_STACK = `"Kaiti SC","STKaiti","KaiTi","楷体",serif`
const MONO_STACK = `ui-monospace,"SF Mono","Cascadia Code","JetBrains Mono",Consolas,"Courier New",monospace`

/**
 * 全部皮肤共享的 base CSS：布局骨架、模块组件，全部由 CSS 变量驱动。
 * 主题只设 body.theme-xxx 下的变量（+ 少量独有装饰），互不污染。
 *
 * ⚠️ 变量嵌套求值陷阱（踩过一次，务必遵守）：
 *   `--a:var(--b)` 写在 :root 上时，var(--b) 会在 **:root 处**就被替换掉，
 *   主题在 body 上覆盖的 --b 影响不到 --a，浅色皮肤会直接用上默认的浅色文字，
 *   表现为「浅底浅字 / 整页近乎空白」。
 *   因此：**派生变量一律不在 :root 声明**，改在使用处写 `var(--x, var(--y))`，
 *   这样 var(--y) 在元素自身求值，能拿到主题作用域里的值。
 */
const BASE_CSS = `
:root{
  --accent:#6366f1;--accent-rgb:99,102,241;
  --bg:#000;
  --bg-overlay:rgba(0,0,0,.55);
  --bg-pattern:none;
  --bg-pattern-size:auto;
  --text:#e8e8e8;
  --text-dim:#9a9a9a;
  --font-body:${SANS_STACK};
  --mod-gap:26px;
  --mod-title-size:11.5px;
  --mod-title-ls:.16em;
  --mod-title-rule:transparent;
  --link-bg:rgba(255,255,255,.04);
  --link-border:1px solid rgba(255,255,255,.08);
  --link-radius:14px;
  --link-hover-bg:rgba(255,255,255,.08);
  --link-hover-border:1px solid rgba(255,255,255,.15);
  --link-hover-shadow:none;
  --link-hover-transform:translateY(-2px);
  --avatar-size:96px;
  --avatar-radius:50%;
  --avatar-border:3px solid rgba(255,255,255,.15);
  --avatar-shadow:none;
  --name-size:26px;
  --name-weight:600;
  --name-ls:-.01em;
  --name-shadow:none;
  --chip-bg:transparent;
  --chip-border:1px solid rgba(var(--accent-rgb),.3);
  --chip-radius:999px;
  --player-bg:rgba(255,255,255,.04);
  --player-border:1px solid rgba(255,255,255,.08);
  --player-radius:999px;
  --player-cover-radius:8px;
  --gallery-radius:10px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:var(--font-body);
  -webkit-font-smoothing:antialiased;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  min-height:100vh;min-height:100dvh;padding:28px 22px;
  overflow-x:hidden;
  background:var(--bg);color:var(--text);
}
body::before{
  content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background:var(--bg-pattern);background-size:var(--bg-pattern-size);
}
a{color:inherit;text-decoration:none}
.wrap{width:100%;max-width:460px;position:relative;z-index:1}

/* ---- 身份区 ---- */
.hero{display:flex;flex-direction:column;align-items:center;text-align:center}
.avatar{width:var(--avatar-size);height:var(--avatar-size);border-radius:var(--avatar-radius);object-fit:cover;display:block;border:var(--avatar-border);box-shadow:var(--avatar-shadow)}
.avatar-fallback{width:var(--avatar-size);height:var(--avatar-size);border-radius:var(--avatar-radius);display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:600;background:var(--accent);color:#fff;border:var(--avatar-border);box-shadow:var(--avatar-shadow)}
.name{margin-top:18px;font-family:var(--font-display,var(--font-body)),var(--font-body);font-size:var(--name-size);font-weight:var(--name-weight);letter-spacing:var(--name-ls);color:var(--name-color,var(--text));text-shadow:var(--name-shadow);word-break:break-word}
.bio{margin-top:10px;font-size:14.5px;line-height:1.7;color:var(--bio-color,var(--text-dim));white-space:pre-wrap;word-break:break-word;max-width:54ch}
.status-pill{display:inline-flex;align-items:center;gap:6px;margin-top:14px;padding:5px 14px;border-radius:999px;font-size:12.5px;line-height:1.4;
  background:rgba(var(--accent-rgb),.1);border:1px solid rgba(var(--accent-rgb),.28);color:var(--text)}
.status-pill .se{flex-shrink:0}
.seal{display:none}

/* ---- 模块 ---- */
.mods{margin-top:var(--mod-gap);display:flex;flex-direction:column;gap:var(--mod-gap)}
.mod{background:var(--mod-bg,transparent);border:var(--mod-border,none);border-radius:var(--mod-radius,18px);padding:var(--mod-padding,0);box-shadow:var(--mod-shadow,none);
  -webkit-backdrop-filter:var(--mod-blur,none);backdrop-filter:var(--mod-blur,none)}
.mod-title{font-size:var(--mod-title-size);font-weight:600;letter-spacing:var(--mod-title-ls);text-transform:uppercase;color:var(--mod-title-color,var(--text-dim));margin-bottom:14px;display:flex;align-items:center;gap:12px}
.mod-title::after{content:"";flex:1;height:1px;background:var(--mod-title-rule)}

/* 联系方式 */
.links{display:flex;flex-direction:column;gap:10px}
.link{display:flex;align-items:center;gap:12px;padding:13px 16px;border-radius:var(--link-radius);font-size:14px;
  background:var(--link-bg);border:var(--link-border);color:var(--link-color,inherit);
  transition:transform .16s ease,background .16s ease,border .16s ease,box-shadow .16s ease,color .16s ease;will-change:transform}
.link:hover{transform:var(--link-hover-transform);background:var(--link-hover-bg);border:var(--link-hover-border);color:var(--link-hover-color,inherit);box-shadow:var(--link-hover-shadow)}
.link svg{width:18px;height:18px;flex-shrink:0}
.link .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 标签 */
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{padding:6px 14px;border-radius:var(--chip-radius);font-size:13px;line-height:1.4;background:var(--chip-bg);border:var(--chip-border);color:var(--chip-color,var(--text))}

/* 名言 */
.quote{padding:2px 0 2px 18px;border-left:3px solid var(--accent)}
.quote p{font-size:16px;line-height:1.75;word-break:break-word}
.quote cite{display:block;margin-top:8px;font-size:12.5px;font-style:normal;color:var(--text-dim)}

/* 大事记 */
.timeline{list-style:none}
.timeline li{position:relative;padding:0 0 20px 24px}
.timeline li:last-child{padding-bottom:0}
.timeline li::before{content:"";position:absolute;left:0;top:6px;width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--bg)}
.timeline li::after{content:"";position:absolute;left:4px;top:19px;bottom:-1px;width:1px;background:rgba(var(--accent-rgb),.3)}
.timeline li:last-child::after{display:none}
.tl-date{font-size:11.5px;letter-spacing:.08em;color:var(--text-dim)}
.tl-title{font-size:14.5px;font-weight:550;margin-top:2px}
.tl-desc{font-size:13px;line-height:1.6;color:var(--text-dim);margin-top:3px;word-break:break-word}

/* 图片墙 */
.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.gallery figure{position:relative;aspect-ratio:1;overflow:hidden;border-radius:var(--gallery-radius);background:var(--mod-bg)}
.gallery img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .45s ease}
.gallery figure:hover img{transform:scale(1.06)}
.gallery figcaption{position:absolute;left:0;right:0;bottom:0;padding:16px 8px 7px;font-size:11px;line-height:1.3;color:#fff;
  background:linear-gradient(transparent,rgba(0,0,0,.6));opacity:0;transition:opacity .3s}
.gallery figure:hover figcaption{opacity:1}

/* 音乐播放器 */
.player{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:var(--player-radius);font-size:12px;background:var(--player-bg);border:var(--player-border)}
.player button{width:34px;height:34px;border-radius:50%;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:var(--player-btn-bg,var(--accent));color:var(--player-btn-color,#fff)}
.player button svg{width:14px;height:14px}
.player .cover{width:42px;height:42px;border-radius:var(--player-cover-radius);flex-shrink:0;overflow:hidden;background:rgba(128,128,128,.15);display:flex;align-items:center;justify-content:center}
.player .cover img{width:100%;height:100%;object-fit:cover;display:block}
.player .cover .cover-fallback{width:18px;height:18px;opacity:.5}
.player .info{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.player .info .title{font-size:13px;font-weight:550;opacity:.95;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.player .progress{display:flex;align-items:center;gap:8px}
.player .track{flex:1;height:4px;border-radius:2px;background:rgba(128,128,128,.25);overflow:hidden;cursor:pointer}
.player .track .fill{height:100%;width:0;border-radius:2px;background:var(--accent);transition:width .1s linear}
.player .time{font-size:10px;opacity:.55;font-variant-numeric:tabular-nums;flex-shrink:0}

/* 页脚统计 */
.stats{margin-top:34px;text-align:center;font-size:11px;color:var(--text-dim);opacity:.85;letter-spacing:.06em}

/* 背景图层 */
.bg{position:fixed;inset:0;z-index:0;background-size:cover;background-position:center}
.bg::after{content:"";position:absolute;inset:0;background:var(--bg-overlay)}
.bg-blur{position:fixed;inset:0;z-index:0;background-size:cover;background-position:center;filter:blur(28px) saturate(1.4);transform:scale(1.15)}

/* banner 布局的头图 */
.banner-img{position:relative;width:100%;height:230px;background-size:cover;background-position:center}
.banner-img::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 35%,var(--bg) 98%)}

@media(max-width:640px){
  .gallery{gap:6px}
}
`

/**
 * 11 套皮肤：每套都是一种完整的设计语言，而不只是换色。
 * 各自定义：配色温度、字体栈、材质（surface/mod）、按钮造型、装饰纹理、
 * 以及独有的小细节（霓虹辉光、终端扫描线、纸刊发丝线、水墨朱印、紫金描金框）。
 */
const THEME_CSS: Record<string, string> = {
  /* 虚空：纯黑留白，把所有注意力让给内容本身，accent 只做克制的点睛 */
  void: `
body.theme-void{
  --bg:#050505;--bg-overlay:rgba(0,0,0,.62);--text:#ececec;--text-dim:#8b8b8b;
  --bg-pattern:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(var(--accent-rgb),.09),transparent);
  --link-bg:transparent;--link-border:1px solid rgba(255,255,255,.09);
  --link-hover-bg:rgba(var(--accent-rgb),.06);--link-hover-border:1px solid rgba(var(--accent-rgb),.45);
  --link-hover-shadow:0 0 24px rgba(var(--accent-rgb),.18);
  --avatar-border:2px solid rgba(255,255,255,.14);--avatar-shadow:0 0 28px rgba(var(--accent-rgb),.28);
  --name-size:30px;--name-shadow:0 0 34px rgba(var(--accent-rgb),.35);
  --mod-title-rule:rgba(255,255,255,.07);
}`,
  /* 霓虹：合成波夜色，描边辉光，名字带粉青渐变 */
  neon: `
body.theme-neon{
  --bg:#07070f;--bg-overlay:rgba(4,4,10,.6);--text:#e9e9f4;--text-dim:#8f8fb0;
  --bg-pattern:linear-gradient(transparent 55%,rgba(var(--accent-rgb),.05) 100%),repeating-linear-gradient(90deg,transparent 0 79px,rgba(var(--accent-rgb),.05) 79px 80px);
  --mod-bg:rgba(12,12,24,.66);--mod-border:1px solid rgba(var(--accent-rgb),.3);--mod-radius:18px;
  --mod-padding:20px;--mod-shadow:0 0 34px rgba(var(--accent-rgb),.12);
  --link-bg:transparent;--link-border:1px solid rgba(var(--accent-rgb),.42);--link-radius:12px;
  --link-hover-bg:rgba(var(--accent-rgb),.1);--link-hover-border:1px solid var(--accent);
  --link-hover-shadow:0 0 20px rgba(var(--accent-rgb),.38);
  --avatar-border:2px solid var(--accent);--avatar-shadow:0 0 18px rgba(var(--accent-rgb),.55);
  --mod-title-color:rgba(var(--accent-rgb),.9);--mod-title-rule:rgba(var(--accent-rgb),.18);
  --player-bg:rgba(12,12,24,.66);--player-border:1px solid rgba(var(--accent-rgb),.3);
}
body.theme-neon .name{
  background:linear-gradient(92deg,var(--accent),#f472b6);
  -webkit-background-clip:text;background-clip:text;color:transparent;
}`,
  /* 玻璃：背景图模糊化，面板磨砂悬浮 */
  glass: `
body.theme-glass{
  --bg:#0d1326;--bg-overlay:rgba(13,19,38,.45);--text:#f4f7ff;--text-dim:#a8b4d0;
  --mod-bg:rgba(255,255,255,.08);--mod-border:1px solid rgba(255,255,255,.14);--mod-radius:24px;
  --mod-padding:20px;--mod-shadow:0 18px 50px rgba(0,0,0,.32);--mod-blur:blur(18px);
  --link-bg:rgba(255,255,255,.1);--link-border:1px solid rgba(255,255,255,.16);--link-radius:14px;
  --link-hover-bg:rgba(255,255,255,.17);
  --avatar-border:3px solid rgba(255,255,255,.5);--avatar-shadow:0 10px 30px rgba(0,0,0,.35);
  --chip-bg:rgba(255,255,255,.1);--chip-border:1px solid rgba(255,255,255,.16);
  --mod-title-rule:rgba(255,255,255,.14);
  --player-bg:rgba(255,255,255,.1);--player-border:1px solid rgba(255,255,255,.16);
}`,
  /* 极光：旋转的多色光带做底，面板压暗浮起 */
  aurora: `
body.theme-aurora{
  --bg:#0a0a14;--bg-overlay:rgba(6,6,16,.5);--text:#fff;--text-dim:#a3a3c2;
  --mod-bg:rgba(10,10,22,.68);--mod-border:1px solid rgba(255,255,255,.1);--mod-radius:22px;
  --mod-padding:20px;--mod-blur:blur(12px);--mod-shadow:0 18px 50px rgba(0,0,0,.45);
  --link-bg:rgba(255,255,255,.1);--link-border:1px solid rgba(255,255,255,.1);
  --link-hover-bg:rgba(255,255,255,.18);
  --avatar-border:3px solid rgba(255,255,255,.6);--avatar-shadow:0 10px 26px rgba(0,0,0,.35);
  --mod-title-rule:rgba(255,255,255,.1);
  --player-bg:rgba(255,255,255,.1);--player-border:1px solid rgba(255,255,255,.12);
}
body.theme-aurora::before{
  background:conic-gradient(from 0deg,#6366f1,#ec4899,#f59e0b,#10b981,#6366f1);
  inset:-50%;filter:blur(64px);opacity:.38;
  animation:aurora-shift 22s linear infinite;
}
@keyframes aurora-shift{to{transform:rotate(360deg)}}`,
  /* 赛博：HUD 网格、切角面板、命令行气质 */
  cyber: `
body.theme-cyber{
  --bg:#06060d;--bg-overlay:rgba(6,6,13,.72);--text:#d2f8dc;--text-dim:#5f8a6d;
  --bg-pattern:repeating-linear-gradient(0deg,transparent 0 39px,rgba(var(--accent-rgb),.05) 39px 40px),repeating-linear-gradient(90deg,transparent 0 39px,rgba(var(--accent-rgb),.05) 39px 40px);
  --mod-bg:rgba(9,12,10,.72);--mod-border:1px solid rgba(var(--accent-rgb),.28);--mod-radius:4px;
  --mod-padding:18px;--mod-shadow:0 0 26px rgba(var(--accent-rgb),.08);
  --link-bg:rgba(var(--accent-rgb),.04);--link-border:1px solid rgba(var(--accent-rgb),.25);--link-radius:3px;
  --link-hover-bg:rgba(var(--accent-rgb),.12);--link-hover-border:1px solid var(--accent);
  --link-hover-transform:none;
  --avatar-radius:6px;--avatar-border:2px solid rgba(var(--accent-rgb),.45);
  --chip-bg:transparent;--chip-border:1px solid rgba(var(--accent-rgb),.35);--chip-radius:2px;
  --name-size:24px;--name-ls:.1em;
  --mod-title-color:rgba(var(--accent-rgb),.85);
  --player-bg:rgba(9,12,10,.72);--player-border:1px solid rgba(var(--accent-rgb),.28);--player-radius:4px;--player-cover-radius:2px;
  --gallery-radius:3px;
}
body.theme-cyber .mod,body.theme-cyber .link,body.theme-cyber .player{clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)}
body.theme-cyber .name::before{content:"> ";color:var(--accent);opacity:.7}
body.theme-cyber .mod-title::before{content:"// ";opacity:.6}
body.theme-cyber .mod-title{letter-spacing:.22em}`,
  /* 绽放：浅色樱粉，白卡浮在柔粉空气里 */
  blossom: `
body.theme-blossom{
  --bg:#fdf4f8;--bg-overlay:rgba(253,244,248,.72);--text:#6d2145;--text-dim:#b07a97;
  --bg-pattern:radial-gradient(circle at 85% 8%,rgba(244,168,196,.22),transparent 42%),radial-gradient(circle at 8% 92%,rgba(251,207,232,.3),transparent 46%);
  --mod-bg:#fff;--mod-border:1px solid #fbdfec;--mod-radius:22px;--mod-padding:20px;
  --mod-shadow:0 6px 26px rgba(232,104,168,.12);
  --link-bg:#fff;--link-border:1px solid #fbd6e8;--link-radius:14px;
  --link-hover-bg:#fff;--link-hover-border:1px solid #f4a8cc;--link-hover-shadow:0 6px 16px rgba(232,104,168,.18);
  --avatar-border:4px solid #fff;--avatar-shadow:0 6px 20px rgba(232,104,168,.25);
  --chip-bg:#fff;--chip-border:1px solid #fbd6e8;--chip-color:#9d3365;
  --mod-title-color:#c989aa;--mod-title-rule:#fbe3ef;
  --player-bg:#fff;--player-border:1px solid #fbdfec;
}
body.theme-blossom .quote{border-left-color:#f4a8cc}`,
  /* 纸刊：米色纸面 + 衬线排版 + 发丝线，像一页杂志 */
  paper: `
body.theme-paper{
  --bg:#f5f0e5;--bg-overlay:rgba(245,240,229,.78);--text:#211b12;--text-dim:#857a64;
  --font-body:${SONG_STACK};
  --bg-pattern:repeating-linear-gradient(45deg,rgba(33,27,18,.012) 0 2px,transparent 2px 6px);
  --mod-gap:30px;--mod-title-size:11px;--mod-title-ls:.34em;--mod-title-color:#a2937a;
  --mod-title-rule:rgba(33,27,18,.14);
  --link-bg:transparent;--link-border:none;--link-radius:0;
  --link-hover-bg:transparent;--link-hover-color:var(--accent);--link-hover-transform:none;
  --link-hover-border:none;
  --avatar-size:88px;--avatar-radius:4px;--avatar-border:1px solid rgba(33,27,18,.2);
  --name-size:32px;--name-weight:600;--name-ls:.04em;
  --chip-bg:transparent;--chip-border:1px solid rgba(33,27,18,.25);--chip-color:#4a4030;--chip-radius:2px;
  --player-bg:transparent;--player-border:1px solid rgba(33,27,18,.18);--player-radius:2px;--player-cover-radius:2px;
  --gallery-radius:2px;
}
body.theme-paper .hero{padding-bottom:22px;border-bottom:1px solid rgba(33,27,18,.16)}
body.theme-paper .name{padding:10px 0;border-top:1px solid rgba(33,27,18,.3);border-bottom:1px solid rgba(33,27,18,.3)}
body.theme-paper .link{border-bottom:1px solid rgba(33,27,18,.12);padding:13px 2px}
body.theme-paper .link::after{content:"↗";color:#b3a78e;transition:color .16s}
body.theme-paper .link:hover::after{color:var(--accent)}
body.theme-paper .quote{border-left:2px solid var(--accent);padding-left:22px}
body.theme-paper .quote p{font-size:18px}`,
  /* 水墨：宣纸墨字，朱印落款，楷体书写 */
  ink: `
body.theme-ink{
  --bg:#f3efe6;--bg-overlay:rgba(243,239,230,.8);--text:#1a1610;--text-dim:#7d7462;
  --font-body:${KAI_STACK};
  --bg-pattern:radial-gradient(circle at 92% 6%,rgba(26,22,16,.05),transparent 40%),repeating-linear-gradient(0deg,rgba(26,22,16,.008) 0 1px,transparent 1px 4px);
  --mod-gap:30px;--mod-title-ls:.4em;--mod-title-color:#968b75;--mod-title-rule:rgba(26,22,16,.12);
  --link-bg:transparent;--link-border:1px solid rgba(26,22,16,.28);--link-radius:3px;
  --link-hover-bg:#1a1610;--link-hover-color:#f3efe6;--link-hover-border:1px solid #1a1610;
  --link-hover-transform:none;
  --avatar-size:90px;--avatar-radius:6px;--avatar-border:1px solid rgba(26,22,16,.3);
  --name-size:38px;--name-weight:500;--name-ls:.14em;
  --chip-bg:transparent;--chip-border:1px solid rgba(26,22,16,.3);--chip-color:#37301f;--chip-radius:3px;
  --player-bg:transparent;--player-border:1px solid rgba(26,22,16,.25);--player-radius:3px;--player-cover-radius:2px;
  --gallery-radius:3px;
}
body.theme-ink .seal{
  display:inline-flex;align-items:center;justify-content:center;
  width:30px;height:30px;margin-left:12px;border-radius:5px;
  background:var(--accent);color:#f8f4ea;font-size:15px;font-weight:600;
  font-family:${KAI_STACK};vertical-align:.28em;box-shadow:0 2px 8px rgba(var(--accent-rgb),.35);
}
body.theme-ink .quote{border-left:3px solid var(--accent)}
body.theme-ink .quote p{font-size:19px}
body.theme-ink .timeline li::before{border-radius:2px}`,
  /* 终端：荧光绿屏 + 扫描线 + 等宽，一切都在命令行里 */
  terminal: `
body.theme-terminal{
  --bg:#070c07;--bg-overlay:rgba(4,8,4,.7);--text:#b7f3c9;--text-dim:#4d7a5e;
  --font-body:${MONO_STACK};--font-display:${MONO_STACK};
  --bg-pattern:repeating-linear-gradient(0deg,rgba(0,0,0,.25) 0 1px,transparent 1px 3px),radial-gradient(ellipse 90% 80% at 50% 50%,transparent 60%,rgba(0,0,0,.5));
  --mod-bg:rgba(10,20,12,.5);--mod-border:1px solid rgba(var(--accent-rgb),.2);--mod-radius:4px;--mod-padding:18px;
  --link-bg:transparent;--link-border:1px solid rgba(var(--accent-rgb),.25);--link-radius:3px;
  --link-hover-bg:var(--accent);--link-hover-color:#031007;--link-hover-border:1px solid var(--accent);
  --link-hover-transform:none;
  --avatar-size:80px;--avatar-radius:4px;--avatar-border:1px solid rgba(var(--accent-rgb),.5);
  --name-size:26px;--name-ls:.06em;
  --chip-bg:transparent;--chip-border:1px solid rgba(var(--accent-rgb),.4);--chip-radius:2px;
  --mod-title-color:rgba(var(--accent-rgb),.75);--mod-title-ls:.24em;
  --player-bg:rgba(10,20,12,.5);--player-border:1px solid rgba(var(--accent-rgb),.2);--player-radius:4px;--player-cover-radius:2px;
  --gallery-radius:2px;
}
body.theme-terminal .name::after{content:"▊";margin-left:6px;color:var(--accent);animation:term-blink 1.06s steps(1) infinite}
@keyframes term-blink{0%,49%{opacity:1}50%,100%{opacity:0}}
body.theme-terminal .link::before{content:">";color:var(--accent);opacity:.7;flex-shrink:0}
body.theme-terminal .mod-title::before{content:"::";opacity:.6}
body.theme-terminal .mod-title::after{content:"::";flex:0;margin-left:0}
body.theme-terminal .tl-date{color:rgba(var(--accent-rgb),.7)}
body.theme-terminal .chip::before{content:"#";opacity:.55;margin-right:1px}`,
  /* 暖阳：奶油暖调，大圆角与软阴影，亲和明快 */
  solar: `
body.theme-solar{
  --bg:#fff6ea;--bg-overlay:rgba(255,246,234,.7);--text:#503018;--text-dim:#a8876b;
  --bg-pattern:radial-gradient(circle at 88% 4%,rgba(255,183,77,.32),transparent 44%),radial-gradient(circle at 4% 96%,rgba(255,213,160,.35),transparent 40%);
  --mod-bg:#fff;--mod-border:1px solid rgba(221,107,32,.12);--mod-radius:26px;--mod-padding:20px;
  --mod-shadow:0 10px 32px rgba(221,107,32,.1);
  --link-bg:#fffaf2;--link-border:1px solid rgba(221,107,32,.16);--link-radius:999px;
  --link-hover-bg:#fff;--link-hover-border:1px solid rgba(221,107,32,.4);--link-hover-shadow:0 8px 20px rgba(221,107,32,.16);
  --avatar-radius:36%;--avatar-border:4px solid #fff;--avatar-shadow:0 8px 24px rgba(221,107,32,.22);
  --chip-bg:#fff3e2;--chip-border:1px solid rgba(221,107,32,.18);--chip-color:#8a4a1a;--chip-radius:999px;
  --mod-title-color:#c89878;--mod-title-rule:rgba(221,107,32,.12);
  --player-bg:#fffaf2;--player-border:1px solid rgba(221,107,32,.16);
  --gallery-radius:14px;
}
body.theme-solar .quote{border-left:4px solid var(--accent);border-radius:2px}`,
  /* 紫金：深紫描金，衬线大标题，典雅华丽 */
  royal: `
body.theme-royal{
  --bg:#150e20;--bg-overlay:rgba(21,14,32,.66);--text:#ecdcf7;--text-dim:#9b86b8;
  --font-body:${SONG_STACK};
  --mod-bg:rgba(32,21,48,.55);--mod-border:3px double rgba(var(--accent-rgb),.38);--mod-radius:6px;--mod-padding:22px;
  --mod-shadow:0 16px 44px rgba(0,0,0,.4);
  --link-bg:transparent;--link-border:1px solid rgba(var(--accent-rgb),.32);--link-radius:4px;
  --link-hover-bg:rgba(var(--accent-rgb),.12);--link-hover-border:1px solid var(--accent);
  --link-hover-transform:none;
  --avatar-radius:6px;--avatar-border:1px solid var(--accent);--avatar-shadow:0 0 0 4px rgba(var(--accent-rgb),.15),0 10px 28px rgba(0,0,0,.45);
  --name-size:30px;--name-weight:600;--name-ls:.22em;--name-color:var(--accent);
  --chip-bg:transparent;--chip-border:1px solid rgba(var(--accent-rgb),.4);--chip-radius:3px;--chip-color:#e6d3ae;
  --mod-title-color:rgba(var(--accent-rgb),.8);--mod-title-ls:.38em;--mod-title-rule:rgba(var(--accent-rgb),.22);
  --player-bg:rgba(32,21,48,.55);--player-border:1px solid rgba(var(--accent-rgb),.3);--player-radius:4px;--player-cover-radius:2px;
  --gallery-radius:4px;
}
body.theme-royal::after{
  content:"";position:fixed;inset:14px;z-index:0;pointer-events:none;
  border:1px solid rgba(var(--accent-rgb),.28);
}
body.theme-royal .hero .name{padding-bottom:14px;position:relative}
body.theme-royal .hero .name::after{
  content:"";position:absolute;left:50%;bottom:0;transform:translateX(-50%);
  width:72px;height:1px;
  background:linear-gradient(90deg,transparent,var(--accent) 30%,var(--accent) 70%,transparent);
}
body.theme-royal .quote{border-left:2px solid var(--accent)}
body.theme-royal .quote p{font-size:18px}`,
}

/**
 * 中文正文字体栈（body.fcjk-xxx 覆盖主题的 --font-body；system 不输出规则，
 * 让主题自带的默认栈生效）。放在主题 CSS 之后，同优先级靠后定义获胜。
 */
const CJK_FONT_CSS: Record<string, string> = {
  song: `body.fcjk-song{--font-body:${SONG_STACK}}`,
  kai: `body.fcjk-kai{--font-body:${KAI_STACK}}`,
  yuan: `body.fcjk-yuan{--font-body:"Yuanti SC","YouYuan","Yuanti TC","PingFang SC","Hiragino Sans GB",sans-serif}`,
}

function themeCss(theme: string, accent: string | null): string {
  const userAccent = accent && /^#[0-9a-f]{3,8}$/i.test(accent) ? accent : null
  const a = userAccent ?? THEME_DEFAULT_ACCENT[theme] ?? "#6366f1"
  return (
    BASE_CSS.replace(
      "--accent:#6366f1;--accent-rgb:99,102,241;",
      `--accent:${a};--accent-rgb:${hexToRgb(a)};`
    ) + (THEME_CSS[theme] ?? THEME_CSS.void)
  )
}

function cjkFontCss(cjkFont: string): string {
  return CJK_FONT_CSS[cjkFont] ?? ""
}

/**
 * 6 种结构预设：改变页面骨架而不只是样式。
 *   center = 居中卡片（默认，纵向居中）
 *   side   = 侧栏型（身份区固定左栏，模块在右）
 *   split  = 分屏型（底部浮层，背景大图全屏）
 *   plain  = 极简列（无容器，纯文字左对齐）
 *   bento  = 网格拼贴（模块以磁贴平铺成网格）
 *   banner = 横幅头图（顶部大图 + 下挂头像，杂志封面感）
 */
const LAYOUT_CSS: Record<string, string> = {
  side: `
body.layout-side .wrap{max-width:780px;display:flex;gap:44px;align-items:flex-start}
body.layout-side .hero{flex:0 0 240px;position:sticky;top:28px;align-items:flex-start;text-align:left}
body.layout-side .mods{flex:1;min-width:0;margin-top:4px}
body.layout-side .status-pill{margin-top:12px}
@media(max-width:640px){
  body.layout-side .wrap{flex-direction:column;gap:26px}
  body.layout-side .hero{position:static;flex-basis:auto;align-items:center;text-align:center}
}`,
  split: `
body.layout-split{justify-content:flex-end;padding-bottom:8vh;padding-top:48px}
body.layout-split .wrap{max-width:500px;padding:32px 26px;border-radius:24px;
  background:rgba(8,8,14,.58);border:1px solid rgba(255,255,255,.1);
  -webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);
  box-shadow:0 24px 64px rgba(0,0,0,.45)}
@media(max-width:560px){body.layout-split{padding-bottom:4vh}}`,
  plain: `
body.layout-plain{align-items:flex-start;justify-content:flex-start;padding:56px 26px}
body.layout-plain .wrap{max-width:580px}
body.layout-plain .hero{flex-direction:row;gap:18px;align-items:center;text-align:left}
body.layout-plain .avatar,body.layout-plain .avatar-fallback{width:56px;height:56px;font-size:22px}
body.layout-plain .name{margin-top:0;font-size:23px}
body.layout-plain .bio{margin-top:4px}
body.layout-plain .status-pill{margin-top:8px}
body.layout-plain .mods{margin-top:38px}
body.layout-plain .link{background:transparent;border:0;border-bottom:1px solid rgba(128,128,128,.18);border-radius:0;padding:12px 2px}
body.layout-plain .link:hover{transform:none;background:transparent;border-bottom:1px solid var(--accent);box-shadow:none}`,
  bento: `
body.layout-bento .wrap{max-width:780px;display:grid;grid-template-columns:1fr 1fr;gap:14px}
body.layout-bento .hero{
  grid-column:1/-1;flex-direction:row;gap:22px;align-items:center;text-align:left;
  background:var(--mod-bg,rgba(127,127,140,.07));border:var(--mod-border,1px solid rgba(127,127,140,.12));
  border-radius:var(--mod-radius,18px);padding:24px;box-shadow:var(--mod-shadow,none);
  -webkit-backdrop-filter:var(--mod-blur,none);backdrop-filter:var(--mod-blur,none)}
body.layout-bento .avatar,body.layout-bento .avatar-fallback{width:84px;height:84px;font-size:30px;flex-shrink:0}
body.layout-bento .name{margin-top:0}
body.layout-bento .mods{display:contents}
body.layout-bento .mod{
  background:var(--mod-bg,rgba(127,127,140,.07));border:var(--mod-border,1px solid rgba(127,127,140,.12));
  border-radius:var(--mod-radius,18px);padding:18px;box-shadow:var(--mod-shadow,none);
  -webkit-backdrop-filter:var(--mod-blur,none);backdrop-filter:var(--mod-blur,none)}
body.layout-bento .mod-gallery,body.layout-bento .mod-timeline,body.layout-bento .mod-links{grid-column:1/-1}
body.layout-bento .stats{grid-column:1/-1;margin-top:8px}
@media(max-width:640px){
  body.layout-bento .wrap{grid-template-columns:1fr}
  body.layout-bento .mod{grid-column:1/-1}
  body.layout-bento .hero{flex-direction:column;text-align:center;gap:14px}
}`,
  banner: `
body.layout-banner{padding:0 0 56px}
body.layout-banner .wrap{max-width:640px}
body.layout-banner .hero{display:block;text-align:left}
body.layout-banner .banner-img{height:210px}
body.layout-banner .avatar-wrap{padding:0 30px;margin-top:-52px;position:relative;z-index:1}
body.layout-banner .avatar,body.layout-banner .avatar-fallback{width:92px;height:92px;border-width:4px;border-color:var(--bg);font-size:32px}
body.layout-banner .id-text{padding:0 30px;margin-top:16px}
body.layout-banner .name{margin-top:0}
body.layout-banner .mods{margin-top:30px;padding:0 30px}
body.layout-banner .stats{padding:0 30px}
@media(max-width:560px){
  body.layout-banner .avatar-wrap,body.layout-banner .id-text,body.layout-banner .mods,body.layout-banner .stats{padding-left:20px;padding-right:20px}
}`,
}

function layoutCss(layout: string): string {
  return LAYOUT_CSS[layout] ?? ""
}

/** 英文标题字体：自托管 woff2，仅英文/拉丁字符集，中文回退到 --font-body 栈。 */
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
  // 只声明 --font-display:'DisplayFont'，中文回退交给使用处拼 var(--font-body)：
  // 若在这里写 var(--font-body)，会按「:root 处求值」的规则被冻成默认字体栈，
  // 主题（如水墨的楷体）就失效了。
  return `
@font-face{font-family:'DisplayFont';src:url('${esc(origin)}/fonts/${esc(file)}') format('woff2');font-display:swap;unicode-range:U+0020-007F,U+00A0-00FF,U+2000-206F}
:root{--font-display:'DisplayFont'}
`
}

/** 共用 canvas 层的动效互斥：只保留最先出现的一个。 */
function resolveEffectConflicts(effects: string[]): string[] {
  const CANVAS = new Set(["particles", "rain", "sakura", "snow"])
  let canvasSeen = false
  return effects.filter((e) => {
    if (!CANVAS.has(e)) return true
    if (canvasSeen) return false
    canvasSeen = true
    return true
  })
}

/** 动效 CSS：纯 CSS 类动效（glitch/glow/sparkle/float 的样式）+ canvas 容器。 */
function effectsCss(effects: string[]): string {
  let css = ""
  if (effects.some((e) => ["particles", "rain", "sakura", "snow"].includes(e))) {
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
  if (effects.includes("float")) {
    css += `
@keyframes fx-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
.hero,.mods .mod{animation:fx-float 6s ease-in-out infinite}
.mods .mod:nth-child(2n){animation-delay:-2s}
.mods .mod:nth-child(3n){animation-delay:-4s}`
  }
  return css
}

/** 动效需要插入 body 的 DOM（canvas / sparkle 层）。 */
function effectsHtml(effects: string[]): string {
  let html = ""
  if (effects.some((e) => ["particles", "rain", "sakura", "snow"].includes(e))) {
    html += `<canvas class="fx-canvas" id="fx-canvas"></canvas>`
  }
  if (effects.includes("sparkle")) {
    // 30 个随机位置 span（服务端用确定性变量生成，不用 Math.random）
    let spans = ""
    for (let i = 0; i < 30; i++) {
      const left = (i * 37) % 100
      const top = (i * 73) % 100
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
  if (effects.includes("sakura")) {
    js += `(function(){
      if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      var c=document.getElementById('fx-canvas');if(!c)return;
      var ctx=c.getContext('2d'),w,h,ps=[];
      function resize(){w=c.width=innerWidth;h=c.height=innerHeight}
      resize();addEventListener('resize',resize);
      var n=innerWidth<768?16:26;
      for(var i=0;i<n;i++)ps.push({x:Math.random()*w,y:Math.random()*h,r:4+Math.random()*5,
        vy:.5+Math.random()*.9,ph:Math.random()*6.28,rot:Math.random()*6.28,vr:(Math.random()-.5)*.02,
        a:.45+Math.random()*.4});
      function loop(){
        ctx.clearRect(0,0,w,h);
        for(var i=0;i<ps.length;i++){
          var p=ps[i];p.ph+=.012;p.y+=p.vy;p.x+=Math.sin(p.ph)*.7;p.rot+=p.vr;
          if(p.y>h+12){p.y=-12;p.x=Math.random()*w}
          if(p.x>w+12)p.x=-12;if(p.x<-12)p.x=w+12;
          ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.rot);
          ctx.fillStyle='rgba(244,164,196,'+p.a+')';
          ctx.beginPath();ctx.ellipse(0,0,p.r,p.r*.62,0,0,6.29);ctx.fill();
          ctx.fillStyle='rgba(251,207,232,'+(p.a*.85)+')';
          ctx.beginPath();ctx.ellipse(p.r*.32,-p.r*.2,p.r*.55,p.r*.34,.6,0,6.29);ctx.fill();
          ctx.restore();
        }
        requestAnimationFrame(loop)
      }
      loop();
    })();`
  }
  if (effects.includes("snow")) {
    js += `(function(){
      if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      var c=document.getElementById('fx-canvas');if(!c)return;
      var ctx=c.getContext('2d'),w,h,fs=[];
      function resize(){w=c.width=innerWidth;h=c.height=innerHeight}
      resize();addEventListener('resize',resize);
      var n=innerWidth<768?40:80;
      for(var i=0;i<n;i++)fs.push({x:Math.random()*w,y:Math.random()*h,r:.8+Math.random()*2.2,
        vy:.4+Math.random()*.9,ph:Math.random()*6.28,a:.35+Math.random()*.5});
      function loop(){
        ctx.clearRect(0,0,w,h);
        for(var i=0;i<fs.length;i++){
          var f=fs[i];f.ph+=.01;f.y+=f.vy;f.x+=Math.sin(f.ph)*.5;
          if(f.y>h+6){f.y=-6;f.x=Math.random()*w}
          if(f.x>w+6)f.x=-6;if(f.x<-6)f.x=w+6;
          ctx.beginPath();ctx.arc(f.x,f.y,f.r,0,6.28);
          ctx.fillStyle='rgba(255,255,255,'+f.a+')';ctx.fill();
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
  // glitch/glow/float 是纯 CSS，给目标元素加 fx class 触发
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
  // 兜底 1：环境完全不执行脚本时（iframe 无 allow-scripts、阅读模式等），
  // 直接放出内容——否则交互式开屏会让页面永久空白。
  css += `@media (scripting: none){.wrap{opacity:1 !important}.intro-overlay{display:none !important}}`
  if (intro === "enter") {
    css += `.intro-overlay{background:var(--bg)}`
    css += `.intro-overlay .intro-text{font-size:13px;letter-spacing:.3em;text-transform:uppercase;color:var(--text-dim);animation:fx-pulse 2s ease-in-out infinite}`
    css += `@keyframes fx-pulse{0%,100%{opacity:.35}50%{opacity:1}}`
  } else if (intro === "portal") {
    css += `.intro-overlay{background:var(--bg)}`
    css += `.intro-portal{width:120px;height:120px;border-radius:50%;background:conic-gradient(from 0deg,var(--accent),transparent,var(--accent));animation:portal-spin 2s linear infinite;box-shadow:0 0 40px rgba(var(--accent-rgb),.4)}`
    css += `@keyframes portal-spin{to{transform:rotate(360deg)}}`
    css += `.intro-overlay.gone .intro-portal{animation-duration:.3s}`
    css += `.intro-overlay .intro-text{color:var(--text-dim);font-size:12px;letter-spacing:.2em;text-transform:uppercase}`
  } else if (intro === "typewriter") {
    css += `.intro-overlay{background:var(--bg);cursor:pointer}`
    css += `.tw-line{font-family:var(--font-display,var(--font-body)),var(--font-body);font-size:clamp(26px,6vw,44px);color:var(--text);letter-spacing:.02em;min-height:1.3em;padding:0 24px;text-align:center;word-break:break-all}`
    css += `.tw-caret{display:inline-block;width:.5em;height:1.08em;background:var(--accent);vertical-align:-.16em;margin-left:3px;animation:tw-blink .82s steps(1) infinite}`
    css += `@keyframes tw-blink{0%,49%{opacity:1}50%,100%{opacity:0}}`
    css += `.tw-skip{position:absolute;bottom:34px;font-size:11px;letter-spacing:.3em;color:var(--text-dim);opacity:.7}`
    // 兜底 2：脚本存在但执行失败/被拦（打字机是最依赖 JS 的开屏），
    // 用纯 CSS 定时自动揭幕，保证内容一定出来。
    css += `.intro-overlay{animation:tw-autohide .6s ease 3.6s forwards}`
    css += `@keyframes tw-autohide{to{opacity:0;visibility:hidden}}`
    css += `.wrap{animation:intro-fade-in 1s ease 3.8s forwards}`
    css += `@keyframes intro-fade-in{from{opacity:0}to{opacity:1}}`
  } else if (intro === "fade") {
    css += `@keyframes intro-fade{to{opacity:1}}`
    css += `.wrap{animation:intro-fade 1.5s ease forwards}`
  } else if (intro === "slide") {
    css += `@keyframes intro-slide{to{opacity:1;transform:translateY(0)}}`
    css += `.wrap{transform:translateY(40px);animation:intro-slide .8s ease forwards}`
  }
  return css
}

/** 交互式 intro 的遮罩 DOM。非交互式（fade/slide）不需要 DOM。 */
function introHtml(intro: string): string {
  if (intro === "enter") {
    return `<div class="intro-overlay" id="intro"><span class="intro-text">Click to Enter</span></div>`
  }
  if (intro === "portal") {
    return `<div class="intro-overlay" id="intro"><div class="intro-portal"></div><span class="intro-text">Click to Enter</span></div>`
  }
  if (intro === "typewriter") {
    return `<div class="intro-overlay" id="intro"><span class="tw-line" id="tw"></span><span class="tw-caret"></span><span class="tw-skip">CLICK TO SKIP</span></div>`
  }
  return ""
}

/** 交互式 / 打字机 intro 的 JS。 */
function introJs(intro: string, name: string): string {
  if (intro === "enter" || intro === "portal") {
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
  if (intro === "typewriter") {
    // 昵称注入 <script>：JSON.stringify 之外还要转义 <，
    // 否则 displayName 里写 "</script>" 就能破壳（XSS）。
    const safeName = JSON.stringify(name).replace(/</g, "\\u003c")
    return `(function(){
      var ov=document.getElementById('intro'),tw=document.getElementById('tw'),wrap=document.querySelector('.wrap');
      if(!ov||!tw||!wrap)return;
      var name=${safeName},i=0,done=false;
      function finish(){
        if(done)return;done=true;
        tw.textContent=name;
        ov.classList.add('gone');
        setTimeout(function(){wrap.classList.add('visible')},200);
        setTimeout(function(){ov.style.display='none'},700);
      }
      if(matchMedia('(prefers-reduced-motion: reduce)').matches){finish();return;}
      ov.addEventListener('click',finish);
      var timer=setInterval(function(){
        if(i>=name.length){clearInterval(timer);setTimeout(finish,620);return;}
        tw.textContent=name.slice(0,++i);
      },110);
    })();`
  }
  return ""
}

/**
 * 头像圆角化后写回 <link rel="icon">。
 *
 * 为什么要跑 JS：favicon 没有 CSS 可用，圆角只能先把图画进 canvas（clip 出圆角矩形）
 * 再 toDataURL 回填 href。浏览器不允许给 favicon 加样式，这是唯一办法。
 *
 * 兜底策略（任一环节失败都保持原图，绝不出现"图标消失"）：
 *   - 跨域头像 + 对方没发 CORS 头 → img 加载失败 → 原 href 不动；
 *   - canvas 被污染 → toDataURL 抛错 → catch 吞掉。
 * 只对 rel="icon" 生效；apple-touch-icon 不做——iOS 自己会套 squircle 蒙版，
 * 预圆角反而会在白底上露出四个缺口。
 */
function faviconJs(url: string): string {
  const safe = JSON.stringify(url).replace(/</g, "\\u003c")
  return `(function(){
    var link=document.getElementById('favicon');
    if(!link||!window.HTMLCanvasElement)return;
    var img=new Image();
    img.crossOrigin='anonymous';
    img.onload=function(){
      try{
        var s=128,c=document.createElement('canvas');
        c.width=s;c.height=s;
        var x=c.getContext('2d');
        if(!x)return;
        var r=s*0.24;               /* 不大不小：约 iOS squircle 的圆角比例 */
        x.beginPath();
        x.moveTo(r,0); x.lineTo(s-r,0); x.quadraticCurveTo(s,0,s,r);
        x.lineTo(s,s-r); x.quadraticCurveTo(s,s,s-r,s);
        x.lineTo(r,s); x.quadraticCurveTo(0,s,0,s-r);
        x.lineTo(0,r); x.quadraticCurveTo(0,0,r,0);
        x.closePath();
        x.save(); x.clip();
        /* cover 裁剪：非正方形头像按短边铺满，避免拉伸变形 */
        var iw=img.naturalWidth||img.width, ih=img.naturalHeight||img.height;
        if(!iw||!ih)return;
        var k=Math.max(s/iw,s/ih), dw=iw*k, dh=ih*k;
        x.drawImage(img,(s-dw)/2,(s-dh)/2,dw,dh);
        x.restore();
        link.href=c.toDataURL('image/png');
      }catch(e){}
    };
    img.src=${safe};
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
    function update(){
      if(!fill)return;
      var cur=audio.currentTime||0,dur=audio.duration||0;
      fill.style.width=(dur>0?(cur/dur*100):0)+'%';
      if(time)time.textContent=fmt(cur)+(dur>0?' / '+fmt(dur):'');
    }
    audio.addEventListener('timeupdate',update);
    audio.addEventListener('loadedmetadata',update);
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

// ---- 模块解析与渲染 ----

/** 中间区模块的默认顺序（用户在编辑器里可拖动调整，存储数组顺序优先）。 */
const DEFAULT_MODULE_ORDER = ["tags", "quote", "links", "timeline", "gallery", "music"]

/** 各模块的默认开关：联系方式/音乐/统计默认开，新增模块默认关。 */
const MODULE_DEFAULT_ENABLED: Record<string, boolean> = {
  status: false,
  tags: false,
  quote: false,
  links: true,
  timeline: false,
  gallery: false,
  music: true,
  stats: true,
}

const MODULE_TITLES: Record<string, string> = {
  tags: "标签",
  quote: "名言",
  links: "联系方式",
  timeline: "大事记",
  gallery: "图片墙",
}

interface ResolvedModules {
  status: ProfileModule | null
  middle: ProfileModule[]
  stats: boolean
}

/**
 * 把存储的 modules 数组解析成「最终展示列表」：
 * - 数组顺序优先，缺省的模块按默认顺序补位
 * - 开关以存储为准，没存过用默认值
 * - identity 恒在头部、stats 恒在页脚、status 跟随身份区（不在此列表）
 * - 启用但无内容的模块自动隐藏（如没填标签就不出「标签」块）
 */
function resolveModules(parsed: ProfileModule[], p: PublicProfile): ResolvedModules {
  const map = new Map<string, ProfileModule>()
  for (const m of parsed) map.set(m.id, m)

  const storedOrder = parsed
    .map((m) => m.id)
    .filter((id) => DEFAULT_MODULE_ORDER.includes(id))
  const middleIds = [
    ...storedOrder,
    ...DEFAULT_MODULE_ORDER.filter((id) => !storedOrder.includes(id)),
  ]

  const hasContent = (m: ProfileModule): boolean => {
    switch (m.id) {
      case "links":
        return p.contacts.length > 0
      case "music":
        return Boolean(safeUrl(p.music))
      case "tags":
        return strItems(m).length > 0
      case "quote":
        return Boolean(m.text)
      case "timeline":
        return timelineItems(m).length > 0
      case "gallery":
        return galleryItems(m).length > 0
      default:
        return false
    }
  }

  const middle: ProfileModule[] = []
  for (const id of middleIds) {
    const stored = map.get(id)
    const mod: ProfileModule = stored ?? { id, enabled: MODULE_DEFAULT_ENABLED[id] ?? false }
    const enabled = stored ? stored.enabled : (MODULE_DEFAULT_ENABLED[id] ?? false)
    if (!enabled) continue
    const withFlag = { ...mod, enabled: true }
    if (hasContent(withFlag)) middle.push(withFlag)
  }

  const statusStored = map.get("status")
  const status =
    (statusStored ? statusStored.enabled : MODULE_DEFAULT_ENABLED.status) &&
    statusStored?.text
      ? statusStored
      : null
  const statsStored = map.get("stats")
  const stats = statsStored ? statsStored.enabled : MODULE_DEFAULT_ENABLED.stats

  return { status, middle, stats }
}

function strItems(m: ProfileModule): string[] {
  return (m.items ?? []).filter((x): x is string => typeof x === "string")
}

function timelineItems(m: ProfileModule): TimelineItem[] {
  return (m.items ?? []).filter(
    (x): x is TimelineItem => typeof x === "object" && x !== null && "title" in x
  )
}

function galleryItems(m: ProfileModule): GalleryItem[] {
  return (m.items ?? []).filter(
    (x): x is GalleryItem => typeof x === "object" && x !== null && "url" in x
  )
}

/** 渲染中间区的单个模块（调用方保证 enabled 且有内容）。 */
function renderModule(m: ProfileModule, p: PublicProfile): string {
  switch (m.id) {
    case "tags": {
      const chips = strItems(m)
        .map((t) => `<span class="chip">${esc(t)}</span>`)
        .join("")
      return `<section class="mod mod-tags"><h2 class="mod-title">${MODULE_TITLES.tags}</h2><div class="chips">${chips}</div></section>`
    }
    case "quote": {
      const author = m.author ? `<cite>—— ${esc(m.author)}</cite>` : ""
      return `<section class="mod mod-quote"><h2 class="mod-title">${MODULE_TITLES.quote}</h2><blockquote class="quote"><p>${escMultiline(m.text)}</p>${author}</blockquote></section>`
    }
    case "links": {
      const links = p.contacts
        .map((c) => {
          const { href, label, icon: iconName } = contactLink(c)
          const inner = `${icon(iconName)}<span class="t">${esc(label)}</span>`
          return href
            ? `<a class="link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
            : `<div class="link">${inner}</div>`
        })
        .join("")
      return `<section class="mod mod-links"><h2 class="mod-title">${MODULE_TITLES.links}</h2><nav class="links">${links}</nav></section>`
    }
    case "timeline": {
      const items = timelineItems(m)
        .map((it) => {
          const date = it.date ? `<div class="tl-date">${esc(it.date)}</div>` : ""
          const desc = it.desc ? `<div class="tl-desc">${esc(it.desc)}</div>` : ""
          return `<li>${date}<div class="tl-title">${esc(it.title)}</div>${desc}</li>`
        })
        .join("")
      return `<section class="mod mod-timeline"><h2 class="mod-title">${MODULE_TITLES.timeline}</h2><ol class="timeline">${items}</ol></section>`
    }
    case "gallery": {
      const figs = galleryItems(m)
        .map((g) => {
          const u = safeUrl(g.url)
          if (!u) return ""
          const cap = g.caption ? `<figcaption>${esc(g.caption)}</figcaption>` : ""
          return `<figure><img loading="lazy" src="${esc(u)}" alt="${esc(g.caption || "图片")}">${cap}</figure>`
        })
        .join("")
      return `<section class="mod mod-gallery"><h2 class="mod-title">${MODULE_TITLES.gallery}</h2><div class="gallery">${figs}</div></section>`
    }
    case "music": {
      const music = safeUrl(p.music)
      if (!music) return ""
      const musicCover = safeUrl(p.musicCover)
      return `<section class="mod mod-music"><div class="player">
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
      <audio id="bgm" src="${esc(music)}" loop ${p.musicAutoplay ? "autoplay" : ""} preload="metadata"></audio></section>`
    }
    default:
      return ""
  }
}

/**
 * 渲染公开名片页。
 * opts.baseHref：编辑器 iframe srcdoc 预览用——srcdoc 是 opaque origin，
 * 相对路径（/p/…、/fonts/…）无法解析，注入 <base> 让资源走绝对地址。
 */
export function renderProfileHtml(
  p: PublicProfile,
  opts?: { baseHref?: string }
): string {
  const avatar = safeUrl(p.avatar)
  const background = safeUrl(p.background)
  const name = p.displayName || p.username
  const initial = name.slice(0, 1).toUpperCase()

  const fx = resolveEffectConflicts(p.effects)
  const intro = p.intro
  const mods = resolveModules(p.modules ?? [], p)

  // 公开页资源走站内路径；字体自托管，自定义域名下也用绝对 URL（/fonts/* 已加 CORS）
  const origin = "https://cloud.doulor.cn"

  // 站点图标用用户头像（没有头像时回落到站点默认 favicon）。
  // 不写 type：上传头像可能是 jpg/png/webp/gif，服务端不额外查扩展名，交给浏览器嗅探。
  // 头像用相对路径即可——自定义域名下 /p/* 同样路由到本 Worker，自己域名自己取图。
  // 默认 favicon 则必须写绝对地址：它是静态站点的资源，自定义域名上没有。
  const favicon = avatar || `${origin}/favicon.png`
  // 只有用户头像才圆角化；站点默认图标本身就是设计好的，不再加工
  const faviconRounded = Boolean(avatar)

  // 背景层：glass 用模糊层；banner 布局时背景图挪进头图横幅，不再全屏铺
  const isBanner = p.layout === "banner"
  const blurLayer =
    p.theme === "glass" && background && !isBanner
      ? `<div class="bg-blur" style="background-image:url('${esc(background)}')"></div>`
      : ""
  const bgLayer =
    background && p.theme !== "glass" && !isBanner
      ? `<div class="bg" style="background-image:url('${esc(background)}')"></div>`
      : ""

  // banner 头图：用户背景图优先，否则用 accent 渐变
  const bannerImg = isBanner
    ? `<div class="banner-img" style="${background ? `background-image:url('${esc(background)}')` : `background-image:linear-gradient(135deg,var(--accent),rgba(var(--accent-rgb),.35))`}"></div>`
    : ""

  const fxLayer = effectsHtml(fx)
  const introLayer = introHtml(intro)

  // 页脚统计
  const regDate = p.registeredAt
    ? new Date(p.registeredAt).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
    : null
  const metaParts: string[] = []
  if (regDate) metaParts.push(`加入于 ${regDate}`)
  metaParts.push(`${p.viewCount} 次访问`)
  const statsLine = mods.stats
    ? `<footer class="stats">${esc(metaParts.join(" · "))}</footer>`
    : ""

  // 交互式 intro：初始 .wrap 无 visible（JS 点击后加）；非交互式/none：CSS animation 或直接显示
  const wrapVisibleClass = intro === "enter" || intro === "portal" || intro === "typewriter" ? "" : " visible"

  // 身份区
  const avatarHtml = avatar
    ? `<img class="avatar" src="${esc(avatar)}" alt="${esc(name)}">`
    : `<div class="avatar-fallback">${esc(initial)}</div>`
  const sealHtml = `<span class="seal">${esc(initial)}</span>`
  const statusHtml = mods.status
    ? `<div class="status-pill">${mods.status.emoji ? `<span class="se">${esc(mods.status.emoji)}</span>` : ""}<span>${esc(mods.status.text)}</span></div>`
    : ""

  // 身份区：banner 骨架下头图独占整行，头像压边、文字全部落在纯色背景上
  // （旧的「整块 id-block 负 margin 上提」会让昵称压在头图渐隐层上，被洗白）
  const heroInner = isBanner
    ? `${bannerImg}<div class="avatar-wrap">${avatarHtml}</div><div class="id-text"><h1 class="name">${esc(name)}${sealHtml}</h1>${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ""}${statusHtml}</div>`
    : `<div class="avatar-wrap">${avatarHtml}</div><div class="id-text"><h1 class="name">${esc(name)}${sealHtml}</h1>${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ""}${statusHtml}</div>`

  const modsHtml = mods.middle.map((m) => renderModule(m, p)).join("")

  const css =
    themeCss(p.theme, p.accent) +
    cjkFontCss(p.cjkFont) +
    layoutCss(p.layout) +
    fontFaceCss(p.font, origin) +
    effectsCss(fx) +
    introCss(intro)

  const js =
    (faviconRounded ? faviconJs(favicon) : "") +
    musicPlayerJs() +
    effectsJs(fx) +
    introJs(intro, name)

  const baseTag = opts?.baseHref ? `<base href="${esc(opts.baseHref)}">` : ""

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
${baseTag}
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(name)}</title>
<link rel="icon" id="favicon" href="${esc(favicon)}">
<link rel="apple-touch-icon" href="${esc(favicon)}">
<meta name="description" content="${esc(p.bio || `${name} 的个人名片`)}">
<meta property="og:title" content="${esc(name)}">
<meta property="og:description" content="${esc(p.bio || "")}">
${avatar ? `<meta property="og:image" content="${esc(avatar)}">` : ""}
<meta name="theme-color" content="${esc(p.accent || THEME_DEFAULT_ACCENT[p.theme] || "#6366f1")}">
<style>${css}</style>
</head>
<body class="theme-${esc(p.theme)} layout-${esc(p.layout)} fcjk-${esc(p.cjkFont || "system")}">
${blurLayer}${bgLayer}
${fxLayer}
${introLayer}
<div class="wrap${wrapVisibleClass}">
  <header class="hero">${heroInner}</header>
  ${modsHtml ? `<main class="mods">${modsHtml}</main>` : ""}
  ${statsLine}
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
