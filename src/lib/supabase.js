import { createClient } from '@supabase/supabase-js'
import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { App } from '@capacitor/app'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

const isNative = Capacitor.isNativePlatform()
const REMEMBER_KEY = 'mystorehub-remember-me'

// Native WebView localStorage isn't reliably durable across app cold starts
// the way browser localStorage is — @capacitor/preferences (backed by
// SharedPreferences/UserDefaults) is. Web keeps plain localStorage so
// browser/PWA behaviour is untouched.
async function durableGet(key) {
  if (isNative) return (await Preferences.get({ key })).value
  return localStorage.getItem(key)
}
async function durableSet(key, value) {
  if (isNative) return Preferences.set({ key, value })
  localStorage.setItem(key, value)
}
async function durableRemove(key) {
  if (isNative) return Preferences.remove({ key })
  localStorage.removeItem(key)
}

// "Remember me" unchecked = session lives only in memory, so it's gone the
// moment the app process is killed (native cold start) or the tab closes
// (web). Checked = session goes to durable storage and survives restarts.
let memoryStore = {}

export async function setRememberMe(remember) {
  await durableSet(REMEMBER_KEY, String(remember))
}

async function getRememberMe() {
  return (await durableGet(REMEMBER_KEY)) === 'true'
}

const hybridStorage = {
  async getItem(key) {
    if (await getRememberMe()) return durableGet(key)
    return memoryStore[key] ?? null
  },
  async setItem(key, value) {
    if (await getRememberMe()) {
      await durableSet(key, value)
      delete memoryStore[key]
    } else {
      memoryStore[key] = value
    }
  },
  async removeItem(key) {
    delete memoryStore[key]
    await durableRemove(key)
  },
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storage: hybridStorage,
  },
})

// autoRefreshToken relies on a setInterval timer that Android suspends while
// the app is backgrounded, so a long background period can leave the token
// stale until something explicitly refreshes it. Supabase's own guidance for
// mobile WebViews is to drive refresh off foreground/background transitions
// instead of trusting the timer alone.
if (isNative) {
  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
      supabase.auth.startAutoRefresh()
    } else {
      supabase.auth.stopAutoRefresh()
    }
  })
}
