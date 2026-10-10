// Display-only constants shared by the pages that list orders in a compact
// row (Dashboard's recent orders, the Revenue breakdown). Lifted out of
// Dashboard.jsx so the two can't drift into different badge colours for the
// same status. Rendering still goes through t('status.<key>'); everything here
// is keyed by the STABLE keys from src/lib/orderStatus.js, never by a label.

// The raw `platform` column value -> the STABLE display label. These labels are
// also used as keys (PLATFORM_DISPLAY below, PLATFORM_META / PLATFORM_FILTERS
// in Orders.jsx), so they must never be translated in place — see
// platformDisplayName() for the rendering side.
export const PLATFORM_LABELS = {
  shopee: 'Shopee',
  lazada: 'Lazada',
  tiktok: 'TikTok',
  shopify: 'Shopify',
  // catsplaytoy.com, ingested by webhook (api/website.js).
  website: 'Website',
}

// Order of the platform breakdown grid + per-platform display styling.
// Violet for Website: the one hue not already spoken for by a marketplace
// (Shopee orange, Lazada blue, TikTok grey, Shopify green), so the badge is
// distinguishable at a glance on a crowded order list.
export const PLATFORM_DISPLAY = {
  Shopee: { dotClass: 'bg-orange-500', letter: 'S', badgeClass: 'bg-orange-500' },
  Lazada: { dotClass: 'bg-blue-500', letter: 'L', badgeClass: 'bg-blue-500' },
  TikTok: { dotClass: 'bg-gray-400', letter: 'T', badgeClass: 'bg-gray-500' },
  Shopify: { dotClass: 'bg-green-500', letter: 'SH', badgeClass: 'bg-green-600' },
  Website: { dotClass: 'bg-violet-500', letter: 'W', badgeClass: 'bg-violet-500' },
}

export function platformLabel(platform) {
  return PLATFORM_LABELS[platform] ?? platform
}

/**
 * The platform name as the USER should read it, resolved at render time.
 *
 * 'Website' is the only entry that gets translated, and the reason is worth
 * stating so the next platform isn't handled inconsistently: Shopee, Lazada,
 * TikTok and Shopify are BRAND NAMES — they are spelled the same in English
 * and Chinese, which is exactly why Orders.jsx can get away with using them
 * simultaneously as filter keys and as on-screen text. 'Website' is not a
 * brand, it is a common noun, and a zh-CN user should read 官网.
 *
 * Takes the DISPLAY label (the PLATFORM_LABELS value, i.e. what lands in
 * order.platform), not the raw column slug, because that is what every caller
 * already has in hand.
 */
export function platformDisplayName(t, displayLabel) {
  return displayLabel === 'Website' ? t('platforms.website') : displayLabel
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
