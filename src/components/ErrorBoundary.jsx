import { Component } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

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

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#FAF9F6] px-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#2563EB]/10">
          <RefreshCw className="h-6 w-6 text-[#2563EB]" />
        </div>
        <div className="space-y-1">
          <p className="text-base font-semibold text-[#1F2937]">Something went wrong</p>
          <p className="text-sm text-[#6B7280]">
            Reload the page — your data is safe, this was just a display error.
          </p>
        </div>
        <Button
          onClick={() => window.location.reload()}
          className="h-11 rounded-xl bg-[#2563EB] px-6 text-white hover:bg-[#2563EB]/90"
        >
          Reload
        </Button>
      </div>
    )
  }
}
