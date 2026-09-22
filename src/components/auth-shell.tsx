import * as React from "react"
import { Link } from "react-router-dom"

import { Logo } from "@/components/logo"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

interface AuthShellProps {
  title: string
  description: React.ReactNode
  footer: React.ReactNode
  children: React.ReactNode
}

export function AuthShell({ title, description, footer, children }: AuthShellProps) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-16 sm:py-24">
      <div className="mb-8">
        <Logo className="text-lg" />
      </div>
      <Card className="w-full">
        <CardHeader className="space-y-2">
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      <p className="mt-6 text-center text-sm text-muted-foreground">{footer}</p>
    </div>
  )
}

export function AuthFooterLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="font-medium text-foreground underline-offset-4 hover:underline"
    >
      {label}
    </Link>
  )
}
