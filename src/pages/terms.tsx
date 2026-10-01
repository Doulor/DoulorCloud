import { TermsContent } from "@/components/legal-content"
import { useT } from "@/i18n"

export default function TermsPage() {
  const { t } = useT()
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 lg:px-8">
      <h1 className="text-xl font-semibold">{t("legal.termsTitle")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("legal.updatedAt")}
      </p>
      <div className="mt-6">
        <TermsContent />
      </div>
    </div>
  )
}
