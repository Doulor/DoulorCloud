import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { TermsContent } from "@/components/legal-content"

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Doulor Cloud 服务条款</DialogTitle>
          <DialogDescription>
            更新日期：2026 年 9 月 27 日 · 生效日期：2026 年 9 月 27 日
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
