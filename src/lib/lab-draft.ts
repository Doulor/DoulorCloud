/**
 * AI实验室的「草稿」持久化（IndexedDB）—— **多会话版**。
 *
 * 为什么需要：
 *   项目文件原本只活在内存里，刷新一次全没了。这里把
 *   「文件 + 时间线 + 对话历史 + 作品信息」整体存一份，
 *   下次打开原样恢复 —— 刷新、误关标签页、浏览器崩溃都不再丢稿。
 *
 * 为什么要多份（2026-10-09 加）：
 *   一份草稿意味着「开新对话 = 扔掉上一个」。用户想同时留着
 *   「做小游戏」和「调一个表单」两条线时只能二选一。现在最多留
 *   `MAX_SESSIONS` 份，各自独立，随时切回去。
 *
 * 存哪儿：**浏览器本地（IndexedDB）**，不上服务器。
 *   理由和「为什么不是 localStorage」是同一个：内容可能到几 MB。
 *   放大到服务器就是「每个用户几 MB × N 个会话」的存储成本，
 *   而这个数据只在当前设备上连续使用才有意义（跟草稿的定位一致）。
 *   代价是换设备 / 换浏览器看不到 —— 与单份草稿时代的行为相同。
 *
 * 和「自动保存到本地文件夹」是两件事，配合使用最稳：
 *   - 草稿：浏览器自己保管，刷新就恢复，**不需要授权**，但只在这台设备上；
 *   - 本地文件夹：用户自己选的目录，**需要授权**，但产出的是真文件。
 *
 * 存储布局（同一个 object store 里三种 key）：
 *   `__index__`       → DraftIndex（活跃会话 + 各会话的标题/时间）
 *   `session:<id>`    → LabDraft（那一份完整草稿）
 *   `current`         → **旧版单份草稿**，只读一次用于迁移，之后不再写
 */

import type { LabConvoMessage } from "./lab-agent"
import type { FileMap } from "./lab-agent"

const IDB_NAME = "doulor-lab-draft"
const IDB_STORE = "draft"
/** 索引记录（活跃会话 + 会话清单） */
const INDEX_KEY = "__index__"
/** 旧版单份草稿的 key —— 只在首次加载时读一次，用来迁移 */
const LEGACY_KEY = "current"

const sessionKey = (id: string) => `session:${id}`

/** 最多同时保留几个会话。超了会按「最久没动过」淘汰，活跃的那个永远不淘汰。 */
export const MAX_SESSIONS = 5

/** 存进单份草稿的东西（entries 的类型由调用方决定，避免把 UI 类型下沉到这里） */
export interface LabDraft<TEntry = unknown> {
  files: FileMap
  entries: TEntry[]
  /** 带图的多模态消息也存这里（类型见 lab-agent.ts 的 LabConvoMessage） */
  convo: LabConvoMessage[]
  currentId: string | null
  saveName: string
  saveDesc: string
  folderName: string
  savedAt: number
}

/** 一个会话的元信息（列表用；不含体积很大的正文） */
export interface LabSessionMeta {
  id: string
  title: string
  updatedAt: number
}

/** 索引：谁在前台 + 会话清单（最近更新在前） */
export interface DraftIndex {
  activeId: string | null
  sessions: LabSessionMeta[]
}

const EMPTY_INDEX: DraftIndex = { activeId: null, sessions: [] }

/** 生成会话 id（时间戳 + 随机尾巴，够用且不依赖 crypto） */
export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

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

/** 在一个只读/读写事务里跑一段逻辑，省得每处都写一遍样板 */
async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest | void,
  done: (store: IDBObjectStore) => T
): Promise<T | null> {
  const db = await openIdb()
  if (!db) return null
  try {
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(IDB_STORE, mode)
      const store = tx.objectStore(IDB_STORE)
      fn(store)
      tx.oncomplete = () => resolve(done(store))
      tx.onerror = () => resolve(null)
      tx.onabort = () => resolve(null)
    })
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** 单条 get，找不到 / 出错都返回 null */
function idbGet<T>(key: string): Promise<T | null> {
  return new Promise((resolve) => {
    void (async () => {
      const db = await openIdb()
      if (!db) return resolve(null)
      try {
        const raw = await new Promise<unknown>((res) => {
          const tx = db.transaction(IDB_STORE, "readonly")
          const r = tx.objectStore(IDB_STORE).get(key)
          r.onsuccess = () => res(r.result)
          r.onerror = () => res(null)
        })
        resolve((raw as T) ?? null)
      } catch {
        resolve(null)
      } finally {
        db.close()
      }
    })()
  })
}

function normalizeDraft<T>(raw: unknown): LabDraft<T> | null {
  if (!raw || typeof raw !== "object") return null
  const d = raw as Partial<LabDraft<T>>
  if (!d.files || typeof d.files !== "object") return null
  return {
    files: d.files,
    entries: Array.isArray(d.entries) ? d.entries : [],
    convo: Array.isArray(d.convo) ? d.convo : [],
    currentId: typeof d.currentId === "string" ? d.currentId : null,
    saveName: typeof d.saveName === "string" ? d.saveName : "",
    saveDesc: typeof d.saveDesc === "string" ? d.saveDesc : "",
    folderName: typeof d.folderName === "string" ? d.folderName : "",
    savedAt: typeof d.savedAt === "number" ? d.savedAt : 0,
  }
}

function normalizeIndex(raw: unknown): DraftIndex {
  if (!raw || typeof raw !== "object") return { ...EMPTY_INDEX }
  const d = raw as Partial<DraftIndex>
  const sessions = Array.isArray(d.sessions)
    ? d.sessions
        .filter(
          (s): s is LabSessionMeta =>
            !!s && typeof s.id === "string" && s.id.length > 0
        )
        .map((s) => ({
          id: s.id,
          title: typeof s.title === "string" && s.title.trim() ? s.title : "",
          updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
        }))
        .slice(0, MAX_SESSIONS)
    : []
  const activeId =
    typeof d.activeId === "string" && sessions.some((s) => s.id === d.activeId)
      ? d.activeId
      : (sessions[0]?.id ?? null)
  return { activeId, sessions }
}

/**
 * 读会话索引。
 *
 * **迁移**：老版本只有一份 `current` 草稿。第一次读到「索引不存在」而
 * `current` 还在时，把它收编成第 1 个会话 —— 用户升级后不会发现草稿没了。
 *
 * ⚠️ 迁移**不能**调 `saveSessionDraft`：那个函数内部又会读索引，
 * 而此刻索引还没写进去 ⇒ 它会再次判定「需要迁移」⇒ 无限递归。
 * 所以这里直接落盘。
 */
export async function loadSessionIndex(): Promise<DraftIndex> {
  const raw = await idbGet<unknown>(INDEX_KEY)
  if (raw) return normalizeIndex(raw)

  const legacy = await idbGet<unknown>(LEGACY_KEY)
  const draft = normalizeDraft(legacy)
  if (!draft) return { ...EMPTY_INDEX }
  const hasContent =
    Object.keys(draft.files).length > 0 || draft.entries.length > 0
  if (!hasContent) return { ...EMPTY_INDEX }

  const id = newSessionId()
  const meta: LabSessionMeta = {
    id,
    title: draft.saveName || "",
    updatedAt: draft.savedAt || Date.now(),
  }
  const idx: DraftIndex = { activeId: id, sessions: [meta] }
  const ok = await withStore(
    "readwrite",
    (store) => {
      store.put(draft, sessionKey(id))
      store.put(idx, INDEX_KEY)
    },
    () => true
  )
  return ok ? idx : { ...EMPTY_INDEX }
}

/** 读某个会话的完整草稿 */
export async function loadSessionDraft<T>(id: string): Promise<LabDraft<T> | null> {
  return normalizeDraft<T>(await idbGet<unknown>(sessionKey(id)))
}

/**
 * 写某个会话的草稿，并同步索引（标题 / 更新时间 / 淘汰超额会话）。
 *
 * 淘汰规则：按「最近更新」排序后，**超出上限的从最久没动的开始砍**，
 * 且**跳过当前会话** —— 正在用的那份永远不该被自己挤掉。
 *
 * @returns 写成功时返回最新的索引（调用方直接拿它刷新列表）；失败返回 null
 */
export async function saveSessionDraft<T>(
  id: string,
  draft: LabDraft<T>,
  title: string
): Promise<DraftIndex | null> {
  const index = await loadSessionIndex()
  const clean = title.trim().slice(0, 40)
  const rest = index.sessions.filter((s) => s.id !== id)
  const meta: LabSessionMeta = {
    id,
    // 标题为空时保留原标题（否则「新对话」会把用户起的名字抹掉）
    title: clean || index.sessions.find((s) => s.id === id)?.title || "",
    updatedAt: draft.savedAt || Date.now(),
  }
  // 最近更新在前；超出上限时从**末尾**（最久没动）开始砍
  let sessions = [meta, ...rest]
  if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(0, MAX_SESSIONS)
  const dropped = rest.filter((s) => !sessions.some((x) => x.id === s.id)).map((s) => s.id)
  const nextIndex: DraftIndex = { activeId: id, sessions }

  return withStore(
    "readwrite",
    (store) => {
      store.put(draft, sessionKey(id))
      store.put(nextIndex, INDEX_KEY)
      for (const droppedId of dropped) store.delete(sessionKey(droppedId))
    },
    () => nextIndex
  )
}

/** 删除一个会话（连同它的草稿正文） */
export async function deleteSessionDraft(id: string): Promise<DraftIndex> {
  const index = await loadSessionIndex()
  const sessions = index.sessions.filter((s) => s.id !== id)
  const activeId = index.activeId === id ? (sessions[0]?.id ?? null) : index.activeId
  const next: DraftIndex = { activeId, sessions }
  await withStore(
    "readwrite",
    (store) => {
      store.delete(sessionKey(id))
      store.put(next, INDEX_KEY)
    },
    () => true
  )
  return next
}

/** 只改「谁在前台」，不碰草稿正文 */
export async function setActiveSession(id: string | null): Promise<void> {
  const index = await loadSessionIndex()
  await withStore(
    "readwrite",
    (store) => store.put({ ...index, activeId: id }, INDEX_KEY),
    () => true
  )
}

/**
 * 从时间线里猜一个会话标题 —— 用**第一条用户发言**，截断到 40 字。
 * 猜不出来就返回空串（由调用方决定显示成「新对话」还是别的）。
 */
export function deriveSessionTitle<T extends { kind: string; text?: string }>(
  entries: T[]
): string {
  for (const e of entries) {
    if (e.kind !== "user") continue
    const text = (e.text ?? "").replace(/\s+/g, " ").trim()
    if (text) return text.slice(0, 40)
  }
  return ""
}
