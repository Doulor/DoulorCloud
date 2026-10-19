import * as React from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { AlertTriangle, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, FileText, FolderOpen, HardDriveDownload, Info, List, Loader2, PanelRight, Plus, Power, RefreshCw, Save, Sparkles, Square, Terminal, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { confirmDialog } from "@/components/confirm-dialog"
import { AnchoredPanel, isInsideAnchoredPanel } from "@/components/anchored-panel"
import { PromptBar, SlingButton, ThoughtLine } from "@/components/reactbits"
import {
  Attachment01Icon,
  Database02Icon,
  Link01Icon,
  Search01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons"
import { compressToLimit } from "@/lib/image-compress"
import { decodeTextBytes, isTextLikeFile, readLabAttachments, type AttachIssueReason, type AttachPayload } from "@/lib/lab-attach"
import { buildSingleFileHtml, downloadBlob, zipFiles } from "@/lib/lab-export"
import { NATIVE_TOOLS } from "@/lib/lab-tools-native"
import { useMotionPref } from "@/hooks/use-motion-pref"
import { clearLabRun, getLabRun, setLabRun, useLabRun } from "@/lib/lab-run"
import { Label } from "@/components/ui/label"
import { useT, tStatic } from "@/i18n"
import { applyReplace, buildPreviewDoc, missingPathReason, buildSystemPrompt, buildToolResults, type LabConvoMessage, type LabConvoPart, compactHistory, nativeToolCallsToSegments, type NativeToolCall, EFFORT_LABEL_KEY, EFFORT_LEVELS, EFFORT_TEMPERATURE, type EffortLevel, grepFiles, looksLikeBuildRequest, needsToolResult, normalizeEffort, openPreviewInNewTab, parseAgentText, parseReplaceContent, PROTOCOL_NUDGE, CLOSING_NUDGE, REPORT_NUDGE, MAX_CLOSING_NUDGES, type FileMap, type Segment, inlineAssets } from "@/lib/lab-agent"
import { buildSiteManual, parseSiteArgs, runSiteOp, type SiteOp } from "@/lib/lab-site"
import { compileLabSources, needsCompile, type CompileError } from "@/lib/lab-compile"
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
import { HttpError, labApi, streamLabChat, type LabProjectSummary, type LabPromptTemplate, type LabSkillIndexEntry } from "@/services/api"

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

import type { CustomChannel, Entry, LabChannel, SiteChannelsInfo } from "./lab/types"
import { ChannelDialog, EffortPicker, ModelPicker, SearchKeyDialog, SkillDialog, TimelineEntry, toolIntent, WidthHandle, WorkingIndicator } from "./lab/parts"
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

/* --------------------------------------------------------------------------
   内容列宽度可拖拽（2026-10-12 站长要求，规格照抄 DeepSeek Harness）
   --------------------------------------------------------------------------
   DSH 的三个常量与解析函数（它的 ConversationWidthControls）：
     · `WIDTH_PREF_KEY`   —— localStorage 里存用户拖出来的宽度（px）
     · `CONTENT_MIN = 640`         —— 最窄：再窄就没法读代码了
     · `CONTENT_EDGE_BUDGET = 176` —— 距可视区两侧各留出的预算
   解析规则：
     `max = max(CONTENT_MIN, 可视宽 - CONTENT_EDGE_BUDGET)`
     有用户偏好 → `clamp(偏好, CONTENT_MIN, max)`
     没有偏好   → DSH 用 `clamp(可视宽 * 0.64, 680, 920)`；
                  **我们这里默认保持 48rem（768px）**，也就是改动前的 `max-w-3xl` ——
                  站长要的是「能调」，不该顺手把大家习惯的默认宽度也改掉。
   -------------------------------------------------------------------------- */
const LAB_WIDTH_KEY = "doulor.lab.contentWidth"
const LAB_CONTENT_MIN = 640
/**
 * 距可视区两侧各留出的预算（总预留 = 这个值）。
 *
 * ⚠️ 2026-10-12 站长反馈「上限不够高、想更宽」：DSH 用的是 176，但**它的布局两侧
 * 还有别的东西**（侧栏、工具条），我们这里整块就是聊天区 ⇒ 176 太保守
 * （1088 宽的可视区只能拉到 912）。改成 64（两侧各 32px）：
 *   · 内容最宽 = 可视宽 − 64（1088 → 1024，比原来多 112px）；
 *   · 手柄在最宽处仍有 12px 可抓（见 index.css 里手柄宽度的 `- 20px`），
 *     不会出现「拉到最大就再也抓不回来」。
 * 还想更宽/更窄就只改这一个数（越小越宽）。
 */
const LAB_CONTENT_EDGE_BUDGET = 64
/** 默认内容宽（= 原来的 max-w-3xl = 48rem = 768px） */
const LAB_CONTENT_DEFAULT = 768

function readLabWidthPref(): number | null {
  try {
    const raw = localStorage.getItem(LAB_WIDTH_KEY)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function resolveLabContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(LAB_CONTENT_MIN, columnWidth - LAB_CONTENT_EDGE_BUDGET)
  if (preference !== null) {
    return Math.min(Math.max(preference, LAB_CONTENT_MIN), max)
  }
  return Math.min(LAB_CONTENT_DEFAULT, max)
}

/* --------------------------------------------------------------------------
   自动「参考网址」（2026-10-12 站长要求：原来是主动触发，改成自动）
   --------------------------------------------------------------------------
   原来必须点「+ → 参考网址 → 贴链接 → 抓取」才会读页面；现在**消息里出现网址
   就自动读**，与手动那条走同一条路（同一个 attachedRef / pendingAttachRef）。
   上限 3 个：再多就等用户自己挑（也免得一条消息卡在抓取上太久）。
   -------------------------------------------------------------------------- */
const LAB_AUTO_REF_MAX = 3

/**
 * 「这一轮看起来卡住了」的判定阈值（毫秒）：这么久**没有任何流事件**（正文/思考/
 * 工具分片都没有）就认为连接死了，允许下一次发送直接收掉它（见 send() 里的守卫）。
 *
 * ⚠️ 2026-10-12 从 90 秒收紧到 20 秒：站长反馈「手机离开一下再回来，发消息还是没反应」
 * —— 手机切走时页面被**冻结**（连计时器都停），回来时连接基本已经断了。
 * 90 秒的阈值意味着「离开 30 秒回来发消息」会被判成「上一轮还活着」⇒ 消息被排进队列，
 * 而「上一轮结束」那一刻永远不来 ⇒ 看起来就是毫无反应。
 */

/**
 * 估算 token 数（用量面板用）。
 * ⚠️ 这是**估算**，不是真实计数：CJK 约 1.6 字/token，其余约 4 字/token。
 * 面板上会标「≈」，不假装精确 —— 真实 usage 需要上游回 stream_options，
 * 上游不一定给（见 lab.tsx 里 metricsRef 的注释）。
 */
function estTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length
  const rest = text.length - cjk
  return Math.round(cjk / 1.6 + rest / 4)
}

/**
 * 本轮改动清单（#5）：对比「这一轮开始前」的快照，列出新增 / 修改 / 删除的文件。
 * 行数差用 ± 表示 —— 模型和用户都能一眼看出"这一轮到底动了什么、动了多少"。
 * 只做展示，不参与任何执行判断。
 */
function diffFileMap(
  before: Record<string, string>,
  after: Record<string, string>
): string[] {
  const rows: string[] = []
  for (const [p, c] of Object.entries(after)) {
    const old = before[p]
    const nowLines = c ? c.split("\n").length : 0
    if (old === undefined) {
      rows.push(`+ ${p}（新增，${nowLines} 行）`)
    } else if (old !== c) {
      const d = nowLines - (old ? old.split("\n").length : 0)
      rows.push(`~ ${p}（${d >= 0 ? "+" : ""}${d} 行，共 ${nowLines} 行）`)
    }
  }
  for (const p of Object.keys(before)) {
    if (!(p in after)) rows.push(`- ${p}（删除）`)
  }
  return rows
}

/** 12_345 → 12.3k（面板里省地方） */
function fmtTok(n: number): string {
  if (n < 1000) return String(n)
  return (n / 1000).toFixed(1) + "k"
}

const STUCK_MS = 20_000

/**
 * 网络类断流最多自动重试几次（见 send() 里那段注释）。
 * 2 次足够扛过「切后台断流」「地铁里信号抖一下」；再多就是上游真挂了，
 * 继续重试只会白烧额度。
 */
const MAX_NET_RETRIES = 2

/** 等页面回到前台（切后台断流时用）；最多等 10 分钟，免得永远挂着 */
function waitUntilVisible(): Promise<void> {
  if (typeof document === "undefined" || !document.hidden) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      document.removeEventListener("visibilitychange", onVis)
      window.clearTimeout(timer)
      resolve()
    }
    const onVis = () => {
      if (!document.hidden) done()
    }
    document.addEventListener("visibilitychange", onVis)
    const timer = window.setTimeout(done, 600_000)
  })
}

/** 匹配正文里的 http(s) 链接（排除空白、引号、中英文括号等紧邻字符） */
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`）)】\]}，。；！？、]+/gi

/**
 * 从一段文字里挑出要抓的网址。
 * ⚠️ 末尾常粘着标点（「看看 https://a.com。谢谢」）⇒ 剪掉尾部的标点再返回，
 * 否则请求会带上 `。` 直接 404。
 */
function extractUrls(text: string): string[] {
  const out: string[] = []
  for (const raw of text.match(URL_IN_TEXT_RE) ?? []) {
    const url = raw.replace(/[.,;:!?，。；：！？、）)】》"']+$/g, "")
    if (!url || out.includes(url)) continue
    out.push(url)
  }
  return out
}

/**
 * 是否已同意启动浏览器终端。
 * 🔴 **默认视为已同意**（站长 2026-10-13 要求：默认就是同意状态，AI 该静默启动终端）。
 * 只有显式关掉过（写入 "0"）才再问一次；隐私模式下 localStorage 抛异常也按已同意。
 */
function hasVmConsent(): boolean {
  try {
    return localStorage.getItem(VM_CONSENT_KEY) !== "0"
  } catch {
    return true
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
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`
  return tStatic("lab.folder.defaultName", { stamp })
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
 * 流「一个字节都没来」多久算死连接（毫秒）。
 *
 * ⚠️ 2026-10-12 从 180 秒收紧到 45 秒：手机上切走再回来，用户根本不会等 3 分钟
 * —— 他要的是"回来就能继续"。45 秒的完全静默（正文/思考/工具分片全都没有）
 * 在正常调用里极少出现（真思考时也会有 reasoning 增量）。
 */
const STREAM_IDLE_MS = 45_000

/** 读流空闲超时抛出的错误（区别于 CORS/断网，可重试） */
class StreamIdleError extends Error {
  constructor() {
    super("stream idle timeout")
    this.name = "StreamIdleError"
  }
}

/**
 * 给任意 promise 套上「空闲 / 回到前台时陈旧」守卫（2026-10-12）。
 *
 * 两种判定与 readWithIdle 完全一致（见其注释）：
 *   ① 整整 idleMs 没有进展（这里指「没有新数据」，由调用方在活动时刷新 getLastActivity）；
 *   ② 页面从后台回到前台时，距上次活动已经超过 staleMs —— **立刻**判定，不等定时器。
 * 用于 **fetch（等响应头）** 和 **读流** 两处：两者都可能永远挂着。
 * ⚠️ 守卫触发只 reject 这个 promise，**不**动调用方的中止信号 ——
 *    这样上层才能把它当成「可重试的网络类失败」自动重试。
 */
function withIdleGuard<T>(
  p: Promise<T>,
  idleMs: number,
  staleMs: number,
  getLastActivity: () => number
): Promise<T> {
  let timer: number | undefined
  let rejectRef: ((e: unknown) => void) | undefined
  const onVisible = () => {
    if (!document.hidden && Date.now() - getLastActivity() > staleMs) {
      rejectRef?.(new StreamIdleError())
    }
  }
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      rejectRef = reject
      timer = window.setTimeout(() => reject(new StreamIdleError()), idleMs)
      document.addEventListener("visibilitychange", onVisible)
    }),
  ]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer)
    document.removeEventListener("visibilitychange", onVisible)
  })
}

/**
 * 读一段流；两种情况都算「连接死了」，抛 StreamIdleError（可重试）：
 *   ① 整整 idleMs 没有任何数据（定时器）；
 *   ② **页面从后台回到前台时，距上次数据已经超过 staleMs** —— 手机上切走会冻结页面，
 *      连接多半已经断了；这时**立刻**判定，不用再干等定时器（站长反馈
 *      「手机离开一下再回来，发消息还是没反应」：等定时器要等太久，用户以为坏了）。
 */
async function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  staleMs: number,
  getLastActivity: () => number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: number | undefined
  const onVisible = () => {
    if (!document.hidden && Date.now() - getLastActivity() > staleMs) {
      rejectRef?.(new StreamIdleError())
    }
  }
  let rejectRef: ((e: unknown) => void) | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        rejectRef = reject
        timer = window.setTimeout(() => reject(new StreamIdleError()), idleMs)
        document.addEventListener("visibilitychange", onVisible)
      }),
    ])
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
    document.removeEventListener("visibilitychange", onVisible)
  }
}

/**
 * 解析 SSE 流：正文 delta 交给 onDelta，模型的**思考内容**（reasoning_content）
 * 交给 onReasoning。两家分开走 —— 思考内容不能混进正文，否则会污染标签协议解析。
 */
async function consumeSSE(
  res: Response,
  onDelta: (delta: string) => void,
  onReasoning?: (delta: string) => void,
  /**
   * 原生工具调用：上游分片传来的 `tool_calls` 在这里**按 index 拼好**。
   *
   * ⚠️ **每次分片变化都会回调一次**（不是流结束才回调）——
   * 这样工具卡片能像主流 agent 那样**函数名一到就出现**、参数边流边填。
   * 调用方拿到的永远是一份**当前快照**；最后一次回调才是完整结果。
   */
  onToolCalls?: (calls: NativeToolCall[]) => void,
  /**
   * 取「最近一次流里有动静的时刻」——回到前台时靠它判断这一轮是不是已经陈旧
   * （见 readWithIdle 的 ②；不传就用 Date.now()，等于不做前台陈旧判定）
   */
  getLastActivity: () => number = () => Date.now()
): Promise<void> {
  const reader = res.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buf = ""
  /**
   * 工具调用的分片累积表：index → {id, name, args}。
   * ⚠️ 上游是**按 index 分片**传的：先给 id 和 name，arguments 一段一段来，
   *    必须按 index 累积并**拼接** arguments（这不是"最后一个覆盖前面"的字段）。
   */
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()
  try {
    for (;;) {
      /**
       * 🔴 读流带**空闲超时**（2026-10-12 站长反馈「消息发出去什么回应都没有，
       * 连正在思考都不显示」的真凶之一）。
       *
       * 半开连接（切后台被中断、中间设备悄悄断链）下 `reader.read()` 会**永远挂着**：
       * 不 resolve、也不 reject ⇒ 这一轮的 `finally` 永远不跑 ⇒ `streaming` 一直停在
       * true ⇒ **之后每次发送都被 `if (streaming) return` 静默吞掉**（而且 PromptBar
       * 已经先清了输入框，用户看到的就是「消息没了、什么都没发生」）。
       * 给它一个上限：这么久一个字节都没有，就当成死连接抛出去（可重试）。
       */
      const { done, value } = await readWithIdle(
        reader,
        STREAM_IDLE_MS,
        STUCK_MS,
        getLastActivity
      )
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
          // ---- 原生工具调用分片 ----
          const tcs = (d as { tool_calls?: unknown } | undefined)?.tool_calls
          if (Array.isArray(tcs)) {
            for (const raw of tcs) {
              const tc = raw as {
                index?: number
                id?: string
                function?: { name?: string; arguments?: string }
              }
              const idx = typeof tc.index === "number" ? tc.index : 0
              const cur = toolAcc.get(idx) ?? { id: "", name: "", args: "" }
              if (typeof tc.id === "string" && tc.id) cur.id = tc.id
              if (typeof tc.function?.name === "string" && tc.function.name) {
                cur.name = tc.function.name
              }
              if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments
              toolAcc.set(idx, cur)
            }
            // 立刻把快照报出去 ⇒ 卡片实时出现、参数实时长
            if (onToolCalls) onToolCalls(snapshotToolCalls(toolAcc))
          }
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
  // 收尾再报一次：保证调用方最后拿到的一定是**完整**快照
  if (onToolCalls && toolAcc.size) onToolCalls(snapshotToolCalls(toolAcc))
}

/** 把累积表整理成一份「当前快照」（按 index 排序、丢掉还没名字的） */
function snapshotToolCalls(
  acc: Map<number, { id: string; name: string; args: string }>
): NativeToolCall[] {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, v]) => ({
      // 极少数上游不给 id；缺失时自己造一个稳定的，免得回喂时对不上
      id: v.id || `call_${idx}`,
      name: v.name,
      args: v.args,
    }))
    .filter((c) => c.name)
}

/** 把「解析出来的片段」变成时间线上的条目 */
function segmentsToEntries(
  segs: Segment[],
  round: number,
  final: boolean,
  files?: FileMap,
  runResults?: Map<number, string>,
  siteResults?: Map<number, string>,
  skillResults?: Map<number, string>,
  searchResults?: Map<number, string>,
  httpResults?: Map<number, string>,
  /** 产出这一轮的模型名（写到文本消息上，工具栏要显示） */
  model?: string
): Entry[] {
  const out: Entry[] = []
  segs.forEach((s, i) => {
    /**
     * 🔴 工具卡片的 key 用**工具调用 id**，不用数组下标（2026-10-12 修）。
     *
     * 下标 key 的坑：流式期间正文是**边流边长**的，而实时视图固定拼成
     * `[正文…, 工具卡片…]` ⇒ 正文段一多，工具卡片的下标就往后挪
     * （`r0-0` → `r0-1`…）⇒ key 变了 ⇒ React 认为换了一个组件 ⇒ **重新挂载**
     * ⇒ 卡片里「展开/收起」的 state 被重置。
     * 表现：点开写入卡片想看内容，几十毫秒后它自己合上了（站长反馈
     * 「给写入框加个粘住」——其实先得让它别自己合上）。
     * toolCallId 一轮内唯一且稳定 ⇒ 下标怎么变都对应同一个 DOM。
     */
    const key =
      s.type === "action" && s.toolCallId ? `r${round}-${s.toolCallId}` : `r${round}-${i}`
    if (s.type === "text") {
      // 后面还跟着文件动作 → 这段是「思考/计划」，折叠起来；
      // 后面没有动作 → 是给用户的最终答复，正常显示。
      // ⚠️ 这里**不能**要求动作已经 complete：流式期间动作天然是未完成的，
      // 若加上 complete 条件，旁白会先渲染成普通气泡、直到这一轮结束才「变成」折叠块，
      // 用户看到的就是「气泡一闪、忽然被收进思考块」。
      /**
       * ⚠️ 曾经这里是 `segs.slice(i + 1).some(有 action)`，即「后面跟着工具调用就折叠」。
       * 那个判据是**错的**，2026-10-10 站长反馈「模型一轮一直在做事、基本没说过正文」：
       * 模型说的每一句「我先看一下 X」「搞清楚了」后面都紧跟着工具调用，
       * 于是**整轮的话全被折进思考块**，用户什么都看不到。
       *
       * 现在：**正文一律不折叠**。真正该折叠的是模型的推理 ——
       * 它走的是另一条路（`reasoning_content` → liveThink → collapsible: true），
       * 与正文严格分开。这也与主流 agent 的行为一致：
       * 模型说的话照常显示，只有推理才收起来。
       */
      const collapsible = false
      out.push({
        key,
        kind: "text",
        text: s.text,
        live: !final,
        collapsible,
        model,
        at: Date.now(),
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
        skill: s.skill,
        desc: s.desc,
        url: s.url,
        httpMethod: s.httpMethod,
        image: s.image,
        // 未收尾但本轮已结束 ⇒ failed（多半被上游截断），不能再显示成绿勾
        status: s.complete ? "done" : final ? "failed" : "running",
        // 结果不来自模型、而在本地现算：grep 命中行 / 终端命令输出 / 站内操作响应
        content: s.complete
          ? s.tool === "grep" && files
            ? grepFiles(files, s.pattern ?? "", s.scope)
            : s.tool === "run" && runResults?.get(i)
              ? runResults.get(i)!
              : s.tool === "site" && siteResults?.get(i)
                ? siteResults.get(i)!
                : s.tool === "skill" && skillResults?.get(i)
                  ? skillResults.get(i)!
                  : s.tool === "web_search" && searchResults?.get(i)
                    ? searchResults.get(i)!
                    : s.tool === "http" && httpResults?.get(i)
                      ? httpResults.get(i)!
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

/**
 * 识别「二进制素材」在项目表里的形态（data URL）。
 * 素材对话框原本会把整串 base64 直接铺进 `<pre>`（图片也一样），
 * 一行几十万字符既卡又没法看 —— 这里改成按类型给出真正的预览。
 */
function dataUrlMeta(content: string): { mime: string; bytes: number } | null {
  const m = /^data:([^;,]+)(;base64)?,/i.exec(content)
  if (!m) return null
  const body = content.length - m[0].length
  // base64 每 4 个字符 3 字节；URL 编码的文本按字符数粗略估算
  return { mime: m[1].toLowerCase(), bytes: m[2] ? Math.floor((body * 3) / 4) : body }
}

/** 单个素材超过体积上限（与「读取失败」区分开，提示文案不同） */
class AssetTooLarge extends Error {}

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
  /**
   * `streaming` 的 ref 镜像：send() 里要**轮询等待**上一轮收尾（中止卡住的那轮），
   * 那时闭包里的 state 是旧的，只能读 ref。
   */
  const streamingRef = React.useRef(false)
  streamingRef.current = streaming
  /**
   * 最近一次「流里有动静」的时刻（正文/思考/工具分片任一到达就刷新）。
   * 用来判断这一轮是还活着、还是卡死了（见 send() 开头的守卫与 STUCK_MS）。
   */
  const lastActivityRef = React.useRef(Date.now())
  /** 是否正处于「断线自动重试」中（跨作用域用：send 里置位、streamRound 里复位） */
  const retryingRef = React.useRef(false)
  /**
   * 本轮用量指标（2026-10-12 站长要求，仿 DSH 的上下文状态显示）：
   * 上下文占用、分项（系统提示 / 工具声明 / 对话历史）、首 token 耗时、生成速度。
   *
   * ⚠️ token 是**估算**（见 estTokens）；首 token 与速度是**实测**。
   * 之所以不用真实 usage：那要求上游支持 `stream_options:{include_usage:true}`，
   * 而中转站不一定支持，发过去还有被 400 的风险 —— 先用估算，标「≈」。
   */
  const [metrics, setMetrics] = React.useState<{
    system: number
    tools: number
    history: number
    context: number
    ttftMs: number | null
    tokPerSec: number | null
    outTokens: number
    rounds: number
  } | null>(null)
  const metricsRef = React.useRef<{
    start: number
    first: number | null
    outChars: number
    rounds: number
    ctx: { system: number; tools: number; history: number }
  }>({ start: 0, first: null, outChars: 0, rounds: 0, ctx: { system: 0, tools: 0, history: 0 } })

  // 预览
  const [preview, setPreview] = React.useState("")
  const [previewSeq, setPreviewSeq] = React.useState(0)
  const [previewOpen, setPreviewOpen] = React.useState(false)
  /**
   * JSX / TS 源码的编译错误。
   * 作品里写了 `.jsx`/`.tsx`/`.ts` 时，保存与预览前会就地编译成 `.js`；
   * 编不过就把错误显示出来（不要静默失败 —— 否则用户只看到白屏，无从下手）。
   */
  const [compileErrors, setCompileErrors] = React.useState<CompileError[]>([])

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
   * **隐藏的终端画面挂载点**（2026-10-13）。
   *
   * 背景：v86 必须有一个真实尺寸的 DOM 容器才能跑；原来画面只挂在终端面板里，
   * 而面板是条件渲染的 ⇒ AI 申请终端时如果不把界面切过去，容器就是 null、
   * 虚拟机根本起不来（我试过直接不切界面，结果 run 永远拿不到输出）。
   * 所以这里常驻一个**移出视口**的容器：界面留在聊天页，虚拟机照常在后台跑。
   * ⚠️ 用 left:-10000px 而不是 display:none —— 后者量不到尺寸，v86 会算不出画面。
   */
  const hiddenVmRef = React.useRef<HTMLDivElement | null>(null)

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
  /**
   * 可用技能的**索引**（只有名字 + 一句话，没有正文）。
   * 渐进式披露：这份索引拼进系统提示当目录；模型点名某个技能时才去调 readSkill 取正文。
   * 技能是账号级的（站点默认 ∪ 自己导入的），所以从 /lab/settings 一起下发。
   */
  const [labSkills, setLabSkills] = React.useState<LabSkillIndexEntry[]>([])
  /**
   * 用户有没有打开「联网搜索」（**默认关**）。
   * 关着时**根本不把 <lab_web_search> 告诉模型** —— 这样它不会去试，
   * 也就不会走站点 key 花掉这个用户的积分。
   */
  const [webSearchOn, setWebSearchOn] = React.useState(false)
  /**
   * 「中途插话」队列（2026-10-10 站长要求）。
   * 正在跑的时候用户又说了话，不能直接开新的一轮（会把当前这轮的状态搅乱），
   * 所以先排在这儿，等这一轮跑完自动接着发。
   *
   * 🔴 2026-10-12 改成**可见队列**（站长反馈「插话后既看不到、也改不了、也不能立刻发」）：
   *    以前只存在 ref 里 ⇒ 界面上毫无痕迹。现在用 state 存（ref 做镜像给 effect 用），
   *    时间线上会渲染成「待发送」气泡，带**编辑 / 立即发送 / 撤回**三个动作。
   */
  const [steerQueue, setSteerQueue] = React.useState<
    { id: string; text: string; at: number }[]
  >([])
  /** 队列的镜像：effect 里读 state 会拿到旧闭包值，所以同步写一份 ref */
  const steerRef = React.useRef<{ id: string; text: string; at: number }[]>([])
  const pushSteer = (text: string) => {
    const item = { id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, at: Date.now() }
    steerRef.current = [...steerRef.current, item]
    setSteerQueue(steerRef.current)
  }
  const dropSteer = (id: string) => {
    steerRef.current = steerRef.current.filter((s) => s.id !== id)
    setSteerQueue(steerRef.current)
  }
  /**
   * 往输入框里「填字」的信号（编辑历史消息用）。
   * 输入框的草稿归 PromptBar 自己管，所以只能给它一个信号让它自己填；
   * `at` 是时间戳 —— 每次点编辑都换一个新对象，哪怕文本一样也要重新填。
   */
  const [seedDraft, setSeedDraft] = React.useState<{ text: string; at: number } | null>(null)
  /** 「技能」对话框（从输入框「+」菜单进来） */
  const [skillOpen, setSkillOpen] = React.useState(false)
  /** 「联网搜索」对话框：看状态 / 填自己的 Tavily key */
  const [searchKeyOpen, setSearchKeyOpen] = React.useState(false)
  /** 「参考网址」对话框：贴个链接，把页面正文抓回来当上下文 */
  const [refOpen, setRefOpen] = React.useState(false)
  const [refDraft, setRefDraft] = React.useState("")
  const [refBusy, setRefBusy] = React.useState(false)
  /**
   * 从「参考网址」进来的附件名（不在 PromptBar 的附件列表里，
   * 所以单独记一份，发送时并进去）。存的是 URL 本身 —— 气泡里显示网址最直观。
   */
  const pendingAttachRef = React.useRef<string[]>([])

  /**
   * 「参考网址」附件的正文头 —— 这段会**原样进模型上下文**，所以也要跟界面语言走
   * （英文界面下模型不该再读到中文，2026-10-14）。
   */
  const refHeader = (url: string, truncated: boolean): string =>
    t("lab.ref.header", {
      url,
      note: truncated ? t("lab.ref.headerTruncated") : "",
    })

  /** 抓一个网址当参考。抓回来的正文按「文本附件」处理，与导入文件走同一条路 */
  const fetchRef = async () => {
    const url = refDraft.trim()
    if (!url) return
    setRefBusy(true)
    try {
      // 「参考网址」是用户主动要参考一个页面 ⇒ **原样抓 HTML**（要能看见类名/结构/内联样式，
      // 转纯文本就把样式信息全丢了，那用户就没法「照着这个做」）。
      const r = await labApi.http({ url, raw: true })
      attachedRef.current[url] = { text: refHeader(url, r.truncated) + r.body }
      if (!pendingAttachRef.current.includes(url)) pendingAttachRef.current.push(url)
      setRefOpen(false)
      setRefDraft("")
      toast.success(t("lab.ref.done"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("lab.ref.failed"))
    } finally {
      setRefBusy(false)
    }
  }
  /**
   * 自动「参考网址」（2026-10-12 站长要求）：**消息里出现网址就自动读进来**，
   * 不用再点「+ → 参考网址」。
   *
   * 与手动那条完全同路：抓到的正文写进 `attachedRef`、名字进 `pendingAttachRef`，
   * 随后 `takeAttachments` 会把它并进给模型的正文里（气泡上也显示网址）。
   *
   * 几个刻意的取舍：
   *   · **并行抓**（`allSettled`）：串行抓 3 个页面最坏要等 3 个超时；
   *   · 单个失败**不影响整条消息**（模型照样能看到网址本身，也能自己再抓）；
   *   · 已经在 `attachedRef` 里的（手动抓过 / 本轮已抓）跳过，不重复抓；
   *   · 抓取期间显示「正在读取网页…」，否则用户会以为发送卡住了。
   */
  const autoAttachUrls = async (
    text: string
  ): Promise<{ done: string[]; failed: number }> => {
    const urls = extractUrls(text)
      .filter((u) => !attachedRef.current[u])
      .slice(0, LAB_AUTO_REF_MAX)
    if (!urls.length) return { done: [], failed: 0 }
    setLabRun({
      running: true,
      label: t("lab.ref.autoReading"),
      steps: [],
      startedAt: Date.now(),
    })
    try {
      const results = await Promise.allSettled(
        urls.map((url) => labApi.http({ url, raw: true }))
      )
      const done: string[] = []
      let failed = 0
      results.forEach((r, i) => {
        if (r.status !== "fulfilled") {
          failed += 1
          return
        }
        const url = urls[i]
        attachedRef.current[url] = { text: refHeader(url, r.value.truncated) + r.value.body }
        if (!pendingAttachRef.current.includes(url)) pendingAttachRef.current.push(url)
        done.push(url)
      })
      return { done, failed }
    } finally {
      clearLabRun()
    }
  }

  /**
   * 重新拉 /lab/settings 的触发器。
   * 用户导入新技能后，系统提示里的「技能目录」必须跟着更新，
   * 否则要刷新整页才生效 —— 那就太反直觉了。
   */
  const [settingsKey, setSettingsKey] = React.useState(0)
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
  /**
   * 正在导出哪个作品（null = 没开）。
   * 导出放在**作品目录**里而不是工具栏：导出的是「某个作品」，
   * 而工具栏那一份只能导当前工作区，语义对不上（2026-10-10 站长要求挪进来）。
   */
  const [exportFor, setExportFor] = React.useState<string | null>(null)
  const [exportFiles, setExportFiles] = React.useState<Record<string, string> | null>(null)
  const [exportBusy, setExportBusy] = React.useState(false)
  /**
   * ⚠️ 绑定域名的 UI **已搬到造物集**（2026-10-12 站长要求：不要放在实验室的
   * 「我的作品」里）。这里只保留作品列表本身，域名相关的 state/弹窗/按钮全部移除 ——
   * 见 src/pages/gallery.tsx 的 EditDialog（gal.domain.*）。
   */
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
  const convoRef = React.useRef<LabConvoMessage[]>([])
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
  /** 「已经放出来的思考文本」长度 —— pushThink 的渐进显示靠它同步判断进度（见其注释） */
  const thinkShownRef = React.useRef(0)

  /* ---- 内容列宽度（可拖拽，规格见文件顶部 LAB_WIDTH_KEY 那段注释）---- */
  /** 拖拽容器（= 可视区）：手柄相对它定位，CSS 变量也设在它身上 */
  const widthBoxRef = React.useRef<HTMLDivElement | null>(null)
  /** 用户拖出来的宽度偏好（null = 没拖过，用默认） */
  const widthPrefRef = React.useRef<number | null>(readLabWidthPref())
  /** 实际生效的内容宽（经过 min/max 钳制），写进 `--lab-content-width` */
  const [contentWidth, setContentWidth] = React.useState(LAB_CONTENT_DEFAULT)
  /**
   * 重新解析一次生效宽度。
   * ⚠️ 必须在**容器尺寸变化**时也重算：窗口缩小后旧的偏好可能超过可用宽度
   * （DSH 用 ResizeObserver 做这件事，我们照抄）。
   */
  const publishWidth = React.useCallback(() => {
    const box = widthBoxRef.current
    if (!box) return
    setContentWidth(resolveLabContentWidth(box.offsetWidth, widthPrefRef.current))
  }, [])
  React.useEffect(() => {
    const box = widthBoxRef.current
    if (!box) return
    publishWidth()
    const ro = new ResizeObserver(() => publishWidth())
    ro.observe(box)
    return () => ro.disconnect()
  }, [publishWidth])
  /** 手柄开始拖：以「当前生效宽度」为基准（不是偏好值 —— 可能已被窗口挤小） */
  const onWidthStart = React.useCallback(() => contentWidth, [contentWidth])
  /** 拖动中：钳制后写进 CSS 变量（WidthHandle 已用 rAF 节流） */
  const onWidthDrag = React.useCallback((w: number) => {
    const box = widthBoxRef.current
    if (!box) return
    setContentWidth(resolveLabContentWidth(box.offsetWidth, w))
  }, [])
  /** 松手：把最终宽度落盘，下次进来还是这个宽度 */
  const onWidthCommit = React.useCallback((w: number) => {
    const box = widthBoxRef.current
    if (!box) return
    const final = resolveLabContentWidth(box.offsetWidth, w)
    widthPrefRef.current = final
    try {
      localStorage.setItem(LAB_WIDTH_KEY, String(final))
    } catch {
      /* 隐私模式：记不住就算了 */
    }
  }, [])
  /** 松手后重算一次（窗口可能在拖动期间变过） */
  const onWidthEnd = React.useCallback(() => publishWidth(), [publishWidth])

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
    thinkShownRef.current = 0
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
      // 读取出错也按「丢失」处理（.catch(() => null)），别让整个页面白屏
      const d = await loadSessionDraft<Entry>(idx.activeId).catch(() => null)
      if (cancelled) {
        sessionLoadingRef.current = false
        return
      }
      if (!d) {
        /**
         * ⚠️ 索引里有当前会话、但草稿正文读不出来 ⇒ 这才是**真正的进度丢失**
         * （浏览器清了存储、或写入中途被打断）。这种必须告诉用户，不能装没事。
         * 与之相对：能正常恢复是**预期行为**（每次进来都会恢复），不该弹提示。
         */
        toast.error(t("lab.draft.lost"))
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
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 🔴 「继续创作」（2026-10-12 站长要求）：从造物集把已发布作品的文件拉回来。
   *
   * 造物集那边点「继续创作」时，把作品的文件塞进 sessionStorage 的
   * `doulor.lab.import` 再跳过来；这里挂载时认领一次（拿完立刻删，
   * 防止刷新重复导入）。载入方式与草稿恢复一致 —— 走 restoreFromDraft
   * 的同一套结构（时间线空、对话历史空：这是「文件的续作」，不是对话的续集）。
   */
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      let payload: { id?: string; name?: string; description?: string; files?: Record<string, string> } | null = null
      try {
        const raw = sessionStorage.getItem("doulor.lab.import")
        if (!raw) return
        sessionStorage.removeItem("doulor.lab.import")
        payload = JSON.parse(raw)
      } catch {
        return
      }
      if (cancelled || !payload) return
      const files = payload.files ?? {}
      if (!Object.keys(files).length) return
      // 等「草稿恢复」做完再动手（否则它随后会把恢复的草稿盖回来）
      for (let i = 0; i < 20 && sessionLoadingRef.current; i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (cancelled) return
      // 先清空当前工作区，再把作品的文件作为新起点
      resetWorkspace()
      filesRef.current = files
      setFiles(files)
      setCurrentId(payload.id ?? null)
      setSaveName(payload.name ?? "")
      setSaveDesc(payload.description ?? "")
      // 注意：这里要先编译（作品里可能有 .jsx/.tsx），再生成预览 —— 所以统一走 refreshPreview
      await refreshPreview(true)
      toast.success(t("gal.continueDone"))
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
          setModel((prev) => prev || mRes.value.models[0] || mRes.value.freeModels?.[0] || "")
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
        setLabSkills(res.skills ?? [])
        setWebSearchOn(res.webSearch?.enabled === true)
        // 用户导入技能后要重新拿目录才能生效 —— 由 SkillDialog 关闭时触发一次刷新
        // （这里只是记录加载成功，见 loadLabSettings 的调用点）
      })
      .catch(() => {
        /* 忽略：内置默认提示词照样能跑 */
      })
    return () => {
      cancelled = true
    }
  }, [settingsKey])

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

  /**
   * 流式期间：模型的思考内容排在本轮正文之前（跟真实时序一致）。
   *
   * 🔴 思考块**不能等 `live` 有内容才显示**（2026-10-12 站长反馈
   * 「思考过程非流式：卡半天啥都不显示，第一个动作出现时突然刷出一长串」）：
   * `live` 要等**正文或工具调用**到达才有内容 —— 而「纯想」阶段两者都没有，
   * 思考块就被挡在时间线外面，攒到几十行后随第一个动作一起砸出来。
   * 修法：`liveThink` 非空就显示（哪怕 `live` 还是空的）。
   */
  const timeline: Entry[] =
    live || liveThink
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
          ...(live ?? []),
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
      // 人话文案统一走 toolIntent（见 lab/parts.tsx 的注释）
      return toolIntent(t, last)
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
    return tools.map((e) => toolIntent(t, e))
  }, [streaming, live, t])

  /**
   * PromptBar 的模型清单：把「渠道 + 模型」压成一维列表。
   *
   * 原来渠道（站内 / 免费渠道 / 自定义）是输入框上的一个独立开关，选完再选模型；
   * PromptBar 只有一个模型菜单，所以这里把两者**合成一个 key**（`渠道:模型`），
   * 选中即同时决定渠道和模型 —— 少一次点击，也不会出现「渠道和模型对不上」。
   */
  const fxModels = React.useMemo(() => {
    // 按渠道分组：PromptBar 会在「换组」的地方画一条小分隔（见 PromptBarModel.group）
    const out: { key: string; name: string; tag?: string; group?: string }[] = []

    /**
     * 菜单里**显示**的模型名。
     *
     * ⚠️ 只去掉 `workbuddy-` 前缀 —— 那是内部路由用的标识，对用户是纯噪音。
     * **这里不做长度截断**：展开的列表要看得到全名（2026-10-10 站长要求），
     * 而且列表里名字长一点不影响布局。
     * 按钮上「太长」的问题是**在按钮那一侧用 CSS 限宽**解决的（见 fxBarClass）——
     * 按字数截不靠谱：中文/英文/自定义名字宽度差很多。
     * ⚠️ `key` 保持完整模型 id（它要拿去请求，改了会调不通）。
     */
    const displayName = (raw: string) => raw.replace(/^workbuddy-/, "")
    const gStation = t("lab.model.groupStation")
    const gSite = t("lab.model.groupSite")
    const gCustom = t("lab.model.groupCustom")
    for (const m of models) {
      out.push({
        key: `station:${m}`,
        name: displayName(m),
        group: gStation,
        tag:
          stationFree && stationFreeModels.includes(m)
            ? t("lab.free.trialBadge")
            : undefined,
      })
    }
    /**
     * ⚠️ 免费模型必须**单独列出来**（不能只当「站内模型的徽章」用）。
     *
     * 2026-10-12 站长反馈「AI 实验室 / AI 聊天没有正文」的真因之一：
     * 站内模型清单（`lab_site_models`）为空时上面那个循环一个都没 push，
     * 而免费模型只在徽章逻辑里被引用 ⇒ **菜单里一个能发的模型都没有**，
     * 默认选中落到「自定义模型…」⇒ 发出去 `model:""` ⇒ 后端 400 INVALID_MODEL。
     * 手动点过站点渠道的那几次是成功的，所以现象像「时好时坏」。
     */
    if (stationFree) {
      for (const m of stationFreeModels) {
        if (models.includes(m)) continue
        out.push({
          key: `station:${m}`,
          name: displayName(m),
          group: gStation,
          tag: t("lab.free.trialBadge"),
        })
      }
    }
    for (const c of siteInfo?.channels ?? []) {
      out.push({
        key: `site:${c.id}`,
        name: displayName(c.name),
        group: gSite,
        tag: t("lab.free.channelBadge"),
      })
    }
    // 自定义渠道可能配了多个模型，全部列出来（老的单模型配置也能读）
    const customModels = custom?.models?.length ? custom.models : custom?.model ? [custom.model] : []
    for (const m of customModels) {
      out.push({
        key: `custom:${m}`,
        name: displayName(m),
        group: gCustom,
        tag: t("lab.channel.custom"),
      })
    }
    /**
     * ⚠️ 这一条**永远要有**：旧版模型选择器里有个「自定义渠道」页签带配置按钮，
     * 换成 PromptBar 的平铺菜单之后那个入口没了 ⇒ 没配置过的人**根本加不了自定义模型**
     * （2026-10-10 站长反馈）。所以这里固定放一条，点它开配置弹窗（见 onModelPick）。
     */
    out.push({
      key: "custom-setup",
      name: t("lab.model.customSetup"),
      group: gCustom,
      tag: custom?.model ? t("lab.model.customEdit") : t("lab.model.customAdd"),
    })
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
      {
        key: "files",
        name: t("lab.src.files"),
        description: t("lab.src.filesDesc"),
        icon: Attachment01Icon,
        attach: true,
      },
      { key: "site", name: t("lab.src.site"), description: t("lab.src.siteDesc"), icon: Database02Icon },
      { key: "skills", name: t("lab.src.skills"), description: t("lab.src.skillsDesc"), icon: SparklesIcon },
      { key: "web", name: t("lab.src.web"), description: t("lab.src.webDesc"), icon: Search01Icon },
      {
        key: "ref",
        name: t("lab.src.ref"),
        description: t("lab.src.refDesc"),
        // ⚠️ 必须用 @hugeicons 的图标：这个菜单其它项都是，
        // 换成 lucide 的组件类型对不上（而且 lucide 的 Link 还和 react-router 的 Link 重名）
        icon: Link01Icon,
      },
    ],
    [t]
  )

  /**
   * 「导入文件」带进来的东西：key = 文件名，值是两种形态的组合。
   *   · `text`   —— 文本 / 文档抽取结果，发送时并进正文；
   *   · `images` —— 图片（或扫描版 PDF 的页面），转成 data URL 当**多模态内容**发。
   * 之所以分开放：图片塞进文字里模型是看不懂的（那是乱码），
   * 必须走 content parts 才能被真正「看到」。
   */
  const attachedRef = React.useRef<Record<string, AttachPayload>>({})

  /** 把 File 读成 data URL（添加素材也用） */
  const fileToDataUrl = (file: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error("read failed"))
      r.readAsDataURL(file)
    })

  /** 提示里最多列 3 个文件名，剩下的用「等 N 个」收口 */
  const namesPreview = (names: string[]): string => {
    const shown = names.slice(0, 3).join(t("lab.attach.sep"))
    return names.length > 3 ? `${shown}${t("lab.attach.more", { n: names.length - 3 })}` : shown
  }

  /**
   * 导入文件 —— **纯本地读，不经过服务器**。
   * 支持文本/代码、PDF（扫描件渲染成图）、Word / Excel / PPT / EPUB、压缩包、
   * 图片等；读不了的文件会**明确提示原因**，不再像以前那样静默丢掉。
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
    const loadingId = toast.loading(t("lab.attach.reading"))
    try {
      const { items, issues, truncated } = await readLabAttachments(Array.from(picked))
      for (const [name, payload] of Object.entries(items)) {
        attachedRef.current[name] = payload
      }

      const namesOf = (reason: AttachIssueReason): string[] =>
        issues.filter((i) => i.reason === reason).map((i) => i.name)
      const warn = (reason: AttachIssueReason, key: string) => {
        const names = namesOf(reason)
        if (names.length) toast.warning(t(key, { n: names.length, names: namesPreview(names) }))
      }
      warn("unsupported", "lab.attach.unsupported")
      warn("tooLarge", "lab.attach.tooLarge")
      warn("readFailed", "lab.attach.readFailed")
      warn("imageFormat", "lab.attach.imageIssue")
      warn("imageTooLarge", "lab.attach.imageTooLargeList")
      warn("imageLimit", "lab.attach.imageLimit")
      if (truncated.length) {
        toast.info(t("lab.attach.truncated", { n: truncated.length, names: namesPreview(truncated) }))
      }

      // 只把**真的读到内容**的挂到输入框；失败的文件已由上面的提示说明
      return Object.keys(items)
    } catch {
      toast.error(t("lab.err.generic"))
      return []
    } finally {
      toast.dismiss(loadingId)
    }
  }

  /**
   * 把带进来的**文本**附件并进正文，并收集**图片**的 data URL。
   * 一趟做完（顺带清空暂存，避免下一轮重复带上），返回两样东西
   * —— 因为它们在消息里是两个不同的位置：文本进 content 的文字段，
   * 图片进 image_url 段。
   */
  const takeAttachments = (
    text: string,
    names: string[]
  ): { text: string; images: string[] } => {
    const bodies: string[] = []
    const images: string[] = []
    for (const n of names ?? []) {
      const got = attachedRef.current[n]
      if (!got) continue
      if (got.text) bodies.push(t("lab.attach.fileHeader", { name: n, text: got.text }))
      if (got.images) images.push(...got.images)
    }
    attachedRef.current = {}
    return {
      text: bodies.length ? `${bodies.join("\n\n")}\n\n${text}` : text,
      images,
    }
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
  /**
   * 时间线内容容器的**尺寸监听**（2026-10-12 站长要求「整体粘住底部」）。
   *
   * 为什么光有上面那个 effect 不够：它只在**条目数变化**（timelineLen）或 live 数组
   * 换引用时触发 —— 而「正在思考」那块是**同一个条目在长高**（思考文字增长、工具卡片
   * 行数增长、正文流式变长），条目数根本不变 ⇒ 内容长了、视图不跟。
   * 用户发完消息去忙别的，回头一看还停在自己发消息那一屏（站长原话）。
   * 用 ResizeObserver 盯住内容容器：只要它变高、且用户没往上翻，就滚到底。
   */
  const timelineInnerRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const inner = timelineInnerRef.current
    if (!inner) return
    const ro = new ResizeObserver(() => {
      if (!nearBottomRef.current) return
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
    ro.observe(inner)
    return () => ro.disconnect()
    // 空时间线时内容容器不存在，等它出现（timelineLen 从 0 变正）再挂
  }, [timelineLen > 0])

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

  /**
   * 思考内容的「渐进显示」（2026-10-12 站长反馈「思考卡半天啥都不显示，
   * 突然一次性出现 xxx 行」）。
   *
   * 原因：部分中转站/模型（尤其原生工具 + 高思考档）在「纯想」阶段
   * **不发 reasoning 增量**，最后把整段一次性吐出 —— 上游就是这样的，
   * 前端改不了它的发送方式，但可以**改变展示节奏**：
   * `thinkRef` 是「已收到的全文」，`liveThink` 是「已经放出来的部分」。
   * 每 40ms 放一小段（按剩余量自适应：剩余越多放得越快，约 1.6 秒内追平），
   * 真流式时增量本来就小，观感不变；一次性大块时呈现打字机效果，
   * 不再「半屏文字砸脸」。
   */
  const pushThink = () => {
    if (thinkTimer.current != null) return
    const step = () => {
      const full = thinkRef.current
      const shownLen = thinkShownRef.current
      if (shownLen >= full.length) {
        // 已追平：停表。下一个 reasoning 增量到来时 pushThink 会重新启动
        thinkTimer.current = null
        return
      }
      /**
       * 每步放剩余的 1/12（至少 2 字符）：
       * 指数衰减下 ~15 步（约 600ms）追平 —— 「一次性大块」呈现为一段
       * 快速打字机；真流式时增量本来就小（一步就追平），观感不变。
       * （试过 1/40：衰减太慢，2.5 秒才放完 75%，反而又变成「卡着不动」——
       *  单元测试 _unit-think-reveal.mjs 量出来的，别改回去。）
       */
      const remain = full.length - shownLen
      // 收尾别拖：剩最后一小段时一步放完，否则尾巴会以每步 2 字慢慢爬
      const n = remain <= 48 ? remain : Math.max(2, Math.ceil(remain / 12))
      const next = full.slice(0, shownLen + n)
      thinkShownRef.current = next.length
      setLiveThink(next)
      thinkTimer.current = window.setTimeout(step, 40)
    }
    thinkTimer.current = window.setTimeout(step, 40)
  }

  /** 一轮收尾：停掉思考的渐进刷新，并把剩余未放出的部分**一次性补齐**（不能只显示半截） */
  const settleThink = () => {
    if (thinkTimer.current != null) {
      window.clearTimeout(thinkTimer.current)
      thinkTimer.current = null
    }
    if (thinkShownRef.current < thinkRef.current.length) {
      thinkShownRef.current = thinkRef.current.length
      setLiveThink(thinkRef.current)
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
    if (!a.complete) return null
    // 缺 path 时以前直接 return null（= 当成功），模型于是以为改好了继续往下改 ——
    // 改成明确失败，让上层回喂一轮纠正。list 本来就不需要 path。
    if (!a.path) {
      /**
       * 🔴 这些工具**本来就不需要 path**，各自有专门的执行批次（见下面的 http /
       * web_search / run / site / screenshot / inspect 批次）。
       * 以前只有 list 被放行，其余一律回「缺少 path」——于是模型调 screenshot /
       * inspect 时收到「必须带 path=文件名」的**假反馈**，就一遍遍改参数瞎试
       * （2026-10-13 站长反馈「截图读取了五六次都没读出来」）。
       */
      const noPathTools: string[] = [
        "list",
        "run",
        "need_vm",
        "site",
        "site_manual",
        "skill",
        "web_search",
        "http",
        "screenshot",
        "inspect",
      ]
      if (noPathTools.includes(a.tool)) return null
      return missingPathReason(a.tool)
    }
    /**
     * patch：一次改多处（#3）。逐处调用 applyReplace —— 复用同一套「精确匹配 +
     * 模糊兜底 + 失败时给最像的一段」逻辑，不另写一份替换实现。
     * ⚠️ 逐处**基于上一处的结果**继续（前一处改了行数，后一处的 old 仍按新内容匹配 ✅）。
     */
    if (a.tool === "patch") {
      const hunks = a.hunks ?? []
      if (!hunks.length) return "patch 失败：没有给出 hunks（每项要 {old,new}）"
      let cur = filesRef.current[a.path]
      if (cur == null) return `patch 失败：文件 ${a.path} 不存在`
      const notes: string[] = []
      let okCount = 0
      for (let hi = 0; hi < hunks.length; hi++) {
        const r = applyReplace({ [a.path]: cur }, a.path, hunks[hi].old, hunks[hi].new)
        if (r.ok) {
          cur = r.value
          okCount++
        } else {
          notes.push(`第 ${hi + 1} 处失败：${r.reason}`)
        }
      }
      if (okCount) {
        filesRef.current = { ...filesRef.current, [a.path]: cur }
        setFiles(filesRef.current)
      }
      return (
        `[修改 ${a.path} ${okCount}/${hunks.length} 处成功]\n` +
        (notes.length ? notes.join("\n") : "全部改好了。")
      )
    }
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
        return t("lab.replace.badFormat")
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

  /**
   * 编译作品里的 JSX / TS 源码，把产物写回文件集。
   *
   * 预览、保存、新标签页预览三条路径都要先过这一步 —— 否则保存到 R2 的只有源码，
   * 绑定的域名和审核预览都拿不到能跑的 `.js`。
   * 没有可编译文件时**零开销**（compileLabSources 内部直接返回，连编译器都不加载）。
   */
  const syncCompiled = async (): Promise<FileMap> => {
    const cur = filesRef.current
    if (!Object.keys(cur).some(needsCompile)) {
      if (compileErrors.length) setCompileErrors([])
      return cur
    }
    const { files: next, errors } = await compileLabSources(cur)
    setCompileErrors(errors)
    // 编译失败也把成功的部分写回去：整页白屏比缺一个文件更难排查
    filesRef.current = next
    setFiles(next)
    return next
  }

  const refreshPreview = async (bump: boolean) => {
    const next = await syncCompiled()
    setPreview(buildPreviewDoc(next))
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

  /**
   * 终端画面挂载点：面板是条件渲染的，所以 ref 要跟着开关重新登记。
   * 面板没开（= 用户在聊天页）时挂到**隐藏容器**上 —— 虚拟机照常运行，
   * 界面不会被切走；等用户真打开终端页，effect 会把画面改挂到可见容器。
   */
  React.useEffect(() => {
    mountVmScreen(termScreenRef.current ?? hiddenVmRef.current)
  }, [previewOpen, termTab, vmPhase])

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
      // 不再切界面（站长要求留在聊天页）；弹窗本身已说明清楚
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
  const ensureVM = async (
    /**
     * 是否把界面切到终端页。AI 申请时传 false —— **留在聊天页**
     * （画面挂在隐藏容器上，见 hiddenVmRef 的注释）。
     */
    reveal = true
  ): Promise<{ ok: boolean; error?: string }> => {
    if (getVmPhase() === "ready") return { ok: true }

    if (!hasVmConsent()) {
      const allowed = await askVMEnable()
      if (!allowed) return { ok: false }
      markVmConsent()
    }

    // 走到这里＝已授权：不再打扰，直接启动（要不要切界面由 reveal 决定）
    if (reveal) revealTermPanel()
    // 给一个明确的状态，别让用户对着空面板猜「怎么卡住了」
    toast.message(t("lab.term.autoOn"), { duration: 2500 })
    try {
      await bootVM()
      /**
       * ⚠️ **等它就绪，别立刻判死**：bootVM() 返回时 phase 往往还是 loading
       * （内核还在起），马上检查会把慢启动误判成失败。最多等 30 秒。
       */
      for (let i = 0; i < 60 && getVmPhase() !== "ready"; i++) {
        await new Promise((r) => setTimeout(r, 500))
      }
      if (getVmPhase() !== "ready") {
        return {
          ok: false,
          error: `等待 30 秒后终端状态仍是「${getVmPhase()}」而不是就绪 —— 多半是虚拟机资源没加载出来`,
        }
      }
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
    messages: LabConvoMessage[],
    signal: AbortSignal,
    round: number,
    applied: Map<number, string>,
    onPreviewTick: () => void,
    /**
     * 这一轮**真正要用**的渠道 / 模型 / 免费渠道 id，由调用方显式传入。
     * ⚠️ 不能在这里直接读 state：`send` 里刚 `applyFxModel()` 过，
     * 而 setState 是异步的 —— 那一刻这些 state 还是**上一轮的值**，
     * 结果就是「换了模型，实际请求与消息标识都还停在旧模型」。
     */
    useChannel: string,
    useModel: string,
    useSiteChannelId: string,
    /** 原生工具调用：给上游带 tools、并按结构化 tool_calls 解析 */
    useNativeTools: boolean,
    /** 收这一轮的结构化调用（原地填充；流结束时才完整） */
    collected: NativeToolCall[]
  ): Promise<string> => {
    let res: Response
    if (useChannel === "station" || useChannel === "site") {
      /**
       * 🔴 连**等响应头**这一步也要有守卫（2026-10-12 站长反馈「手机离开过后再回来，
       * 发消息还是没有反应」）。
       *
       * 之前只在「读流」那步做了空闲/前台陈旧判定 —— 但请求卡在**更早**的阶段
       * （fetch 一直不返回：切后台时请求刚发出、或网络被掐）时那个守卫还没生效，
       * 整轮就永远挂着。这里用**独立的 AbortController**（跟随本轮的中止信号）：
       * 守卫触发时只掐掉这一次请求，**不把整轮标记成「用户主动中止」**
       * （否则自动重试会被跳过）。
       */
      const fetchCtrl = new AbortController()
      const onRoundAbort = () => fetchCtrl.abort()
      if (signal.aborted) fetchCtrl.abort()
      else signal.addEventListener("abort", onRoundAbort)
      try {
        res = await withIdleGuard(
          streamLabChat({
            model: useModel,
            // 原生模式：把工具声明交给上游（声明见 src/lib/lab-tools-native.ts）
            tools: useNativeTools ? NATIVE_TOOLS : undefined,
            messages,
            effort,
            // 温度由这里算好传下去（唯一口径，见 lab-agent.ts 的 EFFORT_TEMPERATURE）
            temperature: EFFORT_TEMPERATURE[effort],
            // 免费渠道只传 id：真实地址与密钥留在服务端，浏览器拿不到
            channelId: useChannel === "site" ? useSiteChannelId : undefined,
            signal: fetchCtrl.signal,
          }),
          STREAM_IDLE_MS,
          STUCK_MS,
          () => lastActivityRef.current
        )
      } finally {
        signal.removeEventListener("abort", onRoundAbort)
      }
      /**
       * 免费额度用完、后端**自动改用你自己账号的额度**继续（见后端 chat() 的注释）。
       * 必须提示一下：用户选的明明是免费模型，不说明白他会以为扣错账了。
       */
      if (res.headers.get("X-Lab-Auto-Fallback") === "1") {
        toast.warning(t("lab.free.autoFallback"))
      }
    } else {
      res = await fetch(customEndpoint(custom!.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${custom!.apiKey}`,
        },
        body: JSON.stringify({
          model: useModel,
          messages,
          stream: true,
          // 自定义渠道不经过本站后端，是否支持 tools 由对方决定（开关可随时关掉）
          tools: useNativeTools ? NATIVE_TOOLS : undefined,
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
    thinkShownRef.current = 0
    setLiveThink("")
    sealedRef.current = false
    setThinkSealed(false)
    /**
     * 🔴 连接一旦真的建立，就**立刻**把「正在自动重试…」复位（2026-10-13 站长反馈）。
     * 复位**不能**放在 streamRound 之后 —— 那个函数要等整轮流完才返回，于是文案会
     * 一直停在「正在重试…」直到这一轮结束（站长看到的就是「…7m 0s」）。
     * 复位成空串 ⇒ 回落到正常的「正在思考…」。
     */
    if (retryingRef.current) {
      retryingRef.current = false
      setLabRun({ label: "" })
    }
    await consumeSSE(
      res,
      (delta) => {
        lastActivityRef.current = Date.now()
        // 用量面板埋点：第一个 delta 就是「首 token」，字符数用来估输出 token
        if (metricsRef.current.first === null) metricsRef.current.first = Date.now()
        metricsRef.current.outChars += delta.length
        acc += delta
        accRef.current = acc
        // 正文开始了 ⇒ 这一轮的思考已经结束（推理与正文在流里是先后关系），
        // 立刻封口：思考块停止流光、自动折叠，避免「都在改文件了还在转圈」。
        if (!sealedRef.current && acc.trim()) {
          sealedRef.current = true
          setThinkSealed(true)
        }
        /**
         * ⚠️ 原生模式下**绝不解析/执行正文里的标签**：
         * 那时标签只是普通文字（模型可能只是举例），去执行它等于绕过结构化调用，
         * 而且会在流式途中拿半截参数动手。
         * 但**显示**是另一回事：原生模式下正文也必须实时出现在时间线上
         * （2026-10-12 站长反馈「流式期间完全看不到 AI 在说什么」）——
         * 所以这里单独取一份**只用于显示**的 text 段，绝不参与执行。
         */
        const displaySegs = useNativeTools
          ? parseAgentText(acc).filter((s) => s.type === "text")
          : parseAgentText(acc)
        const segs = useNativeTools ? [] : displaySegs
        segs.forEach((s, i) => {
          if (s.type === "action" && s.complete && !applied.has(i)) {
            applied.set(i, applyAction(s) ?? "")
          }
        })
        /**
         * 实时视图 = 正在流出的正文 + 结构化工具卡片（原生模式）。
         * ⚠️ 必须合在一起再 pushLive：**文本回调与工具调用回调都会把整个实时视图
         *    整份替换**，只推一半就会把另一半抹掉（见下面工具回调里的注释）。
         * 顺序 = **正文在前、工具卡片在后**，与这一轮结束时落盘的顺序一致
         * （`const segs = useNative ? [正文…, 工具…] : …`）—— 两边顺序不一致的话，
         * 这一轮一结束正文会「跳」到另一个位置。
         */
        const liveSegs =
          useNativeTools && collected.length
            ? [...displaySegs, ...nativeToolCallsToSegments(collected, false)]
            : displaySegs
        pushLive(segmentsToEntries(liveSegs, round, false, filesRef.current))
        /**
         * 把「跑到哪一步了」同步进模块单例。
         * ⚠️ 这个回调是**循环闭包**，页面卸载后它照样在跑 ——
         *    所以即使切走了，回来时思考动画里的步骤也是最新的（见 lib/lab-run.ts）。
         * ⚠️ 原生模式下 `segs` 恒为空 ⇒ 步骤必须从 liveSegs（含工具卡片）里提，
         *    否则「正在做的事」永远不更新（2026-10-12 站长反馈）。
         */
        setLabRun({ steps: actionSteps(liveSegs) })
        const now = Date.now()
        if (now - lastPreview > 700) {
          lastPreview = now
          onPreviewTick()
        }
      },
      (think) => {
        lastActivityRef.current = Date.now()
        thinkRef.current += think
        pushThink()
      },
      (calls) => {
        /**
         * 原生工具调用：这份是**当前快照**（会随分片不断变完整）。
         * · 更新 `collected`（整份替换，最后一次回调即最终结果）；
         * · 同时渲染**实时卡片** —— 函数名一到就出现，参数边流边填，
         *   和主流 agent 一致。⚠️ 卡片必须按「未完成」渲染（complete=false）：
         *   参数可能只到一半，**绝不能拿半截参数去执行**（比如 write 的内容还没传完）。
         */
        collected.length = 0
        lastActivityRef.current = Date.now()
        collected.push(...calls)
        if (calls.length) {
          /**
           * 🔴 这里**必须把已经流出的正文一起带上**（2026-10-12 站长反馈
           * 「正文闪一下就没了，等写入完才又出现」）：
           * `pushLive` 是**整份替换**，只推工具卡片的话正文会被从时间线上抹掉 ——
           * 而写入这类工具的参数要流很久（几百行），正文就消失那么久。
           * 顺序与文本回调、以及本轮结束时的落盘顺序保持一致：正文在前、卡片在后。
           */
          const textSegs = useNativeTools
            ? parseAgentText(accRef.current).filter((s) => s.type === "text")
            : []
          pushLive(
            segmentsToEntries(
              [...textSegs, ...nativeToolCallsToSegments(calls, false)],
              round,
              false,
              filesRef.current
            )
          )
        }
      },
      // 回到前台时用它判断「这一轮是不是已经陈旧」（见 readWithIdle 的 ②）
      () => lastActivityRef.current
    )
    return acc
  }

  /**
   * 发一轮。
   * `override` 给 PromptBar 用 —— 输入框归它管，文字从它那边递过来，
   * 不再是「先写进我们的 state 再读出来」。
   */
  /**
   * 这一轮模型没给用户任何文字时的兜底说明。
   * 只在「循环真要结束、且几轮都没留下话」时调用一次。
   */
  const appendSilentEndNote = () => {
    updateEntries((prev) => [
      ...prev,
      {
        key: `silent-${Date.now()}`,
        kind: "text" as const,
        text: t("lab.silentEnd"),
        live: false,
        collapsible: false,
        at: Date.now(),
      },
    ])
  }

  /**
   * 🔴 「干完活但没有报告」的最终兜底（2026-10-12 站长反馈）：模型做完事
   * 一句话不说就结束 ⇒ **前端自己写摘要**。数据来源是**真实的工具条目**
   * （不是模型自称），从 entriesRef 里把这一整轮的 tool 条目汇总成一句话。
   * 只在真的拿不到模型报告时出现（REPORT_NUDGE 推过仍不说），所以用户
   * 看到它 = 模型偷懒了，摘要末尾注明是自动生成的。
   */
  const appendAutoReport = () => {
    const acts: string[] = []
    for (const e of entriesRef.current) {
      if (e.kind !== "tool") continue
      const arg = e.tool === "grep" ? e.pattern : e.tool === "run" ? e.command?.split("\n")[0] : e.path
      const label = t(`lab.tool.${e.tool}`)
      acts.push(arg ? `${label} ${arg}` : label)
    }
    if (!acts.length) return
    // 去重（同一路径反复读写只记一次），最多列 8 条，多了说明是长活，点到为止
    const uniq = [...new Set(acts)].slice(0, 8)
    updateEntries((prev) => [
      ...prev,
      {
        key: `report-${Date.now()}`,
        kind: "text" as const,
        text:
          `${t("lab.autoReport.done")}\n${uniq.map((a) => `· ${a}`).join("\n")}` +
          `\n${t("lab.autoReport.hint")}`,
        live: false,
        collapsible: false,
        at: Date.now(),
      },
    ])
  }

  const send = async (
    override?: string,
    files: string[] = [],
    /**
     * PromptBar 刚选中的模型 key（`station:xxx` / `site:xxx` / `custom:xxx`）。
     *
     * ⚠️ **必须显式传进来，不能只读 state**：
     * `onSend` 里先 `applyFxModel(key)`（一连串 setState）**紧接着**就调 `send`，
     * 而 React 的状态更新是**异步的** —— 这一刻 render 闭包里的 `channel` / `model`
     * **还是旧值**。结果就是「换了模型，发出去的第一条用的还是上一个模型」，
     * 消息上那枚模型标识也跟着错（2026-10-10 站长反馈「撤回说第二遍才生效」）。
     */
    pickedKey?: string
  ) => {
    // 解析出这一轮**真正要用**的渠道与模型（纯计算，不依赖 setState 有没有生效）
    const pi = pickedKey ? pickedKey.indexOf(":") : -1
    const pCh = pi > 0 ? pickedKey!.slice(0, pi) : ""
    const pVal = pi > 0 ? pickedKey!.slice(pi + 1) : ""
    const effChannel =
      pCh === "station" || pCh === "site" || pCh === "custom"
        ? (pCh as typeof channel)
        : channel
    const effSiteChannelId =
      effChannel === "site" && pCh === "site" ? pVal : siteChannelId
    const effSiteChannel =
      siteInfo?.channels.find((c) => c.id === effSiteChannelId) ?? null
    /**
     * 原生工具调用开关（站点设置 `lab_native_tools`，**默认关**）。
     * 关着 = 走原来的文本标签协议 ⇒ 这就是回滚口子。
     */
    const nativeToolsOn = Boolean(siteInfo?.nativeTools)
    /**
     * 兜底模型 —— **空模型绝不能发出去**。
     *
     * ⚠️ 2026-10-12 站长反馈「AI 实验室 / AI 聊天没有正文」的真因就在这儿：
     *    `lab_site_models` 为空 ⇒ 站内模型清单为空 ⇒ `model` 状态一直是 `""`
     *    ⇒ **直接打字发送**就带 `model:""` ⇒ 后端 400 INVALID_MODEL
     *    ⇒ 界面上一点回复都没有（手动在菜单里选过模型的那几次是正常的，所以像「时好时坏」）。
     * 兜底顺序跟模型菜单里能看到的顺序一致：站内清单 → 站内免费 → 站点渠道。
     */
    const modelFallback =
      effChannel === "site"
        ? effSiteChannel?.model || siteInfo?.channels[0]?.model || ""
        : effChannel === "custom"
          ? (custom?.model ?? "")
          : models[0] || stationFreeModels[0] || ""
    const effModel =
      (effChannel === "station"
        ? pCh === "station"
          ? pVal
          : model
        : effChannel === "site"
          ? effSiteChannel?.model || model
          : // 自定义渠道：多选时 key 里带的那个模型要能用上（否则永远只用第一个）
            pCh === "custom" && pVal
            ? pVal
            : (custom?.model ?? "")) ||
      modelFallback

    /**
     * ⚠️ 这里刻意把「模型看到的」和「用户看到的」分成两份：
     *   · 用户气泡：只显示他自己打的字 + 附件名（附件内容平铺进聊天里非常难看，
     *     几百行 txt 会把整屏刷掉 —— 2026-10-10 站长反馈）；
     *   · 模型输入：正文 + 附件全文（它必须拿到内容才做得了事）。
     */
    /**
     * ⚠️ 启动恢复（IndexedDB 异步）没完成前，filesRef 里还是**空的** ——
     * 这时发消息会把「（空项目，还没有任何文件）」写进 system prompt，
     * 模型于是「明明项目里有文件却说没有」，然后**把文件全部重写一遍**
     * （2026-10-12 站长反馈）。
     *
     * 🔴 但「等」本身也出过事（同日站长反馈「消息发出去了但没有思考标记、
     * 也没有正式开始」）：等的时候**界面完全静默** —— 输入框没清空、没有气泡、
     * 没有思考动画，点了发送像没点。所以这里：
     *   ① 先把用户气泡和「正在加载项目」状态**立刻**立起来（有反馈）；
     *   ② 再等恢复完成（上限 2 秒）。
     * 判断用 `sessionLoadingRef`（读盘期间为 true），不要用 draftReady：
     * 没有任何会话的老用户 draftReady 很快就 true，但根本没有「恢复」要做。
     */
    if (sessionLoadingRef.current) {
      setLabRun({
        running: true,
        label: t("lab.loadingProject"),
        steps: [],
        startedAt: Date.now(),
      })
      for (let i = 0; i < 20 && sessionLoadingRef.current; i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
      clearLabRun()
    }
    const typed = (override ?? input).trim()
    /**
     * 空消息（既没打字、也没有任何附件）直接不发。
     *
     * ⚠️ 这里**不能**再用 `takeAttachments` 的结果判断：附件要等「自动读网页」
     * 之后才汇总得出来（见下方那段），所以先做一个等价的便宜判断。
     */
    if (!typed && !(files ?? []).length && !pendingAttachRef.current.length) return
    /**
     * 🔴 「上一轮还在跑」**不能静默吞掉**（2026-10-12 站长反馈「消息发出去什么回应
     * 都没有，连正在思考都不显示」）。
     *
     * 原来这里直接 `return` —— 而 PromptBar 在调 onSend 之后**已经清空了输入框**，
     * 所以用户看到的是「消息消失了，什么都没发生」。更糟的是：半开连接下 `streaming`
     * 可能**永远卡在 true**，于是之后每一次发送都被这条静默吃掉。
     *
     * 现在分两种：
     *   · 那一轮还活着（最近有动静）⇒ 明确告诉他「上一轮还在跑」，并把它排成插话（不丢消息）；
     *   · 那一轮已经卡住（超过 STUCK_MS 没任何动静）⇒ 直接收掉它，然后照常发这条。
     */
    if (streaming) {
      const idleMs = Date.now() - lastActivityRef.current
      if (idleMs > STUCK_MS) {
        // 卡住了：中止 + 等循环收尾（finally 会把 streaming 置 false）
        toast.warning(t("lab.err.stuckReset"))
        abortRef.current?.abort()
        for (let i = 0; i < 30 && streamingRef.current; i++) {
          await new Promise((r) => setTimeout(r, 100))
        }
      } else {
        // 还活着：不丢消息，按「中途插话」排队（时间线上会出现「待发送」气泡）
        pushSteer(typed)
        toast.success(t("lab.steer.queued"))
        return
      }
    }
    // 一个模型都没有：明确告诉用户，而不是把空模型发出去换回 400（见 modelFallback 的说明）
    if (!effModel) {
      toast.error(t("lab.err.noModel"))
      return
    }
    if (effChannel === "station" && (stationMissing || stationAuthExpired)) {
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
    if (effChannel === "site") {
      const picked = effSiteChannel
      if (!picked) {
        toast.error(t("lab.err.siteChannelGone"))
        setChannel("station")
        return
      }
    }
    if (
      effChannel === "custom" &&
      (!custom || !custom.baseUrl || !custom.apiKey || !effModel)
    ) {
      setChannelOpen(true)
      return
    }

    setInput("")
    const bubbleKey = `u-${Date.now()}`
    updateEntries((prev) => [
      ...prev,
      // convoAt 记的是「这条消息即将被塞进 convoRef 的位置」——
      // 编辑重发时就从这里往回切（见 editMessage）
      {
        key: bubbleKey,
        kind: "user",
        text: typed,
        files,
        convoAt: convoRef.current.length,
        at: Date.now(),
      },
    ])
    /**
     * 发消息就**重新粘到底部**（2026-10-12 站长要求）。
     * 用户可能正翻着上面的历史 —— 但既然发了消息，他要看的就是新回复，
     * 所以这里强制恢复「跟随底部」；之后他自己往上翻仍会正常松开。
     */
    nearBottomRef.current = true
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })

    /**
     * 🔴 自动「参考网址」（2026-10-12 站长要求：原来要点「+ → 参考网址」才读页面，
     * 现在消息里带网址就自动读）。
     *
     * ⚠️ 位置很关键：**必须排在用户气泡入队之后**。
     *    状态行（「正在读取网页…」）挂在时间线的**非空分支**里 ——
     *    首条消息时时间线还是空的（走的是 slogan 空状态），
     *    抓取期间就一条状态都显示不出来（实测 0/15 次采样命中）。
     *    先把气泡立起来，时间线非空 ⇒ 状态行才有地方渲染。
     * 抓到的正文写进 attachedRef / pendingAttachRef，下面 takeAttachments 才会带上。
     */
    if (typed) {
      const got = await autoAttachUrls(typed)
      if (got.done.length) {
        toast.success(t("lab.ref.autoDone", { n: String(got.done.length) }))
      } else if (got.failed) {
        // 全失败才提示（部分失败不吵）；模型仍能看到网址本身，也能自己再抓
        toast.warning(t("lab.ref.autoFailed", { n: String(got.failed) }))
      }
    }
    // 「参考网址」进来的附件不在 PromptBar 的列表里，这里并进去一起处理
    const refNames = [...pendingAttachRef.current]
    pendingAttachRef.current = []
    const allFiles = [...(files ?? []), ...refNames]
    const taken = takeAttachments(typed, allFiles)
    const text = taken.text
    // 把自动抓来的网址补到气泡的附件标签上（用户才看得出这轮读了哪些页面）
    if (refNames.length) {
      updateEntries((prev) =>
        prev.map((e) =>
          e.key === bubbleKey ? { ...e, files: [...(files ?? []), ...refNames] } : e
        )
      )
    }
    // 极端情况：只有空附件、又没打字 ⇒ 确实没东西可发（原判断挪到这里）
    if (!text && !taken.images.length) {
      // ⚠️ 这里用户气泡**已经入队了**，再静默 return 就会留下一条永远没有回应的消息
      //    （2026-10-12：所有静默返回都要给个说法）
      toast.error(t("lab.err.emptySend"))
      return
    }
    /**
     * 给模型的这一份：有图就走**多模态 content 数组**。
     * 文字在前、图片在后 —— 多数模型对「先描述再给图」的理解更稳。
     * 没有图就保持原来的纯字符串（对老模型/免费渠道最兼容）。
     */
    let modelContent: string | LabConvoPart[] = text
    if (taken.images.length) {
      const parts: LabConvoPart[] = []
      if (text) parts.push({ type: "text", text })
      for (const url of taken.images) {
        parts.push({ type: "image_url", image_url: { url } })
      }
      modelContent = parts
    }
    convoRef.current = [...convoRef.current, { role: "user", content: modelContent }]
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
    /**
     * 收尾补问的次数（**不是布尔**）。
     *
     * ⚠️ 原来是个「只补一次」的开关，2026-10-10 站长反馈「思考完就结束了」：
     * 补过一次之后，如果模型**又一次**只输出思考/只调工具，就再没有机会，
     * 循环直接 break ⇒ 用户看到「思考完，没了」。
     * 允许补两次；真不行也不许静默结束 —— 见下面的兜底。
     */
    let closingNudges = 0
    /**
     * **整轮**（这一次发送）里模型有没有跟用户说过话。
     * 只要有一轮说过，最后就不该再补「这轮没有说明」—— 那会让用户莫名其妙
     * （2026-10-10 站长反馈「每轮结束都要说一句…」）。
     */
    let turnSaidSomething = false
    /**
     * 🔴「干完活必须有报告」（2026-10-12 站长反馈「做完了直接就结束了，
     * 没有报告没有总结」）。
     *
     * 原机制的洞：`turnSaidSomething` 只要有**任何一轮**说过话（哪怕开头一句
     * 「我来做」）就置 true ⇒ 后面几轮纯工具干完、最后一轮一句话不说，
     * 收尾补问的兜底（`!turnSaidSomething`）**整轮不触发** ⇒ 完全静默结束。
     *
     * 现在双保险：
     *   ① 干过活（有文件/命令/站内动作）且**最后一轮**没跟用户说话 ⇒
     *      发 REPORT_NUDGE（独立计数，只推 1 次）再给模型一次机会；
     *   ② 仍不说 ⇒ **前端自己生成收尾摘要**（从工具条目汇总），用户
     *      永远能看到「做了什么」。
     */
    /**
     * 本轮改动清单（#5）的基准快照 —— 整个 send 期间共享，结束时对比一次。
     */
    const filesAtTurnStart = { ...filesRef.current }
    let didRealWork = false
    let reportNudged = false
    /** 网络断流自动重试的计数（见循环里那段注释）—— 整轮共享，不按 round 重置 */
    let netRetries = 0
    let round = 0

    try {
      /**
       * 循环跑到「模型不再要求用工具」为止 —— 不设轮数上限、也不因「连续几轮没改文件」强制中断。
       * 结束条件只有三个：模型自己收尾、用户点停止、或者出错。
       * （`for (;; round++)` 的 `continue` 也会执行 round++，所以计数始终准确。）
       */
      for (;; round++) {
        lastActivityRef.current = Date.now()
        if (!metricsRef.current.start) metricsRef.current.start = Date.now()
        metricsRef.current.rounds += 1
        const messages = [
          {
            role: "system",
            content:
              buildSystemPrompt(filesRef.current, effectivePrompt, labSkills, webSearchOn) +
              (siteOpRef.current
                ? t("lab.site.prompt.header") +
                  t("lab.site.prompt.body") +
                  buildSiteManual()
                : ""),
          },
          ...compactHistory(convoRef.current),
        ]
        // 用量面板：这一轮上下文的构成（系统提示 / 工具声明 / 对话历史）
        metricsRef.current.ctx = {
          system: estTokens(String((messages[0] as { content?: unknown })?.content ?? "")),
          tools: nativeToolsOn ? estTokens(JSON.stringify(NATIVE_TOOLS)) : 0,
          history: estTokens(
            messages
              .slice(1)
              .map((m) => {
                const c = (m as { content?: unknown }).content
                return typeof c === "string" ? c : JSON.stringify(c ?? "")
              })
              .join("")
          ),
        }
        const applied = new Map<number, string>()
        /** 这一轮上游给的结构化工具调用（原生模式才有内容） */
        const nativeCalls: NativeToolCall[] = []
        /**
         * 🔴 网络类断流**自动重试**（2026-10-12 站长反馈「切到后台就不干活了，
         * 回来只看到『这一轮没能完成：CORS 限制 / 生成中断了』」）。
         *
         * 成因：SSE 是**浏览器直连**的长连接 —— 页面被切到后台（尤其手机上被挂起）
         * 时连接会被中断，`fetch` 抛 `TypeError`。以前这一抛就直接结束整轮，
         * 用户回来看到的是一句「CORS 限制」（其实是断流，误判）。
         *
         * 现在：断流最多自动重试 2 次；**如果页面当时在后台，先等它回到前台再重试**
         * （后台重试大概率还是失败，白烧额度）。重试 = 用同一份 messages 重新发这一轮，
         * 模型会重新生成这一步；已经写进项目的文件不受影响。
         */
        let raw: string
        try {
          raw = await streamRound(
            messages,
            controller.signal,
            round,
            applied,
            () => void refreshPreview(false),
            effChannel,
            effModel,
            effSiteChannelId,
            nativeToolsOn,
            nativeCalls
          )
        } catch (err) {
          const netErr =
            (err instanceof TypeError ||
              err instanceof StreamIdleError ||
              /**
               * 🔴 **5xx 也要重试**（2026-10-12 实测发现）：`/api/lab/chat` 会**间歇性**
               * 返回 500「服务器内部错误」（同一个请求体，连打 3 次全 500、过一会儿又 200）。
               * 不重试的话，用户看到的就是「发出去没反应」—— 正是站长反馈的现象。
               * 这种偶发内部错误重试一次基本就好了。
               */
              (err instanceof HttpError && err.status >= 500)) &&
            !controller.signal.aborted
          if (netErr && netRetries < MAX_NET_RETRIES) {
            netRetries += 1
            retryingRef.current = true
            setLabRun({ label: t("lab.err.retrying") })
            toast.warning(t("lab.err.retrying"), { id: "lab-net-retry" })
            // 页面在后台就先等回前台：后台重试多半还是断（手机还会被挂起）
            if (document.hidden) await waitUntilVisible()
            if (controller.signal.aborted) throw err
            await new Promise((r) => setTimeout(r, 800 * netRetries))
            round -= 1 // 这一轮不算数，重试同一轮
            continue
          }
          throw err
        }

        /**
         * 🔴 重试**成功**后必须把状态文案**复位**（2026-10-13 站长反馈）：
         * 之前只设了「连接断了，正在自动重试…」却从不复位 ⇒ 明明已经接上、模型也在
         * 正常思考，界面却一直停在「正在自动重试…7m 0s」。
         * 复位成空串 ⇒ 回落到正常的「正在思考…」（ThoughtLine 的 label 有兜底）。
         */
        if (retryingRef.current) {
      retryingRef.current = false
      setLabRun({ label: "" })
    }
        /**
         * 收尾：把没来得及执行的补齐（中止时也走这里，保住已生成的部分）。
         *
         * ⚠️ 两种模式在这里汇合：
         *   · 原生：结构化调用 → 翻译成**与标签协议同形状**的 Segment；
         *   · 文本：正则解析标签。
         * 下游（applyAction / 工具卡片 / 回喂）完全不知道差别。
         */
        const useNative = nativeToolsOn && nativeCalls.length > 0
        /**
         * 🔴 原生模式下**绝不能把正文丢掉**（2026-10-12 站长反馈
         * 「所有文字都在思考里，没有以正文显示」）：
         *
         * `nativeToolCallsToSegments` 只返回工具调用的 Segment —— 模型在这一轮里
         * 对用户说的**每一句话都在 `raw` 里**，原代码只把 `raw` 存进对话历史
         * （后面 convoRef 那段），**时间线上一个字都不会出现**，用户看到的就是
         * 「思考块 + 一堆工具卡片，没有任何正文」。
         *
         * 修法：把 `raw` 解析成 text Segment 拼在工具卡片**前面**。
         * 复用 parseAgentText 是有意的：它的容错归一化会把模型偶尔
         * 漏出来的标签残片（`</lab_write>`、`</think>` 等）滤掉，
         * 原生模式下这些只是普通文字，显示出来反而是垃圾。
         */
        const segs = useNative
          ? [
              ...parseAgentText(raw).filter((s) => s.type === "text"),
              ...nativeToolCallsToSegments(nativeCalls),
            ]
          : parseAgentText(raw)
        segs.forEach((s, i) => {
          if (s.type === "action" && s.complete && !applied.has(i)) {
            applied.set(i, applyAction(s) ?? "")
          }
        })
        // 「干过活」标记：收尾必须有报告的判据（见 send 开头 didRealWork 的注释）
        if (
          segs.some(
            (s) =>
              s.type === "action" &&
              s.complete &&
              (s.tool === "write" ||
                s.tool === "replace" ||
                s.tool === "delete" ||
                s.tool === "run" ||
                s.tool === "site" ||
                s.tool === "skill" ||
                s.tool === "web_search" ||
                s.tool === "http")
          )
        ) {
          didRealWork = true
        }

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
              runResults.set(
                i,
                `${t("lab.cmd.head", { cmd })}\n${t("lab.cmd.failed", {
                  msg: String(e?.message ?? e),
                })}`
              )
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
            siteResults.set(
              i,
              t("lab.site.fail", { op: s.op || "?", msg: parsed.error })
            )
            continue
          }
          const r = await runSiteOp(s.op ?? "", parsed.value, approveSite)
          siteResults.set(i, r.text)
        }

        // ---- 服务端抓取：正文是服务端取回来的，必须回喂一轮 ----
        const httpResults = new Map<number, string>()
        /**
         * 🔴 #6 **并行**（2026-10-14）：同一轮里的多个抓取互相独立（结果按下标存），
         * 串行会让总耗时 = 各次之和；并行后 = 最慢的那一次。
         * ⚠️ 只并行**网络型**批次：VM 命令共享一个终端、站内写操作要按顺序批准，
         * 那些必须保持串行（下面不动）。
         */
        const httpJobs: Promise<void>[] = []
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i]
          if (s.type !== "action" || !s.complete || s.tool !== "http") continue
          httpJobs.push(
            (async () => {
          const target = (s.url ?? "").trim()
          if (!target) {
            httpResults.set(i, t("lab.http.noUrl"))
            return
          }
          try {
            const r = await labApi.http({
              url: target,
              method: s.httpMethod,
              // raw="1" ⇒ 不转纯文本，原样返回（看 HTML 结构/类名用）
              raw: s.httpRaw,
              // 正文当请求体（POST/PUT 才有意义；GET 时后端会忽略）
              body: s.content?.trim() || undefined,
            })
            httpResults.set(
              i,
              t("lab.http.result", {
                target,
                status: r.status,
                note: r.truncated ? t("lab.http.truncatedNote") : "",
                body: r.body,
              })
            )
          } catch (e: any) {
            httpResults.set(
              i,
              t("lab.http.failed", { target, msg: String(e?.message ?? e) })
            )
          }
            })()
          )
        }
        await Promise.all(httpJobs)

        // ---- 截图自检：把项目内联成单文件 HTML，交给服务端用真浏览器渲染 ----
        const shotResults = new Map<number, string>()
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i]
          if (s.type !== "action" || !s.complete || s.tool !== "screenshot") continue
          try {
            const files = filesRef.current
            const entryPath =
              files["index.html"] != null
                ? "index.html"
                : Object.keys(files).find((p) => /\.html?$/i.test(p))
            if (!entryPath) {
              s.content = t("lab.shot.noHtml")
              continue
            }
            const r = await labApi.screenshot({
              html: inlineAssets(files[entryPath], files, entryPath),
              fullPage: true,
              // 多断点：模型给了 device/width/height 就用它的，否则服务端兜底 1280×800
              ...(s.device ? { device: s.device } : {}),
              ...(s.width ? { width: s.width } : {}),
              ...(s.height ? { height: s.height } : {}),
            })
            // ⚠️ dataUrl 只放 image（展示 + 回喂），**绝不放进 content** ——
            //    几十 KB 的 base64 进正文会把卡片和上下文一起撑爆
            s.image = r.dataUrl
            shotResults.set(i, r.dataUrl)
            s.content = t("lab.shot.ok", {
              ms: Math.round(r.msUsed),
              used: Math.round(r.dayMs / 1000),
              limit: Math.round(r.dayLimitMs / 1000),
            })
          } catch (e: any) {
            s.content = t("lab.shot.failed", { msg: String(e?.message ?? e) })
          }
        }

        // ---- 页面体检：文字诊断（横向溢出 / console 报错 / 资源失败）----
        // 复用 httpResults 这个「按段下标存回执文本」的通道 —— 服务端
        // buildToolResults 里把 inspect 与 http 同等对待（见 lab-agent.ts）。
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i]
          if (s.type !== "action" || !s.complete || s.tool !== "inspect") continue
          try {
            const files = filesRef.current
            const entryPath =
              files["index.html"] != null
                ? "index.html"
                : Object.keys(files).find((p) => /\.html?$/i.test(p))
            if (!entryPath) {
              s.content = t("lab.inspect.noHtml")
              continue
            }
            const r = await labApi.inspect({
              html: inlineAssets(files[entryPath], files, entryPath),
              ...(s.device ? { device: s.device } : {}),
              ...(s.width ? { width: s.width } : {}),
              ...(s.height ? { height: s.height } : {}),
              ...(s.steps?.length ? { steps: s.steps } : {}),
            })
            s.content = r.text
            httpResults.set(i, r.text)
          } catch (e: any) {
            s.content = t("lab.inspect.failed", { msg: String(e?.message ?? e) })
            httpResults.set(i, s.content)
          }
        }

        // ---- 联网搜索：key 只存服务端，所以必须走接口 ----
        const searchResults = new Map<number, string>()
        // #6 同上：搜索也是网络型、互相独立 ⇒ 并行
        const searchJobs: Promise<void>[] = []
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i]
          if (s.type !== "action" || !s.complete || s.tool !== "web_search") continue
          searchJobs.push(
            (async () => {
          const q = (s.query ?? "").trim()
          if (!q) {
            searchResults.set(i, t("lab.search.noQuery"))
            return
          }
          try {
            const r = await labApi.webSearch(q)
            searchResults.set(i, r.text)
          } catch (e: any) {
            // 积分不足 / 没配 key 都是「用户要自己处理」的事，原话告诉他
            searchResults.set(
              i,
              t("lab.search.failed", { query: q, msg: String(e?.message ?? e) })
            )
          }
            })()
          )
        }
        await Promise.all(searchJobs)

        // ---- 技能：模型点名要读某个技能的正文（渐进式披露第二步）----
        // 正文在服务端，所以要单独去取一次；取回来当「工具结果」回喂。
        const skillResults = new Map<number, string>()
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i]
          if (s.type !== "action" || !s.complete || s.tool !== "skill") continue
          const wanted = (s.skill ?? "").trim()
          if (!wanted) {
            skillResults.set(i, t("lab.skill.noName"))
            continue
          }
          try {
            const got = await labApi.readSkill(wanted)
            skillResults.set(
              i,
              t("lab.skill.result", {
                name: got.skill.name,
                desc: got.skill.description,
                content: got.skill.content,
              })
            )
          } catch (e: any) {
            skillResults.set(
              i,
              t("lab.skill.failed", {
                name: wanted,
                msg: String(e?.message ?? e),
              })
            )
          }
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
          ...segmentsToEntries(
            segs,
            round,
            true,
            filesRef.current,
            runResults,
            siteResults,
            skillResults,
            searchResults,
            httpResults,
            effModel
          ),
        ])
        setLive(null)
        setLiveThink("")
        thinkRef.current = ""
    thinkShownRef.current = 0
        settleThink()
        if (liveTimer.current != null) {
          window.clearTimeout(liveTimer.current)
          liveTimer.current = null
        }
        /**
         * ⚠️ 原生模式下 assistant 消息**必须带上 tool_calls**：
         * 下一轮要按 `role:"tool"` 逐条回应这些调用，上游靠这份清单校验 `tool_call_id`，
         * 少了它就会直接报「tool 消息对不上」。
         */
        convoRef.current = [
          ...convoRef.current,
          useNative
            ? {
                role: "assistant",
                content: raw,
                tool_calls: nativeCalls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: c.args },
                })),
              }
            : { role: "assistant", content: raw },
        ]
        await refreshPreview(true)
        // 每轮结束立刻落一次本地（比定时器更及时，保住刚生成的稿子）
        void flushAutoSave()
        void persistDraft()

        if (controller.signal.aborted) break
        /**
         * 这一轮「用户看得见的东西」有哪些。
         *   · `saidSomething`：有正文（会被渲染成气泡或折叠块）
         *   · `endedWithAction`：以工具调用收尾 ⇒ 模型明显还没说完
         */
        /**
         * 这一轮模型有没有**跟用户说话**。
         *
         * 🔴 原生模式下 `segs` **只有工具调用** —— 正文在 `raw` 里，压根不会被转成 Segment。
         *    所以这里必须看 `raw`；否则永远判定为「没说」，于是每一轮都补问、
         *    最后还补一条「这轮没有说明」（2026-10-10 站长反馈）。
         */
        const saidSomething = useNative
          ? raw.trim().length > 0
          : segs.some((s) => s.type === "text" && s.text.trim().length > 0)
        if (saidSomething) turnSaidSomething = true
        const endedWithAction =
          segs.length > 0 && segs[segs.length - 1].type === "action"

        /**
         * 该收尾了，但模型一个字都没说（整轮空、只有思考、或者以动作收尾）——
         * 补问一次，让它有机会把话说完。不回喂的话用户就会看到「干完活一声不响地结束」。
         */
        const shouldNudgeClosing = !saidSomething || endedWithAction
        const mayNudgeClosing =
          shouldNudgeClosing && closingNudges < MAX_CLOSING_NUDGES

        // 整轮什么都没产出（例如预算全花在思考上，正文是空的）
        if (!segs.length) {
          if (!mayNudgeClosing) {
            // 🔴 干过活却始终空轮：同样给一次 REPORT_NUDGE 机会，然后前端自己写摘要
            const lastEntry0 = entriesRef.current[entriesRef.current.length - 1]
            const endsWithoutReport0 =
              didRealWork && (lastEntry0?.kind === "tool" || !saidSomething)
            if (endsWithoutReport0 && !reportNudged) {
              reportNudged = true
              convoRef.current = [
                ...convoRef.current,
                { role: "user", content: REPORT_NUDGE },
              ]
              continue
            }
            // 兜底：整轮下来一个字都没说，循环要结束了 —— 不能让用户只看到思考
            if (endsWithoutReport0) appendAutoReport()
            else if (!turnSaidSomething) appendSilentEndNote()
            break
          }
          closingNudges += 1
          convoRef.current = [
            ...convoRef.current,
            { role: "user", content: CLOSING_NUDGE },
          ]
          continue
        }
        const failures = new Map([...applied].filter(([, reason]) => reason))

        /**
         * 把这一轮的结果回喂给模型。
         *
         * · 文本标签协议：拼成**一条用户消息**（那时没有 tool_call_id 可对）。
         * · 原生工具调用：**每一条调用回一条 `role:"tool"` 消息** ——
         *   ⚠️ 必须**逐一对上**：assistant 里列了几条，就得回几条，
         *   少一条上游直接报错（哪怕它只是个 write / need_vm 这种"不需要看结果"的动作，
         *   也得回一句「已执行」）。
         */
        /**
         * 截图**必须走 user 角色**回喂（2026-10-13）：服务端 sanitizeMessages 只允许
         * `role:"user"` 带 image part —— 塞进 `role:"tool"` 会被直接丢掉。
         * 调用点放在工具回执**之后** ⇒ 模型先看到「截图成功」，紧接着就看到那张图。
         */
        const feedShots = () => {
          for (const [, dataUrl] of shotResults) {
            convoRef.current = [
              ...convoRef.current,
              {
                role: "user",
                content: [
                  { type: "text", text: t("lab.shot.feedNote") },
                  { type: "image_url", image_url: { url: dataUrl } },
                ],
              },
            ]
          }
        }

        const feedResults = (notes: string[]) => {
          if (useNative) {
            const calls = segs.filter((x) => x.type === "action" && x.toolCallId)
            for (const sg of calls) {
              const i = segs.indexOf(sg)
              /**
               * 🔴 **必须把「按原始下标存的」结果 map 重映射成 0**：
               * buildToolResults([sg], …) 内部是 segments.forEach((s, i) => …)，
               * 这个 i 是**传入数组**的下标（单元素数组恒为 0），而结果 map 是按
               * 原始段下标存的 ⇒ 除第 0 段外永远查不到。failures 早就重映射了，其它漏了。
               * ⚠️ undefined 不放进 map，否则会顶掉下游兜底文案。
               */
              const rekey = (m?: Map<number, string>) => {
                const v = m?.get(i)
                return v === undefined ? undefined : new Map([[0, v]])
              }
              const one = buildToolResults(
                [sg],
                filesRef.current,
                rekey(failures),
                rekey(runResults),
                rekey(siteResults),
                rekey(skillResults),
                rekey(searchResults),
                rekey(httpResults)
              )
              const body = one.replace(/^工具执行结果：\n?/, "").trim() // i18n-exempt: 剥掉 lab-agent.ts（PROMPT_FILES 已豁免）的回执前缀，中文必须与之逐字一致
              convoRef.current = [
                ...convoRef.current,
                {
                  role: "tool",
                  tool_call_id: (sg as { toolCallId: string }).toolCallId,
                  // 有些动作本地没有"结果文本"（write/replace/need_vm），
                  // 但**仍然必须回一条**，否则上游认为这次调用没被回应
                  content: body || t("lab.toolResult.empty"),
                },
              ]
            }
            if (notes.length) {
              convoRef.current = [
                ...convoRef.current,
                { role: "user", content: notes.join("\n\n") },
              ]
            }
            return
          }
          convoRef.current = [
            ...convoRef.current,
            { role: "user", content: notes.join("\n\n") },
          ]
        }
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
          // AI 申请：**不切界面**，留在聊天页；画面挂隐藏容器
          const res = await ensureVM(false)
          let note: string
          if (res.ok) {
            note = t("lab.term.readyNote")
          } else if (res.error) {
            note = t("lab.term.bootFailedNote", { error: res.error })
            // 🔴 同时弹给用户：否则界面上什么都看不到，只能看着 AI 一直跑不起来
            toast.error(t("lab.term.bootFailedToast", { error: res.error }), {
              duration: 8000,
            })
          } else {
            note = t("lab.term.rejectedNote")
          }
          // ⚠️ 同一轮里可能还夹着站内操作 —— 这里 `continue` 会跳过下面那段回喂，
          // 所以把手册和站内结果**并进同一条消息**，别把它们丢了。
          const merged: string[] = [note, ...siteNotes]
          if (siteResults.size) merged.push(...siteResults.values())
          feedResults(merged)
        feedShots()
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
                  s.tool === "delete" ||
                  s.tool === "skill" ||
                  s.tool === "web_search" ||
                  s.tool === "http")
            )
          if (hasOtherResults) {
            parts.push(
              buildToolResults(
                segs,
                filesRef.current,
                failures,
                runResults,
                siteResults,
                skillResults,
                searchResults,
                httpResults
              )
            )
          } else if (siteResults.size) {
            parts.push(
              t("lab.toolResult.head"),
              ...siteResults.values(),
              t("lab.toolResult.continue")
            )
          } else {
            // 只要了手册、还没动手：明确告诉它下一步干什么，免得又空跑一轮
            parts.push(t("lab.site.manualGiven"))
          }
          feedResults(parts)
        feedShots()
          continue
        }

        // 只有「失败的动作」或「读/列/删」才需要回喂一轮
        if (!needsToolResult(segs, failures)) {
          /**
           * 🔴 原生模式下**必须先把 tool 回执补齐再走收尾**（2026-10-12 站长反馈
           * 「模型明明写了文件，却觉得自己没写、反复重写」的真因）：
           *
           * OpenAI 协议要求 assistant 的**每一条 tool_call 都得有一条 `role:"tool"`
           * 消息回应**。write/need_vm 这类"本地无返回"的动作不走上面的回喂分支，
           * 之前在这里直接 break/continue ⇒ **悬空 tool_call** ——
           *   · 上游（中转站/模型）对悬空调用表现各异：有的直接报错，glm-5.3 的
           *     表现是**下一轮表现得像从没写过**（它既没收到回执，也拿不准写没写成）；
           *   · 于是模型反复重写同一个文件。
           * `feedResults([])` 会对每条 tool_call 回一句「已执行，无返回内容」，
           * notes 为空 ⇒ 不额外插 user 消息（不打扰收尾逻辑）。
           */
          if (useNative) {
          feedResults([])
          feedShots()
        }
          // 收尾机会：模型没留下给用户的话（空轮 / 只思考 / 以动作收尾）⇒ 补问一次
          if (mayNudgeClosing) {
            closingNudges += 1
            convoRef.current = [
              ...convoRef.current,
              { role: "user", content: CLOSING_NUDGE },
            ]
            continue
          }
          /**
           * 🔴 「干完活必须有报告」的最后一推（didRealWork 的注释见 send 开头）。
           *
           * ⚠️ 判据（2026-10-12 二次修）：「这一轮说没说话」**不够** ——
           * 模型常在干完活后只回一个字（「好」「完成」）就结束，saidSomething=true，
           * 三层全跳过 ⇒ 用户依旧看不到「做了什么」。真正该看的口径是：
           * **时间线的最后一条是不是工具卡片** —— 收尾落在动作上 = 没有总结。
           * （正文气泡结尾 = 模型给了说明，不打扰。）
           */
          const lastEntry = entriesRef.current[entriesRef.current.length - 1]
          const endsWithoutReport =
            didRealWork &&
            (lastEntry?.kind === "tool" || !saidSomething)
          if (endsWithoutReport && !reportNudged) {
            reportNudged = true
            convoRef.current = [
              ...convoRef.current,
              { role: "user", content: REPORT_NUDGE },
            ]
            continue
          }
          /**
           * 🔴 兜底：到这儿就是真的要结束了。
           * 干过活而收尾没有报告（最后一条是工具卡片、或这一轮没说话）⇒
           * 前端自己把摘要写出来 —— 用户必须知道做了什么，这不该依赖模型自觉。
           * 纯聊天没干活的静默轮才用「只输出了思考」那条提示。
           */
          if (endsWithoutReport) appendAutoReport()
          else if (!turnSaidSomething) appendSilentEndNote()
          break
        }
        // 模型要了文件内容 / 有动作失败 → 回喂结果，让它接着改
        convoRef.current = [
          ...convoRef.current,
          {
            role: "user",
            content: buildToolResults(
              segs,
              filesRef.current,
              failures,
              /**
               * 🔴 这两行原来是 undefined（真凶）：**终端命令的真实输出被整段丢掉**，
               * 回执只剩「(没能执行：…)」，模型以为终端坏了、反复 run/反复申请。
               * segs 是完整数组，下标天然对齐，直接传入即可。站内结果同理。
               */
              runResults,
              siteResults,
              skillResults,
              searchResults,
              httpResults
            ),
          },
        ]
      }
    } catch (err) {
      /**
       * 🔴 出错必须**在时间线上留痕**（2026-10-12 站长反馈「消息发出去了但没有
       * 思考标记、也没有正式开始」）：只弹 toast 的话，手机上一闪而过/切走再回来
       * 就什么都没有 —— 用户看到的是「我发了消息，然后就没有然后了」。
       * 这里补一条系统错误条目，把原因写明；toast 照旧（当时在场的人能立刻看到）。
       *
       * ⚠️ `TypeError` 不能一律说成 CORS（2026-10-12 修）：fetch 抛 TypeError 有**两种**
       * 常见原因 —— 真·跨域被拦，和**连接被中断**（切后台、网络抖动、手机被挂起）。
       * 以前一律提示「这个渠道不允许浏览器直连（CORS 限制）」，把断流误诊成配置问题，
       * 用户会跑去换渠道（白折腾）。按页面可见性/在线状态分开说。
       *
       * 🔴 用户**主动中止**（点停止 / 点插话的「立即发送」）**不算错误**
       * （2026-10-12 修）：原来照样写一条「⚠️ 这一轮没能完成：生成中断了」，
       * 于是每次打断都留个红字，用户以为出故障了。
       */
      const aborted = controller.signal.aborted
      const netInterrupted =
        !aborted && err instanceof TypeError && (document.hidden || !navigator.onLine)
      const errText =
        err instanceof HttpError
          ? err.message
          : netInterrupted
            ? t("lab.channel.interrupted")
            : err instanceof TypeError
              ? t("lab.channel.cors")
              : err instanceof Error && effChannel === "custom"
                ? err.message || t("lab.err.generic")
                : t("lab.err.stream")
      if (!aborted) {
        updateEntries((prev) => [
          ...prev,
          {
            key: `err-${Date.now()}`,
            kind: "text",
            text: `⚠️ ${t("lab.err.roundFailed")}${errText ? `：${errText}` : ""}`,
            live: false,
            collapsible: false,
            at: Date.now(),
          },
        ])
      }
      if (aborted) {
        const segs = parseAgentText(accRef.current)
        updateEntries((prev) => [
          ...prev,
          ...segmentsToEntries(segs, 99, true, filesRef.current),
        ])
      } else if (err instanceof TypeError) {
        toast.error(netInterrupted ? t("lab.channel.interrupted") : t("lab.channel.cors"))
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
      } else if (err instanceof Error && effChannel === "custom") {
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
    thinkShownRef.current = 0
      setLiveThink("")
      settleThink()
      setLive(null)
      /**
       * 本轮改动清单（#5）：把「这一轮从头到尾改了哪些文件、多少行」列成一条，
       * 挂到时间线上。原来只能逐个工具卡片去看，一轮改了五六个文件根本对不上账。
       * ⚠️ 中止/出错也走这里 —— 已经落盘的改动同样要让人看见。
       */
      {
        const rows = diffFileMap(filesAtTurnStart, filesRef.current)
        if (rows.length) {
          updateEntries((prev) => [
            ...prev,
            {
              key: `changes-${Date.now()}`,
              kind: "text" as const,
              text:
                `${t("lab.round.changes")}\n` +
                rows.map((r) => `· ${r}`).join("\n"),
              live: false,
              collapsible: false,
              at: Date.now(),
            },
          ])
        }
      }
      // 用量面板：这一轮收尾时算出来（首 token / 速度是实测，token 是估算）
      {
        const m = metricsRef.current
        const genMs = m.first !== null ? Date.now() - m.first : 0
        const outTokens = Math.round(m.outChars / 3.4)
        if (m.ctx.system || m.ctx.history) {
          setMetrics({
            system: m.ctx.system,
            tools: m.ctx.tools,
            history: m.ctx.history,
            context: m.ctx.system + m.ctx.tools + m.ctx.history,
            ttftMs: m.first !== null && m.start ? m.first - m.start : null,
            tokPerSec: genMs > 200 ? outTokens / (genMs / 1000) : null,
            outTokens,
            rounds: m.rounds,
          })
        }
      }
      setStreaming(false)
      abortRef.current = null
      // 单例也要清干净：否则切走再回来会显示一个永远转圈的「思考中」
      clearLabRun()
      await refreshPreview(true)
      // 同上：这一轮彻底结束，必须落盘一次（卸载后没有任何 effect 会替我们做）
      void persistDraft()
    }
  }

  /**
   * 这一轮跑完就把排队里的下一句发出去（中途插话的兑现点）。
   * 放 effect 里而不是循环内部：这样不用去动那个已经很复杂的 agent 循环，
   * 少一处出错的地方。代价是「等这一轮结束才生效」而不是"立刻打断"——
   * 想立刻发就点队列气泡上的「立即发送」（它会先中止当前轮，effect 随即兑现）。
   */
  React.useEffect(() => {
    if (streaming) return
    const next = steerRef.current[0]
    if (!next) return
    dropSteer(next.id)
    void send(next.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming])

  /** 「立即发送」：先中止当前轮（拿当前实例的手柄，切回来时退回单例里那个），
   *  中止后 `streaming` 变 false ⇒ 上面那个 effect 立刻把队列第一句发出去。 */
  const sendSteerNow = () => {
    const ctrl = abortRef.current ?? getLabRun().abort
    if (ctrl && !ctrl.signal.aborted) ctrl.abort()
    else if (steerRef.current[0]) {
      // 没有在跑的轮次（理论上不该发生）：直接发
      const next = steerRef.current[0]
      dropSteer(next.id)
      void send(next.text)
    }
  }

  /** 「编辑」排队中的插话：把文字填回输入框、并从队列里移除（用户改完再发） */
  const editSteer = (id: string) => {
    const item = steerRef.current.find((s) => s.id === id)
    if (!item) return
    dropSteer(id)
    setSeedDraft({ text: item.text, at: Date.now() })
  }

  /**
   * #10 失败后的两个补救动作（2026-10-12 站长要求「失败后能从这里继续」）。
   * 原来失败只剩一条「⚠️ 这一轮没能完成」，用户只能自己重新打一遍 —— 而那一轮
   * 的进度（已写入的文件、工具回执）都还在对话历史里，续跑是有意义的。
   */
  const continueRound = () => {
    // 「继续」= 发一条系统口吻的用户消息，让模型接着上次的进度干，别从头重做
    void send(t("lab.resumeNote"))
  }
  /**
   * 「重发上一条」= **原地重发**，不是再追加一条（2026-10-13 站长要求）。
   *
   * 站长原话：「这个重发上一条真的是重发啊，不太好，如果反复出错会占用上下文，
   * 把这个重发的逻辑改为把那条失败的重发，也就是说哪怕一直失败、我一直点重发上一条，
   * 记录里面只会有一条出错消息」。
   *
   * 所以这里先**回退**（时间线截到那条用户气泡之前 + 对话历史截回它入队前的位置），
   * 再用同一段文字重发 ⇒ 反复点也不会累积消息，上下文不被撑大。
   * 回退口径与 editMessage 一致；老草稿没记 convoAt 时退而求其次找最后一条 user。
   */
  const resendLast = () => {
    if (streaming) return
    const list = entriesRef.current
    let idx = -1
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].kind === "user") {
        idx = i
        break
      }
    }
    if (idx < 0) return
    const bubble = list[idx] as Extract<Entry, { kind: "user" }>
    const text = bubble.text
    if (!text.trim()) return
    // ① 时间线：截到这条气泡之前 —— 上一次的失败条目/错误条目随之消失
    updateEntries((prev) => prev.slice(0, idx))
    // ② 对话历史：截回这条消息入队前的位置
    let cut = bubble.convoAt
    if (typeof cut !== "number" || cut < 0 || cut > convoRef.current.length) {
      cut = -1
      for (let i = convoRef.current.length - 1; i >= 0; i--) {
        if (convoRef.current[i].role === "user") {
          cut = i
          break
        }
      }
    }
    if (cut >= 0) convoRef.current = convoRef.current.slice(0, cut)
    void persistDraft()
    // ③ 用同一段文字重发（send 会重新入队一条 user + 一条气泡）
    void send(text)
  }

  /**
   * 编辑一条用户消息 → **回退对话进度**、把原文填回输入框。
   *
   * ⚠️ 只回退一半，这是站长明确要求的（2026-10-10）：
   *   · **回退**：对话历史 —— entries 与 convoRef 都截断到这条之前，
   *     重发之后模型不会「记得」被撤掉的那几轮；
   *   · **不回退**：项目文件 —— AI 已经写进文件的内容原样保留。
   *     用户要的是「改一句话重来」，不是「把已经做好的活也一起抹掉」。
   */
  const editMessage = (entry: Extract<Entry, { kind: "user" }>) => {
    if (streaming) {
      toast.error(t("lab.msg.editWhileRunning"))
      return
    }
    const idx = entriesRef.current.findIndex((e) => e.key === entry.key)
    if (idx < 0) return
    const cut = entry.convoAt
    updateEntries((prev) => prev.slice(0, idx))
    // 老草稿里没记 convoAt ⇒ 不截对话（宁可多留历史，也不要截错位置）
    if (typeof cut === "number" && cut >= 0 && cut <= convoRef.current.length) {
      convoRef.current = convoRef.current.slice(0, cut)
    }
    setSeedDraft({ text: entry.text, at: Date.now() })
    void persistDraft()
    toast.success(t("lab.msg.editLoaded"))
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
    thinkShownRef.current = 0
    convoRef.current = []
    filesRef.current = {}
    setFiles({})
    setPreview("")
    setCurrentId(null)
    setSaveName("")
    setSaveDesc("")
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
    // 流式还没结束就开新会话：进行中的那几轮会把内容重新写回来（还可能写串到新会话）
    if (streaming) return
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

  /**
 * 添加素材 → 存进**同一个项目文件表**。
 *
 * 为什么走「字符串」而不是另开二进制通道：项目文件表本来就是 `Record<路径, 字符串>`
 * （正文甚至放在 R2 里），素材编码进去之后，保存 / 预览 / 导出 / 发布**全部现有管线都能直接用**；
 * 预览与导出时由 `inlineAssets`（lab-agent）把它内联进 HTML，因此 iframe 里也不会 404。
 *
 * 支持范围（2026-10-17 站长反馈：原来只收图片，应该不限格式）：
 *   · 图片 —— 栅格图压到 240KB 以内再转 data URL；**SVG 保留原文**（矢量、可编辑）；
 *   · 文本类（json / gltf / obj / js / css / md…）—— 直接存原文，AI 也能读改；
 *   · 其余二进制（字体、音频、视频、glb…）—— data URL 原样存。
 *
 * 体积约束来自服务端（worker/src/handlers/lab.ts）：单文件 800KB、作品合计 3MB。
 * 这里按 **700KB / 2.9MB** 先挡，避免用户点保存时才被整单拒绝。
 */
const ASSET_MAX_BYTES = 240_000
const ASSET_MAX_CHARS = 700_000
const ASSET_TOTAL_CHARS = 2_900_000

const assetExt = (f: File): string => {
  const i = f.name.lastIndexOf(".")
  if (i > 0 && i < f.name.length - 1) return f.name.slice(i + 1).toLowerCase()
  const sub = /^(?:image|audio|video|font)\/([\w.+-]+)$/i.exec(f.type)?.[1]
  return sub ? sub.toLowerCase() : "bin"
}

/**
 * Windows 上不少素材类型 `File.type` 是空串或 `application/octet-stream`
 * （ttf/otf/glb 都这样）。直接 FileReader 会把 data URL 标成 octet-stream，
 * 预览里显示得莫名其妙，浏览器按 MIME 处理字体/模型时也可能不认。
 * 这里按扩展名补一份常见类型。
 */
const ASSET_MIME: Record<string, string> = {
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  eot: "application/vnd.ms-fontobject",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "text/plain",
  stl: "model/stl",
  wasm: "application/wasm",
  pdf: "application/pdf",
  zip: "application/zip",
}

const assetBlob = (f: File): Blob => {
  const type =
    f.type && f.type !== "application/octet-stream" ? f.type : ASSET_MIME[assetExt(f)] ?? f.type
  return type && type !== f.type ? new Blob([f], { type }) : f
}

const readAssetContent = async (f: File): Promise<string> => {
  const readText = async (): Promise<string> => {
    // 4MB 以上不可能压到 700k 字符以内（UTF-8 一个字符至少 1 字节），先挡掉再读
    if (f.size > ASSET_MAX_CHARS * 4) throw new AssetTooLarge()
    return decodeTextBytes(new Uint8Array(await f.arrayBuffer())).replace(/\u0000/g, "")
  }
  // SVG 是文本：存原文比转位图更小、可缩放、AI 还能直接改
  if (f.type === "image/svg+xml" || assetExt(f) === "svg") {
    const text = await readText()
    if (text.length > ASSET_MAX_CHARS) throw new AssetTooLarge()
    return text
  }
  if (f.type.startsWith("image/")) {
    // compressToLimit 压不到目标体积时返回 null（不是抛错）
    const small = await compressToLimit(f, ASSET_MAX_BYTES)
    if (small) return fileToDataUrl(small)
    /**
     * 浏览器解不了这张图（HEIC 之类），或压不下去。
     * 只要原始体积还在单文件预算内，就**原样存** —— 用户要的是「素材能进项目」，
     * 网页里用不用得了由浏览器能力决定，不该由我们直接拒收。
     */
    if (f.size <= Math.floor(ASSET_MAX_CHARS * 0.73)) {
      const url = await fileToDataUrl(assetBlob(f))
      if (url.length <= ASSET_MAX_CHARS) return url
    }
    throw new AssetTooLarge()
  }
  if (isTextLikeFile(f.name, f.type)) {
    const text = await readText()
    if (text.length > ASSET_MAX_CHARS) throw new AssetTooLarge()
    return text
  }
  // 其余按二进制处理：先按 base64 膨胀 1/3 粗判，再按实际 data URL 长度收口
  if (f.size > Math.floor(ASSET_MAX_CHARS * 0.73)) throw new AssetTooLarge()
  const url = await fileToDataUrl(assetBlob(f))
  if (url.length > ASSET_MAX_CHARS) throw new AssetTooLarge()
  return url
}

const ingestAssets = async (picked: File[]) => {
  if (!picked.length) return
  setLocalBusy(true)
  try {
    const add: Record<string, string> = {}
    /** 预算表：同一个路径重复添加时按「替换」算，不重复占额度 */
    const budget: Record<string, string> = { ...filesRef.current }
    let total = Object.values(budget).reduce((n, s) => n + s.length, 0)
    let tooLarge = 0
    let failed = 0
    let overLimit = 0

    for (const f of picked) {
      const ext = assetExt(f)
      // 保留中文/Unicode 字母，别把「字体.ttf」压成「__.ttf」
      const base =
        f.name.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 40) || "asset"
      const path = `assets/${base}.${ext}`
      try {
        const content = await readAssetContent(f)
        const baseLen = total - (budget[path]?.length ?? 0)
        if (baseLen + content.length > ASSET_TOTAL_CHARS) {
          overLimit++
          continue
        }
        add[path] = content
        budget[path] = content
        total = baseLen + content.length
      } catch (e) {
        if (e instanceof AssetTooLarge) tooLarge++
        else failed++
      }
    }

    const names = Object.keys(add)
    if (names.length === 0) {
      toast.error(t("lab.assets.none"))
    } else {
      const merged = { ...filesRef.current, ...add }
      filesRef.current = merged
      setFiles(merged)
      setPreview(buildPreviewDoc(merged))
      setPreviewSeq((s) => s + 1)
      toast.success(t("lab.assets.done").replace("{n}", String(names.length)))
    }
    // 失败原因照常提示（即使一个都没成功，用户也需要知道是「太大」还是「读取失败」）
    if (tooLarge > 0) toast.warning(t("lab.assets.skipped").replace("{n}", String(tooLarge)))
    if (failed > 0) toast.warning(t("lab.assets.failed").replace("{n}", String(failed)))
    if (overLimit > 0) toast.warning(t("lab.assets.limit").replace("{n}", String(overLimit)))
  } catch {
    toast.error(t("lab.err.generic"))
  } finally {
    setLocalBusy(false)
  }
}

/** 打开系统文件选择器（用程序化 input：不必为它加 state 和 JSX） */
const doAddAssets = () => {
  const input = document.createElement("input")
  input.type = "file"
  // ⚠️ 刻意**不设 accept**：素材不只图片，字体/音频/视频/模型/JSON 都要能选
  input.multiple = true
  input.onchange = () => void ingestAssets([...(input.files ?? [])])
  input.click()
}
/**
 * 点「可视输入框」的任何留白都聚焦输入框（2026-10-11 修移动端）。
 *
 * 现象（站长反馈）：输入框的**触摸位置与外观位置不一致** —— 看着能点的地方点上去没反应。
 * 实测（iPhone 13 仿真）：可视盒子 350×82，而真正的 textarea 只有 326×22，
 * 四周留白 12px（左右上）/ 48px（下）；点在留白上命中的是普通 div ⇒ 不会聚焦。
 *
 * 为什么要在这里兜一层，而不是去改 PromptBar：那是 ReactBits 的**逐字复制**组件
 * （我们唯一允许的改动是 renderSend 接发送键），改它等于把上游代码弄脏、以后没法升级。
 * 所以在外层包装上兜：命中按钮/链接/输入框就放行，其余一律聚焦。
 */
const onComposerTap = (e: React.PointerEvent<HTMLDivElement>) => {
  const target = e.target as HTMLElement | null
  if (!target) return
  // 各司其职：点到按钮、链接、输入框本身、可编辑区就交给它们
  // ⚠️ 排除「弹层内容 + 所有可交互角色」：
    //    之前只排除了 button/a/input/textarea，于是**滑块（div[role=slider]）**、
    //    模型列表项（role=option）、菜单项（role=menuitem）都没被排除 ⇒
    //    点它们时这里反而去聚焦输入框、把手机软键盘顶起来（2026-10-11 站长反馈）。
    if (
      target.closest(
        "button, a, input, textarea, select, [contenteditable='true'], " +
          "[role='button'], [role='slider'], [role='listbox'], [role='option'], [role='menu'], [role='menuitem'], [role='dialog'], [role='switch'], [role='checkbox'], [role='radio'], " +
          "[data-radix-popper-content-wrapper]"
      )
    ) {
    return
  }
  const field = e.currentTarget.querySelector<HTMLElement>("textarea, input[type='text']")
  field?.focus()
}
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

  /**
   * 导出当前工作区。
   *  · 单文件：CSS/JS 内联进一个 html，双击就能看（发给别人最省事）；
   *  · zip：保留原目录结构（多文件作品、要用构建工具的走这条）。
   */
  const doExport = (
    kind: "html" | "zip",
    files: Record<string, string>,
    rawName: string
  ) => {
    const paths = Object.keys(files)
    if (!paths.length) {
      toast.error(t("lab.export.empty"))
      return
    }
    // 文件名取作品名，没有就用时间；都做一次文件名净化，别带路径分隔符
    const base = (rawName.trim() || `lab-${Date.now()}`).replace(/[\\/:*?"<>|]/g, "-")
    if (kind === "html") {
      const html = buildSingleFileHtml(files)
      if (!html) {
        toast.error(t("lab.export.noHtml"))
        return
      }
      downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), `${base}.html`)
    } else {
      downloadBlob(zipFiles(files), `${base}.zip`)
    }
    setExportFor(null)
    setExportFiles(null)
  }

  /** 打开导出弹窗时先把该作品的文件拉下来（列表接口不带文件内容） */
  const openExport = async (projectId: string) => {
    setExportFor(projectId)
    setExportFiles(null)
    setExportBusy(true)
    try {
      const { project } = await labApi.getProject(projectId)
      setExportFiles(project.files ?? {})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("lab.export.loadFailed"))
      setExportFor(null)
    } finally {
      setExportBusy(false)
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
    // 切项目同理：流式进行中先拦下，免得进行中的写入落到刚打开的作品上
    if (streaming) return
    try {
      const { project } = await labApi.getProject(id)
      // 换项目 = 换会话：时间线 / 对话历史 / 流式缓冲一起重置，
      // 否则旧会话的对话会被拼进新作品的请求里（串写）
      setEntries([])
      setLive(null)
      setLiveThink("")
      thinkRef.current = ""
      convoRef.current = []
      accRef.current = ""
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
    // 保存前必须先把 JSX/TS 编出 .js —— R2 里只放源码的话，绑定的域名会打不开
    const compiled = await syncCompiled()
    if (compileErrors.length) {
      toast.error(t("lab.compile.failed", { file: compileErrors[0].path }))
      return
    }
    const current = compiled
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
  const openInNewTab = async () => {
    // 新标签页里跑的是静态产物，先把 JSX/TS 编译出来
    const next = await syncCompiled()
    if (compileErrors.length) {
      toast.error(
        t("lab.compile.failed", { file: compileErrors[0].path })
      )
      return
    }
    const doc = buildPreviewDoc(next)
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
      {/*
        ⚠️ 必须能**换行**（2026-10-10 站长反馈「手机端上面那排按钮超出范围」）：
        这排按钮是 `flex` 且 `shrink-0`（不收缩），按钮一多就把整行撑得比屏幕宽 ——
        后果不只是按钮被切掉：**整个页面会横向溢出**，于是居中的聊天区和
        新发出来的消息都被推到屏幕外（同一时间站长反馈的「发消息没反应」就是它）。
        换行而不是横向滚动：不会有「藏在右边的按钮」这种发现不了的东西。
      */}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
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
        <Button variant="ghost" size="sm" onClick={openProjects} disabled={streaming}>
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
          /**
           * ⚠️ 手机端隐藏（2026-10-10 站长要求）：
           * 窄屏上这个按钮挤在动作条里没什么用，还占位置。
           * 用 `hidden sm:inline-flex` 而不是 `max-sm:hidden` —— 后者依赖较新版本，
           * 前者任何版本都稳（Button 本身是 inline-flex，这里只是覆盖显示值）。
           */
          className="inline-flex"
          onClick={() => setPreviewOpen((v) => !v)}
          title={t("lab.preview.switchHint")}
        >
          <PanelRight className="h-4 w-4" />
          <span className="hidden sm:inline">
            <span className="hidden sm:inline">{previewOpen ? t("lab.preview.back") : t("lab.previewLive")}</span>
          </span>
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
        ref={widthBoxRef}
        className="relative min-h-0 flex-1 overflow-hidden pt-3"
        style={
          {
            perspective: "1600px",
            /**
             * 内容列宽度 —— 拖拽手柄写的就是它（见 index.css 的 .lab-col /
             * .lab-width-handle）。所有内容列（时间线、输入框、横幅）都用
             * `.lab-col` 取这个值，所以拖一次全跟着变。
             */
            "--lab-content-width": `${contentWidth}px`,
          } as React.CSSProperties
        }
      >
        {/*
          ---- 内容列宽度拖拽手柄（左右各一条，鼠标移过去才显示一条小竖线）----
          预览屏打开时对话列不在可视区，就不显示手柄了（拖它也没意义）。
        */}
        {!previewOpen && (
          <>
            <WidthHandle
              side="left"
              onStart={onWidthStart}
              onDrag={onWidthDrag}
              onCommit={onWidthCommit}
              onEnd={onWidthEnd}
            />
            <WidthHandle
              side="right"
              onStart={onWidthStart}
              onDrag={onWidthDrag}
              onCommit={onWidthCommit}
              onEnd={onWidthEnd}
            />
          </>
        )}
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
              <div ref={timelineInnerRef} className="lab-col space-y-2.5 py-2">
                {timeline.map((e) => (
                  <div key={e.key}>
                    <TimelineEntry entry={e} onEdit={editMessage} />
                    {/*
                      #10：失败条目下面给两个补救按钮。
                      判据是 key 前缀 —— 错误条目统一用 `err-` 开头（见 catch 里）。
                    */}
                    {e.kind === "text" && e.key.startsWith("err-") && !streaming && (
                      <div className="mt-1 flex items-center gap-1.5 pl-1 text-[11px]">
                        <button
                          type="button"
                          title={t("lab.err.continueHint")}
                          onClick={continueRound}
                          className="rounded-full border border-border/70 px-2 py-0.5 font-medium text-primary hover:bg-primary/10"
                        >
                          {t("lab.err.continue")}
                        </button>
                        <button
                          type="button"
                          onClick={resendLast}
                          className="rounded-full border border-border/70 px-2 py-0.5 text-muted-foreground hover:bg-accent"
                        >
                          {t("lab.err.resend")}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {/*
                  ---- 待发送的插话（2026-10-12 站长要求：可见、可改、可立刻发）----
                  以前插话只存在 ref 里，界面上毫无痕迹。现在排在时间线末尾，
                  一眼看得到内容，并且能编辑 / 立即发送 / 撤回。
                */}
                {steerQueue.map((s) => (
                  <div key={s.id} className="flex flex-col items-end gap-1">
                    <div className="max-w-[85%] rounded-2xl border border-dashed border-primary/50 bg-primary/10 px-3.5 py-2 text-sm leading-relaxed text-foreground">
                      <p className="whitespace-pre-wrap break-words">{s.text}</p>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span>{t("lab.steer.pending")}</span>
                      <button
                        type="button"
                        onClick={sendSteerNow}
                        className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10"
                      >
                        {t("lab.steer.sendNow")}
                      </button>
                      <button
                        type="button"
                        onClick={() => editSteer(s.id)}
                        className="rounded px-1.5 py-0.5 hover:bg-accent"
                      >
                        {t("lab.steer.edit")}
                      </button>
                      <button
                        type="button"
                        onClick={() => dropSteer(s.id)}
                        className="rounded px-1.5 py-0.5 text-destructive hover:bg-destructive/10"
                      >
                        {t("lab.steer.remove")}
                      </button>
                    </div>
                  </div>
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

          {/*
            ---- 本轮用量指标（#3/#8）----
            站长要的「像 DSH 那样的上下文状态」：占了多少、哪部分占的、
            首 token 多久、每秒多少 token。数字前面带「≈」的是估算值。
          */}
          {metrics && (
            <div className="lab-col mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              <span>{t("lab.metrics.context", { n: fmtTok(metrics.context) })}</span>
              <span>
                {t("lab.metrics.parts", {
                  s: fmtTok(metrics.system),
                  tl: fmtTok(metrics.tools),
                  h: fmtTok(metrics.history),
                })}
              </span>
              {metrics.ttftMs !== null && (
                <span>{t("lab.metrics.ttft", { s: (metrics.ttftMs / 1000).toFixed(1) })}</span>
              )}
              {metrics.tokPerSec !== null && (
                <span>{t("lab.metrics.speed", { n: metrics.tokPerSec.toFixed(1) })}</span>
              )}
              <span>{t("lab.metrics.out", { n: fmtTok(metrics.outTokens) })}</span>
            </div>
          )}
          {stationMissing && channel === "station" && (
            <div className="lab-col mb-2 flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
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
            <div className="lab-col mb-2 flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
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
            <div className="lab-col mb-2 flex items-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
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
              ⚠️ `relative right-[5px]` 不是随手写的：
              消息列表在时间线里居中，而时间线被滚动条占掉 10px
              （见 index.css 的 .lab-timeline { scrollbar-gutter: stable }），
              所以消息的居中基准比整列窄 10px ⇒ 输入框要往左让正好一半，才能左右都对齐。
              不能用 `mr-[10px]`：它会顶掉 `mx-auto` 的 margin-right，
              只剩 margin-left:auto，整条输入框会被推到最右边（2026-10-10 站长反馈）。
              「AI 实验室动效」开着时用 ReactBits 的 PromptBar：模型选择、思考强度、
              发送/停止都收在那一条里；关掉时用下面这套原来的朴素输入框。
              两者是**二选一**，不靠互相覆盖，所以关掉之后与改动前逐字一致。 */}
          {labFxOn ? (
            /*
              ⚠️（JSX 里这里只能用普通注释：`? (` 后面只能接**一个表达式**，
              写成 `{/* *\/}` 会变成两个并列子节点 ⇒ 语法错误。）

              那个 `right-[5px]` 只在**桌面**是对的：
              时间线用 `scrollbar-gutter: stable` 预留了 10px 滚动条，消息居中基准比整列窄，
              所以输入框要往左让一半才对齐（详见下方原注释）。
              但**手机上滚动条是浮层、预留为 0** ⇒ 这 5px 就成了纯偏移，
              把整条输入框推出左边界（2026-10-10 站长反馈「左边被截断、右边差一点」）。
              ⇒ 只在 ≥sm 生效，手机上归零。
            */
            <div
          // 整块可视输入框都可点（见 onComposerTap 的说明）
          onPointerDown={onComposerTap}
          className="relative right-0 lab-col shrink-0 pt-6 pb-1 sm:right-[5px]"
        >
              {/*
                思考强度越高，输入框外面套一层光（见 index.css 的 .lab-composer-glow）：
                  · xhigh = 常驻环绕微光；
                  · max   = 微光 + 扭转光带。
                包在**紧贴输入框**的这一层上（不带 padding），
                否则光会被那圈 pt-6 撑到盒子外面去、对不上边。
              */}
              <div
                className={cn(
                  "relative",
                  effort === "xhigh" && "lab-composer-glow",
                  effort === "max" && "lab-composer-glow"
                )}
              >
                {/*
                  旋转光带**单独一个被裁剪的容器**，不挂在 glow 容器自己的伪元素上：
                  见 index.css 里 .lab-composer-glow-ring 的注释 ——
                  只有让外层 overflow:hidden 把内层裁掉，光才真的出不了输入框。
                */}
                {effort === "max" && (
                  <span className="lab-composer-glow-ring" aria-hidden="true" />
                )}
              <PromptBar
                /**
                 * ⚠️ 只对**模型按钮里的那个名字**限宽 + 省略号（2026-10-10 站长要求）：
                 * 按钮是 `flex-none`（不收缩），名字多长按钮就多宽，一超就把发送键顶出输入框。
                 * 这里用 CSS 限宽而不是按字数截断 —— 中英文/自定义名字宽度差很多，
                 * 按字数截要么撑破要么截太狠。**展开的列表不受影响，显示全名。**
                 *
                 * 宽度取 160px：**它是一个「防超长」的安全上限，不是通常生效的截断点**。
                 * 我们的模型名（去掉前缀后最长 18 字）大约 110px ⇒ 正常显示**完整名字**，
                 * 按钮就跟着名字自然变长；只有用户自己填了超长自定义名字时才会省略。
                 * ⚠️ 上一版误把它当「截断点」取了 76px，比名字本身还窄 ⇒ 按钮反而变短了
                 *    （2026-10-10 站长反馈「为什么按钮更短了」）。
                 * 想再调长短就改这一个数字。
                 */
                className="[&_button[aria-label='Choose_model']>span]:max-w-[160px] [&_button[aria-label='Choose_model']>span]:overflow-hidden [&_button[aria-label='Choose_model']>span]:text-ellipsis [&_button[aria-label='Choose_model']>span]:whitespace-nowrap [&_[role=listbox]]:max-h-[min(404px,60vh)] [&_[role=listbox]]:overflow-y-auto [&_[role=listbox]]:overscroll-contain [&_[role=slider]]:touch-none"
                placeholder={t("lab.inputPlaceholder")}
                models={fxModels}
                defaultModel={fxDefaultModelKey}
                efforts={fxEfforts}
                defaultEffort={fxEfforts[EFFORT_LEVELS.indexOf(effort)] ?? ""}
                onEffortChange={(label: string) => {
                  const i = fxEfforts.indexOf(label)
                  if (i >= 0) persistEffort(EFFORT_LEVELS[i])
                }}
      seedDraft={seedDraft ?? undefined}
      /** 「自定义模型…」这一项不是模型，而是开配置弹窗 */
      onModelPick={(key: string) => {
        if (key === "custom-setup") {
          setChannelOpen(true)
          return true
        }
        return false
      }}
      sources={fxSources}
      onAttach={handleAttach}
      /**
       * 「技能」这一项不往输入框插 `@技能`，而是开管理对话框
       * （用户不需要手写技能名 —— 系统提示里已经带目录，模型自己判断）。
       */
      onSource={(key: string) => {
        if (key === "skills") {
          setSkillOpen(true)
          return true
        }
        if (key === "web") {
          setSearchKeyOpen(true)
          return true
        }
        if (key === "ref") {
          setRefOpen(true)
          return true
        }
        return false
      }}
      busy={streaming}
      onSend={(text: string, detail: { model?: { key: string }; attachments?: string[] }) => {
        applyFxModel(detail?.model?.key)
        // 用户在「+」里明确要动站内数据 ⇒ 这一轮把手册直接给他，别让他再拉一遍
        siteOpRef.current = /@站内操作|@site\b/i.test(text) // i18n-exempt: 用户输入的 @ 提及关键词，必须同时认中英字面（「+」菜单按当前语言插入 @站内操作 / @Site operations）
        // 附件正文由 send 内部并进「给模型的那份」，不糊在聊天里
        /**
         * ⚠️ 这里**不再自己判断 `streaming`**（2026-10-12 修）。
         *
         * 原来这里有一份「运行中就排队」的逻辑，和 send() 开头那份**重复**了 ——
         * 后果是 send() 里那份（会区分「这一轮还活着」和「这一轮卡死了」）
         * **永远轮不到**：半开连接把 `streaming` 卡住时，用户发的消息只会被默默排进
         * 队列，而「上一轮结束」那一刻永远不来 ⇒ 表现就是「发出去什么回应都没有」。
         * 现在统一交给 send()：活着就排队（并在时间线上显示「待发送」）、
         * 卡死了就先收掉旧轮再发。
         */
        void send(text, detail?.attachments ?? [], detail?.model?.key)
      }}
                onStop={stop}
      /** 组件里这几处文案写死了英文，按当前语言覆盖掉 */
      labels={{
        effortTitle: t("lab.effortMenu.title"),
        effortHint: t("lab.effortMenu.hint"),
        faster: t("lab.effortMenu.faster"),
        smarter: t("lab.effortMenu.smarter"),
      }}
      /**
       * ⚠️ 宽度**必须跟着内容列走**（2026-10-12 站长反馈「拉宽后聊天框的光效没变」）：
       * PromptBar 根元素是 `width: min(var(--pb-w), 100%)` —— 写死 768 的话，
       * 内容列被拖宽后**消息变宽、输入框还钉在 768**，而外面那层光效挂在列宽上
       * ⇒ 光比输入框宽一圈、看着完全对不上。传当前生效宽度即可（列宽已钳制过）。
       */
      width={contentWidth}
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
                      /**
                       * 🔴 2026-10-17 修线上反馈「实验室 / 强制暂停不好使」。
                       *
                       * 这里原来调的是 `trigger` —— 而 `trigger` 在忙碌时的语义是
                       * 「**草稿为空**才是停止，**草稿有内容**就改成插话（steer）」。
                       * 于是用户在输入框里打了字（很常见：边看生成边想下一句），
                       * 再点这个明确标着「停止」的方块，实际发生的是**插话**，
                       * 生成照跑不停 —— 表现就是「强制暂停不好使」，
                       * 而且那一刻页面上**没有别的停止入口**（忙碌时只渲染这一个按钮）。
                       *
                       * 这个按钮的标题、图标都是「停止」，那它就必须只做停止。
                       * 插话仍然可用：在输入框里直接回车（走 PromptBar 的 onSend，
                       * 页面侧会把忙碌中的消息按 steer 排队），不再抢这个按钮。
                       */
                      onClick={stop}
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
             * ⚠️ 让**可点区域和看得见的圆环一样大**（2026-10-10 站长反馈
             * 「触发位置和显示位置不同」）。
             *
             * 组件内部给 pad 的命中区只外扩了 6px（`after:-inset-1.5`），
             * 但外面那圈「井」（well）比 pad 宽 22px ⇒ 每边多出 11px。
             * 结果：用户看着 52px 的圆往下点，只有中间 42px 有反应，边上点了没动静。
             * 这里把命中区外扩到 11px（11 < 输入框自身 12px 内边距，不会捅出去）。
             * 组件源码保持原样，只从调用点覆盖这一个值。
             */
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
            className={cn(
              "shrink-0",
              /**
               * 🔴 修复「发送按钮左半边点不动」（2026-10-12 站长反馈）。
               *
               * SlingButton 的 root 靠 `[width:var(--sl-size)] [height:var(--sl-size)]`
               * 这两个 arbitrary utility 拿尺寸 —— 实测线上**只有 width 生效、height 是 0**
               * （Tailwind v4 对带 var() 的 arbitrary height 的生成/覆盖有问题）：
               * root 30×0 ⇒ 里面的 pad 按钮（absolute inset-0）也是 0 高 ⇒ 命中区退化成
               * 贴着输入框底边的一条线，`after:-inset-[11px]` 外扩也救不回来（父级 0 高）。
               * 手机上输入框更高，这条「线」被左侧其他层盖掉一半 ⇒ 左半无反应、右半正常。
               *
               * 修法：调用点用**标准尺寸类**（`size-8` 生成 width+height，不依赖 var 转义）
               * 直接把 root 撑成 32×32 —— 组件源码不动，视觉尺寸不变（SVG 圆环本来就是
               * 绝对定位画出来的，不吃布局高度）。
               */
              "size-8",
              "[&_button]:after:-inset-[11px]"
            )}
          />
                  )
                }
              />
              </div>
            </div>
          ) : (
            // ⚠️ 同上：`right-[5px]` 是给桌面滚动条留白做的补偿，
            //    手机上没有留白 ⇒ 会把输入框推出左边界，所以只在 ≥sm 生效。
            <div
          // 整块可视输入框都可点（见 onComposerTap 的说明）
          onPointerDown={onComposerTap}
          className="relative right-0 lab-col shrink-0 pt-6 pb-1 sm:right-[5px]"
        >
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
                <div className={cn("flex h-full w-full flex-col", termTab && "hidden")}>
                  {/*
                    JSX / TS 编译失败时必须显式告诉用户 —— 否则产物缺失，他看到的只是一片白屏，
                    完全联想不到是「某个源码文件语法错了」。
                  */}
                  {compileErrors.length > 0 && (
                    <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                      <span className="font-medium">
                        {t("lab.compile.badge")}：
                      </span>
                      {compileErrors.map((e, i) => (
                        <span key={`${e.path}-${i}`} className="mr-3 inline-block">
                          {e.path} — {e.message}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="min-h-0 flex-1">
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
              🔴 手机上**整条隐藏**（2026-10-12 站长反馈「发送按钮左半边点不动」）：
              这块 40px 宽的隐形命中区贴着右边**贯穿全屏**，在触屏上没有 hover、
              圆钮永远不出现，但它**始终在挡东西** —— 发送按钮（SlingButton）就在
              它的覆盖范围里，左半边被它吃掉，怎么点都没反应。
              手机上切预览走顶部工具栏的「在线预览」按钮，这块命中带没有存在意义。
              判定用 `hover:none`（无悬停能力 = 触屏）：带触屏的桌面不受影响。
            */
            "[@media(hover:none)]:hidden",
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
      <SearchKeyDialog
        open={searchKeyOpen}
        onOpenChange={(o) => {
          setSearchKeyOpen(o)
          // 关掉时重拉设置：把刚打开的联网搜索开关同步进系统提示
          if (!o) setSettingsKey((k) => k + 1)
        }}
      />

      {/* ---- 参考网址 ---- */}
      <Dialog open={refOpen} onOpenChange={(o) => !o && setRefOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("lab.ref.title")}</DialogTitle>
            <DialogDescription>{t("lab.ref.desc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="lab-ref-url" className="text-xs">
              {t("lab.ref.label")}
            </Label>
            <Input
              id="lab-ref-url"
              value={refDraft}
              onChange={(e) => setRefDraft(e.target.value)}
              placeholder="https://example.com"
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("lab.ref.hint")}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={refBusy || !refDraft.trim()} onClick={() => void fetchRef()}>
              {refBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {t("lab.ref.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SkillDialog
        open={skillOpen}
        onOpenChange={(o) => {
          setSkillOpen(o)
          // 关掉时重拉一次设置：把刚导入的技能同步进系统提示的技能目录
          if (!o) setSettingsKey((k) => k + 1)
        }}
      />

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

      {/*
        隐藏的终端画面容器：见 hiddenVmRef 的注释。
        常驻渲染（不在视口内），这样 AI 申请终端时不必切界面也能启动虚拟机。
      */}
      <div
        ref={hiddenVmRef}
        aria-hidden
        className="lab-term-screen pointer-events-none fixed left-[-10000px] top-0 h-[400px] w-[640px] overflow-hidden opacity-0"
      />

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
              {(() => {
                const content = files[viewFile ?? filePaths[0]] ?? ""
                const meta = dataUrlMeta(content)
                if (!meta) {
                  return (
                    <pre className="max-h-[50vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                      {content}
                    </pre>
                  )
                }
                if (meta.mime.startsWith("image/")) {
                  return (
                    <div className="flex max-h-[50vh] flex-col items-center justify-center gap-2 overflow-auto rounded-md border bg-muted/40 p-3">
                      <img src={content} alt="" className="max-h-[42vh] max-w-full object-contain" />
                      <span className="text-[10px] text-muted-foreground">
                        {meta.mime} · {formatBytes(meta.bytes)}
                      </span>
                    </div>
                  )
                }
                if (meta.mime.startsWith("audio/")) {
                  return (
                    <div className="flex flex-col justify-center gap-2 rounded-md border bg-muted/40 p-4">
                      <audio controls src={content} className="w-full" />
                      <span className="text-[10px] text-muted-foreground">
                        {meta.mime} · {formatBytes(meta.bytes)}
                      </span>
                    </div>
                  )
                }
                if (meta.mime.startsWith("video/")) {
                  return (
                    <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3">
                      <video controls src={content} className="max-h-[42vh] w-full rounded" />
                      <span className="text-[10px] text-muted-foreground">
                        {meta.mime} · {formatBytes(meta.bytes)}
                      </span>
                    </div>
                  )
                }
                return (
                  <div className="flex max-h-[50vh] flex-col items-center justify-center gap-1 overflow-auto rounded-md border bg-muted/40 p-6 text-center">
                    <p className="text-xs font-medium">{t("lab.files.binary")}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {meta.mime} · {formatBytes(meta.bytes)}
                    </p>
                  </div>
                )
              })()}
            </div>
          )}
          <DialogFooter className="sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void doAddAssets()}
                disabled={localBusy}
                title={t("lab.assets.hint")}
              >
                {t("lab.assets.add")}
              </Button>
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
                  {/*
                    绑定域名的入口**已搬到造物集**（2026-10-12 站长要求：
                    不要放在实验室的「我的作品」里）—— 见 gallery.tsx 的 EditDialog。
                    这里只留「导出」与「打开」两个动作。
                  */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground"
                    title={t("lab.export.title")}
                    onClick={() => void openExport(p.id)}
                  >
                    <HardDriveDownload className="h-4 w-4" />
                  </Button>
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

      {/* ---- 导出作品（单文件 / zip）---- */}
      <Dialog open={exportFor !== null} onOpenChange={(o) => !o && setExportFor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("lab.export.title")}</DialogTitle>
            <DialogDescription>{t("lab.export.desc")}</DialogDescription>
          </DialogHeader>
          {exportBusy || !exportFiles ? (
            <p className="rounded-md border border-dashed p-5 text-center text-xs text-muted-foreground">
              <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
              {t("lab.export.loading")}
            </p>
          ) : (
            <div className="space-y-1.5">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/60"
                onClick={() => {
                  const p = projects.find((x) => x.id === exportFor)
                  doExport("html", exportFiles, p?.name ?? "")
                }}
              >
                <FileText className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  {t("lab.export.html")}
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {t("lab.export.htmlHint")}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/60"
                onClick={() => {
                  const p = projects.find((x) => x.id === exportFor)
                  doExport("zip", exportFiles, p?.name ?? "")
                }}
              >
                <FolderOpen className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  {t("lab.export.zip")}
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {t("lab.export.zipHint")}
                  </span>
                </span>
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- 绑定域名的弹窗已搬到造物集（gallery.tsx 的 EditDialog）---- */}

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
