import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.jsx'
import { Toaster } from '@/components/ui/sonner'
import { I18nProvider } from '@/lib/i18n/I18nProvider'
import { queryClient } from '@/lib/queryClient'

// Light theme is the default; ensure any previously-set dark class is removed.
document.documentElement.classList.remove('dark')

// Above the router so the query cache survives route changes — a page that
// remounts on navigation still finds its data already cached instead of
// starting from empty (see queryClient.js for the cache-then-refresh config).
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <BrowserRouter>
          <App />
          <Toaster />
        </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
)
