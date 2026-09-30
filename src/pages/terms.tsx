import { TermsContent } from "@/components/legal-content"

export default function TermsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 lg:px-8">
      <h1 className="text-xl font-semibold">Doulor Cloud 服务条款</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        更新日期：2026 年 9 月 27 日 · 生效日期：2026 年 9 月 27 日
      </p>
      <div className="mt-6">
        <TermsContent />
      </div>
    </div>
  )
}
