import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // public/manifest.json is the source of truth and index.html links to it
      // directly, so the plugin must not emit a competing manifest.
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webp,woff,woff2}'],
        // Pulls our hand-written push/notificationclick handlers into the
        // generated service worker. public/push-sw.js is copied to the site
        // root as-is, so importScripts loads it at '/push-sw.js'. Keep it out
        // of the precache globs (it's imported, not fetched) — that's fine
        // because .js is precached above; excluding it isn't necessary since
        // importScripts re-fetches it on SW install regardless.
        importScripts: ['/push-sw.js'],
        navigateFallback: '/index.html',
        // Never serve the app shell in place of a real API response.
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
