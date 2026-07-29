// Simplified Chinese strings. Keep in exact key-shape parity with en.js —
// the i18n context falls back to en.js per-key if a key is ever missing
// here, but that fallback should never actually be exercised.
export default {
  nav: {
    dashboard: '首页',
    orders: '订单',
    // "Boost" is this app's name for the Shopee product-boost/slot feature —
    // flagged in the rollout report as needing confirmation against
    // Shopee's own official zh-CN term rather than treated as settled.
    boost: '推广',
    products: '商品',
    more: '更多',
  },
  login: {
    subtitle: '卖家管理后台',
    emailLabel: '邮箱',
    passwordLabel: '密码',
    showPasswordAria: '显示密码',
    hidePasswordAria: '隐藏密码',
    rememberMe: '记住我',
    forgotPassword: '忘记密码？',
    signIn: '登录',
    signingIn: '登录中…',
    noAccount: '还没有账号？',
    register: '注册',
    validationError: '请输入邮箱和密码。',
    genericError: '邮箱或密码错误。',
  },
  dashboard: {
    greeting: '早上好 👋',
    allStores: '全部店铺',
    scanCard: {
      title: '扫码查单',
      description: '扫描运单条码，封箱前再次核对内容',
    },
    stats: {
      ordersToday: '今日订单',
      revenue: '营业额',
      lowStock: '库存不足',
    },
    platforms: {
      title: '平台',
      connected: '已连接',
      notConnected: '未连接',
      orderCount_one: '{{count}} 个订单',
      orderCount_other: '{{count}} 个订单',
    },
    recentOrders: {
      title: '最近订单',
      viewAll: '查看全部 →',
      empty: '暂无订单。',
      unknownBuyer: '未知买家',
    },
    quickActions: {
      title: '快捷操作',
      printAwb: '打印 AWB',
      // PROVISIONAL — see the matching comment in en.js.
      newOrders: '新订单',
      boostNow: '立即推广',
      // Shopee's own zh-CN term for shop flash sales is 限时秒杀; same
      // confirm-against-Shopee caveat as `nav.boost` above applies.
      flashDeals: '限时秒杀',
    },
    // PROVISIONAL — see the matching comment in en.js. Do not treat these as
    // final; revisit for consistency once Orders.jsx's status vocabulary is
    // settled.
    status: {
      new: '新',
      toPack: '待打包',
      packed: '已打包',
      shipped: '已发货',
      completed: '已完成',
      cancelled: '已取消',
    },
  },
  settings: {
    title: '设置',
    language: {
      title: '语言',
      en: 'English',
      zh: '中文',
    },
    connectedStores: {
      title: '已连接店铺',
      empty: '尚未连接任何店铺',
      connected: '已连接',
      shopId: '店铺 ID：{{id}}',
      lastSynced: '上次同步：{{date}}',
      editNameSaveAria: '保存店铺名称',
      editNameCancelAria: '取消编辑店铺名称',
      editNameEditAria: '编辑店铺名称',
      autoPack: {
        title: '自动打包新订单',
        description: '付款满15分钟后自动安排发货',
        toggleAria: '切换 {{name}} 的自动打包',
        enabledToast: '已为该店铺启用自动打包',
        disabledToast: '已为该店铺关闭自动打包',
        errorToast: '更新自动打包设置失败。',
      },
      sync: {
        ordersButton: '同步订单',
        productsButton: '同步商品',
        syncing: '同步中…',
        loginRequired: '请先登录后再同步。',
        ordersSuccess: '已同步 {{count}} 个订单！',
        ordersError: '同步订单失败。',
        productsSuccess: '已同步 {{count}} 个商品！',
        productsError: '同步商品失败。',
      },
      nameUpdatedToast: '店铺名称已更新',
      nameErrorToast: '更新店铺名称失败。',
    },
    connectStore: {
      title: '连接店铺',
      comingSoon: '即将推出',
      connect: '连接',
      connectedToast: 'Shopee 店铺已连接！',
      startErrorToast: '启动 Shopee 连接失败。',
    },
    orders: {
      title: '订单',
      autoSyncLabel: '自动同步订单（60秒）',
      autoSyncDescription: '订单页面保持打开时自动刷新，标签页隐藏时暂停。',
      autoSyncAria: '切换自动同步订单',
    },
    push: {
      title: '通知',
      label: '推送通知',
      description: '有新订单或买家申请取消时提醒此设备——即使应用已关闭。',
      toggleAria: '切换推送通知',
      enabledToast: '已在此设备启用推送通知',
      disabledToast: '已在此设备关闭推送通知',
      deniedToast: '通知已被拦截。请在浏览器设置中允许后重试。',
      errorToast: '更新推送通知失败。',
      unsupported: '此浏览器不支持推送通知。',
      iosHint: '在 iPhone 上，请先将 MyStore Hub 添加到主屏幕（分享 → 添加到主屏幕），再从图标打开以启用通知。需要 iOS 16.4 或更高版本。',
    },
    account: {
      title: '账户',
      loggedInAs: '登录账号',
      logout: '退出登录',
    },
  },
  sales: {
    title: '销售',
    subtitle: '近 30 天每日营业额',
    allStores: '全部店铺',
    open: '查看销售报表',
    yesterday: '昨日',
    totals: {
      revenue: '30 天营业额',
      orders: '30 天订单数',
      avgPerDay: '日均',
    },
    chart: {
      title: '每日营业额',
      noSales: '此期间没有销售。',
    },
    table: {
      title: '每日明细',
      date: '日期',
      revenue: '营业额',
      orders: '订单数',
      noData: '暂无数据。',
      beforeHistory: '早于已同步记录',
    },
    coverage: {
      partial:
        '订单记录自 {{date}} 开始。此区间内更早的 {{days}} 天不在已同步的数据范围内 —— 并非当天没有销售。',
      none: '尚未同步任何订单，暂时无法生成报表。',
    },
    basis:
      '统计处理中、已发货、待收货、已完成及重新发货的订单，不含未付款、已取消及退货订单。每日以马来西亚时间 00:00–24:00 计算。',
    error: '无法加载销售报表，数据库函数可能尚未安装。',
  },
}
