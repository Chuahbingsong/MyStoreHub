// English strings — the default locale. Keys are namespaced per page so the
// per-page rollout (Settings first, others later) stays easy to track: each
// page owns one top-level key.
export default {
  // Order-status vocabulary, shared rather than owned by any one page — the
  // same status is rendered on Dashboard, Orders and Scan, and three copies
  // would drift. Keyed by the STABLE status keys (see STATUS in
  // src/lib/orderStatus.js), never by the English label, so rewording a label
  // here can never move an order between tabs or change a badge colour.
  //
  // NOW COMPLETE: all twelve canonical statuses. Orders' private English
  // STATUS_LABEL map is gone and every page — Orders, Dashboard, Scan —
  // renders from here via t(`status.<key>`).
  //
  // The old 'new' key is retired. It was Dashboard's rendering of Shopee's raw
  // UNPAID status and disagreed with Orders, which gives UNPAID its own tab;
  // Dashboard now maps UNPAID to 'unpaid' like everything else. (This was
  // always a LABEL disagreement only — Dashboard's To Pack stat filters on
  // READY_TO_SHIP and never counted unpaid orders.)
  status: {
    unpaid: 'Unpaid',
    invoicePending: 'Invoice Pending',
    toPack: 'To Pack',
    packed: 'Packed',
    retryShipment: 'Retry Shipment',
    shipped: 'Shipped',
    toConfirmReceipt: 'To Confirm Receipt',
    completed: 'Completed',
    cancelRequested: 'Cancel Requested',
    returnRequested: 'Return Requested',
    returned: 'Returned',
    cancelled: 'Cancelled',
  },
  // Request-failure wording shared by every page — see describeRequestError in
  // src/lib/apiBase.js, which distinguishes these three failure modes so a CORS
  // break can't look identical to a Shopee-side error.
  errors: {
    timeout: 'Request timed out. Try again.',
    badResponse: 'Server sent an unexpected response. Try again.',
    unreachable: 'Could not reach the server — check your connection (see console for details).',
    // {{detail}} is the runtime's own message, appended verbatim.
    withDetail: '{{fallback}} ({{detail}})',
  },
  nav: {
    dashboard: 'Dashboard',
    orders: 'Orders',
    products: 'Products',
    boost: 'Boost',
    more: 'More',
  },
  login: {
    subtitle: 'Seller Management Dashboard',
    emailLabel: 'Email',
    passwordLabel: 'Password',
    showPasswordAria: 'Show password',
    hidePasswordAria: 'Hide password',
    rememberMe: 'Remember me',
    forgotPassword: 'Forgot Password?',
    signIn: 'Sign In',
    signingIn: 'Signing in...',
    noAccount: "Don't have an account?",
    register: 'Register',
    validationError: 'Please enter both email and password.',
    genericError: 'Invalid email or password.',
  },
  dashboard: {
    greeting: 'Good morning 👋',
    allStores: 'All Stores',
    scanCard: {
      title: 'Scan Order',
      description: "Scan an AWB to check a parcel's contents before sealing",
    },
    stats: {
      ordersToday: 'Orders Today',
      revenue: 'Revenue',
      lowStock: 'Low Stock',
      basis:
        "Counts all of today's orders (Malaysia time, all platforms), except cancelled orders and unpaid orders that aren't Cash on Delivery. Revenue includes COD money not yet received.",
    },
    platforms: {
      title: 'Platforms',
      connected: 'Connected',
      notConnected: 'Not connected',
      orderCount_one: '{{count}} order',
      orderCount_other: '{{count}} orders',
    },
    recentOrders: {
      title: 'Recent Orders',
      viewAll: 'View All →',
      empty: 'No orders yet.',
      unknownBuyer: 'Unknown Buyer',
    },
    quickActions: {
      title: 'Quick Actions',
      printAwb: 'Print AWB',
      // PROVISIONAL — same vocabulary as Orders.jsx's "New Orders" tab and
      // BottomNav's "Boost" label. Being settled in a separate pass before
      // Orders.jsx is converted; revisit these two for consistency then.
      newOrders: 'New Orders',
      flashDeals: 'Flash Deals',
      boostNow: 'Boost Now',
    },
    // dashboard.status.* moved to the top-level `status:` namespace — it was
    // never Dashboard-specific vocabulary, and Scan/Orders render the same
    // statuses. Call sites use t('status.<key>').
  },
  settings: {
    title: 'Settings',
    language: {
      title: 'Language',
      en: 'English',
      zh: '中文',
    },
    shipping: {
      title: 'Shipping',
      label: 'Shipping methods',
      description: 'Pick which couriers each store offers at checkout',
    },
    connectedStores: {
      title: 'Connected Stores',
      empty: 'No stores connected yet',
      connected: 'Connected',
      shopId: 'Shop ID: {{id}}',
      lastSynced: 'Last synced {{date}}',
      editNameSaveAria: 'Save store name',
      editNameCancelAria: 'Cancel editing store name',
      editNameEditAria: 'Edit store name',
      autoPack: {
        title: 'Auto-pack new orders',
        description: 'Arranges shipment automatically 15+ min after payment',
        toggleAria: 'Toggle auto-pack for {{name}}',
        enabledToast: 'Auto-pack enabled for this store',
        disabledToast: 'Auto-pack disabled for this store',
        errorToast: 'Failed to update auto-pack setting.',
      },
      sync: {
        ordersButton: 'Sync Orders',
        productsButton: 'Sync Products',
        syncing: 'Syncing...',
        loginRequired: 'You must be logged in to sync.',
        ordersSuccess: 'Synced {{count}} orders!',
        ordersError: 'Failed to sync orders.',
        productsSuccess: 'Synced {{count}} products!',
        productsError: 'Failed to sync products.',
        notSupported: 'Syncing isn\'t available for this platform yet.',
      },
      nameUpdatedToast: 'Store name updated',
      nameErrorToast: 'Failed to update store name.',
    },
    connectStore: {
      title: 'Connect a Store',
      comingSoon: 'Coming soon',
      connect: 'Connect',
      connectedToast: 'Shopee store connected!',
      startErrorToast: 'Failed to start Shopee connection.',
      tiktokLoginRequired: 'You must be logged in to connect TikTok Shop.',
      tiktokStartErrorToast: 'Failed to start TikTok Shop connection.',
      lazadaLoginRequired: 'You must be logged in to connect Lazada.',
      lazadaStartErrorToast: 'Failed to start Lazada connection.',
    },
    orders: {
      title: 'Orders',
      autoSyncLabel: 'Auto-sync orders (60s)',
      autoSyncDescription: "Keeps the Orders page fresh while it's open. Pauses when the tab is hidden.",
      autoSyncAria: 'Toggle auto-sync orders',
    },
    push: {
      title: 'Notifications',
      label: 'Push notifications',
      description: 'Alerts this device when a new order arrives or a buyer requests to cancel — even when the app is closed.',
      toggleAria: 'Toggle push notifications',
      enabledToast: 'Push notifications enabled on this device',
      disabledToast: 'Push notifications disabled on this device',
      deniedToast: 'Notifications are blocked. Allow them in your browser settings, then try again.',
      errorToast: 'Failed to update push notifications.',
      unsupported: "This browser doesn't support push notifications.",
      iosHint: 'On iPhone, add MyStore Hub to your Home Screen first (Share → Add to Home Screen), then open it from the icon to enable notifications. Requires iOS 16.4 or later.',
    },
    account: {
      title: 'Account',
      loggedInAs: 'Logged in as',
      logout: 'Logout',
    },
  },
  boost: {
    title: 'Boost Manager',
    subtitle: 'Shopee product boosts',
    howItWorks:
      'Each store boosts {{max}} products for ~4 hours, then auto re-boosts the next products in your rotation. Turn a store on and MyStore Hub owns its {{max}} slots — switch off any other booster (e.g. BigSeller) for that store first.',
    noStores: 'No Shopee stores connected yet.',
    // Placeholders for empty Shopee fields; real names render untouched.
    unnamedStore: 'Unnamed store',
    untitledProduct: 'Untitled product',
    slotsSummary: '{{active}}/{{max}} slots boosting · {{rotation}} in rotation',
    // Was built in JSX as `slot{n > 1 ? 's are' : ' is'}` — English inflection
    // no translation could reach.
    externallyControlled_one:
      "{{count}} slot is controlled by another booster. Turn BigSeller's boost off for this store so MyStore Hub can take over.",
    externallyControlled_other:
      "{{count}} slots are controlled by another booster. Turn BigSeller's boost off for this store so MyStore Hub can take over.",
    minutesLeft: '{{mins}}m left',
    ready: 'ready',
    emptySlot: 'empty',
    editRotation: 'Edit Rotation',
    rotationTitle: 'Rotation — {{store}}',
    inRotation: 'In rotation ({{count}})',
    emptyRotation:
      'No products yet — add some below. The scheduler cycles the {{max}} slots through this list, least-recently-boosted first.',
    lastBoosted: 'Last boosted {{date}}',
    neverBoosted: 'Never boosted',
    addProduct: 'Add product',
    searchProducts: 'Search products',
    noSyncedProducts: 'No synced products for this store yet.',
    noProductsMatch: 'No products match.',
    stock: 'Stock',
    add: 'Add',
    enabledToast: 'Auto-boost on — MyStore Hub now owns this store’s {{max}} slots',
    disabledToast: 'Auto-boost off',
    toggleError: 'Could not update auto-boost',
    addError: 'Could not add to rotation',
    removeError: 'Could not remove from rotation',
  },
  flashDeals: {
    title: 'Flash Deals',
    subtitle: 'Shopee flash sale sessions',
    monitoringNote:
      "Monitoring only. BigSeller creates and fills these slots — MyStore Hub reads them so you can watch prices, quotas and timing in one place. Shopee doesn't report units sold, so quota is the allocated amount, not stock left.",
    copyDisabledHint: 'Copy is coming soon — pending the 2 Aug slot-ownership test',
    // Tab labels. The tab KEYS (ongoing/upcoming/expired) are stable and come
    // from liveState(); only these labels change with the locale.
    tabs: {
      ongoing: 'Live',
      upcoming: 'Upcoming',
      expired: 'Ended',
    },
    // Status pill wording for the same three states, plus Shopee's rejection.
    state: {
      ongoing: 'Ongoing',
      upcoming: 'Upcoming',
      expired: 'Ended',
      rejected: 'Rejected',
    },
    emptyTab: {
      ongoing: 'No live sessions.',
      upcoming: 'No upcoming sessions.',
      expired: 'No ended sessions.',
    },
    noDataYet: 'No flash sale data yet — it appears after the next sync.',
    noItemData: 'No item data synced for this session yet.',
    session: 'Session',
    clear: 'Clear',
    selectedCount: '{{count}} selected',
    endsIn: 'Ends in {{duration}}',
    startsIn: 'Starts in {{duration}}',
    endsNextDay: 'Ends the next day',
    selectSlot: 'Select {{slot}}',
    // Placeholders for missing Shopee data; real names render untouched.
    unknownStore: 'Store',
    untitledItem: 'Untitled',
    // Shown when Shopee returns a status code this app has no mapping for.
    unknownStatusCode: 'Status {{code}}',
    syncedAgo: 'Synced {{ago}}',
    refreshFailed: 'Refresh failed.',
    tryAgainIn: 'Try again in {{secs}}s.',
    refreshed: 'Refreshed — {{items}} item(s), {{variants}} variant(s).',
    networkError: 'Network error',
    clicksCount: '{{count}} clicks',
    remindersCount: '{{count}} reminders',
    variantsCount: '{{count}} variants',
    rejectedVariants: '{{count}} variant(s) rejected by Shopee',
    buyerPaysInclTax: 'Buyer pays incl. tax',
    promoQuota: 'Promo quota',
    maxPerBuyer: 'max {{limit}}/buyer',
    productStockNow: 'Product stock now',
    outOfStock: 'out of stock',
    underDiscountFloor: 'under 10% floor',
    countsDisagree:
      'Shopee reports {{reported}} enabled item(s), but the item list returns {{derived}}. The item list is the one to trust — Shopee zeroes this figure on ended sessions.',
    columns: {
      timeSlot: 'Time slot',
      flashSaleId: 'Flash sale ID',
      items: 'Items',
      clicks: 'Clicks',
      remind: 'Remind',
      status: 'Status',
      renew: 'Renew',
      actions: 'Actions',
    },
    details: {
      itemsInSlot: 'Items in slot',
      enabledItems: 'Enabled items',
      variants: 'Variants',
      shopeeReports: 'Shopee reports',
      flashSaleId: 'Flash sale ID',
      timeslotId: 'Time slot ID',
    },
    actions: {
      refresh: 'Refresh this session from Shopee',
      coolingDown: 'Cooling down — {{secs}}s',
      copy: 'Copy this session into a free slot',
      details: 'Open details',
    },
    autoRenew: {
      short: 'Auto-renew',
      title: 'Auto-renew this slot',
      previewBadge: 'Preview',
      notActive: 'Not active yet — this toggle does nothing so far.',
    },
    // Shopee's per-variant status enum (MODEL_STATUS), keyed by stable key.
    modelStatus: {
      disabled: 'Disabled',
      enabled: 'Enabled',
      deleted: 'Deleted',
      systemRejected: 'System rejected',
      manualRejected: 'Manual rejected',
    },
    // Shopee's session-level status enum (SESSION_STATUS) — a distinct enum.
    sessionStatus: {
      deleted: 'Deleted',
      enabled: 'Enabled',
      disabled: 'Disabled',
      systemRejected: 'System rejected',
    },
    // Lead-time buckets in the slot picker; keys come from slotRisk().
    risk: {
      near: {
        label: 'Within 48h',
        note: 'Higher risk — the slot-ownership race with BigSeller is still untested',
      },
      mid: { label: '2–7 days out', note: 'Some lead time' },
      far: { label: '7+ days out', note: 'Safest — most lead time before BigSeller would act' },
    },
    picker: {
      title: 'Choose time slots',
      description:
        'Free slots in the 18-day horizon. Pick up to {{max}} — each one becomes its own flash sale.',
      noFreeSlots: 'No free slots in the 18-day horizon for this store.',
      justCopied: 'just copied',
      selectedCount: '{{picked}} of {{max}} selected',
      estimate: '~{{duration}} — {{perMin}}/min rate limit',
      atCap:
        '{{max}} is the cap — the batch runs in this screen, and more would mean waiting here far longer.',
      confirmCount_one: 'Confirm {{count}} slot',
      confirmCount_other: 'Confirm {{count}} slots',
      confirmEmpty: 'Confirm slots',
    },
    tally: {
      // Assembled into one line by the batch summary toast.
      join: ', ',
      copied: '{{count}} copied',
      partial: '{{count}} partial',
      unverified: '{{count}} unverified',
      failed: '{{count}} failed',
      skipped: '{{count}} skipped',
      allCopied: '{{count}} slot(s) copied.',
      mixed: '{{parts}} — see the per-slot results.',
    },
    copy: {
      sheetTitle: 'Copy to free slots',
      fromSlot: 'From {{slot}}',
      disabledBanner:
        '⏸️ Copy is disabled. This is a preview of what would be written — nothing is sent to Shopee. Pending the 2 Aug slot-ownership test.',
      loadingSlots: 'Loading slots…',
      chooseSlot: 'Choose Time Slot',
      changeSlots: 'Change slots ({{count}})',
      removeSlot: 'Remove {{slot}}',
      nearTermWarning:
        "⚠️ Some picks start within 48h. Whether Shopee lets us hold a slot BigSeller also wants is still unobserved — the 2 Aug test hasn't run yet.",
      copyingHeading: 'Copying…',
      resultsHeading: 'Results',
      slotCount_one: '{{count}} slot',
      slotCount_other: '{{count}} slots',
      willCopySummary: 'Will copy {{items}} item(s) / {{variants}} variant(s), prices unchanged',
      copiedSummary: 'Copied {{items}} item(s) / {{variants}} variant(s), prices unchanged',
      intoEachSlot: ', into each of {{count}} slots',
      pricesNote:
        "Disabled and rejected variants are skipped. Prices are copied exactly — re-running a price is the case proven not to trip Shopee's lowest-price rule.",
      noEnabledVariants: 'No enabled variants on this session — nothing to copy.',
      stopAfterCurrent: 'Stop after the current slot',
      done: 'Done',
      copyDisabled: 'Copy disabled',
      chooseSlotFirst: 'Choose a slot first',
      createDeals_one: 'Create {{count}} flash deal',
      createDeals_other: 'Create {{count}} flash deals',
      keepOpen: 'Keep this screen open — the batch runs here, not on the server.',
      copying: 'Copying',
      waitingForLock: 'Waiting for lock',
      rateLimit: 'Rate limit',
      queued: 'Queued',
      skipped: 'Skipped',
      lockHeldNote:
        'An earlier copy still holds this store’s lock. If it was killed mid-flight the lock clears on its own within 90s — this slot has not failed.',
      verdictCopied: 'Copied — {{persisted}}/{{sent}} models verified',
      verdictFailed: 'FAILED — no flash sale confirmed',
      verdictPartial: 'PARTIAL — {{persisted}}/{{sent}} models verified',
      verdictUnverified: 'UNVERIFIED — {{persisted}}/{{sent}} models verified',
      uncertainNote:
        'The request was sent but its outcome is unknown — a session may still have been created on this slot. Check Shopee before retrying it.',
      newFlashSale: 'New flash sale',
      onSlot: 'on slot',
      // {{error}} and the addError value are Shopee's own text, passed through.
      addCallReported: 'Add call reported',
      readBackFailed:
        'Read-back failed: {{error}}. What landed is unknown — inspect the session on Shopee before retrying.',
      notPersisted: 'Sent but not persisted ({{count}}):',
      priceDrift: 'Price drift ({{count}}):',
      quotaDrift: 'Quota drift ({{count}}):',
      rejectedByShopee: 'Rejected by Shopee ({{count}}):',
      sentGot: 'sent {{sent}} → got {{got}}',
      lockTimeoutError:
        'Another copy held this store’s lock for over 90s — it was probably killed mid-flight. This slot was never attempted; retry it.',
      neverAttempted: 'This slot was never attempted; retry it.',
      httpError: 'Copy failed (HTTP {{status}})',
      batchFailed: 'Copy batch failed.',
    },
  },
  // Shared by BulkPrint and Orders — both render the same two AWB dialogs.
  printAwb: {
    cancel: 'Cancel',
    confirmButton: 'Confirm',
    confirm: {
      title_one: 'Download and open the AWB?',
      title_other: 'Download and open {{count}} AWBs?',
      description: 'The shipping label will download as a PDF to this device.',
    },
    markPrinted: {
      title_one: 'Mark this package as printed?',
      title_other: 'Mark {{count}} packages as printed?',
      description: 'Confirm once the label has actually printed.',
    },
    // Android and iOS reach genuinely different post-download flows, and the
    // Capacitor build differs again from the browser — see HINT_KEY in
    // PrintAwbConfirmDialog.jsx.
    hint: {
      androidNative: 'An "Open with" chooser will appear — pick your printer app (or Drive, WPS, etc).',
      androidWeb: 'On Android, tap the download notification to choose which app opens it.',
      ios: 'On iPhone/iPad, the label opens in Safari — tap the share icon to open it in another app.',
    },
  },
  bulkPrint: {
    title: 'Bulk Print AWB',
    loading: 'Loading...',
    backToOrders: 'Back to orders',
    backToOrdersButton: 'Back to Orders',
    readyToPrint_one: '{{count}} order ready to print',
    readyToPrint_other: '{{count}} orders ready to print',
    orderCount_one: '{{count}} order',
    orderCount_other: '{{count}} orders',
    // Placeholders for rows where Shopee gave no courier / no shop name. The
    // real courier and shop names are DATA and render untouched.
    unknownCourier: 'Unknown courier',
    unknownStore: 'Unknown store',
    shopFallback: 'Shop {{id}}',
    noCourierWarning: 'No courier recorded — these may span channels and print as separate files.',
    printed: 'Printed',
    printing: 'Printing...',
    print: 'Print',
    allPrinted: 'All labels printed',
    allPrintedHint: 'Nothing is waiting for an AWB right now.',
    // One sentence with both counts, rather than fragments concatenated in
    // JSX: en and zh-CN order these differently.
    summary: '{{orders}} order(s) across {{groups}} group(s)',
    perChannelNote: 'Shopee prints one file per logistics channel, so each group is printed separately.',
    preparingMerged: 'Preparing one file...',
    printMerged: 'Print all unprinted as one file',
    printMergedCount: 'Print all unprinted as one file ({{count}})',
    mergeUnavailable: 'Nothing here can be merged yet — orders must be processed by Shopee before a label exists.',
    mergeAvailable: 'Every Shopee label above, merged into a single PDF, sorted by courier so the printed stack is already grouped.',
    loadError: 'Failed to load orders.',
    loginRequired: 'You must be logged in to print.',
    printError: 'Failed to print labels.',
    nothingToPrint: 'Nothing to print.',
    deliveryError: 'Labels generated but could not be saved/opened on this device.',
    printedToast_one: 'Printed {{count}} label — {{courier}}',
    printedToast_other: 'Printed {{count}} labels — {{courier}}',
    mergedToast_one: 'Printed {{count}} label in one file',
    mergedToast_other: 'Printed {{count}} labels in one file',
    remainingToast_one: '{{count}} more order left — print again to continue.',
    remainingToast_other: '{{count}} more orders left — print again to continue.',
    notReadyToast_one: '{{count}} order not ready — no tracking number yet.',
    notReadyToast_other: '{{count}} orders not ready — no tracking number yet.',
    // {{reason}} is Shopee's own per-order explanation (see describeFailedOrders
    // in lib/awb.js) — marketplace text, never translated.
    skippedToast_one: '{{count}} order skipped — {{reason}}',
    skippedToast_other: '{{count}} orders skipped — {{reason}}',
    failedToast_one: '{{count}} order failed — {{reason}}',
    failedToast_other: '{{count}} orders failed — {{reason}}',
  },
  scan: {
    title: 'Scan to Check Order',
    subtitle: 'Scan the AWB barcode to double-check contents before sealing',
    back: 'Back',
    lookingUp: 'Looking up order…',
    toggleTorch: 'Toggle flashlight',
    torchUnsupported: 'Flashlight not supported on this device.',
    lookupError: 'Lookup failed — check your connection and try again.',
    cameraBlocked: 'Camera access is blocked',
    // Two variants because the APK's WebView has no browser settings to send
    // anyone to — see CAMERA_DENIED_HELP_KEY in Scan.jsx.
    cameraDenied: {
      native:
        'Allow camera access for MyStore Hub in Android Settings › Apps › MyStore Hub › Permissions, then try again — or type the tracking number below.',
      web: 'Allow camera access for this site in your browser settings, then reload — or type the tracking number below.',
    },
    retryCamera: 'Try camera again',
    manualPlaceholder: 'Or type/paste the tracking number',
    lookUp: 'Look up',
    notFound: 'Order not found — try syncing',
    // {{value}} is the raw text off the barcode — echoed back verbatim so the
    // seller can compare it against the label in their hand.
    scannedValue: 'Scanned: {{value}}',
    scanAgain: 'Scan again',
    scanAnother: 'Scan another',
    // Placeholders only. The buyer's name and the product name are Shopee DATA
    // and render untouched; these fill in when the field is empty.
    unknownBuyer: 'Unknown Buyer',
    unnamedItem: 'Unnamed item',
    unknownStatus: 'Unknown',
    fields: {
      order: 'Order',
      package: 'Package',
      tracking: 'Tracking',
      // Kept as the acronym in both locales: it is what is printed on the AWB
      // and in Seller Centre, and sellers scan for it visually.
      sku: 'SKU',
      total: 'Order Total',
    },
    noItems: 'No items found for this order.',
    viewImage: 'View larger image',
    closePreview: 'Close preview',
  },
  products: {
    title: 'Products',
    // Placeholder for a Shopee product row with no title. The product's real
    // title is DATA and is never translated — this is only what fills the gap
    // when Shopee sent none.
    untitled: 'Untitled product',
    searchPlaceholder: 'Search product name or SKU',
    clearSearch: 'Clear search',
    empty: 'No products yet — tap Sync to fetch your Shopee products',
    noMatches: 'No products found.',
    filters: {
      // Only the "All" chip; the other chips are platform brand names, which
      // are not translated in either locale.
      all: 'All',
    },
    statusFilters: {
      all: 'All',
      active: 'Active',
      lowStock: 'Low Stock',
      outOfStock: 'Out of Stock',
    },
    // Shopee's product-listing states, keyed by the stable keys in
    // SHOPEE_PRODUCT_STATUS_MAP.
    status: {
      active: 'Active',
      unlisted: 'Unlisted',
      banned: 'Banned',
      deleted: 'Deleted',
    },
    card: {
      outOfStock: 'Out of stock',
      inStock: '{{count}} in stock',
    },
    sync: {
      button: 'Sync',
      loginRequired: 'You must be logged in to sync.',
      success: 'Synced {{count}} products!',
      error: 'Failed to sync products.',
    },
    edit: {
      title: 'Edit Product',
      titleField: 'Title',
      priceField: 'Price (RM)',
      stockField: 'Stock',
      cancel: 'Cancel',
      save: 'Save',
      saved: 'Product updated!',
      titleRequired: 'Title cannot be empty.',
      priceInvalid: 'Enter a valid price.',
      stockInvalid: 'Enter a valid stock quantity.',
      saveError: 'Failed to save changes.',
    },
  },
  sales: {
    title: 'Sales',
    subtitle: 'Daily revenue, last 30 days',
    allStores: 'All Stores',
    open: 'View sales report',
    yesterday: 'Yesterday',
    totals: {
      revenue: '30-day revenue',
      orders: '30-day orders',
      avgPerDay: 'Avg / day',
    },
    chart: {
      title: 'Daily revenue',
      noSales: 'No sales in this window.',
    },
    table: {
      title: 'Daily figures',
      date: 'Date',
      revenue: 'Revenue',
      orders: 'Orders',
      noData: 'No data yet.',
      beforeHistory: 'Before synced history',
    },
    coverage: {
      partial:
        'Order history starts {{date}}. The {{days}} earlier day(s) in this window are outside your synced data — they are not days with no sales.',
      none: 'No orders have been synced yet, so there is nothing to report.',
    },
    // Stated in the UI rather than buried in a tooltip: which orders count is
    // the single assumption a revenue figure rests on.
    basis:
      'Counts processed, shipped, to-confirm, completed and retry-ship orders. Excludes unpaid, cancelled and returns. Days run 00:00–24:00 Malaysia time.',
    error: 'Could not load the sales report. The database function may not be installed yet.',
  },
  orders: {
    title: 'Orders',
    searchPlaceholder: 'Search order ID or buyer name',
    clearSearch: 'Clear search',
    scanAria: 'Scan to check order',
    selectedCount: '{{count}} selected',
    updatedAgo: 'Updated {{ago}}',
    catchingUp: 'Catching up',
    catchingUpHint: 'This store has more orders than fit in one sync — keep syncing to catch up.',
    printAll: 'Print All AWB',
    printAllCount: 'Print All AWB ({{count}})',
    truncated:
      'Showing the {{count}} most recent orders only — older ones are not loaded, so counts and search below exclude them.',
    // Placeholders for empty Shopee fields; real values render untouched.
    unknownBuyer: 'Unknown Buyer',
    unnamedItem: 'Item',
    copyTracking: 'Copy tracking number',
    viewImage: 'View larger image',
    closePreview: 'Close preview',
    loginRequired: 'You must be logged in.',
    arrangedVia: 'Arranged via',
    paidAt: 'Paid {{date}}',
    packedAt: 'Packed {{date}}',
    // TAB LABELS — keyed by the stable tab ids in TABS. These are this app's
    // own groupings, not Shopee screens, so they need not match Seller Centre
    // one-for-one. 'other' is a safety net that should always read 0.
    tabs: {
      unpaid: 'Unpaid',
      new: 'New Orders',
      inprocess: 'In Process',
      shipped: 'Shipped',
      completed: 'Completed',
      cancelRequests: 'Cancel Requests',
      returns: 'Returns',
      cancelled: 'Cancelled',
      other: 'Other',
    },
    filters: {
      // Only the "All" chip — the rest are platform brand names.
      all: 'All',
    },
    printedFilters: {
      all: 'All',
      notPrinted: 'Not Printed',
      printed: 'Printed',
    },
    // Raw Shopee ship-method values are the stable keys here.
    shippingMethod: {
      pickup: 'Pickup',
      dropoff: 'Dropoff',
      non_integrated: 'Non-integrated',
    },
    timeline: {
      ordered: 'Ordered',
      packed: 'Packed',
      shipped: 'Shipped',
    },
    // Shopee Seller Centre's OWN wording for a status, which is deliberately
    // not the same as this app's (Shopee calls both To Pack and Packed
    // "Processed"). Only Shopee is translated here — the other platforms keep
    // their own English in MARKETPLACE_STATUS, since that is what their
    // consoles actually display.
    marketplaceStatus: {
      shopee: {
        unpaid: 'Unpaid',
        invoicePending: 'Invoice Pending',
        processed: 'Processed',
        retryShipment: 'Retry Shipment',
        shipped: 'Shipped',
        toConfirmReceive: 'To Confirm Receive',
        cancellationRequested: 'Cancellation Requested',
        toReturnRefund: 'To Return/Refund',
        cancelled: 'Cancelled',
      },
    },
    sections: {
      buyer: 'Buyer',
      shipping: 'Shipping',
      items: 'Items',
      timeline: 'Order Timeline',
    },
    fields: {
      marketplaceStatus: 'Marketplace status',
      logistics: 'Logistics',
      trackingNo: 'Tracking No.',
      paid: 'Paid',
      packed: 'Packed',
      autoSuffix: '(auto)',
      qty: 'Qty',
      subtotal: 'Subtotal',
      shippingFee: 'Shipping',
      total: 'Total',
    },
    actions: {
      printAwb: 'Print AWB',
      printLabel: 'Print Label',
      pack: 'Pack',
      ship: 'Ship',
      cancel: 'Cancel',
      track: 'Track',
      approve: 'Approve',
      reject: 'Reject',
    },
    flags: {
      waitingForPayment: 'Waiting for payment',
      printed: 'Printed',
      printedAt: 'Printed {{date}}',
      autoPackFailed: 'Auto-pack failed — needs manual Pack',
      autoPackFailedHint: 'Auto-pack failed — pack this order manually',
      autoPacked: 'Auto-packed',
    },
    autoPack: {
      failed: 'Auto-pack failed',
      unknownError: 'Unknown error',
      noRetry: 'This order will not be retried automatically — use Pack below.',
    },
    empty: {
      title: 'No orders yet',
      hint: 'Tap Sync above to fetch your Shopee orders',
    },
    noResults: {
      title: 'No orders found',
      hint: 'Try a different search term or filter',
    },
    cancelRequest: {
      title: 'Buyer requested cancellation',
      reason: 'Reason',
      notProvided: 'Not provided',
      deadlineShort: 'Respond within ~2 days or Shopee auto-accepts.',
      deadline:
        'Respond within ~2 days or Shopee automatically accepts the cancellation and refunds the buyer. Read the reason, then Approve or Reject below.',
    },
    sync: {
      button: 'Sync',
      noStore: 'No Shopee store connected — nothing to sync yet.',
      error: 'Failed to sync orders.',
      partial: 'Some stores failed to sync.',
      autoError: 'Auto-sync failed.',
      success_one: 'Synced — {{count}} order updated',
      success_other: 'Synced — {{count}} orders updated',
      // A separate whole sentence rather than a clause appended to the one
      // above: the trailing "— more pending" could not be concatenated onto a
      // Chinese sentence and still read as grammar.
      successMore_one: 'Synced — {{count}} order updated. More pending; sync again to continue.',
      successMore_other: 'Synced — {{count}} orders updated. More pending; sync again to continue.',
    },
    printAwb: {
      realOrdersOnly: 'Print AWB works with real connected orders only.',
      loginRequired: 'You must be logged in to print.',
      error: 'Failed to print AWB.',
      bulkError: 'Failed to print labels.',
      deliveryErrorSingle: 'Label generated but could not be saved/opened on this device.',
      deliveryError: 'Labels generated but could not be saved/opened on this device.',
      downloaded: 'Downloaded {{files}} label file(s) covering {{orders}} order(s)',
      notReady_one: '{{count}} order not ready — no tracking number yet.',
      notReady_other: '{{count}} orders not ready — no tracking number yet.',
      // {{reason}} is Shopee's own per-order text (describeFailedOrders).
      failed_one: '{{count}} order failed — {{reason}}',
      failed_other: '{{count}} orders failed — {{reason}}',
      sameStoreOnly: 'Printed {{printed}} of {{selected}} selected (same store only).',
    },
    pack: {
      realOrdersOnly: 'Pack works with real connected orders only.',
      error: 'Failed to arrange shipment.',
      success: 'Shipment arranged — Shopee notified',
    },
    ship: {
      realOrdersOnly: 'Ship works with real connected orders only.',
      error: 'Failed to ship order.',
      success: 'Order shipped!',
    },
    cancel: {
      realOrdersOnly: 'Cancel works with real connected orders only.',
      error: 'Failed to cancel order.',
      success: 'Order cancelled.',
    },
    bulk: {
      shipped: 'Shipped {{succeeded}} of {{total}} order(s).',
      shipError: 'Failed to ship orders.',
      cancelled: 'Cancelled {{succeeded}} of {{total}} order(s).',
      cancelError: 'Failed to cancel orders.',
    },
    // Keyed on the DECISION, not on an English verb. The old code built these
    // as `Failed to ${verb.toLowerCase()} cancellation.` — runtime English
    // morphology that no dictionary could reach.
    buyerCancel: {
      realOrdersOnly: 'This works with real connected orders only.',
      noReason: 'no reason given',
      alreadyResolved: 'This cancellation was already resolved.',
      confirm: {
        approve:
          "Approve cancellation of {{id}}?\n\nBuyer's reason: {{reason}}\n\nThe order will be cancelled and the buyer refunded. This cannot be undone.",
        reject:
          "Reject cancellation of {{id}}?\n\nBuyer's reason: {{reason}}\n\nThe order returns to fulfilment and the buyer is expected to receive it. This cannot be undone.",
      },
      error: {
        approve: 'Failed to approve cancellation.',
        reject: 'Failed to reject cancellation.',
      },
      success: {
        approve: 'Cancellation approved.',
        reject: 'Cancellation rejected.',
      },
    },
    buyerMessage: {
      badge: '💬 Buyer left a message',
      title: 'Buyer left a message',
      hint: 'Read this before packing — it may need a substitution, gift wrap, or delivery instruction a human has to decide on.',
    },
  },
  shipping: {
    title: 'Shipping Methods',
    subtitle: 'Couriers offered at checkout, per store',
    liveAt: 'Live from Shopee · {{time}}',
    refresh: 'Refresh',
    loading: 'Reading live channel state from Shopee...',
    loadError: 'Could not load shipping methods from Shopee.',
    loginRequired: 'You must be logged in.',
    noStores: 'No Shopee stores connected yet.',
    storesFailed: "Couldn't read channels for: {{names}}. Those columns are hidden.",
    courier: 'Courier',
    // Fallback when a store id has no matching shop name — the real shop name
    // is DATA and renders untouched.
    thisStore: 'this store',
    // Tooltips on the per-store toggle cell.
    cell: {
      notOffered: 'Not offered for this store',
      lockedCompulsory: 'Shopee requires this courier — it cannot be turned off',
      lockedForced: 'Shopee forces this courier on — it cannot be changed',
    },
    standalone: 'Standalone couriers',
    on: 'On',
    off: 'Off',
    dismiss: 'Dismiss',
    parentLocked: 'Managed in Seller Centre',
    sharedChildren: 'Couriers listed under Doorstep Delivery',
    alsoUnder: 'Also listed under Bulky Delivery — one switch controls both',
    toggleAria: 'Change {{channel}} for {{store}}',
    notApplied: 'Shopee accepted the change but did not apply it.',
    enabledToast: 'Courier enabled — verified with Shopee',
    disabledToast: 'Courier disabled — verified with Shopee',
    collateralToast: 'Applied, but {{count}} other courier(s) changed too',
    toggleError: 'Failed to change this courier.',
    divergent: {
      title: '{{count}} courier(s) differ between your stores',
      description: "Seller Centre only shows one store at a time, so drift like this normally goes unnoticed. Check whether each of these is deliberate.",
      onOff: 'on for {{on}} · off for {{off}}',
    },
    result: {
      ok: '{{channel}} is now {{state}} for {{store}}.',
      collateral: '{{channel}} changed for {{store}} — but so did other couriers.',
      unapplied: 'Shopee did not apply the change to {{channel}} for {{store}}.',
      unappliedHint: 'It is still {{actual}}. This usually means its shipping-option group is off in Seller Centre.',
      error: 'Could not change {{channel}} for {{store}}.',
      unverified: 'The change could not be verified.',
      alsoChanged: 'Also changed, as a side effect:',
    },
    confirm: {
      titleEnable: 'Enable {{channel}} for {{store}}?',
      titleDisable: 'Disable {{channel}} for {{store}}?',
      enableBody: 'Buyers at this store will be able to choose this courier at checkout.',
      disableBody: 'This takes effect on your live store immediately.',
      liveWarning: 'Buyers choosing this courier right now will lose it. Orders already placed are unaffected.',
      relationWarning: 'Shopee links this channel to others. A change here can switch other couriers too — the exact effect is not predictable in advance.',
      parentOffWarning: 'Its group "{{group}}" is currently off for this store, so Shopee may ignore this change.',
      verifyNote: "We'll re-read this store's channels from Shopee afterwards and show you what actually changed.",
      cancel: 'Cancel',
      confirmEnable: 'Enable',
      confirmDisable: 'Disable',
      applying: 'Applying...',
    },
    footnote:
      'Shipping-option groups (Doorstep Delivery, Bulky Delivery, Sea Shipping, Economy Delivery) are read-only here. Shopee links them to their couriers with rules that contradict each other, so turning a group off can take couriers down with it and turning it back on may not restore them. Change those in Seller Centre. Pickup vs drop-off is not set per courier — it follows your shop pickup address in Seller Centre.',
  },
}
