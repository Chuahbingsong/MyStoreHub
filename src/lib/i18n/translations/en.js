// English strings — the default locale. Keys are namespaced per page so the
// per-page rollout (Settings first, others later) stays easy to track: each
// page owns one top-level key.
export default {
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
    // PROVISIONAL — reused between the "To Pack" stat card and the recent-
    // orders status badges. This is Shopee order-status vocabulary; final
    // wording is being settled separately before Orders.jsx is converted.
    // `new` in particular maps from Shopee's raw UNPAID status (see
    // SHOPEE_STATUS_KEY in Dashboard.jsx) — note this already reads
    // differently from Orders.jsx, which gives UNPAID its own dedicated
    // "Unpaid" tab distinct from "New Orders". That inconsistency predates
    // this translation pass; flagging it here rather than quietly picking a
    // wording that papers over it.
    status: {
      new: 'New',
      toPack: 'To Pack',
      packed: 'Packed',
      shipped: 'Shipped',
      completed: 'Completed',
      cancelled: 'Cancelled',
    },
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
