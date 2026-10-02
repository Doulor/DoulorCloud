import { Link } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { useT } from "@/i18n"

export default function NotFoundPage() {
  const { t } = useT()
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">
        {t("nf.title")}
      </h1>
      <p className="text-sm text-muted-foreground">
        {t("nf.desc")}
      </p>
      <Button asChild className="mt-2">
        <Link to="/">{t("nf.backHome")}</Link>
      </Button>
    </div>
  )
}
