import * as React from "react"
import { authApi } from "@/services/api"
import type { MeResponse } from "@/types"
import { startPerfCollect } from "@/lib/perf-collect"
import { startDiagLog } from "@/lib/diag-log"

interface AuthContextValue {
  user: MeResponse["user"] | null
  loading: boolean
  setUser: (user: MeResponse["user"] | null) => void
}

const AuthContext = React.createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = React.useState<MeResponse["user"] | null>(null)
  const [loading, setLoading] = React.useState(true)
  // 每次显式登录/注册成功 +1；用它作废「挂载时那次 /me 探测」的迟到响应，
  // 避免旧 401 在登录成功后覆盖新用户态（登录循环的竞态根源）。
  const epochRef = React.useRef(0)

  const setUser = React.useCallback((next: MeResponse["user"] | null) => {
    if (next) epochRef.current += 1
    setUserState(next)
  }, [])

  React.useEffect(() => {
    let cancelled = false
    const epochAtStart = epochRef.current
    authApi
      .me()
      .then((res) => {
        if (!cancelled && epochRef.current === epochAtStart) {
          setUserState(res.user)
          // 前端可观测性开关（2026-10-10）：站点设置 perf_collect_enabled /
          // diag_log_enabled 打开时启用性能采集与诊断日志记录器。
          // 两个记录器自身幂等（start* 只生效一次），失败静默。
          try {
            if (res.perfCollectEnabled) startPerfCollect()
            if (res.diagLogEnabled) startDiagLog()
          } catch {
            // 可观测性绝不影响登录流程
          }
        }
      })
      .catch(() => {
        if (!cancelled && epochRef.current === epochAtStart) setUserState(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 任何请求返回 401 时，同步清空本地用户态
  React.useEffect(() => {
    const onExpired = () => setUserState(null)
    window.addEventListener("auth:expired", onExpired)
    return () => window.removeEventListener("auth:expired", onExpired)
  }, [])

  // value 收敛成稳定引用：AuthProvider 任何一次重渲染都不该让全部 useAuth
  // 消费者（概览页卡片等 memo 化子树）被 context 打穿而白渲染
  const value = React.useMemo(
    () => ({ user, loading, setUser }),
    [user, loading, setUser]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>")
  return ctx
}
