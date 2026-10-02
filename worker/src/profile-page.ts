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

/** 正则转义——域名里的点号拼进 RegExp 前必须转义，否则 `t.me` 会匹配 `tXme` */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 把用户填的联系方式值归一化成「平台裸标识」（用户名 / UID / handle）。
 *
 * 用户在输入框里实际会填的形态远多于提示词要求的：
 *   "Doulor" / "@Doulor" / "https://github.com/Doulor" / "github.com/Doulor" / "GitHub: Doulor"
 * 旧实现只对部分平台做了 isUrl 判断，其余直接拼前缀，于是生成
 *   https://t.me/https%3A%2F%2Ft.me%2FDoulor
 * 这类必然打不开的链接 —— 线上 B 站那条 /UID%3A1307574205 是同一个病根。
 *
 * @param hosts 该平台的域名（用于把粘进来的链接还原成裸标识）；无个人主页形态的平台传 []
 * @returns 裸标识；无法识别时返回空串，调用方据此**不给链接**（宁可不可点，也别指向陌生人）
 */
function bareId(raw: string, hosts: string[]): string {
  let s = raw.trim()
  if (!s) return ""

  const hostAlt = hosts.map(escapeRe).join("|")
  // 剥「协议 + www + 平台域名」；也认无协议的裸域名写法（t.me/foo）
  const stripHost = (t: string): string =>
    hostAlt
      ? t.replace(new RegExp(`^(?:https?://)?(?:www\\.)?(?:${hostAlt})/+`, "i"), "")
      : t

  // 该平台没有可还原的链接形态：填了 URL 也认不出标识，交给调用方拒绝
  if (!hostAlt && /^https?:\/\//i.test(s)) return ""

  // 先剥平台域名，再剥「前缀:」标签。两者会叠加（"GitHub: https://github.com/foo"），
  // 所以来回剥两轮。
  s = stripHost(s)
  // 「前缀:」写法（UID:1307574205、GitHub: Doulor、Telegram：Doulor），中英文冒号都认。
  // 标识本身不可能含冒号，所以在第一个冒号处截断是安全的。
  s = s.replace(/^[^\s:：/]{1,24}\s*[:：]\s*/, "")
  s = stripHost(s)

  // 剥完平台域名后仍带着「域名/」形态 → 用户填的是别的站点的地址，认不出裸标识。
  // 直接放行会拼出 github.com/example.com 这类同样打不开的链接，不如拒绝。
  if (/^[^\s/]+\.[a-z]{2,}\//i.test(s)) return ""

  // 剥开头的 @（Telegram / X / YouTube 的 handle 常带 @）
  s = s.replace(/^@+/, "")

  // 丢掉路径与查询串的剩余部分（github.com/foo/repo → foo）
  s = s.replace(/[/?#].*$/, "")

  return s.trim()
}

/**
 * 把联系方式拼成可点击链接。
 * 服务端拼接的好处：用户只需填原始值（QQ 号 / UID / 用户名），
 * 避免在前端各处重复实现拼接规则、也防止用户填出 javascript: 之类的危险协议。
 *
 * 显示文字统一为「平台名 + 归一化后的值」；用户填了自定义 label 时以 label 优先。
 * 识别不出裸标识的平台一律不给 href（渲染成不可点的文本）。
 */
function contactLink(c: Contact): { href: string | null; label: string; icon: string } {
  const v = c.value.trim()
  switch (c.type) {
    case "email": {
      // 用户可能把 "mailto:" 或「邮箱:」也一起粘进来
      const addr = v
        .replace(/^mailto:/i, "")
        .replace(/^[^\s:：@]{1,24}\s*[:：]\s*/, "")
        .trim()
      const ok = /^[^\s@]+@[^\s@]+$/.test(addr)
      return {
        href: ok ? `mailto:${addr}` : null,
        label: c.label || `邮箱 ${addr || v}`,
        icon: "mail",
      }
    }
    case "qq": {
      // QQ 加好友链接的两种来源，体验和用途完全不同，所以**先区分再处理**：
      //
      // 1. 用户粘贴 QQ 里「分享」得到的加好友内容。真实形态常带一段文案，例如
      //      「点击链接加我为QQ好友：https://qm.qq.com/q/5uAkInIOJi」
      //    也可能直接是链接本体（短链 /q/xxx，或二维码页 cgi-bin/qm/qr?k=…）。
      //    这是**加好友的正道**——腾讯内部用加密 token 验证「本人主动分享的邀请」，
      //    扫/点开后是「加好友」而不是「咨询客服」。token 无法用 QQ 号反推，
      //    只能用户分享时拿一次。⇒ 用正则从整段文本里**搜索**出链接本体。
      //
      // 2. 只填了 QQ 数字号。这时只能用 `wpa.qq.com/msgrd`，但它是腾讯给
      //    **商家/商户**用的客服通道，点开是「请选择沟通方式 / 唤起客户端」，
      //    不是加好友、也不是个人主页。体验差但聊胜于无（至少能唤起 QQ 客户端）。
      //    注意：填错号码就会跳到「不知道什么地方」，那是号码错了，不是链接问题。
      //
      // ⚠️ 2026-09-25 历史：曾硬编码第三方 `res.abeim.cn/api/qq/`（该域名已全线失联）。
      const trimmed = v.trim()

      // QQ 显示文字归一化：用户填纯数字（QQ 号）时自动补「QQ 」前缀，
      // 与旁边「GitHub Doulor」「Bilibili 1307574205」等条目对齐；
      // 已含「QQ」字样或自定义文字则原样保留，避免「QQ QQ 123」这类重复。
      const qqLabel = (raw: string): string => {
        const t = raw.trim()
        if (!t) return t
        if (/^qq\b/i.test(t)) return t // 已带 QQ 前缀
        if (/^\d{4,12}$/.test(t)) return `QQ ${t}` // 纯数字 → 补前缀
        return t
      }

      // 从整段文本里找 qm 链接本体（允许前后带「点击链接加我为QQ好友：」之类文案）
      const qmLnk = trimmed.match(/https?:\/\/(?:www\.)?qm\.qq\.com\/(?:q\/[A-Za-z0-9_-]+|cgi-bin\/qm\/qr\?k=[A-Za-z0-9_-]+)/i)
      if (qmLnk) {
        // 强制 https，去掉可能粘进来的尾随斜杠/标点
        const url = qmLnk[0].replace(/^http:/i, "https:").replace(/[\/.,，。]+$/, "")
        // 显示文字：用户填了 label（通常是 QQ 号，方便别人不用点也能看到直接搜）优先；
        // 否则尝试从内容里识别数字号；再退化成「QQ」
        const num = trimmed.match(/\b\d{4,12}\b/)
        return {
          href: url,
          label: qqLabel(c.label ?? "") || (num ? `QQ ${num[0]}` : "QQ"),
          icon: "qq",
        }
      }

      // 否则走数字号（带前缀 "QQ: 123" 也归一化）。该接口只认数字号。
      const qq = bareId(trimmed, [])
      const ok = /^\d{4,12}$/.test(qq)
      return {
        href: ok ? `https://wpa.qq.com/msgrd?v=3&uin=${qq}&site=qq&menu=yes` : null,
        label: qqLabel(c.label ?? "") || `QQ ${ok ? qq : v}`,
        icon: "qq",
      }
    }
    case "wechat":
      // 微信没有可跳转的个人主页，只支持填二维码图片链接
      return {
        href: /^https?:\/\//i.test(v) ? v : null,
        label: c.label || (/^https?:\/\//i.test(v) ? "微信" : `微信 ${v}`),
        icon: "wechat",
      }
    case "bilibili": {
      // B 站用户空间只认数字 UID（space.bilibili.com/<uid>）。
      // b23.tv 短链无法在服务端还原成 UID，因此会被下面的数字校验挡掉 —— 符合预期。
      const uid = bareId(v, ["space.bilibili.com", "bilibili.com", "b23.tv"])
      const ok = /^\d+$/.test(uid)
      return {
        href: ok ? `https://space.bilibili.com/${uid}` : null,
        label: c.label || `Bilibili ${ok ? uid : v}`,
        icon: "bilibili",
      }
    }
    case "discord": {
      // 邀请码可能来自 discord.gg/CODE 或 discord.com/invite/CODE
      // （长域名写在前面，正则择先匹配）
      const code = bareId(v, ["discord.gg", "discord.com/invite", "discord.com"])
      return {
        href: code ? `https://discord.gg/${encodeURIComponent(code)}` : null,
        label: c.label || `Discord ${code || v}`,
        icon: "discord",
      }
    }
    case "telegram": {
      const handle = bareId(v, ["t.me", "telegram.me"])
      return {
        href: handle ? `https://t.me/${encodeURIComponent(handle)}` : null,
        label: c.label || `Telegram ${handle ? `@${handle}` : v}`,
        icon: "telegram",
      }
    }
    case "youtube": {
      // YouTube 的频道链接有多种合法形态（/@handle、/channel/UCxxx、/c/Name），
      // 没法像别的平台那样「剥出裸标识再拼回去」，识别到链接就整条采用。
      // 只认 youtube.com：youtu.be 是视频短链，转成频道地址必然错，不如不给。
      const url = v.match(/^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(\S+)$/i)
      if (url) {
        return {
          href: `https://www.youtube.com/${url[1]}`,
          label: c.label || "YouTube",
          icon: "youtube",
        }
      }
      const id = bareId(v, [])
      return {
        href: id ? `https://youtube.com/@${encodeURIComponent(id)}` : null,
        label: c.label || `YouTube ${id ? `@${id}` : v}`,
        icon: "youtube",
      }
    }
    case "github": {
      const id = bareId(v, ["github.com"])
      return {
        href: id ? `https://github.com/${encodeURIComponent(id)}` : null,
        label: c.label || `GitHub ${id || v}`,
        icon: "github",
      }
    }
    case "x": {
      const handle = bareId(v, ["x.com", "twitter.com"])
      return {
        href: handle ? `https://x.com/${encodeURIComponent(handle)}` : null,
        label: c.label || `X ${handle ? `@${handle}` : v}`,
        icon: "x",
      }
    }
    case "custom":
    default:
      // 自定义链接无法猜测归属，只接受完整 URL
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

/**
 * 转义后再把换行变成 <br>——用于名言等允许换行的多行文本。
 * 必须先 esc 再替换：这样用户输入的 < 已被转义，插入的 <br> 不会被二次转义。
 */
function escMultiline(s: string | null | undefined): string {
  return esc(s).replace(/\r\n|\r|\n/g, "<br>")
}

/**
 * 只允许安全的 URL 进入 src/href（再次兜底，防 javascript:）。
 *
 * ⚠️ 2026-09-25 审计（L9）：原判断是 `t.startsWith("/")`，于是
 * `//evil.com/x`（协议相对 URL）也被放行 —— 浏览器会把它当
 * `https://evil.com/x` 处理。虽然 https 外链本来就是允许的，
 * 但这里放行的是**看起来像站内相对路径**的字符串，容易被用来做
 * 「本站域名开头的钓鱼链接」（`cloud.doulor.cn/u/x` 上显示的是站内路径，
 * 点开却去了外站）。现在显式排除以 `//` 或 `/\` 开头的形式。
 */
function safeUrl(u: string | null): string | null {
  if (!u) return null
  const t = u.trim()
  if (/^https?:\/\//i.test(t)) return t
  if (t.startsWith("/") && !/^\/[/\\]/.test(t)) return t
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
/* html/body 不设 height:100%：设了之后 body 高度被钉死在视口高，
   而 flex 的 justify-content:center 在内容溢出时会把溢出量**平均分到上下两侧**，
   上侧那部分滚不到（scrollTop 不能为负）→ 模块一多，头像和昵称就永久看不见了。
   改成 height:auto 让 body 随内容增长；再配 safe center 兜底：
   safe 关键字规定「溢出时按 start 对齐」，即退化成从顶部开始、可正常滚动。 */
html,body{height:auto}
body{
  font-family:var(--font-body);
  -webkit-font-smoothing:antialiased;
  display:flex;flex-direction:column;align-items:center;justify-content:safe center;
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

/* ---- 自动缩放 ----
   为什么用 zoom 而不是 transform:scale：
   transform 只改变绘制结果，**布局高度不变**，缩完页面底下仍留一大段
   空白滚动区；zoom 参与布局计算，文档高度会跟着缩，滚动条长度才正确。
   而且 zoom 在 Chrome/Safari/Firefox(126+) 都已支持，本项目面向现代浏览器。
   基准值由内联样式 --pz 注入（见 renderProfileHtml），默认 1。 */
.wrap{zoom:var(--pz,1)}

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

/* 模块宽度（桌面端）。
   只有当**有模块显式设过宽度**时，.mods 才从单列流式切成两列网格 —— 用 :has() 做开关，
   于是老数据（没人设过宽度）逐像素保持原样，不存在「上线后所有人名片集体变样」。
   ⚠️ 默认必须写成「所有模块先跨满整行，只有设了 half 的才占一列」。
   反过来写（「只有设了 full 的才跨列」）会踩坑：没设宽度的模块身上**没有** data-size 属性，
   不匹配任何规则，于是掉进 grid 的默认行为占 1 列 —— 变成半宽，比改动前更糟。
   ⚠️ 排除 bento：那个骨架自己把 .mods 设成 display:contents，两列网格由它自己管。 */
@media(min-width:641px){
  body:not(.layout-bento) .mods:has(>[data-size]){display:grid;grid-template-columns:1fr 1fr;gap:var(--mod-gap)}
  body:not(.layout-bento) .mods>.mod{grid-column:1/-1}
  body:not(.layout-bento) .mods>[data-size="half"]{grid-column:span 1}
}

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
/* 音乐模块。
   用 grid + 容器查询实现「歌词在播放器下面还是右边」：
   网格本身常驻两列，默认两个子元素都跨满整行 ⇒ 上下排，与改动前视觉一致；
   只有**模块自身**够宽时，才在容器查询里把两者分到左右两列。
   ⚠️ 容器查询只能选中容器的**后代**，不能选中容器自己 —— 所以 grid 必须常驻在 .mod-music 上，
   不能写进 @container 里（那样 .mod-music 不是它自己的后代，规则永远不生效）。
   ⚠️ 容器是「模块自身宽度」而非视口宽度：同一个模块在 center 骨架里 460px、
   在 bento 整宽里 780px，按视口宽度判断会判错。 */
.mod-music{container-type:inline-size;display:grid;grid-template-columns:1fr 1fr;gap:0}
.mod-music>audio{display:none}
.mod-music>.player,.mod-music>.lyrics{grid-column:1/-1}
/* 够宽才并排。620px 以下播放器分不到一半宽度，标题会被挤成省略号，不如上下排。
   间距用 margin 而不是 grid gap：gap 写在容器自己身上，容器查询改不了它（只能改后代），
   常驻 row-gap 又会让上下排时平白多出一段空隙。 */
@container (min-width:620px){
  .mod-music>.player{grid-column:1}
  .mod-music>.lyrics{grid-column:2;margin-top:0;margin-left:12px}
}
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

/* 歌词面板
   配色全部复用各主题已有的 --player-* 变量，因此不用给 10 个主题各写一份。
   无时间轴的纯文本歌词走 .lyrics-plain，去掉逐行高亮相关的样式。 */
.lyrics{margin-top:8px;padding:8px 14px;border-radius:var(--player-radius);background:var(--player-bg);border:var(--player-border);overflow:hidden}
/* 歌词面板只展示「当前行 + 下一行」：高度 = 2 × 行高 + 行间距。
   ⚠️ 高度里的 em 必须落在 .lrc-inner **自己**身上。字号以前只写在 .lrc-line 上，
   .lrc-inner 只继承页面基准字号（16px）⇒ calc(2*1.9em+12px) 按 16px 算成 73px，
   而两行实际只占 ~46px，底下空一大截，卡片显得又高又空、歌词只占一点点。
   现在把 font-size/line-height 提到 .lrc-inner，em 与行高同源，两行刚好填满。 */
.lrc-inner{position:relative;font-size:12px;line-height:1.75;height:calc(2 * 1.75em + 4px);overflow:hidden}
/* ⚠️ 基准 opacity 必须是 0：同一时刻只有 .on / .pre 两行可见。
   以前写成 .42，于是**所有**没被标记的歌词都停在 translateY(0) 上 ——
   全部叠在卡片最顶上、一直显示，这就是「歌词全堆在最上面」的根因。 */
.lrc-line{position:absolute;left:0;right:0;font-size:inherit;line-height:inherit;text-align:center;color:var(--text);opacity:0;transition:transform .3s ease,opacity .18s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 两行：上=当前(高亮)，下=下一行(半透明)。用 transform 定位，避免 layout 抖动 */
.lrc-line.on{opacity:1;font-weight:600;transform:translateY(0)}
.lrc-line.pre{opacity:.42;transform:translateY(calc(1.75em + 2px))}
/* 没有时间轴的纯文本歌词：整段静态展示（那段文字直接放在 .lrc-inner 里，没有 .lrc-line 子元素），
   不参与「两行」同步，也不受上面的 opacity:0 影响 */
.lyrics-plain .lrc-inner{height:auto;line-height:1.9;text-align:center;color:var(--text);opacity:.72;white-space:pre-wrap}
/* 「歌词在下面还是右边」的规则在 .mod-music 那段（需要容器查询，且容器不能选中自己） */

/* 页脚统计 */
.stats{margin-top:34px;text-align:center;font-size:11px;color:var(--text-dim);opacity:.85;letter-spacing:.06em}
/* 署名行：始终渲染（不随「页脚统计」模块开关），紧跟 stats 时收紧间距 */
.attribution{margin-top:34px;text-align:center;font-size:11px;color:var(--text-dim);opacity:.85;letter-spacing:.06em}
.stats + .attribution{margin-top:10px}
.attribution a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.attribution a:hover{color:var(--accent)}

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
/* 用 grid 而不是 flex：.wrap 的直接子元素除了 .hero / .mods 之外还有 .stats、
   .attribution 两个 <footer>（DOM 是共用的，改不了顺序）。用 flex 时这四个会挤在
   同一行里互相压缩，模块区被压成几像素宽 —— 必须显式分列分格。 */
body.layout-side .wrap{max-width:820px;display:grid;
  grid-template-columns:250px minmax(0,1fr);column-gap:44px;align-items:start}
body.layout-side .hero{grid-column:1;grid-row:1/span 3;
  position:sticky;top:28px;align-items:flex-start;text-align:left}
body.layout-side .mods{grid-column:2;grid-row:1;min-width:0;margin-top:4px}
/* 页脚两行跟在模块列下面，不再横跨整页、也不参与左栏 */
body.layout-side .stats{grid-column:2;grid-row:2}
body.layout-side .attribution{grid-column:2;grid-row:3}
body.layout-side .status-pill{margin-top:12px}
@media(max-width:640px){
  body.layout-side .wrap{grid-template-columns:minmax(0,1fr);column-gap:0;row-gap:26px}
  body.layout-side .hero{grid-column:1;grid-row:auto;position:static;align-items:center;text-align:center}
  body.layout-side .mods,body.layout-side .stats,body.layout-side .attribution{grid-column:1;grid-row:auto}
}`,
  split: `
body.layout-split{justify-content:safe flex-end;padding-bottom:8vh;padding-top:48px}
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
/* 宽内容模块跨满整行：音乐卡是「封面 + 标题 + 进度条」的横排条，半宽会挤掉标题和时间，
   且只有它一个模块时孤零零占左半边，很不对称 —— 所以和图片墙/大事记/联系方式一样跨列。 */
body.layout-bento .mod-gallery,body.layout-bento .mod-timeline,body.layout-bento .mod-links,body.layout-bento .mod-music{grid-column:1/-1}
/* 用户显式设过宽度时以用户为准，覆盖上面按模块类型写死的名单。
   必须放在名单**之后**：同 specificity 时后者胜。
   ⚠️ 但下面那条 :only-child 兜底 specificity 更高，会压过这里 —— 这是故意的：
   「只有一个模块却只占半宽」比「用户想设半宽」更突兀，那种情况一律铺满整行。 */
body.layout-bento .mod[data-size="half"]{grid-column:span 1}
body.layout-bento .mod[data-size="full"]{grid-column:1/-1}
/* 兜底：任何模块单独存在时都铺满整行，避免「只有一个小卡却只占半宽」的突兀感 */
body.layout-bento .mods>.mod:only-child{grid-column:1/-1}
body.layout-bento .stats{grid-column:1/-1;margin-top:8px}
body.layout-bento .attribution{grid-column:1/-1;margin-top:8px}
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
body.layout-banner .attribution{padding:0 30px}
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

/**
 * 自动缩放 JS：内容超出视口时把 .wrap 整体缩小到刚好放下。
 *
 * 为什么在客户端算而不是服务端：
 *   视口高度只有浏览器知道（手机 667 / 桌面 1080 差一倍），服务端渲染时
 *   无法确定该缩多少。故把「模式 + 两个比例」注入页面，由 JS 现场量高度。
 *
 * 算法（一次算完，不做迭代）：
 *   1. 先把 --pz 归一到 1，再读 .wrap 的 offsetHeight 作为「自然高度」。
 *   2. 可用高度 = 视口高 - 上下内边距；比例 = 可用 / 自然高。
 *   3. 夹到 [scaleMin, scaleManual]：auto 模式**只缩不放**，
 *      内容不长时算出来 ≥ scaleManual，取 scaleManual 即观感与不缩放一致。
 *
 * ⚠️ 第 1 步的「先归一到 1」是**必须**的，不是保险（2026-10-01 站长反馈
 * 「名片切紫金主题时预览疯狂抽动」的根因就在这里）。
 *
 * 原先的写法是「在当前缩放值下直接量 offsetHeight」，理由是「zoom 不影响
 * offsetHeight」——对固定高度的块成立，但**对文字不成立**：zoom 会改变元素的
 * 实际盒宽，进而改变换行数，offsetHeight 随之变化。于是「量高度 → 算比例 →
 * 写回 --pz → 高度又变 → 再量」构成反馈回路。实测在内容刚好放不下时会进入
 * 稳定的两点振荡：--pz 在 0.998 与 1 之间永久来回跳，肉眼就是整个预览持续抽动。
 * 归一到 1 再量，得到的是与当前缩放无关的定值，一次算完必然收敛。
 *
 * 触发时机：load / resize / 字体加载完成后（字体换了行高会变）。
 * 用 ResizeObserver 监听 .wrap 自身的自然高度变化（如图片加载完），
 * 只在「高度真的变了」时重算。测量过程归零后立刻复位，净尺寸变化为 0，
 * 所以观察者回调不会再次触发自己。
 */
function autoscaleJs(mode: string, minPct: number, manualPct: number): string {
  const cfg = JSON.stringify({
    mode,
    min: minPct / 100,
    manual: manualPct / 100,
  }).replace(/</g, "\\u003c")
  return `(function(){
    var cfg=${cfg};
    var wrap=document.querySelector('.wrap');
    if(!wrap)return;
    var lastNatural=-1;

    /* 量「自然高度」。必须先归一到 1，否则量到的值会随当前缩放变化，
       与 apply() 构成反馈回路（见函数注释里的振荡说明）。归零后立刻复位
       原值，净尺寸变化为 0，因此不会触发下面的 ResizeObserver 再回调。 */
    function naturalHeight(){
      var prev=wrap.style.getPropertyValue('--pz');
      wrap.style.setProperty('--pz','1');
      var h=wrap.offsetHeight;
      if(prev)wrap.style.setProperty('--pz',prev);else wrap.style.removeProperty('--pz');
      return h;
    }

    function apply(){
      var natural=naturalHeight();
      if(!natural)return;
      lastNatural=natural;
      if(cfg.mode!=='auto'){wrap.style.setProperty('--pz',cfg.manual);return;}
      var cs=getComputedStyle(document.body);
      var avail=window.innerHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom);
      /* 页面底部还可能有横向滚动条等占位，留 2px 余量避免「差一点」又出滚动条 */
      var ratio=avail>0?Math.min(cfg.manual,(avail-2)/natural):cfg.manual;
      if(ratio>cfg.manual)ratio=cfg.manual;
      if(ratio<cfg.min)ratio=cfg.min;
      wrap.style.setProperty('--pz',String(Math.round(ratio*1000)/1000));
    }
    apply();
    addEventListener('resize',apply,{passive:true});
    /* 字体/图片加载完高度会变，重算一次（这两个事件都只触发有限次） */
    addEventListener('load',apply);
    if(document.fonts&&document.fonts.ready)document.fonts.ready.then(apply);
    /* 只监听自然高度变化（图片加载完、字体换行数变化）。容差 1px 挡掉
       子像素噪声，避免反复重算。 */
    if(window.ResizeObserver){
      new ResizeObserver(function(){
        var h=naturalHeight();
        if(Math.abs(h-lastNatural)>1)apply();
      }).observe(wrap);
    }
  })();`
}

/**
 * 解析 LRC 歌词文本。
 *
 * 在**服务端**解析而不是丢给浏览器，有三个好处：
 *   1. 前端 JS 只需比较 `data-t` 与 currentTime，不用带一个解析器；
 *   2. 歌词文本走统一的 `esc()` 转义，不会出现「歌词里带 HTML 就注入」的口子；
 *   3. 解析失败（用户手填的纯文本歌词）在渲染时就决定了降级方案。
 *
 * 时间标签支持 `[mm:ss]`、`[mm:ss.xx]`、`[mm:ss.xxx]`；
 * 一行多个标签（`[00:12.34][01:20.00]歌词`）会展开成多条 —— 这是 LRC 的合法写法，
 * 常见于副歌复用。
 *
 * `[ti:...]` `[ar:...]` `[by:...]` 这类元信息标签不会命中（要求标签内是数字开头）。
 */
function parseLrc(raw: string): { time: number; text: string }[] {
  const out: { time: number; text: string }[] = []
  for (const line of raw.split(/\r\n|\r|\n/)) {
    const stamps = line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)
    const found: number[] = []
    for (const m of stamps) {
      const minute = Number(m[1])
      const second = Number(m[2])
      if (!Number.isFinite(minute) || !Number.isFinite(second)) continue
      const fracRaw = m[3] ?? ""
      // 两位是百分秒（.52），三位是毫秒（.520）—— 差一个数量级，必须分开算
      const frac =
        fracRaw.length === 3
          ? Number(fracRaw) / 1000
          : fracRaw.length > 0
            ? Number(fracRaw) / 100
            : 0
      found.push(minute * 60 + second + frac)
    }
    if (found.length === 0) continue
    const text = line.replace(/\[[^\]]*\]/g, "").trim()
    if (!text) continue
    for (const time of found) out.push({ time, text })
  }
  return out.sort((a, b) => a.time - b.time)
}

/**
 * 歌词面板 HTML。
 *
 * 两种形态：
 *   - 带时间轴 → 每行一个 `.lrc-line[data-t]`，由客户端 JS 做高亮 + 滚动
 *   - 没有时间轴（用户手填的纯文本）→ 静态展示，不参与同步，也不报错
 *
 * `data-t` 固定用 toFixed(2)：避免浮点数的长尾（`12.340000000000002`）浪费字节，
 * 也避免前端 parseFloat 时出现意外的精度差。
 */
function lyricsBlock(lyrics: string | null): string {
  const raw = (lyrics ?? "").trim()
  if (!raw) return ""

  const timed = parseLrc(raw)
  if (timed.length === 0) {
    return `<div class="lyrics lyrics-plain" id="plyrics"><div class="lrc-inner">${escMultiline(raw)}</div></div>`
  }

  const lines = timed
    .map((l) => `<div class="lrc-line" data-t="${l.time.toFixed(2)}">${esc(l.text)}</div>`)
    .join("")
  return `<div class="lyrics" id="plyrics"><div class="lrc-inner">${lines}</div></div>`
}

/** 背景音乐播放器 JS：播放/暂停 + 进度条 + 时间显示 + 点击跳转 + 歌词同步。 */
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

    /* ---- 歌词同步 ---- */
    var lyr=document.getElementById('plyrics');
    var rows=lyr?[].slice.call(lyr.querySelectorAll('.lrc-line')):[];
    var times=rows.map(function(el){return parseFloat(el.getAttribute('data-t'))||0});
    var idx=-2;
    /* 只展示「当前行 + 下一行」：给当前行加 .on，下一行加 .pre，其余靠 CSS 的 opacity:0 藏起。
       用 CSS transform 定位两行（而不是滚动容器），所以不需要滚动条与防抢滚动。
       ⚠️ idx 初值必须是 -2，不能是 -1：歌曲开头（还没唱到第一句）算出的 i 就是 -1，
       若初值也是 -1，首次 syncLyrics 会命中 i===idx 直接 return，一个 class 都不打
       ⇒ 歌词框一片空白。 */
    function syncLyrics(){
      if(!rows.length)return;
      var t=audio.currentTime||0,i=-1;
      /* 容忍 0.15s 提前量：歌词一般标在这句开始唱的时刻，零延迟切换会显得晚半拍 */
      for(var k=0;k<times.length;k++){if(times[k]<=t+0.15)i=k;else break}
      if(i===idx)return;
      /* i<0 = 还没唱到第一句：当前行留空，把第一句当「下一行」先亮出来，否则框是空的 */
      var cur=i, nxt=(i<rows.length-1)?i+1:-1;
      for(var r=0;r<rows.length;r++){
        rows[r].classList.toggle('on', r===cur);
        rows[r].classList.toggle('pre', r===nxt);
      }
      idx=i;
    }

    function update(){
      if(!fill)return;
      var cur=audio.currentTime||0,dur=audio.duration||0;
      fill.style.width=(dur>0?(cur/dur*100):0)+'%';
      if(time)time.textContent=fmt(cur)+(dur>0?' / '+fmt(dur):'');
      syncLyrics();
    }
    audio.addEventListener('timeupdate',update);
    audio.addEventListener('loadedmetadata',update);
    audio.addEventListener('seeked',syncLyrics);
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

/**
 * 给模块的 `<section>` 补上 `data-size`（只在显式设过宽度时输出）。
 *
 * 刻意放在外层而不是逐个改 renderModule 的 6 个 return —— 那样要改 6 处，
 * 将来加新模块极易漏。找不到目标串就原样返回（music 无音频源时会返回空串）。
 */
function withSize(html: string, m: ProfileModule): string {
  if (!m.size) return html
  return html.replace('<section class="mod', `<section data-size="${m.size}" class="mod`)
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
      ${lyricsBlock(p.musicLyrics)}
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
  // UID：按注册顺序的编号，不足三位补零（001）；超过 999 就显示实际位数
  const uidText = p.uid != null ? `#${String(p.uid).padStart(3, "0")}` : null
  const metaParts: string[] = []
  if (uidText) metaParts.push(`UID ${uidText}`)
  if (regDate) metaParts.push(`加入于 ${regDate}`)
  metaParts.push(`${p.viewCount} 次访问`)
  const statsLine = mods.stats
    ? `<footer class="stats">${esc(metaParts.join(" · "))}</footer>`
    : ""

  // 署名行：品牌标识，**始终渲染**（不随「页脚统计」模块开关，跟统计小字另起一行）
  const attributionLine = `<footer class="attribution">来源于 <a href="https://cloud.doulor.cn/" target="_blank" rel="noopener noreferrer">Doulor Cloud</a></footer>`

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

  const modsHtml = mods.middle.map((m) => withSize(renderModule(m, p), m)).join("")

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
    introJs(intro, name) +
    autoscaleJs(
      p.scaleMode ?? "auto",
      p.scaleMin ?? 50,
      p.scaleManual ?? 100
    )

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
  ${attributionLine}
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
