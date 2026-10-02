import * as React from "react"
import { authApi } from "@/services/api"
import type { MeResponse } from "@/types"

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
        if (!cancelled && epochRef.current === epochAtStart) setUserState(res.user)
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

  return (
    <AuthContext.Provider value={{ user, loading, setUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>")
  return ctx
}
