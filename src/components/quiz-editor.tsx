/**
 * 问卷图形化编辑器（后台用）。
 *
 * 设计取舍：
 *   · **`value`（JSON 字符串）仍是唯一数据源** —— 组件解析它、编辑后写回 JSON。
 *     这样「图形化」和「高级 JSON」天然双向同步，草稿结构（EventDraft.quizJson）
 *     一行都不用改，出问题也容易回退。
 *   · 解析失败（JSON 写坏了）时不崩：显示提示 + 让用户去高级区改，不覆盖他的输入。
 *   · 选项 id 一旦生成**不再变**（与普通投票同一原则：改标题不能让已交的卷对错答案），
 *     所以「正确答案」用**单选圆点**指向某个选项，而不是让人填 id。
 */
import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/i18n"

/* ------------------------------- 类型（与 worker 侧 parseQuizConfig 对齐） ------------------------------- */

interface QuizOption {
  id: string
  label: string
  desc?: string
  image?: string
}
interface QuizQuestion {
  id: string
  title: string
  options: QuizOption[]
  correctOptionId: string
}
interface QuizTier {
  minPercent: number
  rewardType: string
  params?: Record<string, unknown>
}
interface QuizShape {
  mode: "quiz"
  questions: QuizQuestion[]
  retake: "once" | "best" | "unlimited"
  reveal: "immediate" | "afterDeadline" | "never"
  timeLimit: { totalSec?: number; perQuestionSec?: number } | null
  scoring: { kind: "tiers"; tiers: QuizTier[] } | { kind: "linear"; maxPoints: number }
}

/** 一键示例（与后台「填入示例」同形状，必须能通过服务端 parseQuizConfig） */

const QUIZ_TEMPLATE_FOR_EDITOR = JSON.stringify(

  {

    mode: "quiz",

    questions: [

      {

        id: "q1",

        title: "1 + 1 等于几？",

        options: [

          { id: "a", label: "2" },

          { id: "b", label: "3" },

        ],

        correctOptionId: "a",

      },

    ],

    retake: "once",

    reveal: "immediate",

    scoring: { kind: "linear", maxPoints: 10 },

  },

  null,

  2

)


/** 生成稳定 id（与后台普通投票的选项 id 同一思路：随机串，生成后不变） */
const rid = (p: string) => `${p}${Math.random().toString(36).slice(2, 8)}`

/** 奖励类型（与 worker 的 REWARD_TYPES 对齐；问卷常用这几种） */
const REWARD_TYPES = ["points", "newapi_quota", "invite_quota"] as const

export function QuizEditor({
  value,
  onChange,
}: {
  /** 问卷 JSON（唯一数据源） */
  value: string
  /** 编辑后回写 JSON 字符串 */
  onChange: (json: string) => void
}) {
  const { t } = useT()
  /** 解析结果：非法时为 null（此时只提示，不覆盖用户的输入） */
  const parsed = React.useMemo<QuizShape | null>(() => {
    try {
      const o = JSON.parse(value || "{}") as QuizShape
      if (!o || typeof o !== "object") return null
      if (!Array.isArray(o.questions)) return null
      return o
    } catch {
      return null
    }
  }, [value])

  if (!parsed) {
    return (
      <div className="mt-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
        <p className="text-xs text-destructive">{t("quiz.ed.errJson")}</p>
        {/* 给条出路：不然 JSON 是空/写坏时用户就卡在这儿了（站长实测反馈） */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => onChange(QUIZ_TEMPLATE_FOR_EDITOR)}
        >
          {t("quiz.adm.fillExample")}
        </Button>
      </div>
    )
  }

  /** 改一处 → 写回 JSON（缩进 2，保持可读、也方便高级区手改） */
  const update = (fn: (d: QuizShape) => void) => {
    const next = JSON.parse(JSON.stringify(parsed)) as QuizShape
    fn(next)
    onChange(JSON.stringify(next, null, 2))
  }

  const setQuestion = (qi: number, fn: (q: QuizQuestion) => void) =>
    update((d) => fn(d.questions[qi]))

  const retake = parsed.retake ?? "once"
  const reveal = parsed.reveal ?? "afterDeadline"
  const scoring = parsed.scoring ?? { kind: "tiers", tiers: [] }
  const tiers = scoring.kind === "tiers" ? scoring.tiers : []

  return (
    <div className="mt-3 space-y-4">
      {/* ---- 全局策略 ---- */}
      <div className="grid gap-3 rounded-lg border border-border/70 p-3 sm:grid-cols-3">
        <label className="block text-xs">
          <span className="mb-1 block font-medium">{t("quiz.ed.retake")}</span>
          <select
            className="w-full rounded-md border border-border bg-background px-2 py-1.5"
            value={retake}
            onChange={(e) => update((d) => (d.retake = e.target.value as QuizShape["retake"]))}
          >
            <option value="once">{t("quiz.ed.retake.once")}</option>
            <option value="best">{t("quiz.ed.retake.best")}</option>
            <option value="unlimited">{t("quiz.ed.retake.unlimited")}</option>
          </select>
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium">{t("quiz.ed.reveal")}</span>
          <select
            className="w-full rounded-md border border-border bg-background px-2 py-1.5"
            value={reveal}
            onChange={(e) => update((d) => (d.reveal = e.target.value as QuizShape["reveal"]))}
          >
            <option value="immediate">{t("quiz.ed.reveal.immediate")}</option>
            <option value="afterDeadline">{t("quiz.ed.reveal.after")}</option>
            <option value="never">{t("quiz.ed.reveal.never")}</option>
          </select>
        </label>
        <div className="text-xs">
          <span className="mb-1 block font-medium">{t("quiz.ed.timeLimit")}</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              placeholder={t("quiz.ed.totalSec")}
              className="w-24 rounded-md border border-border bg-background px-2 py-1.5"
              value={parsed.timeLimit?.totalSec ?? ""}
              onChange={(e) =>
                update((d) => {
                  const v = Number(e.target.value) || 0
                  d.timeLimit = v > 0 ? { ...(d.timeLimit ?? {}), totalSec: v } : null
                })
              }
            />
            <span className="text-muted-foreground">{t("quiz.ed.sec")}</span>
          </div>
        </div>
      </div>

      {/* ---- 发奖口径 ---- */}
      <div className="rounded-lg border border-border/70 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-4 text-xs">
          <span className="font-medium">{t("quiz.ed.scoring")}</span>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={scoring.kind === "tiers"}
              onChange={() => update((d) => (d.scoring = { kind: "tiers", tiers: d.scoring.kind === "tiers" ? d.scoring.tiers : [] }))}
            />
            {t("quiz.ed.scoring.tiers")}
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={scoring.kind === "linear"}
              onChange={() => update((d) => (d.scoring = { kind: "linear", maxPoints: 10 }))}
            />
            {t("quiz.ed.scoring.linear")}
          </label>
        </div>

        {scoring.kind === "linear" ? (
          <label className="flex items-center gap-2 text-xs">
            {t("quiz.ed.linearMax")}
            <input
              type="number"
              min={1}
              className="w-24 rounded-md border border-border bg-background px-2 py-1.5"
              value={scoring.maxPoints}
              onChange={(e) => update((d) => (d.scoring = { kind: "linear", maxPoints: Number(e.target.value) || 0 }))}
            />
            {t("quiz.ed.points")}
          </label>
        ) : (
          <div className="space-y-2">
            {tiers.map((tier, ti) => (
              <div key={ti} className="flex flex-wrap items-center gap-2 text-xs">
                <span>{t("quiz.ed.atLeast")}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="w-20 rounded-md border border-border bg-background px-2 py-1.5"
                  value={tier.minPercent}
                  onChange={(e) =>
                    update((d) => {
                      if (d.scoring.kind === "tiers") d.scoring.tiers[ti].minPercent = Number(e.target.value) || 0
                    })
                  }
                />
                <span>% →</span>
                <select
                  className="rounded-md border border-border bg-background px-2 py-1.5"
                  value={tier.rewardType}
                  onChange={(e) =>
                    update((d) => {
                      if (d.scoring.kind === "tiers") d.scoring.tiers[ti].rewardType = e.target.value
                    })
                  }
                >
                  {REWARD_TYPES.map((r) => (
                    <option key={r} value={r}>
                      {t(`quiz.ed.reward.${r}`)}
                    </option>
                  ))}
                </select>
                {/*
                  ⚠️ 三种奖励的**参数字段名不一样**（读 worker/src/event-rewards.ts）：
                    points        → amount（积分）
                    newapi_quota  → amount（中转站钱包余额）
                    invite_quota  → count （邀请码创建额度）
                  原来只给 points 画了输入框 ⇒ 选中转站额度时**没有数量框**，只能靠手改 JSON。
                */}
                <input
                  type="number"
                  min={1}
                  className="w-20 rounded-md border border-border bg-background px-2 py-1.5"
                  value={String(
                    (tier.params as { amount?: number; count?: number } | undefined)?.[
                      tier.rewardType === "invite_quota" ? "count" : "amount"
                    ] ?? 1
                  )}
                  onChange={(e) =>
                    update((d) => {
                      if (d.scoring.kind !== "tiers") return
                      const v = Number(e.target.value) || 0
                      d.scoring.tiers[ti].params =
                        tier.rewardType === "invite_quota" ? { count: v } : { amount: v }
                    })
                  }
                />
                <span>{t(`quiz.ed.unit.${tier.rewardType}`)}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    update((d) => {
                      if (d.scoring.kind === "tiers") d.scoring.tiers.splice(ti, 1)
                    })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                update((d) => {
                  if (d.scoring.kind !== "tiers") return
                  const max = d.scoring.tiers.reduce((a, x) => Math.max(a, x.minPercent), 0)
                  d.scoring.tiers.push({
                    minPercent: Math.min(100, max === 0 ? 60 : max),
                    rewardType: "points",
                    params: { amount: 1 },
                  })
                })
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("quiz.ed.addTier")}
            </Button>
          </div>
        )}
      </div>

      {/* ---- 题目 ---- */}
      {parsed.questions.map((q, qi) => (
        <div key={q.id} className="rounded-lg border border-border/70 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t("quiz.ed.questionN", { n: String(qi + 1) })}
            </span>
            <input
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              placeholder={t("quiz.ed.questionTitle")}
              value={q.title}
              onChange={(e) => setQuestion(qi, (x) => (x.title = e.target.value))}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                update((d) => {
                  if (d.questions.length > 1) d.questions.splice(qi, 1)
                })
              }
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="space-y-1.5">
            {q.options.map((o, oi) => (
              <div key={o.id} className="flex items-center gap-2">
                {/* 单选圆点 = 正确答案 */}
                <input
                  type="radio"
                  name={`correct-${q.id}`}
                  checked={q.correctOptionId === o.id}
                  onChange={() => setQuestion(qi, (x) => (x.correctOptionId = o.id))}
                  title={t("quiz.ed.markCorrect")}
                />
                <input
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                  placeholder={t("quiz.ed.optionLabel", { n: String(oi + 1) })}
                  value={o.label}
                  onChange={(e) => setQuestion(qi, (x) => (x.options[oi].label = e.target.value))}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setQuestion(qi, (x) => {
                      if (x.options.length > 2) {
                        x.options.splice(oi, 1)
                        // 删掉的正好是正确答案 ⇒ 兜底指向第一个，避免出现"没有正确答案"
                        if (x.correctOptionId === o.id) x.correctOptionId = x.options[0]?.id ?? ""
                      }
                    })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setQuestion(qi, (x) => {
                  const id = rid("o")
                  x.options.push({ id, label: "" })
                  if (!x.correctOptionId) x.correctOptionId = id
                })
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("quiz.ed.addOption")}
            </Button>
          </div>
          {!q.correctOptionId && (
            <p className="mt-1.5 text-xs text-destructive">{t("quiz.ed.needCorrect")}</p>
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          update((d) => {
            const o1 = rid("o")
            const o2 = rid("o")
            d.questions.push({
              id: rid("q"),
              title: "",
              options: [
                { id: o1, label: "" },
                { id: o2, label: "" },
              ],
              correctOptionId: o1,
            })
          })
        }
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t("quiz.ed.addQuestion")}
      </Button>
    </div>
  )
}
