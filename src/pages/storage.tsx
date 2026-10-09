import * as React from "react"
import { ChevronRight, Cloud, Copy, ExternalLink, Eye, EyeOff, Folder, FolderPlus, Globe, HardDrive, Home, Link2, Loader2, Power, RefreshCw, ScrollText, Share2, Trash2, Upload, X } from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { FeatureLockedNotice } from "@/components/feature-locked-notice"
import { EmptyState } from "@/components/empty-state"
import { StorageSkeleton } from "@/components/skeletons"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { storageApi, HttpError } from "@/services/api"
import { formatBytes, fmtTime } from "@/lib/format"
import type { StorageFolder, StorageObject, StorageOverview, StorageShare } from "@/types"
import { useT } from "@/i18n"
/**
 * 网盘「使用协议」。版本须与后端 STORAGE_CONSENT_VERSION 一致。
 * 用户点「开通网盘」前必须勾选同意，服务端校验通过才会写入启用状态。
 * 目的：明确禁止存放违规内容、违规后果自负并可能永久封号，降低平台责任。
 */
const STORAGE_CONSENT_VERSION = 1

const STORAGE_AGREEMENT = [
  {
    title: "st.ag.1.title",
    body: "st.ag.1.body",
  },
  {
    title: "st.ag.2.title",
    body: "st.ag.2.body",
  },
  {
    title: "st.ag.3.title",
    body: "st.ag.3.body",
  },
  {
    title: "st.ag.4.title",
    body: "st.ag.4.body",
  },
  {
    title: "st.ag.5.title",
    body: "st.ag.5.body",
  },
  {
    title: "st.ag.6.title",
    body: "st.ag.6.body",
  },
]


/** 与 Worker 端 settings.ts 的 formatBytes 保持一致的展示逻辑（实现见 @/lib/format） */

/**
 * 上传中的进度状态。
 * 必须用唯一 id 而不是文件名做键：一次拖拽可能包含两个同名文件，
 * 用名字做键会导致两者的进度条目互相覆盖/提前消失。
 */
interface Uploading {
  id: string
  name: string
  percent: number
}

export default function StoragePage() {
  const { t } = useT()
  const [overview, setOverview] = React.useState<StorageOverview | null>(null)
  const [objects, setObjects] = React.useState<StorageObject[]>([])
  const [folders, setFolders] = React.useState<StorageFolder[]>([])
  /** 当前所在目录（相对账号根目录；'' = 根目录） */
  const [path, setPath] = React.useState("")
  const [listingTruncated, setListingTruncated] = React.useState(false)
  /** 切换目录时的轻量加载态：不整页换骨架屏，只在这块内容上给个提示 */
  const [navLoading, setNavLoading] = React.useState(false)
  const [shares, setShares] = React.useState<StorageShare[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  // 协议同意（开通前必须勾选）
  const [consent, setConsent] = React.useState(false)
  const [agreementOpen, setAgreementOpen] = React.useState(false)
  const [uploading, setUploading] = React.useState<Uploading[]>([])
  const [uploadActive, setUploadActive] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const [domainOpen, setDomainOpen] = React.useState(false)
  const [selectedSub, setSelectedSub] = React.useState("")
  // 新建目录
  const [folderOpen, setFolderOpen] = React.useState(false)
  const [folderName, setFolderName] = React.useState("")
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  /** 多选：批量删除用（存 key） */
  const [selected, setSelected] = React.useState<Set<string>>(new Set())

  /** 拉取概览与文件列表；silent 用于上传/删除后刷新，避免整页 loading 闪烁 */
  // 无权限（403 FEATURE_NOT_PERMITTED）：整页显示提示 + 捐献入口
  const [locked, setLocked] = React.useState(false)

  // 当前目录的即时值：load() 是异步的，若用户在其返回前切了目录，
  // 直接用 state 会读到旧值（闭包），所以用 ref 做「是否已切走」的判定。
  const pathRef = React.useRef(path)

  const load = React.useCallback(async (silent = false, dir?: string) => {
    const target = dir ?? pathRef.current
    if (!silent) setLoading(true)
    try {
      const res = await storageApi.overview()
      setOverview(res)
      if (res.account) {
        const list = await storageApi.list(target)
        // 请求返回时用户已切到别的目录 → 丢弃这次结果，避免串目录
        if (pathRef.current !== target) return
        setObjects(list.objects)
        setFolders(list.folders ?? [])
        setListingTruncated(Boolean(list.truncated))
      } else {
        setObjects([])
        setFolders([])
      }
    } catch (err) {
      if (err instanceof HttpError && err.code === "FEATURE_NOT_PERMITTED") {
        setLocked(true)
        return
      }
      toast.error(err instanceof HttpError ? err.message : t("st.err.load"))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  /** 分享列表单独拉：失败不影响主流程，所以静默处理 */
  const loadShares = React.useCallback(async () => {
    try {
      const res = await storageApi.shares()
      setShares(res.shares)
    } catch {
      /* 分享是附加能力，拉取失败不打断页面 */
    }
  }, [])

  /**
   * 上传后刷新列表（并发合并）。
   *
   * 为什么需要：原来只有「整批传完」才刷一次，多文件/大文件时列表长时间一动不动，
   * 用户会以为上传失败。现在每传完一个就刷一次。
   *
   * 为什么要合并：`load()` 一次要打两个接口（overview + list），批量上传几十个文件时
   * 逐个 `await` 会把整批上传拖成串行。这里改成「同一时刻只在跑一次」，
   * 期间又传完的文件只记一个标记，等这次回来再补刷一次 —— 最终状态一定是新的。
   */
  const refreshing = React.useRef(false)
  const refreshQueued = React.useRef(false)
  const refreshList = async () => {
    if (refreshing.current) {
      refreshQueued.current = true
      return
    }
    refreshing.current = true
    try {
      await load(true)
    } finally {
      refreshing.current = false
      if (refreshQueued.current) {
        refreshQueued.current = false
        void refreshList()
      }
    }
  }

  React.useEffect(() => {
    void load()
    void loadShares()
  }, [load, loadShares])

  /** 进入目录（必须先同步 pathRef，否则 load 里的「已切走」判定会把结果丢掉） */
  const enterFolder = (next: string) => {
    if (next === pathRef.current) return
    pathRef.current = next
    setSelected(new Set())
    setPath(next)
    setNavLoading(true)
    void load(true, next).finally(() => setNavLoading(false))
  }

  const handleEnable = async () => {
    if (!consent) {
      toast.error(t("st.err.needConsent"))
      return
    }
    setBusy(true)
    try {
      await storageApi.enable(STORAGE_CONSENT_VERSION)
      toast.success(t("st.ok.created"))
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("st.err.create"))
    } finally {
      setBusy(false)
    }
  }

  const handleToggleEnabled = async () => {
    if (!overview?.account || busy) return
    setBusy(true)
    try {
      if (overview.account.enabled) {
        await storageApi.disable()
        toast.success(t("st.ok.linkDisabled"))
      } else {
        // 重新启用同样要带协议版本：若协议已升级，服务端会要求重新同意
        await storageApi.enable(STORAGE_CONSENT_VERSION)
        toast.success(t("st.ok.linkEnabled"))
      }
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.op"))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 生成文件直链（按段编码，目录里的文件不能整串 encode，否则 `/` 也会被编码）。
   * 若用户设置了「默认分享前缀」，则用 https://<子域名>/<路径>，
   * 否则回退到 https://<站点>/dl/<用户名>/<路径>。
   */
  const directLinkFor = (relativePath: string) => {
    if (!overview?.account) return ""
    const enc = relativePath.split("/").filter(Boolean).map(encodeURIComponent).join("/")
    if (overview.defaultPrefix) {
      return `https://${overview.defaultPrefix.fqdn}/${enc}`
    }
    return `${window.location.origin}/dl/${encodeURIComponent(
      overview.account.prefix
    )}/${enc}`
  }

  /** 在某个目录上生成（或复用）分享链接，并复制到剪贴板 */
  const handleShareFolder = async (folderPath: string) => {
    setBusy(true)
    try {
      const res = await storageApi.createShare(folderPath)
      await loadShares()
      try {
        await navigator.clipboard.writeText(res.share.url)
        toast.success(res.reused ? t("st.share.okReused") : t("st.share.okCreated"))
      } catch {
        // 剪贴板不可用（非 HTTPS / 无权限）时至少让用户看到链接
        toast.success(res.share.url)
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("st.share.errCreate"))
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteShare = async (id: string) => {
    if (!confirm(t("st.share.confirmDelete"))) return
    try {
      await storageApi.deleteShare(id)
      toast.success(t("st.share.okDeleted"))
      await loadShares()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("st.share.errOp"))
    }
  }

  const handleToggleShare = async (share: StorageShare) => {
    try {
      await storageApi.toggleShare(share.id, !share.enabled)
      toast.success(share.enabled ? t("st.share.okDisabled") : t("st.share.okEnabled"))
      await loadShares()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("st.share.errOp"))
    }
  }

  /** 新建目录（在当前目录下） */
  const handleCreateFolder = async () => {
    const name = folderName.trim()
    if (!name) return
    setBusy(true)
    try {
      const full = path ? `${path}/${name}` : name
      await storageApi.createFolder(full)
      toast.success(t("st.folder.okCreated", { name }))
      setFolderOpen(false)
      setFolderName("")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("st.folder.errCreate"))
    } finally {
      setBusy(false)
    }
  }

  /** 删除目录（递归，含目录下所有文件） */
  const handleDeleteFolder = async (folder: StorageFolder) => {
    if (!confirm(t("st.folder.confirmDelete", { name: folder.name }))) return
    setBusy(true)
    try {
      await storageApi.deleteFolder(folder.path)
      toast.success(t("st.folder.okDeleted", { name: folder.name }))
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.delete"))
    } finally {
      setBusy(false)
    }
  }

  const handleSetDefaultPrefix = async (prefixId: string | null) => {
    setBusy(true)
    try {
      await storageApi.setDefaultPrefix(prefixId)
      toast.success(prefixId ? t("st.ok.defaultPrefixSet") : t("st.ok.defaultPrefixReset"))
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("st.err.setting"))
    } finally {
      setBusy(false)
    }
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t("st.ok.linkCopied"))
    } catch {
      toast.error(t("ai.err.copy"))
    }
  }

  const copyShareUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t("st.share.okCopied"))
    } catch {
      toast.error(t("ai.err.copy"))
    }
  }

  /** 单文件上传：预签名直传 R2（XHR 以获得真实进度），再回服务端登记 */
  const uploadOne = (file: File, folder: string) =>
    new Promise<void>((resolve) => {
      // 用唯一 id 跟踪进度：同名文件不能互相覆盖进度条目
      const uid = crypto.randomUUID()
      setUploading((prev) => [...prev, { id: uid, name: file.name, percent: 0 }])
      const setPercent = (percent: number) =>
        setUploading((prev) =>
          prev.map((u) => (u.id === uid ? { ...u, percent } : u))
        )
      const done = () =>
        setUploading((prev) => prev.filter((u) => u.id !== uid))

      storageApi
        .uploadUrl({
          filename: file.name,
          size: file.size,
          contentType: file.type || "application/octet-stream",
          // 上传到「拖拽那一刻」所在的目录，避免上传途中用户切目录把文件放错地方
          folder: folder || undefined,
        })
        .then(({ uploadUrl, key }) => {
          const xhr = new XMLHttpRequest()
          xhr.open("PUT", uploadUrl, true)
          xhr.setRequestHeader(
            "Content-Type",
            file.type || "application/octet-stream"
          )
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setPercent(Math.round((e.loaded / e.total) * 100))
            }
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              storageApi
                .commit({ key, contentType: file.type })
                .then(() => {
                  toast.success(t("st.ok.fileUploaded", { name: file.name }))
                  done()
                  resolve()
                })
                .catch((err) => {
                  toast.error(
                    err instanceof HttpError ? err.message : t("st.err.regFailed", { name: file.name })
                  )
                  done()
                  resolve()
                })
            } else {
              toast.error(t("st.err.uploadFailed", { name: file.name, status: xhr.status }))
              done()
              resolve()
            }
          }
          xhr.onerror = () => {
            toast.error(t("st.err.uploadAborted", { name: file.name }))
            done()
            resolve()
          }
          xhr.send(file)
        })
        .catch((err) => {
          toast.error(
            err instanceof HttpError ? err.message : t("st.err.cannotUpload", { name: file.name })
          )
          done()
          resolve()
        })
    })

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !overview?.account) return
    if (uploadActive) return // 防止拖拽与选择框并发触发两批上传

    setUploadActive(true)
    try {
      const max = overview.maxFileBytes
      const list = Array.from(files)
      const folder = path

      for (const f of list.filter((f) => f.size > max)) {
        toast.error(t("st.err.tooLarge", { name: f.name, size: formatBytes(max) }))
      }

      for (const file of list.filter((f) => f.size <= max)) {
        await uploadOne(file, folder)
        // 每传完一个立刻开始刷列表（不 await：否则每个文件的刷新都会拖慢整批上传）
        void refreshList()
      }
    } finally {
      setUploadActive(false)
      // 收尾再刷一次，保证「最后一个文件」一定出现在列表里
      await load(true)
    }
  }

  const handleDelete = async (obj: StorageObject) => {
    try {
      await storageApi.remove(obj.key)
      toast.success(t("st.ok.deleted", { name: obj.filename }))
      setSelected((prev) => {
        if (!prev.has(obj.key)) return prev
        const next = new Set(prev)
        next.delete(obj.key)
        return next
      })
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.delete"))
    }
  }

  // ---- 批量删除 ----

  const toggleSelect = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const allSelected = objects.length > 0 && objects.every((o) => selected.has(o.key))

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (objects.length > 0 && objects.every((o) => prev.has(o.key))) {
        for (const o of objects) next.delete(o.key)
      } else {
        for (const o of objects) next.add(o.key)
      }
      return next
    })
  }

  const handleDeleteSelected = async () => {
    // 只用当前列表里仍然存在的 key，避免删掉已经消失的项
    const keys = [...selected].filter((k) => objects.some((o) => o.key === k))
    if (keys.length === 0) return
    if (!confirm(t("st.confirmDeleteMany", { n: keys.length }))) return
    try {
      await storageApi.removeMany(keys)
      toast.success(t("st.ok.deletedMany", { n: keys.length }))
      setSelected(new Set())
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.delete"))
    }
  }

  const handleBindDomain = async () => {
    if (!selectedSub) return
    setBusy(true)
    try {
      const res = await storageApi.bindDomain(selectedSub)
      toast.success(
        res.prefix.dnsCreated
          ? t("st.ok.domainBoundDns")
          : t("st.ok.domainBound")
      )
      setDomainOpen(false)
      setSelectedSub("")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("pf.err.bind"))
    } finally {
      setBusy(false)
    }
  }

  const handleUnbind = async (id: string) => {
    try {
      await storageApi.unbindDomain(id)
      toast.success(t("pf.ok.unbound"))
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("pf.err.unbind"))
    }
  }

  if (locked) {
    return (
      <FeatureLockedNotice
        feature="r2"
        featureLabel={t("feat.r2")}
        description={t("locked.desc", { feature: t("feat.r2") })}
      />
    )
  }

  if (loading) {
    return (
      <div>
        <PageHeader title={t("st.title")} description={t("st.subtitle")} />
        <StorageSkeleton />
      </div>
    )
  }

  if (!overview?.configured) {
    return (
      <div>
        <PageHeader title={t("st.title")} description={t("st.subtitle")} />
        <EmptyState
          title={t("st.notConfigured")}
          description={t("st.notConfiguredDesc")}
        />
      </div>
    )
  }

  if (!overview.account) {
    return (
      <div>
        <PageHeader title={t("st.title")} description={t("st.subtitle")} />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <HardDrive className="h-4 w-4 text-muted-foreground" />
              {t("st.intro.title")}
            </CardTitle>
            <CardDescription>
              {t("st.intro.desc", { size: formatBytes(overview.defaultQuotaBytes) })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>{t("st.intro.b1", { origin: window.location.origin })}</li>
              <li>{t("st.intro.b2")}</li>
              <li>{t("st.intro.b3")}</li>
            </ul>

            <div className="rounded-md border bg-muted/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <ScrollText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">
                      {t("st.consent.version", { v: STORAGE_CONSENT_VERSION })}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("st.consent.desc")}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAgreementOpen(true)}
                >
                  {t("st.consent.viewFull")}
                </Button>
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span className="text-sm text-muted-foreground">
                {t("st.consent.check", { v: STORAGE_CONSENT_VERSION })}
              </span>
            </label>

            <Button onClick={() => void handleEnable()} disabled={busy || !consent}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("st.consent.agreeCreate")}
            </Button>
          </CardContent>
        </Card>

        <AgreementDialog open={agreementOpen} onOpenChange={setAgreementOpen} />
      </div>
    )
  }

  // 协议版本过期（老账号或协议升级）→ 与未开通一样，强制重新阅读并同意
  const needReconsent =
    overview.account !== null &&
    (overview.consentedVersion ?? 0) < overview.consentVersion

  if (needReconsent) {
    return (
      <div>
        <PageHeader title={t("st.title")} description={t("st.subtitle")} />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ScrollText className="h-4 w-4 text-muted-foreground" />
              {t("st.updated.title")}
            </CardTitle>
            <CardDescription>
              {t("st.updated.desc", { v: overview.consentVersion })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <ScrollText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">
                      {t("st.consent.version", { v: overview.consentVersion })}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("st.consent.desc2")}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAgreementOpen(true)}
                >
                  {t("st.consent.viewFull")}
                </Button>
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span className="text-sm text-muted-foreground">
                {t("st.consent.checkShort", { v: overview.consentVersion })}
              </span>
            </label>

            <Button onClick={() => void handleEnable()} disabled={busy || !consent}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("st.consent.agreeContinue")}
            </Button>
          </CardContent>
        </Card>

        <AgreementDialog open={agreementOpen} onOpenChange={setAgreementOpen} />
      </div>
    )
  }

  const account = overview.account
  const pathSegments = path.split("/").filter(Boolean)
  const usedPercent =
    account.quotaBytes > 0
      ? Math.min(100, (account.usedBytes / account.quotaBytes) * 100)
      : 0

  return (
    <div>
      <PageHeader
        title={t("st.title")}
        description={t("st.accountLine", { prefix: account.prefix, n: account.fileCount })}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAgreementOpen(true)}
          >
            <ScrollText className="h-4 w-4" />
            {t("st.consent.link")}
          </Button>
        }
      />

      <div className="space-y-6">
        {/* 用量 + 操作 */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <HardDrive className="h-4 w-4 text-muted-foreground" />
                  {t("st.usage")}
                </CardTitle>
                <CardDescription>
                  {formatBytes(account.usedBytes)} / {formatBytes(account.quotaBytes)}
                  {!account.enabled && t("st.linkDisabled")}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void load()}
                  disabled={busy}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("common.refresh")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleToggleEnabled()}
                  disabled={busy}
                >
                  <Power className="h-3.5 w-3.5" />
                  {account.enabled ? t("st.disableLink") : t("st.enableLink")}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${usedPercent}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("st.usedLine", { pct: usedPercent.toFixed(1) })}{" "}
              {formatBytes(overview.maxFileBytes)}
            </p>
          </CardContent>
        </Card>

        {/* 直链地址 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4 text-muted-foreground" />
              {t("st.links.title")}
            </CardTitle>
            <CardDescription>
              {t("st.links.desc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* 当前默认分享前缀（复制直链时使用） */}
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={`${overview.shareBase ?? account.directLinkBase}/`}
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() =>
                  void copyText(`${overview.shareBase ?? account.directLinkBase}/`)
                }
                title={t("common.copy")}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {overview.defaultPrefix
                ? t("st.links.defaultFqdn", { fqdn: overview.defaultPrefix.fqdn })
                : t("st.links.defaultPath")}
            </p>

            {overview.prefixes.length > 0 && (
              <div className="space-y-2">
                {overview.prefixes.map((p) => {
                  const isDefault = account.defaultPrefixId === p.id
                  return (
                    <div key={p.id} className="flex items-center gap-2">
                      <Input
                        readOnly
                        value={`https://${p.fqdn}/`}
                        className="font-mono text-xs"
                      />
                      {isDefault ? (
                        <Badge variant="success" className="shrink-0">
                          {t("st.links.isDefault")}
                        </Badge>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => void handleSetDefaultPrefix(p.id)}
                          disabled={busy}
                          title={t("st.links.setDefaultHint")}
                        >
                          {t("st.links.setDefault")}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => void copyText(`https://${p.fqdn}/`)}
                        title={t("common.copy")}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => void handleUnbind(p.id)}
                        title={t("st.links.unbind")}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  )
                })}
                {account.defaultPrefixId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => void handleSetDefaultPrefix(null)}
                    disabled={busy}
                  >
                    {t("st.links.resetDefault")}
                  </Button>
                )}
              </div>
            )}

            {overview.customDomainSupported ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDomainOpen(true)}
                disabled={overview.availableSubdomains.length === 0}
              >
                <Globe className="h-3.5 w-3.5" />
                {t("st.bind.title")}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("st.bind.disabled")}
              </p>
            )}
          </CardContent>
        </Card>

        {/* 上传 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Cloud className="h-4 w-4 text-muted-foreground" />
              {t("st.files.title")}
            </CardTitle>
            <CardDescription>{t("st.files.desc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                void handleFiles(e.dataTransfer.files)
              }}
              onClick={() => {
                if (!uploadActive) fileInputRef.current?.click()
              }}
              className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
                uploadActive ? "cursor-wait opacity-60" : "cursor-pointer"
              } ${
                dragging ? "border-primary bg-accent/40" : "border-muted-foreground/25"
              }`}
            >
              <Upload className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm font-medium">
                {uploadActive ? t("st.files.uploading") : t("st.files.dropHint")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("st.files.maxSize", { size: formatBytes(overview.maxFileBytes) })}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                disabled={uploadActive}
                className="hidden"
                onChange={(e) => {
                  void handleFiles(e.target.files)
                  e.target.value = ""
                }}
              />
            </div>

            {uploading.length > 0 && (
              <div className="space-y-2">
                {uploading.map((u) => (
                  <div key={u.id} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="truncate">{u.name}</span>
                      <span className="text-muted-foreground">{u.percent}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${u.percent}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 目录 + 文件列表 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">
              {t("st.list.title", { n: objects.length + folders.length })}
            </CardTitle>
            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => void handleDeleteSelected()}
                >
                  <Trash2 className="h-4 w-4" />
                  {t("st.list.deleteSelected", { n: selected.size })}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setFolderOpen(true)}>
                <FolderPlus className="h-4 w-4" />
                {t("st.folder.new")}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* 面包屑：根目录 → 当前目录 */}
            <div className="flex flex-wrap items-center gap-1 text-sm">
              <button
                type="button"
                onClick={() => enterFolder("")}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Home className="h-3.5 w-3.5" />
                {account.prefix}
              </button>
              {pathSegments.map((seg, i) => {
                const target = pathSegments.slice(0, i + 1).join("/")
                const isLast = i === pathSegments.length - 1
                return (
                  <React.Fragment key={target}>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                    {isLast ? (
                      <span className="rounded-md px-2 py-1 font-medium">{seg}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => enterFolder(target)}
                        className="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        {seg}
                      </button>
                    )}
                  </React.Fragment>
                )
              })}
            </div>

            {listingTruncated && (
              <p className="text-xs text-muted-foreground">{t("st.list.truncated")}</p>
            )}

            {navLoading && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("common.loading")}
              </p>
            )}

            {folders.length > 0 && (
              <div className="overflow-hidden rounded-lg border">
                {folders.map((f) => (
                  <div
                    key={f.path}
                    className="flex items-center gap-1 border-b px-2 py-1.5 last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() => enterFolder(f.path)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent"
                    >
                      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm">{f.name}</span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted-foreground"
                      onClick={() => void handleShareFolder(f.path)}
                      disabled={busy}
                      title={t("st.share.action")}
                    >
                      <Share2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => void handleDeleteFolder(f)}
                      disabled={busy}
                      title={t("st.folder.delete")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {objects.length === 0 && folders.length === 0 ? (
              <EmptyState
                title={t("st.list.empty")}
                description={t("st.list.emptyDesc")}
              />
            ) : objects.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer accent-primary align-middle"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        aria-label={t("st.list.selectAll")}
                      />
                    </TableHead>
                    <TableHead>{t("st.list.col.name")}</TableHead>
                    <TableHead>{t("st.list.col.size")}</TableHead>
                    <TableHead>{t("st.list.col.uploaded")}</TableHead>
                    <TableHead className="w-32" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {objects.map((o) => {
                    const link = directLinkFor(o.path)
                    return (
                      <TableRow key={o.key}>
                        <TableCell className="w-10">
                          <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer accent-primary align-middle"
                            checked={selected.has(o.key)}
                            onChange={() => toggleSelect(o.key)}
                            aria-label={t("st.list.selectOne", { name: o.filename })}
                          />
                        </TableCell>
                        <TableCell className="max-w-xs truncate font-mono text-xs">
                          {o.filename}
                        </TableCell>
                        <TableCell className="text-sm">
                          {formatBytes(o.size)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {fmtTime(o.lastModified)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground"
                              onClick={() => void copyText(link)}
                              title={t("st.list.copyLink")}
                            >
                              <Copy className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground"
                              asChild
                              title={t("st.list.openLink")}
                            >
                              <a href={link} target="_blank" rel="noreferrer">
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => void handleDelete(o)}
                              title={t("common.delete")}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            ) : null}
          </CardContent>
        </Card>

        {/* 目录分享管理 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Share2 className="h-4 w-4 text-muted-foreground" />
              {t("st.share.title")}
            </CardTitle>
            <CardDescription>{t("st.share.desc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {shares.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("st.share.empty")}</p>
            ) : (
              shares.map((s) => (
                <div key={s.id} className="flex items-center gap-2 rounded-lg border p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{s.title}</span>
                      {!s.enabled && (
                        <Badge variant="secondary" className="shrink-0">
                          {t("st.share.disabled")}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {s.url}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground"
                    onClick={() => void copyShareUrl(s.url)}
                    title={t("common.copy")}
                  >
                    <Link2 className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground"
                    asChild
                    title={t("st.list.openLink")}
                  >
                    <a href={s.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground"
                    onClick={() => void handleToggleShare(s)}
                    title={s.enabled ? t("st.share.disable") : t("st.share.enable")}
                  >
                    {s.enabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => void handleDeleteShare(s.id)}
                    title={t("common.delete")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* 新建目录 */}
      <Dialog open={folderOpen} onOpenChange={(v) => { setFolderOpen(v); if (!v) setFolderName("") }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("st.folder.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("st.folder.dialogDesc", { dir: path ? `${account.prefix}/${path}` : account.prefix })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="folderName">{t("st.folder.name")}</Label>
            <Input
              id="folderName"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder={t("st.folder.namePh")}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateFolder()
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleCreateFolder()} disabled={busy || !folderName.trim()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("st.folder.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 绑定二级域名 */}
      <Dialog open={domainOpen} onOpenChange={setDomainOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("st.bind.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("st.bind.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="domainSelect">{t("st.bind.subdomain")}</Label>
            <Select value={selectedSub} onValueChange={setSelectedSub}>
              <SelectTrigger id="domainSelect">
                <SelectValue placeholder={t("st.bind.selectPh")} />
              </SelectTrigger>
              <SelectContent>
                {overview.availableSubdomains.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.fqdn}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("st.bind.note")}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDomainOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void handleBindDomain()}
              disabled={busy || !selectedSub}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("st.bind.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 顶部「使用协议」按钮打开的协议全文弹窗 */}
      <AgreementDialog open={agreementOpen} onOpenChange={setAgreementOpen} />
    </div>
  )
}
/** 协议全文弹窗（与代理节点的 AgreementDialog 同构） */
function AgreementDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { t } = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("st.consent.dialogTitle", { v: STORAGE_CONSENT_VERSION })}</DialogTitle>
          <DialogDescription>
            {t("st.consent.dialogDesc")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {STORAGE_AGREEMENT.map((sec) => (
            <section key={sec.title}>
              <h3 className="mb-1 text-sm font-medium">{t(sec.title)}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t(sec.body)}
              </p>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
