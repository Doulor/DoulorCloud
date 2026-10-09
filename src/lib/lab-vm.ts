/**
 * 浏览器内 Linux 终端（v86 模拟器）—— 与 UI 无关的纯逻辑。
 *
 * 为什么要有它：AI实验室的 agent 只能读写文件、**看不到任何运行结果**，
 * 写错了自己也发现不了。这个模块把一台真 Linux 塞进浏览器
 * （v86 模拟 32 位 x86，跑一份约 8MB 的 Buildroot 镜像），
 * 让 agent 能真的执行命令、读到输出。
 *
 * 它跑在**用户自己的浏览器里**：不吃服务器资源，也不存在服务端沙箱逃逸问题。
 * 代价是首次要下载约 8MB，并占用用户的 CPU / 内存。
 *
 * 实测的镜像能力（很重要，别对模型乱承诺）：
 *   有 —— ash(busybox shell) / cat grep sed awk tr wc sort / tar gzip / vi / lua
 *   没有 —— node、npm、python
 *   ⇒ 能跑 shell 脚本、做文本处理、验证文件结构，**跑不了前端构建**。
 *
 * 通信方式（实测可行，见 .workbuddy/memory/2026-10-09.md）：
 *   - emulator.serial0_send(text)          —— 直接发命令，不必模拟键盘
 *   - on("serial0-output-byte")            —— 收集输出
 *   - 用「哨兵行」判断命令结束：cmd 后紧跟 echo "__LABDONE_xxx__$?"，读到哨兵即完成
 *   - 宿主 → 虚拟机传文件走 heredoc（带引号的分隔符，避免 $ 被展开）
 */

export type VmPhase = "off" | "loading" | "ready" | "error"

export type CommandResult = {
  /** 清洗后的输出（已去 ANSI、回显、哨兵行） */
  output: string
  /** 退出码；没解析到就是 null */
  code: number | null
  timedOut: boolean
}

/** 静态资源目录（public/webvm 下的文件会被原样发布到这个路径） */
const ASSET_BASE = "/webvm"

/**
 * 素材版本号 —— 🔴 **换镜像或换 v86 构建时必须 +1**。
 *
 * `/webvm/*` 走的是「一年不可变」缓存（见根目录 site-worker.js）。这些文件名里
 * **没有内容哈希**，所以只有 URL 变了浏览器才会重新下载；不改这个数字，
 * 用户会一直吃旧镜像的缓存，表现是「明明换了镜像却毫无变化」，极难排查。
 *
 * 背景（2026-10-09 修）：改之前 `/webvm/*` 的响应头是 `no-store` ⇒
 * **每次启用终端都重新下 7.4MB**，这才是「启用要等半天」的真凶（不是没缓存，是压根不让缓存）。
 * 修完之后：第一次下 7.4MB，之后从磁盘缓存读，启用只剩 v86 引导的 CPU 时间。
 */
const ASSET_VERSION = "1"
const assetUrl = (name: string) => `${ASSET_BASE}/${name}?v=${ASSET_VERSION}`

/** 虚拟机里的项目根目录 */
export const VM_PROJECT_DIR = "/root/project"

/** 单文件超过这个大小就不往虚拟机里同步（串口带宽有限，大文件会卡很久） */
const MAX_SYNC_FILE_BYTES = 120_000

/** 从启动到登录提示符出现的上限 */
const BOOT_TIMEOUT_MS = 120_000

let emulator: any = null
let serialBuf = ""
let phase: VmPhase = "off"
let lastError = ""
let bootPromise: Promise<void> | null = null
let screenEl: HTMLElement | null = null
/** 已同步进虚拟机的文件（路径 → 内容），用来只推有变化的 */
const syncedFiles = new Map<string, string>()
const listeners = new Set<() => void>()

/** 哨兵命中时的回调（runCommand 用它做「实时完成」通知，比轮询更快） */
let pendingSentinel: { token: string; resolve: () => void } | null = null

function emit() {
  listeners.forEach((fn) => fn())
}

export function subscribeVm(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export const getVmPhase = (): VmPhase => phase
export const getVmError = (): string => lastError

/** 终端画面挂载点：v86 会把文本写进这个容器里的第一个 div */
export function mountVmScreen(el: HTMLElement | null) {
  screenEl = el
}

function waitFor<T>(fn: () => T | null, timeoutMs: number, pollMs = 200): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      const v = fn()
      if (v) return resolve(v)
      if (Date.now() - t0 > timeoutMs) return reject(new Error("等待超时"))
      setTimeout(tick, pollMs)
    }
    tick()
  })
}

function loadScriptOnce(src: string): Promise<void> {
  if (document.querySelector('script[data-lab-vm="1"]')) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement("script")
    s.src = src
    s.dataset.labVm = "1"
    s.onload = () => resolve()
    s.onerror = () => reject(new Error("v86 运行时加载失败（可能是网络问题）"))
    document.head.appendChild(s)
  })
}

/** 把命令（或文件内容）里的单引号安全地塞进 shell 单引号字符串 */
function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 去掉 ANSI 颜色/光标控制序列 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[()][A-Z0-9]/g, "")
}

function cleanOutput(raw: string, cmd: string, marker: string): CommandResult {
  let s = stripAnsi(raw).replace(/\r/g, "")

  // 去掉「命令回显」：从命令第一次出现处之后开始算
  const echoAt = s.indexOf(cmd)
  if (echoAt !== -1) s = s.slice(echoAt + cmd.length)

  // 哨兵行拿退出码，并截掉哨兵之后的一切（提示符等）
  let code: number | null = null
  const mi = s.indexOf(marker)
  if (mi !== -1) {
    const m = /^\s*(\d+)/.exec(s.slice(mi + marker.length))
    code = m ? Number(m[1]) : null
    s = s.slice(0, mi)
  }

  // 删掉残留的 echo 回显行（那一行含哨兵名）
  s = s
    .split("\n")
    .filter((line) => !line.includes(marker))
    .join("\n")
    .trim()

  return { output: s, code, timedOut: false }
}

/**
 * 启动虚拟机。重复调用会复用同一次启动（不会重复下载）。
 * 需要终端面板的 DOM 已经挂载（`mountVmScreen`）。
 */
export function bootVM(): Promise<void> {
  if (phase === "ready") return Promise.resolve()
  if (bootPromise) return bootPromise

  phase = "loading"
  lastError = ""
  emit()

  bootPromise = (async () => {
    try {
      const el = await waitFor(
        () => (screenEl && screenEl.isConnected ? screenEl : null),
        10_000,
        100
      )
      await loadScriptOnce(assetUrl("libv86.js"))
      const V86 = (window as any).V86
      if (!V86) throw new Error("v86 运行时未就绪")

      serialBuf = ""
      emulator = new V86({
        wasm_path: assetUrl("v86.wasm"),
        memory_size: 64 * 1024 * 1024,
        vga_memory_size: 2 * 1024 * 1024,
        screen_container: el,
        bios: { url: assetUrl("seabios.bin") },
        vga_bios: { url: assetUrl("vgabios.bin") },
        cdrom: { url: assetUrl("linux.iso") },
        autostart: true,
      })

      emulator.add_listener("serial0-output-byte", (b: number) => {
        serialBuf += String.fromCharCode(b)
        // 防止长会话把内存吃满
        if (serialBuf.length > 600_000) serialBuf = serialBuf.slice(-300_000)
        if (pendingSentinel && serialBuf.includes(pendingSentinel.token)) {
          const p = pendingSentinel
          pendingSentinel = null
          p.resolve()
        }
      })

      // 等到出现登录提示符
      await waitFor(() => (/login:/i.test(serialBuf) ? true : null), BOOT_TIMEOUT_MS, 500)

      // Buildroot 镜像 root 无密码
      emulator.serial0_send("root\n")
      await waitFor(
        () => (/\/root[%$#] |Welcome to|\n[%$#] $/.test(serialBuf.slice(-400)) ? true : null),
        25_000,
        300
      )

      phase = "ready"
      emit()
    } catch (e: any) {
      phase = "error"
      lastError = e?.message || String(e)
      try {
        emulator?.destroy?.()
      } catch {
        /* 忽略 */
      }
      emulator = null
      emit()
      throw e
    } finally {
      bootPromise = null
    }
  })()

  return bootPromise
}

export function shutdownVM() {
  try {
    emulator?.destroy?.()
  } catch {
    /* 忽略 */
  }
  emulator = null
  serialBuf = ""
  syncedFiles.clear()
  pendingSentinel = null
  lastError = ""
  phase = "off"
  emit()
}

/**
 * 在虚拟机里执行一条命令。
 * 用哨兵行判断结束；超时就返回已收集到的部分（让模型至少看到一半输出）。
 */
export async function runCommand(cmd: string, timeoutMs = 25_000): Promise<CommandResult> {
  if (phase !== "ready" || !emulator) throw new Error("浏览器终端还没启动")

  const token = `__LABDONE_${Math.random().toString(36).slice(2, 10)}__`
  const before = serialBuf.length
  const payload = `${cmd}\necho "${token}$?"\n`

  const hit = new Promise<boolean>((resolve) => {
    pendingSentinel = { token, resolve: () => resolve(true) }
    setTimeout(() => {
      if (pendingSentinel && pendingSentinel.token === token) {
        pendingSentinel = null
        resolve(false)
      }
    }, timeoutMs)
  })

  emulator.serial0_send(payload)
  const finished = await hit

  const raw = serialBuf.slice(before)
  const res = cleanOutput(raw, cmd, token)
  if (!finished) {
    return {
      output: `${res.output}\n（命令超时未结束，可能卡在交互式程序里；以上是已收到的输出）`.trim(),
      code: null,
      timedOut: true,
    }
  }
  return res
}

async function writeFileToVm(fullPath: string, content: string): Promise<boolean> {
  // 分隔符必须不出现在正文里，否则 heredoc 会提前结束
  let delim = `LABEOF_${Math.random().toString(36).slice(2, 10)}`
  while (content.includes(delim)) delim += "X"
  const body = content.endsWith("\n") ? content.slice(0, -1) : content
  const r = await runCommand(
    `mkdir -p "$(dirname ${quote(fullPath)})" && cat > ${quote(fullPath)} << '${delim}'\n${body}\n${delim}`,
    30_000
  )
  return !r.timedOut && (r.code === 0 || r.code === null)
}

/**
 * 把项目文件同步进虚拟机（只推有变化的）。
 * 返回推送了几个、跳过了哪些（过大或失败的）。
 */
export async function syncProjectFiles(
  files: Record<string, string>
): Promise<{ pushed: number; skipped: string[] }> {
  if (phase !== "ready") throw new Error("浏览器终端还没启动")

  const skipped: string[] = []
  const wanted = new Set(Object.keys(files))

  // 删掉虚拟机里已经不存在于项目的文件
  for (const path of [...syncedFiles.keys()]) {
    if (!wanted.has(path)) {
      await runCommand(`rm -f ${quote(`${VM_PROJECT_DIR}/${path}`)}`, 8_000)
      syncedFiles.delete(path)
    }
  }

  let pushed = 0
  for (const [path, content] of Object.entries(files)) {
    if (syncedFiles.get(path) === content) continue
    if (content.length > MAX_SYNC_FILE_BYTES) {
      skipped.push(path)
      continue
    }
    const ok = await writeFileToVm(`${VM_PROJECT_DIR}/${path}`, content)
    if (ok) {
      syncedFiles.set(path, content)
      pushed++
    } else {
      skipped.push(path)
    }
  }
  return { pushed, skipped }
}

/** 把命令输出压缩成回喂给模型的一段文本 */
export function formatCommandResult(cmd: string, r: CommandResult): string {
  const head = `[执行命令] ${cmd.trim()}`
  const meta = r.timedOut
    ? "（超时）"
    : r.code == null
      ? ""
      : `（退出码 ${r.code}）`
  let body = r.output || "(没有输出)"
  if (body.length > 6_000) {
    body = `${body.slice(0, 2_500)}\n…（中间省略）…\n${body.slice(-2_500)}`
  }
  return `${head} ${meta}\n${body}`
}
