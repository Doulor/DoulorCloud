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
 * 每次生成码都会重新构造书签；码 10 分钟有效、一次性。
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
  const script =
    "(async()=>{try{" +
    "const H=location.hostname;" +
    "if(!/(^|\\.)xiaohuanxiong\\.com$/.test(H)){return alert('这个书签要在小浣熊页面上点。\\n当前页面是：'+H);}" +
    "const parts=('; '+document.cookie).split('; xhx_token=');" +
    "const t=parts.length>1?parts[1].split(';')[0]:'';" +
    "if(!t){return alert('没有读到小浣熊登录状态。\\n当前页面：'+H+'\\n请确认在这个浏览器里登录过 xiaohuanxiong.com');}" +
    "const r=await fetch('https://cloud.doulor.cn/api/donations/raccoon/claim',{method:'POST'," +
    "headers:{'content-type':'text/plain;charset=UTF-8'}," +
    "body:JSON.stringify({code:'" + code + "',accessToken:t})});" +
    "const j=await r.json();" +
    "alert(j.ok?('✅ 捐献成功，已加入 Doulor 号池'+(j.duplicate?'（这个号已经在池子里了）':''))" +
    ":('❌ 失败：'+(j.detail||j.reason||'未知错误')));" +
    "}catch(e){alert('出错了：'+e.message)}})();"
  return "javascript:" + script
}

export default function DonateRaccoonPage() {
  const [code, setCode] = React.useState("")
  const [expiresIn, setExpiresIn] = React.useState(0)
  const [generating, setGenerating] = React.useState(false)
  const [rows, setRows] = React.useState<DonationRow[] | null>(null)
  const [manual, setManual] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [importing, setImporting] = React.useState(false)

  const bookmarklet = React.useMemo(() => (code ? buildBookmarklet(code) : ""), [code])

  const loadMine = React.useCallback(async () => {
    try {
      const r = await fetch("/api/donations/raccoon/mine", { credentials: "include" })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = (await r.json()) as { donations?: DonationRow[] }
      setRows(d.donations ?? [])
    } catch {
      setRows([])
    }
  }, [])

  React.useEffect(() => {
    void loadMine()
  }, [loadMine])

  const generate = async () => {
    setGenerating(true)
    try {
      const r = await fetch("/api/donations/raccoon/code", { method: "POST", credentials: "include" })
      const d = (await r.json()) as { code?: string; expiresIn?: number; message?: string }
      if (!r.ok || !d.code) throw new Error(d.message || "生成失败")
      setCode(d.code)
      setExpiresIn(d.expiresIn ?? 600)
      toast.success("书签已生成，10 分钟内有效")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "生成失败")
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

  const submitManual = async () => {
    const token = manual.trim()
    if (!token) {
      toast.error("先粘贴 xhx_token")
      return
    }
    if (!code) {
      toast.error("请先点上面的「生成捐献书签」")
      return
    }
    setSubmitting(true)
    try {
      const r = await fetch("/api/donations/raccoon/claim", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, accessToken: token }),
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">捐献步骤</CardTitle>
          <CardDescription>只需要做一次；生成的码 10 分钟内有效、一次性。</CardDescription>
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
                    <a href={bookmarklet} className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent">
                      🦝 捐献小浣熊
                    </a>
                    <Button variant="outline" onClick={() => void copyBookmarklet()}>
                      复制书签代码
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      有效期 {Math.round(expiresIn / 60)} 分钟
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
          <CardTitle className="text-base">书签点不动？手动粘贴</CardTitle>
          <CardDescription>
            在小浣熊页面按 F12 → Console，粘贴{" "}
            <code className="rounded bg-muted px-1 text-xs">document.cookie.match(/xhx_token=([^;]+)/)[1]</code>{" "}
            回车，把输出的字符串粘到下面。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="粘贴 xhx_token 的值（形如 eyJhbGciOi…）"
            className="min-h-[80px] font-mono text-xs"
          />
          <Button onClick={() => void submitManual()} disabled={submitting || !code}>
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
                      <span className="text-xs text-muted-foreground/70">ID {x.account_id}</span>
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
