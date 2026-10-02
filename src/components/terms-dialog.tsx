import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { TermsContent } from "@/components/legal-content"
import { useT } from "@/i18n"

/**
 * 《服务条款》弹窗。
 *
 * 注册页 / 登录页在提交按钮下方引一行「继续即视为同意本条款」，
 * 点「服务条款」打开本弹窗查看全文。另有独立页面 /terms（见 pages/terms.tsx）。
 * 正文复用 legal-content.tsx 的 TermsContent，保证两处一致。
 */

interface TermsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function TermsDialog({ open, onOpenChange }: TermsDialogProps) {
  const { t } = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("legal.termsTitle")}</DialogTitle>
          <DialogDescription>
            {t("legal.updatedAt")}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto pr-4">
          <div className="pb-2">
            <TermsContent />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
