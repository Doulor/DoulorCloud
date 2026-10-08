/**
 * 本地文件夹读写（File System Access API）。
 *
 * 浏览器**不允许**网页执行本地命令，但允许在用户「当面点选」之后
 * 直接读写那个文件夹 —— 这是 Chrome/Edge 的原生能力，不用装任何东西。
 * Safari / Firefox 还没实现（只支持选择文件，不支持写回目录），
 * 所以调用方必须先看 supportsLocalFs()，不支持就别显示按钮。
 */
import type { FileMap } from "./lab-agent"

type FileHandle = {
  kind: "file"
  name: string
  getFile(): Promise<File>
  createWritable(): Promise<{
    write(data: string): Promise<void>
    close(): Promise<void>
  }>
}

type DirHandle = {
  kind: "directory"
  name: string
  entries(): AsyncIterableIterator<[string, FileHandle | DirHandle]>
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>
}

type PickerWindow = {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<DirHandle>
}

type PermissionCapable = {
  queryPermission?: (o: { mode: string }) => Promise<PermissionState>
  requestPermission?: (o: { mode: string }) => Promise<PermissionState>
}

type DirectoryPicker = (o?: {
  mode?: "read" | "readwrite"
  id?: string
}) => Promise<DirHandle>

export type LocalDirHandle = DirHandle

function picker(): DirectoryPicker | null {
  if (typeof window === "undefined") return null
  const fn = (window as unknown as PickerWindow).showDirectoryPicker
  return typeof fn === "function" ? fn.bind(window) : null
}

/** 这个浏览器能不能读写本地文件夹 */
export function supportsLocalFs(): boolean {
  return picker() !== null
}

/** 只收文本类文件：二进制（图片/字体）目前存不进「文本文件系统」 */
const TEXT_EXT_RE =
  /\.(html?|css|js|mjs|cjs|jsx|ts|tsx|vue|svelte|json|md|txt|svg|xml|ya?ml|toml|ini|env|gitignore)$/i

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "vendor",
  "__pycache__",
  "coverage",
])

export const LOCAL_IMPORT_MAX_FILES = 60
export const LOCAL_IMPORT_MAX_BYTES = 2_000_000
export const LOCAL_IMPORT_MAX_FILE_BYTES = 400_000

async function walk(
  dir: DirHandle,
  prefix: string,
  out: FileMap,
  budget: { bytes: number }
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    if (Object.keys(out).length >= LOCAL_IMPORT_MAX_FILES) return
    if (budget.bytes >= LOCAL_IMPORT_MAX_BYTES) return
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue

    if (handle.kind === "file") {
      if (!TEXT_EXT_RE.test(name)) continue
      const file = await handle.getFile()
      if (file.size > LOCAL_IMPORT_MAX_FILE_BYTES) continue
      const text = await file.text()
      if (budget.bytes + text.length > LOCAL_IMPORT_MAX_BYTES) return
      out[prefix + name] = text
      budget.bytes += text.length
    } else {
      await walk(handle, `${prefix}${name}/`, out, budget)
    }
  }
}

/**
 * 让用户选一个本地文件夹，读回里面的文本文件。
 * 用户取消（AbortError）返回 null，其它错误抛出去由调用方提示。
 */
export async function importLocalFolder(): Promise<FileMap | null> {
  const show = picker()
  if (!show) throw new Error("UNSUPPORTED")
  let dir: DirHandle
  try {
    dir = await show({ mode: "read" })
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null
    throw err
  }
  const out: FileMap = {}
  await walk(dir, "", out, { bytes: 0 })
  return out
}

/** 把当前项目写进用户选的本地文件夹（会在里面再建一个项目子目录） */
export async function exportToLocalFolder(
  files: FileMap,
  subdir?: string
): Promise<number> {
  const show = picker()
  if (!show) throw new Error("UNSUPPORTED")
  let dir: DirHandle
  try {
    dir = await show({ mode: "readwrite", id: "doulor-lab-project" })
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return 0
    throw err
  }
  return writeFilesInto(dir, files, subdir)
}

/**
 * 把文件名收敛成合法的目录名（Windows 下 `\ / : * ? " < > |` 都会炸）。
 * 名字全是非法字符时返回空串。
 */
export function sanitizeDirName(raw?: string): string {
  return (raw ?? "")
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 60)
    .trim()
    .replace(/\.+$/, "")
}

/**
 * 把 FileMap 写进指定目录（自动保存复用这条）。
 * `subdir` 非空时，文件会写进 `<所选目录>/<subdir>/…` —— 每个作品一个文件夹，
 * 免得多个项目的 index.html 互相覆盖。
 */
export async function writeFilesInto(
  dir: LocalDirHandle,
  files: FileMap,
  subdir?: string
): Promise<number> {
  const seg = sanitizeDirName(subdir)
  const root = seg ? await dir.getDirectoryHandle(seg, { create: true }) : dir

  let written = 0
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/").filter(Boolean)
    if (!parts.length) continue
    let cur = root
    for (const s of parts.slice(0, -1)) {
      cur = await cur.getDirectoryHandle(s, { create: true })
    }
    const fh = await cur.getFileHandle(parts[parts.length - 1], { create: true })
    const writable = await fh.createWritable()
    await writable.write(content)
    await writable.close()
    written++
  }
  return written
}

// ---------------------------------------------------------------------------
// 目录句柄的「记忆」：自动保存要跨刷新继续用同一个文件夹
//
// 句柄本身可以存进 IndexedDB（浏览器允许），但**权限不会跟着留住**：
// 刷新后要重新授权，而且 requestPermission() 必须由用户点击触发。
// 所以流程是「回忆句柄 → 静默查权限 → 没权限就等用户点一下再申请」。
// ---------------------------------------------------------------------------

const IDB_NAME = "doulor-lab-fs"
const IDB_STORE = "handles"
const AUTOSAVE_KEY = "autoSaveDir"

function openIdb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null)
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(IDB_NAME, 1)
    } catch {
      return resolve(null)
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}

async function idbPut(value: unknown): Promise<void> {
  const db = await openIdb()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite")
      tx.objectStore(IDB_STORE).put(value, AUTOSAVE_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    // 句柄不可结构化克隆 / 隐私模式下 IDB 半残：记不住就算了，
    // 本次会话内的自动保存必须照常工作（调用方不该因此报错）。
  } finally {
    db.close()
  }
}

/** 记住自动保存的目录（跨刷新） */
export async function rememberAutoSaveDir(handle: LocalDirHandle): Promise<void> {
  await idbPut(handle)
}

/** 取回上次记住的目录（没有 / 不支持 / IDB 出错 时返回 null） */
export async function recallAutoSaveDir(): Promise<LocalDirHandle | null> {
  const db = await openIdb()
  if (!db) return null
  try {
    return await new Promise<LocalDirHandle | null>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readonly")
      const r = tx.objectStore(IDB_STORE).get(AUTOSAVE_KEY)
      r.onsuccess = () => resolve((r.result as LocalDirHandle | undefined) ?? null)
      r.onerror = () => resolve(null)
    })
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** 忘掉自动保存的目录 */
export async function forgetAutoSaveDir(): Promise<void> {
  const db = await openIdb()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite")
      tx.objectStore(IDB_STORE).delete(AUTOSAVE_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    /* 删不掉也无所谓：下次开启会重新选目录 */
  } finally {
    db.close()
  }
}

/**
 * 查 / 申请目录权限。
 * `request=true` 时必须由用户点击触发，否则浏览器直接拒绝（返回 false）。
 */
export async function dirPermission(
  handle: LocalDirHandle,
  mode: "read" | "readwrite",
  request: boolean
): Promise<boolean> {
  const h = handle as LocalDirHandle & PermissionCapable
  try {
    if (request && typeof h.requestPermission === "function") {
      return (await h.requestPermission({ mode })) === "granted"
    }
    if (typeof h.queryPermission === "function") {
      return (await h.queryPermission({ mode })) === "granted"
    }
    // 老实现没有权限 API：先当作可用，真写的时候会抛错再兜
    return true
  } catch {
    return false
  }
}

/** 让用户挑一个「自动保存」用的文件夹（取消返回 null） */
export async function pickAutoSaveDir(): Promise<LocalDirHandle | null> {
  const show = picker()
  if (!show) throw new Error("UNSUPPORTED")
  try {
    return await show({ mode: "readwrite", id: "doulor-lab-project" })
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null
    throw err
  }
}
