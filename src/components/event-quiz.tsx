/**
 * 集合投票（问卷）：一个活动里含多道题，交卷后按**答对率**发奖。
 *
 * 与普通投票（event-vote.tsx）的区别：
 *   · 普通投票：一人选一个选项，投完即定（可能立刻结算，也可能截止后开奖）；
 *   · 问卷：一人答 N 题，**交卷**才结算；答对率决定落哪一档。
 *
 * 配置全部来自服务端下发的 `ev.quiz`（**不含正确答案** —— 那是有意剥掉的，
 * 见 worker/src/handlers/events.ts 的 publicQuizConfig）：
 *   retake    能否重答；reveal 每题对错何时可见；timeLimit 限时；scoring 发奖口径。
 *
 * ⚠️ 这个组件**只管展示与收集答案**，计分与发奖一律由服务端做 ——
 *    前端算分等于把答案和判定权交给客户端，刷分就无从防起。
 */
import * as React from "react"
import { CheckCircle2, Circle, Loader2, Send, Timer, XCircle } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { eventApi } from "@/services/api"
import type { EventItem } from "@/types"
import { useT } from "@/i18n"

type QuizResult = Awaited<ReturnType<typeof eventApi.submitQuiz>>

export function EventQuiz({ ev, onSubmitted }: { ev: EventItem; onSubmitted?: () => void }) {
  const { t } = useT()
  const quiz = ev.quiz
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<QuizResult | null>(null)
  /** 已用秒数：交卷时带给服务端做限时判定（服务端才是权威） */
  const [elapsed, setElapsed] = React.useState(0)
  /**
  /**
   * 计时起点：**只在内存里**（站长 2026-10-15 要求）。
   * 重新进入页面就重新计时 —— 不做跨会话持久化，也不写 localStorage。
   */
  const startedAt = React.useRef(Date.now())

  const total = quiz?.questions.length ?? 0
  const answered = quiz ? quiz.questions.filter((q) => answers[q.id]).length : 0
  const allAnswered = total > 0 && answered === total
  const totalSec = quiz?.timeLimit?.totalSec
  const remain = totalSec ? Math.max(0, totalSec - elapsed) : null

  /** 计时：只在「有整卷限时 + 还没交卷」时跑 */
  React.useEffect(() => {
    if (!totalSec || result) return undefined
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [totalSec, result])

  if (!quiz) return null

  const submit = async () => {
    setBusy(true)
    try {
      const r = await eventApi.submitQuiz(
        ev.id,
        answers,
        Math.floor((Date.now() - startedAt.current) / 1000)
      )
      setResult(r)
      onSubmitted?.()
      if (r.granted) toast.success(r.rewardNote)
      else toast.message(r.rewardNote)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }


  /** 每题对错只在服务端允许时才有（reveal=immediate），其余一律 undefined */
  const verdictOf = (qid: string): boolean | undefined => {
    const row = result?.perQuestion.find((p: { id: string; correct?: boolean }) => p.id === qid)
    return row?.correct
  }

  return (
    <div className="space-y-4">
      {/* 顶部：进度 + 限时 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{t("quiz.progress", { done: String(answered), total: String(total) })}</span>
        {quiz.retake !== "once" && <span>{t(`quiz.retake.${quiz.retake}`)}</span>}
        {remain !== null && !result && (
          <span className={cn("inline-flex items-center gap-1", remain <= 30 && "text-destructive")}>
            <Timer className="h-3.5 w-3.5" />
            {t("quiz.remaining", {
              time: `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, "0")}`,
            })}
          </span>
        )}
      </div>

      {quiz.questions.map((q, qi) => {
        const verdict = verdictOf(q.id)
        return (
          <div key={q.id} className="rounded-xl border border-border/70 bg-card/50 p-3">
            <p className="mb-2 text-sm font-medium leading-relaxed">
              <span className="mr-1 text-muted-foreground">{qi + 1}.</span>
              {q.title}
              {verdict === true && <CheckCircle2 className="ml-1 inline h-4 w-4 text-emerald-500" />}
              {verdict === false && <XCircle className="ml-1 inline h-4 w-4 text-destructive" />}
            </p>
            <div className="grid gap-1.5">
              {q.options.map((o) => {
                const picked = answers[q.id] === o.id
                const isAnswer =
                  result?.perQuestion.find((p: { id: string; answer?: string }) => p.id === q.id)
                    ?.answer === o.id
                return (
                  <button
                    key={o.id}
                    type="button"
                    disabled={busy || !!result}
                    onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: o.id }))}
                    className={cn(
                      "flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                      picked ? "border-primary bg-primary/10" : "border-border/70 hover:bg-accent/40",
                      // 交卷后：正确答案描绿、选错的描红（只有 reveal 允许时 isAnswer 才有值）
                      result && isAnswer && "border-emerald-500/70 bg-emerald-500/10",
                      result && picked && !isAnswer && "border-destructive/60 bg-destructive/5",
                      (busy || !!result) && "cursor-default"
                    )}
                  >
                    {picked ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0">
                      <span className="block">{o.label}</span>
                      {o.desc && (
                        <span className="block text-xs text-muted-foreground">{o.desc}</span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      {/* 交卷 / 结果 */}
      {result ? (
        <div className="rounded-xl border border-border/70 bg-muted/30 p-3 text-sm">
          <p className="font-medium">
            {t("quiz.score", {
              percent: String(result.percent),
              right: String(result.rightCount),
              total: String(result.total),
            })}
          </p>
          <p className="mt-1 text-muted-foreground">{result.rewardNote}</p>
          {!result.revealed && (
            /*
             * 2026-10-17（用户 fxz 反馈「问卷建议」第 2 点）：
             * 原来不管哪种模式都写「将在活动结束后公布」。但 `never` 那一档是**永不公布**，
             * 这句话就成了假承诺；而 `never` 恰恰就是他要的「只给正确率、不给答案、
             * 把答案传出去也没用」的防作弊口径（回执里本来就有 percent，见上面 quiz.score）。
             * 所以这里按模式给不同说法，并让编辑器那一档的名字直接写明"只给正确率"。
             */
            <p className="mt-1 text-xs text-muted-foreground">
              {quiz.reveal === "never" ? t("quiz.notRevealedNever") : t("quiz.notRevealed")}
            </p>
          )}
        </div>
      ) : (
        <Button onClick={() => void submit()} disabled={busy || !allAnswered}>
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />}
          {allAnswered ? t("quiz.submit") : t("quiz.needAll")}
        </Button>
      )}
    </div>
  )
}
