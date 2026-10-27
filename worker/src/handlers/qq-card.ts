/**
 * QQ 卡片渲染（纯云端，2026-10-26）。
 *
 * 为什么不再用服务器渲染：站长要求「完全不需要服务器的渲染」。
 * Worker 已绑定 Browser Rendering（env.BROWSER，见 handlers/lab-shot.ts），
 * 直接把 HTML 丢给 `quickAction("screenshot")` 就能出 PNG，
 * 再由 qq.ts 用富媒体接口发到群里 —— 全程只在 Cloudflare 上，零容器。
 *
 * 视觉参考 reactbits 那套：暗色极光渐变底 + 玻璃拟态卡 + 渐变字标题 + 胶囊徽章。
 *
 * 注意：浏览器渲染有每日时长限制（免费档约 10 分钟/天）。
 * 失败时调用方必须降级成文本，不能让指令整体失败。
 */

import type { Env } from "../env"

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{
  width:820px;font-family:"Noto Sans CJK SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  background:#07070a;color:#e9ecf3;padding:22px;
  background-image:
    radial-gradient(60% 55% at 12% 8%, rgba(99,102,241,.32), transparent 62%),
    radial-gradient(55% 50% at 88% 4%, rgba(45,212,191,.22), transparent 60%),
    radial-gradient(70% 60% at 70% 96%, rgba(236,72,153,.18), transparent 65%);
}
.wrap{border-radius:22px;padding:22px;background:rgba(255,255,255,.045);
  border:1px solid rgba(255,255,255,.10);
  box-shadow:0 24px 60px -20px rgba(0,0,0,.9), inset 0 1px 0 rgba(255,255,255,.06)}
.head{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:18px}
h1{font-size:26px;font-weight:800;letter-spacing:-.4px;
   background:linear-gradient(94deg,#fff 8%,#a5b4fc 52%,#5eead4 96%);
   -webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-size:12.5px;color:#8b93a7;font-variant-numeric:tabular-nums}
.row{display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:8px;
     border-radius:14px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.075)}
.row:last-child{margin-bottom:0}
.dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.ok{background:#34d399;box-shadow:0 0 12px 1px rgba(52,211,153,.85)}
.bad{background:#f87171;box-shadow:0 0 12px 1px rgba(248,113,113,.85)}
.unk{background:#4b5563}
.name{font-size:15px;font-weight:600}
.detail{font-size:12.5px;color:#8b93a7;margin-left:auto}
.ms{font-size:12.5px;color:#c7cede;font-family:ui-monospace,monospace;min-width:62px;text-align:right}
.body{flex:1;min-width:0}
.title{font-size:15.5px;font-weight:650}
.meta{font-size:12.5px;color:#8b93a7;margin-top:3px}
.pill{font-size:11.5px;font-weight:600;padding:4px 11px;border-radius:999px;white-space:nowrap}
.p-blue{background:rgba(96,165,250,.14);color:#93c5fd;border:1px solid rgba(96,165,250,.35)}
.p-green{background:rgba(52,211,153,.14);color:#6ee7b7;border:1px solid rgba(52,211,153,.35)}
.p-red{background:rgba(248,113,113,.14);color:#fca5a5;border:1px solid rgba(248,113,113,.35)}
.idx{font-family:ui-monospace,monospace;font-size:12px;color:#6b7280;min-width:26px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.mrow{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;
  background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.075)}
.mname{font-size:13.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mms{font-size:11.5px;color:#8b93a7;font-family:ui-monospace,monospace;margin-left:auto}
.foot{margin-top:16px;font-size:11.5px;color:#6b7280;display:flex;justify-content:space-between}
`;

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export type ProbeRow = { name: string; ok: boolean; detail?: string; ms?: number };
export type WoolRow = { seq: number; title: string; meta?: string; status: string };

export function statusHtml(rows: ProbeRow[], time: string, footer = ""): string {
  const body = rows
    .map((r) => {
      const ms = r.ms ? `${r.ms} ms` : "—";
      return `<div class="row"><span class="dot ${r.ok ? "ok" : "bad"}"></span>
        <span class="name">${esc(r.name)}</span>
        <span class="detail">${esc(r.detail || "")}</span>
        <span class="ms">${esc(ms)}</span></div>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div class="wrap"><div class="head">
  <div><h1>服务状态</h1><div class="sub" style="margin-top:6px">${esc(time)}</div></div>
  <div class="sub">Doulor Cloud</div></div>
  ${body}
  <div class="foot"><span>${esc(footer)}</span><span>每 2 分钟自动探测</span></div>
</div>`;
}

export function woolHtml(rows: WoolRow[], time: string, footer = ""): string {
  const body = rows
    .map((r) => {
      const cls = r.status === "已领" ? "p-green" : r.status === "已过期" ? "p-red" : "p-blue";
      return `<div class="row"><span class="idx">#${r.seq}</span>
        <div class="body"><div class="title">${esc(r.title)}</div>
        <div class="meta">${esc(r.meta || "")}</div></div>
        <span class="pill ${cls}">${esc(r.status)}</span></div>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div class="wrap"><div class="head">
  <div><h1>羊毛清单</h1><div class="sub" style="margin-top:6px">${esc(time)}</div></div>
  <div class="sub">Doulor Cloud</div></div>
  ${body}
  <div class="foot"><span>${esc(footer)}</span><span>共 ${rows.length} 条</span></div>
</div>`;
}

/**
 * 交给 Cloudflare 浏览器渲染出 PNG。失败返回 null（调用方降级成文本）。
 *
 * 用两次 viewport 高度不行 —— quickAction 支持 fullPage，交给它自己算高度，
 * 避免像自建服务那样把内容裁断。
 */
export async function shotHtml(env: Env, html: string): Promise<Uint8Array | null> {
  if (!env.BROWSER) return null;
  try {
    const res = await env.BROWSER.quickAction("screenshot", {
      html,
      viewport: { width: 864, height: 600 },
      // JPEG 比 PNG 小一个数量级：PNG 187KB 在 Worker 里做 base64 会顶到 CPU 上限
      screenshotOptions: { type: "jpeg", quality: 78, fullPage: true } as Record<string, unknown>,
      gotoOptions: { waitUntil: "networkidle0", timeout: 15000 },
    } as Record<string, unknown>)
    if (!res || !res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    return null
  }
}

export type ModelRow = { model: string; ok: boolean; ms?: number; detail?: string; unknown?: boolean }

/** 模型状态长图：两列排布，一次能放几十个模型 */
export function modelsHtml(rows: ModelRow[], time: string): string {
  const known = rows.filter((r) => !r.unknown)
  const okN = known.filter((r) => r.ok).length
  const body = rows
    .map((r) => {
      const ms = r.unknown ? "待探测" : r.ms ? `${r.ms}ms` : ""
      const cls = r.unknown ? "unk" : r.ok ? "ok" : "bad"
      return `<div class="mrow"><span class="dot ${cls}"></span>
        <span class="mname">${esc(r.model)}</span><span class="mms">${esc(ms)}</span></div>`
    })
    .join("")
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div class="wrap"><div class="head">
  <div><h1>模型状态</h1><div class="sub" style="margin-top:6px">${esc(time)}</div></div>
  <div class="sub">可用 ${okN} / ${known.length}${known.length < rows.length ? `（待探 ${rows.length - known.length}）` : ""}</div></div>
  <div class="grid">${body}</div>
  <div class="foot"><span>仅列出已启用渠道的模型（不含 donation）</span><span>10 分钟刷新</span></div>
</div>`
}
