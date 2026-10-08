/**
 * 网页实验室的「草稿」持久化（IndexedDB）。
 *
 * 为什么需要：
 *   项目文件原本只活在内存里，刷新一次全没了。这里把
 *   「文件 + 时间线 + 对话历史 + 作品信息」整体存一份，
 *   下次打开原样恢复 —— 刷新、误关标签页、浏览器崩溃都不再丢稿。
 *
 * 和「自动保存到本地文件夹」是两件事，配合使用最稳：
 *   - 草稿：浏览器自己保管，刷新就恢复，**不需要授权**，但只在这台设备上；
 *   - 本地文件夹：用户自己选的目录，**需要授权**，但产出的是真文件。
 *
 * 存储层用 IndexedDB 而不是 localStorage：内容可能到几 MB，
 * localStorage 上限只有 5MB 左右而且是同步写、会卡主线程。
 */

import type { FileMap } from "./lab-agent"

const IDB_NAME = "doulor-lab-draft"
const IDB_STORE = "draft"
const DRAFT_KEY = "current"

/** 存进草稿的东西（entries 的类型由调用方决定，避免把 UI 类型下沉到这里） */
export interface LabDraft<TEntry = unknown> {
  files: FileMap
  entries: TEntry[]
  convo: { role: string; content: string }[]
  currentId: string | null
  saveName: string
  saveDesc: string
  folderName: string
  savedAt: number
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

/** 写草稿。隐私模式 / 配额满等问题一律吞掉 —— 存不了也不能连累正在进行的对话 */
export async function saveDraft<T>(draft: LabDraft<T>): Promise<boolean> {
  const db = await openIdb()
  if (!db) return false
  try {
    return await new Promise<boolean>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite")
      tx.objectStore(IDB_STORE).put(draft, DRAFT_KEY)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    })
  } catch {
    return false
  } finally {
    db.close()
  }
}

/** 读草稿。没有 / 损坏 / 不支持时返回 null */
export async function loadDraft<T>(): Promise<LabDraft<T> | null> {
  const db = await openIdb()
  if (!db) return null
  try {
    const raw = await new Promise<unknown>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readonly")
      const r = tx.objectStore(IDB_STORE).get(DRAFT_KEY)
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => resolve(null)
    })
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
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** 清掉草稿（「新对话」时用） */
export async function clearDraft(): Promise<void> {
  const db = await openIdb()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite")
      tx.objectStore(IDB_STORE).delete(DRAFT_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    /* 删不掉就算了：下次「新对话」还会覆盖 */
  } finally {
    db.close()
  }
}
