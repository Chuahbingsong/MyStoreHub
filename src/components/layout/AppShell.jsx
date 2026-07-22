import BottomNav from './BottomNav'

export default function AppShell({ children, orderCount }) {
  return (
    <div className="pt-safe flex h-screen flex-col bg-[#FAF9F6]">
      <main className="pb-nav-safe flex-1 overflow-y-auto">{children}</main>
      <BottomNav orderCount={orderCount} />
    </div>
  )
}
