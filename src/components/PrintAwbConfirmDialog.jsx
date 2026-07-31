import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { detectAwbHintPlatform, hasSeenAwbOpenWithHint, markAwbOpenWithHintSeen } from '@/lib/awb'

// Android and iOS land on genuinely different post-download experiences (see
// src/lib/awb.js downloadPdf) — say so instead of promising one universal flow.
const HINT_TEXT = {
  android: 'On Android, tap the download notification to choose which app opens it.',
  ios: 'On iPhone/iPad, the label opens in Safari — tap the share icon to open it in another app.',
}

/**
 * Confirm-before-download step for Print AWB. Shown once per device: the
 * platform hint below only appears the first time, then stays out of the way.
 */
export default function PrintAwbConfirmDialog({ open, count = 1, onCancel, onConfirm }) {
  const hint = HINT_TEXT[detectAwbHintPlatform()]
  // Read fresh each render rather than cached in state — the only state
  // change is the localStorage write below, on close, after the user has
  // already seen it for this open session.
  const showHint = open && Boolean(hint) && !hasSeenAwbOpenWithHint()

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
            Download and open {count === 1 ? 'the AWB' : `${count} AWBs`}?
          </DialogTitle>
          <DialogDescription className="text-[12px] text-[#6B7280]">
            The shipping label will download as a PDF to this device.
          </DialogDescription>
        </DialogHeader>

        {showHint && hint && (
          <div className="rounded-md border border-[#E8E6E1] bg-[#FAFAF9] px-3 py-2 text-[12px] text-[#6B7280]">
            {hint}
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            className="bg-[#2563EB] text-white hover:bg-[#2563EB]/90"
          >
            Confirm
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
