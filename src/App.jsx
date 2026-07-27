import { Navigate, Route, Routes } from 'react-router-dom'
import ErrorBoundary from '@/components/ErrorBoundary'
import AppShell from '@/components/layout/AppShell'
import Login from '@/pages/Login'
import Dashboard from '@/pages/Dashboard'
import Orders from '@/pages/Orders'
import BulkPrint from '@/pages/BulkPrint'
import Products from '@/pages/Products'
import Boost from '@/pages/Boost'
import FlashDeals from '@/pages/FlashDeals'
import Inventory from '@/pages/Inventory'
import Analytics from '@/pages/Analytics'
import Sales from '@/pages/Sales'
import Settings from '@/pages/Settings'
import Scan from '@/pages/Scan'

function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<Login />} />
        <Route
          path="/dashboard"
          element={
            <AppShell>
              <Dashboard />
            </AppShell>
          }
        />
        <Route
          path="/sales"
          element={
            <AppShell>
              <Sales />
            </AppShell>
          }
        />
        <Route
          path="/orders"
          element={
            <AppShell>
              <Orders />
            </AppShell>
          }
        />
        <Route
          path="/bulk-print"
          element={
            <AppShell>
              <BulkPrint />
            </AppShell>
          }
        />
        <Route
          path="/products"
          element={
            <AppShell>
              <Products />
            </AppShell>
          }
        />
        <Route
          path="/boost"
          element={
            <AppShell>
              <Boost />
            </AppShell>
          }
        />
        <Route
          path="/flash-deals"
          element={
            <AppShell>
              <FlashDeals />
            </AppShell>
          }
        />
        <Route
          path="/inventory"
          element={
            <AppShell>
              <Inventory />
            </AppShell>
          }
        />
        <Route
          path="/analytics"
          element={
            <AppShell>
              <Analytics />
            </AppShell>
          }
        />
        <Route
          path="/settings"
          element={
            <AppShell>
              <Settings />
            </AppShell>
          }
        />
        <Route
          path="/scan"
          element={
            <AppShell>
              <Scan />
            </AppShell>
          }
        />
      </Routes>
    </ErrorBoundary>
  )
}

export default App
