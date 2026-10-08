/**
 * 游标分页：编码上一页最后一条的排序键。
 *
 * 「最新」用 (created_at DESC, id DESC)；「最热」还要带上热度值 `h`
 * —— 否则翻页时无从判断"下一页从哪个热度继续"。
 * 老游标（只有 c/i）照样能解，缺 `h` 时由调用方按「最热」的兜底值处理。
 */
export function encodeCursor(createdAt: string, id: string, hot?: number): string {
  const payload: Record<string, unknown> = { c: createdAt, i: id }
  if (typeof hot === "number" && Number.isFinite(hot)) payload.h = hot
  return btoa(JSON.stringify(payload))
}
export function decodeCursor(
  cursor: string
): { createdAt: string; id: string; hot?: number } | null {
  try {
    const o = JSON.parse(atob(cursor))
    if (typeof o.c === "string" && typeof o.i === "string") {
      return {
        createdAt: o.c,
        id: o.i,
        ...(typeof o.h === "number" && Number.isFinite(o.h) ? { hot: o.h } : {}),
      }
    }
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
  /** 赞数（高赞排序用） */
  likeCount?: number
  /** 是否为「全社区前 20%」的高赞评论 */
  hot?: boolean
}

export interface CommentNode extends RawComment {
  replies: CommentNode[]
}

/**
 * 同级评论排序（用户反馈 2026-10-03「高赞回复在同级别优先显示」）：
 * 高赞优先 → 赞数高优先 → 时间早优先。把最值得看的顶到上面，时间顺序退居其次。
 */
function sortSiblings(list: CommentNode[]): CommentNode[] {
  return list.sort((a, b) => {
    const hotDiff = (b.hot ? 1 : 0) - (a.hot ? 1 : 0)
    if (hotDiff !== 0) return hotDiff
    const likeDiff = (b.likeCount ?? 0) - (a.likeCount ?? 0)
    if (likeDiff !== 0) return likeDiff
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  })
}

/**
 * 把平铺评论按 parent_id 递归建成任意深度的树。
 *
 * 输入由 SQL `ORDER BY created_at ASC` 保证按时间正序；建树后对每一层同级做
 * 高赞排序（见 sortSiblings）。parent_id 指向已删除或不存在的评论时，
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
  // 对每一层同级排序（自顶向下递归）
  const sortTree = (list: CommentNode[]): void => {
    sortSiblings(list)
    for (const n of list) sortTree(n.replies)
  }
  sortTree(roots)
  return roots
}

/** 防刷屏：给定该用户最近一条记录时间，返回是否允许再发。now 默认当前时间。 */
export function canPostAgain(lastCreatedAt: string | null, minSeconds: number, now = Date.now()): boolean {
  if (!lastCreatedAt) return true
  return now - new Date(lastCreatedAt).getTime() >= minSeconds * 1000
}
