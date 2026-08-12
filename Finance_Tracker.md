# PROJECT_CONTEXT.md — Ganesh's Net Worth & Allocation Tracker

Last updated: reflects state as of this conversation (through frozen columns + Debt overwrite import/Google Sheet import/maturity highlighting — see §10). Read this before making further changes — it captures decisions, known issues, and exact config values that aren't obvious from the code alone.

---

## 1. What this is

A single-page personal finance tracker — HTML/CSS/JS, no build step, two files: `index.html` and `app.js`. Tracks Cash, Debt/Fixed Income, Equity Mutual Funds, Equity Stocks, and Gold (ETF-only) with a Dashboard showing net worth, current vs. ideal allocation, and a pie chart. Owner: Ganesh, based in Chennai. Intended hosting: GitHub Pages, used from both a PC and a phone.

**Current canonical files:** `/mnt/user-data/outputs/finance-tracker/index.html` and `app.js` (always ship both together after any change — check whether a change touched one or both before telling the user which to replace).

**Cache-busting:** `index.html` loads `app.js?v=2026-08-08-4` (a version query string, not a real query param the file uses; bumped once per redeploy this session, currently at `-4`). GitHub Pages doesn't set cache-control headers, so browsers can serve a stale cached `app.js` after a redeploy even though the file on disk is current — bump this version string on every future redeploy so Ganesh's browser (PC or phone) is guaranteed to fetch the new file rather than an old cached copy. **Important distinction learned this session:** this only matters for GitHub Pages — a local file opened directly in a browser is never cached, so if a bug reproduces on a local file, look for a stale/outdated local copy of the code, not caching.

---

## 2. Tech stack / libraries (all via CDN, no npm build)

- Chart.js 4.4.1 + chartjs-plugin-datalabels 2.2.0 (pie chart, permanent on-slice % labels)
- SheetJS (xlsx) 0.18.5 (`xlsx.full.min.js`) — used for both Import from Excel (per-tab) and Export/Restore to Excel (full backup)
- Firebase compat SDK 10.14.1 (app, auth, firestore) — cloud sync
- Fonts: Space Grotesk (display/headers), Inter (body), JetBrains Mono (numeric table data)
- Design language: dark navy background (#0c1220), gold accent (#c9a44c), teal=positive/red=negative for P&L

---

## 3. Data model

`state` object, persisted to `localStorage` under key `ledger_data_v1`:
```
{ cash, ideal: {cash,debt,mf,equity,gold}, equity: [...], debt: [...], mf: [...], gold: [...], lastSaved, lastBackup, portfolioLocked }
```
Each row has a generated `id` (via `uid()`). Row shapes:
- **equity**: id, name, invested, units, ltp
- **debt**: id, name, category, subcategory, account, invested, roi, maturityAmount, investedDate, maturityDate, tenureMonths, notes
- **mf**: id, name, symbol, category, subcategory, unitPrice, units, remarks
- **gold**: id, name, form (Physical/Digital/SGB/ETF — new rows default to ETF since Ganesh only holds Gold ETFs), weight, purchaseRate, invested, currentRate, notes

All P&L/current-value/tenure-years fields are **always computed**, never stored (`equityDerived()`, `debtDerived()`, `mfDerived()`, `goldDerived()`).

**Important calculation note:** Equity tab's Alloc % is based on **invested amount**, not current market value (changed per explicit request) — `row.invested / totalInvested * 100`.

---

## 4. Live prices — Google Sheet + Apps Script Web App (JSON API)

**History (don't reintroduce this — it was replaced for a reason):** originally used 3 separate "Publish to web → CSV" links. That approach hit a real, confirmed CORS limitation (Google's publish-CSV endpoint doesn't reliably send `Access-Control-Allow-Origin`) — fetches failed with a browser-level network error, not a data problem. **Do not go back to CSV-publish links.**

**Current mechanism:** Ganesh's Google Sheet has 3 tabs — `Stocks`, `Mutual Funds`, `ETF` (exact names, case-sensitive, used by `doGet()`). An Apps Script Web App deployment (`doGet()`) reads all 3 tabs and returns one JSON payload:
```
{ stocks: [{ "Stock Name": ..., "Symbol": ..., "Live Price": ... }], mf: [...], gold: [...] }
```
Kept fresh by a 15-minute time-driven Apps Script trigger (forces `GOOGLEFINANCE()` recalculation; also does the actual NAV fetch for Mutual Funds since `GOOGLEFINANCE` doesn't support Indian MF NAV at all).

**Current endpoint (`PRICE_API_URL` in app.js):**
```
https://script.google.com/macros/s/AKfycbxT5Mgu9hhXdIA6kbfRfT_RhyWJNb6UYbbWBjte0jWh-9Zk4QmyiTLNJveQYLeUoTNBHw/exec
```

**Matching logic (`buildPriceMap` in app.js):** flexible on purpose — indexes a price under *every* identifier column found per row (both "Stock Name" like `WIPRO` and "Symbol" like `NSE:WIPRO`), so the user can type either into the app's Name/Symbol field and it'll match. Verified working via a mocked JSON server matching the real sheet's exact shape.

**Gold:** Ganesh holds Gold ETFs only (e.g. GOLDBEES.NS) — these trade like stocks, so they reuse the exact same live-price mechanism as Equity, just against the `gold` array in the payload. No separate "spot gold" handling needed or wanted.

**Mutual Funds now have Category / Sub-category / Symbol on the live-price Google Sheet** (Ganesh added these columns to the `Mutual Funds` tab himself). The app's MF NAV refresh (`refreshMFPrices`) keys off the app's own `row.symbol` field, so a fund needs its `symbol` field populated in the app to ever pick up live NAV — see §5 for how that got backfilled from a one-off snapshot of the sheet, and the matching bug that was fixed to make it possible.

---

## 5. Excel import/export

**Per-tab Import from Excel** (Stocks, MF, Gold, Debt) — first row = header (skipped), **upsert** behavior for Stocks/MF/Gold (matches existing row by Name for Stocks/Gold, by Symbol-then-Name for MF; adds a new row if no match). **Debt import stays append-only** — deliberately not upserted, since FD names aren't a reliable unique key (two different FDs can share a bank name) and matching by name risked silently merging distinct entries.

**⚠️ Blank-cell-safe as of this session — read before touching these handlers again:**
- **The bug:** the Stocks/MF/Gold importers used to write `parseFloat(cell) || 0` for every numeric column unconditionally, so a sheet that only fills in *some* columns (e.g. just Category/Sub-category/Symbol for MF) would silently zero out real Units/Invested/Weight on the matched existing row. Never actually hit in production, but the exact workflow Ganesh needed this session (see below) would have hit it immediately.
- **The fix:** a blank cell (empty/undefined after `String(v).trim()` — see `cellIsBlank()`) is now **omitted from the update entirely** rather than coerced to 0, for Invested/Units/Weight/Purchase Rate/Category/Sub-category/Remarks/Notes across all three importers. A non-blank cell still overwrites normally. New rows (no existing match) are unaffected — omitted fields just default to `undefined`, which renders identically to `""`/`0` everywhere in the app. `ltp`/`unitPrice`/`currentRate` were never part of this (never reset on update, as before).
- **MF matching bug, also fixed:** the MF importer matched an existing row by Symbol *only* when the imported row had a Symbol — so a fund that existed in the app but didn't have a Symbol assigned yet (exactly the "assign Symbol for the first time" case) could never match on Symbol, and got pushed as a duplicate new row instead of updating the real one. Fixed: if the imported row has a Symbol but the existing row's `symbol` is still blank, fall back to matching by Name. Verified with a seeded pre-existing row (Puppeteer) — confirms it updates in place instead of duplicating.

**Export to Excel** (`btnExportExcel`) — one click, downloads a 6-sheet `.xlsx`: Dashboard Summary, Stock Holdings, Mutual Funds, Gold, Debt, Settings. Fully formatted (proper headers, column widths), built entirely client-side via SheetJS, near-zero performance cost since it only runs on click, not on every render.

**Restore from Excel** (`restoreExcelFile`) — reads all sheets from one backup workbook and **fully replaces** current state (unlike per-tab import, which appends/upserts). Confirms with the user first (destructive). Tested end-to-end: export → wipe localStorage → restore → diff, all fields matched including dates.

**JSON Export/Import** also still exists (top bar) — simpler, fully lossless, was the original backup mechanism before Excel export was added.

**Weekly auto-backup:** on page load, if it's Sunday or 7+ days since `state.lastBackup`, auto-triggers a JSON download (once per day max, guarded). Can't run while the app is closed — this was an explicit, disclosed limitation (static page, no server) — it only fires when the app happens to be opened.

**One-off deliverable, earlier session — `MF_Import_Category_Symbol.xlsx` / `MF_Import_Category_Symbol_v2.xlsx`:** built by cross-referencing Ganesh's `Stocks Live price.xlsx` (MF Name/Symbol/Category/Sub-category, one row per fund on the `Mutual Funds` sheet) against a Zerodha Console Holdings export (for real Units per fund by matching fund name), later regenerated from an updated `Stocks Live price.xlsx` alone (Units left blank throughout). Columns match the app's expected MF import layout — Name, Symbol, Category, Sub-category, Units, Remarks — with a Remarks note on the one fund (`HDFC NIFTY 50 INDEX FUND - DIRECT PLAN`) that still has no Symbol in the live-price sheet, so its NAV won't fetch until Ganesh adds one there. **Superseded going forward by §5b's automatic Category/Symbol/Sub-category enrichment during Zerodha import** — this manual file is no longer the normal path, just a historical one-off.

---

## 5b. Import Zerodha Holdings — now per-tab (was a single topbar button)

**Before this session:** one "Import Zerodha Holdings" button in the topbar, reading one workbook and updating Equity + Mutual Funds + Gold all at once from its three sheets in a single combined preview/confirm.

**Changed this session, per explicit request:** replaced with **three separate buttons**, one in each of the Equity, Mutual Funds, and Gold tab toolbars (next to that tab's own "Import from Excel" button). Each button:
- Reads the **same** uploaded workbook (Zerodha Console's Holdings export, sheets named exactly `Stocks`, `Mutual funds`, `Gold` — see `ZERODHA_SHEETS`) — Ganesh doesn't need three different files, just the one export.
- Only reads **its own sheet** and only touches **its own asset class's data** in `state` — importing on the Equity tab cannot add/update anything in Mutual Funds or Gold, and vice versa. Verified with Puppeteer using the real `Import_sheet.xlsx`: importing via the Equity button left `state.mf` and `state.gold` at their pre-import length; same isolation confirmed for the MF and Gold buttons.
- Shows its own scoped preview modal (Will Update / New Entries / Duplicate Rows counts, named holdings) before applying — same "preview then confirm" pattern as before, just single-asset-class now instead of three sections in one modal.

Everything else about the mechanism is unchanged: two junk rows per real holding in Zerodha's export are dropped by requiring both Qty. and Buy avg. present and numeric (not by pattern-matching "ZZ" text); Equity and Gold match existing rows by Symbol-against-Name; Mutual Funds also match by Symbol-against-Name (Zerodha's MF "Symbol" column is actually the full scheme name, not a code — doesn't correspond to the app's own `symbol` field, which is reserved for the Google-Sheet live-NAV lookup in §4); only Quantity/Units and Average Price/Invested are overwritten on a match, nothing else; unmatched rows become new entries with `livePricePending: true` and surface in the post-import reminder modal.

Shared helpers (`parseIndianNumber`, `parseHoldingsSheetRows`, `planAssetClass`) are unchanged and still shared across all three buttons — only the per-asset apply/summary/wiring functions were split out (`applyEquityZerodhaPlan` / `applyMFZerodhaPlan` / `applyGoldZerodhaPlan`, `singleAssetPlanSummaryHTML`, `ZERODHA_TAB_CONFIG`, `setupZerodhaTabImport`).

**New this session — Mutual Funds Zerodha import now also auto-fills Symbol/Category/Sub-category:** previously that only happened via the manual `MF_Import_Category_Symbol.xlsx` route (§5). Now, when the MF "Import Zerodha Holdings" button is used:
- Before showing the preview modal, it calls the same `fetchPriceData()` used by the live-NAV refresh (§4) and builds a name → `{symbol, category, subcategory}` map from the live-price sheet's Mutual Funds tab (`buildMFCategoryMap()`), matching flexibly on the sheet's actual `Sub-cateogry` typo as well as the correct spelling.
- The preview modal shows an extra line: how many of the funds being imported (matched + new) were found on the live-price sheet, before Ganesh confirms.
- On confirm (`applyMFZerodhaPlan(plan, categoryMap)`), both matched (existing) and newly-added rows get Symbol/Category/Sub-category set from that map — but **only for fields the sheet actually has a value for** (`applyMFCategoryData()` — same blank-cell-safe rule as §5's Excel importers, so a blank column on the sheet never clobbers something already filled in). Funds not found on the sheet import fine otherwise (Units/Invested still set) and just keep those three fields as they were/blank.
- If the live-price sheet fetch itself fails (network/deployment issue), the import still proceeds for Units/Invested — Ganesh gets a clear message that only the auto-tagging step was skipped, not a blocked import.
- Tested via a Node-level logic harness (matched row, new row with a sheet match, new row with no sheet match, blank-cell-safe check, null-categoryMap fallback) plus a Puppeteer run through the real `fetchPriceData → buildMFCategoryMap → openModal → applyMFZerodhaPlan` path against a mocked `fetch`. Could not test the actual `.xlsx` file-picker end of this (SheetJS CDN unreachable from the sandbox — see §9), only the logic downstream of "file successfully parsed into rows".
- The manual `MF_Import_Category_Symbol.xlsx` route in §5 still works but is no longer the primary way to get Symbol/Category/Sub-category into the app — this is now automatic on every Zerodha MF import.

---

## 6. Table UX — sort, filter, resize

All four data tables (Equity, Debt, MF, Gold): click any column header to sort (toggles asc/desc with an arrow indicator); one filter/search box per tab matching across **all** columns in that tab (not per-column filters — deliberate simplification, stated explicitly to the user). Sorting/filtering only changes what's displayed — footer totals always reflect full unfiltered data.

**Column resize:** drag handles only on the 4 columns explicitly requested — Equity's Stock/Symbol, Debt's Name, MF's Name, Gold's Name/Symbol — via `<colgroup>`/`<col>` + a resizer handle, `table-layout: fixed`.

**⚠️ Fragile area — two real bugs already happened here, read before touching column widths again:**
1. First bug: `table-layout: fixed` + only 1 column with explicit width → other columns got squeezed to equal fractions regardless of content, cropping headers and date fields. Fixed by giving **every** column in every colgroup an explicit width.
2. Second bug: after fixing #1, tables no longer stretched to fill wide screens (left a visible empty gap) — fixed by keeping `width: 100%` on `.data-table` (proportional stretch across all explicitly-sized columns) plus a per-table `min-width` (via `#panel-X table.data-table{min-width:...}`) so narrow screens get horizontal scroll instead of squeezing.
3. Third bug (Debt tab specifically): date columns at 130px were still a few px too tight for `MM/DD/YYYY` + native calendar icon → widened to 155px, tightened date input's own padding as extra margin.

**If asked to adjust any column width again: change the specific `<col style="width:...">` value for that column, verify the table's `min-width` rule still ≥ the new column-width sum, and re-screenshot-test on both a wide (~1850px) and narrow (~900px) viewport before shipping** — this area has burned 3 rounds already from under-testing.

---

## 7. Cloud sync — Firebase Auth (Google Sign-In) + Firestore

Replaces an earlier abandoned "Connect Google Drive" placeholder button (never implemented, was just an explanatory alert). Real implementation now:

**Firebase project config** (`networth-tracker-f101b` — safe to be public, this is a client identifier, not a secret):
```js
{
  apiKey: "AIzaSyDhaP5WPnVHD5PXTg3O6wJeJOlG51NJ6xI",
  authDomain: "networth-tracker-f101b.firebaseapp.com",
  projectId: "networth-tracker-f101b",
  storageBucket: "networth-tracker-f101b.firebasestorage.app",
  messagingSenderId: "638244383857",
  appId: "1:638244383857:web:84431ad971b2fee7e47fd0"
}
```

**Architecture:** localStorage stays the instant local cache (nothing about normal app usage changed); Firestore doc at `portfolios/{uid}` mirrors it. `saveState()` triggers a debounced (2s) background push whenever signed in. On sign-in (including a Firebase-restored session on page load), `resolveCloudSync()` reconciles local vs. cloud.

**⚠️ Critical bug already found and fixed — do not reintroduce the old logic:** the original conflict resolution picked whichever side (local/cloud) had the newer timestamp, **fully automatically, no safeguard**. This silently wiped real local data whenever an empty/partial cloud document happened to have a newer timestamp than real local data (very plausible given sign-in was also flaky) — confirmed as the likely cause of a real data-loss report from the user, reproduced the exact scenario, and fixed it.

**Current (correct) conflict logic:**
- Empty cloud + non-empty local → push local (safe, automatic, no prompt)
- Empty local + non-empty cloud → pull cloud (safe, automatic, no prompt)
- Both empty → no-op
- Both non-empty and **content-identical** (ignoring `lastSaved`/`lastBackup`) → no-op, no prompt (avoids nagging on every normal page load)
- Both non-empty and **genuinely different** → `confirm()` dialog, user explicitly picks which side wins — **never silently overwrites either side when both have real, different data**

Helper functions: `isStateEmpty(s)`, `stateContentEqual(a,b)`.

**Setup steps only Ganesh can do (I cannot do these — no console access):**
1. Firestore security rules (Console → Firestore → Rules):
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /portfolios/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```
2. Authorized domains (Console → Authentication → Settings) — needs the GitHub Pages domain added (e.g. `username.github.io`); `localhost` is included by default.
3. Google sign-in provider must be enabled (Console → Authentication → Sign-in method).

**Testing limitation, important to remember:** this sandbox cannot reach Firebase's real servers (not on the allowed network list) or run a real OAuth popup. All cloud-sync testing so far has been done against a hand-built mock of the `firebase` global that mimics the compat SDK's shape — good enough to validate the *logic* (sign-in flow, debounce, conflict resolution in both safe and unsafe-without-the-fix scenarios) but **the real end-to-end sign-in/sync has never actually been verified working against real Firebase** — that verification can only happen on Ganesh's end.

---

## 8. OPEN / UNRESOLVED as of last message

1. **"Sign in with Google not working"** — root cause not yet confirmed. Asked Ganesh for exact behavior (popup opens and closes? alert with error text? nothing at all?) and whether the 3 setup steps above were actually completed. **No reply received yet — do not assume this is fixed.**
2. **"Export to Excel not working"** — plausible this was a downstream symptom of the data-wipe bug (exporting already-blanked state looks broken even though the export code itself works) — the wipe bug is now fixed, but this specific symptom hasn't been explicitly retested/confirmed resolved by Ganesh yet.
3. **"Locked/Unlocked toggle not working" — RESOLVED, root cause confirmed.** Turned out to be two separate things, found by asking for the exact symptom instead of guessing again:
   - **Not actually a caching issue.** Ganesh was testing against a **local file** on his computer, not the live GitHub Pages URL — browsers never cache local files, so the earlier cache-busting theory (§1) didn't apply here at all. His local `index.html`/`app.js` were simply an older copy that predated the lock fix. Re-shipped current files for him to replace locally; confirmed via a fresh headless-browser test that Invested/Units correctly go `disabled` on lock with the current code.
   - **Scope expanded per explicit follow-up request:** originally only Invested/Units (and Purchase Rate on Gold) were locked — Name, Symbol, Category, Sub-category, price fields (LTP/NAV/Current Rate), Remarks/Notes, and Gold's Form dropdown stayed editable by design. Ganesh asked for **all fields** to lock. Done — every input/select in Equity, Mutual Funds, and Gold's row template now carries `${locked ? "disabled" : ""}`; row Add/Remove buttons were deliberately left untouched (not asked for, and functionally different from a data field) — flag if that should lock too. Verified with Puppeteer: added one row to each of the three tables, confirmed all inputs/selects report `disabled:false` before lock, all `true` after lock, all `false` again after unlock. Debt tab was never in scope for locking (matches the original design — lock exists specifically to force changes through Zerodha import, which never touches Debt) and remains untouched.
   - Takeaway for next time a "reported bug can't be reproduced" situation comes up: **always ask whether they're testing the live URL or a local file** — it changes which explanation (caching vs. stale local copy) is even possible.
4. **Zerodha Console CSV/quantity sync — now implemented for the manual-download path** (see §5b): three per-tab "Import Zerodha Holdings" buttons read Ganesh's Console Holdings export directly, no API/OAuth integration needed. This resolves the "does Family Holdings offer a CSV/Excel export" question from a materially simpler angle than the originally-discussed Kite Connect API integration (token exchange, 3 separate account logins, ISIN matching, etc.) — that fuller API-based design is **no longer needed unless Ganesh specifically still wants automatic/scheduled sync** rather than the manual "download from Console, click Import" flow now in place.

---

## 9. Design/process conventions established in this project (follow these)

- **Never modify code without explicit go-ahead** when the user says "don't implement yet" / "plan first" — this has been requested multiple times (Zerodha planning, cloud storage planning) and should keep being honored by default for any new "add X" request that's nontrivial in scope.
- **Test before shipping, don't just assert correctness** — this project's history includes 3 separate rounds of "here's a screenshot showing your fix didn't work" on the column-width issue specifically because changes went out under-tested. Established practice now: headless Puppeteer test (Chrome binary at `/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome`, via the mermaid-cli-bundled puppeteer install at `/home/claude/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer`) for anything visual or logic-bearing, ideally with a screenshot compared against the actual bug report when one exists. **This session's Excel-import matching bug (§5) was only caught because the new MF import file was actually run through a seeded-state Puppeteer test before shipping** — testing against a fresh/empty state alone would have missed it, since the bug only manifests when an existing row is present to (fail to) match against.
- **Frozen/sticky table columns are simplest at position 0.** When considering freezing more than one column on any table in future, remember: only the leftmost column gets `left:0` for free. A second frozen column needs its `left` offset kept in sync with the first column's *live* width (including on resize/window-resize), which is real added complexity — was deliberately scoped to one column per table this session for that reason, not just a design preference.
- **Sandbox network is restricted** — cannot reach `docs.google.com`, `script.google.com`, `firebase*.com`, `cdnjs.cloudflare.com`, `registry.npmjs.org`, etc. **Correction this session: `npm install` doesn't work either** (403 from the npm registry) — the earlier plan of `npm install xlsx --no-save` to get a local copy of SheetJS for test pages doesn't work in this sandbox. There is no local copy of `xlsx.full.min.js` or `chart.umd.min.js` cached anywhere in the environment. Practical fallback used successfully this session: stub the CDN global with a minimal hand-written mock matching just the methods actually called (`window.Chart = function(){...}`, `Chart.register = function(){}` was enough to get `renderDashboard()`/`renderPieChart()` running without errors) and mock `window.fetch` directly for anything that would otherwise hit `PRICE_API_URL`. For features that need the real `XLSX.read()`/file-upload parsing specifically (e.g. the Zerodha `.xlsx` file picker), that step of the flow currently **cannot** be exercised end-to-end in this sandbox — test the logic downstream of "file successfully parsed into rows" instead (build the same plan/row shapes by hand and feed them into the real apply/matching functions), and say so plainly rather than claiming full coverage.
- **Always clean up test artifacts** (`rm -f test_*.xlsx index_test.html`, `rm -rf node_modules package.json package-lock.json`) before copying final files to `/mnt/user-data/outputs/finance-tracker/` — the delivered files should never include test scaffolding.
- **State assumptions explicitly** when a request is ambiguous (e.g., "filter for all columns" → built as one search box per tab rather than per-column filters, stated clearly) rather than blocking on a clarifying question for every small ambiguity.
- **When a reported bug can't be reproduced after real testing, say so plainly and ship the best available defensive fix rather than guessing at code changes** — this is what happened with the lock-toggle report this session (see §8.3): don't touch working, tested code on faith that something's wrong with it; look for an environmental explanation (caching, stale deploy) first.

---

## 10. Frozen columns + Debt import overhaul + maturity highlighting (this session)

### 10a. Frozen (sticky) first column — Equity, Debt, Mutual Funds, Gold

All four data tables now keep their Name/Symbol column fixed in place while the rest of the table scrolls horizontally underneath it — header, body rows, and the footer's "Total" cell all included. Implemented via plain CSS `position: sticky; left: 0` on that one column (no JS needed to track an offset, since it's the leftmost column — see the note in §9). Applied classes:
- `.sticky-col` on the header `<th>`, every row's first `<td>` (in the JS render templates), and the footer's "Total" `<td>` — for all four tabs.
- New CSS block in `index.html` (`.data-table td.sticky-col` / `th.sticky-col` / `tfoot td.sticky-col`) handles the sticky positioning, an explicit `background` (so scrolling content doesn't show through), a right-edge drop shadow for visual separation, and a z-index stack (`th.sticky-col` above plain `thead th` above `td.sticky-col`) so the frozen-column-and-frozen-header corner renders correctly.
- Only the Name/Symbol column is frozen on each tab, deliberately — see §9 for why a second frozen column is meaningfully more complex and wasn't done without being asked.
- Verified via Puppeteer: programmatically scrolled each table's `.table-scroll` container and confirmed via `getBoundingClientRect()` that the frozen column's on-screen position doesn't move while `scrollLeft` changes; screenshots confirm it visually (Debt tab shown scrolled to Maturity Date with Name still pinned on the left).

### 10b. Debt Excel import — now a full overwrite, not append

**This reverses the append-only decision documented in the original §5** — full overwrite actually sidesteps the original problem (FD names not being a reliable unique key) entirely, since there's no matching/merging logic left to get wrong: the imported rows simply *become* `state.debt`.
- `parseDebtWorkbookRows()` parses the workbook the same way as before (same 11-column layout: Name, Category, Sub-category, Account No., Invested Amount, ROI, Maturity Amount, Invested Date, Maturity Date, Tenure Months, Notes).
- Every import — Excel or Google Sheet (§10c) — now goes through a **preview-and-confirm modal** (`showDebtImportPreview()`) before touching `state.debt`, same UX pattern as the Zerodha importers: shows current-entry count, incoming-entry count, an explicit "N will be replaced" warning, and a sample of the incoming rows (first 10, with a "…and N more" note). Only on clicking "Replace N entries" does `state.debt = newRows` actually happen. Cancel leaves existing data untouched.
- No more silent appends — this was a deliberate, explicit change per this session's request, not a bug fix.

### 10c. Debt import from Google Sheet — new "Import from Google Sheet" button

Chosen over a Google Drive file-picker (the other option discussed) because Ganesh confirmed his Debt data lives in a Sheet he maintains, same as the existing Stocks/Mutual Funds/ETF live-price tabs — this reuses that exact mechanism (same `PRICE_API_URL`, same Apps Script Web App, same `doGet()` JSON pattern) instead of adding a whole new Google Drive Picker API + OAuth scope for comparatively little benefit.

**⚠️ Requires one manual step from Ganesh — the app-side code is done, but nothing will come through until this is added:** the Apps Script's `doGet()` needs to also return a `debt` array, keyed by whatever your `Debt` tab's own header row says (same convention as Stocks/MF/Gold). Concretely, add a `Debt` tab to the Sheet with these headers in row 1 (any order, exact spelling matters for the ones marked *required*):

```
Name (required) | Category | Sub-category | Account No. | Invested Amount | ROI | Maturity Amount | Invested Date | Maturity Date | Tenure Months | Notes
```

Then extend `doGet()` to include it — using whatever helper your script already uses to turn a sheet's rows into an array of `{header: value}` objects for the Stocks/Mutual Funds/Gold tabs (e.g. if it's called `sheetToObjects(sheet)`), just call that same helper on the new `Debt` tab and add it under a `debt` key:

```javascript
function doGet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ContentService.createTextOutput(JSON.stringify({
    stocks: sheetToObjects(ss.getSheetByName('Stocks')),
    mf:     sheetToObjects(ss.getSheetByName('Mutual Funds')),
    gold:   sheetToObjects(ss.getSheetByName('ETF')),
    debt:   sheetToObjects(ss.getSheetByName('Debt'))   // <-- new line
  })).setMimeType(ContentService.MimeType.JSON);
}
```

(Substitute your script's actual helper/function name and tab names if they differ from this example — the point is just "read the new Debt tab the same way the other three are already read, and add it to the response object under `debt`.")

Once that's live, clicking **Import from Google Sheet** on the Debt tab fetches the same JSON already used for live prices, reads `data.debt`, and feeds it through the exact same preview-and-confirm-overwrite flow as the Excel import (§10b) — so both import paths end up sharing one code path (`showDebtImportPreview()`) once parsed.

- Until the Sheet returns a `debt` key, clicking the button shows a clear alert explaining exactly that (not a silent failure or generic error) — verified via Puppeteer with a mocked old-shape response (`{stocks, mf, gold}`, no `debt`).
- Full flow (fetch → parse → preview modal → confirm → overwrite `state.debt` → re-render) verified end-to-end via Puppeteer with a mocked Apps Script response — including the CORS header the mock needed to add to be fetchable at all from a `file://` test page, which is a testing-environment detail only, not something Ganesh needs to think about (his real deployment already handles this the same way live prices do).
- Field matching (`parseDebtSheetRows()`) is flexible on header spelling the same way `buildMFCategoryMap()` already is for Sub-category (`Sub-category` / `Sub-cateogry` / `Subcategory` / `Sub category` all match), so a small header typo on the new Debt tab won't silently drop that column.
- `toDateInputValue()` was widened to also accept full ISO datetime strings (e.g. `"2026-08-08T00:00:00.000Z"`, what Apps Script's `JSON.stringify` produces for a Date-typed cell) in addition to the plain `"YYYY-MM-DD"` it already handled — needed for dates coming from the Sheet, backward-compatible with the existing Excel-import path.

### 10d. Debt maturity-date highlighting

Every Debt row's Maturity Date cell is now colored based on how close it is to today, recomputed on every render/edit — never stored as a flag on the row itself:
- **Already matured** (maturity date is in the past) → red background/text, reusing the existing `--negative` / `--negative-soft` variables (no new red needed).
- **Maturing within 30 days** → new `--warning` (`#d9a441`) / `--warning-soft` variables, an amber tone chosen deliberately *not* to reuse `--gold` — gold is the app's primary brand accent (hero stat card, active tab underline) and reusing it here would make "this is your brand color" and "this needs attention soon" look identical.
- **More than 30 days away, or blank** → unstyled, matches every other cell.
- `maturityStatus(dateStr)` is the single source of truth for this logic (in `app.js`), called from both `renderDebt()` (full re-render) and `updateDebtComputed()` (the lightweight per-field update path that runs on every edit without disturbing focus) — so editing a row's Maturity Date, ROI, or any other field always leaves the highlighting correct on next paint, not just on tab-switch.
- No layout, spacing, or unrelated visual changes — same table, same fonts, same input styling otherwise, just a background tint + border/text color on that one cell when a threshold is crossed.
- Verified via Puppeteer with three seeded rows (5 days overdue, 15 days out, 400 days out) — confirmed the overdue row gets `maturity-overdue`, the 15-day row gets `maturity-soon`, and the 400-day row gets neither.

---

## 11. Import Zerodha Holdings from Google Drive (this session) — new alternative to the local file picker

**New file, delivered alongside `index.html`/`app.js`: `ZerodhaHoldingsImport.gs`.** Paste this into a **brand new, standalone Apps Script project** — deliberately not added to the existing price-fetch script, so a failure or redeploy of one never touches the other. Full setup steps (enabling the Advanced Drive Service, creating the Drive folder, deploying as a Web App, getting the `/exec` URL) are in the comment block at the top of that file — Ganesh needs to do this part; I don't have Drive/Apps Script console access.

**What it does:** scans a designated Drive folder for the **most recently modified `.xlsx` file** (any filename — no renaming needed), converts it to a temporary Google Sheet via the Advanced Drive Service (`Drive.Files.copy` with a Sheets MIME type — `SpreadsheetApp` can't open `.xlsx` blobs natively), reads the `Stocks` / `Mutual funds` / `Gold` tabs, deletes the temp copy, and returns JSON:
```json
{ "sourceFileName": "...", "fileUpdated": "ISO timestamp", "stocks": [...], "mf": [...], "gold": [...] }
```
Row-object shape (keyed by header text: `Symbol`, `Qty.`, `Buy avg.`, `Buy value`, ...) — same convention `buildMFCategoryMap()`/`parseDebtSheetRows()` already use for the live-price and Debt-sheet integrations.

**Ongoing use, once set up:** whenever Ganesh downloads a fresh Holdings export from Zerodha Console, he just drops the `.xlsx` into that one Drive folder — any filename, no need to overwrite/rename. Old exports can pile up or be cleaned out independently; the script always reads whichever one was modified most recently.

**Both import paths now exist side by side, per explicit request** (not a replacement): each of the three tabs (Equity, Mutual Funds, Gold) has both the original "Import Zerodha Holdings" (local file picker) button and a new **"Import from Google Drive"** button. Both funnel into the exact same downstream logic — a new shared function `runZerodhaImportFlow()` was factored out of what used to be file-picker-only code in `setupZerodhaTabImport()`; it builds the match/add/duplicate plan (`planAssetClass`), does MF category enrichment when applicable, and shows the same preview-and-confirm modal either way. This means `applyEquityZerodhaPlan` / `applyMFZerodhaPlan` / `applyGoldZerodhaPlan` — and the MF category-enrichment logic — needed **zero changes**; only the "how do rows get from a source into `{symbol, qty, buyAvg, buyValue}` objects" step differs between the two paths.

**New endpoint, deliberately separate from `PRICE_API_URL`:** `HOLDINGS_API_URL` in `app.js` — currently a placeholder (`PASTE_YOUR_HOLDINGS_APPS_SCRIPT_WEB_APP_URL_HERE`) that Ganesh needs to replace with his real deployment's `/exec` URL once set up. `fetchHoldingsData()` mirrors `fetchPriceData()`'s error handling (network/HTTP/parse-failure messages) but is a fully separate function, so a Drive-import failure is never confused with a live-price failure in the UI.

**New parsing function `parseHoldingsSheetObjects()`** — the object-keyed counterpart to the existing `parseHoldingsSheetRows()` (which works on SheetJS's positional arrays). Same junk-row rule (needs both `Qty.` and `Buy avg.` present and numeric) and same `parseIndianNumber()` reused for values — including comma-grouped strings like `"2,85,708.85"` that Google Sheets can leave as text after an xlsx→Sheets conversion (verified against the real `Import.xlsx`'s Gold sheet, which has exactly this).

**Preview modal, Drive path only:** shows an extra line above the usual match/add/duplicate summary — `Source: <filename> — last updated <timestamp>` — so Ganesh can confirm he's about to import a fresh file before clicking Confirm, a check the local-file path doesn't need (the file he just picked is obviously current).

**Tested end-to-end via Puppeteer** with a mocked `fetch()` built from the real `Import.xlsx`'s actual sheet contents (166 raw stock rows including junk rows, 26 MF rows, 3 gold rows) reshaped into the object format the new Apps Script would return:
- Seeded one pre-existing row per asset class, confirmed each correctly matched-and-updated (Invested/Units overwritten) while new rows got added with `livePricePending: true`.
- Confirmed junk rows (Zerodha's two per-holding artifact rows) were correctly filtered out in all three sheets.
- Confirmed MF category enrichment still works through the new path — one mocked live-price-sheet match got Symbol/Category/Sub-category auto-filled; the twelve unmatched new funds were correctly left blank rather than crashing or getting garbage values.
- Confirmed Gold's comma-formatted `Buy value` string (`"2,85,708.85"`) parsed to the correct number (`285708.85`).
- Confirmed the source-file/timestamp note rendered correctly in the preview modal for all three tabs.
- **Not testable in this sandbox** (no network access to Drive/Apps Script/the Advanced Drive Service): the actual folder-scan-for-most-recent-xlsx step and the xlsx→Google-Sheets conversion step. That part needs Ganesh's own verification once he's completed the one-time setup and deployed the script — same disclosed limitation as the rest of the Google Sheet integration (§9).

**`index.html` cache-busting bumped to `app.js?v=2026-08-09-1`** — bump this again on the next redeploy (see §1).

**Still to do (Ganesh's side, not code):** complete the one-time Apps Script setup in `ZerodhaHoldingsImport.gs`'s header comment (enable Advanced Drive Service, create/ID the Drive folder, deploy, get the URL), then paste that URL into `HOLDINGS_API_URL` near the top of `app.js` before the Drive-import buttons will actually work — until then, clicking "Import from Google Drive" will fail with a clear network/HTTP error rather than silently doing nothing.

---

## 12. Mobile card-view redesign (this session)

**Problem:** the app was desktop-only in practice. All four data tables (Equity/Debt/MF/Gold) are wide, fixed-width (`table-layout:fixed`, 955–1615px `min-width`), horizontally-scrolling tables — fine on a PC, but on a phone this meant swiping sideways through most of a row's data even with the Name column frozen, plus a toolbar of 4–6 buttons wrapping into several rows before you even reached the table, plus small (~12.6px) table inputs that trigger iOS Safari's auto-zoom on tap.

**Approach chosen (of three discussed): below a new `700px` breakpoint, every table row renders as a stacked card instead of a horizontally-scrolling row** — pure CSS on top of the exact same DOM, sort/filter state, render functions, and event handlers; **desktop is completely unchanged**, since every mobile rule lives inside `@media (max-width:700px)`. Nothing about how state, calculations, or imports work changed in this session — presentation layer only.

### 12a. How the card view works

- `td[data-label]::before{content:attr(data-label)}` shows the column name next to each value — every `<td>` across all four render functions (`renderEquity`, `renderDebt`, `renderMF`, `renderGold`) and the Dashboard's allocation table now carries a `data-label="..."` attribute matching its header text (the first "Name" column and the "row-actions" remove-button column intentionally have none — the name is the card's own title, the ✕ button is self-explanatory).
- `table.data-table tbody tr` becomes a bordered, rounded card; `thead`/`tfoot` are hidden (their numbers move to a dedicated mobile summary bar instead — see 12b); the first column (`td.sticky-col`) becomes the card's title row (larger font, bottom border) instead of a desktop frozen column — `position:sticky` is explicitly reset to `position:static` on mobile since there's no horizontal scroll to freeze against anymore.
- Debt's maturity-soon/overdue tinting now also applies to the whole card via a class added directly to the `<tr>` (`maturityStatus()`'s return value), not just the one date field as on desktop — a left-edge accent border, kept in sync on every edit through `updateDebtComputed()` exactly like the existing `.c-maturity` cell class already was.

### 12b. New mobile-only controls (all hidden above 700px, all reuse existing state/handlers — no parallel logic)

- **Sticky totals bar** (`.mobile-totals`, one per tab plus one implicit via the Dashboard's own already-responsive stat cards) — mirrors the desktop `<tfoot>` figures, updated in the exact same places `renderX()`/`updateXComputed()` already update the desktop footer, just writing to a second set of element IDs (`eqMobTotal*`, `debtMobTotal*`, `mfMobTotal*`, `goldMobTotal*`).
- **Mobile sort control** (`<select>` + a ↑/↓ direction-toggle button) stands in for clicking a column header, since headers aren't visible in card view. `setupMobileSort()` operates on the exact same `tableUI[tableKey]` object the desktop click-to-sort headers use, and keeps the desktop header's arrow indicator in sync (`syncDesktopHeaders()`), so switching between mobile and desktop widths — or just resizing a window — never shows stale sort state either way.
- **Overflow menu** (`⋯` toggle button) shows/hides the secondary action buttons (Refresh, Import from Excel, Import Zerodha Holdings, Import from Google Drive) that would otherwise crowd a phone-width toolbar. Implemented as a plain class toggle (`setupOverflowToggle()`) on a wrapper (`.toolbar-secondary`) that's `display:contents` above 700px — meaning on desktop those buttons render exactly as before, inline, with zero visual or behavioral change; the toggle button itself is also hidden on desktop.
- **Floating "+" button** (`.fab-add`, one per panel, `position:fixed` bottom-right) — `setupFabAdd()` just forwards its click to the existing "+ Add ..." button's `.click()`, so there's no second add-row implementation to keep in sync; CSS shows it only for whichever panel currently has `.active` (`.panel.active .fab-add{display:flex}`), so only one FAB is ever visible at a time without any JS needed to hide the other three.

### 12c. Default sort order (new this session, explicit request)

Previously all four tables started unsorted (insertion order). Now:
- **Equity, Mutual Funds** default to **Alloc % descending** (`tableUI.equity`/`tableUI.mf = { sortCol: "allocPct", sortDir: -1 }`) — biggest holdings first.
- **Debt** defaults to **Maturity Date ascending** (`tableUI.debt = { sortCol: "maturityDate", sortDir: 1 }`) — soonest-maturing entries first, so upcoming maturities needing attention surface at the top without having to sort manually.
- **Gold** stays unsorted by default (not requested).
- `markInitialSortIndicator()` marks the correct desktop header with its arrow on page load, so the header UI reflects the actual default sort state from the first render rather than only after a manual click. The mobile `<select>` elements have their default `<option>` marked `selected` to match (`allocPct` for Equity/MF, `maturityDate` for Debt).
- This only changes the *initial* sort state — clicking any header (desktop) or picking any option (mobile) still works exactly as before, on any column, either direction.

### 12d. Also updated: Dashboard allocation table

Same card-list treatment as the four asset-class tabs, but via a separate, narrowly-scoped CSS block (`#panel-dashboard table tbody tr{...}` etc.) rather than reusing `.data-table`'s rules — that table isn't tagged `.data-table` and deliberately wasn't given that class, since `.data-table`'s desktop `table-layout:fixed` divides columns evenly and would have squeezed the Asset Class column (which needs more room for the color swatch + label) on desktop. The Ideal % input still works identically; a small `.ideal-input{width:70px}` override just keeps it from stretching full-width in the card layout.

### 12e. Testing

Verified via Puppeteer at two viewports (1400px desktop, 380px mobile) against the same page load:
- **Desktop**: confirmed `sticky-col` cells are still `display:table-cell` (not the mobile `block`), the FAB/mobile-totals/mobile-sort-row/overflow-toggle are all `display:none`, and `.toolbar-secondary` renders as `display:contents` (buttons inline, unchanged) — i.e. a real regression check that mobile CSS doesn't leak into desktop rendering.
- **Desktop, default sort**: confirmed `tableUI.equity`/`mf` start at `{sortCol:"allocPct", sortDir:-1}` and `tableUI.debt` at `{sortCol:"maturityDate", sortDir:1}`; confirmed actual row order on load matches (higher-invested stock row before lower-invested one for Equity; sooner-maturing FD before later one for Debt); confirmed the desktop header shows `sort-desc`/`sort-asc` on load without any click.
- **Mobile**: confirmed rows render as `display:block` cards, `thead` is hidden, the FAB is `display:flex` and visible only on the active tab, the mobile totals bar shows the correct aggregated figures (cross-checked against manually computed Invested/Current/P&L for the seeded test rows), `data-label` attributes are present and correct, the overflow toggle correctly shows/hides the secondary buttons, a debt row maturing within 30 days gets the amber (`--warning`, `rgb(217,164,65)`) card border, clicking the FAB adds a row through the real `btnAddStock` handler (row count increased by exactly one), and changing the mobile sort `<select>` updates `tableUI` and syncs the desktop header's indicator class.
- **Dashboard allocation table**: confirmed it also renders as `display:block` cards on mobile with correct `data-label`s and values.
- **Not retestable in this sandbox**: real touch interaction, iOS Safari's specific auto-zoom behavior on `<input>` focus (the inputs' font-size wasn't changed this session since the card-view inputs already read at 14px in the card layout, above the 16px iOS zoom threshold isn't guaranteed on every input — flag if this still zooms on your phone and I'll bump the specific input font-size), and real-device layout at your actual phone's exact viewport width/browser. Please try it on your phone and report back anything that still looks off.

**`index.html` cache-busting bumped to `app.js?v=2026-08-10-1`.**

