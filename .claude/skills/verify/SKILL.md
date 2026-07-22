---
name: verify
description: Run MyStore Hub in a real browser and drive a page end-to-end to verify a change. Use when verifying UI changes to src/pages/*.
---

# Verifying MyStore Hub

React 19 + Vite SPA, Supabase backend, Vercel serverless functions under `api/`.

## Key facts

- **Routes are unguarded.** `src/App.jsx` renders `/orders`, `/dashboard`, etc.
  without an auth check, so you can navigate straight to a page. No login needed.
- **Pages read Supabase directly** from the browser (`src/lib/supabase.js`),
  so stubbing `**/rest/v1/<table>**` in Playwright gives you full control of the data.
- **`api/*` does not run under `vite dev`** (they're Vercel functions). Stub them.

## Never touch production data

Start the dev server with a fake Supabase host so real credentials are never
loaded and no request can reach the live database:

```bash
VITE_SUPABASE_URL=http://localhost:9999 VITE_SUPABASE_ANON_KEY=fake \
  npx vite --port 5199 --strictPort
```

Reading `.env.local` to query the live Supabase is blocked by the sandbox
(production read) — don't try, stub instead.

## Faking a logged-in session

`supabase.auth.getSession()` reads localStorage; seed it before load and no
network call happens. The key is `sb-<hostname first label>-auth-token`, so with
the fake host above it is `sb-localhost-auth-token`:

```js
await context.addInitScript(() => {
  localStorage.setItem('sb-localhost-auth-token', JSON.stringify({
    access_token: 'fake', refresh_token: 'r', token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'u1', email: 't@e.com', aud: 'authenticated', role: 'authenticated' },
  }))
})
```

Without this, handlers bail out early with "You must be logged in".

## Driving

Playwright isn't a project dep — install it in the scratchpad
(`npm i playwright && npx playwright install chromium`). Use
`viewport: {width: 420, height: 900}` (phone-sized; this is a mobile-first app)
and `acceptDownloads: true` if the flow downloads a file — `page.on('download')`
fires for `<a download>` blob URLs.

Stub the table read and any `api/` route:

```js
await page.route('**/rest/v1/orders**', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ORDERS) }))
```

Rows must be in raw Supabase column shape (`order_status: 'READY_TO_SHIP'`,
`awb_printed`, nested `order_items`) — `mapSupabaseOrder` transforms them.

## Gotchas

- **Tabs vs statuses**: the "In Process" tab (key `inprocess`) holds both
  `To Pack` and `Packed` orders. There is no tab literally named "To Pack".
- `/api/shopee/print-awb` returns an inline `application/pdf` for a single order
  but base64 JSON for multiple — stub both branches or you'll miss one.
- Sonner toasts are readable via `page.locator('[data-sonner-toast]')`.
- Lint runs the React Compiler: a `useMemo` whose value is closed over by a
  hoisted `function` declaration triggers "Existing memoization could not be
  preserved", which skips optimizing the whole component. Prefer plain derived
  consts (the file already does this for `filteredOrders`).
