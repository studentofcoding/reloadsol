# Buy / Sell / Swap Page Split – Execution Plan

_Last updated: 2025-07-02_

---

## Goals
1. Provide dedicated, shareable URLs for each major action:
   * `/buy` – bulk buy up to 10 tokens.
   * `/sell` – bulk sell / close accounts.
   * `/swap` – individual token swap (optional `[mint]` param).
2. Preserve the current "no-reload" feel: wallet connection, React-Query cache, and subscriptions remain mounted while navigating.
3. Minimise layout shift and perceived latency.
4. Allow pre-filling the **Buy** form via query parameters (`sol`, `mints`) for easy sharing.

---

## 1. Routing Structure
```text
/app
└─ (trade)                 # route-group with shared layout
   ├─ layout.tsx           # mounts providers + nav tabs
   ├─ buy
   │  └─ page.tsx         # <BulkTokenBuyer />
   ├─ sell
   │  └─ page.tsx         # <BulkTokenSeller />
   └─ swap
      ├─ [mint]
      │  └─ page.tsx      # <SingleSwap mint={mint} />
      └─ page.tsx         # generic swap form
```
*The existing root `page.tsx` will be converted to a simple redirect (see §6).*  
*If we decide to persist inactive pages in memory, we can add parallel routes (`@buyer`, `@seller`) under the same group later.*

---

## 2. Shared Layout Highlights (`app/(trade)/layout.tsx`)
* Wraps children with `WalletProvider`, `TradingDataProvider`, and any global context.
* Houses header, footer, and navigation tabs (`next/link` – prefetch enabled).
* Reserves fixed widths / `min-h` placeholders around charts & token lists to avoid cumulative layout shift.

---

## 3. Navigation Tabs (example JSX)
```tsx
<Link href="/sell" className={cls(active,'sell')}>Reload SOL</Link>
<Link href="/buy"  className={cls(active,'buy')}>Buy Tokens</Link>
<Link href="/swap" className={cls(active,'swap')}>Swap</Link>
```
Hover triggers automatic prefetch; we can manually call `router.prefetch()` for stronger control.

---

## 4. State & Performance
* React-Query provider lives **above** route boundaries, so cache survives page switches.
* Wallet connection remains intact.
* Optionally keep old page mounted via parallel routes to preserve component-local state (e.g. typed token list in Buyer).
* Heavy data (user-tokens list) can be prefetched in background when user hovers a nav tab.

---

## 5. Prefilled **Buy** Links
*Query parameters*
* `sol`   – decimal string (`0.2`).
* `mints` – comma-separated list of up to 10 base-58 mint addresses.

**Implementation – inside `BulkTokenBuyer`:**
```tsx
'use client'
...
import { useSearchParams } from 'next/navigation'

export default function BulkTokenBuyer() {
  const searchParams = useSearchParams()
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    if (initialized) return

    const sol   = searchParams.get('sol')
    const mints = searchParams.get('mints')

    if (sol && !Number.isNaN(+sol) && +sol > 0) setSolAmount(sol)

    if (mints) {
      const tokenStr = mints
        .split(',')
        .slice(0, 10)              // enforce limit
        .filter(Boolean)
        .join('\n')
      setTokenMints(tokenStr)
    }

    setInitialized(true)
  }, [initialized, searchParams])
  ...
}
```
*This reads the params once; the URL is not mutated when the user edits the form.*  
*(Future enhancement: add a "Copy link" button to serialise current form back to URL.)*

---

## 6. Redirect
`app/page.tsx` will simply:
```tsx
import { redirect } from 'next/navigation'
export default function Root() {
  redirect('/sell')
}
```
This keeps existing external links functional while pushing users to the new structure.

---

## 7. Testing Checklist
1. Navigate Buy → Sell → Buy: wallet remains connected, no full reload.
2. Confirm `react-query` cache retains **user token list** (spy network – should not refetch if within TTL).
3. Page switch < 150 ms on throttled 3G.
4. CLS < 0.1 on Web-Vitals.
5. Prefilled URL `/buy?sol=0.3&mints=A,B` populates the form correctly.
6. SEO: each page provides unique title & OpenGraph description.

---

## 8. Roll-out Steps
1. ✅ **Code:** implement new routes, shared layout, query-param parsing.
   - ✅ Created `(trade)` route group with shared layout
   - ✅ Implemented `/buy`, `/sell`, `/swap` pages
   - ✅ Added query parameter support to BulkTokenBuyer (`sol`, `mints`)
   - ✅ Updated root page to landing page with call-to-action
   - ✅ Fixed metadata exports and build issues
2. **QA:** run testing checklist locally & on preview deploy.
3. **Docs:** update README, in-app tool-tips, and marketing materials with new shareable links.
4. **Deploy** to production.
5. **Monitor**: track Web-Vitals, error logs, and React-Query cache misses.

---

Happy shipping! 🚀 