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
  createdAt: string
}

export interface CommentNode extends RawComment {
  replies: CommentNode[]
}

/**
 * 把平铺评论按 parent_id 递归建成任意深度的树。
 *
 * 输入由 SQL `ORDER BY created_at ASC` 保证按时间正序，树内各级 replies 也自然
 * 保持正序（Map 按插入顺序遍历）。parent_id 指向已删除或不存在的评论时，
 * 该节点会退化为根节点展示，不丢失数据。
 */
export function groupComments(comments: RawComment[]): CommentNode[] {
  const nodes = new Map<string, CommentNode>()
  const roots: CommentNode[] = []
  for (const c of comments) nodes.set(c.id, { ...c, replies: [] })
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : undefined
    if (parent) parent.replies.push(node)
    else roots.push(node)
  }
  return roots
}

/** 防刷屏：给定该用户最近一条记录时间，返回是否允许再发。now 默认当前时间。 */
export function canPostAgain(lastCreatedAt: string | null, minSeconds: number, now = Date.now()): boolean {
  if (!lastCreatedAt) return true
  return now - new Date(lastCreatedAt).getTime() >= minSeconds * 1000
}
