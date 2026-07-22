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
    },
    orders: {
      title: 'Orders',
      autoSyncLabel: 'Auto-sync orders (60s)',
      autoSyncDescription: "Keeps the Orders page fresh while it's open. Pauses when the tab is hidden.",
      autoSyncAria: 'Toggle auto-sync orders',
    },
    account: {
      title: 'Account',
      loggedInAs: 'Logged in as',
      logout: 'Logout',
    },
  },
}
