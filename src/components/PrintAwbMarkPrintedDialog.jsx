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
      <DialogContent className="border border-[#E8E6E1] bg-white sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base text-[#1F2937]">
            {t('printAwb.markPrinted.title', { count })}
          </DialogTitle>
          <DialogDescription className="text-[12px] text-[#6B7280]">
            {t('printAwb.markPrinted.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('printAwb.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={onConfirm}
            className="bg-[#2563EB] text-white hover:bg-[#2563EB]/90"
          >
            {t('printAwb.confirmButton')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
