import * as React from "react"
import { toast } from "sonner"
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronRight,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  HardDriveDownload,
  Info,
  List,
  Loader2,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useT } from "@/i18n"
import {
  applyReplace,
  buildPreviewDoc,
  buildSystemPrompt,
  buildToolResults,
  compactHistory,
  MAX_ROUNDS,
  needsToolResult,
  parseAgentText,
  parseReplaceContent,
  PROTOCOL_NUDGE,
  type FileMap,
  type Segment,
  type ToolName,
} from "@/lib/lab-agent"
import {
  clearDraft,
  loadDraft,
  saveDraft,
  type LabDraft,
} from "@/lib/lab-draft"
import {
  dirPermission,
  exportToLocalFolder,
  forgetAutoSaveDir,
  importLocalFolder,
  pickAutoSaveDir,
  recallAutoSaveDir,
  rememberAutoSaveDir,
  sanitizeDirName,
  supportsLocalFs,
  writeFilesInto,
  type LocalDirHandle,
} from "@/lib/local-fs"
import { cn } from "@/lib/utils"
import {
  HttpError,
  labApi,
  streamLabChat,
  type LabProjectSummary,
} from "@/services/api"

/**
 * 网页实验室：一个「网页版 agent」。
 *
 * 和普通聊天页的区别：AI 不是吐一段文字，而是在一个**虚拟项目文件夹**里
 * 建文件、改文件、读文件 —— 每一次文件操作都渲染成可展开的过程卡片，
 * 所以用户看得见「它在改什么」。协议与解析逻辑见 @/lib/lab-agent。
 *
 * 版式（用户明确要求）：上面一大片留白，底部一条长条聊天框，只有一层容器；
 * 预览默认收起，点右上角才从右侧拉出一半。
 *
 * 额度来源两种：站内额度（后端自动管理专用 Key）/ 自定义渠道（Key 只存本地）。
 */

type Entry =
  | { key: string; kind: "user"; text: string }
  | {
      key: string
      kind: "text"
      text: string
      /** 还在流式输出中（用于「逐渐显示 + 思考走马灯」） */
      live: boolean
      /** 后面跟着工具调用 → 这是「思考/计划」，折叠展示；否则是给用户的答复 */
      collapsible: boolean
    }
  | {
      key: string
      kind: "tool"
      tool: ToolName
      path?: string
      status: "running" | "done"
      content: string
    }

/** 自定义渠道配置（只存浏览器本地） */
interface CustomChannel {
  baseUrl: string
  apiKey: string
  model: string
}
const CUSTOM_KEY = "doulor.lab.customChannel"
const MODEL_KEY = "doulor.lab.model"
/** 自动保存开关（目录句柄存在 IndexedDB 里，见 @/lib/local-fs） */
const AUTOSAVE_KEY = "doulor.lab.autosave"
/** 自动保存的「授权说明」是否已经看过（看过就不再弹） */
const AUTOSAVE_INTRO_KEY = "doulor.lab.autosaveIntro"
/** 本地保存用的「项目子目录名」——每个作品一个文件夹，免得 index.html 互相覆盖 */
const FOLDER_KEY = "doulor.lab.folder"
/** 自动保存间隔（毫秒）——只是兜底，每轮对话结束也会立刻存一次 */
const AUTOSAVE_INTERVAL = 20_000
/** 草稿落盘防抖（毫秒）：改文件很频繁，攒一攒再往 IndexedDB 写 */
const DRAFT_DEBOUNCE = 600

/** 起一个本地子目录名：优先用作品名，没有就按时间起一个 */
function makeFolderName(base?: string): string {
  const clean = sanitizeDirName(base)
  if (clean) return clean
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `网页项目-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}`
}

function loadCustom(): CustomChannel | null {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw) as Partial<CustomChannel>
    if (!obj || typeof obj.baseUrl !== "string") return null
    return {
      baseUrl: obj.baseUrl,
      apiKey: typeof obj.apiKey === "string" ? obj.apiKey : "",
      model: typeof obj.model === "string" ? obj.model : "",
    }
  } catch {
    return null
  }
}

/** 把用户填的 baseUrl 规范成 chat/completions 端点 */
function customEndpoint(raw: string): string {
  const base = raw.trim().replace(/\/+$/, "")
  if (/\/chat\/completions$/i.test(base)) return base
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

/** 解析 SSE 流：把每个 delta 交给 onDelta */
async function consumeSSE(
  res: Response,
  onDelta: (delta: string) => void
): Promise<void> {
  const reader = res.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buf = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        const s = line.trim()
        if (!s.startsWith("data:")) continue
        const payload = s.slice(5).trim()
        if (!payload || payload === "[DONE]") continue
        try {
          const j = JSON.parse(payload) as {
            choices?: { delta?: { content?: unknown } }[]
          }
          const delta = j?.choices?.[0]?.delta?.content
          if (typeof delta === "string" && delta) onDelta(delta)
        } catch {
          /* 单行坏数据跳过 */
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** 把「解析出来的片段」变成时间线上的条目 */
function segmentsToEntries(
  segs: Segment[],
  round: number,
  final: boolean
): Entry[] {
  const out: Entry[] = []
  segs.forEach((s, i) => {
    const key = `r${round}-${i}`
    if (s.type === "text") {
      // 后面还跟着文件动作 → 这段是「思考/计划」，折叠起来；
      // 后面没有动作 → 是给用户的最终答复，正常显示。
      // ⚠️ 这里**不能**要求动作已经 complete：流式期间动作天然是未完成的，
      // 若加上 complete 条件，旁白会先渲染成普通气泡、直到这一轮结束才「变成」折叠块，
      // 用户看到的就是「气泡一闪、忽然被收进思考块」。
      const followedByAction = segs.slice(i + 1).some((n) => n.type === "action")
      out.push({
        key,
        kind: "text",
        text: s.text,
        live: !final,
        collapsible: followedByAction,
      })
    } else {
      out.push({
        key,
        kind: "tool",
        tool: s.tool,
        path: s.path,
        status: final || s.complete ? "done" : "running",
        content: s.content,
      })
    }
  })
  return out
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export default function LabPage() {
  const { t } = useT()

  // 项目文件（内存里的工作副本；保存时落到云端或本地）
  const [files, setFiles] = React.useState<FileMap>({})
  const filesRef = React.useRef<FileMap>({})
  // 时间线
  const [entries, setEntries] = React.useState<Entry[]>([])
  const [live, setLive] = React.useState<Entry[] | null>(null)
  const [input, setInput] = React.useState("")
  const [streaming, setStreaming] = React.useState(false)

  // 预览
  const [preview, setPreview] = React.useState("")
  const [previewSeq, setPreviewSeq] = React.useState(0)
  const [previewOpen, setPreviewOpen] = React.useState(false)

  // 模型与渠道
  const [models, setModels] = React.useState<string[]>([])
  const [modelsLoading, setModelsLoading] = React.useState(true)
  const [stationMissing, setStationMissing] = React.useState(false)
  const [model, setModel] = React.useState(
    () => localStorage.getItem(MODEL_KEY) ?? ""
  )
  const [channel, setChannel] = React.useState<"station" | "custom">("station")
  const [custom, setCustom] = React.useState<CustomChannel | null>(() => loadCustom())

  // 弹窗
  const [channelOpen, setChannelOpen] = React.useState(false)
  const [saveOpen, setSaveOpen] = React.useState(false)
  const [projectsOpen, setProjectsOpen] = React.useState(false)
  const [filesOpen, setFilesOpen] = React.useState(false)
  const [viewFile, setViewFile] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [localBusy, setLocalBusy] = React.useState(false)

  // 作品
  const [projects, setProjects] = React.useState<LabProjectSummary[]>([])
  const [currentId, setCurrentId] = React.useState<string | null>(null)
  const [saveName, setSaveName] = React.useState("")
  const [saveDesc, setSaveDesc] = React.useState("")

  const abortRef = React.useRef<AbortController | null>(null)
  const convoRef = React.useRef<{ role: string; content: string }[]>([])
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const taRef = React.useRef<HTMLTextAreaElement | null>(null)
  const liveTimer = React.useRef<number | null>(null)
  const pendingLive = React.useRef<Entry[] | null>(null)
  const accRef = React.useRef("")

  // 自动保存到本地文件夹（防浏览器崩溃丢稿）
  const [autoSave, setAutoSave] = React.useState(() => {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) === "1"
    } catch {
      return false
    }
  })
  const [autoDir, setAutoDir] = React.useState<LocalDirHandle | null>(null)
  const [autoNeedPerm, setAutoNeedPerm] = React.useState(false)
  const [autoSavedAt, setAutoSavedAt] = React.useState<number | null>(null)
  const [autoBusy, setAutoBusy] = React.useState(false)
  const autoDirRef = React.useRef<LocalDirHandle | null>(null)
  /** 授权说明是否已展示过（localStorage 记着，跨会话） */
  const autoIntroShownRef = React.useRef<boolean>(
    ((): boolean => {
      try {
        return localStorage.getItem(AUTOSAVE_INTRO_KEY) === "1"
      } catch {
        return false
      }
    })()
  )

  // 本地保存的子目录名（每个作品一个独立文件夹）
  const [folderName, setFolderName] = React.useState(() => {
    try {
      const saved = localStorage.getItem(FOLDER_KEY)
      if (saved) return saved
    } catch {
      /* 隐私模式等：忽略 */
    }
    return makeFolderName()
  })
  const folderRef = React.useRef(folderName)

  // ---- 草稿（浏览器自己保管，刷新不丢）----
  /** 草稿最近一次落盘时间 */
  const [draftSavedAt, setDraftSavedAt] = React.useState<number | null>(null)
  /** 这次打开是不是从草稿恢复来的（显示一次性提示） */
  const [resumed, setResumed] = React.useState(false)
  /** 有改动还没写进草稿 → 离开页面前拦一下 */
  const dirtyRef = React.useRef(false)
  const draftTimer = React.useRef<number | null>(null)
  /** 自动保存的首次开启说明弹窗 */
  const [autoIntroOpen, setAutoIntroOpen] = React.useState(false)
  /** 顶部「草稿已保存」提示可以关掉 */
  const [draftTipClosed, setDraftTipClosed] = React.useState(false)
  /** 草稿读过一次之后才允许往回写（否则会把还没恢复的「空」覆盖成草稿） */
  const draftReady = React.useRef(false)

  /** 换一个子目录名（同时落 localStorage，刷新后接得上） */
  const applyFolderName = (name: string) => {
    folderRef.current = name
    setFolderName(name)
    try {
      localStorage.setItem(FOLDER_KEY, name)
    } catch {
      /* 忽略 */
    }
  }

  const localOk = React.useMemo(() => supportsLocalFs(), [])

  // ---- 草稿：把工作副本存进 IndexedDB，刷新后原样恢复 ----

  /** 立刻把当前状态写进草稿（返回是否写入成功） */
  const persistDraft = React.useCallback(async (): Promise<boolean> => {
    const snapshot: LabDraft<Entry> = {
      files: filesRef.current,
      entries,
      convo: convoRef.current,
      currentId,
      saveName,
      saveDesc,
      folderName: folderRef.current,
      savedAt: Date.now(),
    }
    const hasContent =
      Object.keys(snapshot.files).length > 0 || snapshot.entries.length > 0
    if (!hasContent) {
      // 空项目（比如刚点了「新对话」）→ 顺手把旧草稿清掉，
      // 否则下次刷新又冒出一份已经被删掉的内容
      dirtyRef.current = false
      setDraftSavedAt(null)
      await clearDraft()
      return false
    }
    const ok = await saveDraft(snapshot)
    if (ok) {
      dirtyRef.current = false
      setDraftSavedAt(snapshot.savedAt)
    }
    return ok
  }, [entries, currentId, saveName, saveDesc])

  /** 打个「有改动」标记，并攒一小会儿再落盘 */
  const markDirty = React.useCallback(() => {
    dirtyRef.current = true
    if (draftTimer.current != null) window.clearTimeout(draftTimer.current)
    draftTimer.current = window.setTimeout(() => {
      draftTimer.current = null
      void persistDraft()
    }, DRAFT_DEBOUNCE)
  }, [persistDraft])

  // 启动时读草稿：有就整份接回来（文件 / 时间线 / 对话历史 / 作品信息）
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      const d = await loadDraft<Entry>()
      if (cancelled) return
      draftReady.current = true
      if (!d) return
      const hasContent =
        Object.keys(d.files).length > 0 || d.entries.length > 0
      if (!hasContent) return
      filesRef.current = d.files
      setFiles(d.files)
      setEntries(d.entries)
      convoRef.current = d.convo
      setCurrentId(d.currentId)
      setSaveName(d.saveName)
      setSaveDesc(d.saveDesc)
      if (d.folderName) applyFolderName(d.folderName)
      const doc = buildPreviewDoc(d.files)
      if (doc) {
        setPreview(doc)
        setPreviewSeq((s) => s + 1)
      }
      setDraftSavedAt(d.savedAt || Date.now())
      setResumed(true)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 任何改动都攒一攒再落盘（含流式期间的文件写入）
  React.useEffect(() => {
    if (!draftReady.current) return
    markDirty()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, currentId, saveName, saveDesc, entries])

  // 从草稿恢复成功 → 轻提示一下（只提示一次）
  React.useEffect(() => {
    if (!resumed) return
    toast.success(t("lab.draft.restored"))
    setResumed(false)
  }, [resumed, t])

  // 关页/刷新前：还有没落盘的改动就拦一下浏览器弹确认框
  React.useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      e.preventDefault()
      // 现代浏览器只认 returnValue，文案由浏览器决定
      e.returnValue = t("lab.leaveWarn")
      return t("lab.leaveWarn")
    }
    const onHide = () => {
      // 页面被隐藏（切后台/关标签）时补一次，尽量不让改动裸露在内存里
      if (dirtyRef.current) void persistDraft()
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    window.addEventListener("pagehide", onHide)
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload)
      window.removeEventListener("pagehide", onHide)
    }
  }, [persistDraft, t])

  // 卸载时兜最后一次（React 卸载和 beforeunload 不一定同时发生）
  React.useEffect(() => {
    return () => {
      if (dirtyRef.current) void persistDraft()
    }
  }, [persistDraft])


  // 初始：拉站内模型列表（顺便探测是否已开通中转站）
  React.useEffect(() => {
    let cancelled = false
    labApi
      .models()
      .then((res) => {
        if (cancelled) return
        setModels(res.models)
        setModel((prev) => prev || res.models[0] || "")
      })
      .catch((err) => {
        if (cancelled) return
        const notBound =
          err instanceof HttpError && (err.status === 404 || err.code === "NOT_BOUND")
        setStationMissing(notBound)
        if (notBound && loadCustom()) setChannel("custom")
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const timeline = live ? [...entries, ...live] : entries
  const timelineLen = timeline.length
  /** 只有「本来就在底部」时才自动跟随，用户往上翻看历史时不打扰 */
  const nearBottomRef = React.useRef(true)
  React.useEffect(() => {
    if (!nearBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [timelineLen, live])

  // 输入框随内容长高（上限约 6 行）
  React.useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [input])

  const activeModel = channel === "station" ? model : custom?.model ?? ""
  const canSend = input.trim().length > 0 && !streaming && Boolean(activeModel)
  const filePaths = React.useMemo(() => Object.keys(files).sort(), [files])

  /** 节流刷新「进行中」的时间线：流式期间每 90ms 一帧，避免每个 delta 都重排 */
  const pushLive = (next: Entry[]) => {
    pendingLive.current = next
    if (liveTimer.current != null) return
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = null
      if (pendingLive.current) setLive(pendingLive.current)
    }, 90)
  }

  const persistModel = (m: string) => {
    setModel(m)
    try {
      localStorage.setItem(MODEL_KEY, m)
    } catch {
      /* 隐私模式等：忽略 */
    }
  }

  /**
   * 执行一个「已完成」的文件动作（写 / 改直接改内存文件系统）。
   * 返回失败原因（成功返回 null）——失败时要回喂给模型，否则它会以为改成功了。
   */
  const applyAction = (a: Extract<Segment, { type: "action" }>): string | null => {
    if (!a.complete || !a.path) return null
    if (a.tool === "write") {
      filesRef.current = { ...filesRef.current, [a.path]: a.content }
      setFiles(filesRef.current)
      return null
    }
    if (a.tool === "delete") {
      if (a.path in filesRef.current) {
        const copy = { ...filesRef.current }
        delete copy[a.path]
        filesRef.current = copy
        setFiles(copy)
      }
      return null
    }
    if (a.tool === "replace") {
      const diff = parseReplaceContent(a.content)
      if (!diff) {
        return "格式不对：正文需要 <<<<<<< 原文 ======= 新内容 >>>>>>> 三段（7 个以上符号都行）"
      }
      const res = applyReplace(filesRef.current, a.path, diff.old, diff.new)
      if (!res.ok) return res.reason
      filesRef.current = { ...filesRef.current, [a.path]: res.value }
      setFiles(filesRef.current)
      return null
    }
    return null
  }

  const refreshPreview = (bump: boolean) => {
    setPreview(buildPreviewDoc(filesRef.current))
    if (bump) setPreviewSeq((s) => s + 1)
  }

  // ---- 自动保存到本地文件夹（防浏览器崩溃丢稿）----

  /** 把当前项目写进已授权的本地目录；权限被回收就挂上「需要重新授权」 */
  const flushAutoSave = React.useCallback(async () => {
    const dir = autoDirRef.current
    if (!dir) return
    const snapshot = filesRef.current
    if (!Object.keys(snapshot).length) return
    try {
      await writeFilesInto(dir, snapshot, folderRef.current)
      setAutoSavedAt(Date.now())
    } catch (err) {
      const denied =
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "SecurityError")
      if (denied) {
        autoDirRef.current = null
        setAutoDir(null)
        setAutoNeedPerm(true)
      }
    }
  }, [])

  // 启动时：开关是开的就把上次的文件夹找回来（权限要单独确认，刷新后不会自动留）
  React.useEffect(() => {
    let cancelled = false
    let on = false
    try {
      on = localStorage.getItem(AUTOSAVE_KEY) === "1"
    } catch {
      /* 隐私模式等：忽略 */
    }
    if (!on || !supportsLocalFs()) return
    ;(async () => {
      const handle = await recallAutoSaveDir()
      if (cancelled) return
      if (!handle) {
        setAutoNeedPerm(true)
        return
      }
      const granted = await dirPermission(handle, "readwrite", false)
      if (cancelled) return
      if (granted) {
        autoDirRef.current = handle
        setAutoDir(handle)
      } else {
        setAutoNeedPerm(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 定时兜底；每轮对话结束还会立刻存一次
  React.useEffect(() => {
    if (!autoSave || !autoDir) return
    const id = window.setInterval(() => void flushAutoSave(), AUTOSAVE_INTERVAL)
    return () => window.clearInterval(id)
  }, [autoSave, autoDir, flushAutoSave])

  /** 开关自动保存。开启必须由用户点一次目录（浏览器只在一次点击里允许授权） */
  const toggleAutoSave = async () => {
    if (autoSave && autoDir) {
      setAutoSave(false)
      try {
        localStorage.setItem(AUTOSAVE_KEY, "0")
      } catch {
        /* 忽略 */
      }
      autoDirRef.current = null
      setAutoDir(null)
      setAutoSavedAt(null)
      setAutoNeedPerm(false)
      void forgetAutoSaveDir()
      toast.success(t("lab.autosave.off"))
      return
    }
    // 第一次开启：先说清楚「会弹权限框、刷新后要重新授权」，用户同意再动手
    if (autoIntroShownRef.current) {
      await beginAutoSave()
      return
    }
    setAutoIntroOpen(true)
  }

  /** 真正去申请权限并开启（说明弹窗点了「继续」之后走这里） */
  const beginAutoSave = async () => {
    if (!Object.keys(filesRef.current).length) {
      toast.error(t("lab.autosave.nothing"))
      return
    }
    setAutoBusy(true)
    try {
      let handle = autoDirRef.current ?? (await recallAutoSaveDir())
      let granted = handle ? await dirPermission(handle, "readwrite", true) : false
      if (!handle || !granted) {
        handle = await pickAutoSaveDir()
        if (!handle) return
        granted = await dirPermission(handle, "readwrite", true)
      }
      if (!granted) {
        toast.error(t("lab.autosave.denied"))
        return
      }
      await rememberAutoSaveDir(handle)
      autoDirRef.current = handle
      setAutoDir(handle)
      setAutoNeedPerm(false)
      setAutoSave(true)
      try {
        localStorage.setItem(AUTOSAVE_KEY, "1")
        localStorage.setItem(AUTOSAVE_INTRO_KEY, "1")
      } catch {
        /* 忽略 */
      }
      autoIntroShownRef.current = true
      await flushAutoSave()
      toast.success(
        t("lab.autosave.on").replace("{dir}", folderRef.current)
      )
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      toast.error(t("lab.err.generic"))
    } finally {
      setAutoBusy(false)
    }
  }

  /** 跑一轮：请求 → 流式解析 → 边写边执行 → 返回完整文本 */
  const streamRound = async (
    messages: { role: string; content: string }[],
    signal: AbortSignal,
    round: number,
    applied: Map<number, string>,
    onPreviewTick: () => void
  ): Promise<string> => {
    let res: Response
    if (channel === "station") {
      res = await streamLabChat({ model, messages, signal })
    } else {
      res = await fetch(customEndpoint(custom!.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${custom!.apiKey}`,
        },
        body: JSON.stringify({ model: custom!.model, messages, stream: true }),
        signal,
      })
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "")
        let msg = `HTTP ${res.status}`
        try {
          const j = JSON.parse(bodyText) as {
            error?: { message?: string }
            message?: string
          }
          msg = j?.error?.message ?? j?.message ?? msg
        } catch {
          /* 保留兜底 */
        }
        throw new Error(msg.slice(0, 200))
      }
    }

    let acc = ""
    let lastPreview = 0
    await consumeSSE(res, (delta) => {
      acc += delta
      accRef.current = acc
      const segs = parseAgentText(acc)
      segs.forEach((s, i) => {
        if (s.type === "action" && s.complete && !applied.has(i)) {
          applied.set(i, applyAction(s) ?? "")
        }
      })
      pushLive(segmentsToEntries(segs, round, false))
      const now = Date.now()
      if (now - lastPreview > 700) {
        lastPreview = now
        onPreviewTick()
      }
    })
    return acc
  }

  const send = async () => {
    const text = input.trim()
    if (!text || streaming) return
    if (channel === "station" && stationMissing) {
      toast.error(t("lab.err.notBound"))
      return
    }
    if (
      channel === "custom" &&
      (!custom || !custom.baseUrl || !custom.apiKey || !custom.model)
    ) {
      setChannelOpen(true)
      return
    }

    setInput("")
    setEntries((prev) => [
      ...prev,
      { key: `u-${Date.now()}`, kind: "user", text },
    ])
    convoRef.current = [...convoRef.current, { role: "user", content: text }]
    setStreaming(true)
    accRef.current = ""

    const controller = new AbortController()
    abortRef.current = controller

    // 模型偶尔会无视标签协议（把代码写成 markdown 代码块）——只纠正一次，别来回拉扯
    let nudged = false

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const messages = [
          { role: "system", content: buildSystemPrompt(filesRef.current) },
          ...compactHistory(convoRef.current),
        ]
        const applied = new Map<number, string>()
        const raw = await streamRound(messages, controller.signal, round, applied, () =>
          refreshPreview(false)
        )

        // 收尾：把没来得及执行的补齐（中止时也走这里，保住已生成的部分）
        const segs = parseAgentText(raw)
        segs.forEach((s, i) => {
          if (s.type === "action" && s.complete && !applied.has(i)) {
            applied.set(i, applyAction(s) ?? "")
          }
        })
        setEntries((prev) => [...prev, ...segmentsToEntries(segs, round, true)])
        setLive(null)
        if (liveTimer.current != null) {
          window.clearTimeout(liveTimer.current)
          liveTimer.current = null
        }
        convoRef.current = [...convoRef.current, { role: "assistant", content: raw }]
        refreshPreview(true)
        // 每轮结束立刻落一次本地（比定时器更及时，保住刚生成的稿子）
        void flushAutoSave()
        void persistDraft()

        if (!segs.length || controller.signal.aborted) break
        const failures = new Map([...applied].filter(([, reason]) => reason))
        const hasAction = segs.some((s) => s.type === "action" && s.complete)
        // 项目还空着、模型却只吐了 markdown 代码块 → 提醒它用标签重来（只一次）
        if (
          !hasAction &&
          !nudged &&
          Object.keys(filesRef.current).length === 0 &&
          raw.includes("```")
        ) {
          nudged = true
          convoRef.current = [
            ...convoRef.current,
            { role: "user", content: PROTOCOL_NUDGE },
          ]
          continue
        }
        // 只有「失败的动作」或「读/列/删」才需要回喂一轮
        if (!needsToolResult(segs, failures)) break
        // 模型要了文件内容 / 有动作失败 → 回喂结果，让它接着改
        convoRef.current = [
          ...convoRef.current,
          {
            role: "user",
            content: buildToolResults(segs, filesRef.current, failures),
          },
        ]
      }
    } catch (err) {
      if (controller.signal.aborted) {
        const segs = parseAgentText(accRef.current)
        setEntries((prev) => [...prev, ...segmentsToEntries(segs, 99, true)])
      } else if (err instanceof TypeError) {
        toast.error(t("lab.channel.cors"))
      } else if (err instanceof HttpError) {
        if (err.code === "NOT_BOUND") setStationMissing(true)
        if (
          err.code === "UPSTREAM_ERROR" &&
          /no available channel/i.test(err.message)
        ) {
          toast.error(t("lab.err.modelUnavailable"))
        } else {
          toast.error(err.message)
        }
      } else if (err instanceof Error && channel === "custom") {
        toast.error(err.message || t("lab.err.generic"))
      } else {
        toast.error(t("lab.err.stream"))
      }
    } finally {
      if (liveTimer.current != null) {
        window.clearTimeout(liveTimer.current)
        liveTimer.current = null
      }
      setLive(null)
      setStreaming(false)
      abortRef.current = null
      refreshPreview(true)
    }
  }

  const stop = () => abortRef.current?.abort()

  const newChat = () => {
    if (entries.length > 0 && Object.keys(filesRef.current).length && !currentId) {
      if (!window.confirm(t("lab.newChatConfirm"))) return
    }
    setEntries([])
    setLive(null)
    convoRef.current = []
    filesRef.current = {}
    setFiles({})
    setPreview("")
    setCurrentId(null)
    setSaveName("")
    setSaveDesc("")
    setResumed(false)
    setDraftTipClosed(false)
    // 草稿层也跟着清掉，免得刷新后又把刚清空的内容捞回来
    void clearDraft()
    setDraftSavedAt(null)
    // 新对话 → 换一个干净的本地目录，别把上一份写串
    applyFolderName(makeFolderName())
  }

  // ---- 本地文件夹 ----

  const doImportLocal = async () => {
    setLocalBusy(true)
    try {
      const got = await importLocalFolder()
      if (!got) return
      if (!Object.keys(got).length) {
        toast.error(t("lab.files.importEmpty"))
        return
      }
      const merged = { ...filesRef.current, ...got }
      filesRef.current = merged
      setFiles(merged)
      setPreview(buildPreviewDoc(merged))
      setPreviewSeq((s) => s + 1)
      toast.success(t("lab.files.importDone").replace("{n}", String(Object.keys(got).length)))
    } catch (err) {
      toast.error(
        err instanceof Error && err.message === "UNSUPPORTED"
          ? t("lab.files.unsupported")
          : t("lab.err.generic")
      )
    } finally {
      setLocalBusy(false)
    }
  }

  const doExportLocal = async () => {
    const current = filesRef.current
    if (!Object.keys(current).length) {
      toast.error(t("lab.files.exportFirst"))
      return
    }
    setLocalBusy(true)
    try {
      const n = await exportToLocalFolder(current, folderRef.current)
      if (n > 0) {
        toast.success(
          t("lab.files.exportDone")
            .replace("{n}", String(n))
            .replace("{dir}", folderRef.current)
        )
      }
    } catch (err) {
      toast.error(
        err instanceof Error && err.message === "UNSUPPORTED"
          ? t("lab.files.unsupported")
          : t("lab.err.generic")
      )
    } finally {
      setLocalBusy(false)
    }
  }

  // ---- 作品 ----

  const loadProjects = async () => {
    try {
      const res = await labApi.listProjects()
      setProjects(res.projects)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("lab.err.generic"))
    }
  }

  const openProjects = () => {
    setProjectsOpen(true)
    void loadProjects()
  }

  const openProject = async (id: string) => {
    try {
      const { project } = await labApi.getProject(id)
      filesRef.current = project.files
      setFiles(project.files)
      setPreview(buildPreviewDoc(project.files))
      setPreviewSeq((s) => s + 1)
      setPreviewOpen(true)
      setCurrentId(project.id)
      setSaveName(project.name)
      setSaveDesc(project.description)
      // 本地保存目录跟着作品名走
      applyFolderName(makeFolderName(project.name))
      setProjectsOpen(false)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("lab.err.generic"))
    }
  }

  const removeProject = async (p: LabProjectSummary) => {
    if (!window.confirm(t("lab.projects.deleteConfirm"))) return
    try {
      await labApi.deleteProject(p.id)
      setProjects((prev) => prev.filter((x) => x.id !== p.id))
      if (currentId === p.id) setCurrentId(null)
      toast.success(t("lab.projects.deleted"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("lab.err.generic"))
    }
  }

  const doSave = async () => {
    const current = filesRef.current
    if (!Object.keys(current).length) {
      toast.error(t("lab.save.nothing"))
      return
    }
    const name = saveName.trim()
    if (!name) return
    setSaving(true)
    try {
      const res = await labApi.saveProject({
        id: currentId ?? undefined,
        name,
        description: saveDesc.trim(),
        files: current,
      })
      setCurrentId(res.project.id)
      setSaveOpen(false)
      // 还没往本地写过 → 本地目录名跟着作品名（已写过就不动，免得两份目录各留一份）
      if (!autoSavedAt) applyFolderName(makeFolderName(res.project.name))
      toast.success(t("lab.save.saved"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("lab.err.generic"))
    } finally {
      setSaving(false)
    }
  }

  const openInNewTab = () => {
    const doc = buildPreviewDoc(filesRef.current)
    if (!doc) return
    const blob = new Blob([doc], { type: "text/html" })
    const url = URL.createObjectURL(blob)
    window.open(url, "_blank", "noopener")
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const saveCustom = (next: CustomChannel) => {
    setCustom(next)
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(next))
    } catch {
      /* 忽略 */
    }
  }

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] min-h-[520px] flex-col">
      {/* ---- 顶部动作条（预览固定在右上角）---- */}
      <div className="flex shrink-0 items-center justify-end gap-1.5">
        {localOk && (
          <>
            {autoSave && autoSavedAt && !autoNeedPerm && (
              <span className="mr-0.5 hidden text-[11px] tabular-nums text-muted-foreground/80 sm:inline">
                {t("lab.autosave.savedAt").replace(
                  "{t}",
                  new Date(autoSavedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                )}
              </span>
            )}
            <Button
              variant={autoSave && autoDir ? "secondary" : "ghost"}
              size="sm"
              onClick={() => void toggleAutoSave()}
              disabled={autoBusy}
              title={
                autoNeedPerm
                  ? t("lab.autosave.denied")
                  : autoSave
                    ? t("lab.autosave.on").replace("{dir}", folderName)
                    : t("lab.autosave.enable")
              }
            >
              {autoBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <HardDriveDownload className="h-4 w-4" />
              )}
              {autoNeedPerm ? t("lab.autosave.restore") : t("lab.autosave")}
              {autoSave && autoDir && (
                <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />
              )}
            </Button>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={() => setFilesOpen(true)}>
          <FileText className="h-4 w-4" />
          {t("lab.files")}
          {filePaths.length > 0 && (
            <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">
              {filePaths.length}
            </span>
          )}
        </Button>
        <Button variant="ghost" size="sm" onClick={openProjects}>
          <FolderOpen className="h-4 w-4" />
          {t("lab.projects")}
        </Button>
        <Button variant="ghost" size="sm" onClick={newChat}>
          <Plus className="h-4 w-4" />
          {t("lab.newChat")}
        </Button>
        <Button
          variant={previewOpen ? "secondary" : "outline"}
          size="sm"
          onClick={() => setPreviewOpen((v) => !v)}
        >
          <PanelRight className="h-4 w-4" />
          {previewOpen ? t("lab.preview.close") : t("lab.preview")}
          {!previewOpen && preview && (
            <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
          )}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 gap-4 pt-3">
        {/* ---- 主区：上留白（时间线） + 底部长条聊天框 ---- */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            data-lab-timeline=""
            onScroll={() => {
              const el = scrollRef.current
              if (!el) return
              nearBottomRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 120
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {timeline.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground/90 sm:text-3xl">
                  {t("lab.slogan")}
                </h1>
                <p className="mt-2 max-w-md text-sm text-muted-foreground">
                  {t("lab.sloganSub")}
                </p>
              </div>
            ) : (
              <div className="mx-auto w-full max-w-3xl space-y-2.5 py-2">
                {timeline.map((e) => (
                  <TimelineEntry key={e.key} entry={e} />
                ))}
                {/* AI 还没吐出第一个字：在「它该出现的位置」显示等待态 */}
                {streaming && (!live || live.length === 0) && <ThinkingBubble />}
              </div>
            )}
          </div>

          {stationMissing && channel === "station" && (
            <div className="mx-auto mb-2 flex w-full max-w-3xl items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <span className="font-medium">{t("lab.err.notBound")}</span>
                {" — "}
                {t("lab.err.notBoundDesc")}
              </span>
            </div>
          )}

          {/* ---- 草稿安全提示（有内容、且用户没关掉时出现）---- */}
          {filePaths.length > 0 && !draftTipClosed && (
            <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {t("lab.draft.tip")}
                {!currentId && (
                  <span className="text-muted-foreground/80">
                    {" "}
                    {t("lab.draft.tipCloud")}
                  </span>
                )}
              </span>
              {draftSavedAt && (
                <span className="hidden shrink-0 tabular-nums text-muted-foreground/70 sm:inline">
                  {t("lab.draft.savedAt").replace(
                    "{t}",
                    new Date(draftSavedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  )}
                </span>
              )}
              <button
                type="button"
                className="shrink-0 rounded p-0.5 hover:bg-accent"
                title={t("lab.draft.dismiss")}
                onClick={() => setDraftTipClosed(true)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* ---- 长条聊天框（整页唯一一层容器）---- */}
          <div className="mx-auto w-full max-w-3xl shrink-0 pb-1">
            <div className="rounded-[26px] border border-border/70 bg-card/70 shadow-[0_2px_24px_-8px_rgba(0,0,0,0.18)] backdrop-blur-xl transition-[box-shadow,border-color] duration-200 focus-within:border-border focus-within:shadow-[0_6px_32px_-10px_rgba(0,0,0,0.26)]">
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder={t("lab.inputPlaceholder")}
                rows={1}
                className="block max-h-40 min-h-[56px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70"
              />

              <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
                <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-muted/70 p-0.5">
                  <button
                    type="button"
                    onClick={() => setChannel("station")}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs transition-colors",
                      channel === "station"
                        ? "bg-background font-medium shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {t("lab.channel.station")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setChannel("custom")}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs transition-colors",
                      channel === "custom"
                        ? "bg-background font-medium shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {t("lab.channel.custom")}
                  </button>
                </div>

                {channel === "station" ? (
                  <ModelPicker
                    models={models}
                    value={model}
                    loading={modelsLoading}
                    onChange={persistModel}
                  />
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 max-w-[200px] gap-1.5 rounded-full px-2.5 text-xs font-normal text-muted-foreground"
                    onClick={() => setChannelOpen(true)}
                  >
                    <Settings2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      {custom?.model || t("lab.channel.settings")}
                    </span>
                  </Button>
                )}

                <span className="ml-auto hidden shrink-0 text-[11px] text-muted-foreground/80 sm:inline">
                  {streaming ? t("lab.agent.running") : t("lab.inputHint")}
                </span>

                {streaming ? (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0 rounded-full"
                    title={t("lab.stop")}
                    onClick={stop}
                  >
                    <Square className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    className="h-9 w-9 shrink-0 rounded-full"
                    title={t("lab.send")}
                    onClick={() => void send()}
                    disabled={!canSend}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ---- 预览：点右上角按钮才拉出 ---- */}
        {previewOpen && (
          <>
            <div
              className="fixed inset-0 z-30 bg-black/30 lg:hidden"
              onClick={() => setPreviewOpen(false)}
            />
            <aside className="animate-in fade-in slide-in-from-right-4 flex flex-col overflow-hidden rounded-2xl border bg-card shadow-sm duration-300 max-lg:fixed max-lg:inset-x-3 max-lg:top-16 max-lg:bottom-4 max-lg:z-40 max-lg:shadow-2xl lg:w-1/2 lg:shrink-0">
              <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
                <span className="text-sm font-medium">{t("lab.preview")}</span>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    title={t("lab.preview.refresh")}
                    onClick={() => setPreviewSeq((s) => s + 1)}
                    disabled={!preview}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    title={t("lab.preview.newTab")}
                    onClick={openInNewTab}
                    disabled={!preview}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setSaveOpen(true)}
                    disabled={!preview}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {t("lab.save")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    title={t("lab.preview.close")}
                    onClick={() => setPreviewOpen(false)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="relative flex-1 bg-white">
                {preview ? (
                  <iframe
                    key={previewSeq}
                    title="preview"
                    className="h-full w-full border-0"
                    sandbox="allow-scripts allow-modals allow-forms allow-popups"
                    srcDoc={preview}
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-1.5 bg-card px-6 text-center">
                    <p className="text-sm text-muted-foreground">
                      {t("lab.preview.empty")}
                    </p>
                    <p className="text-xs text-muted-foreground/80">
                      {t("lab.preview.emptyDesc")}
                    </p>
                  </div>
                )}
              </div>
            </aside>
          </>
        )}
      </div>

      {/* ---- 项目文件 ---- */}
      <Dialog
        open={filesOpen}
        onOpenChange={(o) => {
          setFilesOpen(o)
          if (!o) setViewFile(null)
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("lab.files")}</DialogTitle>
          </DialogHeader>
          {filePaths.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("lab.files.empty")}
            </p>
          ) : (
            <div className="grid max-h-[50vh] gap-3 sm:grid-cols-[200px_1fr]">
              <div className="space-y-1 overflow-y-auto">
                {filePaths.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setViewFile(p)}
                    className={cn(
                      "block w-full truncate rounded-md px-2 py-1.5 text-left text-xs",
                      (viewFile ?? filePaths[0]) === p
                        ? "bg-accent font-medium"
                        : "hover:bg-accent/60"
                    )}
                    title={p}
                  >
                    {p}
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      {formatBytes(files[p].length)}
                    </span>
                  </button>
                ))}
              </div>
              <pre className="max-h-[50vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                {files[viewFile ?? filePaths[0]] ?? ""}
              </pre>
            </div>
          )}
          <DialogFooter className="sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {localOk && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void doImportLocal()}
                    disabled={localBusy}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t("lab.files.import")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void doExportLocal()}
                    disabled={localBusy || filePaths.length === 0}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {t("lab.files.export")}
                  </Button>
                  <span className="text-[11px] text-muted-foreground">
                    {t("lab.files.folderHint").replace("{dir}", folderName)}
                  </span>
                </>
              )}
            </div>
            <Button variant="outline" onClick={() => setFilesOpen(false)}>
              {t("lab.save.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 自定义渠道设置 ---- */}
      <ChannelDialog
        open={channelOpen}
        onOpenChange={setChannelOpen}
        initial={custom}
        onSave={(next) => {
          saveCustom(next)
          setChannelOpen(false)
          setChannel("custom")
          toast.success(t("lab.channel.saved"))
        }}
      />

      {/* ---- 保存作品 ---- */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("lab.save.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="lab-save-name">{t("lab.save.name")}</Label>
              <Input
                id="lab-save-name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder={t("lab.save.namePlaceholder")}
                maxLength={60}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lab-save-desc">{t("lab.save.description")}</Label>
              <Input
                id="lab-save-desc"
                value={saveDesc}
                onChange={(e) => setSaveDesc(e.target.value)}
                maxLength={200}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("lab.save.filesHint").replace("{n}", String(filePaths.length))}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              {t("lab.save.cancel")}
            </Button>
            <Button onClick={() => void doSave()} disabled={saving || !saveName.trim()}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("lab.save.ok")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 我的作品 ---- */}
      <Dialog open={projectsOpen} onOpenChange={setProjectsOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("lab.projects")}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-1.5 overflow-y-auto">
            {projects.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("lab.projects.empty")}
              </p>
            ) : (
              projects.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 rounded-md border px-3 py-2"
                >
                  <span className="text-lg leading-none">{p.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {new Date(p.updatedAt).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void openProject(p.id)}
                  >
                    {t("lab.projects.open")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    title={t("lab.projects.delete")}
                    onClick={() => void removeProject(p)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ---- 自动保存：首次开启的授权说明 ---- */}
      <Dialog open={autoIntroOpen} onOpenChange={setAutoIntroOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("lab.autosave.introTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2.5 text-sm leading-relaxed text-muted-foreground">
            <p>{t("lab.autosave.introBody1")}</p>
            <p>{t("lab.autosave.introBody2")}</p>
            <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs">
              <p className="font-medium text-foreground">
                {t("lab.autosave.introTitle2")}
              </p>
              <p className="mt-1">{t("lab.autosave.introBody3")}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAutoIntroOpen(false)}>
              {t("lab.save.cancel")}
            </Button>
            <Button
              onClick={() => {
                setAutoIntroOpen(false)
                void beginAutoSave()
              }}
            >
              {t("lab.autosave.introOk")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  )
}

// ---------------------------------------------------------------------------
// 时间线条目
// ---------------------------------------------------------------------------

/** AI 等待态：星标旋转 + 文案流光（仿 Gemini 官网那种） */
function ThinkingBubble() {
  const { t } = useT()
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2.5 rounded-2xl bg-muted px-3.5 py-2.5">
        <Sparkles className="lab-think-icon h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="lab-think-text text-sm">{t("lab.agent.thinking")}</span>
      </div>
    </div>
  )
}

function TimelineEntry({ entry }: { entry: Entry }) {
  if (entry.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground">
          <p className="whitespace-pre-wrap break-words">{entry.text}</p>
        </div>
      </div>
    )
  }
  if (entry.kind === "text") return <ThinkingBlock entry={entry} />
  return <ToolCard entry={entry} />
}

/**
 * 「思考过程」块（仿主流 agent 框架）：
 *   - 流式期间展开、文字逐字出现，标题带流光走马灯；
 *   - 这一轮说完（后面跟着工具调用）就自动折叠成一行，点一下还能展开；
 *   - 如果这段是直接给用户的答复（后面没有动作），就正常当气泡显示。
 */
function ThinkingBlock({ entry }: { entry: Extract<Entry, { kind: "text" }> }) {
  const { t } = useT()
  // 流式期间默认展开；从草稿恢复出来的（live=false）默认就是收起的
  const [open, setOpen] = React.useState(entry.live)
  /** 用户手动点开过就不再自动收起（免得刚展开又被合上） */
  const touched = React.useRef(false)

  React.useEffect(() => {
    if (!entry.live && !touched.current) setOpen(false)
  }, [entry.live])

  // 直接给用户的答复：普通气泡
  if (!entry.collapsible) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
          <p className="whitespace-pre-wrap break-words">
            {entry.text}
            {entry.live && <span className="lab-caret" />}
          </p>
        </div>
      </div>
    )
  }

  const lines = entry.text ? entry.text.split("\n").length : 0

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/30">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          touched.current = true
          setOpen((v) => !v)
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/40"
      >
        <Sparkles
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground",
            entry.live && "lab-think-icon"
          )}
        />
        <span
          className={cn(
            "shrink-0 font-medium",
            entry.live && "lab-think-text"
          )}
        >
          {entry.live ? t("lab.agent.thinking") : t("lab.agent.thought")}
        </span>
        {lines > 1 && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
            {t("lab.agent.thoughtLines").replace("{n}", String(lines))}
          </span>
        )}
        <ChevronRight
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-90"
          )}
        />
      </button>
      {open && (
        <div className="border-t border-border/50 px-3 py-2 text-[13px] leading-relaxed text-muted-foreground">
          <p className="whitespace-pre-wrap break-words">
            {entry.text}
            {entry.live && <span className="lab-caret" />}
          </p>
        </div>
      )}
    </div>
  )
}

const TOOL_ICON: Record<ToolName, typeof FileText> = {
  write: FileText,
  replace: Pencil,
  read: Eye,
  list: List,
  delete: Trash2,
}

function ToolCard({
  entry,
}: {
  entry: Extract<Entry, { kind: "tool" }>
}) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const Icon = TOOL_ICON[entry.tool]
  const lines = entry.content ? entry.content.split("\n").length : 0
  const expandable = Boolean(entry.content)
  const running = entry.status === "running"

  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 overflow-hidden rounded-xl border border-border/70 bg-card/50 duration-200">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left text-xs",
          expandable && "hover:bg-accent/40"
        )}
      >
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground",
            running && "animate-pulse"
          )}
        />
        <span className={cn("shrink-0 font-medium", running && "lab-think-text")}>
          {t(`lab.tool.${entry.tool}`)}
        </span>
        {entry.path && (
          <code className="truncate font-mono text-[11px] text-muted-foreground">
            {entry.path}
          </code>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          {entry.tool === "write" && lines > 0 && (
            <span className="tabular-nums">
              {t("lab.tool.lines").replace("{n}", String(lines))}
            </span>
          )}
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5 text-emerald-500" />
          )}
          {expandable && (
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                open && "rotate-90"
              )}
            />
          )}
        </span>
      </button>
      {open && expandable && (
        <pre className="max-h-64 animate-in fade-in overflow-auto border-t border-border/70 bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed duration-150">
          {entry.content}
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 模型选择器
// ---------------------------------------------------------------------------

function ModelPicker({
  models,
  value,
  loading,
  onChange,
}: {
  models: string[]
  value: string
  loading: boolean
  onChange: (m: string) => void
}) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const [keyword, setKeyword] = React.useState("")

  const filtered = React.useMemo(() => {
    const k = keyword.trim().toLowerCase()
    const list = k ? models.filter((m) => m.toLowerCase().includes(k)) : models
    return list.slice(0, 300)
  }, [models, keyword])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={loading}
          className="flex h-8 min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : null}
          <span className="truncate">
            {loading ? t("lab.model.loading") : value || t("lab.model.placeholder")}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="pointer-events-auto w-72 p-2">
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={t("lab.model.search")}
          className="mb-2 h-8 text-xs"
        />
        <div className="max-h-64 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("lab.model.empty")}
            </p>
          ) : (
            filtered.map((m) => (
              <button
                key={m}
                type="button"
                className={cn(
                  "block w-full truncate rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
                  m === value && "bg-accent font-medium"
                )}
                onClick={() => {
                  onChange(m)
                  setOpen(false)
                }}
              >
                {m}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 自定义渠道设置弹窗 */
function ChannelDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: CustomChannel | null
  onSave: (next: CustomChannel) => void
}) {
  const { t } = useT()
  const [baseUrl, setBaseUrl] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [model, setModel] = React.useState("")

  React.useEffect(() => {
    if (open) {
      setBaseUrl(initial?.baseUrl ?? "")
      setApiKey(initial?.apiKey ?? "")
      setModel(initial?.model ?? "")
    }
  }, [open, initial])

  const submit = () => {
    if (!baseUrl.trim()) {
      toast.error(t("lab.channel.errNoUrl"))
      return
    }
    onSave({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("lab.channel.custom")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t("lab.channel.customHint")}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="lab-ch-url">{t("lab.channel.baseUrl")}</Label>
            <Input
              id="lab-ch-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t("lab.channel.baseUrlPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lab-ch-key">{t("lab.channel.apiKey")}</Label>
            <Input
              id="lab-ch-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("lab.channel.keyPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lab-ch-model">{t("lab.channel.modelName")}</Label>
            <Input
              id="lab-ch-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t("lab.channel.modelPlaceholder")}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("lab.save.cancel")}
          </Button>
          <Button onClick={submit}>{t("lab.channel.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
