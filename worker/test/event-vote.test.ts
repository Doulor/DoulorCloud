// 活动投票（0124）：一人一票 + 五种获奖规则。
//
// 覆盖：
//   1. parseVoteConfig / validateVoteCondition 的边界（<2 项、无标题、id 重复、规则非法）
//   2. pickWinningOptions 纯函数：多数 / 少数、平票并列、0 票选项不参与「少数」
//   3. all        参与即可获奖 —— 投完当场发积分
//   4. instant_*  投票后立刻按当前票数结算（中的当场发、没中的当场 lost）
//   5. majority/minority 截止后开奖：投中获奖选项的人拿奖、其余标 lost
//   6. 一人一票：重复投票被拒（409），票数不涨
//   7. 选项不存在 → 400（且不消耗参与名额）
//   8. 开奖幂等：重复开奖 409
//   9. 开奖时忽略已从配置删掉的选项（孤儿票不参与比较）
//  10. 「参与即可获奖」/「立刻结算」不允许开奖（400）
//  11. promo_hidden = 1 的活动不出现在 /api/events 列表里，但链接仍可访问、可参与
//  12. 无人投票时开奖 → 400 且不留开奖锁
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import {
  parseVoteConfig,
  validateVoteCondition,
  pickWinningOptions,
  isInstantVoteRule,
  isDrawVoteRule,
  validatePointsReward,
  pickPointsAmount,
} from "../src/event-rewards"
import { drawDueVotes } from "../src/handlers/events"
import { getPointsBalance } from "../src/points"

/**
 * 管理端操作必须用 **superadmin** 而不是 admin。
 *
 * `requireAdminScope` 对 admin 角色还要查权限组 / 白名单（`resolveAdminScope`），
 * 而 `makeUser({role:"admin"})` 建出来的账号没有配任何权限组 ⇒ 一律 403。
 * 那是既有基线（event-lottery.test.ts 里同样 9 条 red），不是本功能的问题。
 * `isPrivileged()` 对 superadmin / root 直接放行，用它才能测到真正的开奖逻辑。
 */
async function makeAdmin(): Promise<TestUser> {
  return makeUser({ role: "superadmin" })
}

const OPTIONS = [
  { id: "a", label: "选项 A" },
  { id: "b", label: "选项 B" },
  { id: "c", label: "选项 C" },
]

/** 建一条投票活动（直接落库，聚焦投票/开奖逻辑） */
async function seedVote(opts: {
  rule?: string
  pool?: number
  rewardType?: string
  rewardParams?: unknown
  options?: { id: string; label: string }[]
  fixedOptionId?: string
  endsAt?: string | null
  status?: string
  maxClaims?: number | null
  promoHidden?: number
}): Promise<string> {
  const id = `ev_${Math.random().toString(36).slice(2, 10)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO events
       (id, title, body, status, starts_at, ends_at, max_claims, reward_label, reward_type,
        reward_params, condition_type, condition_params, promo_hidden, created_by,
        created_at, updated_at)
     VALUES (?, '投票测试', '正文', ?, NULL, ?, ?, '投票奖励', ?,
             ?, 'vote', ?, ?, NULL, ?, ?)`
  )
    .bind(
      id,
      opts.status ?? "active",
      opts.endsAt ?? null,
      opts.maxClaims ?? null,
      opts.rewardType ?? "points",
      opts.rewardParams === undefined
        ? JSON.stringify({ amount: 10 })
        : opts.rewardParams === null
          ? null
          : JSON.stringify(opts.rewardParams),
      JSON.stringify({
        options: opts.options ?? OPTIONS,
        rewardRule: opts.rule ?? "all",
        ...(opts.fixedOptionId ? { fixedOptionId: opts.fixedOptionId } : {}),
      }),
      opts.promoHidden ?? 0,
      now,
      now
    )
    .run()
  return id
}

async function vote(evId: string, user: TestUser, optionId?: string): Promise<Response> {
  return fetchSelf(
    authRequest(user, `/api/events/${evId}/claim`, {
      method: "POST",
      body: JSON.stringify({ optionId: optionId ?? "" }),
    })
  )
}

async function draw(evId: string, admin: TestUser): Promise<Response> {
  return fetchSelf(authRequest(admin, `/api/admin/events/${evId}/draw`, { method: "POST" }))
}

async function voteCount(evId: string, optionId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM event_votes WHERE event_id = ? AND option_id = ?"
  )
    .bind(evId, optionId)
    .first<{ c: number }>()
  return row?.c ?? 0
}

async function claimStatus(evId: string, user: TestUser): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT reward_status FROM event_claims WHERE event_id = ? AND user_id = ?"
  )
    .bind(evId, user.id)
    .first<{ reward_status: string }>()
  return row?.reward_status ?? null
}

async function drawnAt(evId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT drawn_at FROM events WHERE id = ?")
    .bind(evId)
    .first<{ drawn_at: string | null }>()
  return row?.drawn_at ?? null
}

describe("投票：配置解析与校验", () => {
  it("合法配置解析出选项与规则", () => {
    const cfg = parseVoteConfig({ options: OPTIONS, rewardRule: "majority" })
    expect(cfg?.options).toHaveLength(3)
    expect(cfg?.rewardRule).toBe("majority")
  })

  it("少于 2 个选项不合法", () => {
    expect(parseVoteConfig({ options: [OPTIONS[0]], rewardRule: "all" })).toBeNull()
    expect(validateVoteCondition({ options: [OPTIONS[0]], rewardRule: "all" })).toBe(
      "投票至少要配置 2 个选项"
    )
  })

  it("没有标题的选项被丢掉，剩不足 2 个就不合法", () => {
    expect(
      parseVoteConfig({
        options: [{ id: "a", label: "A" }, { id: "b", label: "   " }],
        rewardRule: "all",
      })
    ).toBeNull()
  })

  it("重复的选项 id 只保留一个（否则计票会把两项算成同一堆）", () => {
    const cfg = parseVoteConfig({
      options: [{ id: "a", label: "A" }, { id: "a", label: "A2" }, { id: "b", label: "B" }],
      rewardRule: "all",
    })
    expect(cfg?.options.map((o) => o.id)).toEqual(["a", "b"])
  })

  it("缺 id 时按位置自动生成", () => {
    const cfg = parseVoteConfig({
      options: [{ label: "A" }, { label: "B" }],
      rewardRule: "all",
    })
    expect(cfg?.options.map((o) => o.id)).toEqual(["opt1", "opt2"])
  })

  it("非法的获奖规则一律拒绝（不静默回落）", () => {
    expect(parseVoteConfig({ options: OPTIONS, rewardRule: "whatever" })).toBeNull()
    expect(validateVoteCondition({ options: OPTIONS, rewardRule: "" })).toContain("不合法")
  })

  it("规则分类辅助函数", () => {
    expect(isInstantVoteRule("instant_majority")).toBe(true)
    expect(isInstantVoteRule("majority")).toBe(false)
    expect(isDrawVoteRule("majority")).toBe(true)
    expect(isDrawVoteRule("instant_minority")).toBe(false)
    expect(isDrawVoteRule("all")).toBe(false)
  })
})

describe("投票：获奖选项计算（平票并列全算）", () => {
  const counts = (pairs: [string, number][]) => new Map(pairs)

  it("多数：取票数最高的全部选项", () => {
    expect(pickWinningOptions(counts([["a", 5], ["b", 3], ["c", 1]]), "majority")).toEqual(["a"])
    // 平票：两个都是最高 ⇒ 都算
    expect(
      pickWinningOptions(counts([["a", 5], ["b", 5], ["c", 1]]), "majority").sort()
    ).toEqual(["a", "b"])
  })

  it("少数：只在有票的选项里取最低（0 票的选项不参与）", () => {
    expect(pickWinningOptions(counts([["a", 5], ["b", 3], ["c", 1]]), "minority")).toEqual(["c"])
    // 平票：两个都是最低 ⇒ 都算
    expect(
      pickWinningOptions(counts([["a", 5], ["b", 1], ["c", 1]]), "minority").sort()
    ).toEqual(["b", "c"])
    // 0 票的 d 不算「少数」——否则这一轮谁都中不了奖
    const withZero = counts([["a", 5], ["b", 2], ["d", 0]])
    expect(pickWinningOptions(withZero, "minority")).toEqual(["b"])
  })

  it("只有一个选项有票时，它既是多数也是少数", () => {
    const m = counts([["a", 3], ["b", 0]])
    expect(pickWinningOptions(m, "majority")).toEqual(["a"])
    expect(pickWinningOptions(m, "minority")).toEqual(["a"])
  })

  it("一票都没有时返回空", () => {
    expect(pickWinningOptions(new Map(), "majority")).toEqual([])
    expect(pickWinningOptions(counts([["a", 0]]), "minority")).toEqual([])
  })
})

describe("投票：参与即可获奖（all）", () => {
  it("投完当场发积分，票数与领取记录都落库", async () => {
    const ev = await seedVote({ rule: "all" })
    const u = await makeUser({})

    const res = await vote(ev, u, "a")
    expect(res.status).toBe(200)
    const body = await res.json<{ status: string }>()
    expect(body.status).toBe("granted")

    expect(await voteCount(ev, "a")).toBe(1)
    expect(await claimStatus(ev, u)).toBe("granted")
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })
})

describe("投票：投票后立刻结算（instant_*）", () => {
  it("第一个投票的人按当前票数就是多数，当场拿奖", async () => {
    const ev = await seedVote({ rule: "instant_majority" })
    const u = await makeUser({})

    const res = await vote(ev, u, "a")
    const body = await res.json<{ status: string }>()
    expect(body.status).toBe("granted")
    expect(await claimStatus(ev, u)).toBe("granted")
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })

  it("多数结算：后投的人若选了少数选项，当场判负（lost 而不是 failed）", async () => {
    const ev = await seedVote({ rule: "instant_majority" })
    const u1 = await makeUser({})
    const u2 = await makeUser({})

    // u1 投 a（1 票，多数）→ 中奖
    expect((await (await vote(ev, u1, "a")).json<{ status: string }>()).status).toBe("granted")
    // u2 投 b（a=1, b=1 平票 ⇒ 并列都算多数）→ 也中奖
    expect((await (await vote(ev, u2, "b")).json<{ status: string }>()).status).toBe("granted")

    // u3 投 c（a=1,b=1,c=1 三项平票 ⇒ 仍并列）—— 想造出「明确少数」得先拉开差距
    const u3 = await makeUser({})
    const u4 = await makeUser({})
    await vote(ev, u3, "a") // a=2
    // 现在 a=2, b=1, c=0；u4 投 b ⇒ b=2 与 a 平票 ⇒ 中奖
    expect((await (await vote(ev, u4, "b")).json<{ status: string }>()).status).toBe("granted")

    // u5 投 c ⇒ c=1，其余 a=2/b=2 ⇒ c 是唯一少数 ⇒ 当场 lost
    const u5 = await makeUser({})
    const res = await vote(ev, u5, "c")
    expect(res.status).toBe(200)
    expect((await res.json<{ status: string }>()).status).toBe("lost")
    expect(await claimStatus(ev, u5)).toBe("lost")
    // 没中奖不发积分
    expect(await getPointsBalance(env, u5.id)).toBe(0)
  })

  it("少数结算：投了票数最少的选项才拿奖", async () => {
    const ev = await seedVote({ rule: "instant_minority" })
    const u1 = await makeUser({})
    const u2 = await makeUser({})

    // u1 投 a（唯一有票 ⇒ 也是最少）→ 中奖
    expect((await (await vote(ev, u1, "a")).json<{ status: string }>()).status).toBe("granted")
    // u2 投 b：a=1, b=1 平票 ⇒ 并列最少 ⇒ 也中奖
    expect((await (await vote(ev, u2, "b")).json<{ status: string }>()).status).toBe("granted")

    // u3 投 a ⇒ a=2, b=1 ⇒ b 最少，u3 投的是 a（多数）⇒ 当场没中
    const u3 = await makeUser({})
    expect((await (await vote(ev, u3, "a")).json<{ status: string }>()).status).toBe("lost")
  })

  it("立刻结算的活动不允许开奖", async () => {
    const admin = await makeAdmin()
    const ev = await seedVote({ rule: "instant_majority" })
    const u = await makeUser({})
    await vote(ev, u, "a")

    const res = await draw(ev, admin)
    expect(res.status).toBe(400)
  })
})

describe("投票：截止后开奖（majority / minority）", () => {
  it("多数得奖：投中最高票选项的人拿奖，其余标 lost", async () => {
    const admin = await makeAdmin()
    const ev = await seedVote({ rule: "majority" })
    const a1 = await makeUser({})
    const a2 = await makeUser({})
    const b1 = await makeUser({})

    // 投票时只登记，不发奖
    const r1 = await vote(ev, a1, "a")
    expect((await r1.json<{ status: string }>()).status).toBe("pending")
    expect(await getPointsBalance(env, a1.id)).toBe(0)

    await vote(ev, a2, "a") // a = 2
    await vote(ev, b1, "b") // b = 1

    const res = await draw(ev, admin)
    expect(res.status).toBe(200)
    const outcome = await res.json<{
      winners: number
      winningOptions: string[]
      distributed: number
      participants: number
    }>()
    expect(outcome.winningOptions).toEqual(["a"])
    expect(outcome.winners).toBe(2)
    expect(outcome.participants).toBe(3)
    expect(outcome.distributed).toBe(20)

    expect(await claimStatus(ev, a1)).toBe("granted")
    expect(await claimStatus(ev, a2)).toBe("granted")
    expect(await claimStatus(ev, b1)).toBe("lost")
    expect(await getPointsBalance(env, a1.id)).toBe(10)
    expect(await getPointsBalance(env, b1.id)).toBe(0)
  })

  it("少数得奖：投中最低票选项的人拿奖", async () => {
    const admin = await makeAdmin()
    const ev = await seedVote({ rule: "minority", options: OPTIONS })
    const a1 = await makeUser({})
    const a2 = await makeUser({})
    const c1 = await makeUser({})

    await vote(ev, a1, "a")
    await vote(ev, a2, "a") // a = 2（多数）
    await vote(ev, c1, "c") // c = 1（唯一有票的最低 ⇒ 少数）

    const outcome = await (
      await draw(ev, admin)
    ).json<{ winningOptions: string[]; winners: number }>()
    expect(outcome.winningOptions).toEqual(["c"])
    expect(outcome.winners).toBe(1)
    expect(await claimStatus(ev, c1)).toBe("granted")
    expect(await claimStatus(ev, a1)).toBe("lost")
  })

  it("平票时并列的选项都算获奖", async () => {
    const admin = await makeAdmin()
    const ev = await seedVote({ rule: "majority" })
    const a1 = await makeUser({})
    const b1 = await makeUser({})

    await vote(ev, a1, "a")
    await vote(ev, b1, "b") // a = b = 1

    const outcome = await (
      await draw(ev, admin)
    ).json<{ winningOptions: string[]; winners: number }>()
    expect(outcome.winningOptions.sort()).toEqual(["a", "b"])
    expect(outcome.winners).toBe(2)
    expect(await claimStatus(ev, a1)).toBe("granted")
    expect(await claimStatus(ev, b1)).toBe("granted")
  })

  it("重复开奖返回 409（drawn_at 就是幂等锁）", async () => {
    const admin = await makeAdmin()
    const ev = await seedVote({ rule: "majority" })
    const u = await makeUser({})
    await vote(ev, u, "a")

    expect((await draw(ev, admin)).status).toBe(200)
    expect((await draw(ev, admin)).status).toBe(409)
    // 只发了一次
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })

  it("没人投票时不能开奖，且不留下开奖锁（之后还能开）", async () => {
    const admin = await makeAdmin()
    const ev = await seedVote({ rule: "majority" })

    const res = await draw(ev, admin)
    expect(res.status).toBe(400)
    expect(await drawnAt(ev)).toBeNull()

    // 有人投票后可以正常开
    const u = await makeUser({})
    await vote(ev, u, "a")
    expect((await draw(ev, admin)).status).toBe(200)
  })

  it("开奖时忽略已从配置里删掉的选项（孤儿票不参与比较）", async () => {
    const admin = await makeAdmin()
    // 一开始有 a / b / rem
    const ev = await seedVote({
      rule: "majority",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "rem", label: "待删" }],
    })
    const uRem = await makeUser({})
    const uA = await makeUser({})
    const uB = await makeUser({})
    await vote(ev, uRem, "rem") // rem = 1
    await vote(ev, uA, "a") // a = 1
    await vote(ev, uB, "b") // b = 1

    // 站长把 rem 这个选项删掉（改配置），它那票就成了孤儿
    await env.DB.prepare("UPDATE events SET condition_params = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
          rewardRule: "majority",
        }),
        ev
      )
      .run()

    const outcome = await (
      await draw(ev, admin)
    ).json<{ winningOptions: string[] }>()
    // rem 已不在配置里 ⇒ 不能获奖；获奖的是 a 与 b（各 1 票，平票并列）
    expect(outcome.winningOptions.sort()).toEqual(["a", "b"])
    expect(await claimStatus(ev, uRem)).toBe("lost")
  })
})

describe("投票：一人一票与参数校验", () => {
  it("重复投票被拒（409），票数不涨", async () => {
    const ev = await seedVote({ rule: "all" })
    const u = await makeUser({})

    expect((await vote(ev, u, "a")).status).toBe(200)
    const again = await vote(ev, u, "b")
    expect(again.status).toBe(409)
    expect(await voteCount(ev, "a")).toBe(1)
    expect(await voteCount(ev, "b")).toBe(0)
  })

  it("不选选项 → 400", async () => {
    const ev = await seedVote({ rule: "all" })
    const u = await makeUser({})
    const res = await vote(ev, u, "")
    expect(res.status).toBe(400)
    expect(await claimStatus(ev, u)).toBeNull()
  })

  it("选项不存在 → 400，且不消耗参与名额（claim 未落库）", async () => {
    const ev = await seedVote({ rule: "all" })
    const u = await makeUser({})
    const res = await vote(ev, u, "not-exist")
    expect(res.status).toBe(400)
    expect(await claimStatus(ev, u)).toBeNull()
    // 说明没占位：换成合法选项还能投
    expect((await vote(ev, u, "a")).status).toBe(200)
  })

  it("已开奖后不能再投（即便活动还没到结束时间）", async () => {
    const admin = await makeAdmin()
    const ev = await seedVote({ rule: "majority" })
    const u1 = await makeUser({})
    await vote(ev, u1, "a")
    expect((await draw(ev, admin)).status).toBe(200)

    const u2 = await makeUser({})
    const res = await vote(ev, u2, "b")
    expect(res.status).toBe(400)
  })

  it("参与人数上限：投满即拒（与抽奖共用 max_claims）", async () => {
    const ev = await seedVote({ rule: "all", maxClaims: 1 })
    const u1 = await makeUser({})
    const u2 = await makeUser({})
    expect((await vote(ev, u1, "a")).status).toBe(200)
    expect((await vote(ev, u2, "b")).status).toBe(409)
  })

  it("活动未开始 / 已结束都不能投", async () => {
    const u = await makeUser({})
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const past = new Date(Date.now() - 3_600_000).toISOString()

    const evNotStarted = await seedVote({ rule: "all" })
    await env.DB.prepare("UPDATE events SET starts_at = ? WHERE id = ?")
      .bind(future, evNotStarted)
      .run()
    expect((await vote(evNotStarted, u, "a")).status).toBe(400)

    const evEnded = await seedVote({ rule: "all", endsAt: past, status: "ended" })
    expect((await vote(evEnded, u, "a")).status).toBe(400)
  })
})

describe("投票：指定选项获奖（fixed / instant_fixed）", () => {
  it("配置：缺 fixedOptionId 或指向不存在的选项都判非法", () => {
    expect(
      parseVoteConfig({ options: OPTIONS, rewardRule: "fixed" })
    ).toBeNull()
    expect(
      parseVoteConfig({ options: OPTIONS, rewardRule: "fixed", fixedOptionId: "nope" })
    ).toBeNull()
    const cfg = parseVoteConfig({
      options: OPTIONS,
      rewardRule: "fixed",
      fixedOptionId: "b",
    })
    expect(cfg?.fixedOptionId).toBe("b")
    expect(validateVoteCondition({ options: OPTIONS, rewardRule: "instant_fixed" })).toContain(
      "指定获奖的那个选项"
    )
  })

  it("pickWinningOptions：fixed 完全不看得票（0 票也算获奖选项）", () => {
    // 指定了 c，但 c 一票都没有 —— 仍然返回 c，而不是改判别的选项
    expect(pickWinningOptions(new Map([["a", 99]]), "fixed", "c")).toEqual(["c"])
    expect(pickWinningOptions(new Map(), "fixed", "c")).toEqual(["c"])
    // 没传 fixedOptionId（配置异常）→ 空，不发奖
    expect(pickWinningOptions(new Map(), "fixed", undefined)).toEqual([])
  })

  it("instant_fixed：投中指定选项当场发奖，投别的当场判负", async () => {
    const ev = await seedVote({ rule: "instant_fixed", fixedOptionId: "b" })
    const win = await makeUser({})
    const lose = await makeUser({})

    const w = await vote(ev, win, "b")
    expect(w.status).toBe(200)
    expect((await w.json<{ status: string }>()).status).toBe("granted")
    expect(await getPointsBalance(env, win.id)).toBe(10)

    const l = await vote(ev, lose, "a")
    expect(l.status).toBe(200)
    expect((await l.json<{ status: string }>()).status).toBe("lost")
    expect(await getPointsBalance(env, lose.id)).toBe(0)
  })

  it("instant_fixed 不允许开奖（投票时已结算）", async () => {
    const admin = await makeAdmin()
    const ev = await seedVote({ rule: "instant_fixed", fixedOptionId: "a" })
    const u = await makeUser({})
    await vote(ev, u, "a")
    expect((await draw(ev, admin)).status).toBe(400)
  })

  it("fixed：投票时只登记，截止后开奖只认指定选项", async () => {
    const admin = await makeAdmin()
    const ev = await seedVote({ rule: "fixed", fixedOptionId: "c" })
    const a1 = await makeUser({})
    const c1 = await makeUser({})
    const c2 = await makeUser({})

    // 全体都去投 a（多数），只有两个人投了指定的 c
    expect((await (await vote(ev, a1, "a")).json<{ status: string }>()).status).toBe("pending")
    await vote(ev, c1, "c")
    await vote(ev, c2, "c")
    expect(await getPointsBalance(env, a1.id)).toBe(0)

    const outcome = await (
      await draw(ev, admin)
    ).json<{ winningOptions: string[]; winners: number }>()
    // 指定 c ⇒ 即使 a 票更多也无效
    expect(outcome.winningOptions).toEqual(["c"])
    expect(outcome.winners).toBe(2)
    expect(await claimStatus(ev, a1)).toBe("lost")
    expect(await claimStatus(ev, c1)).toBe("granted")
    expect(await getPointsBalance(env, c1.id)).toBe(10)
  })

  it("fixed：指定选项一票都没有时照样开奖（0 人中奖，不会改判别的选项）", async () => {
    const admin = await makeAdmin()
    const ev = await seedVote({ rule: "fixed", fixedOptionId: "c" })
    const a1 = await makeUser({})
    await vote(ev, a1, "a")

    const outcome = await (
      await draw(ev, admin)
    ).json<{ winningOptions: string[]; winners: number }>()
    expect(outcome.winningOptions).toEqual(["c"])
    expect(outcome.winners).toBe(0)
    expect(await claimStatus(ev, a1)).toBe("lost")
    expect(await getPointsBalance(env, a1.id)).toBe(0)
  })

  it("fixed：到点会被自动开奖扫到", async () => {
    const ev = await seedVote({ rule: "fixed", fixedOptionId: "b" })
    const u = await makeUser({})
    await vote(ev, u, "b")
    const past = new Date(Date.now() - 60_000).toISOString()
    await env.DB.prepare("UPDATE events SET ends_at = ? WHERE id = ?").bind(past, ev).run()

    await drawDueVotes(env)
    expect(await drawnAt(ev)).not.toBeNull()
    expect(await claimStatus(ev, u)).toBe("granted")
  })

  it("fixed：开奖前不告诉用户是哪个选项，开奖后才公开", async () => {
    const admin = await makeAdmin()
    const ev = await seedVote({ rule: "fixed", fixedOptionId: "c" })
    const u = await makeUser({})
    await vote(ev, u, "a")

    // 开奖前：普通用户拿不到答案（否则照着投就行）
    const before = await fetchSelf(authRequest(u, `/api/events/${ev}`))
    expect((await before.json<{ event: { vote: { fixedOptionId: string | null } } }>()).event.vote
      .fixedOptionId).toBeNull()

    expect((await draw(ev, admin)).status).toBe(200)

    // 开奖后：公开（结果已经出来了，也让没中的人知道答案）
    const after = await fetchSelf(authRequest(u, `/api/events/${ev}`))
    expect((await after.json<{ event: { vote: { fixedOptionId: string | null } } }>()).event.vote
      .fixedOptionId).toBe("c")
  })
})

describe("投票：积分可以为负数（扣积分）", () => {
  it("validatePointsReward：负数合法，0 不合法，越界拒绝", () => {
    expect(validatePointsReward({ amount: -100 })).toBeNull()
    expect(validatePointsReward({ min: -50, max: -10 })).toBeNull()
    // 跨越 0 也允许（抽到 0 时按「不增不减」处理）
    expect(validatePointsReward({ min: -10, max: 10 })).toBeNull()
    expect(validatePointsReward({ amount: 0 })).toContain("不能为 0")
    expect(validatePointsReward({ min: -5, max: -10 })).toContain("不能小于下限")
    expect(validatePointsReward({ amount: 2_000_000 })).toContain("最多")
    expect(validatePointsReward({ min: -2_000_000, max: -1_000_000 })).toContain("不能小于")
  })

  it("pickPointsAmount：负数区间按 seed 确定性取到区间内", () => {
    const p = pickPointsAmount({ min: -50, max: -10 }, "seed-a")
    expect(p).not.toBeNull()
    expect(p!.amount).toBeLessThanOrEqual(-10)
    expect(p!.amount).toBeGreaterThanOrEqual(-50)
    expect(p!.random).toBe(true)
    // 确定性：同一 seed 两次结果一致（发放失败重试不会变金额）
    expect(pickPointsAmount({ min: -50, max: -10 }, "seed-a")!.amount).toBe(p!.amount)

    const fixed = pickPointsAmount({ amount: -30 }, "seed-b")
    expect(fixed).toEqual({ amount: -30, min: -30, max: -30, random: false })
  })

  it("区间跨越 0 时可能抽到 0（由调用方按「不增不减」处理，不能丢给 applyPoints）", () => {
    const amounts = new Set<number>()
    for (let i = 0; i < 200; i++) amounts.add(pickPointsAmount({ min: -1, max: 1 }, `s${i}`)!.amount)
    // -1 / 0 / 1 都应该出现过（否则说明取模分布有问题）
    expect([...amounts].sort()).toEqual([-1, 0, 1])
  })

  it("活动奖励填负数 → 投票后真的扣掉积分", async () => {
    const u = await makeUser({})
    // 先给用户攒 100 积分
    const { applyPoints } = await import("../src/points")
    await applyPoints(env, { userId: u.id, delta: 100, reason: "event", detail: "初始" })
    expect(await getPointsBalance(env, u.id)).toBe(100)

    const ev = await seedVote({ rule: "all", rewardParams: { amount: -30 } })
    const res = await vote(ev, u, "a")
    expect(res.status).toBe(200)
    expect((await res.json<{ status: string; detail: string }>()).detail).toContain("扣除 30")
    expect(await getPointsBalance(env, u.id)).toBe(70)
  })

  it("余额不足时扣积分 → failed（不能当成「已领过」报成成功）", async () => {
    const u = await makeUser({}) // 余额 0
    const ev = await seedVote({ rule: "all", rewardParams: { amount: -30 } })

    const res = await vote(ev, u, "a")
    expect(res.status).toBe(200)
    const body = await res.json<{ status: string; detail: string }>()
    expect(body.status).toBe("failed")
    expect(body.detail).toContain("余额不足")
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })

  it("区间跨越 0 抽到 0：记为 granted 且余额不变", async () => {
    const u = await makeUser({})
    const { applyPoints } = await import("../src/points")
    await applyPoints(env, { userId: u.id, delta: 50, reason: "event", detail: "初始" })

    // 找一个必然抽到 0 的 seed 不现实，这里直接把区间压成 0~0 之外的做法不可行
    // （validate 会拒 0 固定值），所以用「区间 -1~1」+ 多试几个用户，只要出现一次 0 即可。
    let sawZero = false
    for (let i = 0; i < 12 && !sawZero; i++) {
      const ux = await makeUser({})
      await applyPoints(env, { userId: ux.id, delta: 50, reason: "event", detail: "初始" })
      const ev = await seedVote({ rule: "all", rewardParams: { min: -1, max: 1 } })
      const body = await (
        await vote(ev, ux, "a")
      ).json<{ status: string; detail: string }>()
      if (body.detail.includes("0 积分")) {
        sawZero = true
        expect(body.status).toBe("granted")
        expect(await getPointsBalance(env, ux.id)).toBe(50) // 不变
      } else {
        // 不是 0 的话余额必须真的变了（说明加/扣都落了账）
        const bal = await getPointsBalance(env, ux.id)
        expect(bal === 49 || bal === 51).toBe(true)
      }
    }
    expect(sawZero).toBe(true)
  })
})

describe("投票：奖励类型可选（不限于积分）", () => {
  it("邀请码额度：中奖者拿到邀请码额度而不是积分", async () => {
    const admin = await makeAdmin()
    const ev = await seedVote({
      rule: "majority",
      rewardType: "invite_quota",
      rewardParams: { count: 3 },
    })
    const u = await makeUser({})
    await vote(ev, u, "a")

    expect((await draw(ev, admin)).status).toBe(200)
    expect(await claimStatus(ev, u)).toBe("granted")
    const row = await env.DB.prepare("SELECT invite_quota_bonus FROM users WHERE id = ?")
      .bind(u.id)
      .first<{ invite_quota_bonus: number | null }>()
    expect(row?.invite_quota_bonus).toBe(3)
  })

  it("奖励类型 none：落成 manual，等管理员手动发", async () => {
    const admin = await makeAdmin()
    const ev = await seedVote({
      rule: "majority",
      rewardType: "none",
      rewardParams: null,
    })
    const u = await makeUser({})
    await vote(ev, u, "a")

    expect((await draw(ev, admin)).status).toBe(200)
    expect(await claimStatus(ev, u)).toBe("manual")
  })
})

describe("投票：活动推广开关（promo_hidden）", () => {
  it("隐藏的活动不出现在 /api/events 列表里，但链接仍可访问、仍可参与", async () => {
    const u = await makeUser({})
    const visible = await seedVote({ rule: "all" })
    const hidden = await seedVote({ rule: "all", promoHidden: 1 })

    const list = await fetchSelf(authRequest(u, "/api/events"))
    const ids = (await list.json<{ events: { id: string }[] }>()).events.map((e) => e.id)
    expect(ids).toContain(visible)
    expect(ids).not.toContain(hidden)

    // 链接可访问（getEvent 不过滤 promo_hidden）
    const one = await fetchSelf(authRequest(u, `/api/events/${hidden}`))
    expect(one.status).toBe(200)

    // 也能正常参与
    expect((await vote(hidden, u, "a")).status).toBe(200)
  })

  it("列表里下发了 promoHidden 字段（管理端据此显示「仅链接可见」）", async () => {
    const u = await makeUser({})
    const ev = await seedVote({ rule: "all" })
    const res = await fetchSelf(authRequest(u, `/api/events/${ev}`))
    const body = await res.json<{ event: { promoHidden: boolean } }>()
    expect(body.event.promoHidden).toBe(false)
  })
})

describe("投票：到点自动开奖", () => {
  it("过了结束时间的「多数得奖」投票由 drawDueVotes 开奖", async () => {
    const ev = await seedVote({ rule: "majority" })
    const u = await makeUser({})
    // ⚠️ 必须先投票、再把结束时间改到过去 —— 活动已结束就投不了了（claimState = ended）。
    // 直接带着过去的 ends_at 建活动会让这条用例「假通过」（什么都没投，drawn_at 当然为空）。
    await vote(ev, u, "a")
    const past = new Date(Date.now() - 60_000).toISOString()
    await env.DB.prepare("UPDATE events SET ends_at = ? WHERE id = ?").bind(past, ev).run()

    const r = await drawDueVotes(env)
    expect(r.drawn).toBeGreaterThanOrEqual(1)
    expect(await drawnAt(ev)).not.toBeNull()
    expect(await claimStatus(ev, u)).toBe("granted")
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })

  it("「参与即可获奖」的投票不会被自动开奖扫到（投票时已发完）", async () => {
    const ev = await seedVote({ rule: "all" })
    const u = await makeUser({})
    await vote(ev, u, "a")
    expect(await getPointsBalance(env, u.id)).toBe(10)
    const past = new Date(Date.now() - 60_000).toISOString()
    await env.DB.prepare("UPDATE events SET ends_at = ? WHERE id = ?").bind(past, ev).run()

    await drawDueVotes(env)
    expect(await drawnAt(ev)).toBeNull()
    // 仍然是投票时那一次，没有被重复发
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })

  it("「投票后立刻结算」的投票也不会被自动开奖扫到", async () => {
    const ev = await seedVote({ rule: "instant_minority" })
    const u = await makeUser({})
    await vote(ev, u, "a")
    expect(await getPointsBalance(env, u.id)).toBe(10)
    const past = new Date(Date.now() - 60_000).toISOString()
    await env.DB.prepare("UPDATE events SET ends_at = ? WHERE id = ?").bind(past, ev).run()

    await drawDueVotes(env)
    expect(await drawnAt(ev)).toBeNull()
    // 仍然只发了投票时那一次（没被开奖重算、也没重复发）
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })
})

describe("投票：创建/更新活动的参数校验", () => {
  it("投票活动缺少选项 → 400", async () => {
    const admin = await makeAdmin()
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/events", {
        method: "POST",
        body: JSON.stringify({
          title: "投票",
          body: "正文",
          status: "draft",
          conditionType: "vote",
          conditionParams: { options: [{ id: "a", label: "A" }], rewardRule: "all" },
        }),
      })
    )
    expect(res.status).toBe(400)
  })

  it("投票活动奖励类型可以是积分之外（与抽奖不同）", async () => {
    const admin = await makeAdmin()
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/events", {
        method: "POST",
        body: JSON.stringify({
          title: "投票2",
          body: "正文",
          status: "draft",
          conditionType: "vote",
          rewardType: "invite_quota",
          rewardParams: { count: 2 },
          conditionParams: { options: OPTIONS, rewardRule: "majority" },
        }),
      })
    )
    expect(res.status).toBe(201)
    const body = await res.json<{ event: { conditionType: string; rewardType: string } }>()
    expect(body.event.conditionType).toBe("vote")
    expect(body.event.rewardType).toBe("invite_quota")
  })

  it("创建时带 promoHidden 会落库并在列表里体现", async () => {
    const admin = await makeAdmin()
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/events", {
        method: "POST",
        body: JSON.stringify({
          title: "隐藏投票",
          body: "正文",
          status: "draft",
          conditionType: "vote",
          conditionParams: { options: OPTIONS, rewardRule: "all" },
          promoHidden: true,
        }),
      })
    )
    expect(res.status).toBe(201)
    const body = await res.json<{ event: { promoHidden: boolean } }>()
    expect(body.event.promoHidden).toBe(true)
  })
})
