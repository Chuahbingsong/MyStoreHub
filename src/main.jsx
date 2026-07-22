import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { Toaster } from '@/components/ui/sonner'
import { I18nProvider } from '@/lib/i18n/I18nProvider'

// Light theme is the default; ensure any previously-set dark class is removed.
document.documentElement.classList.remove('dark')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <App />
        <Toaster />
      </BrowserRouter>
    </I18nProvider>
  </StrictMode>,
)
