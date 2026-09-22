import * as React from "react"
import { Navigate, Route, Routes, useLocation } from "react-router-dom"

import { LandingLayout } from "@/layouts/landing-layout"
import { DashboardLayout } from "@/layouts/dashboard-layout"
import { useAuth } from "@/hooks/use-auth"
import { Skeleton } from "@/components/ui/skeleton"

import LandingPage from "@/pages/landing"
import LoginPage from "@/pages/login"
import RegisterPage from "@/pages/register"
import DashboardPage from "@/pages/dashboard"
import DomainsPage from "@/pages/domains"
import EmailPage from "@/pages/email"
import StoragePage from "@/pages/storage"
import AiPage from "@/pages/ai"
import FrpPage from "@/pages/frp"
import ProfilePage from "@/pages/profile"
import SettingsPage from "@/pages/settings"
import AdminPage from "@/pages/admin"
import NotFoundPage from "@/pages/not-found"

function FullScreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) return <FullScreenLoader />

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <>{children}</>
}

function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <FullScreenLoader />
  if (user) return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route element={<LandingLayout />}>
        <Route index element={<LandingPage />} />
        <Route
          path="login"
          element={
            <RedirectIfAuthed>
              <LoginPage />
            </RedirectIfAuthed>
          }
        />
        <Route
          path="register"
          element={
            <RedirectIfAuthed>
              <RegisterPage />
            </RedirectIfAuthed>
          }
        />
      </Route>

      <Route
        path="dashboard"
        element={
          <RequireAuth>
            <DashboardLayout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="domains" element={<DomainsPage />} />
        <Route path="dns" element={<Navigate to="/dashboard/domains" replace />} />
        <Route path="email" element={<EmailPage />} />
        <Route path="storage" element={<StoragePage />} />
        <Route path="ai" element={<AiPage />} />
        <Route path="frp" element={<FrpPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin" element={<AdminPage />} />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
