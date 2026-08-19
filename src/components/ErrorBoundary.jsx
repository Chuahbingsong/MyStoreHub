import { Component } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getLocale } from '@/lib/preferences'

// Strings held locally and read from the persisted locale rather than pulled
// from the i18n context, unlike every other component in the app.
//
// This is the screen that renders when something in the tree has ALREADY
// thrown. Depending on the i18n provider here would mean the crash screen
// shares a failure mode with the thing it exists to survive — a broken
// dictionary or provider would leave the user with a blank page instead of a
// Reload button. localStorage is the one dependency that cannot itself have
// thrown by this point. Same local-table shape as SHORT_AGO in
// src/lib/i18n/datetime.js.
const STRINGS = {
  en: {
    title: 'Something went wrong',
    body: 'Reload the page — your data is safe, this was just a display error.',
    reload: 'Reload',
  },
  'zh-CN': {
    title: '出了点问题',
    body: '请重新加载页面 —— 你的数据是安全的，这只是显示错误。',
    reload: '重新加载',
  },
}

// Last-resort catch-all: React error boundaries only catch render/lifecycle
// throws in the tree below them (not event handlers, async code, or effect
// cleanup — e.g. the scan page's own teardownOnUnmount already swallows its
// own throws for that reason). Without this, an escaped throw anywhere in
// the app unmounts the whole React tree with nothing left on screen.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] uncaught error in render tree', error, errorInfo)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    // Read at render, not in the constructor: the boundary is mounted for the
    // whole session, so a language switch before the crash must still be
    // reflected. Falls back to English for an unreadable/unknown value.
    let strings = STRINGS.en
    try {
      strings = STRINGS[getLocale()] ?? STRINGS.en
    } catch {
      // localStorage can throw in a locked-down webview; English is fine here.
    }

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#FAF9F6] px-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#2563EB]/10">
          <RefreshCw className="h-6 w-6 text-[#2563EB]" />
        </div>
        <div className="space-y-1">
          <p className="text-base font-semibold text-[#1F2937]">{strings.title}</p>
          <p className="text-sm text-[#6B7280]">{strings.body}</p>
        </div>
        <Button
          onClick={() => window.location.reload()}
          className="h-11 rounded-xl bg-[#2563EB] px-6 text-white hover:bg-[#2563EB]/90"
        >
          {strings.reload}
        </Button>
      </div>
    )
  }
}
