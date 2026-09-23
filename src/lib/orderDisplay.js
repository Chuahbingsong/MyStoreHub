// Display-only constants shared by the pages that list orders in a compact
// row (Dashboard's recent orders, the Revenue breakdown). Lifted out of
// Dashboard.jsx so the two can't drift into different badge colours for the
// same status. Rendering still goes through t('status.<key>'); everything here
// is keyed by the STABLE keys from src/lib/orderStatus.js, never by a label.

export const PLATFORM_LABELS = {
  shopee: 'Shopee',
  lazada: 'Lazada',
  tiktok: 'TikTok',
  shopify: 'Shopify',
}

// Order of the platform breakdown grid + per-platform display styling.
export const PLATFORM_DISPLAY = {
  Shopee: { dotClass: 'bg-orange-500', letter: 'S', badgeClass: 'bg-orange-500' },
  Lazada: { dotClass: 'bg-blue-500', letter: 'L', badgeClass: 'bg-blue-500' },
  TikTok: { dotClass: 'bg-gray-400', letter: 'T', badgeClass: 'bg-gray-500' },
  Shopify: { dotClass: 'bg-green-500', letter: 'SH', badgeClass: 'bg-green-600' },
}

export function platformLabel(platform) {
  return PLATFORM_LABELS[platform] ?? platform
}

// Shared pill style for status/connection badges — matches Orders' BADGE_CLS
// so the pages read as one system.
export const BADGE_CLS =
  'inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium leading-none'

// Keyed by the same stable status keys as t('status.<key>'), never by the
// display string (translating a label must not drop a badge to the default).
export const STATUS_CLASS = {
  unpaid: 'bg-gray-200 text-gray-600',
  invoicePending: 'bg-orange-500/15 text-orange-600',
  toPack: 'bg-yellow-600/15 text-yellow-700',
  retryShipment: 'bg-orange-600/15 text-orange-700',
  toConfirmReceipt: 'bg-green-500/15 text-green-600',
  cancelRequested: 'bg-amber-500/15 text-amber-700',
  returnRequested: 'bg-amber-500/15 text-amber-700',
  returned: 'bg-amber-600/15 text-amber-800',
  packed: 'bg-yellow-600/15 text-yellow-700',
  shipped: 'bg-green-500/15 text-green-600',
  completed: 'bg-teal-500/15 text-teal-600',
  cancelled: 'bg-red-500/15 text-red-600',
}
export const DEFAULT_STATUS_CLASS = 'bg-gray-500/15 text-gray-600'
