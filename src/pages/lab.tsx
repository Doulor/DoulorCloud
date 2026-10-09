import * as React from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import {
  AlertTriangle,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  Gauge,
  Gift,
  Globe,
  HardDriveDownload,
  Info,
  List,
  Loader2,
  PanelRight,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Sparkles,
  Square,
  Terminal,
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
import { confirmDialog } from "@/components/confirm-dialog"
import { AnchoredPanel, isInsideAnchoredPanel } from "@/components/anchored-panel"
import {
  PromptBar,
  SlingButton,
  StatusMark,
  ThoughtLine,
} from "@/components/reactbits"
import { useMotionPref } from "@/hooks/use-motion-pref"
import { clearLabRun, getLabRun, setLabRun, useLabRun } from "@/lib/lab-run"
import { Markdown } from "@/components/markdown"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useT } from "@/i18n"
import {
  applyReplace,
  buildPreviewDoc,
  buildSystemPrompt,
  buildToolResults,
  compactHistory,
  EFFORT_DESC_KEY,
  EFFORT_LABEL_KEY,
  EFFORT_LEVELS,
  EFFORT_TEMPERATURE,
  type EffortLevel,
  grepFiles,
  looksLikeBuildRequest,
  needsToolResult,
  normalizeEffort,
  openPreviewInNewTab,
  parseAgentText,
  parseReplaceContent,
  PROTOCOL_NUDGE,
  CLOSING_NUDGE,
  type FileMap,
  type Segment,
  type ToolName,
} from "@/lib/lab-agent"
import { buildSiteManual, parseSiteArgs, runSiteOp, type SiteOp } from "@/lib/lab-site"
import {
  bootVM,
  formatCommandResult,
  getVmError,
  getVmPhase,
  mountVmScreen,
  runCommand,
  shutdownVM,
  subscribeVm,
  syncProjectFiles,
  type VmPhase,
} from "@/lib/lab-vm"
import {
  deleteSessionDraft,
  deriveSessionTitle,
  loadSessionDraft,
  loadSessionIndex,
  MAX_SESSIONS,
  newSessionId,
  saveSessionDraft,
  setActiveSession,
  type LabDraft,
  type LabSessionMeta,
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
  type LabPromptTemplate,
} from "@/services/api"

/**
 * AI实验室：一个「网页版 agent」。
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
      /** grep 用：搜索的正则 / 范围，展示在卡片上 */
      pattern?: string
      scope?: string
      /** run 用：完整命令（卡片标题上显示） */
      command?: string
      /** site 用：站内操作的 op id（卡片标题上显示） */
      op?: string
      status: "running" | "done"
      content: string
    }

/** 自定义渠道配置（只存浏览器本地） */
interface CustomChannel {
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * 站内三个渠道来源。
 *   · station —— 站内模型（扣自己的中转站额度；管理员开了统一 Key 时是免费试用）
 *   · site    —— 管理员提供的免费渠道（**密钥不下发浏览器**，调用走服务端代理）
 *   · custom  —— 用户自己的自定义渠道（只存本地，浏览器直连）
 */
type LabChannel = "station" | "site" | "custom"

/** 管理员提供的一条免费渠道（前端只拿得到 id / 名字 / 模型） */
interface SiteChannel {
  id: string
  name: string
  model: string
  free: boolean
}

/** `GET /api/lab/channels` 的返回 */
interface SiteChannelsInfo {
  source: "user" | "admin"
  quotaLimit: number
  quotaPeriod: "day" | "month" | "total"
  quotaUsed: number
  channels: SiteChannel[]
}
const CUSTOM_KEY = "doulor.lab.customChannel"
const MODEL_KEY = "doulor.lab.model"
/** 思考强度档位（off/low/medium/high） */
const EFFORT_KEY = "doulor.lab.effort"
/** 自动保存开关（目录句柄存在 IndexedDB 里，见 @/lib/local-fs） */
const AUTOSAVE_KEY = "doulor.lab.autosave"
/** 自动保存的「授权说明」是否已经看过（看过就不再弹） */
const AUTOSAVE_INTRO_KEY = "doulor.lab.autosaveIntro"
/** 本地保存用的「项目子目录名」——每个作品一个文件夹，免得 index.html 互相覆盖 */
const FOLDER_KEY = "doulor.lab.folder"
/**
 * 用户当前选中的「系统提示词模板」id。
 * 管理端可以启用多份模板，用户在这里挑一份；记在本地，下次进来还是这份。
 */
const PROMPT_TEMPLATE_KEY = "doulor.lab.promptTemplate"
/**
 * 「草稿会保留」那条提示被关掉过没有。
 * 它是给**第一次用**的人看的说明，关一次就该永远别再弹 —— 之前只记在组件 state 里，
 * 切一次板块/刷新一次就回来，很烦（2026-10-09 站长反馈）。
 */
const DRAFT_TIP_KEY = "doulor.lab.draftTipClosed"
/**
 * 启用中的模板数量达到这个值才显示切换按钮。
 * 只有 1 份时没得选，显示按钮反而是噪音。
 */
const PROMPT_SWITCH_MIN = 2
/** 自动保存间隔（毫秒）——只是兜底，每轮对话结束也会立刻存一次 */
const AUTOSAVE_INTERVAL = 20_000
/** 草稿落盘防抖（毫秒）：改文件很频繁，攒一攒再往 IndexedDB 写 */
const DRAFT_DEBOUNCE = 600
/**
 * 浏览器终端的「同意」标记（2026-10-09 站长要求无感启用）。
 * 同意过一次就记在 localStorage 里，之后 AI 需要终端时直接开、不再弹窗；
 * 只有**从没同意过**才会看到那一次确认。用户当时点了「不用」＝不写这个标记，下次还会问。
 */
const VM_CONSENT_KEY = "doulor.lab.vmConsent"

function hasVmConsent(): boolean {
  try {
    return localStorage.getItem(VM_CONSENT_KEY) === "1"
  } catch {
    return false
  }
}

function markVmConsent() {
  try {
    localStorage.setItem(VM_CONSENT_KEY, "1")
  } catch {
    /* 隐私模式下写不了就算了：大不了下次再问一遍 */
  }
}

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

/**
 * 解析 SSE 流：正文 delta 交给 onDelta，模型的**思考内容**（reasoning_content）
 * 交给 onReasoning。两家分开走 —— 思考内容不能混进正文，否则会污染标签协议解析。
 */
async function consumeSSE(
  res: Response,
  onDelta: (delta: string) => void,
  onReasoning?: (delta: string) => void
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
            choices?: {
              delta?: { content?: unknown; reasoning_content?: unknown }
            }[]
          }
          const d = j?.choices?.[0]?.delta
          if (typeof d?.content === "string" && d.content) onDelta(d.content)
          // 各种模型/中转站对思考内容的字段名不完全一致，能认的都认一下
          const think =
            (typeof d?.reasoning_content === "string" && d.reasoning_content) ||
            (typeof (d as { reasoning?: unknown } | undefined)?.reasoning ===
              "string" &&
              ((d as { reasoning?: string }).reasoning as string))
          if (think && onReasoning) onReasoning(think)
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
  final: boolean,
  files?: FileMap,
  runResults?: Map<number, string>,
  siteResults?: Map<number, string>
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
        pattern: s.pattern,
        scope: s.scope,
        command: s.tool === "run" ? s.content.trim() : undefined,
        op: s.op,
        status: final || s.complete ? "done" : "running",
        // 结果不来自模型、而在本地现算：grep 命中行 / 终端命令输出 / 站内操作响应
        content: s.complete
          ? s.tool === "grep" && files
            ? grepFiles(files, s.pattern ?? "", s.scope)
            : s.tool === "run" && runResults?.get(i)
              ? runResults.get(i)!
              : s.tool === "site" && siteResults?.get(i)
                ? siteResults.get(i)!
                : s.content
          : s.content,
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
  /**
   * 时间线的最新值 —— **草稿保存只能读它，不能读 state**。
   *
   * 原因：`persistDraft()` 会在 `send()` 里被调用，而 `send()` 是个长 async 函数，
   * 它的闭包在**用户点发送那一刻就定型了** —— 里面的 `entries` 永远是点击时的旧值。
   * （同一处的 `files` 走的是 ref，所以没事，反而把这个 bug 掩盖了很久：
   *   存出来的草稿是「最新文件 + 点击时的聊天记录」，刷新后文件在、聊天记录没了。）
   */
  const entriesRef = React.useRef<Entry[]>([])
  /**
   * 改时间线**必须**走这个函数，不要直接 `setEntries`。
   * 它同步写 ref，保证 `persistDraft()` 无论从哪个闭包里被调用都拿到最新值。
   */
  const updateEntries = React.useCallback(
    (next: Entry[] | ((prev: Entry[]) => Entry[])) => {
      const value = typeof next === "function" ? next(entriesRef.current) : next
      entriesRef.current = value
      setEntries(value)
    },
    []
  )
  /** 当前轮模型的思考内容（reasoning）实时快照 —— 流式期间逐渐长出来 */
  const [liveThink, setLiveThink] = React.useState("")
  /**
   * 本轮思考是否已经「封口」：模型一旦开始输出正文（工具调用），思考就结束了。
   * 不封口的话，思考块会在「已经开始读/写文件」之后还一直转圈，看着像卡住。
   */
  const [thinkSealed, setThinkSealed] = React.useState(false)
  const [input, setInput] = React.useState("")
  const [streaming, setStreaming] = React.useState(false)

  // 预览
  const [preview, setPreview] = React.useState("")
  const [previewSeq, setPreviewSeq] = React.useState(0)
  const [previewOpen, setPreviewOpen] = React.useState(false)

  // ---- 浏览器终端（v86）：跑在用户自己的浏览器里，用户点了才加载 ----
  /** 右侧面板当前显示的是「终端」还是「预览」 */
  const [termTab, setTermTab] = React.useState(false)
  const [vmPhase, setVmPhase] = React.useState<VmPhase>(getVmPhase())
  const [vmError, setVmError] = React.useState(getVmError())
  /** AI 申请启用终端时的确认弹窗 */
  const [vmAskOpen, setVmAskOpen] = React.useState(false)
  const vmAskResolve = React.useRef<((ok: boolean) => void) | null>(null)
  const termScreenRef = React.useRef<HTMLDivElement | null>(null)

  /**
   * 终端是否正显示在右侧面板上（预览面板开着 **且** 停在终端页签）。
   * 空格键守卫的 effect 是空依赖、读不到 state，所以用 ref 把最新值带进去。
   */
  const termVisibleRef = React.useRef(false)
  termVisibleRef.current = previewOpen && termTab

  /**
   * 实验室自己的那套动效/样式（设置页可关，默认开）。
   * 关掉时下面各处的写法会退回原来那套朴素组件 —— 用 `labFxOn ? A : B` 二选一，
   * 不靠「加个 class 再覆盖」，这样关掉之后的样式与改动前**逐字一致**。
   */
  const { labFxOn } = useMotionPref()
  /** 跨挂载的运行态：切走再回来时，思考动画与「停止」按钮靠它接上 */
  const labRun = useLabRun()
  /**
   * 「切回来」而不是「新开一轮」：把运行中接上。
   * 只做一次（空依赖）—— 之后的 running 变化由循环自己维护。
   */
  React.useEffect(() => {
    if (getLabRun().running) setStreaming(true)
  }, [])

  // 模型与渠道
  const [models, setModels] = React.useState<string[]>([])
  const [modelsLoading, setModelsLoading] = React.useState(true)
  const [stationMissing, setStationMissing] = React.useState(false)
  /**
   * 站内凭据失效 —— 与「未开通」必须分开提示。
   *
   * 现场（2026-10-09 站长反馈「有的人开了中转站也有 key，却显示没有站内模型」）：
   * 用户缓存的 access token 过期后，会走「用存库密码重登」这条自愈链；
   * 但有些账号的存库密码在上游已经登不进去了（NewAPI 对凭据不再匹配回 409 Conflict），
   * 于是 /api/lab/models 返回 401 USER_TOKEN_EXPIRED。
   * 前端原先只把 404/NOT_BOUND 当成「未开通」，这条错误落进兜底分支 ⇒
   * 界面上只剩一句「没有可用模型」，用户完全不知道要去重新绑定密码。
   */
  const [stationAuthExpired, setStationAuthExpired] = React.useState(false)
  /** 模型列表拉取失败（非上述两种原因）：用来替换「没有可用模型」，
   *  免得把「请求失败了」显示成「一个模型都没有」。 */
  const [modelsFailed, setModelsFailed] = React.useState(false)
  /** 自增即重新拉一次模型列表（横幅上的「重试」用） */
  const [modelsReloadKey, setModelsReloadKey] = React.useState(0)
  /** agent 的系统提示词（管理面板可配）；空串 = 用前端内置默认 */
  const [agentPrompt, setAgentPrompt] = React.useState("")
  /** 管理端启用中的提示词模板；空数组 = 没启用任何模板（走 agentPrompt / 内置默认） */
  const [promptTemplates, setPromptTemplates] = React.useState<LabPromptTemplate[]>([])
  /** 用户选中的模板 id；空串 = 还没选（自动用第一份） */
  const [promptTemplateId, setPromptTemplateId] = React.useState(
    () => localStorage.getItem(PROMPT_TEMPLATE_KEY) ?? ""
  )
  const [model, setModel] = React.useState(
    () => localStorage.getItem(MODEL_KEY) ?? ""
  )
  /** 思考强度：存在本地，跨会话记住 */
  const [effort, setEffort] = React.useState<EffortLevel>(() =>
    // 用 normalizeEffort 而不是 isEffortLevel：老版本存过 `off` 这类已废弃的档位名，
    // 直接用合法性判断会把它们当非法值、悄悄退回默认 —— 等于把用户的设置吃掉了。
    normalizeEffort(localStorage.getItem(EFFORT_KEY))
  )
  const [channel, setChannel] = React.useState<LabChannel>("station")
  /** 选中的站内免费渠道 id（channel === "site" 时才有意义） */
  const [siteChannelId, setSiteChannelId] = React.useState("")
  /** 管理员提供的免费渠道 + 免费额度余量；拉不到就是 null（功能整体不可见） */
  const [siteInfo, setSiteInfo] = React.useState<SiteChannelsInfo | null>(null)
  /** 站内模型是不是走管理员的统一 Key —— 是的话界面标「免费试用」 */
  const [stationFree, setStationFree] = React.useState(false)
  /**
   * **具体哪些站内模型是免费的**（服务端按管理员的白名单算好下发）。
   *
   * 空数组有两种含义，靠 `stationFree` 区分：整档没开统一 Key，或者
   * 白名单里没有一个模型在上游列表里。徽标只认这个数组 —— 不再用「整档免费」
   * 一刀切，否则白名单外的模型会被错误地标成免费（点了才发现要自己掏额度）。
   */
  const [stationFreeModels, setStationFreeModels] = React.useState<string[]>([])
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
  /** 本轮思考内容的原文累积 + 它的节流刷新计时器 */
  const thinkRef = React.useRef("")
  /** 本轮思考是否已封口（用 ref 是为了在流式回调里同步判断，不等 React 重渲染） */
  const sealedRef = React.useRef(false)
  const thinkTimer = React.useRef<number | null>(null)

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
  const [draftTipClosed, setDraftTipClosed] = React.useState(
    () => localStorage.getItem(DRAFT_TIP_KEY) === "1"
  )
  /** 草稿读过一次之后才允许往回写（否则会把还没恢复的「空」覆盖成草稿） */
  const draftReady = React.useRef(false)

  // ---- 多会话（最多 MAX_SESSIONS 份草稿，随时切回来）----
  /**
   * 会话清单（最近更新在前）。空数组 = 还没存过任何会话。
   * 列表本身只是索引，正文在各份草稿里，切换时才读。
   */
  const [sessions, setSessions] = React.useState<LabSessionMeta[]>([])
  /**
   * 当前会话 id。`null` = 这一个还没落盘（比如刚点「新对话」、
   * 或首次进来还没产生内容）—— 一旦有内容就分配 id 并进列表。
   */
  const [sessionId, setSessionId] = React.useState<string | null>(null)
  const sessionIdRef = React.useRef<string | null>(null)
  const [sessionOpen, setSessionOpen] = React.useState(false)
  /** 会话清单的镜像：防抖回调里读 state 可能拿到旧值，用它判断「是不是满了」 */
  const sessionsRef = React.useRef<LabSessionMeta[]>([])
  /** 会话下拉的锚点（浮层渲染到 body，靠它定位） */
  const sessionBtnRef = React.useRef<HTMLButtonElement | null>(null)
  /**
   * 正在读另一个会话的正文。
   * 期间内存里还是**上一个**会话的内容，若此时防抖落盘触发，
   * 就会把旧内容写进新会话的存档 —— 所以读盘期间直接跳过落盘。
   */
  const sessionLoadingRef = React.useRef(false)

  // ---- 提示词模板切换（管理端启用 ≥2 份时才出现）----
  const [promptOpen, setPromptOpen] = React.useState(false)
  const promptBtnRef = React.useRef<HTMLButtonElement | null>(null)

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

  // ---- 草稿：把工作副本存进 IndexedDB，刷新后原样恢复（多会话版）----

  /**
   * 把一份草稿整份接回工作区（文件 / 时间线 / 对话历史 / 作品信息）。
   * 启动恢复、切换会话、删除后回退三条路径都复用它，保证行为一致。
   */
  const restoreFromDraft = React.useCallback(
    (d: LabDraft<Entry>) => {
      // 切走之前先掐掉正在跑的流 —— 否则旧会话的回复会写进新会话
      abortRef.current?.abort()
      filesRef.current = d.files
      setFiles(d.files)
      updateEntries(d.entries)
      convoRef.current = d.convo
      setCurrentId(d.currentId)
      setSaveName(d.saveName)
      setSaveDesc(d.saveDesc)
      if (d.folderName) applyFolderName(d.folderName)
      setLive(null)
      setLiveThink("")
      thinkRef.current = ""
      setPreview(buildPreviewDoc(d.files))
      setPreviewSeq((s) => s + 1)
      setDraftSavedAt(d.savedAt || Date.now())
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updateEntries]
  )

  /** 会话标题：优先用作品名，其次用第一条用户发言 */
  const sessionTitleOf = React.useCallback(
    (name: string, list: Entry[]) => name.trim() || deriveSessionTitle(list),
    []
  )

  /** 立刻把当前状态写进草稿（返回是否写入成功） */
  const persistDraft = React.useCallback(async (): Promise<boolean> => {
    // 正在换会话、内存里还是上一份内容 → 不写，免得覆盖目标会话
    if (sessionLoadingRef.current) return false
    const snapshot: LabDraft<Entry> = {
      files: filesRef.current,
      entries: entriesRef.current,
      convo: convoRef.current,
      currentId,
      saveName,
      saveDesc,
      folderName: folderRef.current,
      savedAt: Date.now(),
    }
    const hasContent =
      Object.keys(snapshot.files).length > 0 || snapshot.entries.length > 0
    // 空会话不落盘（比如刚点「新对话」）—— 否则每次开新对话都会多出一条空记录
    if (!hasContent) {
      dirtyRef.current = false
      return false
    }
    let id = sessionIdRef.current
    const wasFull = sessionsRef.current.length >= MAX_SESSIONS
    if (!id) {
      // 还没分配会话 id：现在有内容了，认领一个
      id = newSessionId()
      sessionIdRef.current = id
      setSessionId(id)
    }
    const isNewSession = !sessionsRef.current.some((s) => s.id === id)
    const idx = await saveSessionDraft(
      id,
      snapshot,
      sessionTitleOf(saveName, snapshot.entries)
    )
    if (idx) {
      setSessions(idx.sessions)
      sessionsRef.current = idx.sessions
      // 列表本来就满了、这又是一个新会话 ⇒ 最久没动的那份被挤掉了，提个醒
      if (wasFull && isNewSession) {
        toast.warning(
          t("lab.session.evicted").replace("{max}", String(MAX_SESSIONS))
        )
      }
      dirtyRef.current = false
      setDraftSavedAt(snapshot.savedAt)
      return true
    }
    return false
    // 刻意不依赖 entries：它读的是 entriesRef（永远最新）。
    // 放进来反而会掩盖「send() 的旧闭包读到旧时间线」这个问题。
  }, [currentId, saveName, saveDesc, sessionTitleOf])

  /** 打个「有改动」标记，并攒一小会儿再落盘 */
  const markDirty = React.useCallback(() => {
    dirtyRef.current = true
    if (draftTimer.current != null) window.clearTimeout(draftTimer.current)
    draftTimer.current = window.setTimeout(() => {
      draftTimer.current = null
      void persistDraft()
    }, DRAFT_DEBOUNCE)
  }, [persistDraft])

  // 启动时读会话索引，再把「当前会话」整份接回来
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      const idx = await loadSessionIndex()
      if (cancelled) return
      setSessions(idx.sessions)
      sessionsRef.current = idx.sessions
      draftReady.current = true
      if (!idx.activeId) return
      sessionLoadingRef.current = true
      const d = await loadSessionDraft<Entry>(idx.activeId)
      if (cancelled || !d) {
        sessionLoadingRef.current = false
        return
      }
      const hasContent =
        Object.keys(d.files).length > 0 || d.entries.length > 0
      if (!hasContent) {
        sessionLoadingRef.current = false
        return
      }
      sessionIdRef.current = idx.activeId
      setSessionId(idx.activeId)
      restoreFromDraft(d)
      sessionLoadingRef.current = false
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

  // 会话下拉：点外部关闭。
  // ⚠️ 面板由 AnchoredPanel 渲染到 body、不在按钮的容器内，
  //    所以必须用 isInsideAnchoredPanel 单独放行，否则点面板自身会被判成「点了外部」。
  React.useEffect(() => {
    if (!sessionOpen) return
    const onDoc = (e: MouseEvent) => {
      if (isInsideAnchoredPanel(e.target)) return
      if (sessionBtnRef.current && sessionBtnRef.current.contains(e.target as Node)) return
      setSessionOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [sessionOpen])

  // 提示词模板下拉：同样要放行面板自身（它渲染在 body 下）
  React.useEffect(() => {
    if (!promptOpen) return
    const onDoc = (e: MouseEvent) => {
      if (isInsideAnchoredPanel(e.target)) return
      if (promptBtnRef.current && promptBtnRef.current.contains(e.target as Node)) return
      setPromptOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [promptOpen])


  // 初始：拉站内模型列表（顺便探测是否已开通中转站）
  // modelsReloadKey：横幅上的「重试」按钮用它重新触发这个 effect（用户重新绑定完密码后
  // 不用刷新整页就能恢复）。
  React.useEffect(() => {
    let cancelled = false
    // 免费渠道列表与模型列表一起拉：站内没开通时要靠它决定回落到哪儿，
    // 分两次等会让「先闪一下没有模型、再切过去」很跳。
    Promise.allSettled([labApi.channels(), labApi.models()])
      .then(([chRes, mRes]) => {
        if (cancelled) return

        const info = chRes.status === "fulfilled" ? chRes.value : null
        setSiteInfo(info)
        const siteChannels = info?.channels ?? []

        if (mRes.status === "fulfilled") {
          setModels(mRes.value.models)
          setStationFree(!!mRes.value.free)
          setStationFreeModels(mRes.value.freeModels ?? [])
          setModel((prev) => prev || mRes.value.models[0] || "")
          return
        }

        const err = mRes.reason
        const notBound =
          err instanceof HttpError && (err.status === 404 || err.code === "NOT_BOUND")
        // 凭据失效：上游 access token 过期、且存库密码已登不进去。
        // 这不是「没开通」，必须单独引导用户去重新绑定（见 stationAuthExpired 的注释）。
        const expired =
          err instanceof HttpError && err.code === "USER_TOKEN_EXPIRED"
        setStationMissing(notBound)
        setStationAuthExpired(expired)
        setModelsFailed(!notBound && !expired)

        // 站内用不了的两种情况下，优先落到管理员提供的免费渠道：
        // 那是「不用开通也能用」的路径，比让用户自己去配 Key 友好得多。
        if (notBound || expired) {
          if (siteChannels.length > 0) {
            setChannel("site")
            setSiteChannelId((prev) => prev || siteChannels[0].id)
          } else if (loadCustom()) {
            setChannel("custom")
          }
        }
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [modelsReloadKey])

  /**
   * 空格键切换「对话 / 预览」。
   *
   * ⚠️ 必须避开四种情况，否则用户会莫名其妙：
   *   · 输入框 / 可编辑区里的空格是**打字**（聊天框就在这个页面上，撞车最明显）
   *   · 弹层开着时空格是「确认 / 翻页」（Radix 的 dialog 与 popper 都挂在 body 下的 portal 里）
   *   · Cmd/Ctrl/Alt + 空格 是系统快捷键，别抢
   *   · **终端页签在前时归终端**：用户按空格多半是想在终端里输入/翻屏，
   *     此时把整个预览面板切走（连带终端一起消失）非常反直觉。
   */
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (termVisibleRef.current) return
      const el = e.target as HTMLElement | null
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return
      }
      if (
        document.querySelector(
          '[role="dialog"],[role="alertdialog"],[data-radix-popper-content-wrapper]'
        )
      ) {
        return
      }
      e.preventDefault()
      setPreviewOpen((v) => !v)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // agent 的系统提示词（管理面板可配）。拿不到就用内置默认，不影响使用。
  React.useEffect(() => {
    let cancelled = false
    labApi
      .settings()
      .then((res) => {
        if (cancelled) return
        setAgentPrompt(res.agentPrompt || "")
        setPromptTemplates(res.templates ?? [])
      })
      .catch(() => {
        /* 忽略：内置默认提示词照样能跑 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * 真正生效的提示词覆盖值。
   *
   * 优先级：选中的模板 → 管理端的单份覆盖值(`agentPrompt`) → 内置默认（`buildSystemPrompt` 里兜底）。
   * 选中项失效（模板被管理员删了/停用了）时自动回落到第一份，避免用户卡在一份不存在的提示词上。
   */
  const selectedTemplate =
    promptTemplates.find((t) => t.id === promptTemplateId) ?? promptTemplates[0]
  const effectivePrompt = selectedTemplate?.content || agentPrompt

  /** 切换模板并记住选择（模板被删后回落的情况也会顺手纠正记录） */
  React.useEffect(() => {
    if (!promptTemplates.length) return
    const id = selectedTemplate?.id ?? ""
    if (!id || id === promptTemplateId) return
    setPromptTemplateId(id)
    try {
      localStorage.setItem(PROMPT_TEMPLATE_KEY, id)
    } catch {
      /* 隐私模式等：忽略，只是记不住 */
    }
  }, [promptTemplates, selectedTemplate, promptTemplateId])

  // 流式期间：模型的思考内容排在本轮正文之前（跟真实时序一致）
  const timeline: Entry[] = live
    ? [
        ...entries,
        ...(liveThink
          ? [
              {
                key: "live-think",
                kind: "text" as const,
                text: liveThink,
                live: !thinkSealed,
                collapsible: true,
              },
            ]
          : []),
        ...live,
      ]
    : entries
  const timelineLen = timeline.length

  /**
   * 底部常驻状态行的文案：agent 正在做什么。
   * 有正在跑的文件动作就显示它（「正在写入 index.html」），否则就是「正在思考」。
   */
  const workingLabel = React.useMemo(() => {
    if (!streaming) return ""
    const tools = (live ?? []).filter(
      (e): e is Extract<Entry, { kind: "tool" }> => e.kind === "tool"
    )
    const last = tools[tools.length - 1]
    if (last && last.status === "running") {
      const verb = t(`lab.working.${last.tool}`)
      const arg = last.tool === "grep" ? last.pattern : last.path
      return arg ? `${verb} ${arg}` : verb
    }
    return t("lab.working.thinking")
  }, [streaming, live, t])
  /**
   * 动效版「思考中」的文案拆分：
   *   主行恒定「思考中…」，**实时变化的那件事放到副标题**。
   * 这样副标题一换就能看出 agent 在动（没有动作时副标题为空，不显示空行）。
   */
  const fxThoughtLabel = t("lab.working.thinking")

  /**
   * ThoughtLine 的 `steps`：这一轮**已经做过的事**，逐条累计成轨迹。
   * 它就是「正在做的事情」那部分的真实来源 —— tool 条目本来就是本地实时生成的，
   * 所以模型一动、这里就跟着变，不需要额外让模型「汇报进度」。
   */
  const fxSteps = React.useMemo(() => {
    if (!streaming) return [] as string[]
    const tools = (live ?? []).filter(
      (e): e is Extract<Entry, { kind: "tool" }> => e.kind === "tool"
    )
    return tools.map((e) => {
      const verb = t(`lab.working.${e.tool}`)
      const arg =
        e.tool === "grep"
          ? e.pattern
          : e.tool === "run"
            ? e.command?.split("\n")[0]
            : e.path
      return arg ? `${verb} ${arg}` : verb
    })
  }, [streaming, live, t])

  /**
   * PromptBar 的模型清单：把「渠道 + 模型」压成一维列表。
   *
   * 原来渠道（站内 / 免费渠道 / 自定义）是输入框上的一个独立开关，选完再选模型；
   * PromptBar 只有一个模型菜单，所以这里把两者**合成一个 key**（`渠道:模型`），
   * 选中即同时决定渠道和模型 —— 少一次点击，也不会出现「渠道和模型对不上」。
   */
  const fxModels = React.useMemo(() => {
    const out: { key: string; name: string; tag?: string }[] = []
    for (const m of models) {
      out.push({
        key: `station:${m}`,
        name: m,
        tag:
          stationFree && stationFreeModels.includes(m)
            ? t("lab.free.trialBadge")
            : undefined,
      })
    }
    for (const c of siteInfo?.channels ?? []) {
      out.push({ key: `site:${c.id}`, name: c.name, tag: t("lab.free.channelBadge") })
    }
    if (custom?.model) {
      out.push({ key: `custom:${custom.model}`, name: custom.model, tag: t("lab.channel.custom") })
    }
    return out
  }, [models, siteInfo, custom, stationFree, stationFreeModels, t])

  /** PromptBar 的思考强度选项：显示用本地化文案，取值时按下标映射回 EffortLevel */
  const fxEfforts = React.useMemo(
    () => EFFORT_LEVELS.map((lv) => t(EFFORT_LABEL_KEY[lv])),
    [t]
  )

  /**
   * 「+」菜单里的四项。
   * 组件原本带一批**假 demo 数据**（Photos & files / Sales data / Calendar…），
   * 现在换成我们真有的东西。`attach: true` 的那项点击会走 `onAttach`（真开文件选择器）；
   * 其余项由组件把 `@名字` 插进输入框。
   */
  const fxSources = React.useMemo(
    () => [
      { key: "files", name: t("lab.src.files"), description: t("lab.src.filesDesc"), attach: true },
      { key: "site", name: t("lab.src.site"), description: t("lab.src.siteDesc") },
      { key: "skills", name: t("lab.src.skills"), description: t("lab.src.skillsDesc") },
      { key: "web", name: t("lab.src.web"), description: t("lab.src.webDesc") },
    ],
    [t]
  )

  /** 「导入文件」带进来的文本内容：key = 文件名。发送时并进这一轮正文，模型才看得到 */
  const attachedRef = React.useRef<Record<string, string>>({})

  /**
   * 导入文件 —— **纯本地读，不经过服务器**。
   * 只读文本类（txt/md/json/csv/代码/日志…）；图片等二进制只登记名字，
   * 因为「能不能真的看图」取决于渠道是否支持多模态，这里不替它做假设。
   */
  const handleAttach = async (): Promise<string[]> => {
    const picked = await new Promise<FileList | null>((resolve) => {
      const input = document.createElement("input")
      input.type = "file"
      input.multiple = true
      input.onchange = () => resolve(input.files)
      input.click()
    })
    if (!picked?.length) return []
    const names: string[] = []
    for (const f of Array.from(picked)) {
      names.push(f.name)
      // 太大的别塞进上下文：200KB 以上的正文会直接把这一轮撑爆
      if (f.size > 200_000) continue
      const isText =
        /^text\/|json|csv|javascript|xml|html|markdown/.test(f.type) ||
        /\.(txt|md|json|csv|js|ts|tsx|jsx|css|html|yml|yaml|log)$/i.test(f.name)
      if (!isText) continue
      try {
        attachedRef.current[f.name] = await f.text()
      } catch {
        /* 读不了就只留个文件名，不阻断发送 */
      }
    }
    return names
  }

  /** 把带进来的文件内容并进正文（并清空暂存，避免下一轮重复带上） */
  const foldAttachments = (text: string, names: string[]): string => {
    if (!names?.length) return text
    const parts: string[] = []
    for (const n of names) {
      const body = attachedRef.current[n]
      if (body) parts.push(`【文件：${n}】\n${body}`)
    }
    attachedRef.current = {}
    return parts.length ? `${parts.join("\n\n")}\n\n${text}` : text
  }

  /**
   * 用户这一轮在「+」里 @ 了「站内操作」。
   * 命中后**直接把手册塞进系统提示**，不用模型自己先输 `<lab_site_manual/>` 拉一遍。
   */
  const siteOpRef = React.useRef(false)

  /** 从 PromptBar 选中的 key 反解出渠道与模型，并把它们落到我们自己的状态上 */
  const applyFxModel = (key: string | undefined) => {
    if (!key) return
    const i = key.indexOf(":")
    if (i < 0) return
    const ch = key.slice(0, i)
    const val = key.slice(i + 1)
    if (ch === "station") {
      setChannel("station")
      setModel(val)
      try {
        localStorage.setItem(MODEL_KEY, val)
      } catch {
        /* 隐私模式等：忽略 */
      }
    } else if (ch === "site") {
      setChannel("site")
      setSiteChannelId(val)
    } else if (ch === "custom") {
      setChannel("custom")
    }
  }

  /** PromptBar 进来时该选中哪个模型（= 当前渠道 + 当前模型的合成 key） */
  const fxDefaultModelKey =
    channel === "site"
      ? siteChannelId
        ? `site:${siteChannelId}`
        : ""
      : channel === "custom"
        ? custom?.model
          ? `custom:${custom.model}`
          : ""
        : model
          ? `station:${model}`
          : ""
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

  /**
   * 免费额度余量文案（限额为 0 = 不限量时不显示）。
   * 只在有额度上限时才有意义 —— 不限量还给个「剩余 ∞」只是噪音。
   */
  const siteQuotaHint = React.useMemo(() => {
    if (!siteInfo || siteInfo.quotaLimit <= 0) return ""
    return t("lab.free.quotaLeft", {
      left: String(Math.max(0, siteInfo.quotaLimit - siteInfo.quotaUsed)),
      total: String(siteInfo.quotaLimit),
    })
  }, [siteInfo, t])

  /** 选中的站内免费渠道（channel === "site" 时才有值） */
  const activeSiteChannel =
    channel === "site"
      ? siteInfo?.channels.find((c) => c.id === siteChannelId) ?? null
      : null
  /**
   * 真正发给上游的模型名。
   * 免费渠道可以写死模型（渠道按模型售卖时，用户自己改名会直接 404），
   * 写死时以渠道为准，否则用用户在界面里选的。
   */
  const activeModel =
    channel === "station"
      ? model
      : channel === "site"
        ? activeSiteChannel?.model || model
        : custom?.model ?? ""
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

  /** 思考内容也 90ms 一帧地刷 —— 逐字重排同样吃不消 */
  const pushThink = () => {
    if (thinkTimer.current != null) return
    thinkTimer.current = window.setTimeout(() => {
      thinkTimer.current = null
      setLiveThink(thinkRef.current)
    }, 90)
  }

  /** 一轮收尾：停掉思考的流式刷新计时器 */
  const settleThink = () => {
    if (thinkTimer.current != null) {
      window.clearTimeout(thinkTimer.current)
      thinkTimer.current = null
    }
  }

  const persistModel = (m: string) => {
    setModel(m)
    try {
      localStorage.setItem(MODEL_KEY, m)
    } catch {
      /* 隐私模式等：忽略 */
    }
  }

  const persistEffort = (lv: EffortLevel) => {
    setEffort(lv)
    try {
      localStorage.setItem(EFFORT_KEY, lv)
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

  /**
   * 站内操作的「用户确认」闸门 —— 只对**写操作**调用（读操作直接执行）。
   *
   * 为什么用站内确认框而不是原生 confirm：AI 要连做几步时原生弹窗会连弹好几个，
   * 而且看不出到底要删什么；这里把「操作 + 关键参数」摆清楚再让用户点。
   * 用户点取消 ⇒ runSiteOp 直接返回「用户拒绝」，不发出任何请求。
   */
  const approveSite = React.useCallback(
    async (op: SiteOp, args: Record<string, unknown>) => {
      const info = op.confirm?.(args)
      return confirmDialog({
        title: info?.title ?? op.id,
        desc: info?.desc ?? t("lab.site.confirmDesc"),
        detail: info?.detail,
        okText: t("lab.site.confirmOk"),
        cancelText: t("lab.site.confirmCancel"),
        danger: op.danger === true,
      })
    },
    [t]
  )

  const refreshPreview = (bump: boolean) => {
    setPreview(buildPreviewDoc(filesRef.current))
    if (bump) setPreviewSeq((s) => s + 1)
  }

  // 终端状态订阅：加载中 / 就绪 / 出错都会推过来
  React.useEffect(
    () =>
      subscribeVm(() => {
        setVmPhase(getVmPhase())
        setVmError(getVmError())
      }),
    []
  )

  /**
   * 离开本页就关掉虚拟机（2026-10-09 站长要求）。
   * 用户要的是「启动后一直活到退出界面或刷新为止」：
   *   - 刷新：模块内存本来就没了，不用管
   *   - SPA 路由切走（切到别的 dashboard 页）：页面卸载时主动 destroy，别让它在后台空转吃 CPU
   * 重进本页会重新启动 —— 资源已被浏览器缓存，第二次几乎是秒开。
   */
  React.useEffect(() => () => shutdownVM(), [])

  // 终端画面挂载点：面板是条件渲染的，所以 ref 要跟着开关重新登记
  React.useEffect(() => {
    mountVmScreen(termScreenRef.current)
  }, [previewOpen, termTab])

  /**
   * 让 v86 的终端铺满整个卡片。
   *
   * v86 把终端渲染成「容器里第一个 div 里的 25 行文字」，尺寸 = 字号 × 行列数：
   * 默认 12px 时 80×25 只有约 576×400 像素，卡片一大就缩在左上角。
   * 这里按容器**实测**尺寸反推字号与行高，让 80 列 / 25 行刚好铺满，
   * 再通过 CSS 变量交给 `index.css` 的 `.lab-term-screen` 规则下发
   * （那边必须 `!important` —— v86 会往同一个 div 上写内联样式）。
   *
   * ⚠️ 只在终端真正显示时才计算：容器 `hidden` 时 clientWidth/Height 都是 0，
   * 算出来会是一堆无意义的 0。
   */
  React.useEffect(() => {
    if (!previewOpen || !termTab || vmPhase !== "ready") return
    const host = termScreenRef.current
    if (!host) return

    /** v86 硬编码的文本屏网格（见 libv86.js 的 `set_size_text(80, 25)`） */
    const COLS = 80
    const ROWS = 25

    const apply = () => {
      const w = host.clientWidth
      const h = host.clientHeight
      if (!w || !h) return
      // 减掉内边距：clientWidth/Height 是含 padding 的，直接拿会算大一截
      const cs = window.getComputedStyle(host)
      const availW = w - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const availH = h - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      if (availW <= 0 || availH <= 0) return
      // 等宽字体的单字符宽约 0.6em ⇒ 字号 = 可用宽度 / 列数 / 0.6
      const fontSize = Math.max(8, Math.min(32, availW / COLS / 0.6))
      // 行高按高度单独算，保证竖直方向也铺满；给个下限免得字挤在一起
      const lineHeight = Math.max(fontSize * 1.05, Math.min(64, availH / ROWS))
      host.style.setProperty("--lab-term-font", `${fontSize.toFixed(2)}px`)
      host.style.setProperty("--lab-term-line", `${lineHeight.toFixed(2)}px`)
    }

    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(host)
    return () => ro.disconnect()
  }, [previewOpen, termTab, vmPhase])

  /** 把右侧面板切到「终端」页，让启动进度有个地方显示 */
  const revealTermPanel = () => {
    setPreviewOpen(true)
    setTermTab(true)
  }

  /**
   * 问用户「要不要启用浏览器终端」，返回他是点了同意还是拒绝。
   * **只会问到一次**：同意之后就记进 localStorage，以后都走 ensureVM 的自动路径。
   */
  const askVMEnable = () =>
    new Promise<boolean>((resolve) => {
      // 先把终端页拉出来，让用户看得见「点了之后会得到什么」
      revealTermPanel()
      vmAskResolve.current = resolve
      setVmAskOpen(true)
    })

  const answerVM = (ok: boolean) => {
    setVmAskOpen(false)
    const r = vmAskResolve.current
    vmAskResolve.current = null
    r?.(ok)
  }

  /**
   * 确保终端处于可用状态 —— 这是**唯一**的启动入口（AI 申请、用户点「启用」、
   * 用户自己点开终端页，三处都调它）。
   *
   * 无感的关键：**同意过就不再弹窗**。已经同意过的话，这里直接把面板切到终端、
   * 转圈启动；用户只会看到「正在启动 Linux…」，不会被拦一道。
   *
   * 返回 `{ ok }`：ok=false 且没有 error ⇒ 用户拒绝了；有 error ⇒ 启动失败。
   */
  const ensureVM = async (): Promise<{ ok: boolean; error?: string }> => {
    if (getVmPhase() === "ready") return { ok: true }

    if (!hasVmConsent()) {
      const allowed = await askVMEnable()
      if (!allowed) return { ok: false }
      markVmConsent()
    }

    // 走到这里＝已授权：不再打扰，直接把界面切到终端并启动
    revealTermPanel()
    // 给一个明确的状态，别让用户对着空面板猜「怎么卡住了」
    toast.message(t("lab.term.autoOn"), { duration: 2500 })
    try {
      await bootVM()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  /** 用户自己点「启用终端」/ 点开终端页：走同一条无感路径 */
  const enableVMFromPanel = async () => {
    const res = await ensureVM()
    if (res.error) toast.error(res.error)
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

  /**
   * 把「这一轮已经发出的动作」转成给用户看的一行行文字。
   * ThoughtLine 的 steps 与朴素模式的「正在写入 xxx」都从这里来 —— 单一来源，
   * 省得两套文案各写一遍还对不上。
   */
  const actionSteps = (segs: Segment[]): string[] =>
    segs
      .filter((s) => s.type === "action")
      .map((s) => {
        const verb = t(`lab.working.${s.tool}`)
        const arg =
          s.tool === "grep"
            ? s.pattern
            : s.tool === "run"
              ? s.content.split("\n")[0]
              : s.path
        return arg ? `${verb} ${arg}` : verb
      })

  /** 跑一轮：请求 → 流式解析 → 边写边执行 → 返回完整文本 */
  const streamRound = async (
    messages: { role: string; content: string }[],
    signal: AbortSignal,
    round: number,
    applied: Map<number, string>,
    onPreviewTick: () => void
  ): Promise<string> => {
    let res: Response
    if (channel === "station" || channel === "site") {
      res = await streamLabChat({
        model: activeModel,
        messages,
        effort,
        // 温度由这里算好传下去（唯一口径，见 lab-agent.ts 的 EFFORT_TEMPERATURE）
        temperature: EFFORT_TEMPERATURE[effort],
        // 免费渠道只传 id：真实地址与密钥留在服务端，浏览器拿不到
        channelId: channel === "site" ? siteChannelId : undefined,
        signal,
      })
    } else {
      res = await fetch(customEndpoint(custom!.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${custom!.apiKey}`,
        },
        body: JSON.stringify({
          model: custom!.model,
          messages,
          stream: true,
          // 自定义渠道不经过后端，reasoning_effort 各家吃不吃不确定 ⇒ 只带温度（通用安全）
          temperature: EFFORT_TEMPERATURE[effort],
        }),
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
    // 每轮从头开始攒思考内容，别把上一轮的带过来
    thinkRef.current = ""
    setLiveThink("")
    sealedRef.current = false
    setThinkSealed(false)
    await consumeSSE(
      res,
      (delta) => {
        acc += delta
        accRef.current = acc
        // 正文开始了 ⇒ 这一轮的思考已经结束（推理与正文在流里是先后关系），
        // 立刻封口：思考块停止流光、自动折叠，避免「都在改文件了还在转圈」。
        if (!sealedRef.current && acc.trim()) {
          sealedRef.current = true
          setThinkSealed(true)
        }
        const segs = parseAgentText(acc)
        segs.forEach((s, i) => {
          if (s.type === "action" && s.complete && !applied.has(i)) {
            applied.set(i, applyAction(s) ?? "")
          }
        })
        pushLive(segmentsToEntries(segs, round, false, filesRef.current))
        /**
         * 把「跑到哪一步了」同步进模块单例。
         * ⚠️ 这个回调是**循环闭包**，页面卸载后它照样在跑 ——
         *    所以即使切走了，回来时思考动画里的步骤也是最新的（见 lib/lab-run.ts）。
         */
        setLabRun({ steps: actionSteps(segs) })
        const now = Date.now()
        if (now - lastPreview > 700) {
          lastPreview = now
          onPreviewTick()
        }
      },
      (think) => {
        thinkRef.current += think
        pushThink()
      }
    )
    return acc
  }

  /**
   * 发一轮。
   * `override` 给 PromptBar 用 —— 输入框归它管，文字从它那边递过来，
   * 不再是「先写进我们的 state 再读出来」。
   */
  const send = async (override?: string) => {
    const text = (override ?? input).trim()
    if (!text || streaming) return
    if (channel === "station" && (stationMissing || stationAuthExpired)) {
      // 两种情况要分开说：一种是压根没开通，一种是开通了但站内登录失效
      // （后者去重新绑定密码即可，别让用户以为要重新开通）
      //
      // 但如果站里挂着免费渠道，就直接替他切过去 —— 用户要的是「能聊天」，
      // 不是「被教育去开通中转站」。
      if (siteInfo && siteInfo.channels.length > 0) {
        setChannel("site")
        setSiteChannelId((prev) => prev || siteInfo.channels[0].id)
        return
      }
      toast.error(t(stationAuthExpired ? "lab.err.expired" : "lab.err.notBound"))
      return
    }
    if (channel === "site") {
      const picked = siteInfo?.channels.find((c) => c.id === siteChannelId)
      if (!picked) {
        toast.error(t("lab.err.siteChannelGone"))
        setChannel("station")
        return
      }
    }
    if (
      channel === "custom" &&
      (!custom || !custom.baseUrl || !custom.apiKey || !custom.model)
    ) {
      setChannelOpen(true)
      return
    }

    setInput("")
    updateEntries((prev) => [
      ...prev,
      { key: `u-${Date.now()}`, kind: "user", text },
    ])
    convoRef.current = [...convoRef.current, { role: "user", content: text }]
    setStreaming(true)
    accRef.current = ""

    const controller = new AbortController()
    abortRef.current = controller
    /**
     * 告诉「跨挂载单例」这一轮开跑了 —— 切到别的板块时本页会卸载，
     * 但循环不停；回来时靠这个把思考动画接上（否则界面像已经中断了）。
     */
    setLabRun({
      running: true,
      label: t("lab.working.thinking"),
      steps: [],
      abort: controller,
      // 这一轮真正开始的时刻：切走再回来，思考计时接着走而不是重新从 0 开始
      startedAt: Date.now(),
    })

    // 模型偶尔会无视标签协议（把代码写成 markdown 代码块）——只纠正一次，别来回拉扯
    let nudged = false
    /**
     * 「临收尾却一句话不说」的补问是否已经用过。
     * 只给一次机会：万一模型就是不肯开口，也不能让循环卡死。
     * （成因见 lab-agent.ts 的 CLOSING_NUDGE 注释。）
     */
    let closingNudged = false
    let round = 0

    try {
      /**
       * 循环跑到「模型不再要求用工具」为止 —— 不设轮数上限、也不因「连续几轮没改文件」强制中断。
       * 结束条件只有三个：模型自己收尾、用户点停止、或者出错。
       * （`for (;; round++)` 的 `continue` 也会执行 round++，所以计数始终准确。）
       */
      for (;; round++) {
        const messages = [
          {
            role: "system",
            content:
              buildSystemPrompt(filesRef.current, effectivePrompt) +
              (siteOpRef.current
                ? `\n\n## 本轮已启用：站内操作（用户已 @ 指定）\n` +
                  `用户这一轮明确要你处理**站内数据**。手册已经给你了，直接用 <lab_site op="…"> 执行，` +
                  `**不要再输出 <lab_site_manual/> 去拉一遍**。\n\n` +
                  buildSiteManual()
                : ""),
          },
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

        /**
         * 每轮落盘一次。
         * 切到别的侧边栏板块时本页会**卸载**：state 更新不再触发渲染、
         * 依赖 state 的落盘 effect 也不会再跑。但 refs 还活着、循环也在继续 ——
         * 所以这里主动存一次，回到实验室时才看得到这一轮的产出，
         * 而不是「一离开就像停了」（2026-10-09 站长反馈）。
         */
        void persistDraft()

        // ---- 浏览器终端：把 <lab_run> 真的执行掉 ----
        // 终端没就绪时留空（下面会去问用户要不要启用），但绝不在这里静默失败
        const runResults = new Map<number, string>()
        const hasRun = segs.some(
          (s) => s.type === "action" && s.tool === "run" && s.complete
        )
        if (hasRun && getVmPhase() === "ready") {
          try {
            await syncProjectFiles(filesRef.current)
          } catch {
            /* 同步失败也继续：至少还能跑系统自带的命令 */
          }
          for (let i = 0; i < segs.length; i++) {
            const s = segs[i]
            if (s.type !== "action" || s.tool !== "run" || !s.complete) continue
            const cmd = s.content.trim()
            if (!cmd) continue
            try {
              runResults.set(i, formatCommandResult(cmd, await runCommand(cmd)))
            } catch (e: any) {
              runResults.set(i, `[执行命令] ${cmd}\n(执行失败：${e?.message ?? e})`)
            }
          }
        }

        // ---- 站内操作：手册注入 + 真的执行 ----
        // 手册是「按需」的：只有模型自己输出 <lab_site_manual/> 才注入，
        // 免得几千字的手册每轮都占着上下文。
        const siteNotes: string[] = []
        const siteResults = new Map<number, string>()
        if (segs.some((s) => s.type === "action" && s.complete && s.tool === "site_manual")) {
          siteNotes.push(buildSiteManual())
        }
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i]
          if (s.type !== "action" || !s.complete || s.tool !== "site") continue
          const parsed = parseSiteArgs(s.content)
          if ("error" in parsed) {
            siteResults.set(i, `[站内操作 ${s.op || "?"}] 失败：${parsed.error}`)
            continue
          }
          const r = await runSiteOp(s.op ?? "", parsed.value, approveSite)
          siteResults.set(i, r.text)
        }

        // 思考内容归档成这一轮开头的折叠块（用户点开还能看），正文照旧
        const thinkText = thinkRef.current.trim()
        const thinkEntry: Entry[] = thinkText
          ? [
              {
                key: `r${round}-think`,
                kind: "text",
                text: thinkText,
                live: false,
                collapsible: true,
              },
            ]
          : []
        updateEntries((prev) => [
          ...prev,
          ...thinkEntry,
          ...segmentsToEntries(segs, round, true, filesRef.current, runResults, siteResults),
        ])
        setLive(null)
        setLiveThink("")
        thinkRef.current = ""
        settleThink()
        if (liveTimer.current != null) {
          window.clearTimeout(liveTimer.current)
          liveTimer.current = null
        }
        convoRef.current = [...convoRef.current, { role: "assistant", content: raw }]
        refreshPreview(true)
        // 每轮结束立刻落一次本地（比定时器更及时，保住刚生成的稿子）
        void flushAutoSave()
        void persistDraft()

        if (controller.signal.aborted) break
        /**
         * 这一轮「用户看得见的东西」有哪些。
         *   · `saidSomething`：有正文（会被渲染成气泡或折叠块）
         *   · `endedWithAction`：以工具调用收尾 ⇒ 模型明显还没说完
         */
        const saidSomething = segs.some((s) => s.type === "text" && s.text.trim().length > 0)
        const endedWithAction =
          segs.length > 0 && segs[segs.length - 1].type === "action"

        /**
         * 该收尾了，但模型一个字都没说（整轮空、只有思考、或者以动作收尾）——
         * 补问一次，让它有机会把话说完。不回喂的话用户就会看到「干完活一声不响地结束」。
         */
        const shouldNudgeClosing = !saidSomething || endedWithAction
        const mayNudgeClosing = shouldNudgeClosing && !closingNudged

        // 整轮什么都没产出（例如预算全花在思考上，正文是空的）
        if (!segs.length) {
          if (!mayNudgeClosing) break
          closingNudged = true
          convoRef.current = [
            ...convoRef.current,
            { role: "user", content: CLOSING_NUDGE },
          ]
          continue
        }
        const failures = new Map([...applied].filter(([, reason]) => reason))
        const hasAction = segs.some((s) => s.type === "action" && s.complete)
        // 项目还空着、模型只吐了 markdown 代码块、而且用户确实是要做网页 → 提醒它用标签重来（只一次）
        if (
          !hasAction &&
          !nudged &&
          Object.keys(filesRef.current).length === 0 &&
          looksLikeBuildRequest(text) &&
          raw.includes("```")
        ) {
          nudged = true
          convoRef.current = [
            ...convoRef.current,
            { role: "user", content: PROTOCOL_NUDGE },
          ]
          continue
        }
        // ---- 浏览器终端：需要就启动（同意过就直接开，没同意过才弹一次）----
        const wantsVm = segs.some(
          (s) => s.type === "action" && s.tool === "need_vm" && s.complete
        )
        if ((wantsVm || hasRun) && getVmPhase() !== "ready") {
          const res = await ensureVM()
          let note: string
          if (res.ok) {
            note =
              "（系统）浏览器终端已经启动并就绪。项目文件在 /root/project 目录下" +
              "（每次执行命令前会自动同步）。现在可以用 <lab_run> 执行命令了。"
          } else if (res.error) {
            note = `（系统）浏览器终端启动失败：${res.error}。请改用现有的文件工具完成任务，不要再次申请终端。`
          } else {
            note =
              "（系统）用户拒绝启用浏览器终端。请用现有的文件工具完成剩下的工作，不要再申请。"
          }
          // ⚠️ 同一轮里可能还夹着站内操作 —— 这里 `continue` 会跳过下面那段回喂，
          // 所以把手册和站内结果**并进同一条消息**，别把它们丢了。
          const merged: string[] = [note, ...siteNotes]
          if (siteResults.size) merged.push(...siteResults.values())
          convoRef.current = [
            ...convoRef.current,
            { role: "user", content: merged.join("\n\n") },
          ]
          continue
        }

        // ---- 站内操作：把结果（和手册）回喂给模型 ----
        // 必须排在 needsToolResult 之前：站内操作的结果不在 files 里，
        // 走普通回喂路径会拿到空结果。
        if (siteNotes.length || siteResults.size) {
          const parts: string[] = [...siteNotes]
          // 同一轮里可能还夹着文件类的读/搜/跑（模型经常一口气混着来）——
          // 那些结果也必须一起回喂，不能因为走了站内操作分支就丢掉。
          const hasOtherResults =
            failures.size > 0 ||
            segs.some(
              (s) =>
                s.type === "action" &&
                s.complete &&
                (s.tool === "read" ||
                  s.tool === "list" ||
                  s.tool === "grep" ||
                  s.tool === "run" ||
                  s.tool === "delete")
            )
          if (hasOtherResults) {
            parts.push(
              buildToolResults(segs, filesRef.current, failures, runResults, siteResults)
            )
          } else if (siteResults.size) {
            parts.push("工具执行结果：", ...siteResults.values(), "\n请根据结果继续。")
          } else {
            // 只要了手册、还没动手：明确告诉它下一步干什么，免得又空跑一轮
            parts.push(
              "（系统）站内操作手册已给出。现在按手册里的 op 用 <lab_site op=\"…\"> 执行" +
                "用户真正要求的那几步，不要顺手做别的。"
            )
          }
          convoRef.current = [...convoRef.current, { role: "user", content: parts.join("\n\n") }]
          continue
        }

        // 只有「失败的动作」或「读/列/删」才需要回喂一轮
        if (!needsToolResult(segs, failures)) {
          // 收尾机会：模型没留下给用户的话（空轮 / 只思考 / 以动作收尾）⇒ 补问一次
          if (mayNudgeClosing) {
            closingNudged = true
            convoRef.current = [
              ...convoRef.current,
              { role: "user", content: CLOSING_NUDGE },
            ]
            continue
          }
          break
        }
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
        updateEntries((prev) => [
          ...prev,
          ...segmentsToEntries(segs, 99, true, filesRef.current),
        ])
      } else if (err instanceof TypeError) {
        toast.error(t("lab.channel.cors"))
      } else if (err instanceof HttpError) {
        if (err.code === "NOT_BOUND") setStationMissing(true)
        if (
          err.code === "UPSTREAM_ERROR" &&
          /no available channel/i.test(err.message)
        ) {
          toast.error(t("lab.err.modelUnavailable"))
        } else if (err.code === "FREE_QUOTA_EXCEEDED") {
          // 顺手重拉一次渠道信息，把「已用 N 次」刷新到最新
          toast.error(t("lab.err.freeQuota"))
          setModelsReloadKey((k) => k + 1)
        } else if (err.code === "CHANNEL_GONE") {
          toast.error(t("lab.err.siteChannelGone"))
          setModelsReloadKey((k) => k + 1)
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
      // 中途停止/报错时可能还有没归档的思考 —— 别让它凭空消失
      const leftoverThink = thinkRef.current.trim()
      if (leftoverThink) {
        updateEntries((prev) => [
          ...prev,
          {
            key: `think-${Date.now()}`,
            kind: "text",
            text: leftoverThink,
            live: false,
            collapsible: true,
          },
        ])
      }
      thinkRef.current = ""
      setLiveThink("")
      settleThink()
      setLive(null)
      setStreaming(false)
      abortRef.current = null
      // 单例也要清干净：否则切走再回来会显示一个永远转圈的「思考中」
      clearLabRun()
      refreshPreview(true)
      // 同上：这一轮彻底结束，必须落盘一次（卸载后没有任何 effect 会替我们做）
      void persistDraft()
    }
  }

  /** 停止：优先用当前实例的手柄；从别的板块切回来时本实例没有手柄，退回单例里那个 */
  const stop = () => (abortRef.current ?? getLabRun().abort)?.abort()

  /** 切换系统提示词模板（记住选择；下一轮对话生效，已经发出的那轮不变） */
  const choosePromptTemplate = (id: string) => {
    setPromptTemplateId(id)
    setPromptOpen(false)
    try {
      localStorage.setItem(PROMPT_TEMPLATE_KEY, id)
    } catch {
      /* 隐私模式等：忽略，只是记不住 */
    }
  }

  /** 把工作区清成「一张白纸」（不碰任何已有会话的存档） */
  const resetWorkspace = () => {
    updateEntries([])
    setLive(null)
    setLiveThink("")
    thinkRef.current = ""
    convoRef.current = []
    filesRef.current = {}
    setFiles({})
    setPreview("")
    setCurrentId(null)
    setSaveName("")
    setSaveDesc("")
    setResumed(false)
    setDraftTipClosed(false)
    setDraftSavedAt(null)
    // 换一个干净的本地子目录，别把上一份写串
    applyFolderName(makeFolderName())
  }

  /**
   * 开一个新会话。
   *
   * 和以前「清空当前」不同：这里**先把当前这份存好**再清 ——
   * 用户点「新对话」的意图是「再开一条线」，不是「把上一条扔掉」。
   */
  const newChat = async () => {
    if (entries.length > 0 && Object.keys(filesRef.current).length && !currentId) {
      const ok = await confirmDialog({
        title: t("lab.newChat"),
        desc: t("lab.newChatConfirm"),
        okText: t("lab.newChat"),
        danger: true,
      })
      if (!ok) return
    }
    // 存档当前这份（有内容才存得下），再从空白开始
    if (draftReady.current) await persistDraft()
    resetWorkspace()
    // 空白会话先不分配 id：等真产生内容了再认领，免得列表里堆一串空条目
    sessionIdRef.current = null
    setSessionId(null)
    setSessionOpen(false)
  }

  /** 切到另一个会话：先把当前落盘，再把目标整份接回来 */
  const switchSession = async (id: string) => {
    setSessionOpen(false)
    if (id === sessionIdRef.current) return
    if (draftReady.current) await persistDraft()
    // 换会话期间锁住落盘：此刻内存里还是旧内容
    sessionLoadingRef.current = true
    const d = await loadSessionDraft<Entry>(id)
    if (!d) {
      sessionLoadingRef.current = false
      toast.error(t("lab.session.gone"))
      return
    }
    sessionIdRef.current = id
    setSessionId(id)
    restoreFromDraft(d)
    sessionLoadingRef.current = false
    void setActiveSession(id)
  }

  /** 删掉一个会话（连同它的草稿正文） */  const removeSession = async (id: string) => {
    const ok = await confirmDialog({
      title: t("lab.session.delete"),
      desc: t("lab.session.deleteConfirm"),
      okText: t("common.delete"),
      danger: true,
    })
    if (!ok) return
    const next = await deleteSessionDraft(id)
    setSessions(next.sessions)
    sessionsRef.current = next.sessions
    // 删的不是当前这个 → 列表更新即可
    if (id !== sessionIdRef.current) return
    /**
     * 删的正是当前会话。
     * ⚠️ 必须**立刻**把「当前会话」指到替代者（或 null），并且锁住落盘 ——
     * 否则此刻内存里还是刚被删掉的那份内容，一个防抖落盘就会把它原样写回存档里。
     */
    sessionLoadingRef.current = true
    sessionIdRef.current = next.activeId
    setSessionId(next.activeId)
    if (next.activeId) {
      const d = await loadSessionDraft<Entry>(next.activeId)
      if (d) restoreFromDraft(d)
      else resetWorkspace()
    } else {
      resetWorkspace()
    }
    sessionLoadingRef.current = false
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
    const ok = await confirmDialog({
      title: t("lab.projects.delete"),
      desc: t("lab.projects.deleteConfirm"),
      detail: p.name,
      okText: t("lab.projects.delete"),
      danger: true,
    })
    if (!ok) return
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

  /**
   * 在新标签页打开预览。
   *
   * 实现细节（tyu.me 空壳页优先、blob 兜底、为什么不能直接顶层打开 blob）
   * 统一收在 `lib/lab-agent.ts` 的 `openPreviewInNewTab()` 里 —— 造物集也走同一份，
   * 免得两条入口各自实现、修了一处漏另一处。
   */
  const openInNewTab = () => {
    const doc = buildPreviewDoc(filesRef.current)
    if (!doc) return
    if (!openPreviewInNewTab(doc)) {
      // 只有「弹窗被拦」这一种情况需要提示，其余都已就地处理
      toast.error(t("lab.preview.popupBlocked"))
    }
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

  /** 当前会话的标题（没存过就显示「新对话」） */
  const activeSessionTitle =
    sessions.find((s) => s.id === sessionId)?.title ?? ""

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

        {/* 会话列表：最多 MAX_SESSIONS 份草稿，随时切回来 */}
        <div className="relative">
          <Button
            ref={sessionBtnRef}
            variant="ghost"
            size="sm"
            onClick={() => setSessionOpen((v) => !v)}
            aria-expanded={sessionOpen}
            title={t("lab.session.switch")}
          >
            <List className="h-4 w-4" />
            <span className="max-w-[7rem] truncate">
              {activeSessionTitle || t("lab.newChat")}
            </span>
            {sessions.length > 0 && (
              <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">
                {sessions.length}
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </Button>

          <AnchoredPanel
            anchorRef={sessionBtnRef}
            open={sessionOpen}
            onClose={() => setSessionOpen(false)}
            width={288}
            height={320}
          >
            <div className="mb-1.5 flex items-center justify-between gap-2 border-b px-1 pb-1.5">
              <span className="text-xs font-medium">
                {t("lab.session.title")}
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {t("lab.session.count")
                  .replace("{n}", String(sessions.length))
                  .replace("{max}", String(MAX_SESSIONS))}
              </span>
            </div>

            <div className="flex-1 space-y-0.5 overflow-y-auto">
              {sessions.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                  {t("lab.session.empty")}
                </p>
              ) : (
                sessions.map((s) => {
                  const active = s.id === sessionId
                  return (
                    <div
                      key={s.id}
                      className={cn(
                        "group flex items-center gap-1 rounded-md px-1.5 py-1.5 text-xs transition-colors",
                        active ? "bg-accent" : "hover:bg-accent/60"
                      )}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        onClick={() => void switchSession(s.id)}
                      >
                        {active ? (
                          <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                        ) : (
                          <span className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span
                          className={cn(
                            "truncate",
                            active && "font-medium"
                          )}
                        >
                          {s.title || t("lab.session.untitled")}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation()
                          void removeSession(s.id)
                        }}
                        title={t("lab.session.delete")}
                        aria-label={t("lab.session.delete")}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })
              )}
            </div>

            <button
              type="button"
              className="mt-1.5 flex items-center justify-center gap-1.5 rounded-md border border-dashed py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
              onClick={() => void newChat()}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("lab.session.new")}
            </button>
          </AnchoredPanel>
        </div>
        {/* 作品项目（放会话后面 —— 站长要求的顺序：会话 → 项目 → 提示词） */}
        <Button variant="ghost" size="sm" onClick={openProjects}>
          <FolderOpen className="h-4 w-4" />
          {t("lab.projects")}
        </Button>

        {/* 系统提示词模板：管理端启用 ≥2 份时才给切换入口（只有一份时没得选） */}
        {promptTemplates.length >= PROMPT_SWITCH_MIN && (
          <div className="relative">
            <Button
              ref={promptBtnRef}
              variant="ghost"
              size="sm"
              onClick={() => setPromptOpen((v) => !v)}
              aria-expanded={promptOpen}
              title={t("lab.prompt.switch")}
            >
              <Sparkles className="h-4 w-4" />
              <span className="max-w-[7rem] truncate">
                {selectedTemplate?.name || t("lab.prompt.default")}
              </span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </Button>

            <AnchoredPanel
              anchorRef={promptBtnRef}
              open={promptOpen}
              onClose={() => setPromptOpen(false)}
              width={280}
              height={Math.min(320, 72 + promptTemplates.length * 34)}
            >
              <div className="mb-1.5 border-b px-1 pb-1.5 text-xs font-medium">
                {t("lab.prompt.title")}
              </div>
              <div className="flex-1 space-y-0.5 overflow-y-auto">
                {promptTemplates.map((tpl) => {
                  const active = tpl.id === selectedTemplate?.id
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs transition-colors",
                        active ? "bg-accent font-medium" : "hover:bg-accent/60"
                      )}
                      onClick={() => choosePromptTemplate(tpl.id)}
                    >
                      {active ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                      ) : (
                        <span className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className="truncate">{tpl.name}</span>
                    </button>
                  )
                })}
              </div>
              <p className="mt-1.5 px-1 text-[11px] leading-relaxed text-muted-foreground">
                {t("lab.prompt.hint")}
              </p>
            </AnchoredPanel>
          </div>
        )}

        <Button
          variant={previewOpen ? "secondary" : "outline"}
          size="sm"
          onClick={() => setPreviewOpen((v) => !v)}
          title={t("lab.preview.switchHint")}
        >
          <PanelRight className="h-4 w-4" />
          {previewOpen ? t("lab.preview.back") : t("lab.previewLive")}
          {/*
            ⚠️ 这个圆点**必须常驻占位**（不用时才隐藏，而不是不渲染）：
            两种情况文案都是 4 个字（「在线预览」/「回到对话」），宽度本该一模一样，
            但圆点只在关闭态出现 ⇒ 一切换按钮就横向抖一下（2026-10-09 站长反馈）。
            这里改成永远渲染、只切颜色，宽度恒定。
          */}
          <span
            className={cn(
              "ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full",
              !previewOpen && preview ? "bg-primary" : "bg-transparent"
            )}
          />
        </Button>
      </div>

      {/*
        ---- 双屏滑移容器 ----
        对话与预览各占一整屏，并排放进一条 200% 宽的轨道里：
          translateX(0)     → 看到对话（预览停在右边屏幕外）
          translateX(-50%)  → 对话被推到左边屏幕外，预览来到中间
        两个屏幕各自再带一点 rotateY + 缩放，让切换像「卡片甩进来」而不是干巴巴平移。
        缓动用 cubic-bezier(0.76,0,0.24,1)：先慢、中间快、收尾再慢。
      */}
      <div
        className="relative min-h-0 flex-1 overflow-hidden pt-3"
        style={{ perspective: "1600px" }}
      >
        <div
          className="flex h-full w-[200%] transition-transform duration-[640ms] ease-[cubic-bezier(0.76,0,0.24,1)] motion-reduce:transition-none"
          style={{ transform: previewOpen ? "translateX(-50%)" : "translateX(0)" }}
        >
          {/* ---- 左屏：对话（上留白时间线 + 底部长条输入框）---- */}
          <div
            className="h-full w-1/2 shrink-0 min-w-0 pr-2 transition-transform duration-[640ms] ease-[cubic-bezier(0.76,0,0.24,1)] motion-reduce:transition-none sm:pr-3"
            style={{
              transformOrigin: "right center",
              // ⚠️ 静止态**不施加变换**（而不是写一个等价于单位矩阵的 transform）：
              //    父级带 perspective，只要挂着 transform 就会被提升成 3D 图层，
              //    滚动条的命中区域会按变换前的几何算 ⇒ 拖滑块时抓不住（2026-10-09 站长反馈）。
              transform: previewOpen
                ? "rotateY(8deg) scale(0.92) translateZ(-80px)"
                : undefined,
            }}
          >
            <div className="flex h-full min-h-0 flex-col">
          <div
            ref={scrollRef}
            data-lab-timeline=""
            onScroll={() => {
              const el = scrollRef.current
              if (!el) return
              nearBottomRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 120
            }}
            className="lab-timeline min-h-0 flex-1 overflow-y-auto"
          >
            {timeline.length === 0 ? (
              // 空状态整体上移 1/4 屏高：视觉重心落在输入框上方，而不是整块区域的几何中心
              <div
                className="flex h-full flex-col items-center justify-center px-6 text-center"
                style={{ transform: "translateY(-25vh)" }}
              >
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
                {/* 常驻「工作中」状态行：只要 agent 还在跑就一直挂在这，不会中途消失 */}
                {(streaming || labRun.running) &&
                  (labFxOn ? (
                    <ThoughtLine
                      label={labRun.label || fxThoughtLabel}
                      // 挂着时用实时条目（更全）；切回来时用单例里持续更新的那份
                      steps={streaming ? fxSteps : labRun.steps}
                      working
                      fontSize={14}
                      /**
                       * ⚠️ 关掉「流光」是有意的：
                       * 它以 `color-mix(… var(--tl-color) 50%, transparent)` 当背景渐变做文字颜色，
                       * 于是**文字和计时看起来是两个颜色**（文字偏浅、计时是纯色）——
                       * 站长要的是「计时和文字同一个灰」。关掉之后两者都用纯色，颜色就一致了。
                       */
                      shimmer={false}
                      /** 过程文字统一用灰（站长指定），别用正文色 */
                      color="var(--muted-foreground)"
                      /** 用单例里的开始时刻 ⇒ 切走再回来计时接着走，不归零 */
                      startedAt={labRun.startedAt || undefined}
                      className="max-w-[85%]"
                    />
                  ) : (
                    <WorkingIndicator label={workingLabel || labRun.label} />
                  ))}
              </div>
            )}
          </div>

          {stationMissing && channel === "station" && (
            <div className="mx-auto mb-2 flex w-full max-w-3xl items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{t("lab.err.notBound")}</span>
                {" — "}
                {t("lab.err.notBoundDesc")}
              </span>
              {/* 站里挂着免费渠道时给一条明路：用户要的是「能用」，不是「被教育去开通」 */}
              {siteInfo && siteInfo.channels.length > 0 && (
                <button
                  type="button"
                  className="shrink-0 rounded-full border border-current px-2 py-0.5 text-[11px]"
                  onClick={() => {
                    setChannel("site")
                    setSiteChannelId((prev) => prev || siteInfo.channels[0].id)
                  }}
                >
                  {t("lab.channel.site")}
                </button>
              )}
            </div>
          )}

          {stationAuthExpired && channel === "station" && (
            <div className="mx-auto mb-2 flex w-full max-w-3xl items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{t("lab.err.expired")}</span>
                {" — "}
                {t("lab.err.expiredDesc")}
              </span>
              <button
                type="button"
                onClick={() => {
                  setModelsLoading(true)
                  setModelsReloadKey((k) => k + 1)
                }}
                className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium underline underline-offset-2 transition-opacity hover:opacity-70"
              >
                {t("lab.err.retry")}
              </button>
              <Link
                to="/dashboard/ai"
                className="shrink-0 rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-amber-500/30"
              >
                {t("lab.err.rebind")}
              </Link>
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
                onClick={() => {
                  setDraftTipClosed(true)
                  // 记到本地：关一次就永远别再弹（别再只记在 state 里）
                  try {
                    localStorage.setItem(DRAFT_TIP_KEY, "1")
                  } catch {
                    /* 隐私模式等：忽略 */
                  }
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* ---- 长条聊天框 ----
              「AI 实验室动效」开着时用 ReactBits 的 PromptBar：模型选择、思考强度、
              发送/停止都收在那一条里；关掉时用下面这套原来的朴素输入框。
              两者是**二选一**，不靠互相覆盖，所以关掉之后与改动前逐字一致。 */}
          {labFxOn ? (
            <div className="mx-auto w-full max-w-3xl shrink-0 pt-6 mr-[10px] pb-1">
              <PromptBar
                placeholder={t("lab.inputPlaceholder")}
                models={fxModels}
                defaultModel={fxDefaultModelKey}
                efforts={fxEfforts}
                defaultEffort={fxEfforts[EFFORT_LEVELS.indexOf(effort)] ?? ""}
                onEffortChange={(label: string) => {
                  const i = fxEfforts.indexOf(label)
                  if (i >= 0) persistEffort(EFFORT_LEVELS[i])
                }}
      sources={fxSources}
      onAttach={handleAttach}
      busy={streaming}
      onSend={(text: string, detail: { model?: { key: string }; attachments?: string[] }) => {
        applyFxModel(detail?.model?.key)
        // 用户在「+」里明确要动站内数据 ⇒ 这一轮把手册直接给他，别让他再拉一遍
        siteOpRef.current = /@站内操作|@site\b/i.test(text)
        void send(foldAttachments(text, detail?.attachments ?? []))
      }}
                onStop={stop}
      /** 组件里这几处文案写死了英文，按当前语言覆盖掉 */
      labels={{
        effortTitle: t("lab.effortMenu.title"),
        effortHint: t("lab.effortMenu.hint"),
        faster: t("lab.effortMenu.faster"),
        smarter: t("lab.effortMenu.smarter"),
      }}
      width={768}
      radius={26}
      /**
       * ⚠️ 用 `--muted` 而不是 `--card`：我们这个主题里卡片色和页面底色**几乎一样**，
       * 输入框会「没有边界」（2026-10-09 站长反馈）。--muted 在日间是浅灰、夜间是深灰，
       * 两种模式下都能和页面底色区分开。
       */
      background="var(--muted)"
                color="var(--foreground)"
                menuBackground="var(--card)"
                sparkColor="var(--primary)"
                renderSend={({ busy, canSend, trigger }) =>
                  busy ? (
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0 rounded-full"
                      title={t("lab.stop")}
                      onClick={trigger}
                    >
                      <Square className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
          <SlingButton
            size={30}
            strokeWidth={2.5}
            maxPull={90}
            particles={10}
            tapSends
            /**
             * ⚠️ 必须显式传颜色：组件的默认值是**写死的浅色主题**（pad `#f5f5f5` / well `#27272a`），
             * 夜间模式下一个纯黑圆糊在深色背景里（2026-10-10 站长反馈）。
             * 这里全部改用主题变量，日夜自动跟着变。
             */
            padColor="var(--primary)"
            iconColor="var(--primary-foreground)"
            wellColor="var(--primary)"
            bandColor="var(--primary-foreground)"
            accentColor="var(--primary)"
            onSend={trigger}
            disabled={!canSend}
            ariaLabel={t("lab.send")}
            className="shrink-0"
          />
                  )
                }
              />
            </div>
          ) : (
            <div className="mx-auto w-full max-w-3xl shrink-0 pt-6 mr-[10px] pb-1">
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

            <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
              {/*
                一行只放「用哪个模型」和「多想多久」两个按钮。
                渠道切换已收进模型面板（见 ModelPicker），发送按钮在最右 —— 手机上也不挤。
              */}
              <ModelPicker
                models={models}
                value={model}
                loading={modelsLoading}
                failed={modelsFailed}
                onChange={persistModel}
                channel={channel}
                onChannelChange={setChannel}
                custom={custom}
                onEditChannel={() => setChannelOpen(true)}
                stationFree={stationFree}
                stationFreeModels={stationFreeModels}
                siteChannels={siteInfo?.channels ?? []}
                siteChannelId={siteChannelId}
                onSiteChannelChange={setSiteChannelId}
                siteQuotaHint={siteQuotaHint}
              />

              <EffortPicker value={effort} onChange={persistEffort} />

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
          )}
          </div>
        </div>

        {/* ---- 右屏：预览（默认停在屏幕外，滑进来才占中间）---- */}
        <div
          className="h-full w-1/2 shrink-0 min-w-0 pl-2 transition-transform duration-[640ms] ease-[cubic-bezier(0.76,0,0.24,1)] motion-reduce:transition-none sm:pl-3"
          style={{
            transformOrigin: "left center",
            // 同左屏：静止态不挂 transform，避免被提升成 3D 图层而影响滚动条命中
            transform: previewOpen
              ? undefined
              : "rotateY(-8deg) scale(0.92) translateZ(-80px)",
          }}
        >
          <aside className="flex h-full flex-col overflow-hidden rounded-2xl border bg-card shadow-sm">
              <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
                <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
                  <button
                    type="button"
                    onClick={() => setTermTab(false)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs transition-colors",
                      !termTab
                        ? "bg-background font-medium shadow-sm"
                        : "text-muted-foreground"
                    )}
                  >
                    {t("lab.preview")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTermTab(true)
                      // 用户主动点开终端页 = 明确要用 ⇒ 直接启动（同意过就不再问）
                      if (getVmPhase() !== "ready") void enableVMFromPanel()
                    }}
                    className={cn(
                      "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors",
                      termTab
                        ? "bg-background font-medium shadow-sm"
                        : "text-muted-foreground"
                    )}
                  >
                    <Terminal className="h-3 w-3" />
                    {t("lab.term.title")}
                    {vmPhase === "loading" && <Loader2 className="h-3 w-3 animate-spin" />}
                    {vmPhase === "ready" && (
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    )}
                    {vmPhase === "error" && (
                      <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                    )}
                  </button>
                </div>
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
                {/* ---- 浏览器终端（v86）---- */}
                <div
                  className={cn(
                    "relative h-full w-full overflow-hidden bg-[#0f0f14]",
                    !termTab && "hidden"
                  )}
                >
                  {/* v86 会把文本写进这里的第一个 div；canvas 是图形模式的备用位 */}
                  <div
                    ref={termScreenRef}
                    className="lab-term-screen h-full w-full overflow-hidden p-3 font-mono text-[#d6d6e0]"
                  >
                    <div style={{ whiteSpace: "pre", font: "12px/16px monospace" }} />
                    <canvas style={{ display: "none" }} />
                  </div>

                  {vmPhase === "ready" && (
                    <button
                      type="button"
                      onClick={() => shutdownVM()}
                      title={t("lab.term.stop")}
                      className="absolute right-2 top-2 z-10 rounded-md bg-white/10 px-2 py-1 text-[11px] text-[#d6d6e0] transition-colors hover:bg-white/20"
                    >
                      {t("lab.term.stop")}
                    </button>
                  )}

                  {vmPhase !== "ready" && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-[#0f0f14] px-6 text-center">
                      {vmPhase === "off" && (
                        <>
                          <Terminal className="h-6 w-6 text-muted-foreground" />
                          <p className="text-sm text-[#d6d6e0]">{t("lab.term.off")}</p>
                          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                            {t("lab.term.offDesc")}
                          </p>
                          <Button
                            size="sm"
                            className="mt-1"
                            onClick={() => void enableVMFromPanel()}
                          >
                            <Power className="h-3.5 w-3.5" />
                            {t("lab.term.enable")}
                          </Button>
                          <p className="max-w-sm text-[11px] leading-relaxed text-muted-foreground/70">
                            {t("lab.term.cons")}
                          </p>
                        </>
                      )}
                      {vmPhase === "loading" && (
                        <>
                          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                          <p className="text-sm text-[#d6d6e0]">{t("lab.term.loading")}</p>
                          <p className="text-xs text-muted-foreground">
                            {t("lab.term.loadingHint")}
                          </p>
                        </>
                      )}
                      {vmPhase === "error" && (
                        <>
                          <AlertTriangle className="h-6 w-6 text-amber-500" />
                          <p className="text-sm text-[#d6d6e0]">{t("lab.term.failed")}</p>
                          <p className="max-w-sm break-words text-xs text-muted-foreground">
                            {vmError}
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="mt-1"
                            onClick={() => void enableVMFromPanel()}
                          >
                            {t("lab.term.retry")}
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* ---- 作品预览 ---- */}
                <div className={cn("h-full w-full", termTab && "hidden")}>
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
              </div>
          </aside>
        </div>
        </div>

        {/*
          ---- 边缘圆钮 ----
          默认完全隐形（opacity-0），只有鼠标移到这条边缘带（group）上才缓缓浮现。
          位置跟着当前屏走：看着对话 → 贴右边缘；看着预览 → 贴左边缘。
          除了点它，按空格也能切（见下面的 keydown effect）。
        */}
        <div
          className={cn(
            /*
              ⚠️ 贴边时要**让开滚动条那 10px**（`right-[10px]` 而不是 `right-0`）。
              这块 40px 宽的隐形命中区是整条竖边，z-20 压在时间线的滚动条上面，
              结果就是「滚轮能滚、鼠标拖不动滑块」（2026-10-10 站长反馈，实测命中到的
              就是这个元素）。往左让 10px 之后滚动条完全露出来，按钮本身还是贴边的观感。
            */
            "group absolute inset-y-0 z-20 flex w-10 items-center justify-center",
            /*
              贴右边时要让开「左屏的 pr-3（12px）+ 时间线滚动条（10px）」，
              整块命中区必须落在滚动条左侧。实测：`right-[10px]` 时它的右边界
              还在滚动条上（1334~1374 vs 滚动条 1362~1372）⇒ 用 right-6（24px）留出余量。
            */
            previewOpen ? "left-0" : "right-6"
          )}
        >
          <button
            type="button"
            onClick={() => setPreviewOpen((v) => !v)}
            title={t("lab.preview.switchHint")}
            aria-label={t("lab.preview.switchHint")}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full border border-border/70",
              "bg-background/80 text-muted-foreground shadow-sm backdrop-blur",
              "opacity-0 transition-all duration-300 ease-out",
              "group-hover:opacity-100 hover:scale-110 hover:text-foreground",
              "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
          >
            {previewOpen ? (
              <ChevronLeft className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* ---- 启用浏览器终端前的确认（AI 申请时走的也是这一个）---- */}
      <Dialog open={vmAskOpen} onOpenChange={(o) => !o && answerVM(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("lab.term.askTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2.5 text-sm">
            <p className="text-muted-foreground">{t("lab.term.askDesc")}</p>
            <ul className="space-y-1.5 rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
              <li>{t("lab.term.pros")}</li>
              <li>{t("lab.term.cons2")}</li>
            </ul>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => answerVM(false)}>
              {t("lab.term.decline")}
            </Button>
            <Button onClick={() => answerVM(true)}>{t("lab.term.accept")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

/**
 * 「工作中」状态行 —— **常驻**：只要 agent 还在跑，它就一直挂在这里。
 *
 * 为什么改成常驻：以前是「等第一个字才出现、一有内容就消失」，中间还会因为
 * 换轮 / 解析空档闪来闪去，观感上像「它卡住了 / 它跑完了」，用户没法判断到底还在不在干活。
 * 现在文案随当前动作走（正在思考 → 正在写入 index.html → …），期间从不消失。
 */
function WorkingIndicator({ label }: { label: string }) {
  return (
    <div className="flex justify-start" data-lab-working="">
      <div className="flex items-center gap-2.5 rounded-2xl bg-muted px-3.5 py-2.5">
        <Sparkles className="lab-think-icon h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="lab-think-text text-sm">{label}</span>
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

  // 直接给用户的答复：普通气泡。
  // 模型输出走 markdown 渲染 —— 以前是 `whitespace-pre-wrap` 纯文本，
  // `**加粗**`、`- 列表`、```代码块``` 全以**原文**露出来，看着很粗糙。
  if (!entry.collapsible) {
    return (
      <div className="flex justify-start" data-lab-reply="">
        <div
          className={cn(
            "min-w-0 max-w-[85%] rounded-2xl bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground",
            // 流式期间由 CSS（.lab-streaming）往最后一段文字末尾缀闪烁光标
            entry.live && "lab-streaming"
          )}
        >
          <Markdown linkCards={false}>{entry.text}</Markdown>
          {/* 还没吐字时 markdown 里没有任何块级元素，::after 无处可挂，补一个兜底光标 */}
          {entry.live && !entry.text.trim() && <span className="lab-caret" />}
        </div>
      </div>
    )
  }

  const lines = entry.text ? entry.text.split("\n").length : 0
  // 动效模式下这个过程块也要去掉背景胶囊（站长要求：只要文字本身）
  const { labFxOn } = useMotionPref()

  return (
    <div
      className={cn(
        labFxOn
          ? "text-muted-foreground"
          : "overflow-hidden rounded-xl border border-border/60 bg-muted/30"
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          touched.current = true
          setOpen((v) => !v)
        }}
        className={cn(
          "flex w-full items-center gap-2 text-left text-xs",
          labFxOn ? "px-0 py-1" : "px-3 py-1.5 hover:bg-accent/40"
        )}
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
        <div
          className={cn(
            "min-w-0 border-t border-border/50 px-3 py-2 text-[13px] leading-relaxed text-muted-foreground",
            entry.live && "lab-streaming"
          )}
        >
          <Markdown linkCards={false}>{entry.text}</Markdown>
          {entry.live && !entry.text.trim() && <span className="lab-caret" />}
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
  grep: Search,
  need_vm: Power,
  run: Terminal,
  site: Globe,
  site_manual: BookOpen,
}

function ToolCard({
  entry,
}: {
  entry: Extract<Entry, { kind: "tool" }>
}) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const Icon = TOOL_ICON[entry.tool]
  // 工具卡片的状态标要不要用动效版（设置页那个开关）
  const { labFxOn } = useMotionPref()
  const lines = entry.content ? entry.content.split("\n").length : 0
  const expandable = Boolean(entry.content)
  const running = entry.status === "running"
  // 站内操作失败 / 被用户拒绝时别打绿勾 —— 那会让人以为改动已经生效了
  const failed =
    entry.tool === "site" && /\] 失败：|用户拒绝/.test(entry.content ?? "")

  return (
    <div
      className={cn(
        "animate-in fade-in slide-in-from-bottom-1 duration-200",
        // 动效模式：**不要卡片**（站长要求「让文字直接悬浮在空中」），统一灰字；
        // 朴素模式保留原来的卡片外观。
        labFxOn ? "text-muted-foreground" : "overflow-hidden rounded-xl border border-border/70 bg-card/50"
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 text-left text-xs",
          labFxOn ? "px-0 py-1.5" : "px-3 py-2",
          expandable && !labFxOn && "hover:bg-accent/40"
        )}
      >
        {labFxOn ? (
          /*
            动效版：动词前面那枚「转圈 → 打勾 + 划线」的状态标（status-mark 风）。
            ⚠️ 只在本动作**还在跑**时显示：完成后站长不要绿勾、也不要横线划掉
            （2026-10-10 反馈），所以结束态直接退回纯文字。
          */
          running ? (
            <StatusMark
              status="running"
              label={t(`lab.tool.${entry.tool}`)}
              size={15}
              fontSize={12}
              className="shrink-0 font-medium"
            />
          ) : (
            <span className="shrink-0 font-medium">{t(`lab.tool.${entry.tool}`)}</span>
          )
        ) : (
          <>
            <Icon
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground",
                running && "animate-pulse"
              )}
            />
            <span className={cn("shrink-0 font-medium", running && "lab-think-text")}>
              {t(`lab.tool.${entry.tool}`)}
            </span>
          </>
        )}
        {entry.tool === "grep" ? (
          <code className="truncate font-mono text-[11px] text-muted-foreground">
            /{entry.pattern || ""}/{entry.scope ? ` in ${entry.scope}` : ""}
          </code>
        ) : entry.tool === "run" ? (
          <code className="truncate font-mono text-[11px] text-muted-foreground">
            $ {entry.command?.split("\n")[0] ?? ""}
          </code>
        ) : entry.tool === "site" ? (
          <code className="truncate font-mono text-[11px] text-muted-foreground">
            {entry.op || "?"}
          </code>
        ) : (
          entry.path && (
            <code className="truncate font-mono text-[11px] text-muted-foreground">
              {entry.path}
            </code>
          )
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          {entry.tool === "write" && lines > 0 && (
            <span className="tabular-nums">
              {t("lab.tool.lines").replace("{n}", String(lines))}
            </span>
          )}
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : failed ? (
            <X className="h-3.5 w-3.5 text-destructive" />
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
  failed,
  onChange,
  channel,
  onChannelChange,
  custom,
  onEditChannel,
  stationFree = false,
  stationFreeModels = [],
  siteChannels = [],
  siteChannelId = "",
  onSiteChannelChange,
  siteQuotaHint = "",
}: {
  models: string[]
  value: string
  loading: boolean
  /** 拉取失败（不是「一个模型都没有」）—— 空列表时的文案要区分这两种情况 */
  failed?: boolean
  onChange: (m: string) => void
  channel: LabChannel
  onChannelChange: (c: LabChannel) => void
  custom: CustomChannel | null
  onEditChannel: () => void
  /** 站内模型走的是管理员的统一 Key ⇒ 标「免费试用」 */
  stationFree?: boolean
  /**
   * 具体哪些站内模型免费（服务端按白名单算好）。
   * 徽标只认它 —— 管理员可以把白名单收窄到几个模型，其余的不该被标成免费。
   */
  stationFreeModels?: string[]
  /** 管理员提供的免费渠道；为空则不显示「免费渠道」这一档 */
  siteChannels?: SiteChannel[]
  siteChannelId?: string
  onSiteChannelChange?: (id: string) => void
  /** 免费额度余量文案（空则不显示） */
  siteQuotaHint?: string
}) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const [keyword, setKeyword] = React.useState("")

  const filtered = React.useMemo(() => {
    const k = keyword.trim().toLowerCase()
    const list = k ? models.filter((m) => m.toLowerCase().includes(k)) : models
    return list.slice(0, 300)
  }, [models, keyword])

  const isStation = channel === "station"
  const isSite = channel === "site"
  const activeSite = isSite ? siteChannels.find((c) => c.id === siteChannelId) ?? null : null

  const label = isStation
    ? loading
      ? t("lab.model.loading")
      : value || t("lab.model.placeholder")
    : isSite
      ? activeSite?.name || t("lab.channel.sitePick")
      : custom?.model || t("lab.channel.settings")

  /**
   * 渠道三档。中间那档「免费渠道」**有内容才出现** ——
   * 管理员没配渠道时显示一个空列表比不显示更让人困惑。
   */
  const tabs: { key: LabChannel; text: string }[] = [
    { key: "station", text: t("lab.channel.station") },
  ]
  if (siteChannels.length > 0) tabs.push({ key: "site", text: t("lab.channel.site") })
  tabs.push({ key: "custom", text: t("lab.channel.custom") })

  /**
   * 两枚小标刻意分开：
   *   · 站内模型 → 「免费试用」（**会**计入每人的免费额度，用完就没了）
   *   · 免费渠道 → 「免费使用」（站长提供的渠道，同样计数，但语义上是「有这条就能用」）
   * 统一写成一个词会让用户以为两者是同一回事。
   */
  const freeTag = (text: string) => (
    <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] leading-none text-primary">
      {text}
    </span>
  )

  /** 这个模型是不是能白用（服务端已经按白名单算过，这里只做包含判断） */
  const isModelFree = (m: string) => stationFreeModels.includes(m)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-8 min-w-0 max-w-[140px] shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground sm:max-w-[220px]"
        >
          {isStation && loading ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : isStation ? (
            <Sparkles className="h-3.5 w-3.5 shrink-0 opacity-70" />
          ) : isSite ? (
            <Gift className="h-3.5 w-3.5 shrink-0 opacity-70" />
          ) : (
            <Settings2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
          )}
          <span className="truncate">{label}</span>
          {isSite
            ? freeTag(t("lab.free.channelBadge"))
            : isStation && isModelFree(value)
              ? freeTag(t("lab.free.trialBadge"))
              : null}
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="pointer-events-auto w-72 p-2">
        {/*
          渠道切换从输入框常驻位搬到这里（2026-10-09）。
          原来它和模型选择器并排占着输入框底部，加了思考强度之后一行放不下；
          它本来就只影响「用哪个模型」，收进模型面板最自然，输入框也清爽了。
        */}
        {/*
          ⚠️ 这里是「朴素模式」那一支（动效开着时整条输入框都被 PromptBar 换掉了，
          不会走到这儿），所以保持原来的瞬时切换写法即可。
        */}
        <div className="mb-2 flex items-center gap-0.5 rounded-full bg-muted/70 p-0.5">
          {tabs.map(({ key, text }) => (
            <button
              key={key}
              type="button"
              onClick={() => onChannelChange(key)}
              className={cn(
                "flex-1 rounded-full px-2.5 py-1 text-xs transition-colors",
                channel === key
                  ? "bg-background font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {text}
            </button>
          ))}
        </div>

        {isStation ? (
          <>
            {stationFree && (
              <p className="mb-2 rounded-md bg-muted/60 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {t("lab.free.stationHint")}
              </p>
            )}
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t("lab.model.search")}
              className="mb-2 h-8 text-xs"
            />
            <div className="max-h-60 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {failed ? t("lab.err.modelsFailed") : t("lab.model.empty")}
                </p>
              ) : (
                filtered.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
                      m === value && "bg-accent font-medium"
                    )}
                    onClick={() => {
                      onChange(m)
                      setOpen(false)
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{m}</span>
                    {isModelFree(m) && freeTag(t("lab.free.trialBadge"))}
                  </button>
                ))
              )}
            </div>
          </>
        ) : isSite ? (
          <div className="space-y-1">
            <p className="px-1 pb-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t("lab.channel.siteHint")}
            </p>
            {siteChannels.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onSiteChannelChange?.(c.id)
                  setOpen(false)
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
                  c.id === siteChannelId && "bg-accent font-medium"
                )}
              >
                <Gift className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.model && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">{c.model}</span>
                )}
                {freeTag(t("lab.free.channelBadge"))}
              </button>
            ))}
            {siteQuotaHint && (
              <p className="px-1 pt-1.5 text-[11px] text-muted-foreground">{siteQuotaHint}</p>
            )}
          </div>
        ) : (
          <div className="space-y-2 px-1 pt-1 pb-0.5">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {custom?.model
                ? t("lab.channel.current", { model: custom.model })
                : t("lab.channel.notConfigured")}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full gap-1.5 text-xs"
              onClick={() => {
                setOpen(false)
                onEditChannel()
              }}
            >
              <Settings2 className="h-3.5 w-3.5" />
              {t("lab.channel.settings")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * 思考强度滑块（参考 Codex）。
 *
 * 它改两件事：温度（所有模型都生效）+ reasoning_effort（只有推理型模型生效）。
 * 面板里必须把「越高越费时间越费额度」讲明白，别让它看起来像个装饰。
 */
function EffortPicker({
  value,
  onChange,
}: {
  value: EffortLevel
  onChange: (lv: EffortLevel) => void
}) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const max = EFFORT_LEVELS.length - 1
  const idx = EFFORT_LEVELS.indexOf(value)
  /**
   * 滑块的**连续位置**（0..max 的浮点数）。
   *
   * 挡位本身是离散的，但滑块不该「一格一格生跳」—— 拖动时按浮点值走，
   * 只在**取值**时四舍五入到最近的挡位（`Math.round`）。
   * 外部把 value 改掉时（例如恢复默认）再把位置同步过去。
   */
  const [pos, setPos] = React.useState(idx)
  React.useEffect(() => setPos(idx), [idx])
  const pct = max === 0 ? 0 : (pos / max) * 100

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t("lab.effort")}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Gauge className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="tabular-nums">{t(EFFORT_LABEL_KEY[value])}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="pointer-events-auto w-64 p-3">
        <div className="mb-2.5 flex items-baseline justify-between gap-2">
          <p className="text-xs font-medium">{t("lab.effort")}</p>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t(EFFORT_LABEL_KEY[value])}
          </span>
        </div>

        {/* 粗管道滑块：底下是粗轨道，上面盖一层已选进度 + 挡位刻度 + 圆滑块 */}
        <div className="relative h-6">
          <div className="absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-muted" />
          <div
            className="absolute left-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-primary transition-[width] duration-150 ease-out"
            style={{ width: `${pct}%` }}
          />
          {/* 挡位刻度：贴着管道的小凹点，让「有几档」一眼可见 */}
          {EFFORT_LEVELS.map((lv, i) => (
            <span
              key={lv}
              className="absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background/80"
              style={{ left: `${max === 0 ? 0 : (i / max) * 100}%` }}
            />
          ))}
          {/* 圆滑块：位置由浮点值算，所以拖动是连续的 */}
          <div
            className="pointer-events-none absolute top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow-sm transition-[left] duration-150 ease-out"
            style={{ left: `${pct}%` }}
          />
          {/* 真正的输入：完全透明盖在上面，键盘 / 无障碍 / 拖拽都靠它 */}
          <input
            type="range"
            min={0}
            max={max}
            step="any"
            value={pos}
            aria-label={t("lab.effort")}
            onChange={(e) => {
              const v = Number(e.target.value)
              setPos(v)
              onChange(EFFORT_LEVELS[Math.round(v)])
            }}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </div>

        <div className="mt-1.5 flex justify-between">
          {EFFORT_LEVELS.map((lv) => (
            <button
              key={lv}
              type="button"
              onClick={() => onChange(lv)}
              className={cn(
                "rounded px-1 text-[11px] transition-colors",
                lv === value
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(EFFORT_LABEL_KEY[lv])}
            </button>
          ))}
        </div>
        <p className="mt-3 border-t pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {t(EFFORT_DESC_KEY[value])}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
          {t("lab.effort.note")}
        </p>
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
