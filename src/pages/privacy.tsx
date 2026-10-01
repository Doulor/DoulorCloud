import { PrivacyContent } from "@/components/legal-content"
import { useT } from "@/i18n"

export default function PrivacyPage() {
  const { t } = useT()
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 lg:px-8">
      <h1 className="text-xl font-semibold">{t("legal.privacyTitle")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("legal.privacyUpdatedAt")}
      </p>
      <div className="mt-6">
        <PrivacyContent />
      </div>
    </div>
  )
}
