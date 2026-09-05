import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/i18n/I18nContext'

/**
 * Shown when the app resumes after the native "Open with" chooser (see
 * src/lib/awbPrintPrompt.js) — Android gives no signal that a print actually
 * happened, only that the app is foreground again, so this asks the user.
 */
export default function PrintAwbMarkPrintedDialog({ open, count = 1, onCancel, onConfirm }) {
  const { t } = useTranslation()

  function handleOpenChange(nextOpen) {
    if (!nextOpen) onCancel?.()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border border-[#E8E6E1] bg-white p-6 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg text-[#1F2937]">
            {t('printAwb.markPrinted.title', { count })}
          </DialogTitle>
          <DialogDescription className="text-sm text-[#6B7280]">
            {t('printAwb.markPrinted.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex justify-end gap-6">
          <Button
            variant="outline"
            onClick={onCancel}
            className="h-12 rounded-xl px-6 text-base font-semibold"
          >
            {t('printAwb.cancel')}
          </Button>
          <Button
            onClick={onConfirm}
            className="h-12 rounded-xl bg-[#2563EB] px-6 text-base font-semibold text-white hover:bg-[#2563EB]/90"
          >
            {t('printAwb.confirmButton')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
