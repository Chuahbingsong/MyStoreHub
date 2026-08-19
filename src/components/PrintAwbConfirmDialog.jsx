import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  detectAwbHintPlatform,
  hasSeenAwbOpenWithHint,
  isNativePlatform,
  markAwbOpenWithHintSeen,
} from '@/lib/awb'
import { useTranslation } from '@/lib/i18n/I18nContext'

// Android and iOS land on genuinely different post-download experiences (see
// src/lib/awb.js deliverPdf) — say so instead of promising one universal flow.
// Inside the Capacitor app, Android gets a real native "Open with" chooser
// instead of a download notification.
//
// Holds KEYS, not text: this is module scope, where there is no locale. The
// platform branch still resolves once (it cannot change mid-session); only the
// lookup moves to render time.
const HINT_KEY = {
  android: isNativePlatform()
    ? 'printAwb.hint.androidNative'
    : 'printAwb.hint.androidWeb',
  ios: 'printAwb.hint.ios',
}

/**
 * Confirm-before-download step for Print AWB. Shown once per device: the
 * platform hint below only appears the first time, then stays out of the way.
 */
export default function PrintAwbConfirmDialog({ open, count = 1, onCancel, onConfirm }) {
  const { t } = useTranslation()
  const hintKey = HINT_KEY[detectAwbHintPlatform()]
  // Read fresh each render rather than cached in state — the only state
  // change is the localStorage write below, on close, after the user has
  // already seen it for this open session.
  const showHint = open && Boolean(hintKey) && !hasSeenAwbOpenWithHint()

  function handleCancel() {
    if (showHint) markAwbOpenWithHintSeen()
    onCancel?.()
  }

  function handleOpenChange(nextOpen) {
    if (!nextOpen) handleCancel()
  }

  function handleConfirm() {
    if (showHint) markAwbOpenWithHintSeen()
    onConfirm?.()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border border-[#E8E6E1] bg-white sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base text-[#1F2937]">
            {t('printAwb.confirm.title', { count })}
          </DialogTitle>
          <DialogDescription className="text-[12px] text-[#6B7280]">
            {t('printAwb.confirm.description')}
          </DialogDescription>
        </DialogHeader>

        {showHint && hintKey && (
          <div className="rounded-md border border-[#E8E6E1] bg-[#FAFAF9] px-3 py-2 text-[12px] text-[#6B7280]">
            {t(hintKey)}
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleCancel}>
            {t('printAwb.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            className="bg-[#2563EB] text-white hover:bg-[#2563EB]/90"
          >
            {t('printAwb.confirmButton')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
