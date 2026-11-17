import * as React from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { fmtTime } from "@/lib/format"
import { useFeatures } from "@/hooks/use-features"

/**
 * 捐献小浣熊账号（站内页面，2026-10-26 重构）。
 *
 * 为什么不能在站内直接内嵌登录（像 wb2api 那样）：
 *   小浣熊官方授权页只接受 loopback 回调（http://localhost:端口），
 *   服务器侧拿不到 code，任何公网域名都会报「授权链接无效」。
 *   但它的 `xhx_token` 不是 httpOnly，浏览器脚本可以读 ——
 *   所以走「一次性捐献码 + 书签小工具」：用户在本页拿到码，
 *   在已登录的小浣熊页面点一下书签，脚本把 token 连同码提交回来。
 *
 * 每次生成码都会重新构造书签；码 24 小时有效、一次性（2026-10-27 从 10 分钟上调）。
 */

type DonationRow = {
  id: string
  account_id?: string
  account_name?: string
  token_expires_at?: number
  created_at?: number
}

function buildBookmarklet(code: string): string {
  // 注意：不要在这里用正则取 cookie —— 书签要经过多层转义，反斜杠极易被吃掉。
  // 2026-10-27：点击后**先**弹一个浮层说「处理中」，再发请求 —— 捐献要走
  // Worker → 入池网关 → 面板，真实耗时 5~20 秒，原来期间页面上毫无反应，用户以为没点上。
  const script =
    "(async()=>{try{" +
    "const H=location.hostname;" +
    "if(!/(^|\\.)xiaohuanxiong\\.com$/.test(H)){return alert('这个书签要在小浣熊页面上点。\\n当前页面是：'+H);}" +
    "const parts=('; '+document.cookie).split('; xhx_token=');" +
    "const t=parts.length>1?parts[1].split(';')[0]:'';" +
    "if(!t){return alert('没有读到小浣熊登录状态。\\n当前页面：'+H+'\\n请确认在这个浏览器里登录过 xiaohuanxiong.com');}" +
    "const box=document.createElement('div');" +
    "box.style.cssText='position:fixed;z-index:2147483647;left:50%;top:24px;transform:translateX(-50%);background:#111;color:#fff;padding:16px 22px;border-radius:12px;font:14px/1.7 system-ui,-apple-system,sans-serif;box-shadow:0 10px 34px rgba(0,0,0,.4);max-width:92vw;text-align:center';" +
    "box.textContent='⏳ 正在处理捐献，请稍等…（通常 5~20 秒，请不要关闭本页面）';" +
    "document.body.appendChild(box);" +
    "const done=(ok,text,url)=>{box.textContent='';box.style.background=ok?'#0f7b3f':'#8a1f1f';box.textContent=text;if(url){const a=document.createElement('a');a.href=url;a.target='_blank';a.textContent='\\n→ 回到 Doulor Cloud 查看捐献记录';a.style.cssText='display:block;margin-top:8px;color:#9ecbff;text-decoration:underline';box.appendChild(a);}setTimeout(()=>box.remove(),ok?20000:25000);};" +
    "const r=await fetch('https://cloud.doulor.cn/api/donations/raccoon/claim',{method:'POST'," +
    "headers:{'content-type':'text/plain;charset=UTF-8'}," +
    "body:JSON.stringify({code:'" + code + "',accessToken:t})});" +
    "const j=await r.json();" +
    "if(j.ok){done(true,'✅ 捐献成功！账号已加入 Doulor 号池'+(j.duplicate?'（这个号之前就在池子里）':'')+'\\n每日额度会在 1 分钟内生效','https://cloud.doulor.cn/dashboard/donations/raccoon');}" +
    "else{done(false,'❌ 失败：'+(j.reason==='code_invalid'?'捐献码已失效（旧书签里的码用过或过期）——请回捐献页重新生成，并把新书签重新拖到书签栏':(j.detail||j.reason||'未知错误')),'https://cloud.doulor.cn/dashboard/donations/raccoon');}" +
    "}catch(e){const b=document.createElement('div');b.style.cssText='position:fixed;z-index:2147483647;left:50%;top:24px;transform:translateX(-50%);background:#8a1f1f;color:#fff;padding:16px 22px;border-radius:12px;font:14px/1.7 system-ui,sans-serif;max-width:92vw;text-align:center';b.textContent='❌ 出错了：'+e.message+'（可能是网络问题，请重试）';document.body.appendChild(b);setTimeout(()=>b.remove(),20000);}});";
  return "javascript:" + script
}

/**
 * 「只取 token」书签（2026-10-27 新增的兜底路径）。
 *
 * 为什么需要：一键捐献书签要跨域 POST，可能被 CORS / CSP / 网关故障挡住，
 * 而用户看到的只是一句技术错误，无法自救。这个书签只读 cookie、把 token 复制到
 * 剪贴板（或弹框让他手动复制），零网络依赖 —— 出任何问题用户都能自己看清楚。
 *
 * ⚠️ 注意不能用 copy()：那是 DevTools Console 专用函数，书签环境里不存在。
 */
function buildTokenBookmarklet(): string {
  const script =
    "(()=>{" +
    "const p=('; '+document.cookie).split('; xhx_token=');" +
    "const t=p.length>1?p[1].split(';')[0]:'';" +
    "if(!t){alert('没读到 xhx_token：可能未登录，或它是 HttpOnly，JS 读不到');return;}" +
    "(navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(t):Promise.reject())" +
    ".then(()=>alert('已复制 xhx_token，回捐献页粘贴提交'))" +
    ".catch(()=>prompt('手动复制这段：',t));" +
    "})();"
  return "javascript:" + script
}

export default function DonateRaccoonPage() {
  /** 功能开关：捐献关掉后停掉 8s 轮询（每次 1 请求 + 1 查询） */
  const { isOn } = useFeatures()
  const donationsOn = isOn("donations")
  const [code, setCode] = React.useState("")
  const [expiresIn, setExpiresIn] = React.useState(0)
  const [generating, setGenerating] = React.useState(false)
  const [rows, setRows] = React.useState<DonationRow[] | null>(null)
  const [manual, setManual] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [importing, setImporting] = React.useState(false)

  const bookmarklet = React.useMemo(() => (code ? buildBookmarklet(code) : ""), [code])

  /**
   * ⚠️ React 19 会把 `href="javascript:…"` 直接拦掉，换成
   * `javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')`
   * —— 用户拖到书签栏的就是这句报错，等于书签彻底不能用。
   * 所以必须绕开 React 的属性处理，用原生 setAttribute 设 href。
   */
  const bmRef = React.useRef<HTMLAnchorElement>(null)
  const bmTokenRef = React.useRef<HTMLAnchorElement>(null)

  React.useEffect(() => {
    if (bmRef.current) {
      if (bookmarklet) bmRef.current.setAttribute("href", bookmarklet)
      else bmRef.current.removeAttribute("href")
    }
  }, [bookmarklet])

  React.useEffect(() => {
    if (bmTokenRef.current) bmTokenRef.current.setAttribute("href", buildTokenBookmarklet())
  }, [])

  const loadMine = React.useCallback(async () => {
    try {
      const r = await fetch("/api/donations/raccoon/mine", { credentials: "include" })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = (await r.json()) as { donations?: DonationRow[] }
      const next = d.donations ?? []
      if (!firstLoadRef.current) {
        const fresh = next.find((n) => !rowsRef.current.some((o) => o.id === n.id))
        if (next.length > rowsRef.current.length && fresh) {
          setSuccessInfo({ name: fresh.account_name || "新账号" })
          toast.success("捐献成功！")
        }
      }
      firstLoadRef.current = false
      rowsRef.current = next
      setRows(next)
    } catch {
      setRows([])
    }
  }, [])

  /**
   * 捐献完成后回到本站要**看得见**地告诉他成功（2026-10-27 站长要求）。
   *
   * 捐献是在小浣熊页面点书签完成的，本站无法直接收到结果 —— 所以这里：
   *   · 每 8 秒（仅页面可见时）拉一次「我的捐献」，并监听 focus/visibilitychange；
   *   · 发现记录数变多 → 顶部显示显眼的绿色成功横幅（含账号名与额度变化）。
   */
  const [successInfo, setSuccessInfo] = React.useState<{ name: string } | null>(null)
  const rowsRef = React.useRef<DonationRow[]>([])
  const firstLoadRef = React.useRef(true)

  React.useEffect(() => {
    void loadMine()
  }, [loadMine, donationsOn])

  React.useEffect(() => {
    if (!donationsOn) return
    const tick = () => {
      if (document.visibilityState === "visible") void loadMine()
    }
    const id = window.setInterval(tick, 8000)
    document.addEventListener("visibilitychange", tick)
    window.addEventListener("focus", tick)
    return () => {
      window.clearInterval(id)
      document.removeEventListener("visibilitychange", tick)
      window.removeEventListener("focus", tick)
    }
  }, [loadMine])

  const generate = async (): Promise<string | null> => {
    setGenerating(true)
    try {
      const r = await fetch("/api/donations/raccoon/code", { method: "POST", credentials: "include" })
      const d = (await r.json()) as { code?: string; expiresIn?: number; message?: string }
      if (!r.ok || !d.code) throw new Error(d.message || "生成失败")
      setCode(d.code)
      setExpiresIn(d.expiresIn ?? 600)
      toast.success("书签已生成，24 小时内有效")
      return d.code
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "生成失败")
      return null
    } finally {
      setGenerating(false)
    }
  }

  const copyBookmarklet = async () => {
    if (!bookmarklet) return
    try {
      await navigator.clipboard.writeText(bookmarklet)
      toast.success("书签代码已复制")
    } catch {
      toast.error("复制失败，请直接拖拽按钮到收藏夹栏")
    }
  }

  const copyTokenBookmarklet = async () => {
    try {
      await navigator.clipboard.writeText(buildTokenBookmarklet())
      toast.success("已复制「只取 token」书签代码")
    } catch {
      toast.error("复制失败，请直接拖拽按钮")
    }
  }

  const submitManual = async () => {
    const token = manual.trim()
    if (!token) {
      toast.error("先粘贴 xhx_token")
      return
    }
    // 没有码就顺手生成一个（用户可能只用「只取 token」书签，没点过生成）
    const useCode = code || (await generate())
    if (!useCode) return
    setSubmitting(true)
    try {
      const r = await fetch("/api/donations/raccoon/claim", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: useCode, accessToken: token }),
      })
      const d = (await r.json()) as { ok?: boolean; detail?: string; reason?: string; duplicate?: boolean }
      if (d.ok) {
        toast.success(d.duplicate ? "该号已在池中，记录已更新" : "捐献成功，已加入号池")
        setManual("")
        await loadMine()
      } else {
        toast.error(d.detail || d.reason || "捐献失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "提交失败")
    } finally {
      setSubmitting(false)
    }
  }

  /**
   * 批量导入：在浏览器里先解析 JSON 再发，服务端只收归一化后的数组。
   * 这样错误能立刻在本地暴露（文件不是 JSON、结构不对），不用等服务端往返。
   */
  const importJson = async (file: File) => {
    setImporting(true)
    try {
      const text = await file.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        toast.error("文件不是合法 JSON")
        return
      }
      const accounts = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { accounts?: unknown[] })?.accounts)
          ? (parsed as { accounts: unknown[] }).accounts
          : []
      if (!accounts.length) {
        toast.error("JSON 里没找到账号（需要数组或 {accounts:[...]}）")
        return
      }
      const r = await fetch("/api/donations/raccoon/import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accounts }),
      })
      const d = (await r.json()) as {
        ok?: boolean
        added?: number
        duplicate?: number
        failed?: number
        skipped?: number
        errors?: { name?: string; detail?: string }[]
        detail?: string
        reason?: string
        granted?: string
      }
      if (d.ok) {
        const bits = [`新增 ${d.added ?? 0}`]
        if (d.duplicate) bits.push(`重复 ${d.duplicate}`)
        if (d.failed) bits.push(`失败 ${d.failed}`)
        if (d.skipped) bits.push(`跳过 ${d.skipped}`)
        toast.success(`导入完成：${bits.join(" · ")}`)
        const first = d.errors?.[0]
        if (first?.detail) toast.message(`${first.name ?? "有账号"}导入失败：${first.detail}`)
        await loadMine()
      } else {
        toast.error(d.detail || d.reason || "导入失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "导入失败")
    } finally {
      setImporting(false)
    }
  }

  const list = rows ?? []
  const alive = list.filter((x) => !x.token_expires_at || x.token_expires_at > Date.now()).length

  return (
    <div className="space-y-6">
      <PageHeader
        title="捐献小浣熊账号"
        description="把账号的闲置额度接入号池，立刻可用。凭据由号池自动续期，随时可在小浣熊网页端退出登录撤销。"
      />

      {successInfo ? (

        <div className="rounded-lg border-2 border-emerald-500/60 bg-emerald-500/10 p-4">

          <div className="flex items-start justify-between gap-3">

            <div className="space-y-1">

              <p className="text-base font-semibold text-emerald-700 dark:text-emerald-400">

                ✅ 捐献成功！

              </p>

              <p className="text-sm">

                账号「{successInfo.name}」已加入 Doulor 号池，每日免费额度将在 1 分钟内自动生效

                （小浣熊每个账号 ¥200/天）。账号若被上游封禁，额度会自动收回并在这里提醒你重新登录。

              </p>

            </div>

            <Button size="sm" variant="outline" onClick={() => setSuccessInfo(null)}>

              知道了

            </Button>

          </div>

        </div>

      ) : null}


      <Card>
        <CardHeader>
          <CardTitle className="text-base">捐献步骤</CardTitle>
          <CardDescription>只需要做一次；生成的码 24 小时内有效、一次性。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex gap-3">
            <Badge className="h-6 shrink-0">1</Badge>
            <div className="space-y-2">
              <div className="text-sm font-medium">生成捐献书签</div>
              <p className="text-sm text-muted-foreground">
                点下面的按钮，会生成一个只属于你的一次性书签。
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void generate()} disabled={generating}>
                  {generating ? "生成中…" : code ? "重新生成书签" : "生成捐献书签"}
                </Button>
                {code ? (
                  <>
                    <a ref={bmRef} className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent">
                      🦝 捐献小浣熊
                    </a>
                    <Button variant="outline" onClick={() => void copyBookmarklet()}>
                      复制书签代码
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {/* 后端 TTL 是 24 小时（2026-10-27 从 600 秒改的）。这里按秒换算，
                          否则同一屏会出现「24 小时」和「1440 分钟」两个说法。 */}
                      有效期{" "}
                      {expiresIn >= 3600
                        ? `${Math.round(expiresIn / 3600)} 小时`
                        : `${Math.round(expiresIn / 60)} 分钟`}
                    </span>
                  </>
                ) : null}
              </div>
              {code ? (
                <p className="text-xs text-muted-foreground">
                  把这个「🦝 捐献小浣熊」拖到浏览器收藏夹栏；拖不动就点「复制书签代码」，
                  再 Ctrl+D 新建收藏、把内容粘到「网址」栏（前缀被吃掉就手动补 <code>java</code>）。
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex gap-3">
            <Badge className="h-6 shrink-0">2</Badge>
            <div className="space-y-2">
              <div className="text-sm font-medium">在小浣熊页面点它</div>
              <p className="text-sm text-muted-foreground">
                打开
                <a href="https://xiaohuanxiong.com/work" target="_blank" rel="noreferrer" className="mx-1 text-primary underline">
                  xiaohuanxiong.com
                </a>
                并保持登录，然后在收藏夹栏点「🦝 捐献小浣熊」，看到「捐献成功」即可。
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <Badge variant="secondary" className="h-6 shrink-0">!</Badge>
            <div className="space-y-1">
              <div className="text-sm font-medium">目前只支持电脑端捐献</div>
              <p className="text-sm text-muted-foreground">
                手机浏览器没有收藏夹栏，无法使用捐献书签。请用电脑登录同一个小浣熊账号完成捐献；
                捐完之后手机上照样可以直接使用号池的模型。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">备用方案：只取 token 手动提交</CardTitle>
          <CardDescription>
            一键捐献失败时（跨域被拦 / 网关故障 / 码过期）用这条路：只读 cookie、不联网，
            因此不会失败。拿到 token 后回本页粘贴提交，码会自动补一个。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <a
              ref={bmTokenRef}
              className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"
            >
              📋 只取 token
            </a>
            <Button variant="outline" size="sm" onClick={() => void copyTokenBookmarklet()}>
              复制这段书签代码
            </Button>
            <span className="text-xs text-muted-foreground">
              拖到收藏夹栏，在小浣熊页面点它 → token 进剪贴板
            </span>
          </div>
          <Textarea
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="粘贴 xhx_token 的值（形如 eyJhbGciOi…）"
            className="min-h-[80px] font-mono text-xs"
          />
          {/* 不要加 !code 的禁用：submitManual 里本来就有「没有码就顺手生成一个」的兜底
              （用户可能只用「只取 token」书签、从没点过生成），禁用会把那条路堵死。 */}
          <Button onClick={() => void submitManual()} disabled={submitting}>
            {submitting ? "提交中…" : "提交这个 token"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">批量导入 JSON</CardTitle>
          <CardDescription>
            号多的时候别一个个粘。支持两种格式：
            <code className="mx-1 rounded bg-muted px-1 text-xs">[{`{"name":"账号名","accessToken":"xhx_token 的值"}`}, …]</code>
            或 <code className="mx-1 rounded bg-muted px-1 text-xs">{`{"accounts":[…]}`}</code>；
            只有 <code className="mx-1 rounded bg-muted px-1 text-xs">accessToken</code> 是必填（也认
            <code className="mx-1 rounded bg-muted px-1 text-xs"> token / xhx_token</code>），名字缺省就用你的用户名加序号。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            type="file"
            accept=".json,application/json"
            disabled={importing}
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ""
              if (f) void importJson(f)
            }}
            className="block w-full cursor-pointer rounded-md border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1 file:text-sm"
          />
          {importing ? <div className="text-sm text-muted-foreground">正在入池，号多的话要等一会儿…</div> : null}
          <div className="text-xs text-muted-foreground">单次最多 300 个；每小时最多 6 次。</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">我的捐献记录</CardTitle>
              <CardDescription>
                {list.length > 0 ? `共 ${list.length} 条 · 凭据有效 ${alive} 个` : "还没有捐献记录"}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => void loadMine()}>
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {rows === null ? (
            <LoadingBlock />
          ) : list.length === 0 ? (
            <div className="text-sm text-muted-foreground">完成一次捐献后，这里会显示账号与凭据状态。</div>
          ) : (
            <div className="divide-y rounded-md border">
              {list.map((x) => {
                const expiresMs = x.token_expires_at ?? 0
                const expired = expiresMs > 0 && expiresMs <= Date.now()
                return (
                  <div key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <Badge variant={expired ? "destructive" : "secondary"}>{expired ? "凭据已过期" : "使用中"}</Badge>
                    <span className="font-medium">{x.account_name || "raccoon"}</span>
                    <span className="text-xs text-muted-foreground">
                      捐献于 {x.created_at ? fmtTime(new Date(x.created_at * 1000).toISOString()) : "—"}
                    </span>
                    <span className={`text-xs ${expired ? "text-destructive" : "text-muted-foreground"}`}>
                      {expiresMs ? `凭据到期 ${fmtTime(new Date(expiresMs).toISOString())}` : "凭据到期时间未知"}
                    </span>
                    {x.account_id ? (
                      <span className="text-xs text-muted-foreground">ID {x.account_id}</span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="text-sm text-muted-foreground">
        <Link to="/dashboard/donations" className="text-primary underline">
          ← 返回捐献
        </Link>
      </div>
    </div>
  )
}
