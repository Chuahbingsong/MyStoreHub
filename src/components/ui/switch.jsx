import { cn } from '@/lib/utils'

// Shared toggle switch used everywhere a boolean setting appears (auto-sync,
// auto-pack, auto-boost, push notifications). Controlled: pass `checked` and
// an `onCheckedChange(next)` handler. Purely presentational — it owns no state
// and performs no persistence; callers keep their own write logic.
//
// Design: a track with a sliding white thumb. On = brand blue (#2563EB), off =
// the unified warm border-grey (#E8E6E1) so "off" reads as clearly off, not a
// paler blue. The thumb carries a subtle shadow + hairline ring for lift on
// both track colours. The invisible `after` layer expands the hit area to a
// comfortable 44px tap target without changing the 44×24 visual footprint (so
// toggling never shifts layout).
export function Switch({
  checked = false,
  onCheckedChange,
  disabled = false,
  className,
  ...props
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ease-in-out',
        'after:absolute after:-inset-x-1.5 after:-inset-y-2.5 after:content-[""]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-[#2563EB]' : 'bg-[#E8E6E1]',
        className
      )}
      {...props}
    >
      <span
        className={cn(
          // Anchored at a fixed 2px inset (left-0.5 / top-0.5); translate-x
          // carries ONLY the travel. Track 44px − thumb 20px − 2px inset each
          // side = 20px of travel, so ON lands with a symmetric 2px inset and
          // never overshoots the rounded edge.
          'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-200 ease-in-out',
          checked ? 'translate-x-5' : 'translate-x-0'
        )}
      />
    </button>
  )
}
