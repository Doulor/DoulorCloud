/** 游标分页：按 (created_at DESC, id DESC) 排序，游标编码上一页最后一条 */
export function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify({ c: createdAt, i: id }))
}
export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const o = JSON.parse(atob(cursor))
    if (typeof o.c === "string" && typeof o.i === "string") return { createdAt: o.c, id: o.i }
  } catch {}
  return null
}

export interface RawComment {
  id: string
  post_id: string
  user_id: string
  parent_id: string | null
  body: string
  created_at: string
}

export interface CommentNode extends RawComment {
  replies: RawComment[]
}

/** 把平铺评论按 parent_id 分成两层：根 + 其下回复 */
export function groupComments(comments: RawComment[]): CommentNode[] {
  const roots = comments.filter((c) => !c.parent_id)
  const byParent = new Map<string, RawComment[]>()
  for (const c of comments) {
    if (c.parent_id) {
      const arr = byParent.get(c.parent_id) ?? []
      arr.push(c)
      byParent.set(c.parent_id, arr)
    }
  }
  return roots.map((r) => ({ ...r, replies: byParent.get(r.id) ?? [] }))
}

/** 防刷屏：给定该用户最近一条记录时间，返回是否允许再发。now 默认当前时间。 */
export function canPostAgain(lastCreatedAt: string | null, minSeconds: number, now = Date.now()): boolean {
  if (!lastCreatedAt) return true
  return now - new Date(lastCreatedAt).getTime() >= minSeconds * 1000
}
