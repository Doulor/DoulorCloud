/**
 * 管理面板「AI 实验室」板块。
 *
 * 管四件事，都是原来散在别处或根本没做过的：
 *   1. **模型来源** —— 各用户自己的中转站额度，还是全站统一用我提供的 Key；
 *   2. **统一 Key** —— 写进去就加密，只回尾号；留空提交 = 不改；
 *   3. **免费渠道** —— 我挂几条渠道，用户端「外部渠道」里能直接选，标「免费使用」；
 *   4. **系统提示词** —— 从「全局设置」页搬过来的（空 = 用内置默认）。
 *
 * ⚠️ 所有密钥类字段都**只写不读**：面板永远拿不到明文，想换就直接粘一把新的。
 * 这不是为了防管理员，而是避免明文在「浏览器 → 日志 → 截图」链路上到处留痕。
 */
import * as React from "react"
import { toast } from "sonner"
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Eye,
  Gift,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { confirmDialog } from "@/components/confirm-dialog"
import {
  adminApi,
  errMsg,
  galleryCoverUrl,
  labApi,
  type AdminLabChannelInput,
  type AdminLabConfig,
  type AdminLabPromptTemplate,
  type AdminLabReview,
} from "@/services/api"
import { buildPreviewDoc, DEFAULT_AGENT_SYSTEM } from "@/lib/lab-agent"
import { cn } from "@/lib/utils"
import { useT } from "@/i18n"

type Source = "user" | "admin"
type QuotaPeriod = "day" | "month" | "total"

const PERIODS: QuotaPeriod[] = ["day", "month", "total"]

/** 一条渠道的草稿件：apiKey 留空 = 沿用已存的密钥 */
interface ChannelDraft extends AdminLabChannelInput {
  /** 服务端是否已存有密钥（面板只用来提示「留空即不改」） */
  hasStoredKey?: boolean
  keyTail?: string
}

export function AdminLabTab() {
  const { t } = useT()

  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [clearing, setClearing] = React.useState(false)

  // —— 草稿状态（全部由 load() 灌进去，save() 整体提交）——
  const [aiSource, setAiSource] = React.useState<Source>("user")
  const [adminKeyInput, setAdminKeyInput] = React.useState("")
  const [hasAdminKey, setHasAdminKey] = React.useState(false)
  const [adminKeyTail, setAdminKeyTail] = React.useState("")
  const [adminUnavailable, setAdminUnavailable] = React.useState(false)
  const [freeQuota, setFreeQuota] = React.useState(0)
  const [freeQuotaPeriod, setFreeQuotaPeriod] = React.useState<QuotaPeriod>("day")
  /** 免费模型白名单；**空数组 = 全部免费** */
  const [freeModels, setFreeModels] = React.useState<string[]>([])
  /** 站内模型白名单；**空数组 = 不过滤**（下拉里显示站内返回的全部模型） */
  const [siteModels, setSiteModels] = React.useState<string[]>([])
  /** 站内白名单独立的搜索词（两张卡的输入框互不干扰） */
  const [siteKeyword, setSiteKeyword] = React.useState("")
  /** 造物集：作品公开前是否需要审核 */
  const [reviewRequired, setReviewRequired] = React.useState(true)
  /** 「自动获取」拉到的站内模型；null = 还没拉过 */
  const [modelOptions, setModelOptions] = React.useState<string[] | null>(null)
  const [modelsLoading, setModelsLoading] = React.useState(false)
  const [modelKeyword, setModelKeyword] = React.useState("")
  const [agentPrompt, setAgentPrompt] = React.useState("")
  const [channels, setChannels] = React.useState<ChannelDraft[]>([])

  const apply = (res: AdminLabConfig) => {
    setAiSource(res.aiSource)
    setHasAdminKey(res.hasAdminKey)
    setAdminKeyTail(res.adminKeyTail)
    setAdminUnavailable(res.adminUnavailable)
    setFreeQuota(res.freeQuota)
    setFreeQuotaPeriod(res.freeQuotaPeriod)
    setFreeModels(res.freeModels)
    setSiteModels(res.siteModels)
    setReviewRequired(res.reviewRequired)
    setAgentPrompt(res.agentPrompt)
    setChannels(
      res.channels.map((c) => ({
        id: c.id,
        name: c.name,
        baseUrl: c.baseUrl,
        model: c.model,
        apiKey: "",
        hasStoredKey: c.hasKey,
        keyTail: c.keyTail,
      }))
    )
    // 密钥框每次加载都清空：里面显示的是尾号，留着会让管理员以为「已经填了」
    setAdminKeyInput("")
  }

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      apply(await adminApi.getLabConfig())
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.loadFailed")))
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  const patchChannel = (idx: number, upd: Partial<ChannelDraft>) => {
    setChannels((prev) => prev.map((c, i) => (i === idx ? { ...c, ...upd } : c)))
  }

  const addChannel = () => {
    // 新建时就给一个本地 id：列表用 id 当 key，不给的话删中间一条会让
    // React 按索引复用 DOM，用户会看到「输入框里的字跑到别的行去了」。
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setChannels((prev) => [...prev, { id: localId, name: "", baseUrl: "", model: "", apiKey: "" }])
  }

  const removeChannel = (idx: number) => {
    setChannels((prev) => prev.filter((_, i) => i !== idx))
  }

  /**
   * 「自动获取」站内模型列表。
   *
   * 直接复用用户端那个接口（`/api/lab/models`）：管理员本身也是用户，
   * 有统一 Key 时它用统一 Key 拉，没有时用管理员自己绑定的中转站账号拉 ——
   * 不需要为此单开一个管理端接口。
   */
  const fetchModels = async () => {
    setModelsLoading(true)
    try {
      const res = await labApi.models()
      setModelOptions(res.models)
      if (res.models.length === 0) toast.message(t("adm.lab.modelsEmpty"))
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.modelsFailed")))
    } finally {
      setModelsLoading(false)
    }
  }

  /**
   * 白名单的可选项 = 拉到的模型 ∪ 已选模型。
   * 并上「已选」是为了**不丢配置**：上游把某个模型下架后，它仍然出现在列表里
   * 让管理员能看见并手动取消，而不是变成一条改不掉的幽灵条目。
   */
  const modelChoices = React.useMemo(() => {
    const set = new Set([...(modelOptions ?? []), ...freeModels])
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [modelOptions, freeModels])

  const filteredChoices = React.useMemo(() => {
    const k = modelKeyword.trim().toLowerCase()
    const list = k ? modelChoices.filter((m) => m.toLowerCase().includes(k)) : modelChoices
    return list.slice(0, 300)
  }, [modelChoices, modelKeyword])

  const toggleModel = (m: string) => {
    setFreeModels((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]))
  }

  /**
   * 站内白名单的可选项与免费白名单同一份（都来自「自动获取」），
   * 但搜索词、已选列表各自独立。
   */
  const siteChoices = React.useMemo(() => {
    const set = new Set([...(modelOptions ?? []), ...siteModels])
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [modelOptions, siteModels])

  const filteredSiteChoices = React.useMemo(() => {
    const k = siteKeyword.trim().toLowerCase()
    const list = k ? siteChoices.filter((m) => m.toLowerCase().includes(k)) : siteChoices
    return list.slice(0, 300)
  }, [siteChoices, siteKeyword])

  const toggleSiteModel = (m: string) => {
    setSiteModels((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]))
  }

  const save = async () => {
    setBusy(true)
    try {
      const res = await adminApi.saveLabConfig({
        aiSource,
        freeQuota,
        freeQuotaPeriod,
        freeModels,
        siteModels,
        reviewRequired,
        agentPrompt,
        channels: channels.map((c) => ({
          id: c.id,
          name: c.name.trim(),
          baseUrl: c.baseUrl.trim(),
          model: c.model.trim(),
          apiKey: c.apiKey?.trim() ?? "",
        })),
        // 留空 = 不改统一 Key。JSON.stringify 会把 undefined 丢掉，正合此意。
        ...(adminKeyInput.trim() ? { adminApiKey: adminKeyInput.trim() } : {}),
      })
      apply(res)
      toast.success(t("adm.lab.saved"))
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.saveFailed")))
    } finally {
      setBusy(false)
    }
  }

  const clearAdminKey = async () => {
    const ok = await confirmDialog({
      title: t("adm.lab.clearKeyConfirm"),
      desc: t("adm.lab.clearKeyConfirmDesc"),
      danger: true,
      okText: t("adm.lab.clearKey"),
    })
    if (!ok) return
    setClearing(true)
    try {
      apply(await adminApi.saveLabConfig({ clearAdminKey: true }))
      toast.success(t("adm.lab.keyCleared"))
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.saveFailed")))
    } finally {
      setClearing(false)
    }
  }

  if (loading) {
    return (
      <div className="py-16">
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ---------------- 模型来源 ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("adm.lab.sourceTitle")}</CardTitle>
          <CardDescription>{t("adm.lab.sourceDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <SourceOption
              active={aiSource === "user"}
              title={t("adm.lab.sourceUser")}
              desc={t("adm.lab.sourceUserDesc")}
              onSelect={() => setAiSource("user")}
            />
            <SourceOption
              active={aiSource === "admin"}
              title={t("adm.lab.sourceAdmin")}
              desc={t("adm.lab.sourceAdminDesc")}
              icon={<Gift className="h-3.5 w-3.5" />}
              onSelect={() => setAiSource("admin")}
            />
          </div>

          {adminUnavailable && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-xs text-muted-foreground">{t("adm.lab.adminUnavailable")}</p>
            </div>
          )}

          <div className="space-y-1.5 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="lab-admin-key" className="flex items-center gap-1.5 text-sm">
                <KeyRound className="h-3.5 w-3.5" />
                {t("adm.lab.adminKey")}
              </Label>
              {hasAdminKey ? (
                <Badge variant="secondary">
                  {t("adm.lab.keyConfigured")} · {adminKeyTail}
                </Badge>
              ) : (
                <Badge variant="outline">{t("adm.lab.keyNotConfigured")}</Badge>
              )}
              {hasAdminKey && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-destructive"
                  onClick={() => void clearAdminKey()}
                  disabled={clearing}
                >
                  {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  {t("adm.lab.clearKey")}
                </Button>
              )}
            </div>
            <Input
              id="lab-admin-key"
              type="password"
              autoComplete="off"
              value={adminKeyInput}
              onChange={(e) => setAdminKeyInput(e.target.value)}
              placeholder={hasAdminKey ? t("adm.lab.keyKeepHint") : "sk-..."}
            />
            <p className="text-[11px] text-muted-foreground">{t("adm.lab.adminKeyHint")}</p>
          </div>

          <p className="text-[11px] text-muted-foreground">{t("adm.lab.freeBadgeHint")}</p>
        </CardContent>
      </Card>

      {/* ---------------- 免费额度 ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("adm.lab.quotaTitle")}</CardTitle>
          <CardDescription>{t("adm.lab.quotaDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-40 space-y-1.5">
              <Label className="text-xs">{t("adm.lab.quotaCount")}</Label>
              <Input
                type="number"
                min={0}
                value={freeQuota}
                onChange={(e) => setFreeQuota(Math.max(0, Math.floor(Number(e.target.value)) || 0))}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("adm.lab.quotaPeriod")}</Label>
              <div className="flex flex-wrap gap-1">
                {PERIODS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setFreeQuotaPeriod(p)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-xs transition-colors",
                      freeQuotaPeriod === p
                        ? "border-primary bg-primary text-primary-foreground"
                        : "hover:bg-accent"
                    )}
                  >
                    {t(`adm.lab.period.${p}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("adm.lab.quotaHint")}</p>
        </CardContent>
      </Card>

      {/* ---------------- 站内模型白名单 ---------------- */}
      {/* 排在最前面：先决定「哪些模型能被看见」，再决定「哪些免费」 */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("adm.lab.siteModelsTitle")}</CardTitle>
            <CardDescription>{t("adm.lab.siteModelsDesc")}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void fetchModels()} disabled={modelsLoading}>
            {modelsLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t("adm.lab.siteModelsFetch")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={siteModels.length === 0 ? "outline" : "secondary"}>
              {siteModels.length === 0
                ? t("adm.lab.siteModelsAll")
                : t("adm.lab.siteModelsCount", { n: siteModels.length })}
            </Badge>
            {siteModels.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setSiteModels([])}
              >
                {t("adm.lab.siteModelsClear")}
              </Button>
            )}
          </div>

          {siteModels.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {siteModels.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleSiteModel(m)}
                  title={t("adm.lab.siteModelsRemove")}
                  className="group inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs transition-colors hover:border-destructive/50"
                >
                  <span className="max-w-[220px] truncate">{m}</span>
                  <X className="h-3 w-3 text-muted-foreground group-hover:text-destructive" />
                </button>
              ))}
            </div>
          )}

          <Input
            value={siteKeyword}
            onChange={(e) => setSiteKeyword(e.target.value)}
            placeholder={t("adm.lab.siteModelsSearch")}
          />

          {siteChoices.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
              {t("adm.lab.siteModelsEmpty")}
            </p>
          ) : (
            <div className="max-h-64 overflow-auto rounded-md border p-1">
              {filteredSiteChoices.map((m) => {
                const checked = siteModels.includes(m)
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => toggleSiteModel(m)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
                      checked && "bg-accent/60"
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-muted-foreground/40"
                      )}
                    >
                      {checked && <Check className="h-2.5 w-2.5" />}
                    </span>
                    <span className="truncate">{m}</span>
                  </button>
                )
              })}
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">{t("adm.lab.siteModelsHint")}</p>
        </CardContent>
      </Card>

      {/* ---------------- 免费模型白名单 ---------------- */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("adm.lab.freeModelsTitle")}</CardTitle>
            <CardDescription>{t("adm.lab.freeModelsDesc")}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void fetchModels()} disabled={modelsLoading}>
            {modelsLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t("adm.lab.freeModelsFetch")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 当前状态：空名单 = 全部免费，这是最容易误解的一点，用徽章说清楚 */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={freeModels.length === 0 ? "outline" : "secondary"}>
              {freeModels.length === 0
                ? t("adm.lab.freeModelsAll")
                : t("adm.lab.freeModelsCount", { n: freeModels.length })}
            </Badge>
            {freeModels.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setFreeModels([])}
              >
                {t("adm.lab.freeModelsClear")}
              </Button>
            )}
          </div>

          {/* 已选模型：点一下即取消；上游下架的模型也留在这里，方便手动清掉 */}
          {freeModels.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {freeModels.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleModel(m)}
                  title={t("adm.lab.freeModelsRemove")}
                  className="group inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs transition-colors hover:border-destructive/50"
                >
                  <span className="max-w-[220px] truncate">{m}</span>
                  <X className="h-3 w-3 text-muted-foreground group-hover:text-destructive" />
                </button>
              ))}
            </div>
          )}

          <Input
            value={modelKeyword}
            onChange={(e) => setModelKeyword(e.target.value)}
            placeholder={t("adm.lab.freeModelsSearch")}
          />

          {modelChoices.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
              {t("adm.lab.freeModelsEmpty")}
            </p>
          ) : (
            <div className="max-h-64 overflow-auto rounded-md border p-1">
              {filteredChoices.map((m) => {
                const checked = freeModels.includes(m)
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => toggleModel(m)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
                      checked && "bg-accent/60"
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-muted-foreground/40"
                      )}
                    >
                      {checked && <Check className="h-2.5 w-2.5" />}
                    </span>
                    <span className="truncate">{m}</span>
                  </button>
                )
              })}
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">{t("adm.lab.freeModelsHint")}</p>
        </CardContent>
      </Card>

      {/* ---------------- 免费渠道 ---------------- */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("adm.lab.channelsTitle")}</CardTitle>
            <CardDescription>{t("adm.lab.channelsDesc")}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={addChannel}>
            <Plus className="h-4 w-4" />
            {t("adm.lab.addChannel")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {channels.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
              {t("adm.lab.noChannels")}
            </p>
          ) : (
            channels.map((c, idx) => (
              <div key={c.id ?? `new-${idx}`} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("adm.lab.channelN", { n: idx + 1 })}
                  </span>
                  {c.hasStoredKey && (
                    <Badge variant="secondary">
                      {t("adm.lab.keyConfigured")} · {c.keyTail}
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-destructive"
                    onClick={() => removeChannel(idx)}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t("common.delete")}
                  </Button>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">{t("adm.lab.channelName")}</Label>
                    <Input
                      value={c.name}
                      onChange={(e) => patchChannel(idx, { name: e.target.value })}
                      placeholder={t("adm.lab.channelNamePlaceholder")}
                      maxLength={20}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t("adm.lab.channelModel")}</Label>
                    <Input
                      value={c.model}
                      onChange={(e) => patchChannel(idx, { model: e.target.value })}
                      placeholder={t("adm.lab.channelModelPlaceholder")}
                      maxLength={80}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">{t("adm.lab.channelBaseUrl")}</Label>
                  <Input
                    value={c.baseUrl}
                    onChange={(e) => patchChannel(idx, { baseUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                    maxLength={200}
                  />
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">{t("adm.lab.channelKey")}</Label>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={c.apiKey ?? ""}
                    onChange={(e) => patchChannel(idx, { apiKey: e.target.value })}
                    placeholder={c.hasStoredKey ? t("adm.lab.keyKeepHint") : "sk-..."}
                  />
                </div>
              </div>
            ))
          )}
          <p className="text-[11px] text-muted-foreground">{t("adm.lab.channelsHint")}</p>
        </CardContent>
      </Card>

      {/* ---------------- 作品审核 ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("adm.lab.reviewTitle")}</CardTitle>
          <CardDescription>{t("adm.lab.reviewDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <SourceOption
              active={reviewRequired}
              title={t("adm.lab.reviewOn")}
              desc={t("adm.lab.reviewOnDesc")}
              onSelect={() => setReviewRequired(true)}
            />
            <SourceOption
              active={!reviewRequired}
              title={t("adm.lab.reviewOff")}
              desc={t("adm.lab.reviewOffDesc")}
              onSelect={() => setReviewRequired(false)}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">{t("adm.lab.reviewHint")}</p>
        </CardContent>
      </Card>

      {/* ---------------- 系统提示词模板 ---------------- */}
      {/* 自成一个组件：它是 CRUD 列表、点了即时生效，和上面「改完要按保存」的配置不是一回事 */}
      <LabPromptTemplates />

      <div className="flex justify-end">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          {t("common.save")}
        </Button>
      </div>

      {/* ---------------- 作品审核队列 ----------------
          它是**操作台**、点了即时生效，和上面「改完要按保存」的配置不是一回事，
          所以单独一张卡、自己拉数据。 */}
      <LabReviewQueue />
    </div>
  )
}

/**
 * 造物集待审队列。
 *
 * · 「待审核」列出等放行的作品，「已驳回」留个记录（也方便反悔 —— 但驳回后再通过
 *   要用户重新提交，因为 `reviewLabProject` 只处理 pending，这里只读不写）；
 * · 预览走管理端专用接口（用户端详情接口看不到待审作品）；
 * · 作品一律塞进 `sandbox`（**不带 allow-same-origin**）的 iframe 里渲染。
 */
function LabReviewQueue() {
  const { t } = useT()
  const [status, setStatus] = React.useState<"pending" | "rejected">("pending")
  const [items, setItems] = React.useState<AdminLabReview[]>([])
  const [pendingCount, setPendingCount] = React.useState(0)
  const [rejectedCount, setRejectedCount] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  /** 正在写驳回理由的那一条 */
  const [rejecting, setRejecting] = React.useState<AdminLabReview | null>(null)
  /** 正在预览的作品文件 */
  const [preview, setPreview] = React.useState<{ name: string; doc: string } | null>(null)
  const [previewing, setPreviewing] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const res = await adminApi.listLabReviews(status)
      setItems(res.items)
      setPendingCount(res.pendingCount)
      setRejectedCount(res.rejectedCount)
    } catch {
      setItems([])
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [status])

  React.useEffect(() => {
    void load()
  }, [load])

  const approve = async (item: AdminLabReview) => {
    setBusyId(item.id)
    try {
      await adminApi.reviewLabProject(item.id, "approve")
      toast.success(t("adm.lab.reviewApproved", { name: item.name }))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.reviewFailed")))
    } finally {
      setBusyId(null)
    }
  }

  const reject = async (item: AdminLabReview, note: string) => {
    setBusyId(item.id)
    try {
      await adminApi.reviewLabProject(item.id, "reject", note)
      toast.success(t("adm.lab.reviewRejected", { name: item.name }))
      setRejecting(null)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.reviewFailed")))
    } finally {
      setBusyId(null)
    }
  }

  const openPreview = async (item: AdminLabReview) => {
    setPreviewing(item.id)
    try {
      const { project } = await adminApi.previewLabReview(item.id)
      const doc = buildPreviewDoc(project.files ?? {})
      if (!doc) {
        toast.error(t("adm.lab.reviewNoPreview"))
        return
      }
      setPreview({ name: project.name || item.name, doc })
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.reviewFailed")))
    } finally {
      setPreviewing(null)
    }
  }

  const tabBtn = (key: "pending" | "rejected", label: string, count: number) => (
    <button
      key={key}
      type="button"
      onClick={() => setStatus(key)}
      className={cn(
        "rounded-md border px-3 py-1.5 text-xs transition-colors",
        status === key
          ? "border-primary bg-primary text-primary-foreground"
          : "hover:bg-accent"
      )}
    >
      {label}
      {count > 0 && <span className="ml-1.5 tabular-nums opacity-80">{count}</span>}
    </button>
  )

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("adm.lab.reviewQueueTitle")}</CardTitle>
          <CardDescription>{t("adm.lab.reviewQueueDesc")}</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t("adm.lab.reviewRefresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {tabBtn("pending", t("adm.lab.reviewPending"), pendingCount)}
          {tabBtn("rejected", t("adm.lab.reviewRejectedTab"), rejectedCount)}
        </div>

        {loading ? (
          <div className="py-8">
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : failed ? (
          <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            {t("adm.lab.reviewLoadFailed")}
          </p>
        ) : items.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            {status === "pending" ? t("adm.lab.reviewEmptyPending") : t("adm.lab.reviewEmptyRejected")}
          </p>
        ) : (
          <div className="space-y-2">
            {items.map((it) => (
              <div
                key={it.id}
                className="flex flex-wrap items-center gap-3 rounded-md border p-3"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted/50 text-lg">
                  {it.hasCover ? (
                    <img
                      src={galleryCoverUrl(it.id)}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : it.icon?.trim() ? (
                    <span className="leading-none">{it.icon}</span>
                  ) : (
                    <Sparkles className="h-4 w-4 text-muted-foreground" />
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-medium">{it.name}</p>
                    <Badge variant="outline" className="shrink-0">
                      {it.authorName}
                    </Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {it.description || t("gal.noDesc")}
                  </p>
                  {status === "rejected" && it.reviewNote && (
                    <p className="mt-0.5 truncate text-xs text-destructive">{it.reviewNote}</p>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={previewing === it.id}
                    onClick={() => void openPreview(it)}
                  >
                    {previewing === it.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                    {t("adm.lab.reviewPreview")}
                  </Button>
                  {status === "pending" && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive"
                        disabled={busyId === it.id}
                        onClick={() => setRejecting(it)}
                      >
                        <XCircle className="h-4 w-4" />
                        {t("adm.lab.reviewReject")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={busyId === it.id}
                        onClick={() => void approve(it)}
                      >
                        {busyId === it.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4" />
                        )}
                        {t("adm.lab.reviewApprove")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {rejecting && (
        <RejectDialog
          item={rejecting}
          busy={busyId === rejecting.id}
          onCancel={() => setRejecting(null)}
          onConfirm={(note) => void reject(rejecting, note)}
        />
      )}

      {preview && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-background/80 p-2 backdrop-blur-sm sm:p-5"
          onClick={() => setPreview(null)}
        >
          <div
            className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border bg-card shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center gap-3 border-b px-4 py-2.5">
              <p className="min-w-0 flex-1 truncate font-medium">{preview.name}</p>
              <Button variant="ghost" size="icon" onClick={() => setPreview(null)} aria-label={t("common.close")}>
                <X className="h-4 w-4" />
              </Button>
            </header>
            <div className="min-h-0 flex-1 bg-white">
              <iframe
                title={preview.name}
                className="h-full w-full border-0"
                sandbox="allow-scripts allow-modals allow-forms allow-popups"
                srcDoc={preview.doc}
              />
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}

/** 驳回理由输入框（理由会原样回给作者，所以别写太长） */
function RejectDialog({
  item,
  busy,
  onCancel,
  onConfirm,
}: {
  item: AdminLabReview
  busy: boolean
  onCancel: () => void
  onConfirm: (note: string) => void
}) {
  const { t } = useT()
  const [note, setNote] = React.useState("")

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium">{t("adm.lab.rejectTitle")}</h2>
            <Button variant="ghost" size="icon" onClick={onCancel} aria-label={t("common.close")}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("adm.lab.rejectDesc", { name: item.name })}
          </p>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={200}
            placeholder={t("adm.lab.rejectPlaceholder")}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => onConfirm(note.trim())}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("adm.lab.reviewReject")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/** 「模型来源」的两个可选卡片（点击即切换，没有下拉的层级感） */
function SourceOption({
  active,
  title,
  desc,
  icon,
  onSelect,
}: {
  active: boolean
  title: string
  desc: string
  icon?: React.ReactNode
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-start gap-2 rounded-md border p-3 text-left transition-colors",
        active ? "border-primary bg-accent" : "hover:bg-accent/50"
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          active ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
        )}
      >
        {active && <Check className="h-3 w-3" />}
      </span>
      <span className="min-w-0 space-y-0.5">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {title}
          {icon}
        </span>
        <span className="block text-xs text-muted-foreground">{desc}</span>
      </span>
    </button>
  )
}

/**
 * 系统提示词模板管理（CRUD，点了即时生效）。
 *
 * 为什么独立成组件、不挂在上面的「保存」按钮上：
 *   模板是一份份**独立的实体**（各自的 id / 启用状态），走自己的接口增删改；
 *   而上面那张卡片是「一个表单、改完统一提交」。硬凑到一起就会出现
 *   「改了一半按保存，模板和配置谁先谁后」这种说不清的情况。
 *
 * 与用户端的关系：
 *   · 启用中的模板会下发给「AI 实验室」，用户在工具栏上的按钮里切换；
 *   · **启用 ≥2 份**才会出现那个切换按钮（只有一份时没得选）；
 *   · 一个都不启用 ⇒ 回落到旧的单份覆盖值 / 内置默认，行为不变。
 */
function LabPromptTemplates() {
  const { t } = useT()
  const [items, setItems] = React.useState<AdminLabPromptTemplate[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  /** 正在展开编辑的模板 id（同时只展开一个，避免一屏全是输入框） */
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [draftName, setDraftName] = React.useState("")
  const [draftContent, setDraftContent] = React.useState("")

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminApi.listLabPromptTemplates()
      setItems(res.templates)
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.tplSaveFailed")))
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  const enabledCount = items.filter((x) => x.enabled).length

  /** 新建：直接用内置默认提示词打底 —— 空正文是不允许的，从能跑的版本改比从零写强 */
  const create = async () => {
    setBusy(true)
    try {
      const res = await adminApi.createLabPromptTemplate({
        name: t("adm.lab.tplNewName"),
        content: DEFAULT_AGENT_SYSTEM,
      })
      if (res.template) {
        const created = res.template
        setItems((prev) => [...prev, created])
        setEditingId(created.id)
        setDraftName(created.name)
        setDraftContent(created.content)
      }
      toast.success(t("adm.lab.tplCreated"))
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.tplSaveFailed")))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (row: AdminLabPromptTemplate) => {
    try {
      const res = await adminApi.updateLabPromptTemplate(row.id, { enabled: !row.enabled })
      if (res.template) {
        const updated = res.template
        setItems((prev) => prev.map((x) => (x.id === row.id ? updated : x)))
      }
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.tplSaveFailed")))
    }
  }

  const saveEdit = async (id: string) => {
    setBusy(true)
    try {
      const res = await adminApi.updateLabPromptTemplate(id, {
        name: draftName,
        content: draftContent,
      })
      if (res.template) {
        const updated = res.template
        setItems((prev) => prev.map((x) => (x.id === id ? updated : x)))
      }
      setEditingId(null)
      toast.success(t("adm.lab.tplSaved"))
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.tplSaveFailed")))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (row: AdminLabPromptTemplate) => {
    const ok = await confirmDialog({
      title: t("adm.lab.tplDelete"),
      desc: t("adm.lab.tplDeleteConfirm"),
      okText: t("common.delete"),
      danger: true,
    })
    if (!ok) return
    try {
      await adminApi.deleteLabPromptTemplate(row.id)
      setItems((prev) => prev.filter((x) => x.id !== row.id))
      if (editingId === row.id) setEditingId(null)
    } catch (err) {
      toast.error(errMsg(err, t("adm.lab.tplSaveFailed")))
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("adm.lab.tplTitle")}</CardTitle>
          <CardDescription>{t("adm.lab.tplDesc")}</CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={enabledCount === 0 ? "outline" : "secondary"}>
            {enabledCount === 0
              ? t("adm.lab.tplNoneEnabled")
              : t("adm.lab.tplEnabledCount", { n: enabledCount })}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => void create()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {t("adm.lab.tplNew")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
            {t("adm.lab.tplLoading")}
          </p>
        ) : items.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            {t("adm.lab.tplEmpty")}
          </p>
        ) : (
          <div className="space-y-1.5">
            {items.map((row) => {
              const editing = editingId === row.id
              return (
                <div key={row.id} className="rounded-lg border">
                  <div className="flex flex-wrap items-center gap-2 p-2">
                    {/* 启用开关：只有一个复选框，点标签也能切 */}
                    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-[var(--primary)]"
                        checked={row.enabled}
                        onChange={() => void toggle(row)}
                      />
                      {t("adm.lab.tplEnable")}
                    </label>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {t("adm.lab.tplSize", { n: row.content.length })}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (editing) {
                          setEditingId(null)
                          return
                        }
                        setEditingId(row.id)
                        setDraftName(row.name)
                        setDraftContent(row.content)
                      }}
                    >
                      {editing ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                      {editing ? t("common.cancel") : t("common.edit")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void remove(row)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {editing && (
                    <div className="space-y-2 border-t p-2">
                      <div className="space-y-1">
                        <Label className="text-xs">{t("adm.lab.tplName")}</Label>
                        <Input
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          maxLength={40}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">{t("adm.lab.tplContent")}</Label>
                        <Textarea
                          value={draftContent}
                          onChange={(e) => setDraftContent(e.target.value)}
                          rows={12}
                          spellCheck={false}
                          className="max-h-96 min-h-40 overflow-auto font-mono text-xs"
                        />
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void saveEdit(row.id)}
                          disabled={busy}
                        >
                          {busy ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Save className="h-4 w-4" />
                          )}
                          {t("common.save")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-muted-foreground">{t("adm.lab.tplHint")}</p>
      </CardContent>
    </Card>
  )
}
