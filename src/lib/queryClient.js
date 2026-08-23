import { QueryClient } from '@tanstack/react-query'

// Cache-then-refresh, trialled on Orders first (see Orders.jsx): a page shows
// whatever is already cached the instant it mounts — no spinner — and
// revalidates in the background. staleTime: 0 means every mount treats
// cached data as due for a silent refetch; gcTime keeps that cache alive
// well past a route change so navigating back still has something instant to
// show instead of an empty state.
//
// refetchOnWindowFocus is off on purpose: this app drives its own
// foreground-refresh listener (src/lib/foregroundRefresh.js) which only
// refetches after being backgrounded past a minimum threshold. React
// Query's default refetch-on-every-focus would double up with that
// listener and fire far more eagerly than the 30s threshold intends —
// see the AWB "Open with" chooser / notification-shade case that listener
// exists to filter out.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: 30 * 60 * 1000,
      refetchOnMount: true,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: 1,
    },
  },
})
