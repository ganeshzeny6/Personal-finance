/* ============================================================
   Ganesh's Net Worth & Allocation Tracker
   All data lives in localStorage under key "ledger_data_v1".

   Live prices come from a Google Apps Script Web App deployed on
   Ganesh's own Sheet (Stocks / Mutual Funds / ETF tabs), kept
   fresh by a time-driven trigger. The Web App returns JSON, which
   sidesteps a known CORS gap in Google Sheets' "Publish to web ->
   CSV" links (that endpoint doesn't reliably send the header
   browsers require for cross-origin fetches). If a fetch fails,
   prices simply stay at their last saved value — edit them by
   hand as a fallback.

   To point this at a different deployment, just replace the URL
   below with your own Apps Script Web App /exec URL.
   ============================================================ */

const STORAGE_KEY = "ledger_data_v1";

// Declared early (rather than next to renderDashAllocDonut() further
// down) because applyTheme() below reads it on initial load, before
// the rest of the file has executed — a `let` declared later would
// still be in its temporal dead zone at that point.
let dashAllocDonutChart = null;

// ============================================================
// Theme (Light / Dark / Auto)
// "auto" follows the OS/browser color-scheme preference and keeps
// tracking it live; "light"/"dark" pin an explicit choice. The
// choice is persisted so it survives a reload, and applied via a
// data-theme attribute on <html> (see the light-palette CSS block
// and the FOUC-prevention inline script in index.html's <head>,
// which already sets this before first paint — this just keeps it
// in sync afterwards and wires up the toggle buttons).
// ============================================================
const THEME_STORAGE_KEY = "themePreference";

function getStoredThemePreference() {
  try { return localStorage.getItem(THEME_STORAGE_KEY) || "auto"; }
  catch (e) { return "auto"; }
}

function effectiveTheme(pref) {
  if (pref === "light" || pref === "dark") return pref;
  return (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
}

function applyTheme(pref) {
  const effective = effectiveTheme(pref);
  document.documentElement.setAttribute("data-theme", effective);
  document.documentElement.style.colorScheme = effective;
  document.querySelectorAll(".theme-toggle-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.themeChoice === pref);
  });
  // The allocation donut's ring border is painted to match the card
  // surface color, which flips with the theme — repaint it in place
  // rather than waiting for the next full dashboard render.
  if (dashAllocDonutChart) {
    const ringBorder = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
    if (ringBorder) {
      dashAllocDonutChart.data.datasets[0].borderColor = ringBorder;
      dashAllocDonutChart.update();
    }
  }
}

function setThemePreference(pref) {
  try { localStorage.setItem(THEME_STORAGE_KEY, pref); } catch (e) {}
  applyTheme(pref);
}

document.querySelectorAll(".theme-toggle-btn").forEach(btn => {
  btn.addEventListener("click", () => setThemePreference(btn.dataset.themeChoice));
});

if (window.matchMedia) {
  const lightMedia = window.matchMedia("(prefers-color-scheme: light)");
  const onSystemThemeChange = () => {
    if (getStoredThemePreference() === "auto") applyTheme("auto");
  };
  if (lightMedia.addEventListener) lightMedia.addEventListener("change", onSystemThemeChange);
  else if (lightMedia.addListener) lightMedia.addListener(onSystemThemeChange); // older Safari
}

// Re-apply on load so the toggle buttons reflect the stored choice
// (the inline <head> script already set the attribute pre-paint —
// this call is what lights up the correct button as "active").
applyTheme(getStoredThemePreference());

// Apps Script Web App endpoint. doGet() on the Sheet's script
// returns { stocks: [...], mf: [...], gold: [...] }, each row
// keyed by that tab's actual header text (e.g. "Stock Name",
// "Symbol", "Live Price").
// These are just the fallback/first-run values — the live URLs actually
// used by the app live in state.priceApiUrl / state.holdingsApiUrl (see
// blankState() below), which are editable from the Settings modal so a
// redeployed Apps Script URL can be updated without touching code.
const DEFAULT_PRICE_API_URL = "https://script.google.com/macros/s/AKfycbxT5Mgu9hhXdIA6kbfRfT_RhyWJNb6UYbbWBjte0jWh-9Zk4QmyiTLNJveQYLeUoTNBHw/exec";

// Separate Apps Script Web App — its own standalone project/deployment,
// unrelated to the Price API above. It scans a designated Google Drive
// folder for the most recently modified Zerodha Console Holdings
// export (.xlsx), converts it to a temporary Google Sheet, reads the
// Stocks / Mutual funds / Gold tabs, and returns their rows as JSON —
// used by each tab's "Import from Google Drive" button. See
// ZerodhaHoldingsImport.gs for the script this URL comes from.
const DEFAULT_HOLDINGS_API_URL = "https://script.google.com/macros/s/AKfycbxVhXBRtZvfmGNjFEaKwOQE54-u-OrC5oGfiFuEjBN7KDJhwW1PE-2OmnzcjXux8MOZ/exec";

// One-time Google Cloud credentials for the "Import from Google Drive"
// file picker (see Settings for setup steps). These are Ganesh's own
// values, hardcoded as real defaults so a fresh blankState() actually
// has them in `state` (and thus persisted to localStorage/Firestore)
// rather than only appearing as a Settings-modal display fallback that
// never gets saved unless "Save" is explicitly clicked.
const DEFAULT_GOOGLE_DRIVE_CLIENT_ID = "638244383857-oe1ea4pb1l64a79d34d7j64uclmpmqv9.apps.googleusercontent.com";
const DEFAULT_GOOGLE_DRIVE_API_KEY = "AIzaSyB0waRuXkp9Bh1k0CcmSea-BXcM6yY8WQs";

// Yet another separate, standalone Apps Script Web App (see
// nifty_daily_capture.gs's doGet()), bound to the "Nifty Live
// (helper)" sheet, returning { niftyHistory: [{date, close}, ...] }.
// No sensible hardcoded default here (unlike the two above) — it's
// only created once Settings -> "Portfolio Performance Chart" ->
// "Nifty History API URL" is filled in after deploying that script.
const DEFAULT_NIFTY_HISTORY_API_URL = "";

const DEFAULT_IDEAL = { cash: 5, debt: 30, mf: 30, equity: 25, gold: 10 };

// Equity tab: maximum recommended allocation % (of total Equity Invested
// Amount) per market-cap category — editable under Settings -> Equity
// Allocation Limits. Never hardcoded elsewhere; every place that needs a
// limit reads state.equityAllocLimits (falling back to these defaults),
// via getEquityAllocLimit() below.
const DEFAULT_EQUITY_ALLOC_LIMITS = { large: 15, mid: 8, small: 5 };

// Equity tab: overall target % of the WHOLE equity portfolio per
// market-cap category (e.g. Large Cap should make up ~70% of total
// equity invested). Distinct from DEFAULT_EQUITY_ALLOC_LIMITS above,
// which caps a single stock's share of the portfolio — this instead
// caps a whole category's share of the portfolio. Read via
// getEquityCapAllocTarget() below, editable under Settings -> Equity
// Allocation Targets (Overall Portfolio, by Market Cap).
const DEFAULT_EQUITY_CAP_ALLOC_TARGETS = { large: 70, mid: 20, small: 10 };

// Stock Analysis: columns hidden by default on a brand-new install, so
// the table opens compact/scannable instead of showing all 32 fields
// at once. Only ever applied via blankState() below — an existing
// saved stockAnalysisHiddenCols (even an empty array from before this
// change) always wins, so this never resets anyone's own Columns
// picker choices. Everything not listed here (Sector, LTP, 52W Low/
// High, PE, Industry PE, Buy Reco, P/B, ROE, ROCE, Dividend Yield,
// ROA) stays visible by default; ROA itself is always joined/derived
// but only ever displayed for Financial-sector rows (see
// renderStockAnalysis()) — everyone else shows a dash there.
const STOCK_ANALYSIS_DEFAULT_HIDDEN_COLS = [
  "gainFromLow", "dropFromHigh", "eps", "bookValue", "industryPbv", "yieldPct",
  "debtToEquity", "promoterHolding", "epsGrowth3y", "epsGrowth5y", "salesGrowth5y",
  "qtrProfitVar", "qtrSalesVar", "faceValue", "marketCap", "marketCap5y",
  "intCoverage", "fcfPrevAnn", "profitVar3y", "profitVar5y"
];

const ASSET_COLORS = {
  cash:   "#6f93c9",
  debt:   "#4bbf9c",
  mf:     "#c9a44c",
  equity: "#e0667a",
  gold:   "#e0b04b"
};

let state = loadState();
let pieChart = null;

/* ---------------- offline read-only guard ----------------
   Independent of the manual portfolioLocked toggle: while the
   browser has no network connection, every field that Lock
   Portfolio would normally guard is also made read-only (there's
   nothing useful to sync/fetch offline, and it avoids entering
   data that a later cloud-sync conflict could clobber). Connection
   returns -> fields go back to whatever portfolioLocked says.
   isReadOnly() is the single source of truth every render*()
   function below should use instead of state.portfolioLocked. */
function isReadOnly() {
  return state.portfolioLocked || !navigator.onLine;
}

function updateOfflineBanner() {
  const tag = document.getElementById("offlineTag");
  if (!tag) return;
  tag.style.display = navigator.onLine ? "none" : "inline-block";
}

window.addEventListener("online", () => {
  updateOfflineBanner();
  // Re-open Firestore's network connection and pull down whatever's
  // authoritative in the cloud now that we're back online.
  if (fbDb) fbDb.enableNetwork().catch(() => {});
  if (cloudUser) resolveCloudSync();
  renderEquity(); renderDebt(); renderMF(); renderGold(); renderDashboard();
});
window.addEventListener("offline", () => {
  updateOfflineBanner();
  // Fully cuts Firestore off at the network level — no writes get
  // queued locally to replay later; they simply don't happen until
  // we're back online (see resolveCloudSync()/pushStateToCloud()).
  if (fbDb) fbDb.disableNetwork().catch(() => {});
  renderEquity(); renderDebt(); renderMF(); renderGold(); renderDashboard();
});

// chartjs-plugin-datalabels draws permanent on-slice labels (no hover
// needed), which also means it works identically on touch/mobile.
if (typeof ChartDataLabels !== "undefined") {
  Chart.register(ChartDataLabels);
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function blankState() {
  return {
    cash: 0,
    ideal: { ...DEFAULT_IDEAL },
    // Equity tab: max allocation % per market-cap category — see
    // DEFAULT_EQUITY_ALLOC_LIMITS above and getEquityAllocLimit() below.
    equityAllocLimits: { ...DEFAULT_EQUITY_ALLOC_LIMITS },
    // Overall Large/Mid/Small target split for the whole Equity
    // portfolio — see DEFAULT_EQUITY_CAP_ALLOC_TARGETS above.
    equityCapAllocTargets: { ...DEFAULT_EQUITY_CAP_ALLOC_TARGETS },
    equity: [],
    debt: [],
    mf: [],
    gold: [],
    // Stock Analysis tab: one row per imported Screener export, keyed
    // for lookup by `symbol` (uppercased at import time). Values are
    // cleaned to plain numbers where possible (currency/comma/%
    // stripped) — see parseScreenerNum(). Never edited by hand;
    // wholesale-replaced on each "Import Screener Data".
    screenerData: [],
    // Stock Analysis tab: keys of columns the person has hidden via
    // the "Columns" picker (data-col values, e.g. "roe", "pb"). Empty
    // array means every column is shown. "name" (Stock/Symbol) can
    // never be hidden since it's the row's sticky identifier.
    stockAnalysisHiddenCols: [...STOCK_ANALYSIS_DEFAULT_HIDDEN_COLS],
    // Stock Analysis tab: names (uppercased, trimmed — matches the
    // Equity holding's `name`) of stocks the person has removed from
    // this tab's view. This only affects Stock Analysis — the actual
    // Equity holding is untouched and still shows up normally on the
    // Equity tab, since it's driven by Zerodha import and shouldn't be
    // deletable from a read-only analysis view. Restorable any time via
    // the "Hidden (N)" button next to Columns.
    stockAnalysisExcludedNames: [],
    // Banking Metrics (manual, free-tier workflow): quarterly CRAR/NIM/
    // GNPA/NNPA/Cost-to-Income/CASA for Financial-sector holdings.
    // Keyed by uppercased Stock/Symbol -> { history: [ {quarterLabel,
    // quarterKey, reportingDate, metrics, savedAt}, ... ] }, newest
    // quarter first. Nothing here is fetched automatically — every
    // record is a JSON reply the person researched themselves (in
    // their own claude.ai chat) and pasted back in via the Banking
    // Metrics modal; see openBankingMetricsModal() below. Saved the
    // same way as everything else in `state` (saveState() ->
    // localStorage / Firestore), no separate API or billing involved.
    bankingMetrics: {},
    lastSaved: null,
    lastBackup: null,
    // When true, Quantity/Units and Average Price/Invested fields on
    // Equity, Mutual Funds and Gold are read-only in the UI and can
    // only change via "Import Zerodha Holdings". Everything else
    // (name, notes, remarks, category, add/remove row) stays editable.
    portfolioLocked: false,
    // Shown in the header/title ("<name>'s Net Worth & Allocation
    // Tracker") and editable from Settings.
    ownerName: "Ganesh",
    // Editable from Settings so a redeployed Apps Script /exec URL
    // can be updated without touching code.
    priceApiUrl: DEFAULT_PRICE_API_URL,
    holdingsApiUrl: DEFAULT_HOLDINGS_API_URL,
    // Portfolio performance chart (Dashboard): Apps Script Web App URL
    // that returns Nifty History as JSON — see DEFAULT_NIFTY_HISTORY_API_URL
    // above and fetchNiftyHistoryData(). Empty until deployed/set.
    niftyHistoryApiUrl: DEFAULT_NIFTY_HISTORY_API_URL,
    // One-time Google Cloud credentials for the "Import from Google
    // Drive" file picker (see Settings for setup steps). Defaulted to
    // Ganesh's own values (see DEFAULT_GOOGLE_DRIVE_CLIENT_ID/API_KEY
    // above) so Drive import works out of the box; still editable from
    // Settings if these ever need to change.
    googleDriveClientId: DEFAULT_GOOGLE_DRIVE_CLIENT_ID,
    googleDriveApiKey: DEFAULT_GOOGLE_DRIVE_API_KEY,
    // Market Snapshot (Dashboard): last-known live values for Nifty Bank /
    // NIFTY 50 / SENSEX, keyed by INDEX_DEFINITIONS[].key. Persisted like
    // everything else in `state` so the snapshot still has something to
    // show (marked stale) immediately after a reload, before the next
    // 30-second live refresh lands. Populated by refreshIndexData().
    indexData: {}
  };
}

// Single shared merge used everywhere a saved state blob (localStorage,
// a JSON backup file, a Firestore cloud doc, or a pre-demo snapshot) is
// turned into a real `state` object. Centralizing this avoids the bug
// where loadState() had a "backfill blank googleDriveClientId/ApiKey"
// fix that the JSON-import, cloud-sync, and exit-demo code paths didn't
// share — each of those rebuilt `state` with its own copy-pasted spread
// and silently let old saved "" values re-clobber the real defaults.
// Add any future "treat an old saved blank as unset" backfill here once,
// not at every call site.
function mergeIntoState(saved) {
  saved = saved || {};
  return {
    ...blankState(),
    ...saved,
    ideal: { ...DEFAULT_IDEAL, ...(saved.ideal || {}) },
    equityAllocLimits: { ...DEFAULT_EQUITY_ALLOC_LIMITS, ...(saved.equityAllocLimits || {}) },
    equityCapAllocTargets: { ...DEFAULT_EQUITY_CAP_ALLOC_TARGETS, ...(saved.equityCapAllocTargets || {}) },
    // Backfill: earlier saves may have an explicit "" here from before
    // these had real defaults — treat that the same as "never set"
    // rather than letting a blank string win.
    googleDriveClientId: saved.googleDriveClientId || DEFAULT_GOOGLE_DRIVE_CLIENT_ID,
    googleDriveApiKey: saved.googleDriveApiKey || DEFAULT_GOOGLE_DRIVE_API_KEY,
    indexData: { ...(saved.indexData || {}) }
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return blankState();
    return mergeIntoState(JSON.parse(raw));
  } catch (e) {
    console.error("Failed to load saved data, starting fresh.", e);
    return blankState();
  }
}

// localStorage here is ONLY a read cache so the app still has something
// to show while offline (see isReadOnly() — offline already makes every
// editable field read-only, so nothing new gets written locally that
// still needs pushing up). The actual system of record, once signed in,
// is the Firestore document written by scheduleCloudPush() below — and
// that only ever fires while navigator.onLine is true.
function saveState() {
  state.lastSaved = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const tag = document.getElementById("lastUpdatedTag");
  if (tag) tag.textContent = "Saved " + new Date(state.lastSaved).toLocaleTimeString();
  scheduleCloudPush();
}

/* ============================================================
   TRADE BOOK (Portfolio performance chart — deliberately separate
   from `state`/STORAGE_KEY/Firestore)
   Ganesh asked for this data to stay out of Firestore specifically
   (everything else in `state` still syncs to the cloud as before) —
   so it lives in its own localStorage key, with its own load/save
   pair, and saveTradeBook() below never calls scheduleCloudPush().
   Holds raw trade-level rows imported from Zerodha Console
   Tradebook CSV exports across however many demat accounts, later
   used to build the "Portfolio performance vs Nifty 50" chart. It
   is intentionally NOT reconciled into state.equity/mf/gold here —
   that's a separate, not-yet-built step; this is import + storage
   only.
   ============================================================ */

const TRADEBOOK_STORAGE_KEY = "tradebook_data_v1";

function blankTradeBook() {
  return {
    // One entry per unique (accountId + exchange + segment + tradeId)
    // key — see tradeKey(). Shape: { accountId, symbol, isin,
    // tradeDate, exchange, segment, series, tradeType, auction,
    // quantity, price, tradeId, orderId, orderExecutionTime,
    // assetClass } — assetClass is "equity" | "mf" | "gold" (Gold ETF
    // rows like GOLDBEES are detected the same way Zerodha Holdings
    // import already does, via isGoldSymbol()).
    trades: [],
    // Informational import history only, shown in Settings.
    imports: []
  };
}

function loadTradeBook() {
  try {
    const raw = localStorage.getItem(TRADEBOOK_STORAGE_KEY);
    if (!raw) return blankTradeBook();
    return { ...blankTradeBook(), ...JSON.parse(raw) };
  } catch (e) {
    console.error("Failed to load trade book data, starting fresh.", e);
    return blankTradeBook();
  }
}

function saveTradeBook() {
  localStorage.setItem(TRADEBOOK_STORAGE_KEY, JSON.stringify(tradeBook));
}

let tradeBook = loadTradeBook();

/* ---------------- number formatting ---------------- */

function fmtINR(n) {
  n = Number(n) || 0;
  const sign = n < 0 ? "-" : "";
  n = Math.abs(n);
  const str = n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return sign + "\u20B9" + str;
}

function fmtNum(n, decimals = 2) {
  n = Number(n) || 0;
  return n.toLocaleString("en-IN", { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

// Small numeric clamp used by the Dashboard's Portfolio Health scoring
// (keeps every 0-100 sub-score actually within 0-100).
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function fmtPct(n) {
  n = Number(n) || 0;
  return (n >= 0 ? "" : "") + n.toFixed(2) + "%";
}

// Compact Indian currency notation (₹1.21 Cr / ₹10.9 L) for the
// Dashboard's Asset Allocation card, where full digit-grouped rupee
// figures would be too wide next to a donut + 5-column table. Same
// underlying number as fmtINR — just a different display format.
function fmtINRCompact(n, decimals) {
  n = Number(n) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e7) return sign + "\u20B9" + (abs / 1e7).toFixed(decimals ?? 2) + " Cr";
  if (abs >= 1e5) return sign + "\u20B9" + (abs / 1e5).toFixed(decimals ?? 1) + " L";
  return fmtINR(n);
}

// Same as above but always shows an explicit +/- sign, for variance/
// diff amounts where "no sign" would read as ambiguous rather than
// "on target".
function fmtINRCompactSigned(n, decimals) {
  n = Number(n) || 0;
  const base = fmtINRCompact(Math.abs(n), decimals);
  if (n > 0) return "+" + base;
  if (n < 0) return "-" + base;
  return base;
}

function plClass(n) {
  return n > 0 ? "pos" : n < 0 ? "neg" : "muted";
}

// Rounds a numeric field to 2 decimal places FOR DISPLAY ONLY (e.g. an
// <input>'s value attribute). The underlying row[field] in state is
// never touched here — full-precision numbers (as fetched live, or
// computed during Zerodha import as qty * avgPrice) keep flowing
// through every calculation untouched. Because the input's displayed
// value only changes visually and the user hasn't edited anything, no
// `change` event fires, so this never silently rewrites stored data.
// Whole numbers render without a trailing ".00" (e.g. units of 2000
// stays "2000", not "2000.00").
function roundedInputValue(val) {
  if (val === undefined || val === null || val === "") return "";
  const n = Number(val);
  if (isNaN(n)) return "";
  return String(Math.round(n * 100) / 100);
}

/* ============================================================
   MODAL HELPER
   One generic modal, reused for the Zerodha import preview and
   the post-import "new investments" reminder. Content is built
   as an HTML string by the caller and injected here.
   ============================================================ */

const modalOverlay = document.getElementById("modalOverlay");
const modalTitleEl = document.getElementById("modalTitle");
const modalBodyEl = document.getElementById("modalBody");
const modalFooterEl = document.getElementById("modalFooter");

// buttons: [{ label, primary?, onClick }]
function openModal(title, bodyHTML, buttons) {
  modalTitleEl.textContent = title;
  modalBodyEl.innerHTML = bodyHTML;
  modalFooterEl.innerHTML = "";
  (buttons || []).forEach(b => {
    const btn = document.createElement("button");
    btn.className = "btn" + (b.primary ? " btn-primary" : " btn-ghost");
    btn.textContent = b.label;
    btn.addEventListener("click", () => b.onClick && b.onClick());
    modalFooterEl.appendChild(btn);
  });
  modalOverlay.classList.add("open");
}

function closeModal() {
  modalOverlay.classList.remove("open");
}

modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

/* ============================================================
   TABLE UI: SORT / FILTER / COLUMN RESIZE
   Shared by all four data tables (Equity, Debt, Mutual Funds,
   Gold). Sorting and filtering only change which rows are
   displayed and in what order — totals/footer figures always
   come from the full underlying array, never the filtered view.
   Filtering is a single free-text box per tab that matches
   against every column's displayed value (not per-column
   filters), so one search box covers "any column" as requested.
   ============================================================ */

const tableUI = {
  equity: { sortCol: "allocPct", sortDir: -1, filter: "" },
  debt:   { sortCol: "maturityDate", sortDir: 1, filter: "" },
  mf:     { sortCol: "allocPct", sortDir: -1, filter: "" },
  gold:   { sortCol: null, sortDir: 1, filter: "" },
  stockanalysis: { sortCol: null, sortDir: 1, filter: "", page: 1, pageSize: "10" }
};

// Desktop Stock Analysis table shows tableUI.stockanalysis.pageSize
// holdings per page (person-selectable via the dropdown next to the
// pagination controls — 10/20/50/100/All), with Prev/Next + numbered
// pagination below the table. The mobile swipe-card deck reuses the
// exact same page slice (see renderStockAnalysis()) so desktop and
// mobile always agree on "what page am I on". "10" is just the
// starting default — STOCK_ANALYSIS_PAGE_SIZE_OPTIONS is the actual
// list of choices offered.
const STOCK_ANALYSIS_PAGE_SIZE_OPTIONS = ["10", "20", "50", "100", "all"];

// Resolves the current dropdown selection to a number of rows (or
// Infinity for "All"), used everywhere a page needs to be sliced.
function getStockAnalysisPageSize() {
  const v = tableUI.stockanalysis.pageSize;
  return v === "all" ? Infinity : (Number(v) || 10);
}

// Applies filter then sort to `rows`, given per-row lookup
// functions for search text and sortable values. Returns a new
// array — never mutates `rows` or state.
function applySortFilter(tableKey, rows, getSearchText, getSortValue) {
  const ui = tableUI[tableKey];
  let result = rows;
  if (ui.filter) {
    const q = ui.filter.toLowerCase();
    result = result.filter(row => getSearchText(row).toLowerCase().includes(q));
  }
  if (ui.sortCol) {
    result = [...result].sort((a, b) => {
      let va = getSortValue(a, ui.sortCol);
      let vb = getSortValue(b, ui.sortCol);
      if (typeof va === "string" || typeof vb === "string") {
        va = String(va ?? "").toLowerCase();
        vb = String(vb ?? "").toLowerCase();
        return va < vb ? -ui.sortDir : va > vb ? ui.sortDir : 0;
      }
      return ((va || 0) - (vb || 0)) * ui.sortDir;
    });
  }
  return result;
}

// Wires up click-to-sort on every `.sortable` header inside
// `theadSelector`, and live-filtering on `filterInputId`. Call
// once per table at init; re-render is the caller's job via
// `onChange`.
function setupSortAndFilter(tableKey, theadSelector, filterInputId, onChange) {
  document.querySelectorAll(`${theadSelector} th.sortable`).forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      const ui = tableUI[tableKey];
      if (ui.sortCol === col) {
        ui.sortDir = -ui.sortDir;
      } else {
        ui.sortCol = col;
        ui.sortDir = 1;
      }
      document.querySelectorAll(`${theadSelector} th.sortable`).forEach(h => h.classList.remove("sort-asc", "sort-desc"));
      th.classList.add(ui.sortDir === 1 ? "sort-asc" : "sort-desc");
      onChange();
    });
  });
  const filterInput = document.getElementById(filterInputId);
  filterInput.addEventListener("input", () => {
    tableUI[tableKey].filter = filterInput.value;
    onChange();
  });
}

// Marks the desktop header that matches tableUI[tableKey]'s current
// sortCol with the right asc/desc arrow — needed once at init since
// Equity/MF/Debt now start with a non-null default sort (Alloc % /
// Alloc % / Maturity Date) rather than "unsorted".
function markInitialSortIndicator(tableKey, theadSelector) {
  const ui = tableUI[tableKey];
  if (!ui.sortCol) return;
  const th = document.querySelector(`${theadSelector} th.sortable[data-col="${ui.sortCol}"]`);
  if (th) th.classList.add(ui.sortDir === 1 ? "sort-asc" : "sort-desc");
}

// Wires the mobile-only "Sort: <select>" + direction-toggle button
// that stands in for clicking a column header (headers aren't visible
// in the card layout). Reuses the exact same tableUI state the
// desktop click-to-sort headers use, and keeps those headers' arrow
// indicators in sync so switching between mobile/desktop widths (or
// just resizing the window) never shows stale state either way.
function setupMobileSort(tableKey, selectId, dirBtnId, theadSelector, onChange) {
  const select = document.getElementById(selectId);
  const dirBtn = document.getElementById(dirBtnId);
  if (!select) return;
  const ui = tableUI[tableKey];
  select.value = ui.sortCol || "";
  if (dirBtn) dirBtn.textContent = ui.sortDir === 1 ? "↑" : "↓";

  const syncDesktopHeaders = () => {
    document.querySelectorAll(`${theadSelector} th.sortable`).forEach(h => h.classList.remove("sort-asc", "sort-desc"));
    if (ui.sortCol) {
      const th = document.querySelector(`${theadSelector} th.sortable[data-col="${ui.sortCol}"]`);
      if (th) th.classList.add(ui.sortDir === 1 ? "sort-asc" : "sort-desc");
    }
  };

  select.addEventListener("change", () => {
    ui.sortCol = select.value || null;
    ui.sortDir = 1;
    if (dirBtn) dirBtn.textContent = "↑";
    syncDesktopHeaders();
    onChange();
  });
  if (dirBtn) {
    dirBtn.addEventListener("click", () => {
      if (!ui.sortCol) return;
      ui.sortDir = -ui.sortDir;
      dirBtn.textContent = ui.sortDir === 1 ? "↑" : "↓";
      syncDesktopHeaders();
      onChange();
    });
  }
}

// Wires a mobile "⋯" overflow toggle button to show/hide the
// secondary action buttons (Refresh, Import Excel, Import Zerodha,
// Import from Drive) that would otherwise crowd a phone-width
// toolbar. Desktop is unaffected — .toolbar-secondary is `display:
// contents` above the 700px breakpoint, so the buttons sit inline
// exactly as before and this toggle never even renders.
function setupOverflowToggle(toggleId, secondaryId) {
  const toggle = document.getElementById(toggleId);
  const secondary = document.getElementById(secondaryId);
  if (!toggle || !secondary) return;
  toggle.addEventListener("click", () => secondary.classList.toggle("open"));
}

// Wires a mobile floating "+" button to trigger the same "+ Add ..."
// button each tab already has — no separate add logic, just a
// second, thumb-reachable entry point into the existing handler.
function setupFabAdd(fabId, addBtnId) {
  const fab = document.getElementById(fabId);
  const addBtn = document.getElementById(addBtnId);
  if (!fab || !addBtn) return;
  fab.addEventListener("click", () => addBtn.click());
}

// Lightweight drag-to-resize for one column, via its <col>
// element (colId) and a resizer handle inside its header cell.
function setupColumnResize(colId, resizerSelector) {
  const col = document.getElementById(colId);
  const resizer = document.querySelector(resizerSelector);
  if (!col || !resizer) return;
  let startX = 0, startWidth = 0, dragging = false;

  function onMove(clientX) {
    const delta = clientX - startX;
    const newWidth = Math.max(90, startWidth + delta);
    col.style.width = newWidth + "px";
  }

  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = col.getBoundingClientRect().width;
    resizer.classList.add("resizing");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (dragging) onMove(e.clientX);
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    resizer.classList.remove("resizing");
  });

  resizer.addEventListener("touchstart", (e) => {
    dragging = true;
    startX = e.touches[0].clientX;
    startWidth = col.getBoundingClientRect().width;
    resizer.classList.add("resizing");
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (dragging) onMove(e.touches[0].clientX);
  }, { passive: true });
  window.addEventListener("touchend", () => {
    dragging = false;
    resizer.classList.remove("resizing");
  });
}

// Wires every "✕" clear button (see .filter-clear-btn in index.html)
// generically: shows the button only once its paired <input> has text,
// and clicking it clears the value, re-fires the exact same "input"
// event the person typing would have fired (so each tab's own
// setupSortAndFilter()/setupMobileSort() listener — unchanged — picks
// it up and re-renders that tab's table), then returns focus to the
// input. One function covers Equity/Debt/Mutual Funds/Gold/Stock
// Analysis without any tab-specific code.
function setupFilterClearButtons() {
  document.querySelectorAll(".filter-clear-btn").forEach(btn => {
    const input = document.getElementById(btn.dataset.clearTarget);
    if (!input) return;
    const wrap = btn.closest(".filter-clear-wrap, .sa-search-wrap");
    const syncVisibility = () => { if (wrap) wrap.classList.toggle("has-value", !!input.value); };
    syncVisibility();
    input.addEventListener("input", syncVisibility);
    btn.addEventListener("click", () => {
      input.value = "";
      syncVisibility();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
  });
}

// Finds an existing row in `array` via `matchFn` and merges
// `updateFields` into it (preserving id and any field not being
// imported, e.g. a live-fetched price); otherwise pushes a new
// row with a fresh id, `updateFields`, and `newExtraFields`
// (defaults that only apply to brand-new rows, e.g. ltp: 0).
function upsertRow(array, matchFn, updateFields, newExtraFields) {
  const existing = array.find(matchFn);
  if (existing) {
    Object.assign(existing, updateFields);
    return "updated";
  }
  array.push({ id: uid(), ...updateFields, ...(newExtraFields || {}) });
  return "added";
}

/* ============================================================
   TAB SWITCHING
   ============================================================ */

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "dashboard") renderDashboard();
    if (btn.dataset.tab === "insights") renderInsights();
    if (btn.dataset.tab === "stockanalysis") renderStockAnalysis();
  });
});

// Dashboard primary actions — "Edit targets" and "Rebalance portfolio"
// both open the same allocation-target editor; "View opportunities"
// (both the attention-panel and footer buttons) and "View all
// opportunities" jump to Stock Analysis, where Intelligent Insights
// lives in full.
document.getElementById("btnEditTargets")?.addEventListener("click", openIdealTargetsModal);
document.getElementById("btnDashRebalance")?.addEventListener("click", openIdealTargetsModal);
document.getElementById("dashAllocAlertBtn")?.addEventListener("click", openIdealTargetsModal);
document.getElementById("btnDashAddMoney")?.addEventListener("click", openAddMoneyModal);
document.getElementById("btnDashViewOpportunities")?.addEventListener("click", () => goToTab("stockanalysis"));
document.getElementById("dashAttnFilter")?.addEventListener("change", (e) => {
  dashAttnFilter = e.target.value;
  renderDashAttention();
});
document.getElementById("btnViewAllOpportunities")?.addEventListener("click", () => goToTab("stockanalysis"));

/* ============================================================
   APP SHELL — sidebar drawer (mobile), bottom nav mirroring the
   sidebar's tabs, header quick-actions (Rebalance/Opportunities/
   search/notifications). Everything here is additive: it reuses
   the existing tab-btn / goToTab / openIdealTargetsModal wiring
   above rather than duplicating any panel-switching logic.
   ============================================================ */

function setSidebarOpen(open) {
  document.getElementById("sidebar")?.classList.toggle("open", open);
  document.getElementById("sidebarBackdrop")?.classList.toggle("open", open);
}
document.getElementById("hamburgerBtn")?.addEventListener("click", () => setSidebarOpen(true));
document.getElementById("sidebarBackdrop")?.addEventListener("click", () => setSidebarOpen(false));

// Keep the mobile bottom bar's active icon in sync with whichever
// sidebar tab is active, and close the drawer once a destination is
// picked — the actual panel switch still happens entirely through
// the existing .tab-btn click handler above.
function syncMobileNavActive(tabKey) {
  document.querySelectorAll(".mobile-bottom-nav-item[data-tab]").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === tabKey);
  });
}
document.querySelectorAll(".tab-btn[data-tab]").forEach(btn => {
  btn.addEventListener("click", () => {
    syncMobileNavActive(btn.dataset.tab);
    setSidebarOpen(false);
  });
});
document.querySelectorAll(".mobile-bottom-nav-item[data-tab]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelector(`.tab-btn[data-tab="${btn.dataset.tab}"]`)?.click();
  });
});
document.getElementById("mobileMoreBtn")?.addEventListener("click", () => setSidebarOpen(true));

// Rebalance / Opportunities sidebar entries — real, existing features
// (the ideal-% editor and Intelligent Insights) surfaced as top-level
// nav items instead of being buried in Dashboard-only buttons.
document.getElementById("navRebalance")?.addEventListener("click", () => {
  setSidebarOpen(false);
  openIdealTargetsModal();
});
document.getElementById("navOpportunities")?.addEventListener("click", () => {
  setSidebarOpen(false);
  goToTab("stockanalysis");
  setTimeout(() => document.getElementById("intelligentInsightsCard")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
});

// Notification bell — jumps to Dashboard's "What needs your
// attention" card. The badge count itself is kept current by
// renderDashAttention() (see updateNotifBadge() below), so it always
// reflects the same computeAttentionItems() list that card shows.
document.getElementById("notifBtn")?.addEventListener("click", () => {
  goToTab("dashboard");
  setTimeout(() => {
    const card = document.getElementById("dashAttnCard");
    if (card && !card.classList.contains("expanded")) {
      card.classList.add("expanded");
      document.getElementById("dashAttnToggle")?.setAttribute("aria-expanded", "true");
    }
    card?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 150);
});

function updateNotifBadge(count) {
  const badge = document.getElementById("notifBadge");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? "9+" : String(count);
    badge.style.display = "";
  } else {
    badge.style.display = "none";
  }
}

// Small count badge shown next to "What needs your attention" on both
// Dashboard and Debt — lets the person see at a glance whether there's
// anything to look at without expanding the (collapsed-by-default)
// card. Same show/hide-at-zero behavior as updateNotifBadge above.
function updateAttnCountBadge(id, count) {
  const badge = document.getElementById(id);
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? "9+" : String(count);
    badge.style.display = "";
  } else {
    badge.style.display = "none";
  }
}

// "What needs your attention" (Dashboard + Debt) is collapsed by
// default — this wires the chevron/title button that expands it in
// place. Purely a CSS class toggle (.expanded on the card); the list
// underneath keeps rendering/updating regardless of collapsed state.
function setupAttentionToggle(cardId, toggleId) {
  const card = document.getElementById(cardId);
  const toggle = document.getElementById(toggleId);
  if (!card || !toggle) return;
  toggle.addEventListener("click", () => {
    const expanded = card.classList.toggle("expanded");
    toggle.setAttribute("aria-expanded", String(expanded));
  });
}

// Global header search — quick-jump to a holding by name/symbol
// across Equity, Mutual Funds, Gold and Debt. Reuses each tab's own
// existing filter input/logic (setupSortAndFilter already wires
// input->render for each) rather than reimplementing search: this
// just opens the right tab, fills that tab's filter box, and fires
// the same "input" event the user typing there would.
function runGlobalSearch(query) {
  const q = query.trim();
  if (!q) return;
  const qLower = q.toLowerCase();
  const matchers = [
    { key: "equity", rows: state.equity, fields: ["name", "symbol"], filterId: "equityFilter" },
    { key: "mf", rows: state.mf, fields: ["name"], filterId: "mfFilter" },
    { key: "gold", rows: state.gold, fields: ["name", "symbol"], filterId: "goldFilter" },
    { key: "debt", rows: state.debt, fields: ["name", "category", "subcategory"], filterId: "debtFilter" }
  ];
  const hit = matchers.find(m => (m.rows || []).some(r => m.fields.some(f => (r[f] || "").toLowerCase().includes(qLower))));
  if (!hit) return;
  goToTab(hit.key);
  setTimeout(() => {
    const input = document.getElementById(hit.filterId);
    if (!input) return;
    input.value = q;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }, 150);
}
document.getElementById("globalSearch")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runGlobalSearch(e.target.value);
});

/* ============================================================
   PORTFOLIO LOCK
   Locks manual editing of Quantity/Units and Average Price/
   Invested on Equity, Mutual Funds and Gold — those three fields
   are exactly what Import Zerodha Holdings overwrites, so locking
   forces updates to go through that one path. Name, notes,
   remarks, category, and add/remove row stay editable either way.
   ============================================================ */

function updateLockButton() {
  const btn = document.getElementById("btnLockPortfolio");
  if (state.portfolioLocked) {
    btn.textContent = "🔒 Locked";
    btn.classList.add("locked");
    btn.title = "Portfolio locked — Debt fields, Cash on hand, Ideal %, and the Sector/Remarks/Notes fields on Equity/Mutual Funds/Gold are read-only until unlocked. (Equity/MF/Gold's other fields are always driven by Import Holdings and live-price refresh, locked or not.) Click to unlock.";
  } else {
    btn.textContent = "🔓 Unlocked";
    btn.classList.remove("locked");
    btn.title = "Click to lock Debt, Cash, Ideal %, and Equity/MF/Gold's Sector/Remarks/Notes fields against accidental edits.";
  }
}

document.getElementById("btnLockPortfolio").addEventListener("click", () => {
  state.portfolioLocked = !state.portfolioLocked;
  saveState();
  updateLockButton();
  renderEquity();
  renderDebt();
  renderMF();
  renderGold();
  renderDashboard();
});

/* ============================================================
   EQUITY TAB
   ============================================================ */

function equityDerived(row) {
  const invested = Number(row.invested) || 0;
  const units = Number(row.units) || 0;
  const ltp = Number(row.ltp) || 0;
  const avgPrice = units > 0 ? invested / units : 0;
  const currentValue = units * ltp;
  const pl = currentValue - invested;
  const plPct = invested > 0 ? (pl / invested) * 100 : 0;
  return { avgPrice, currentValue, pl, plPct };
}

function equityTotals() {
  let invested = 0, current = 0;
  state.equity.forEach(r => {
    invested += Number(r.invested) || 0;
    current += equityDerived(r).currentValue;
  });
  const pl = current - invested;
  const plPct = invested > 0 ? (pl / invested) * 100 : 0;
  return { invested, current, pl, plPct };
}

// Equity's Cap (Large/Mid/Small) column reuses the exact same Screener
// join and marketCapCategory() classifier the Stock Analysis tab uses
// — matched by Symbol (row.name), via buildScreenerMap()/
// marketCapCategory() defined near the Stock Analysis code below (both
// are plain function declarations, so they're available here
// regardless of file order). Returns null (rendered as a dash) until
// Screener data has been imported for that symbol.
function getEquityCapCategory(row, screenerMap) {
  const screener = screenerMap.get((row.name || "").trim().toUpperCase());
  return marketCapCategory(screener ? screener.market_cap : null);
}

// Looks up the configured max allocation % for a stock's cap category
// (Settings -> Equity Allocation Limits, falling back to
// DEFAULT_EQUITY_ALLOC_LIMITS). Returns null when the cap category
// itself isn't known yet (no Screener match) — callers should treat
// null as "no limit to compare against", not as 0%.
function getEquityAllocLimit(capCategory) {
  const limits = state.equityAllocLimits || DEFAULT_EQUITY_ALLOC_LIMITS;
  if (capCategory === "Large Cap") return Number(limits.large) || 0;
  if (capCategory === "Mid Cap") return Number(limits.mid) || 0;
  if (capCategory === "Small Cap") return Number(limits.small) || 0;
  return null;
}

// Overall target % for a WHOLE market-cap category's share of the
// total Equity portfolio (e.g. Large Cap ~70%) — distinct from
// getEquityAllocLimit() above, which caps a single stock's share.
// Falls back to DEFAULT_EQUITY_CAP_ALLOC_TARGETS. Returns null when
// the cap category itself isn't known.
function getEquityCapAllocTarget(capCategory) {
  const targets = state.equityCapAllocTargets || DEFAULT_EQUITY_CAP_ALLOC_TARGETS;
  if (capCategory === "Large Cap") return Number(targets.large) || 0;
  if (capCategory === "Mid Cap") return Number(targets.mid) || 0;
  if (capCategory === "Small Cap") return Number(targets.small) || 0;
  return null;
}

// Classifies a stock's current (invested-based) allocation % against
// its configured max: "within" (<=80% of the limit), "approaching"
// (80-100% of the limit), or "above" (over the limit). Returns null
// when maxPct is null (cap category unknown) so callers can render a
// plain, unstyled cell rather than guess a status.
function allocLimitStatus(allocPct, maxPct) {
  if (maxPct === null || maxPct === undefined || maxPct <= 0) return null;
  if (allocPct > maxPct) return "above";
  if (allocPct >= maxPct * 0.8) return "approaching";
  return "within";
}

function allocLimitStatusLabel(status) {
  switch (status) {
    case "within": return "Within allocation";
    case "approaching": return "Approaching limit";
    case "above": return "Above recommended limit";
    default: return "";
  }
}

function equityGetSearchText(row, screenerMap) {
  const d = equityDerived(row);
  const cap = getEquityCapCategory(row, screenerMap);
  return [row.name, row.invested, row.units, d.avgPrice, row.ltp, d.currentValue, d.pl, d.plPct, row.sector, cap].join(" ");
}

function equityGetSortValue(row, col, screenerMap) {
  const d = equityDerived(row);
  switch (col) {
    case "name": return row.name || "";
    case "invested": return Number(row.invested) || 0;
    case "units": return Number(row.units) || 0;
    case "avgPrice": return d.avgPrice;
    case "ltp": return Number(row.ltp) || 0;
    case "dayChangePct": return dayChangePct(row.ltp, row.prevClose) ?? -Infinity;
    case "currentValue": return d.currentValue;
    case "pl": return d.pl;
    case "plPct": return d.plPct;
    case "allocPct": return Number(row.invested) || 0; // alloc% is invested-based, same sort order
    case "sector": return row.sector || "";
    case "capCategory": return getEquityCapCategory(row, screenerMap) || "";
    default: return 0;
  }
}

function renderEquity() {
  const tbody = document.getElementById("equityTableBody");
  tbody.innerHTML = "";
  const totals = equityTotals();
  // Built once per render and threaded through the search/sort
  // closures below, rather than rebuilt per row — buildScreenerMap()
  // is the same lookup Stock Analysis uses.
  const screenerMap = buildScreenerMap();
  const displayRows = applySortFilter(
    "equity", state.equity,
    (row) => equityGetSearchText(row, screenerMap),
    (row, col) => equityGetSortValue(row, col, screenerMap)
  );

  if (state.equity.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="13">No stocks yet. Use "Import Holdings" to bring in your Zerodha Console export.</td></tr>';
  } else if (displayRows.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="13">No stocks match this filter.</td></tr>';
  }

  // Name, Invested, Units and LTP are only ever meant to change via
  // Zerodha Holdings import or the automatic live-price refresh now —
  // they're permanently read-only regardless of the Lock Portfolio
  // toggle. Sector is the one field left for manual annotation, and
  // still follows the Lock Portfolio toggle like the rest of the app.
  const notesLocked = isReadOnly();
  displayRows.forEach(row => {
    const d = equityDerived(row);
    // Alloc % reflects each stock's share of total invested capital,
    // not its share of current market value.
    const allocPct = totals.invested > 0 ? (Number(row.invested) / totals.invested) * 100 : 0;
    const capCategory = getEquityCapCategory(row, screenerMap);
    const allocMax = getEquityAllocLimit(capCategory);
    const allocStatus = allocLimitStatus(allocPct, allocMax);
    const allocCellClass = allocStatus ? `c-alloc alloc-${allocStatus}` : "c-alloc";
    const allocTitle = allocStatus
      ? `${allocLimitStatusLabel(allocStatus)} — limit ${allocMax}% (${capCategory})`
      : "Import Screener Data to classify this stock's cap category and see its allocation limit";
    const allocLimitNote = allocMax !== null ? `<span class="alloc-limit-note">/ ${allocMax}%</span>` : "";
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td class="left sticky-col"><input type="text" value="${escapeAttr(row.name || "")}" data-field="name" placeholder="e.g. TCS.NS" disabled></td>
      <td class="left" data-label="Sector"><input type="text" value="${escapeAttr(row.sector || "")}" data-field="sector" placeholder="e.g. IT" ${notesLocked ? "disabled" : ""}></td>
      <td class="left" data-label="Cap">${capCategory ? escapeAttr(capCategory) : '<span class="muted">—</span>'}</td>
      <td data-label="Invested Amt"><input type="number" step="any" value="${roundedInputValue(row.invested)}" data-field="invested" disabled></td>
      <td data-label="Units"><input type="number" step="any" value="${roundedInputValue(row.units)}" data-field="units" disabled></td>
      <td class="c-avg" data-label="Avg Price">${fmtNum(d.avgPrice)}</td>
      <td data-label="LTP">${renderEquityPriceCellHTML(row)}</td>
      <td class="c-daychg" data-label="Day Chg %">${renderEquityDayChangeCellHTML(row)}</td>
      <td class="c-cv" data-label="Current Value">${fmtNum(d.currentValue)}</td>
      <td class="c-pl ${plClass(d.pl)}" data-label="P&amp;L">${fmtNum(d.pl)}</td>
      <td class="c-plpct ${plClass(d.pl)}" data-label="P&amp;L %">${fmtPct(d.plPct)}</td>
      <td class="${allocCellClass}" data-label="Alloc %" title="${escapeAttr(allocTitle)}">${fmtNum(allocPct)}%${allocLimitNote}</td>
      <td class="row-actions"><button class="icon-btn" title="Remove">✕</button></td>
    `;
    tr.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("change", () => {
        const field = inp.dataset.field;
        row[field] = (field === "name" || field === "sector") ? inp.value : parseFloat(inp.value) || 0;
        saveState();
        updateEquityComputed();
        renderDashboard();
      });
    });
    tr.querySelector(".icon-btn").addEventListener("click", () => {
      state.equity = state.equity.filter(r => r.id !== row.id);
      saveState();
      renderEquity();
      renderDashboard();
    });
    tbody.appendChild(tr);
  });

  document.getElementById("eqTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("eqTotalCurrent").textContent = fmtINR(totals.current);
  const plCell = document.getElementById("eqTotalPL");
  plCell.textContent = fmtINR(totals.pl);
  plCell.className = plClass(totals.pl);
  const plPctCell = document.getElementById("eqTotalPLPct");
  plPctCell.textContent = fmtPct(totals.plPct);
  plPctCell.className = plClass(totals.pl);
  document.getElementById("eqMobTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("eqMobTotalCurrent").textContent = fmtINR(totals.current);
  const mobPlCell = document.getElementById("eqMobTotalPL");
  mobPlCell.textContent = fmtINR(totals.pl);
  mobPlCell.className = plClass(totals.pl);
  renderEquityMoversStrip();
}

// Lightweight refresh used on every keystroke-commit (input `change`):
// updates only the read-only derived cells and footer totals, and never
// touches the <input> elements themselves — so focus/Tab order across
// fields in the same row (and across rows) is never disturbed.
function updateEquityComputed() {
  const tbody = document.getElementById("equityTableBody");
  const totals = equityTotals();
  const screenerMap = buildScreenerMap();
  state.equity.forEach(row => {
    const tr = tbody.querySelector(`tr[data-id="${row.id}"]`);
    if (!tr) return;
    const d = equityDerived(row);
    const allocPct = totals.invested > 0 ? (Number(row.invested) / totals.invested) * 100 : 0;
    tr.querySelector(".c-avg").textContent = fmtNum(d.avgPrice);
    tr.querySelector(".c-cv").textContent = fmtNum(d.currentValue);
    const plCell = tr.querySelector(".c-pl");
    plCell.textContent = fmtNum(d.pl);
    plCell.className = "c-pl " + plClass(d.pl);
    const plPctCell = tr.querySelector(".c-plpct");
    plPctCell.textContent = fmtPct(d.plPct);
    plPctCell.className = "c-plpct " + plClass(d.pl);
    const capCategory = getEquityCapCategory(row, screenerMap);
    const allocMax = getEquityAllocLimit(capCategory);
    const allocStatus = allocLimitStatus(allocPct, allocMax);
    const allocCell = tr.querySelector(".c-alloc");
    allocCell.className = allocStatus ? `c-alloc alloc-${allocStatus}` : "c-alloc";
    allocCell.title = allocStatus
      ? `${allocLimitStatusLabel(allocStatus)} — limit ${allocMax}% (${capCategory})`
      : "Import Screener Data to classify this stock's cap category and see its allocation limit";
    allocCell.innerHTML = `${fmtNum(allocPct)}%${allocMax !== null ? `<span class="alloc-limit-note">/ ${allocMax}%</span>` : ""}`;
  });
  document.getElementById("eqTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("eqTotalCurrent").textContent = fmtINR(totals.current);
  const plCell = document.getElementById("eqTotalPL");
  plCell.textContent = fmtINR(totals.pl);
  plCell.className = plClass(totals.pl);
  const plPctCell = document.getElementById("eqTotalPLPct");
  plPctCell.textContent = fmtPct(totals.plPct);
  plPctCell.className = plClass(totals.pl);
  document.getElementById("eqMobTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("eqMobTotalCurrent").textContent = fmtINR(totals.current);
  const mobPlCell = document.getElementById("eqMobTotalPL");
  mobPlCell.textContent = fmtINR(totals.pl);
  mobPlCell.className = plClass(totals.pl);
  renderEquityMoversStrip();
}

// Equity rows are no longer created by hand — Name, Invested, Units
// and LTP are all driven by Zerodha Holdings import (new symbols get
// added automatically there) plus the automatic live-price refresh,
// so there's no "+ Add stock" entry point left in the UI.

/* ---- live price fetch: shared Google Sheet CSV helpers ----
   All three asset classes (Stocks, Mutual Funds, Gold ETFs) use
   the same mechanism: one JSON fetch to Ganesh's Apps Script Web
   App (kept fresh by its own time-driven trigger), which returns
   { stocks: [...], mf: [...], gold: [...] } — each row keyed by
   that tab's actual header text. Rows are matched flexibly: a
   price gets indexed under every identifier column found (e.g.
   both "Stock Name" = WIPRO and "Symbol" = NSE:WIPRO), so typing
   either into the app's Name/Symbol field will find it. */

// Turns a tagged error into a message that actually points at the
// cause, instead of one generic string for every kind of failure.
function sheetErrorMessage(e) {
  return "Could not update: " + (e && e.message ? e.message : "unknown error");
}

async function fetchPriceData() {
  let res;
  try {
    res = await fetch(state.priceApiUrl, { cache: "no-store" });
  } catch (networkErr) {
    const e = new Error("Network/CORS: the browser blocked or couldn't complete this request.");
    e.kind = "network";
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Price API returned HTTP ${res.status}. Check the Apps Script Web App deployment is still active and set to "Anyone" access.`);
    e.kind = "http";
    throw e;
  }
  let json;
  try {
    json = await res.json();
  } catch (parseErr) {
    const e = new Error("The Price API didn't return valid JSON — check the doGet() script for errors (try opening the /exec URL directly in a browser tab).");
    e.kind = "parse";
    throw e;
  }
  return json;
}

// Fetches the Drive-scanned Zerodha Holdings JSON from state.holdingsApiUrl.
// Mirrors fetchPriceData()'s error handling/messages exactly, but is a
// fully separate function since it talks to a separate Apps Script
// deployment — a failure here should never be confused with a
// Price API failure in the UI's error text.
async function fetchHoldingsData() {
  let res;
  try {
    res = await fetch(state.holdingsApiUrl, { cache: "no-store" });
  } catch (networkErr) {
    const e = new Error("Network/CORS: the browser blocked or couldn't complete this request.");
    e.kind = "network";
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Holdings API returned HTTP ${res.status}. Check the Apps Script Web App deployment is still active and set to "Anyone" access.`);
    e.kind = "http";
    throw e;
  }
  let json;
  try {
    json = await res.json();
  } catch (parseErr) {
    const e = new Error("The Holdings API didn't return valid JSON — check the doGet() script for errors (try opening the /exec URL directly in a browser tab).");
    e.kind = "parse";
    throw e;
  }
  // doGet() reports its own errors (e.g. "no .xlsx in folder") as
  // { error: "..." } with an HTTP 200, since Apps Script Web Apps
  // can't easily return non-200 status codes — surface that the
  // same way a network/HTTP failure would be.
  if (json && json.error) {
    const e = new Error(json.error);
    e.kind = "app";
    throw e;
  }
  return json;
}

// Fetches the Nifty History JSON from state.niftyHistoryApiUrl — a
// separate, small Apps Script Web App (see nifty_daily_capture.gs's
// doGet()) bound to the "Nifty Live (helper)" sheet, deployed
// separately from the main Price/Holdings scripts above. Mirrors
// their error handling exactly. Returns { date: 'YYYY-MM-DD', close:
// number }[] sorted ascending by date (de-duplicated by date, keeping
// the last row for any repeat — defensive against the capture script
// ever writing a day twice).
async function fetchNiftyHistoryData() {
  if (!state.niftyHistoryApiUrl) {
    const e = new Error('No Nifty History API URL set — add one in Settings under "Portfolio Performance Chart".');
    e.kind = "unset";
    throw e;
  }
  let res;
  try {
    res = await fetch(state.niftyHistoryApiUrl, { cache: "no-store" });
  } catch (networkErr) {
    const e = new Error("Network/CORS: the browser blocked or couldn't complete this request.");
    e.kind = "network";
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Nifty History API returned HTTP ${res.status}. Check the Apps Script Web App deployment is still active and set to "Anyone" access.`);
    e.kind = "http";
    throw e;
  }
  let json;
  try {
    json = await res.json();
  } catch (parseErr) {
    const e = new Error("The Nifty History API didn't return valid JSON — check the doGet() script for errors (try opening the /exec URL directly in a browser tab).");
    e.kind = "parse";
    throw e;
  }
  if (!json || !Array.isArray(json.niftyHistory)) {
    const e = new Error('The Nifty History API response is missing a "niftyHistory" array — check the doGet() script matches nifty_daily_capture.gs.');
    e.kind = "parse";
    throw e;
  }
  const byDate = new Map();
  json.niftyHistory.forEach(r => {
    const d = String(r.date || "").slice(0, 10);
    const close = Number(r.close);
    if (d && !isNaN(close)) byDate.set(d, close); // later row for the same date wins
  });
  return [...byDate.entries()].map(([date, close]) => ({ date, close })).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

// Header spellings accepted for each new live market-data column added to
// the Apps Script sheet (Previous Close / Open Price / Day High / Day Low /
// 52W High / 52W Low). Matched case-insensitively, same convention as every
// other header lookup in this file (buildMFCategoryMap, toHoldingRecord,
// etc.) — column order in the sheet never matters.
const MARKET_DATA_FIELD_CANDIDATES = {
  prevClose: ["Previous Close", "Prev Close", "PrevClose"],
  open: ["Open Price", "Open"],
  dayHigh: ["Day High", "High"],
  dayLow: ["Day Low", "Low"],
  high52: ["52W High", "52 Week High", "52WHigh", "High 52W"],
  low52: ["52W Low", "52 Week Low", "52WLow", "Low 52W"]
};

// Builds a Map from every identifier column found (uppercased, trimmed) to
// that row's cleaned OHLC/52W figures — mirrors buildPriceMap()'s id-matching
// convention (Stock Name or Symbol) so the same `state.equity` name lookup
// already used for LTP also finds this data. A field that isn't present or
// isn't parseable comes back null (not 0) so callers can leave the
// last-saved value alone instead of clobbering it — see refreshEquityPrices().
function buildMarketDataMap(rows, idCandidates) {
  const map = new Map();
  if (!Array.isArray(rows)) return map;
  rows.forEach(obj => {
    const keys = Object.keys(obj);
    const findVal = (candidates) => {
      const k = keys.find(k => candidates.some(c => c.toLowerCase() === k.trim().toLowerCase()));
      return k !== undefined ? parseIndianNumber(obj[k]) : null;
    };
    let idVal = "";
    for (const idName of idCandidates) {
      const idKey = keys.find(k => k.trim().toLowerCase() === idName.toLowerCase());
      if (idKey && String(obj[idKey] || "").trim()) { idVal = String(obj[idKey]).trim().toUpperCase(); break; }
    }
    if (!idVal) return;
    map.set(idVal, {
      prevClose: findVal(MARKET_DATA_FIELD_CANDIDATES.prevClose),
      open: findVal(MARKET_DATA_FIELD_CANDIDATES.open),
      dayHigh: findVal(MARKET_DATA_FIELD_CANDIDATES.dayHigh),
      dayLow: findVal(MARKET_DATA_FIELD_CANDIDATES.dayLow),
      high52: findVal(MARKET_DATA_FIELD_CANDIDATES.high52),
      low52: findVal(MARKET_DATA_FIELD_CANDIDATES.low52)
    });
  });
  return map;
}

// Day Change % is always derived here from LTP + Previous Close — never
// read as a separately-supplied percentage column, per spec. Returns null
// (renders as a dash) rather than 0 when either side isn't usable yet, so
// "no data" is never shown as "unchanged".
function dayChangePct(ltp, prevClose) {
  const p = Number(prevClose);
  const l = Number(ltp);
  if (!p || p <= 0 || !l || l <= 0) return null;
  return ((l - p) / p) * 100;
}

// Compact green/red/neutral badge used next to LTP on both Equity and
// Stock Analysis — a single shared renderer so the two tabs' badges never
// drift apart visually. `stale` marks a row whose OHLC/52W fields didn't
// all come back on the last refresh (LTP/Day Change can still be current
// even when e.g. 52W High briefly failed) — shown as a small dot with an
// explanatory title rather than hiding or guessing the value.
function renderDayChangeBadgeHTML(ltp, prevClose, stale) {
  const chg = dayChangePct(ltp, prevClose);
  if (chg === null) return '<span class="dc-badge muted">—</span>';
  const cls = chg > 0 ? "pos" : chg < 0 ? "neg" : "muted";
  const arrow = chg > 0 ? "▲" : chg < 0 ? "▼" : "•";
  const staleTitle = stale ? "Some live fields could not refresh this cycle — showing last known values." : "";
  return `<span class="dc-badge ${cls}"${staleTitle ? ` title="${escapeAttr(staleTitle)}"` : ""}>${arrow} ${chg >= 0 ? "+" : ""}${fmtNum(chg, 2)}%${stale ? '<span class="dc-stale-dot">•</span>' : ""}</span>`;
}

// Builds a Map from every identifier column found (uppercased,
// trimmed) to the parsed price, so a stock can be matched by
// either its plain name or its Google Finance-style symbol.
function buildPriceMap(rows, idCandidates, priceCandidates) {
  const map = new Map();
  if (!Array.isArray(rows)) return map;
  rows.forEach(obj => {
    const keys = Object.keys(obj);
    const priceKey = keys.find(k => priceCandidates.some(c => c.toLowerCase() === k.trim().toLowerCase()));
    if (!priceKey) return;
    const price = parseFloat(obj[priceKey]);
    if (isNaN(price)) return;
    idCandidates.forEach(idName => {
      const idKey = keys.find(k => k.trim().toLowerCase() === idName.toLowerCase());
      if (!idKey) return;
      const idVal = String(obj[idKey] || "").trim().toUpperCase();
      if (idVal) map.set(idVal, price);
    });
  });
  return map;
}

// Builds a Map from fund name (uppercased, trimmed) to whatever
// Symbol/Category/Sub-category the live-price sheet's Mutual Funds
// tab has for that fund. Column matching is flexible on the
// sub-category header specifically, since the sheet has a known
// typo ("Sub-cateogry") — matches either spelling.
function buildMFCategoryMap(rows) {
  const map = new Map();
  if (!Array.isArray(rows)) return map;
  rows.forEach(obj => {
    const keys = Object.keys(obj);
    const findVal = (candidates) => {
      const k = keys.find(k => candidates.some(c => c.toLowerCase() === k.trim().toLowerCase()));
      return k ? String(obj[k] ?? "").trim() : "";
    };
    const name = findVal(["MF Name", "Name"]);
    if (!name) return;
    map.set(name.toUpperCase(), {
      symbol: findVal(["Symbol"]),
      category: findVal(["Category"]),
      subcategory: findVal(["Sub-category", "Sub-cateogry", "Subcategory", "Sub category"])
    });
  });
  return map;
}

/* ---- live price fetch: stocks ---- */

// Renders a small panel of per-row refresh failures under a tab's
// toolbar — investment name, asset type, the key that was looked
// up, and a suggested fix — so a failed refresh points at what to
// check instead of just a "3 failed" count.
function renderFailPanel(panelId, assetType, failedRows) {
  const panel = document.getElementById(panelId);
  if (!failedRows || failedRows.length === 0) {
    panel.style.display = "none";
    panel.innerHTML = "";
    return;
  }
  panel.style.display = "block";
  panel.innerHTML = `
    <h4>Live Price Refresh — ${failedRows.length} symbol(s) not matched</h4>
    <table>
      <thead><tr><th class="left">Name</th><th class="left">Asset Type</th><th class="left">Lookup Key Used</th><th class="left">Suggested Action</th></tr></thead>
      <tbody>
        ${failedRows.map(f => `
          <tr>
            <td class="left" data-label="Name">${escapeAttr(f.name)}</td>
            <td class="left" data-label="Asset Type">${assetType}</td>
            <td class="left" data-label="Lookup Key Used">${escapeAttr(f.key || "(blank)")}</td>
            <td class="left" data-label="Suggested Action">Verify the Google Finance ticker or update the symbol mapping in your Apps Script sheet.</td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;
}

// Shared worker: fetches prices and applies them to state.equity.
// Returns { ok, fail, failedRows } so both the button handler and
// the on-load auto-refresh can use the same logic and reporting.
async function refreshEquityPrices() {
  if (state.equity.length === 0) return { ok: 0, fail: 0, failedRows: [], skipped: true };
  const data = await fetchPriceData();
  const priceMap = buildPriceMap(data.stocks, ["Stock Name", "Symbol"], ["Live Price", "Price"]);
  // Same data.stocks payload, same identifier columns — just reading the
  // extra Previous Close/Open/Day High/Day Low/52W High/52W Low columns
  // that have now been added to the sheet. No separate fetch/endpoint.
  const marketDataMap = buildMarketDataMap(data.stocks, ["Stock Name", "Symbol"]);
  let ok = 0;
  const failedRows = [];
  state.equity.forEach(row => {
    const key = (row.name || "").trim().toUpperCase();
    if (key && priceMap.has(key)) {
      row.ltp = priceMap.get(key);
      row.livePricePending = false;
      const md = marketDataMap.get(key);
      // Only overwrite a field when this refresh actually returned a
      // usable number for it — an individually blank/unparseable column
      // (e.g. 52W High momentarily empty) leaves that one field at its
      // last saved value instead of wiping it, per the "keep the last
      // valid value" requirement. row.marketDataStale flags the row
      // whenever any of the six fields didn't come back this cycle, so
      // the UI can show a small "stale" indicator without hiding data.
      if (md) {
        if (md.prevClose !== null) row.prevClose = md.prevClose;
        if (md.open !== null) row.openPrice = md.open;
        if (md.dayHigh !== null) row.dayHigh = md.dayHigh;
        if (md.dayLow !== null) row.dayLow = md.dayLow;
        if (md.high52 !== null) row.high52Live = md.high52;
        if (md.low52 !== null) row.low52Live = md.low52;
        row.marketDataStale = [md.prevClose, md.open, md.dayHigh, md.dayLow, md.high52, md.low52].some(v => v === null);
      } else {
        row.marketDataStale = true;
      }
      ok++;
    } else {
      failedRows.push({ name: row.name || "(unnamed)", key });
      row.marketDataStale = true;
    }
  });
  saveState();
  return { ok, fail: failedRows.length, failedRows };
}

// Plain LTP cell used on the Equity tab — just the price input + a
// Pending badge. Day Change % now lives in its own sortable column
// (see renderEquityDayChangeCellHTML() below) instead of being crammed
// underneath the price input.
function renderEquityPriceCellHTML(row) {
  const pendingBadge = row.livePricePending ? '<span class="pending-badge">Pending</span>' : "";
  return `
    <div class="price-cell">
      <input type="number" step="any" value="${roundedInputValue(row.ltp)}" data-field="ltp" disabled>${pendingBadge}
    </div>
  `;
}

// Standalone "Day Chg %" column cell — a modern rounded chip (colored
// by direction) plus a small Previous Close line underneath, with the
// full OHLC/52W breakdown available as a hover tooltip. Splitting this
// out of the LTP cell into its own column is what makes it sortable
// (see data-col="dayChangePct" in the table header) and gives it room
// to read clearly instead of being squeezed under the price input.
function renderEquityDayChangeCellHTML(row) {
  const chg = dayChangePct(row.ltp, row.prevClose);
  const tipParts = [];
  if (row.openPrice != null) tipParts.push(`Open ${fmtNum(row.openPrice, 2)}`);
  if (row.dayHigh != null) tipParts.push(`Day High ${fmtNum(row.dayHigh, 2)}`);
  if (row.dayLow != null) tipParts.push(`Day Low ${fmtNum(row.dayLow, 2)}`);
  if (row.high52Live != null) tipParts.push(`52W High ${fmtNum(row.high52Live, 2)}`);
  if (row.low52Live != null) tipParts.push(`52W Low ${fmtNum(row.low52Live, 2)}`);
  const tooltip = tipParts.length ? tipParts.join(" · ") : "OHLC / 52W data not available yet";
  if (chg === null) {
    return `<div class="dc-chip muted" title="${escapeAttr(tooltip)}">—</div>`;
  }
  const cls = chg > 0 ? "pos" : chg < 0 ? "neg" : "muted";
  const arrow = chg > 0 ? "▲" : chg < 0 ? "▼" : "•";
  return `
    <div class="dc-chip ${cls}" title="${escapeAttr(tooltip)}">${arrow} ${chg >= 0 ? "+" : ""}${fmtNum(chg, 2)}%${row.marketDataStale ? '<span class="dc-stale-dot" title="Some live fields could not refresh this cycle">•</span>' : ""}</div>
    ${row.prevClose != null ? `<div class="eq-prevclose">Prev ${fmtNum(row.prevClose, 1)}</div>` : ""}
  `;
}

// Tallies today's movers across every Equity holding with a usable
// Day Change % (see dayChangePct()) — purely a display count, nothing
// recalculated differently from what each row's chip already shows.
function computeEquityMovers() {
  let up = 0, down = 0, flat = 0;
  state.equity.forEach(row => {
    const chg = dayChangePct(row.ltp, row.prevClose);
    if (chg === null) return;
    if (chg > 0) up++; else if (chg < 0) down++; else flat++;
  });
  return { up, down, flat };
}

function renderEquityMoversStrip() {
  const el = document.getElementById("equityMoversStrip");
  if (!el) return;
  if (state.equity.length === 0) { el.innerHTML = ""; return; }
  const { up, down, flat } = computeEquityMovers();
  el.innerHTML = `
    <span class="m-pill up">▲ ${up} Up</span>
    <span class="m-pill down">▼ ${down} Down</span>
    <span class="m-pill flat">• ${flat} Flat</span>
  `;
}

async function runEquityRefresh(statusEl) {
  if (state.equity.length === 0) {
    statusEl.textContent = "No stocks to refresh.";
    renderFailPanel("equityFailPanel", "Equity", []);
    return;
  }
  statusEl.textContent = "Fetching...";
  let result;
  try {
    result = await refreshEquityPrices();
  } catch (e) {
    statusEl.textContent = sheetErrorMessage(e);
    return;
  }
  renderEquity();
  renderDashboard();
  renderFailPanel("equityFailPanel", "Equity", result.failedRows);
  statusEl.textContent = `Updated ${result.ok} of ${result.ok + result.fail}.` +
    (result.fail > 0 ? " See details below." : "");
}

// The manual "Refresh live prices" button is gone — see the 30-second
// auto-refresh interval set up in the INIT section, which calls
// runEquityRefresh() the same way this button used to.

/* ============================================================
   DEBT TAB
   ============================================================ */

// Compares a row's Maturity Date against *today* (recomputed on every
// render/update — never stored) and returns the CSS class that should
// highlight it: overdue (already matured), soon (within 30 days), or
// "" for anything further out / blank.
function maturityStatus(dateStr) {
  if (!dateStr) return "";
  const md = new Date(dateStr + "T00:00:00");
  if (isNaN(md)) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = (md - today) / (1000 * 60 * 60 * 24);
  if (diffDays < 0) return "maturity-overdue";
  if (diffDays <= 30) return "maturity-soon";
  return "";
}

function debtDerived(row) {
  const invested = Number(row.invested) || 0;
  const maturity = Number(row.maturityAmount) || 0;
  const profit = maturity - invested;
  const months = Number(row.tenureMonths) || 0;
  const years = months / 12;
  return { profit, years };
}

function debtTotals() {
  let invested = 0, maturity = 0;
  state.debt.forEach(r => {
    invested += Number(r.invested) || 0;
    maturity += Number(r.maturityAmount) || 0;
  });
  return { invested, maturity, profit: maturity - invested };
}

function debtGetSearchText(row) {
  const d = debtDerived(row);
  return [row.name, row.category, row.subcategory, row.account, row.invested, row.roi, row.maturityAmount, d.profit, row.investedDate, row.maturityDate, row.tenureMonths, d.years, row.notes].join(" ");
}

function debtGetSortValue(row, col) {
  const d = debtDerived(row);
  switch (col) {
    case "name": return row.name || "";
    case "category": return row.category || "";
    case "subcategory": return row.subcategory || "";
    case "account": return row.account || "";
    case "invested": return Number(row.invested) || 0;
    case "roi": return Number(row.roi) || 0;
    case "maturityAmount": return Number(row.maturityAmount) || 0;
    case "profit": return d.profit;
    case "investedDate": return row.investedDate || "";
    case "maturityDate": return row.maturityDate || "";
    case "tenureMonths": return Number(row.tenureMonths) || 0;
    case "tenureYears": return d.years;
    case "notes": return row.notes || "";
    default: return 0;
  }
}

/* ============================================================
   DEBT DASHBOARD (redesign)
   Everything below reads state.debt / debtDerived() / debtTotals() /
   maturityStatus() — no new calculation of invested amount, maturity
   amount, or profit is introduced anywhere in this section. Only
   maturity-bucket day-math, a finer 4-tier status label than the
   existing 2-tier maturityStatus(), and simple grouping/summing are
   new, and all of those are computed fresh from row.maturityDate /
   row.invested / row.maturityAmount every time — never persisted,
   never a second source of truth.
   ============================================================ */

// Whole-days-from-today for a YYYY-MM-DD string, or null if missing/
// invalid. Shared by every maturity-bucket/status calculation below
// so "today" and the rounding rule can never drift between them.
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / (1000 * 60 * 60 * 24));
}

// Finer 4-tier status than the existing maturityStatus() (which only
// distinguishes "soon"/"overdue" at a 30-day line, and is left
// untouched since Dashboard's attention panel and the old table's row
// highlighting both already depend on it). This is a Debt-page-only
// display label layered on top, per the brief's own thresholds.
function debtStatusBadge(dateStr) {
  const days = daysUntil(dateStr);
  if (days === null) return { label: "—", cls: "unknown", days: null };
  if (days < 0) return { label: "Matured", cls: "matured", days };
  if (days < 30) return { label: "Action Required", cls: "action", days };
  if (days <= 90) return { label: "Maturing Soon", cls: "soon", days };
  return { label: "Active", cls: "active", days };
}

// { key, label, min, max } — max is inclusive, null = no upper bound.
// Used by both the four Maturity Overview cards and the click-filter
// they drive.
const DEBT_MATURITY_BUCKETS = [
  { key: "30", label: "Next 30 Days", min: 0, max: 30 },
  { key: "90", label: "Next 90 Days", min: 0, max: 90 },
  { key: "180", label: "Next 6 Months", min: 0, max: 182 },
  { key: "365", label: "Next 12 Months", min: 0, max: 365 }
];

function computeMaturityBucket(bucket) {
  const rows = state.debt.filter(row => {
    const days = daysUntil(row.maturityDate);
    return days !== null && days >= bucket.min && days <= bucket.max;
  });
  const total = rows.reduce((s, r) => s + (Number(r.maturityAmount) || 0), 0);
  return { rows, total, count: rows.length };
}

// View-only UI state for the Debt page — filters/sort-shortcuts/
// selected calendar range/selected month/dismissed reinvestment card.
// Never persisted, never affects any stored value.
const debtUI = {
  categoryFilter: "All",
  statusFilter: "All",
  maturityBucket: null,
  calendarMonths: 12,
  selectedMonthIdx: null,
  reinvestDismissed: false,
  attnFilter: "all"
};

// Distinct category values actually present in the data (rather than
// a hardcoded FD/Bonds/PPF/EPF/Other list) — since Category is free
// text here, this can never show a filter chip for a type the person
// hasn't actually entered.
function getDebtCategories() {
  const set = new Set();
  state.debt.forEach(r => { if ((r.category || "").trim()) set.add(r.category.trim()); });
  return [...set].sort();
}

// Applies the chip filters (category/status/maturity-bucket) ahead of
// the existing search+sort pipeline (applySortFilter + debtGetSearchText/
// debtGetSortValue) — so search and column-sort behave exactly as
// they always have, just over a pre-narrowed row set.
function getDebtDisplayRows() {
  let rows = state.debt;
  if (debtUI.categoryFilter !== "All") {
    rows = rows.filter(r => (r.category || "").trim() === debtUI.categoryFilter);
  }
  if (debtUI.statusFilter !== "All") {
    rows = rows.filter(r => debtStatusBadge(r.maturityDate).cls === debtUI.statusFilter);
  }
  if (debtUI.maturityBucket) {
    const bucket = DEBT_MATURITY_BUCKETS.find(b => b.key === debtUI.maturityBucket);
    if (bucket) {
      rows = rows.filter(r => {
        const days = daysUntil(r.maturityDate);
        return days !== null && days >= bucket.min && days <= bucket.max;
      });
    }
  }
  return applySortFilter("debt", rows, debtGetSearchText, debtGetSortValue);
}

// Weighted-average ROI (weighted by invested amount) — the same
// notion of "your average rate" a person means by "Interest Rate" on
// a fixed-income summary; a simple mean would understate/overstate it
// whenever position sizes differ.
function computeWeightedDebtRoi() {
  const totalInvested = state.debt.reduce((s, r) => s + (Number(r.invested) || 0), 0);
  if (totalInvested <= 0) return 0;
  const weighted = state.debt.reduce((s, r) => s + (Number(r.invested) || 0) * (Number(r.roi) || 0), 0);
  return weighted / totalInvested;
}

function renderDebtHeaderBits() {
  const el = document.getElementById("debtLastUpdated");
  if (el) el.textContent = "Last updated: " + (state.lastSaved ? new Date(state.lastSaved).toLocaleTimeString() : "—");
}

function renderDebtKPIs() {
  const totals = debtTotals();
  const { netWorth, classes } = computeAssetClassesAndNetWorth();
  const debtClass = classes.find(c => c.key === "debt");
  const currentPct = netWorth > 0 ? (debtClass.current / netWorth) * 100 : 0;
  const targetPct = Number(state.ideal.debt) || 0;
  const diffPct = currentPct - targetPct;
  const weightedRoi = computeWeightedDebtRoi();
  // "Expected Interest / Year" — the same profit-at-maturity number
  // debtDerived() already computes, simply annualised by dividing by
  // each row's own tenure in years. Rows with no tenure entered are
  // skipped (never divided by zero / never guessed).
  const expectedInterestPerYear = state.debt.reduce((s, r) => {
    const d = debtDerived(r);
    if (!d.years || d.years <= 0) return s;
    return s + (d.profit / d.years);
  }, 0);

  const debtKpiValueEl = document.getElementById("debtKpiValue");
  debtKpiValueEl.textContent = fmtINRCompact(totals.invested, 2);
  debtKpiValueEl.title = fmtINR(totals.invested);
  document.getElementById("debtKpiValuePct").textContent = `${fmtNum(currentPct, 1)}% of total portfolio`;
  const debtKpiInvestedEl = document.getElementById("debtKpiInvested");
  debtKpiInvestedEl.textContent = fmtINRCompact(totals.invested, 2);
  debtKpiInvestedEl.title = fmtINR(totals.invested);
  document.getElementById("debtKpiRate").textContent = fmtNum(weightedRoi, 2) + "%";
  const debtKpiExpectedInterestEl = document.getElementById("debtKpiExpectedInterest");
  debtKpiExpectedInterestEl.textContent = fmtINRCompact(expectedInterestPerYear, 2);
  debtKpiExpectedInterestEl.title = fmtINR(expectedInterestPerYear);
  document.getElementById("debtKpiAllocPct").textContent = fmtNum(currentPct, 1) + "%";

  const targetRow = document.getElementById("debtKpiTargetRow");
  if (Math.abs(diffPct) >= ATTENTION_DRIFT_THRESHOLD) {
    targetRow.style.display = "";
    targetRow.innerHTML = `Target: ${fmtNum(targetPct, 1)}% <span class="${diffPct > 0 ? "dash-alloc-pct over" : "dash-alloc-pct under"}">${diffPct > 0 ? "Overweight" : "Underweight"}: ${diffPct > 0 ? "+" : ""}${fmtNum(diffPct, 1)}%</span>`;
  } else {
    targetRow.style.display = "none";
  }
}

function computeDebtAttentionItems() {
  const items = [];
  const b90 = computeMaturityBucket(DEBT_MATURITY_BUCKETS[1]);
  if (b90.count > 0) {
    items.push({
      kind: "maturity",
      severity: "warn",
      title: `${fmtINR(b90.total)} maturing in next 90 days`,
      detail: `${b90.count} investment${b90.count === 1 ? "" : "s"}`,
      actionLabel: "View maturities",
      onAction: () => { debtUI.maturityBucket = "90"; renderDebtDashboard(); document.getElementById("debtHoldingsCard")?.scrollIntoView({ behavior: "smooth", block: "start" }); }
    });
  }
  const b180 = computeMaturityBucket(DEBT_MATURITY_BUCKETS[2]);
  const beyond90In180 = b180.count - b90.count;
  if (beyond90In180 > 0) {
    items.push({
      kind: "maturity",
      severity: "info",
      title: `${fmtINR(b180.total - b90.total)} maturing in next 6 months`,
      detail: `${beyond90In180} investment${beyond90In180 === 1 ? "" : "s"}`,
      actionLabel: "View calendar",
      onAction: () => document.getElementById("debtCalendarCard")?.scrollIntoView({ behavior: "smooth", block: "start" })
    });
  }
  const { netWorth, classes } = computeAssetClassesAndNetWorth();
  const debtClass = classes.find(c => c.key === "debt");
  const currentPct = netWorth > 0 ? (debtClass.current / netWorth) * 100 : 0;
  const targetPct = Number(state.ideal.debt) || 0;
  const diffPct = currentPct - targetPct;
  if (diffPct >= ATTENTION_DRIFT_THRESHOLD) {
    items.push({
      kind: "allocation",
      severity: "bad",
      title: "Debt allocation is above target",
      detail: `Current: ${fmtNum(currentPct, 1)}% · Target: ${fmtNum(targetPct, 1)}% · Overweight: ${fmtINR((diffPct / 100) * netWorth)}`,
      actionLabel: "View rebalance",
      onAction: () => { goToTab("dashboard"); setTimeout(openIdealTargetsModal, 150); }
    });
  } else if (diffPct <= -ATTENTION_DRIFT_THRESHOLD) {
    items.push({
      kind: "allocation",
      severity: "warn",
      title: "Debt allocation is below target",
      detail: `Current: ${fmtNum(currentPct, 1)}% · Target: ${fmtNum(targetPct, 1)}% · Underweight: ${fmtINR(Math.abs(diffPct / 100) * netWorth)}`,
      actionLabel: "View rebalance",
      onAction: () => { goToTab("dashboard"); setTimeout(openIdealTargetsModal, 150); }
    });
  }
  const expectedInterestPerYear = state.debt.reduce((s, r) => {
    const d = debtDerived(r);
    if (!d.years || d.years <= 0) return s;
    return s + (d.profit / d.years);
  }, 0);
  if (expectedInterestPerYear > 0) {
    items.push({
      kind: "income",
      severity: "good",
      title: `${fmtINR(expectedInterestPerYear)} interest income expected this year`,
      detail: "Based on each investment's rate and tenure",
      actionLabel: "View details",
      onAction: () => document.getElementById("debtHoldingsCard")?.scrollIntoView({ behavior: "smooth", block: "start" })
    });
  }
  return items;
}

function renderDebtAttention() {
  const el = document.getElementById("debtAttentionList");
  if (!el) return;
  const allItems = computeDebtAttentionItems();
  updateAttnCountBadge("debtAttnCount", allItems.length);
  const items = debtUI.attnFilter === "all" ? allItems : allItems.filter(i => i.kind === debtUI.attnFilter);

  if (allItems.length === 0) {
    el.innerHTML = `<div class="dash-attn-empty">You're clear for now — no upcoming maturities, allocation drift, or other action items.</div>`;
    return;
  }
  if (items.length === 0) {
    el.innerHTML = `<div class="dash-attn-empty">No items match this filter right now.</div>`;
    return;
  }
  el.innerHTML = "";
  items.forEach(item => {
    const row = document.createElement("div");
    row.className = "dash-attn-item";
    row.innerHTML = `
      <div class="dash-attn-top">
        <div class="dash-attn-dot ${item.severity}"></div>
        <div class="dash-attn-body">
          <div class="dash-attn-title">${escapeAttr(item.title)}</div>
          <div class="dash-attn-detail">${escapeAttr(item.detail)}</div>
        </div>
      </div>
      <button class="dash-attn-action">${escapeAttr(item.actionLabel)}</button>
    `;
    row.querySelector(".dash-attn-action").addEventListener("click", item.onAction);
    el.appendChild(row);
  });
}

function renderDebtMaturityOverview() {
  const el = document.getElementById("debtMaturityGrid");
  if (!el) return;
  el.innerHTML = DEBT_MATURITY_BUCKETS.map(b => {
    const data = computeMaturityBucket(b);
    const active = debtUI.maturityBucket === b.key;
    return `
      <button class="debt-maturity-card${active ? " active" : ""}" data-bucket="${b.key}">
        <div class="debt-maturity-label">${escapeAttr(b.label)}</div>
        <div class="debt-maturity-amount">${fmtINR(data.total)}</div>
        <div class="debt-maturity-count">${data.count} investment${data.count === 1 ? "" : "s"}</div>
      </button>
    `;
  }).join("");
  el.querySelectorAll(".debt-maturity-card").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.bucket;
      debtUI.maturityBucket = debtUI.maturityBucket === key ? null : key;
      renderDebtDashboard();
      document.getElementById("debtHoldingsCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

const DEBT_CATEGORY_PALETTE = ["#6f93c9", "#c9a44c", "#4bbf9c", "#e0667a", "#d9a441", "#8b98b5", "#a78bfa"];

function renderDebtAllocation() {
  const el = document.getElementById("debtAllocBars");
  const totalEl = document.getElementById("debtAllocTotal");
  if (!el) return;
  const map = new Map();
  state.debt.forEach(r => {
    const cat = (r.category || "").trim() || "Uncategorized";
    map.set(cat, (map.get(cat) || 0) + (Number(r.invested) || 0));
  });
  const total = [...map.values()].reduce((a, b) => a + b, 0);
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    el.innerHTML = `<div class="dash-attn-empty">No debt entries yet.</div>`;
  } else {
    el.innerHTML = entries.map(([label, value], i) => {
      const pct = total > 0 ? (value / total) * 100 : 0;
      const color = DEBT_CATEGORY_PALETTE[i % DEBT_CATEGORY_PALETTE.length];
      return `
        <div class="dash-alloc-row">
          <div class="dash-alloc-top">
            <span class="dash-alloc-name"><span class="swatch" style="background:${color}"></span>${escapeAttr(label)}</span>
            <span class="dash-alloc-pct">${fmtNum(pct, 1)}%</span>
          </div>
          <div class="dash-alloc-amounts"><span>${fmtINR(value)}</span></div>
          <div class="dash-alloc-track"><div class="dash-alloc-fill" style="width:${pct}%;background:${color}"></div></div>
        </div>
      `;
    }).join("");
  }
  if (totalEl) totalEl.textContent = fmtINR(total);
}

function renderDebtCalendar() {
  const wrap = document.getElementById("debtCalendarBars");
  const detail = document.getElementById("debtCalendarDetail");
  if (!wrap) return;
  const months = debtUI.calendarMonths;
  const buckets = [];
  const today = new Date();
  for (let i = 0; i < months; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    buckets.push({ year: d.getFullYear(), month: d.getMonth(), label: d.toLocaleDateString("en-IN", { month: "short" }), rows: [], total: 0 });
  }
  state.debt.forEach(r => {
    if (!r.maturityDate) return;
    const md = new Date(r.maturityDate + "T00:00:00");
    if (isNaN(md)) return;
    const bucket = buckets.find(b => b.year === md.getFullYear() && b.month === md.getMonth());
    if (bucket) { bucket.rows.push(r); bucket.total += Number(r.maturityAmount) || 0; }
  });
  const maxTotal = Math.max(1, ...buckets.map(b => b.total));

  wrap.innerHTML = buckets.map((b, i) => {
    const heightPct = b.total > 0 ? Math.max(6, (b.total / maxTotal) * 100) : 2;
    const selected = debtUI.selectedMonthIdx === i;
    return `
      <button class="debt-cal-bar-col${selected ? " selected" : ""}" data-idx="${i}" title="${escapeAttr(b.label)} ${b.year} — ${b.rows.length} investment(s), ${fmtINR(b.total)}">
        <div class="debt-cal-bar-track"><div class="debt-cal-bar-fill${b.total > 0 ? "" : " empty"}" style="height:${heightPct}%"></div></div>
        <div class="debt-cal-bar-label">${escapeAttr(b.label)}</div>
      </button>
    `;
  }).join("");

  wrap.querySelectorAll(".debt-cal-bar-col").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      debtUI.selectedMonthIdx = debtUI.selectedMonthIdx === idx ? null : idx;
      renderDebtCalendar();
    });
  });

  if (debtUI.selectedMonthIdx !== null && buckets[debtUI.selectedMonthIdx]) {
    const b = buckets[debtUI.selectedMonthIdx];
    detail.style.display = "";
    detail.innerHTML = b.rows.length > 0
      ? `<b>${escapeAttr(b.label)} ${b.year}</b> · ${b.rows.length} investment${b.rows.length === 1 ? "" : "s"} · ${fmtINR(b.total)}`
      : `<b>${escapeAttr(b.label)} ${b.year}</b> · Nothing maturing this month`;
  } else {
    detail.style.display = "none";
    detail.innerHTML = "";
  }
}

function renderDebtLiquidity() {
  const el = document.getElementById("debtLiquidityList");
  if (!el) return;
  const buckets = [
    { label: "Next 30 days", min: 0, max: 30 },
    { label: "31–90 days", min: 31, max: 90 },
    { label: "3–6 months", min: 91, max: 182 },
    { label: "6–12 months", min: 183, max: 365 },
    { label: "1–2 years", min: 366, max: 730 },
    { label: "2+ years", min: 731, max: Infinity }
  ];
  el.innerHTML = buckets.map(b => {
    const total = state.debt.reduce((s, r) => {
      const days = daysUntil(r.maturityDate);
      if (days === null || days < b.min || days > b.max) return s;
      return s + (Number(r.maturityAmount) || 0);
    }, 0);
    return `<div class="debt-liquidity-row"><span>${escapeAttr(b.label)}</span><span class="debt-liquidity-amt">${fmtINR(total)}</span></div>`;
  }).join("");
}

function renderDebtReinvestmentPlanner() {
  const card = document.getElementById("debtReinvestCard");
  if (!card) return;
  if (debtUI.reinvestDismissed) { card.style.display = "none"; return; }

  const upcoming = state.debt
    .map(r => ({ row: r, days: daysUntil(r.maturityDate) }))
    .filter(x => x.days !== null && x.days >= 0 && x.days <= 90)
    .sort((a, b) => a.days - b.days)[0];

  if (!upcoming) { card.style.display = "none"; return; }
  card.style.display = "";

  const { netWorth, classes } = computeAssetClassesAndNetWorth();
  const rows3 = ["debt", "equity", "gold"].map(key => {
    const c = classes.find(cc => cc.key === key);
    const currentPct = netWorth > 0 ? (c.current / netWorth) * 100 : 0;
    const targetPct = Number(state.ideal[key]) || 0;
    const diff = currentPct - targetPct;
    const status = diff > ATTENTION_DRIFT_THRESHOLD ? "OVERWEIGHT" : diff < -ATTENTION_DRIFT_THRESHOLD ? "UNDERWEIGHT" : "ON TARGET";
    const cls = diff > ATTENTION_DRIFT_THRESHOLD ? "over" : diff < -ATTENTION_DRIFT_THRESHOLD ? "under" : "";
    return { label: c.label, currentPct, targetPct, status, cls };
  });

  document.getElementById("debtReinvestAmount").textContent = `${fmtINR(Number(upcoming.row.maturityAmount) || 0)} available in ${upcoming.days} day${upcoming.days === 1 ? "" : "s"}`;
  document.getElementById("debtReinvestRate").textContent = fmtNum(Number(upcoming.row.roi) || 0, 2) + "%";
  document.getElementById("debtReinvestRows").innerHTML = rows3.map(r => `
    <div class="debt-reinvest-row">
      <span>${escapeAttr(r.label)}</span>
      <span class="dash-alloc-pct ${r.cls}">${fmtNum(r.currentPct, 1)}% / ${fmtNum(r.targetPct, 1)}%</span>
      <span class="debt-reinvest-status ${r.cls}">${r.status}</span>
    </div>
  `).join("");
}

// Status colors match the doc's badge language: green (Active), amber
// (Maturing Soon), orange (Action Required), red (Matured).
const DEBT_STATUS_META = {
  active: { label: "Active", cls: "active" },
  soon: { label: "Maturing Soon", cls: "soon" },
  action: { label: "Action Required", cls: "action" },
  matured: { label: "Matured", cls: "matured" },
  unknown: { label: "—", cls: "unknown" }
};

function maskAccount(acc) {
  const s = (acc || "").trim();
  if (s.length <= 4) return s ? "••••" : "";
  return "••••" + s.slice(-4);
}

function renderDebtFilterChips() {
  const catEl = document.getElementById("debtCategoryChips");
  const statusEl = document.getElementById("debtStatusChips");
  if (!catEl || !statusEl) return;
  const categories = ["All", ...getDebtCategories()];
  catEl.innerHTML = categories.map(cat => `<button class="debt-chip${debtUI.categoryFilter === cat ? " active" : ""}" data-cat="${escapeAttr(cat)}">${escapeAttr(cat)}</button>`).join("");
  catEl.querySelectorAll(".debt-chip").forEach(btn => {
    btn.addEventListener("click", () => { debtUI.categoryFilter = btn.dataset.cat; renderDebtHoldingsList(); renderDebtFilterChips(); });
  });

  const statuses = [
    { key: "All", label: "All" },
    { key: "active", label: "Active" },
    { key: "soon", label: "Maturing Soon" },
    { key: "action", label: "Action Required" },
    { key: "matured", label: "Matured" }
  ];
  statusEl.innerHTML = statuses.map(s => `<button class="debt-chip${debtUI.statusFilter === s.key ? " active" : ""}" data-status="${s.key}">${escapeAttr(s.label)}</button>`).join("");
  statusEl.querySelectorAll(".debt-chip").forEach(btn => {
    btn.addEventListener("click", () => { debtUI.statusFilter = btn.dataset.status; renderDebtHoldingsList(); renderDebtFilterChips(); });
  });
}

function renderDebtHoldingsList() {
  const el = document.getElementById("debtHoldingsList");
  const bucketNote = document.getElementById("debtBucketFilterNote");
  if (!el) return;

  if (bucketNote) {
    const bucket = DEBT_MATURITY_BUCKETS.find(b => b.key === debtUI.maturityBucket);
    if (bucket) {
      bucketNote.style.display = "";
      bucketNote.innerHTML = `Filtered to <b>${escapeAttr(bucket.label)}</b> <button class="debt-chip-clear" id="debtClearBucket">Clear</button>`;
      document.getElementById("debtClearBucket").addEventListener("click", () => { debtUI.maturityBucket = null; renderDebtHoldingsList(); });
    } else {
      bucketNote.style.display = "none";
      bucketNote.innerHTML = "";
    }
  }

  const rows = getDebtDisplayRows();
  if (state.debt.length === 0) {
    el.innerHTML = `<div class="dash-attn-empty">No debt / fixed-income entries yet. Click "+ Add Investment" to begin.</div>`;
    return;
  }
  if (rows.length === 0) {
    el.innerHTML = `<div class="dash-attn-empty">No entries match the current filters.</div>`;
    return;
  }

  el.innerHTML = rows.map(row => {
    const d = debtDerived(row);
    const badge = debtStatusBadge(row.maturityDate);
    const meta = DEBT_STATUS_META[badge.cls] || DEBT_STATUS_META.unknown;
    return `
      <div class="debt-holding-row" data-id="${row.id}">
        <div class="debt-holding-main">
          <div class="debt-holding-name">${escapeAttr(row.name || "(unnamed)")}</div>
          <div class="debt-holding-sub">${escapeAttr(row.category || "Uncategorized")}</div>
        </div>
        <div class="debt-holding-col"><div class="debt-holding-label">Principal</div><div class="debt-holding-val">${fmtINR(row.invested)}</div></div>
        <div class="debt-holding-col"><div class="debt-holding-label">Rate</div><div class="debt-holding-val">${fmtNum(row.roi, 2)}%</div></div>
        <div class="debt-holding-col"><div class="debt-holding-label">Maturity</div><div class="debt-holding-val">${row.maturityDate || "—"}</div></div>
        <div class="debt-holding-col"><div class="debt-holding-label">Maturity Value</div><div class="debt-holding-val">${fmtINR(row.maturityAmount)}</div></div>
        <div class="debt-status-badge ${meta.cls}">${escapeAttr(meta.label)}</div>
        <button class="debt-holding-more" data-id="${row.id}" aria-label="More actions">•••</button>
      </div>
    `;
  }).join("");

  el.querySelectorAll(".debt-holding-row").forEach(rowEl => {
    rowEl.addEventListener("click", (e) => {
      if (e.target.closest(".debt-holding-more")) return;
      openDebtDetailModal(rowEl.dataset.id);
    });
  });
  el.querySelectorAll(".debt-holding-more").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDebtDetailModal(btn.dataset.id);
    });
  });
}

function openDebtDetailModal(id) {
  const row = state.debt.find(r => r.id === id);
  if (!row) return;
  const d = debtDerived(row);
  const days = daysUntil(row.maturityDate);
  const { netWorth, classes } = computeAssetClassesAndNetWorth();
  const debtClass = classes.find(c => c.key === "debt");
  const currentPct = netWorth > 0 ? (debtClass.current / netWorth) * 100 : 0;
  const targetPct = Number(state.ideal.debt) || 0;
  const overweight = currentPct > targetPct + ATTENTION_DRIFT_THRESHOLD;

  const html = `
    <div class="debt-detail-grid">
      <div><div class="debt-holding-label">Principal</div><div class="debt-detail-val">${fmtINR(row.invested)}</div></div>
      <div><div class="debt-holding-label">Interest Rate</div><div class="debt-detail-val">${fmtNum(row.roi, 2)}%</div></div>
      <div><div class="debt-holding-label">Start Date</div><div class="debt-detail-val">${row.investedDate || "—"}</div></div>
      <div><div class="debt-holding-label">Maturity Date</div><div class="debt-detail-val">${row.maturityDate || "—"}</div></div>
      <div><div class="debt-holding-label">Estimated Maturity Value</div><div class="debt-detail-val">${fmtINR(row.maturityAmount)}</div></div>
      <div><div class="debt-holding-label">Interest (at maturity)</div><div class="debt-detail-val ${plClass(d.profit)}">${fmtINR(d.profit)}</div></div>
      <div><div class="debt-holding-label">Remaining</div><div class="debt-detail-val">${days === null ? "—" : days < 0 ? `${Math.abs(days)} days overdue` : `${days} days`}</div></div>
      <div><div class="debt-holding-label">Account</div><div class="debt-detail-val">${escapeAttr(maskAccount(row.account) || "—")}</div></div>
    </div>
    ${row.notes ? `<p class="settings-note">${escapeAttr(row.notes)}</p>` : ""}
    <div class="debt-detail-divider"></div>
    <div class="debt-holding-label" style="margin-bottom:8px;">What should I do?</div>
    <div class="debt-reinvest-row">
      <span>Current Debt Allocation</span><span></span><span class="debt-detail-val">${fmtNum(currentPct, 1)}%</span>
    </div>
    <div class="debt-reinvest-row">
      <span>Target</span><span></span><span class="debt-detail-val">${fmtNum(targetPct, 1)}%</span>
    </div>
    ${overweight
      ? `<div class="dash-attn-item" style="border-bottom:none;padding-top:12px;">
           <div class="dash-attn-dot warn"></div>
           <div class="dash-attn-body">
             <div class="dash-attn-title">Debt is already overweight.</div>
             <div class="dash-attn-detail">Consider redirecting maturity proceeds to underweight asset classes instead of renewing this investment as-is.</div>
           </div>
         </div>`
      : `<p class="settings-note">Debt allocation is within range — renewing or reinvesting either way is a reasonable option based on allocation alone.</p>`}
  `;

  openModal(escapeAttr(row.name || "Debt investment"), html, [
    { label: "View rebalance", onClick: () => { closeModal(); goToTab("dashboard"); setTimeout(openIdealTargetsModal, 150); } },
    { label: "Close", primary: true, onClick: closeModal }
  ]);
}

function openDebtColumnsModal() {
  // Placeholder entry point — the redesigned holdings list already
  // shows Name/Category/Principal/Rate/Maturity Date/Maturity Value/
  // Status by default. Extra fields (Sub-category, Account, Invested
  // Date, Tenure, Notes) stay reachable via "Edit holdings (all
  // fields)" below rather than a separate column-visibility system,
  // since that classic table already exposes every field.
  document.getElementById("debtClassicTableDetails")?.setAttribute("open", "");
  document.getElementById("debtClassicTableDetails")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDebtDashboard() {
  renderDebtHeaderBits();
  renderDebtKPIs();
  renderDebtAttention();
  renderDebtMaturityOverview();
  renderDebtAllocation();
  renderDebtCalendar();
  renderDebtLiquidity();
  renderDebtReinvestmentPlanner();
  renderDebtFilterChips();
  renderDebtHoldingsList();
}

function renderDebt() {
  const tbody = document.getElementById("debtTableBody");
  tbody.innerHTML = "";
  const displayRows = applySortFilter("debt", state.debt, debtGetSearchText, debtGetSortValue);

  if (state.debt.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="14">No debt / fixed-income entries yet. Click "+ Add entry" to begin.</td></tr>';
  } else if (displayRows.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="14">No entries match this filter.</td></tr>';
  }

  const locked = isReadOnly();
  displayRows.forEach(row => {
    const d = debtDerived(row);
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    const mStatus = maturityStatus(row.maturityDate);
    if (mStatus) tr.classList.add(mStatus);
    tr.innerHTML = `
      <td class="left sticky-col"><input type="text" value="${escapeAttr(row.name || "")}" data-field="name" ${locked ? "disabled" : ""}></td>
      <td class="left" data-label="Category"><input type="text" value="${escapeAttr(row.category || "")}" data-field="category" ${locked ? "disabled" : ""}></td>
      <td class="left" data-label="Sub-category"><input type="text" value="${escapeAttr(row.subcategory || "")}" data-field="subcategory" ${locked ? "disabled" : ""}></td>
      <td class="left" data-label="Account No."><input type="text" value="${escapeAttr(row.account || "")}" data-field="account" ${locked ? "disabled" : ""}></td>
      <td data-label="Invested Amt"><input type="number" step="any" value="${roundedInputValue(row.invested)}" data-field="invested" ${locked ? "disabled" : ""}></td>
      <td data-label="ROI %"><input type="number" step="any" value="${roundedInputValue(row.roi)}" data-field="roi" ${locked ? "disabled" : ""}></td>
      <td data-label="Maturity Amt"><input type="number" step="any" value="${roundedInputValue(row.maturityAmount)}" data-field="maturityAmount" ${locked ? "disabled" : ""}></td>
      <td class="c-profit ${plClass(d.profit)}" data-label="Profit">${fmtNum(d.profit)}</td>
      <td data-label="Invested Date"><input type="date" value="${row.investedDate || ""}" data-field="investedDate" ${locked ? "disabled" : ""}></td>
      <td class="c-maturity ${mStatus}" data-label="Maturity Date"><input type="date" value="${row.maturityDate || ""}" data-field="maturityDate" ${locked ? "disabled" : ""}></td>
      <td data-label="Tenure (Mo)"><input type="number" step="any" value="${roundedInputValue(row.tenureMonths)}" data-field="tenureMonths" ${locked ? "disabled" : ""}></td>
      <td class="c-years" data-label="Tenure (Yr)">${fmtNum(d.years, 1)}</td>
      <td class="left" data-label="Notes"><input type="text" value="${escapeAttr(row.notes || "")}" data-field="notes" ${locked ? "disabled" : ""}></td>
      <td class="row-actions"><button class="icon-btn" title="Remove">✕</button></td>
    `;
    tr.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("change", () => {
        const field = inp.dataset.field;
        const numericFields = ["invested", "roi", "maturityAmount", "tenureMonths"];
        row[field] = numericFields.includes(field) ? (parseFloat(inp.value) || 0) : inp.value;
        saveState();
        updateDebtComputed();
        renderDashboard();
      });
    });
    tr.querySelector(".icon-btn").addEventListener("click", () => {
      state.debt = state.debt.filter(r => r.id !== row.id);
      saveState();
      renderDebt();
      renderDashboard();
    });
    tbody.appendChild(tr);
  });

  const totals = debtTotals();
  document.getElementById("debtTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("debtTotalMaturity").textContent = fmtINR(totals.maturity);
  const profitCell = document.getElementById("debtTotalProfit");
  profitCell.textContent = fmtINR(totals.profit);
  profitCell.className = plClass(totals.profit);
  document.getElementById("debtMobTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("debtMobTotalMaturity").textContent = fmtINR(totals.maturity);
  const mobProfitCell = document.getElementById("debtMobTotalProfit");
  mobProfitCell.textContent = fmtINR(totals.profit);
  mobProfitCell.className = plClass(totals.profit);
  renderDebtDashboard();
}

function updateDebtComputed() {
  const tbody = document.getElementById("debtTableBody");
  state.debt.forEach(row => {
    const tr = tbody.querySelector(`tr[data-id="${row.id}"]`);
    if (!tr) return;
    const d = debtDerived(row);
    const profitCell = tr.querySelector(".c-profit");
    profitCell.textContent = fmtNum(d.profit);
    profitCell.className = "c-profit " + plClass(d.profit);
    tr.querySelector(".c-years").textContent = fmtNum(d.years, 1);
    const mStatus = maturityStatus(row.maturityDate);
    const maturityCell = tr.querySelector(".c-maturity");
    if (maturityCell) maturityCell.className = ("c-maturity " + mStatus).trim();
    tr.classList.remove("maturity-overdue", "maturity-soon");
    if (mStatus) tr.classList.add(mStatus);
  });
  const totals = debtTotals();
  document.getElementById("debtTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("debtTotalMaturity").textContent = fmtINR(totals.maturity);
  const totalProfitCell = document.getElementById("debtTotalProfit");
  totalProfitCell.textContent = fmtINR(totals.profit);
  totalProfitCell.className = plClass(totals.profit);
  document.getElementById("debtMobTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("debtMobTotalMaturity").textContent = fmtINR(totals.maturity);
  const mobProfitCell = document.getElementById("debtMobTotalProfit");
  mobProfitCell.textContent = fmtINR(totals.profit);
  mobProfitCell.className = plClass(totals.profit);
  renderDebtDashboard();
}

document.getElementById("btnAddDebt").addEventListener("click", () => {
  state.debt.push({
    id: uid(), name: "", category: "", subcategory: "", account: "",
    invested: 0, roi: 0, maturityAmount: 0, investedDate: "", maturityDate: "",
    tenureMonths: 0, notes: ""
  });
  saveState();
  renderDebt();
  renderDashboard();
});

/* ============================================================
   MUTUAL FUNDS TAB
   ============================================================ */

// Mirrors equityDerived(): invested + units are the source of
// truth (editable, or overwritten wholesale by Zerodha import),
// Avg Price is derived from them exactly like Equity's Avg Price,
// so it can never drift out of sync with Invested/Units.
function mfDerived(row) {
  const invested = Number(row.invested) || 0;
  const units = Number(row.units) || 0;
  const unitPrice = Number(row.unitPrice) || 0;
  const avgPrice = units > 0 ? invested / units : 0;
  const currentValue = units * unitPrice;
  const pl = currentValue - invested;
  const plPct = invested > 0 ? (pl / invested) * 100 : 0;
  return { avgPrice, currentValue, pl, plPct };
}

function mfTotals() {
  let invested = 0, current = 0;
  state.mf.forEach(r => {
    invested += Number(r.invested) || 0;
    current += mfDerived(r).currentValue;
  });
  const pl = current - invested;
  const plPct = invested > 0 ? (pl / invested) * 100 : 0;
  return { invested, current, pl, plPct };
}

function mfGetSearchText(row) {
  const d = mfDerived(row);
  return [row.name, row.symbol, row.category, row.invested, row.units, d.avgPrice, row.unitPrice, d.currentValue, d.pl, d.plPct, row.remarks].join(" ");
}

function mfGetSortValue(row, col) {
  const d = mfDerived(row);
  switch (col) {
    case "name": return row.name || "";
    case "symbol": return row.symbol || "";
    case "category": return row.category || "";
    case "invested": return Number(row.invested) || 0;
    case "units": return Number(row.units) || 0;
    case "avgPrice": return d.avgPrice;
    case "unitPrice": return Number(row.unitPrice) || 0;
    case "currentValue": return d.currentValue;
    case "pl": return d.pl;
    case "plPct": return d.plPct;
    case "allocPct": return d.currentValue;
    case "remarks": return row.remarks || "";
    default: return 0;
  }
}

function renderMF() {
  const tbody = document.getElementById("mfTableBody");
  tbody.innerHTML = "";
  const totals = mfTotals();
  const displayRows = applySortFilter("mf", state.mf, mfGetSearchText, mfGetSortValue);

  if (state.mf.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="12">No mutual funds yet. Use "Import Holdings" to bring in your Zerodha Console export.</td></tr>';
  } else if (displayRows.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="12">No funds match this filter.</td></tr>';
  }

  // Name, Category, Invested, Units and NAV are only ever meant to
  // change via Zerodha Holdings import or the automatic live-NAV
  // refresh now — they're permanently read-only regardless of the
  // Lock Portfolio toggle. Remarks is the one field left for manual
  // annotation, and still follows the Lock Portfolio toggle.
  const notesLocked = isReadOnly();
  displayRows.forEach(row => {
    const d = mfDerived(row);
    const allocPct = totals.current > 0 ? (d.currentValue / totals.current) * 100 : 0;
    const pendingBadge = row.livePricePending ? '<span class="pending-badge">Pending</span>' : "";
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td class="left sticky-col"><input type="text" value="${escapeAttr(row.name || "")}" data-field="name" disabled></td>
      <td class="left" data-label="Category"><input type="text" value="${escapeAttr(row.category || "")}" data-field="category" disabled></td>
      <td data-label="Invested Amt"><input type="number" step="any" value="${roundedInputValue(row.invested)}" data-field="invested" disabled></td>
      <td data-label="Units"><input type="number" step="any" value="${roundedInputValue(row.units)}" data-field="units" disabled></td>
      <td class="c-avg" data-label="Avg Price">${fmtNum(d.avgPrice)}</td>
      <td data-label="NAV"><div class="price-cell"><input type="number" step="any" value="${roundedInputValue(row.unitPrice)}" data-field="unitPrice" disabled>${pendingBadge}</div></td>
      <td class="c-cv" data-label="Current Value">${fmtNum(d.currentValue)}</td>
      <td class="c-pl ${plClass(d.pl)}" data-label="P&amp;L">${fmtNum(d.pl)}</td>
      <td class="c-plpct ${plClass(d.pl)}" data-label="P&amp;L %">${fmtPct(d.plPct)}</td>
      <td class="c-alloc" data-label="Alloc %">${fmtNum(allocPct)}%</td>
      <td class="left" data-label="Remarks"><input type="text" value="${escapeAttr(row.remarks || "")}" data-field="remarks" ${notesLocked ? "disabled" : ""}></td>
      <td class="row-actions"><button class="icon-btn" title="Remove">✕</button></td>
    `;
    tr.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("change", () => {
        const field = inp.dataset.field;
        const numericFields = ["invested", "units", "unitPrice"];
        row[field] = numericFields.includes(field) ? (parseFloat(inp.value) || 0) : inp.value;
        saveState();
        updateMFComputed();
        renderDashboard();
      });
    });
    tr.querySelector(".icon-btn").addEventListener("click", () => {
      state.mf = state.mf.filter(r => r.id !== row.id);
      saveState();
      renderMF();
      renderDashboard();
    });
    tbody.appendChild(tr);
  });

  document.getElementById("mfTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("mfTotalCurrent").textContent = fmtINR(totals.current);
  const plCell = document.getElementById("mfTotalPL");
  plCell.textContent = fmtINR(totals.pl);
  plCell.className = plClass(totals.pl);
  const plPctCell = document.getElementById("mfTotalPLPct");
  plPctCell.textContent = fmtPct(totals.plPct);
  plPctCell.className = plClass(totals.pl);
  document.getElementById("mfMobTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("mfMobTotalCurrent").textContent = fmtINR(totals.current);
  const mobPlCell = document.getElementById("mfMobTotalPL");
  mobPlCell.textContent = fmtINR(totals.pl);
  mobPlCell.className = plClass(totals.pl);
}

function updateMFComputed() {
  const tbody = document.getElementById("mfTableBody");
  const totals = mfTotals();
  state.mf.forEach(row => {
    const tr = tbody.querySelector(`tr[data-id="${row.id}"]`);
    if (!tr) return;
    const d = mfDerived(row);
    const allocPct = totals.current > 0 ? (d.currentValue / totals.current) * 100 : 0;
    tr.querySelector(".c-avg").textContent = fmtNum(d.avgPrice);
    tr.querySelector(".c-cv").textContent = fmtNum(d.currentValue);
    const plCell = tr.querySelector(".c-pl");
    plCell.textContent = fmtNum(d.pl);
    plCell.className = "c-pl " + plClass(d.pl);
    const plPctCell = tr.querySelector(".c-plpct");
    plPctCell.textContent = fmtPct(d.plPct);
    plPctCell.className = "c-plpct " + plClass(d.pl);
    tr.querySelector(".c-alloc").textContent = fmtNum(allocPct) + "%";
  });
  document.getElementById("mfTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("mfTotalCurrent").textContent = fmtINR(totals.current);
  const plCell = document.getElementById("mfTotalPL");
  plCell.textContent = fmtINR(totals.pl);
  plCell.className = plClass(totals.pl);
  const plPctCell = document.getElementById("mfTotalPLPct");
  plPctCell.textContent = fmtPct(totals.plPct);
  plPctCell.className = plClass(totals.pl);
  document.getElementById("mfMobTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("mfMobTotalCurrent").textContent = fmtINR(totals.current);
  const mobPlCell2 = document.getElementById("mfMobTotalPL");
  mobPlCell2.textContent = fmtINR(totals.pl);
  mobPlCell2.className = plClass(totals.pl);
}

// Mutual Fund rows are no longer created by hand — Name, Category,
// Invested, Units and NAV are all driven by Zerodha Holdings import
// plus the automatic live-NAV refresh, so there's no "+ Add fund"
// entry point left in the UI.


/* ---- live NAV fetch: mutual funds (Google Sheet, refreshed by Apps Script) ---- */

async function refreshMFPrices() {
  if (state.mf.length === 0) return { ok: 0, fail: 0, failedRows: [], skipped: true };
  const data = await fetchPriceData();
  // buildPriceMap() already keys this map by BOTH "MF Name" and
  // "Symbol" from the sheet (idCandidates below), so it can be looked
  // up either way.
  const navMap = buildPriceMap(data.mf, ["MF Name", "Symbol"], ["Live Price", "NAV", "Price"]);
  const categoryMap = buildMFCategoryMap(data.mf);
  let ok = 0;
  const failedRows = [];
  state.mf.forEach(row => {
    const nameKey = (row.name || "").trim().toUpperCase();
    const symbolKey = (row.symbol || "").trim().toUpperCase();
    // The Symbol column is hidden from the UI (and Zerodha import never
    // sets it), so Name is the only identifier most rows will ever
    // have — match on that first and only fall back to a stored
    // Symbol for older rows that already had one saved.
    const matchKey = navMap.has(nameKey) ? nameKey : (symbolKey && navMap.has(symbolKey) ? symbolKey : "");
    if (matchKey) {
      row.unitPrice = navMap.get(matchKey);
      row.livePricePending = false;
      ok++;
      // Backfill Symbol/Category from the sheet by name so they stay
      // populated even though neither field is manually editable
      // anymore.
      const meta = categoryMap.get(nameKey);
      if (meta) {
        if (meta.symbol && !row.symbol) row.symbol = meta.symbol;
        if (meta.category && !row.category) row.category = meta.category;
      }
    } else {
      failedRows.push({ name: row.name || "(unnamed)", key: nameKey });
    }
  });
  saveState();
  return { ok, fail: failedRows.length, failedRows };
}

async function runMFRefresh(statusEl) {
  if (state.mf.length === 0) {
    statusEl.textContent = "No funds to refresh.";
    renderFailPanel("mfFailPanel", "Mutual Fund", []);
    return;
  }
  statusEl.textContent = "Fetching...";
  let result;
  try {
    result = await refreshMFPrices();
  } catch (e) {
    statusEl.textContent = sheetErrorMessage(e);
    return;
  }
  renderMF();
  renderDashboard();
  renderFailPanel("mfFailPanel", "Mutual Fund", result.failedRows);
  statusEl.textContent = `Updated ${result.ok} of ${result.ok + result.fail}.` +
    (result.fail > 0 ? " See details below." : "");
}

// The manual "Refresh live NAV" button is gone — see the 30-second
// auto-refresh interval set up in the INIT section, which calls
// runMFRefresh() the same way this button used to.

/* ============================================================
   GOLD TAB
   ============================================================ */

function goldDerived(row) {
  const invested = Number(row.invested) || 0;
  const weight = Number(row.weight) || 0;
  const currentRate = Number(row.currentRate) || 0;
  const currentValue = weight * currentRate;
  const pl = currentValue - invested;
  const plPct = invested > 0 ? (pl / invested) * 100 : 0;
  return { currentValue, pl, plPct };
}

function goldTotals() {
  let invested = 0, current = 0;
  state.gold.forEach(r => {
    invested += Number(r.invested) || 0;
    current += goldDerived(r).currentValue;
  });
  const pl = current - invested;
  const plPct = invested > 0 ? (pl / invested) * 100 : 0;
  return { invested, current, pl, plPct };
}

function goldGetSearchText(row) {
  const d = goldDerived(row);
  return [row.name, row.form, row.weight, row.purchaseRate, row.invested, row.currentRate, d.currentValue, d.pl, d.plPct, row.notes].join(" ");
}

function goldGetSortValue(row, col) {
  const d = goldDerived(row);
  switch (col) {
    case "name": return row.name || "";
    case "form": return row.form || "";
    case "weight": return Number(row.weight) || 0;
    case "purchaseRate": return Number(row.purchaseRate) || 0;
    case "invested": return Number(row.invested) || 0;
    case "currentRate": return Number(row.currentRate) || 0;
    case "currentValue": return d.currentValue;
    case "pl": return d.pl;
    case "plPct": return d.plPct;
    case "notes": return row.notes || "";
    default: return 0;
  }
}

function renderGold() {
  const tbody = document.getElementById("goldTableBody");
  tbody.innerHTML = "";
  const totals = goldTotals();
  const displayRows = applySortFilter("gold", state.gold, goldGetSearchText, goldGetSortValue);

  if (state.gold.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="11">No gold holdings yet. Use "Import Holdings" to bring in your Zerodha Console export.</td></tr>';
  } else if (displayRows.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="11">No holdings match this filter.</td></tr>';
  }

  // Name, Form, Weight, Purchase Rate, Invested and Current Rate are
  // only ever meant to change via Zerodha Holdings import or the
  // automatic live-price refresh now — they're permanently read-only
  // regardless of the Lock Portfolio toggle. Notes is the one field
  // left for manual annotation, and still follows the toggle.
  const notesLocked = isReadOnly();
  displayRows.forEach(row => {
    const d = goldDerived(row);
    const pendingBadge = row.livePricePending ? '<span class="pending-badge">Pending</span>' : "";
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td class="left sticky-col"><input type="text" value="${escapeAttr(row.name || "")}" data-field="name" placeholder="e.g. GOLDBEES.NS" disabled></td>
      <td class="left" data-label="Form">
        <select data-field="form" disabled>
          <option value="Physical" ${row.form === "Physical" ? "selected" : ""}>Physical</option>
          <option value="Digital" ${row.form === "Digital" ? "selected" : ""}>Digital</option>
          <option value="SGB" ${row.form === "SGB" ? "selected" : ""}>SGB</option>
          <option value="ETF" ${row.form === "ETF" ? "selected" : ""}>ETF</option>
        </select>
      </td>
      <td data-label="Weight/Units"><input type="number" step="any" value="${roundedInputValue(row.weight)}" data-field="weight" disabled></td>
      <td data-label="Purchase Rate"><input type="number" step="any" value="${roundedInputValue(row.purchaseRate)}" data-field="purchaseRate" disabled></td>
      <td data-label="Invested Amt"><input type="number" step="any" value="${roundedInputValue(row.invested)}" data-field="invested" disabled></td>
      <td data-label="Current Rate"><div class="price-cell"><input type="number" step="any" value="${roundedInputValue(row.currentRate)}" data-field="currentRate" disabled>${pendingBadge}</div></td>
      <td class="c-cv" data-label="Current Value">${fmtNum(d.currentValue)}</td>
      <td class="c-pl ${plClass(d.pl)}" data-label="P&amp;L">${fmtNum(d.pl)}</td>
      <td class="c-plpct ${plClass(d.pl)}" data-label="P&amp;L %">${fmtPct(d.plPct)}</td>
      <td class="left" data-label="Notes"><input type="text" value="${escapeAttr(row.notes || "")}" data-field="notes" ${notesLocked ? "disabled" : ""}></td>
      <td class="row-actions"><button class="icon-btn" title="Remove">✕</button></td>
    `;
    tr.querySelectorAll("input, select").forEach(inp => {
      inp.addEventListener("change", () => {
        const field = inp.dataset.field;
        const numericFields = ["weight", "purchaseRate", "invested", "currentRate"];
        row[field] = numericFields.includes(field) ? (parseFloat(inp.value) || 0) : inp.value;
        saveState();
        updateGoldComputed();
        renderDashboard();
      });
    });
    tr.querySelector(".icon-btn").addEventListener("click", () => {
      state.gold = state.gold.filter(r => r.id !== row.id);
      saveState();
      renderGold();
      renderDashboard();
    });
    tbody.appendChild(tr);
  });

  document.getElementById("goldTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("goldTotalCurrent").textContent = fmtINR(totals.current);
  const plCell = document.getElementById("goldTotalPL");
  plCell.textContent = fmtINR(totals.pl);
  plCell.className = plClass(totals.pl);
  const plPctCell = document.getElementById("goldTotalPLPct");
  plPctCell.textContent = fmtPct(totals.plPct);
  plPctCell.className = plClass(totals.pl);
  document.getElementById("goldMobTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("goldMobTotalCurrent").textContent = fmtINR(totals.current);
  const mobPlCell = document.getElementById("goldMobTotalPL");
  mobPlCell.textContent = fmtINR(totals.pl);
  mobPlCell.className = plClass(totals.pl);
}

function updateGoldComputed() {
  const tbody = document.getElementById("goldTableBody");
  state.gold.forEach(row => {
    const tr = tbody.querySelector(`tr[data-id="${row.id}"]`);
    if (!tr) return;
    const d = goldDerived(row);
    tr.querySelector(".c-cv").textContent = fmtNum(d.currentValue);
    const plCell = tr.querySelector(".c-pl");
    plCell.textContent = fmtNum(d.pl);
    plCell.className = "c-pl " + plClass(d.pl);
    const plPctCell = tr.querySelector(".c-plpct");
    plPctCell.textContent = fmtPct(d.plPct);
    plPctCell.className = "c-plpct " + plClass(d.pl);
  });
  const totals = goldTotals();
  document.getElementById("goldTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("goldTotalCurrent").textContent = fmtINR(totals.current);
  const plCell = document.getElementById("goldTotalPL");
  plCell.textContent = fmtINR(totals.pl);
  plCell.className = plClass(totals.pl);
  const plPctCell = document.getElementById("goldTotalPLPct");
  plPctCell.textContent = fmtPct(totals.plPct);
  plPctCell.className = plClass(totals.pl);
  document.getElementById("goldMobTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("goldMobTotalCurrent").textContent = fmtINR(totals.current);
  const mobPlCell2 = document.getElementById("goldMobTotalPL");
  mobPlCell2.textContent = fmtINR(totals.pl);
  mobPlCell2.className = plClass(totals.pl);
}

// Gold rows are no longer created by hand — Name, Form, Weight,
// Purchase Rate, Invested and Current Rate are all driven by Zerodha
// Holdings import plus the automatic live-price refresh, so there's
// no "+ Add holding" entry point left in the UI.


/* ---- live price fetch: gold ETFs (Google Sheet — ETFs trade like stocks) ---- */

async function refreshGoldPrices() {
  if (state.gold.length === 0) return { ok: 0, fail: 0, failedRows: [], skipped: true };
  const data = await fetchPriceData();
  const priceMap = buildPriceMap(data.gold, ["Stock Name", "Symbol"], ["Live Price", "Price"]);
  let ok = 0;
  const failedRows = [];
  state.gold.forEach(row => {
    const key = (row.name || "").trim().toUpperCase();
    if (key && priceMap.has(key)) {
      row.currentRate = priceMap.get(key);
      row.livePricePending = false;
      ok++;
    } else {
      failedRows.push({ name: row.name || "(unnamed)", key });
    }
  });
  saveState();
  return { ok, fail: failedRows.length, failedRows };
}

async function runGoldRefresh(statusEl) {
  if (state.gold.length === 0) {
    statusEl.textContent = "No holdings to refresh.";
    renderFailPanel("goldFailPanel", "Gold", []);
    return;
  }
  statusEl.textContent = "Fetching...";
  let result;
  try {
    result = await refreshGoldPrices();
  } catch (e) {
    statusEl.textContent = sheetErrorMessage(e);
    return;
  }
  renderGold();
  renderDashboard();
  renderFailPanel("goldFailPanel", "Gold", result.failedRows);
  statusEl.textContent = `Updated ${result.ok} of ${result.ok + result.fail}.` +
    (result.fail > 0 ? " See details below." : "");
}

// The manual "Refresh live prices" button is gone — see the 30-second
// auto-refresh interval set up in the INIT section, which calls
// runGoldRefresh() the same way this button used to.

/* ============================================================
   MARKET SNAPSHOT (Nifty Bank / NIFTY 50 / SENSEX)
   Shown on the Dashboard tab. Reuses the exact same live-data
   endpoint (fetchPriceData()) the Equity tab's live refresh already
   calls — expects an optional `indices` array in the JSON payload,
   one row per index, keyed by that row's own header text (same
   flexible-header convention as everything else in this file). If
   the deployed Apps Script doesn't return an `indices` array yet,
   each card just shows "No live data yet" rather than breaking.
   ============================================================ */

const INDEX_DEFINITIONS = [
  { key: "niftybank", label: "Nifty Bank", candidates: ["Nifty Bank", "Bank Nifty", "NIFTY BANK", "NIFTYBANK"] },
  { key: "nifty50", label: "NIFTY 50", candidates: ["NIFTY 50", "Nifty 50", "Nifty50", "NIFTY"] },
  { key: "sensex", label: "SENSEX", candidates: ["SENSEX", "Sensex", "BSE Sensex"] }
];

// Builds a Map from index name (uppercased, trimmed) to its cleaned
// value/prevClose/52W High/Low — mirrors buildMarketDataMap()'s
// per-field null-on-missing behavior. The index's own name/label
// column is matched flexibly ("Index", "Name", "Index Name").
function buildIndexRecordsMap(rows) {
  const map = new Map();
  if (!Array.isArray(rows)) return map;
  rows.forEach(obj => {
    const keys = Object.keys(obj);
    const findVal = (candidates) => {
      const k = keys.find(k => candidates.some(c => c.toLowerCase() === k.trim().toLowerCase()));
      return k !== undefined ? parseIndianNumber(obj[k]) : null;
    };
    const nameKey = keys.find(k => ["Index", "Name", "Index Name", "Stock Name"].some(c => c.toLowerCase() === k.trim().toLowerCase()));
    const name = nameKey ? String(obj[nameKey] || "").trim() : "";
    if (!name) return;
    map.set(name.toUpperCase(), {
      value: findVal(["Live Price", "Value", "Price", "Current Value"]),
      prevClose: findVal(MARKET_DATA_FIELD_CANDIDATES.prevClose),
      high52: findVal(MARKET_DATA_FIELD_CANDIDATES.high52),
      low52: findVal(MARKET_DATA_FIELD_CANDIDATES.low52)
    });
  });
  return map;
}

function findIndexRecord(map, candidates) {
  for (const c of candidates) {
    const rec = map.get(c.toUpperCase());
    if (rec) return rec;
  }
  return null;
}

// Shared worker, same pattern as refreshEquityPrices()/refreshMFPrices():
// fetches once, updates state.indexData in place (field-by-field, so a
// single missing column doesn't wipe the rest), then re-renders. Silently
// no-ops (marks existing cards stale) if the endpoint doesn't return an
// `indices` array at all — this is additive to the existing sheet, not a
// hard requirement of it.
async function refreshIndexData() {
  let data;
  try {
    data = await fetchPriceData();
  } catch (e) {
    INDEX_DEFINITIONS.forEach(def => { if (state.indexData[def.key]) state.indexData[def.key].stale = true; });
    renderMarketSnapshot();
    return;
  }
  // Prefer a dedicated `indices` array if the Apps Script returns one,
  // but fall back to matching Nifty Bank / NIFTY 50 / SENSEX by name
  // straight out of the existing `stocks` array — this is how they
  // already show up in most people's sheets (same Stock Name/Symbol/
  // Live Price/Previous Close/... columns as any other stock row), so
  // no separate Indices tab or Apps Script change is required.
  const sourceRows = (Array.isArray(data.indices) && data.indices.length > 0) ? data.indices : data.stocks;
  const map = buildIndexRecordsMap(sourceRows);
  let changed = false;
  INDEX_DEFINITIONS.forEach(def => {
    const rec = findIndexRecord(map, def.candidates);
    const existing = state.indexData[def.key] || {};
    if (rec && rec.value !== null) {
      state.indexData[def.key] = {
        value: rec.value,
        prevClose: rec.prevClose !== null ? rec.prevClose : (existing.prevClose ?? null),
        high52: rec.high52 !== null ? rec.high52 : (existing.high52 ?? null),
        low52: rec.low52 !== null ? rec.low52 : (existing.low52 ?? null),
        stale: [rec.prevClose, rec.high52, rec.low52].some(v => v === null)
      };
      changed = true;
    } else if (state.indexData[def.key]) {
      state.indexData[def.key].stale = true;
    }
  });
  if (changed) saveState();
  renderMarketSnapshot();
}

function renderMarketSnapshot() {
  const el = document.getElementById("marketSnapshotGrid");
  if (!el) return;
  el.innerHTML = INDEX_DEFINITIONS.map(def => {
    const rec = state.indexData[def.key];
    if (!rec || rec.value === null || rec.value === undefined) {
      return `
        <div class="ms-card">
          <div class="ms-card-top"><span class="ms-name">${escapeAttr(def.label)}</span></div>
          <div class="ms-empty">No live data yet</div>
        </div>`;
    }
    const chg = dayChangePct(rec.value, rec.prevClose);
    const chgCls = chg === null ? "muted" : chg > 0 ? "pos" : chg < 0 ? "neg" : "muted";
    const chgText = chg === null ? "—" : `${chg >= 0 ? "+" : ""}${fmtNum(chg, 2)}% today`;
    const hasRange = rec.high52 !== null && rec.low52 !== null && rec.high52 > rec.low52;
    let barPct = 50, pctFromLow = null, pctFromHigh = null;
    if (hasRange) {
      pctFromLow = ((rec.value - rec.low52) / rec.low52) * 100;
      pctFromHigh = ((rec.high52 - rec.value) / rec.high52) * 100;
      barPct = Math.max(0, Math.min(100, ((rec.value - rec.low52) / (rec.high52 - rec.low52)) * 100));
    }
    return `
      <div class="ms-card${rec.stale ? " ms-stale" : ""}">
        <div class="ms-card-top">
          <span class="ms-name">${escapeAttr(def.label)}</span>
          ${rec.stale ? '<span class="ms-stale-badge" title="Some fields could not refresh this cycle — showing last known values">stale</span>' : ""}
        </div>
        <div class="ms-value">${fmtNum(rec.value, 0)}</div>
        <div class="ms-chg ${chgCls}">${chgText}</div>
        ${hasRange ? `
          <div class="ms-range-track"><div class="ms-range-dot" style="left:${barPct}%"></div></div>
          <div class="ms-range-labels"><span>52W Low ${fmtNum(rec.low52, 0)}</span><span>52W High ${fmtNum(rec.high52, 0)}</span></div>
          <div class="ms-range-pct"><span class="pos">+${fmtNum(pctFromLow, 1)}% from Low</span><span class="neg">-${fmtNum(pctFromHigh, 1)}% from High</span></div>
        ` : '<div class="ms-empty">52W range not available</div>'}
      </div>
    `;
  }).join("");
}

/* ============================================================
   DASHBOARD
   ============================================================ */

// Single source of truth for the 5 asset-class rows + net worth —
// used by renderDashboard() itself, the Edit Targets modal, and the
// allocation bars, so none of them can ever compute a different
// number for the same thing. Pure read of existing totals functions;
// no calculation here that didn't already exist in the old
// renderDashboard().
function computeAssetClassesAndNetWorth() {
  const eq = equityTotals();
  const debt = debtTotals();
  const mf = mfTotals();
  const gold = goldTotals();
  const cash = Number(state.cash) || 0;

  const classes = [
    { key: "cash",   label: "Cash",                     current: cash,          invested: cash },
    { key: "debt",   label: "Debt / Fixed Investments",  current: debt.invested, invested: debt.invested },
    { key: "mf",     label: "Equity Mutual Funds",       current: mf.current,    invested: mf.invested },
    { key: "equity", label: "Equity Stocks",             current: eq.current,    invested: eq.invested },
    { key: "gold",   label: "Gold",                      current: gold.current,  invested: gold.invested }
  ];
  const netWorth = classes.reduce((s, c) => s + c.current, 0);
  return { classes, netWorth, eq, debt, mf, gold, cash };
}

// Today's P&L, Equity only — Debt is valued at invested amount (no
// intraday movement) and Mutual Funds/Gold don't carry a previous-
// close field the way Equity's live-price refresh does, so a
// portfolio-wide "today" figure would silently be wrong for those
// asset classes. Rows missing prevClose are excluded from both the
// P&L and its base value rather than treated as zero change.
function computeTodaysEquityPL() {
  let pl = 0, baseValue = 0, missing = 0;
  state.equity.forEach(row => {
    const units = Number(row.units) || 0;
    const ltp = Number(row.ltp);
    const prevClose = row.prevClose === null || row.prevClose === undefined ? NaN : Number(row.prevClose);
    if (!units || !isFinite(ltp) || !isFinite(prevClose)) { missing++; return; }
    pl += units * (ltp - prevClose);
    baseValue += units * prevClose;
  });
  const pct = baseValue > 0 ? (pl / baseValue) * 100 : 0;
  return { pl, pct, missing };
}

// A simple, honest market-hours heuristic (Mon-Fri 9:15-15:30 IST) —
// doesn't account for exchange holidays, just gives the header a
// reasonable open/closed signal without needing a live feed for it.
function isIndianMarketOpenNow() {
  const now = new Date();
  const istString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const ist = new Date(istString);
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutesNow = ist.getHours() * 60 + ist.getMinutes();
  return minutesNow >= (9 * 60 + 15) && minutesNow <= (15 * 60 + 30);
}

// "What needs your attention" — every item here reads off data that
// already exists elsewhere (allocation drift from state.ideal, debt
// maturity from maturityStatus(), attractive stocks from Intelligent
// Insights' own category grouping). Nothing new is calculated, only
// surfaced. Allocation drift below ATTENTION_DRIFT_THRESHOLD points
// is treated as within tolerance and not shown, so small/expected
// drift doesn't create noise.
const ATTENTION_DRIFT_THRESHOLD = 3;

function computeAttentionItems() {
  const items = [];
  const { classes, netWorth } = computeAssetClassesAndNetWorth();

  classes.forEach(c => {
    const currentPct = netWorth > 0 ? (c.current / netWorth) * 100 : 0;
    const idealPct = Number(state.ideal[c.key]) || 0;
    const diffPct = currentPct - idealPct;
    if (Math.abs(diffPct) < ATTENTION_DRIFT_THRESHOLD) return;
    const diffAmount = (diffPct / 100) * netWorth;
    const over = diffPct > 0;
    items.push({
      kind: "allocation",
      severity: "warn",
      title: `${c.label} allocation is ${fmtNum(Math.abs(diffPct), 1)}% ${over ? "above" : "below"} target`,
      detail: `Current ${fmtNum(currentPct, 1)}% · Target ${fmtNum(idealPct, 1)}% · ${over ? "Overweight" : "Underweight"} ${fmtINR(Math.abs(diffAmount))}`,
      actionLabel: "Rebalance",
      onAction: openIdealTargetsModal,
      sortKey: Math.abs(diffPct)
    });
  });

  const maturingSoon = state.debt.filter(row => maturityStatus(row.maturityDate) === "maturity-soon");
  if (maturingSoon.length > 0) {
    const nearest = [...maturingSoon].sort((a, b) => (a.maturityDate || "").localeCompare(b.maturityDate || ""))[0];
    items.push({
      kind: "maturity",
      severity: "warn",
      title: `${maturingSoon.length} ${maturingSoon.length === 1 ? "investment is" : "investments are"} maturing in the next 30 days`,
      detail: `Next maturity: ${fmtINR(Number(nearest.maturityAmount) || 0)} on ${nearest.maturityDate || "—"}`,
      actionLabel: "View debt",
      onAction: () => goToTab("debt"),
      sortKey: 50
    });
  }

  const eligible = state.equity.filter(row => !isETFEquity(row));
  if (eligible.length > 0) {
    const screenerMap = buildScreenerMap();
    const insights = eligible.map(row => computeStockInsight(row, screenerMap));
    const attractive = insights.filter(ins => !ins.insufficientData && ins.category === "Consider Adding");
    if (attractive.length > 0) {
      items.push({
        kind: "opportunity",
        severity: "good",
        title: `${attractive.length} stock${attractive.length === 1 ? "" : "s"} look${attractive.length === 1 ? "s" : ""} attractive`,
        detail: "Based on valuation, fundamentals and current portfolio allocation",
        actionLabel: "View opportunities",
        onAction: () => goToTab("stockanalysis"),
        sortKey: 20
      });
    }
  }

  items.sort((a, b) => b.sortKey - a.sortKey);
  return items.slice(0, 5);
}

// View-only filter state for "What needs your attention" on the
// Dashboard — never persisted, purely which items are shown.
let dashAttnFilter = "all";

function renderDashAttention() {
  const el = document.getElementById("dashAttentionList");
  if (!el) return;
  const allItems = computeAttentionItems();
  updateNotifBadge(allItems.length);
  updateAttnCountBadge("dashAttnCount", allItems.length);
  const items = dashAttnFilter === "all" ? allItems : allItems.filter(i => i.kind === dashAttnFilter);

  if (allItems.length === 0) {
    el.innerHTML = `<div class="dash-attn-empty">Nothing urgent right now — allocation, opportunities and upcoming maturities all look within range.</div>`;
    return;
  }
  if (items.length === 0) {
    el.innerHTML = `<div class="dash-attn-empty">No items match this filter right now.</div>`;
    return;
  }
  el.innerHTML = "";
  items.forEach(item => {
    const row = document.createElement("div");
    row.className = "dash-attn-item";
    row.innerHTML = `
      <div class="dash-attn-top">
        <div class="dash-attn-dot ${item.severity}"></div>
        <div class="dash-attn-body">
          <div class="dash-attn-title">${escapeAttr(item.title)}</div>
          <div class="dash-attn-detail">${escapeAttr(item.detail)}</div>
        </div>
      </div>
      <button class="dash-attn-action">${escapeAttr(item.actionLabel)}</button>
    `;
    row.querySelector(".dash-attn-action").addEventListener("click", item.onAction);
    el.appendChild(row);
  });
}

// Portfolio Health — a new composite score (not present before this
// redesign), built entirely from numbers the app already computes
// elsewhere: allocation drift (state.ideal vs actual), equity
// concentration/sector count for Diversification, and the same
// valuation/health verdicts Intelligent Insights already assigns per
// stock for Valuation/Quality. Risk combines concentration with
// debt overweight. Weights/thresholds here are a judgment call, not
// a recalculation of anything else in the app.
function computeHealthScore() {
  const { classes, netWorth } = computeAssetClassesAndNetWorth();

  // Allocation
  const drifts = classes.map(c => {
    const currentPct = netWorth > 0 ? (c.current / netWorth) * 100 : 0;
    const idealPct = Number(state.ideal[c.key]) || 0;
    return Math.abs(currentPct - idealPct);
  });
  const avgDrift = drifts.reduce((a, b) => a + b, 0) / drifts.length;
  const allocationScore = clamp(100 - avgDrift * 3, 0, 100);

  const eligible = state.equity.filter(row => !isETFEquity(row));
  const totalEquityInvested = state.equity.reduce((s, r) => s + (Number(r.invested) || 0), 0);
  const largestStockPct = totalEquityInvested > 0
    ? Math.max(0, ...state.equity.map(r => ((Number(r.invested) || 0) / totalEquityInvested) * 100))
    : 0;
  const sectorCount = new Set(state.equity.map(r => (r.sector || "").trim()).filter(Boolean)).size;

  // Diversification
  const diversificationScore = clamp(100 - Math.max(0, largestStockPct - 10) * 3 + Math.min(sectorCount, 8) * 1.5, 0, 100);

  let valuationScore = 50, qualityScore = 50, worstNote = null;
  if (eligible.length > 0) {
    const screenerMap = buildScreenerMap();
    const insights = eligible.map(row => computeStockInsight(row, screenerMap));
    const scoreFromVerdicts = (getVerdict) => {
      const weights = { attractive: 100, strong: 100, neutral: 60, unattractive: 20, weak: 20 };
      const known = insights.map(getVerdict).filter(v => v !== "unknown");
      if (known.length === 0) return 50;
      return known.reduce((s, v) => s + (weights[v] ?? 60), 0) / known.length;
    };
    valuationScore = scoreFromVerdicts(ins => ins.valuation);
    qualityScore = scoreFromVerdicts(ins => ins.health);
  }

  // Risk — inverse of equity concentration and debt overweight.
  const debtRow = classes.find(c => c.key === "debt");
  const debtCurrentPct = netWorth > 0 ? (debtRow.current / netWorth) * 100 : 0;
  const debtIdealPct = Number(state.ideal.debt) || 0;
  const debtOverweight = Math.max(0, debtCurrentPct - debtIdealPct);
  const riskScore = clamp(100 - Math.max(0, largestStockPct - 10) * 2 - debtOverweight * 1.5, 0, 100);

  const dims = [
    { key: "Allocation", score: allocationScore },
    { key: "Diversification", score: diversificationScore },
    { key: "Valuation", score: valuationScore },
    { key: "Quality", score: qualityScore },
    { key: "Risk", score: riskScore }
  ];
  const overall = dims.reduce((s, d) => s + d.score, 0) / dims.length;
  const worst = [...dims].sort((a, b) => a.score - b.score)[0];

  let label = "Good", cls = "good";
  if (overall < 50) { label = "Needs attention"; cls = "poor"; }
  else if (overall < 72) { label = "Fair"; cls = "fair"; }

  let note = "Your portfolio is healthy overall.";
  if (worst.score < 65) {
    const noteMap = {
      Allocation: "but your asset allocation has drifted meaningfully from target.",
      Diversification: "but concentration in a single stock or sector is on the higher side.",
      Valuation: "but a meaningful share of your equity holdings look expensive right now.",
      Quality: "but some holdings show weaker fundamental health than ideal.",
      Risk: "but concentration and debt overweight are adding more risk than ideal."
    };
    note = `Your portfolio is healthy overall, ${noteMap[worst.key]}`;
  }

  return { overall, label, cls, dims, note };
}

function healthDimCls(score) {
  if (score >= 72) return "good";
  if (score >= 50) return "fair";
  return "poor";
}

function renderDashHealth() {
  const el = document.getElementById("dashHealthBody");
  if (!el) return;
  const h = computeHealthScore();
  el.innerHTML = `
    <div class="dash-health-score-row">
      <span class="dash-health-score ${h.cls}">${fmtNum(h.overall, 0)}</span>
      <span class="dash-health-label">/100 · ${escapeAttr(h.label)}</span>
    </div>
    ${h.dims.map(d => `
      <div class="dash-health-row"><span>${escapeAttr(d.key)}</span><span>${fmtNum(d.score, 0)}</span></div>
      <div class="dash-health-track"><div class="dash-health-fill ${healthDimCls(d.score)}" style="width:${Math.max(2, d.score)}%"></div></div>
    `).join("")}
    <div class="dash-health-note">${escapeAttr(h.note)}</div>
  `;
}

// Donut + table + single-alert Asset Allocation card, matching the
// reference layout: colored ring with the net worth centered inside
// it, a 5-column table (dot/label, Current %, Target %, Variance,
// Amount) to its right, and — only when something is meaningfully
// overweight — one alert bar naming the worst offender with a
// rebalance shortcut. Reads the exact same classes/netWorth/
// state.ideal as everything else on the Dashboard; only the
// presentation is new.
function renderDashAllocDonut(classes, netWorth) {
  const ctx = document.getElementById("dashAllocDonut");
  if (!ctx || typeof Chart === "undefined") return; // fails quietly if the Chart.js CDN hiccups — table/alert still work
  const labels = classes.map(c => c.label);
  const data = classes.map(c => c.current);
  const colors = classes.map(c => ASSET_COLORS[c.key]);
  // Ring border must match the card surface (not a hardcoded dark navy
  // left over from when dark was the only theme), so re-read it live —
  // this keeps the donut correct across light/dark and the theme toggle.
  const ringBorder = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#ffffff";

  try {
    if (dashAllocDonutChart) {
      dashAllocDonutChart.data.labels = labels;
      dashAllocDonutChart.data.datasets[0].data = data;
      dashAllocDonutChart.data.datasets[0].backgroundColor = colors;
      dashAllocDonutChart.data.datasets[0].borderColor = ringBorder;
      dashAllocDonutChart.update();
      return;
    }
    dashAllocDonutChart = new Chart(ctx, {
      type: "doughnut",
      data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: ringBorder, borderWidth: 2 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtINR(ctx.parsed)}` } },
          datalabels: { display: false }
        },
        cutout: "72%"
      }
    });
  } catch (e) {
    console.error("Dashboard allocation donut render failed", e);
  }
}

function renderDashAllocation() {
  const { classes, netWorth } = computeAssetClassesAndNetWorth();
  renderDashAllocDonut(classes, netWorth);

  const totalEl = document.getElementById("dashAllocDonutTotal");
  if (totalEl) totalEl.textContent = fmtINRCompact(netWorth, 2);

  const tbody = document.getElementById("dashAllocTableBody");
  if (!tbody) return;

  let worstOver = null;
  tbody.innerHTML = classes.map(c => {
    const currentPct = netWorth > 0 ? (c.current / netWorth) * 100 : 0;
    const idealPct = Number(state.ideal[c.key]) || 0;
    const diffPct = currentPct - idealPct;
    const diffAmount = c.current - (idealPct / 100) * netWorth;
    const varCls = diffPct > ATTENTION_DRIFT_THRESHOLD ? "over" : diffPct < -ATTENTION_DRIFT_THRESHOLD ? "under" : "";

    if (diffPct > ATTENTION_DRIFT_THRESHOLD && (!worstOver || diffAmount > worstOver.diffAmount)) {
      worstOver = { label: c.label, diffAmount };
    }

    return `
      <tr>
        <td data-label="Asset Class"><span class="dash-alloc-dot" style="background:${ASSET_COLORS[c.key]}"></span>${escapeAttr(c.label)}</td>
        <td data-label="Invested">${fmtINR(c.current)}</td>
        <td data-label="Current">${fmtNum(currentPct, 1)}%</td>
        <td data-label="Target">${fmtNum(idealPct, 1)}%</td>
        <td data-label="Variance" class="dash-alloc-var ${varCls}">${diffPct >= 0 ? "+" : ""}${fmtNum(diffPct, 1)}%</td>
        <td data-label="Amount" class="dash-alloc-var ${varCls}">${fmtINRCompactSigned(diffAmount, 1)}</td>
      </tr>
    `;
  }).join("");

  const alertEl = document.getElementById("dashAllocAlert");
  if (alertEl) {
    if (worstOver) {
      alertEl.style.display = "";
      document.getElementById("dashAllocAlertText").textContent =
        `${worstOver.label} is ${fmtINRCompact(worstOver.diffAmount, 1)} above your target. Consider rebalancing.`;
    } else {
      alertEl.style.display = "none";
    }
  }
}

// Opens the existing ideal-% editor (previously an always-visible
// table) inside a modal instead — same fields, same state.ideal
// writes, same renderDashboard() refresh on change; just relocated
// out of the main scroll so the Dashboard itself stays uncluttered.
function openIdealTargetsModal() {
  const { classes, netWorth } = computeAssetClassesAndNetWorth();
  const idealTotal = Object.values(state.ideal).reduce((a, b) => a + (Number(b) || 0), 0);
  const locked = isReadOnly();
  const rowsHTML = classes.map(c => {
    const currentPct = netWorth > 0 ? (c.current / netWorth) * 100 : 0;
    const idealPct = Number(state.ideal[c.key]) || 0;
    const diffPct = currentPct - idealPct;
    const diffAmount = (diffPct / 100) * netWorth;
    return `
      <tr>
        <td class="left"><div class="alloc-name"><span class="swatch" style="background:${ASSET_COLORS[c.key]}"></span>${escapeAttr(c.label)}</div></td>
        <td data-label="Current Value">${fmtINR(c.current)}</td>
        <td data-label="Current %">${fmtNum(currentPct)}%</td>
        <td data-label="Target %"><input class="ideal-input" type="number" step="any" value="${idealPct}" data-key="${c.key}" ${locked ? "disabled" : ""}></td>
        <td class="${plClass(diffPct)}" data-label="Diff %">${diffPct >= 0 ? "+" : ""}${fmtNum(diffPct)}%</td>
        <td class="${plClass(diffAmount)}" data-label="Diff Amount">${diffAmount >= 0 ? "+" : ""}${fmtINR(diffAmount)}</td>
      </tr>
    `;
  }).join("");

  openModal(
    "Edit allocation targets",
    `
      <p class="settings-note" style="margin-top:0">Target % is editable per row — used only to compute the drift shown on the Dashboard. Debt is valued at amount invested (FDs don't fluctuate day-to-day); Equity, Mutual Fund, and Gold ETF values use live prices fetched from your Google Sheet where available.</p>
      <div class="table-scroll-wrap">
        <table>
          <thead><tr><th class="left">Asset Class</th><th>Current Value</th><th>Current %</th><th>Target %</th><th>Diff %</th><th>Diff Amount</th></tr></thead>
          <tbody>${rowsHTML}</tbody>
          <tfoot><tr><td class="left">Total</td><td>${fmtINR(netWorth)}</td><td>100%</td><td>${fmtNum(idealTotal)}%</td><td>—</td><td>—</td></tr></tfoot>
        </table>
      </div>
    `,
    [{ label: "Done", primary: true, onClick: closeModal }]
  );

  document.querySelectorAll(".ideal-input").forEach(input => {
    input.addEventListener("change", (e) => {
      state.ideal[e.target.dataset.key] = parseFloat(e.target.value) || 0;
      saveState();
      renderDashboard();
      openIdealTargetsModal();
    });
  });
}

// UI entry point only, per the redesign brief — collects an amount
// and explains what's coming next, without touching any backend
// allocation/rebalancing logic.
function openAddMoneyModal() {
  openModal(
    "Add new money",
    `
      <p class="settings-note" style="margin-top:0">Enter an amount to see a suggested allocation across your asset classes and top opportunities, based on your current vs. target allocation, valuation, and portfolio risk.</p>
      <div class="settings-field">
        <label>Amount to invest</label>
        <input type="text" inputmode="decimal" id="addMoneyAmount" placeholder="e.g. 50000">
      </div>
      <p class="settings-note" id="addMoneyNote"></p>
    `,
    [
      { label: "Cancel", onClick: closeModal },
      {
        label: "Get suggestion", primary: true, onClick: () => {
          const val = parseFloat((document.getElementById("addMoneyAmount").value || "").replace(/,/g, ""));
          const noteEl = document.getElementById("addMoneyNote");
          if (!val || val <= 0) { noteEl.textContent = "Enter a valid amount first."; return; }
          noteEl.textContent = `Suggested-allocation logic for ${fmtINR(val)} is coming in a future update — for now, check "Asset allocation" and "Investment opportunities" above for where you're underweight and what looks attractive.`;
        }
      }
    ]
  );
}

// Investment Opportunities — top 5 by the existing Intelligent
// Insights score, restricted to "Consider Adding"/"Watch" so the
// Dashboard only ever surfaces stocks that insight engine itself
// already flagged as worth a look. No separate scoring logic.
function computeDashboardOpportunities() {
  const eligible = state.equity.filter(row => !isETFEquity(row));
  if (eligible.length === 0) return [];
  const screenerMap = buildScreenerMap();
  const insights = eligible
    .map(row => computeStockInsight(row, screenerMap))
    .filter(ins => !ins.insufficientData && (ins.category === "Consider Adding" || ins.category === "Watch"));
  insights.sort((a, b) => {
    const sa = computeInsightScoreDisplay(a.valuation, a.health, a.growth).score ?? -1;
    const sb = computeInsightScoreDisplay(b.valuation, b.health, b.growth).score ?? -1;
    return sb - sa;
  });
  return insights.slice(0, 5);
}

const VALUATION_LABELS = { attractive: "Cheap", neutral: "Fair", unattractive: "Expensive", unknown: "—" };

function renderDashOpportunities() {
  const el = document.getElementById("dashOpportunitiesList");
  if (!el) return;
  const opportunities = computeDashboardOpportunities();
  if (opportunities.length === 0) {
    el.innerHTML = `<div class="dash-opp-empty">No standout opportunities right now — check Intelligent Insights on the Stock Analysis tab for the full picture.</div>`;
    return;
  }
  el.innerHTML = opportunities.map(ins => {
    const score = computeInsightScoreDisplay(ins.valuation, ins.health, ins.growth);
    const isAdd = ins.category === "Consider Adding";
    const totalInvested = state.equity.reduce((s, r) => s + (Number(r.invested) || 0), 0);
    const allocPct = totalInvested > 0 ? (Number(ins.row.invested) / totalInvested) * 100 : 0;
    return `
      <div class="dash-opp-row">
        <span class="dash-opp-name" title="${escapeAttr(ins.row.name || "")}">${escapeAttr(ins.row.name || "(unnamed)")}</span>
        <span class="dash-opp-score ${isAdd ? "add" : "watch"}">${score.score ?? "—"}</span>
        <span class="dash-opp-tag">${VALUATION_LABELS[ins.valuation] || "—"}</span>
        <span class="dash-opp-alloc">${fmtNum(allocPct, 1)}% / ${ins.allocMax !== null ? ins.allocMax + "%" : "—"}</span>
        <span class="dash-opp-action ${isAdd ? "add" : "watch"}">${isAdd ? "BUY" : "WATCH"}</span>
      </div>
    `;
  }).join("");
}

function renderDashPerformers() {
  const { positives, negatives } = computeEquityPerformers();
  const topEl = document.getElementById("dashTopContributors");
  const lowEl = document.getElementById("dashBiggestLosers");
  if (!topEl || !lowEl) return;

  const renderList = (target, items, emptyMsg) => {
    if (items.length === 0) { target.innerHTML = `<div class="dash-perf-empty">${emptyMsg}</div>`; return; }
    target.innerHTML = items.slice(0, 3).map(({ row, d }) => `
      <div class="dash-perf-item">
        <span class="dash-perf-name" title="${escapeAttr(row.name || "")}">${escapeAttr(row.name || "(unnamed)")}</span>
        <span class="dash-perf-val ${plClass(d.pl) === "muted" ? "" : plClass(d.pl)}">${d.pl >= 0 ? "+" : ""}${fmtINR(d.pl)}</span>
      </div>
    `).join("");
  };
  renderList(topEl, positives, "No gainers yet.");
  renderList(lowEl, negatives, "No losers — nothing in the red.");
}

function renderDashBreakdown() {
  const grid = document.getElementById("dashBreakdownGrid");
  const totalEl = document.getElementById("dashBreakdownTotal");
  if (!grid || !totalEl) return;
  const { netWorth } = computeAssetClassesAndNetWorth();
  const rows = [
    { n: state.equity.length, l: "Total Stocks" },
    { n: state.mf.length, l: "Mutual Funds" },
    { n: state.debt.length, l: "Debt Instruments" },
    { n: state.gold.length, l: "Gold Holdings" }
  ];
  grid.innerHTML = rows.map(r => `
    <div class="dash-breakdown-item">
      <div class="dash-breakdown-n">${r.n}</div>
      <div class="dash-breakdown-l">${escapeAttr(r.l)}</div>
    </div>
  `).join("");
  totalEl.textContent = fmtINR(netWorth);
}

// Time-of-day greeting for the Dashboard header — "Good morning/
// afternoon/evening, Ganesh" based on the viewer's local clock, plus
// a fixed one-line sub. Purely cosmetic; replaces the static
// "Dashboard" / "Your portfolio at a glance" text these two elements
// used to hold.
/* ============================================================
   PORTFOLIO PERFORMANCE CHART (Dashboard)
   "Your invested capital vs a Nifty 50 equivalent" — a money-weighted
   comparison built from `tradeBook.trades` (see the TRADE BOOK block
   near saveState()) and Nifty History (fetchNiftyHistoryData()).

   Why not a real "your portfolio's value over time" line: that would
   need a daily historical price for every stock/fund ever held, which
   this app has no source for (only live current prices). What IS
   fully computable from data already on hand: for every trade,
   simulate that the same rupee amount, on the same date, had instead
   bought/sold Nifty 50 at that date's close — sum that up over time
   for a "Nifty-equivalent" value series, and separately track
   cumulative net invested capital (cost basis) on the same axis.
   Today's actual current value (from equityTotals()/mfTotals()/
   goldTotals(), which DO have live prices) is shown as a callout next
   to the chart rather than faked as a historical line.
   ============================================================ */

let portfolioPerfChart = null;
let niftyHistoryCache = null; // null = not loaded yet; [] = loaded but empty
let niftyHistoryLoadPromise = null;
let portfolioPerfSelectedPeriod = "1Y";
const PORTFOLIO_PERF_PERIOD_DAYS = { "1M": 30, "6M": 182, "1Y": 365, "3Y": 365 * 3, "5Y": 365 * 5 }; // "All" handled separately

// Fetches Nifty History once per page load and caches it — this data
// only changes once a day (the Apps Script trigger writes one new row
// per trading day), so there's no need to re-fetch on every 30-second
// dashboard refresh. Returns null on failure (network/CORS/parse/not
// configured) rather than throwing, since callers just want to know
// "usable or not" for rendering the placeholder vs. the chart.
function ensureNiftyHistoryLoaded() {
  if (niftyHistoryCache !== null) return Promise.resolve(niftyHistoryCache);
  if (niftyHistoryLoadPromise) return niftyHistoryLoadPromise;
  niftyHistoryLoadPromise = fetchNiftyHistoryData()
    .then(rows => { niftyHistoryCache = rows; return rows; })
    .catch(err => { console.error("Nifty History fetch failed:", err); niftyHistoryLoadPromise = null; return null; });
  return niftyHistoryLoadPromise;
}

// Composite index-and-invested series, one point per Nifty trading day
// from the first trade's date through the latest date Nifty History
// has. niftyRows must be sorted ascending by date (fetchNiftyHistoryData()
// already guarantees this).
function computeNiftyEquivalentSeries(trades, niftyRows) {
  if (!niftyRows || niftyRows.length === 0 || !trades || trades.length === 0) return null;

  const dates = niftyRows.map(r => r.date);
  const closeByDate = new Map(niftyRows.map(r => [r.date, r.close]));

  // Nearest available Nifty close ON OR BEFORE a given date (binary
  // search over the sorted date list) — handles trade dates that fall
  // on a weekend/holiday, or before the History sheet's own start.
  function closeOnOrBefore(dateStr) {
    let lo = 0, hi = dates.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= dateStr) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans === -1 ? null : closeByDate.get(dates[ans]);
  }

  // Only equity/mf/gold trades are relevant here (that's everything
  // the trade book covers) — signed by trade type so sells reduce both
  // invested capital and the hypothetical Nifty position.
  const flows = trades
    .filter(t => t.tradeDate && !isNaN(Number(t.quantity)) && !isNaN(Number(t.price)))
    .map(t => ({
      date: String(t.tradeDate).slice(0, 10),
      amount: Number(t.quantity) * Number(t.price) * (String(t.tradeType).toLowerCase() === "sell" ? -1 : 1)
    }))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  if (flows.length === 0) return null;

  const firstDate = flows[0].date;
  const relevantDates = dates.filter(d => d >= firstDate);
  if (relevantDates.length === 0) return null;

  let flowIdx = 0, cumUnits = 0, cumInvested = 0;
  const series = [];
  relevantDates.forEach(d => {
    while (flowIdx < flows.length && flows[flowIdx].date <= d) {
      const f = flows[flowIdx];
      const priceOnFlowDate = closeOnOrBefore(f.date);
      if (priceOnFlowDate) cumUnits += f.amount / priceOnFlowDate;
      cumInvested += f.amount;
      flowIdx++;
    }
    series.push({ date: d, niftyEquivalent: cumUnits * closeByDate.get(d), invested: cumInvested });
  });
  return series;
}

// Slices a full series down to the trailing N days of its own date
// range (not wall-clock "today", so the chart still shows something
// sensible even if Nifty History hasn't captured today's row yet).
// Falls back to the full series if the whole trade history is younger
// than the requested period.
function filterSeriesByPeriod(series, periodKey) {
  if (!series || series.length === 0 || periodKey === "All") return series;
  const days = PORTFOLIO_PERF_PERIOD_DAYS[periodKey];
  if (!days) return series;
  const lastDate = new Date(series[series.length - 1].date + "T00:00:00");
  const cutoff = new Date(lastDate);
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const filtered = series.filter(s => s.date >= cutoffStr);
  return filtered.length > 1 ? filtered : series;
}

function drawPortfolioPerfChart(series) {
  const canvas = document.getElementById("dashPerfChart");
  if (!canvas) return;
  const labels = series.map(s => s.date);
  const niftyData = series.map(s => Math.round(s.niftyEquivalent));
  const investedData = series.map(s => Math.round(s.invested));
  const textMuted = getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim() || "#6b6862";
  const border = getComputedStyle(document.documentElement).getPropertyValue("--border").trim() || "#e6e3da";
  const gold = getComputedStyle(document.documentElement).getPropertyValue("--gold").trim() || "#a3742f";

  if (portfolioPerfChart) {
    portfolioPerfChart.data.labels = labels;
    portfolioPerfChart.data.datasets[0].data = niftyData;
    portfolioPerfChart.data.datasets[1].data = investedData;
    portfolioPerfChart.update();
    return;
  }

  portfolioPerfChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Nifty 50 equivalent (your money, same dates)", data: niftyData, borderColor: gold, backgroundColor: gold, pointRadius: 0, borderWidth: 2, tension: 0.15 },
        { label: "Your net invested capital", data: investedData, borderColor: textMuted, backgroundColor: textMuted, pointRadius: 0, borderWidth: 1.5, borderDash: [4, 3], tension: 0 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { color: textMuted, font: { family: "Inter", size: 11 }, boxWidth: 10, padding: 12 } },
        datalabels: { display: false }, // this app registers ChartDataLabels globally — a multi-hundred-point line needs it off
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtINR(ctx.parsed.y)}` } }
      },
      scales: {
        x: { ticks: { color: textMuted, maxTicksLimit: 7, font: { size: 10.5 } }, grid: { display: false } },
        y: { ticks: { color: textMuted, font: { size: 10.5 }, callback: (v) => fmtINRCompact(v, 1) }, grid: { color: border } }
      }
    }
  });
}

function renderPortfolioPerfSummary(fullSeries) {
  const el = document.getElementById("dashPerfSummary");
  if (!el || !fullSeries || fullSeries.length === 0) return;
  const last = fullSeries[fullSeries.length - 1];
  const actualCurrent = equityTotals().current + mfTotals().current + goldTotals().current;
  const diff = actualCurrent - last.niftyEquivalent;
  const diffPct = last.niftyEquivalent > 0 ? (diff / last.niftyEquivalent) * 100 : 0;
  el.innerHTML = `
    <span>Your actual value today <b>${fmtINR(actualCurrent)}</b> <span class="hint">(Equity + MF + Gold, live prices)</span></span>
    <span>Net invested capital <b>${fmtINR(last.invested)}</b></span>
    <span>If invested in Nifty on the same dates <b>${fmtINR(Math.round(last.niftyEquivalent))}</b></span>
    <span class="${plClass(diff)}">${diff >= 0 ? "Outperforming" : "Underperforming"} Nifty by <b>${fmtINRCompactSigned(diff, 2)}</b> (${diff >= 0 ? "+" : ""}${diffPct.toFixed(1)}%)</span>
  `;
}

// Cached so period-button clicks don't need to recompute the whole
// series (only re-slice + redraw) — invalidated whenever trades or
// Nifty History actually change.
let portfolioPerfFullSeries = null;
let portfolioPerfFullSeriesKey = "";

function renderPortfolioPerformanceChart() {
  const placeholder = document.getElementById("dashPerfPlaceholder");
  const chartWrap = document.getElementById("dashPerfChartWrap");
  const periodGroup = document.getElementById("dashPerfPeriodGroup");
  const titleEl = document.getElementById("dashPerfPlaceholderTitle");
  const textEl = document.getElementById("dashPerfPlaceholderText");
  if (!placeholder || !chartWrap || !periodGroup) return;

  const showPlaceholder = (title, text, enablePeriods) => {
    placeholder.style.display = "";
    chartWrap.style.display = "none";
    titleEl.textContent = title;
    textEl.textContent = text;
    periodGroup.toggleAttribute("aria-disabled", !enablePeriods);
    periodGroup.querySelectorAll("button").forEach(b => { b.disabled = !enablePeriods; });
  };

  const hasTrades = tradeBook.trades.length > 0;
  const hasNiftyUrl = !!state.niftyHistoryApiUrl;

  if (!hasTrades) {
    showPlaceholder(
      "No trade book imported yet",
      "Import your trade book (Settings → Import Trade Book) to enable this chart — it compares your actual invested capital against a Nifty 50 equivalent using your real trade dates.",
      false
    );
    return;
  }
  if (!hasNiftyUrl) {
    showPlaceholder(
      "Nifty History not connected yet",
      'Add a "Nifty History API URL" in Settings (under Portfolio Performance Chart) to enable this chart — see the plan doc for the one-time Apps Script setup.',
      false
    );
    return;
  }

  ensureNiftyHistoryLoaded().then(niftyRows => {
    // Bail if the card isn't even on screen anymore by the time this
    // resolves (e.g. the person navigated away) — nothing to update.
    if (!document.getElementById("dashPerfChartWrap")) return;

    if (!niftyRows || niftyRows.length === 0) {
      showPlaceholder(
        "Couldn't load Nifty History",
        'Check the "Nifty History API URL" in Settings, and that the Apps Script Web App is deployed with "Anyone" access.',
        false
      );
      return;
    }

    const cacheKey = tradeBook.trades.length + ":" + niftyRows.length + ":" + (niftyRows[niftyRows.length - 1]?.date || "");
    if (portfolioPerfFullSeriesKey !== cacheKey) {
      portfolioPerfFullSeries = computeNiftyEquivalentSeries(tradeBook.trades, niftyRows);
      portfolioPerfFullSeriesKey = cacheKey;
    }

    if (!portfolioPerfFullSeries || portfolioPerfFullSeries.length < 2) {
      showPlaceholder(
        "Not enough data yet",
        "None of your trade dates overlap with the Nifty History range yet — the chart needs at least a couple of days of data to draw a line.",
        false
      );
      return;
    }

    placeholder.style.display = "none";
    chartWrap.style.display = "";
    periodGroup.removeAttribute("aria-disabled");
    periodGroup.querySelectorAll("button").forEach(b => { b.disabled = false; });

    drawPortfolioPerfChart(filterSeriesByPeriod(portfolioPerfFullSeries, portfolioPerfSelectedPeriod));
    renderPortfolioPerfSummary(portfolioPerfFullSeries);
  });
}

document.getElementById("dashPerfPeriodGroup")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-period]");
  if (!btn || btn.disabled) return;
  portfolioPerfSelectedPeriod = btn.dataset.period;
  document.querySelectorAll("#dashPerfPeriodGroup button").forEach(b => b.classList.toggle("active", b === btn));
  if (portfolioPerfFullSeries) {
    drawPortfolioPerfChart(filterSeriesByPeriod(portfolioPerfFullSeries, portfolioPerfSelectedPeriod));
  }
});

function renderDashGreeting() {
  const titleEl = document.getElementById("dashGreetingTitle");
  const subEl = document.getElementById("dashGreetingSub");
  if (!titleEl || !subEl) return;
  const hour = new Date().getHours();
  const period = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  titleEl.textContent = `Good ${period}, Ganesh \u{1F44B}`;
  subEl.textContent = "Here's what's happening with your investments today.";
}

// Market open/closed — shown both on the Dashboard header (dashMarketLabel/
// dashMarketDot) and, so it's visible from every tab, as a small pill in
// the app header (headerMarketLabel/headerMarketDot). Same isIndianMarketOpenNow()
// call feeds both; only the two DOM targets differ.
function renderMarketStatusInto(labelId, dotId) {
  const labelEl = document.getElementById(labelId);
  const dotEl = document.getElementById(dotId);
  const open = isIndianMarketOpenNow();
  if (labelEl) labelEl.textContent = open ? "Market open" : "Market closed";
  if (dotEl) dotEl.className = dotEl.className.replace(/\bdash-market-dot\b.*/, "").trim();
  if (dotEl) dotEl.classList.add("dash-market-dot", open ? "open" : "closed");
}

function renderDashHeaderBits() {
  renderDashGreeting();
  const lastEl = document.getElementById("dashLastUpdated");
  if (lastEl) lastEl.textContent = "Last updated: " + (state.lastSaved ? new Date(state.lastSaved).toLocaleTimeString() : "—");
  const open = isIndianMarketOpenNow();
  const labelEl = document.getElementById("dashMarketLabel");
  const dotEl = document.getElementById("dashMarketDot");
  if (labelEl) labelEl.textContent = open ? "Open" : "Closed";
  if (dotEl) dotEl.className = "dash-market-dot " + (open ? "open" : "closed");
  renderMarketStatusInto("headerMarketLabel", "headerMarketDot");
}

// Switches to another tab exactly the way clicking its button would —
// reuses the existing tab-switch handler rather than duplicating its
// panel/active-class logic here. The four asset classes now live as
// sub-tabs inside Portfolio rather than top-level tabs, so those keys
// route through switchPortfolioSubTab() instead of looking for a
// (no longer existing) top-level button.
const PORTFOLIO_SUBTABS = ["equity", "debt", "mf", "gold"];

function goToTab(tabKey) {
  if (PORTFOLIO_SUBTABS.includes(tabKey)) {
    const btn = document.querySelector('.tab-btn[data-tab="portfolio"]');
    if (btn) btn.click();
    switchPortfolioSubTab(tabKey);
    return;
  }
  const btn = document.querySelector(`.tab-btn[data-tab="${tabKey}"]`);
  if (btn) btn.click();
}

// Swaps which of the four existing asset-class panels is visible
// inside the Portfolio tab. Each panel already fully re-renders on
// every data change regardless of visibility (same as before this
// restructuring — only Insights guards on active state), so no
// render call is needed here, just the class swap.
function switchPortfolioSubTab(key) {
  document.querySelectorAll(".portfolio-selector-btn").forEach(b => b.classList.toggle("active", b.dataset.subtab === key));
  document.querySelectorAll(".portfolio-subpanel").forEach(p => p.classList.toggle("active", p.id === "panel-" + key));
}

document.querySelectorAll(".portfolio-selector-btn").forEach(btn => {
  btn.addEventListener("click", () => switchPortfolioSubTab(btn.dataset.subtab));
});

function renderDashboard() {
  const cashInput = document.getElementById("cashInput");
  if (document.activeElement !== cashInput) cashInput.value = state.cash ? fmtINR(state.cash) : "";
  cashInput.disabled = isReadOnly();

  const { eq, netWorth } = computeAssetClassesAndNetWorth();
  const debt = debtTotals();
  const mf = mfTotals();
  const gold = goldTotals();
  const totalInvested = debt.invested + mf.invested + eq.invested + gold.invested; // cash excluded from "invested"
  // Debt/cash don't have a live mark-to-market P&L (FDs are valued
  // at invested amount, not fluctuating day-to-day) — Equity, MF
  // and Gold all now carry real invested-vs-current P&L.
  const overallPL = eq.pl + mf.pl + gold.pl;
  const overallPLBase = eq.invested + mf.invested + gold.invested;
  const overallPLPct = overallPLBase > 0 ? (overallPL / overallPLBase) * 100 : 0;

  // Hero KPI values use the compact Indian format (₹1.21 Cr / ₹18.24 L)
  // so they read at a glance — the exact digit-grouped figure is still
  // one hover away via the title tooltip, and every underlying number
  // (netWorth, totalInvested, overallPL, today.pl) is unchanged.
  const statNetWorthEl = document.getElementById("statNetWorth");
  statNetWorthEl.textContent = fmtINRCompact(netWorth, 2);
  statNetWorthEl.title = fmtINR(netWorth);
  const statTotalInvestedEl = document.getElementById("statTotalInvested");
  statTotalInvestedEl.textContent = fmtINRCompact(totalInvested, 2);
  statTotalInvestedEl.title = fmtINR(totalInvested);
  const plEl = document.getElementById("statOverallPL");
  plEl.textContent = fmtINRCompactSigned(overallPL, 2);
  plEl.title = fmtINR(overallPL);
  plEl.className = "dash-kpi-value " + plClass(overallPL);
  document.getElementById("statOverallPLPct").textContent = fmtPct(overallPLPct) + " (Equity + MF + Gold)";

  const today = computeTodaysEquityPL();
  const todayPLEl = document.getElementById("statTodayPL");
  todayPLEl.textContent = fmtINRCompactSigned(today.pl, 2);
  todayPLEl.title = fmtINR(today.pl);
  todayPLEl.className = "dash-kpi-value " + plClass(today.pl);
  document.getElementById("statTodayPLPct").textContent = fmtPct(today.pct) + (today.missing > 0 ? ` · ${today.missing} stock(s) missing live data` : "");

  renderDashHeaderBits();
  renderDashAttention();
  renderDashHealth();
  renderDashAllocation();
  renderDashOpportunities();
  renderDashPerformers();
  renderDashBreakdown();
  renderMarketSnapshot();
  renderPortfolioPerformanceChart();
  // Keeps Insights live whenever it's the visible tab (e.g. during the
  // 30-second auto price refresh); renderInsights() itself no-ops if
  // that tab isn't currently open.
  renderInsights();
  // Stock Analysis joins live off Equity's LTP/Sector, so it needs the
  // same refresh trigger — cheap enough (no chart) to just always run.
  renderStockAnalysis();
}

function renderPieChart(classes, netWorth) {
  const ctx = document.getElementById("allocPie");
  if (!ctx) return; // canvas removed from the redesigned Dashboard — bars replace the donut
  const labels = classes.map(c => c.label);
  const data = classes.map(c => netWorth > 0 ? +(c.current / netWorth * 100).toFixed(2) : 0);
  const colors = classes.map(c => ASSET_COLORS[c.key]);

  if (pieChart) {
    pieChart.data.labels = labels;
    pieChart.data.datasets[0].data = data;
    pieChart.data.datasets[0].backgroundColor = colors;
    pieChart.update();
    return;
  }

  pieChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderColor: "#121b2c", borderWidth: 2 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: "#8b98b5", font: { family: "Inter", size: 11 }, padding: 12, boxWidth: 10 }
        },
        tooltip: {
          callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed}%` }
        },
        datalabels: {
          display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 3, // hide clutter on near-zero slivers
          color: "#0c1220",
          backgroundColor: "#ffffffcc",
          borderRadius: 4,
          padding: { top: 3, bottom: 3, left: 5, right: 5 },
          font: { family: "JetBrains Mono", size: 11, weight: "600" },
          formatter: (value) => value.toFixed(1) + "%"
        }
      },
      cutout: "62%"
    }
  });
}

/* ============================================================
   INSIGHTS TAB
   Purely a read-only view built from data that already exists on
   the Equity/Mutual Funds tabs — every number here comes straight
   from equityDerived()/mfDerived() and the totals already computed
   elsewhere, nothing is recalculated with different logic. Only
   rendered when the tab is actually visible (see the tab-switch
   handler and the piggyback call at the end of renderDashboard()),
   since Chart.js can't size a canvas that's inside a display:none
   panel.
   ============================================================ */

let sectorAllocChart = null;
let mfCategoryChart = null;

// Cycled by index rather than pinned per sector/category name — simple,
// and the palette is large enough that collisions are rare in a
// personal portfolio's sector/category count.
const INSIGHTS_PALETTE = [
  "#c9a44c", "#4bbf9c", "#6f93c9", "#e0667a", "#d9a441",
  "#8b98b5", "#2ec4b6", "#a78bfa", "#e0b04b", "#5c9ead"
];

// Top/worst are ranked by absolute P&L (rupees), matching the request
// literally — P&L% is still shown alongside for context.
function computeEquityPerformers() {
  const rows = state.equity.map(row => ({ row, d: equityDerived(row) }));
  const positives = rows.filter(r => r.d.pl > 0).sort((a, b) => b.d.pl - a.d.pl).slice(0, 5);
  const negatives = rows.filter(r => r.d.pl < 0).sort((a, b) => a.d.pl - b.d.pl).slice(0, 5);
  return { positives, negatives };
}

function renderPerformersList(containerId, items, emptyMessage) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (items.length === 0) {
    el.innerHTML = `<div class="insights-empty">${emptyMessage}</div>`;
    return;
  }
  const maxAbsPL = Math.max(...items.map(it => Math.abs(it.d.pl)));
  el.innerHTML = items.map(({ row, d }) => {
    const barPct = maxAbsPL > 0 ? Math.min(100, (Math.abs(d.pl) / maxAbsPL) * 100) : 0;
    const cls = plClass(d.pl);
    return `
      <div class="performer-row">
        <div class="performer-row-top">
          <span class="performer-name" title="${escapeAttr(row.name || "(unnamed)")}">${escapeAttr(row.name || "(unnamed)")}</span>
          <span class="performer-pl ${cls}">${fmtINR(d.pl)} · ${fmtPct(d.plPct)}</span>
        </div>
        <div class="performer-bar-track"><div class="performer-bar-fill ${cls === "muted" ? "" : cls}" style="width:${barPct}%"></div></div>
        <div class="performer-meta">Current Value: ${fmtINR(d.currentValue)}</div>
      </div>
    `;
  }).join("");
}

// Groups Equity current value by Sector. A blank/missing Sector is
// grouped under "Uncategorized" rather than dropped, so the total
// always reconciles with Equity's actual current value.
function computeSectorAllocation() {
  const map = new Map();
  state.equity.forEach(row => {
    const d = equityDerived(row);
    const sector = (row.sector || "").trim() || "Uncategorized";
    map.set(sector, (map.get(sector) || 0) + d.currentValue);
  });
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

// Same idea for Mutual Funds, grouped by Category instead of Sector.
// "Investment Value" here is current value — the same basis the MF
// tab's own Alloc % column already uses, so the two stay consistent.
function computeMFCategoryAllocation() {
  const map = new Map();
  state.mf.forEach(row => {
    const d = mfDerived(row);
    const category = (row.category || "").trim() || "Uncategorized";
    map.set(category, (map.get(category) || 0) + d.currentValue);
  });
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

// Shared donut renderer for both Insights charts — mirrors
// renderPieChart()'s Dashboard styling so Insights doesn't introduce
// a visually different chart language.
function renderInsightsDonut(existingChart, canvasId, entries, totalValue) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return existingChart;
  // Chart.js loads from a CDN — if that ever fails (outage, ad-blocker,
  // offline), throwing here would otherwise abort the rest of
  // renderInsights() including code that has nothing to do with
  // charts (the Mutual Fund Category table). Fail this one chart
  // quietly instead of taking the whole tab down with it.
  if (typeof Chart === "undefined") return existingChart;
  const labels = entries.map(e => e.label);
  const data = entries.map(e => totalValue > 0 ? +(e.value / totalValue * 100).toFixed(2) : 0);
  const colors = entries.map((_, i) => INSIGHTS_PALETTE[i % INSIGHTS_PALETTE.length]);

  try {
    if (existingChart) {
      existingChart.data.labels = labels;
      existingChart.data.datasets[0].data = data;
      existingChart.data.datasets[0].backgroundColor = colors;
      existingChart.update();
      return existingChart;
    }

    return new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderColor: "#121b2c", borderWidth: 2 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: "#8b98b5", font: { family: "Inter", size: 11 }, padding: 12, boxWidth: 10 }
        },
        tooltip: {
          callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed}%` }
        },
        datalabels: {
          display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 3,
          color: "#0c1220",
          backgroundColor: "#ffffffcc",
          borderRadius: 4,
          padding: { top: 3, bottom: 3, left: 5, right: 5 },
          font: { family: "JetBrains Mono", size: 11, weight: "600" },
          formatter: (value) => value.toFixed(1) + "%"
        }
      },
      cutout: "62%"
    }
  });
  } catch (e) {
    console.error("Chart render failed for", canvasId, e);
    return existingChart;
  }
}

/* ============================================================
   INTELLIGENT INSIGHTS (Equity)
   Decision-support only — combines each stock's allocation status
   (vs. Settings -> Equity Allocation Limits) with a fundamentals
   read-out built from the exact same figures Stock Analysis already
   computes (stockAnalysisDerived()) plus saved Banking Metrics for
   Financial-sector holdings. See computeStockInsight() below for the
   actual decision logic — nothing here treats low allocation as a Buy
   signal or high allocation as a Sell signal on its own.
   ============================================================ */

// Each verdict is deliberately NOT a single blended score — three
// independent reads (valuation / financial health / growth), each one
// of "attractive|unattractive|neutral|unknown" or "strong|weak|neutral|
// unknown" — so every factor behind a recommendation can be shown to
// the person rather than hidden inside one number. Thresholds below
// are simple, named, and adjustable in one place if they ever need
// tuning.

function fundamentalValuationVerdict(d) {
  const pbVerdict = () => {
    if (d.pb === null || !d.industryPbv) return "unknown";
    const pbRatio = d.pb / d.industryPbv;
    if (pbRatio <= 0.9) return "attractive";
    if (pbRatio >= 1.3) return "unattractive";
    return "neutral";
  };
  // Financial-sector stocks (banks/NBFC/insurance) don't use PE as a
  // valuation lens at all — earnings there can swing on provisioning,
  // write-offs or actuarial reserves, making PE unreliable. P/B vs
  // Industry P/B is the appropriate measure instead.
  if (d.isFinancial) return pbVerdict();
  // For everyone else: PE is skipped (not penalized) when missing,
  // zero, negative, or the industry figure isn't usable — a
  // negative/zero PE must never be read as "cheap". P/B fills in as a
  // fallback lens when PE isn't usable.
  if (d.pe === null || d.pe <= 0 || d.industryPe === null || d.industryPe <= 0) return pbVerdict();
  const peRatio = d.pe / d.industryPe;
  const pbRatio = (d.pb !== null && d.industryPbv) ? d.pb / d.industryPbv : null;
  if (peRatio <= 0.9 && (pbRatio === null || pbRatio <= 1.1)) return "attractive";
  if (peRatio >= 1.15 || (pbRatio !== null && pbRatio >= 1.3)) return "unattractive";
  return "neutral";
}

function fundamentalHealthVerdict(d, bankingLatest) {
  const signals = [];
  if (d.isFinancial) {
    // ROA + ROE (ROCE and Debt-to-Equity/Interest Coverage are still
    // skipped — leverage is structural for a lender/insurer, not a red
    // flag the way it would be for a manufacturer — but weak ROE/ROA
    // profitability itself is a genuine health concern for a bank).
    if (d.roa !== null) signals.push(d.roa >= 1 ? 1 : d.roa >= 0.5 ? 0 : -1);
    if (d.roe !== null) signals.push(d.roe >= 15 ? 1 : d.roe <= 8 ? -1 : 0);
    const isLender = /bank|nbfc/i.test(d.sector || "");
    if (isLender && bankingLatest && bankingLatest.metrics) {
      const m = bankingLatest.metrics;
      if (m.gnpa && m.gnpa.value !== null && m.gnpa.value !== undefined) signals.push(m.gnpa.value <= 2 ? 1 : m.gnpa.value <= 4 ? 0 : -1);
      if (m.crar && m.crar.value !== null && m.crar.value !== undefined) signals.push(m.crar.value >= 14 ? 1 : m.crar.value >= 11 ? 0 : -1);
      if (m.nim && m.nim.value !== null && m.nim.value !== undefined) signals.push(m.nim.value >= 3 ? 1 : m.nim.value >= 2 ? 0 : -1);
    } else if (!isLender && d.fcfPrevAnn !== null) {
      // Insurance (or another Financial match that isn't a lender):
      // no GNPA/CRAR/NIM to lean on, so Free Cash Flow direction
      // stands in as a general health signal instead.
      signals.push(d.fcfPrevAnn > 0 ? 1 : -1);
    }
  } else {
    if (d.roe !== null) signals.push(d.roe >= 15 ? 1 : d.roe >= 10 ? 0 : -1);
    if (d.roce !== null) signals.push(d.roce >= 15 ? 1 : d.roce >= 10 ? 0 : -1);
    if (d.debtToEquity !== null) signals.push(d.debtToEquity <= 0.5 ? 1 : d.debtToEquity <= 1.5 ? 0 : -1);
    if (d.intCoverage !== null) signals.push(d.intCoverage >= 5 ? 1 : d.intCoverage >= 2 ? 0 : -1);
  }
  if (signals.length === 0) return "unknown";
  const avg = signals.reduce((a, b) => a + b, 0) / signals.length;
  if (avg >= 0.4) return "strong";
  if (avg <= -0.4) return "weak";
  return "neutral";
}

function fundamentalGrowthVerdict(d) {
  const signals = [];
  if (d.epsGrowth3y !== null) signals.push(d.epsGrowth3y >= 12 ? 1 : d.epsGrowth3y >= 0 ? 0 : -1);
  if (d.epsGrowth5y !== null) signals.push(d.epsGrowth5y >= 12 ? 1 : d.epsGrowth5y >= 0 ? 0 : -1);
  if (d.profitVar3y !== null) signals.push(d.profitVar3y >= 12 ? 1 : d.profitVar3y >= 0 ? 0 : -1);
  if (d.salesGrowth5y !== null) signals.push(d.salesGrowth5y >= 10 ? 1 : d.salesGrowth5y >= 0 ? 0 : -1);
  if (d.qtrProfitVar !== null) signals.push(d.qtrProfitVar >= 10 ? 1 : d.qtrProfitVar >= 0 ? 0 : -1);
  if (signals.length === 0) return "unknown";
  const avg = signals.reduce((a, b) => a + b, 0) / signals.length;
  if (avg >= 0.4) return "strong";
  if (avg <= -0.4) return "weak";
  return "neutral";
}

// Short, factor-by-factor text shown under each stock — every number
// here is read straight from `d` (stockAnalysisDerived() output),
// never recalculated differently.
function describeInsightFactors(d) {
  const parts = [];
  if (d.isFinancial) {
    // Same rationale as fundamentalValuationVerdict()/
    // computeFundamentalView(): P/B and ROA are the meaningful lenses
    // for banks/NBFC/insurance, not PE/ROE/Debt-to-Equity.
    if (d.pb !== null && d.industryPbv) parts.push(`P/B ${fmtNum(d.pb, 2)} vs Industry ${fmtNum(d.industryPbv, 2)}`);
    if (d.roa !== null) parts.push(`ROA ${fmtNum(d.roa, 2)}%`);
    if (d.roe !== null) parts.push(`ROE ${fmtNum(d.roe, 1)}%`);
  } else {
    if (d.pe !== null && d.pe > 0 && d.industryPe !== null) parts.push(`PE ${fmtNum(d.pe, 1)} vs Industry ${fmtNum(d.industryPe, 1)}`);
    else if (d.pb !== null && d.industryPbv) parts.push(`P/B ${fmtNum(d.pb, 2)} vs Industry ${fmtNum(d.industryPbv, 2)}`);
    if (d.roe !== null) parts.push(`ROE ${fmtNum(d.roe, 1)}%`);
    if (d.roce !== null) parts.push(`ROCE ${fmtNum(d.roce, 1)}%`);
    if (d.debtToEquity !== null) parts.push(`D/E ${fmtNum(d.debtToEquity, 2)}`);
  }
  if (d.epsGrowth3y !== null) parts.push(`EPS Growth 3Y ${fmtNum(d.epsGrowth3y, 1)}%`);
  if (d.profitVar3y !== null) parts.push(`Profit Growth 3Y ${fmtNum(d.profitVar3y, 1)}%`);
  return parts.join(", ");
}

// The actual recommendation logic. Allocation status and the three
// fundamental verdicts are combined — never allocation alone in
// either direction. Returns "No Action — Insufficient Data" (rather
// than guessing) when there's no Screener match or too few fields to
// form any verdict.
function computeStockInsight(row, screenerMap) {
  const key = (row.name || "").trim().toUpperCase();
  const screener = screenerMap.get(key);
  const d = stockAnalysisDerived(row, screener);
  const capCategory = d.capCategory;
  const allocMax = getEquityAllocLimit(capCategory);

  // Same invested-based allocation % the Equity tab itself shows —
  // computed fresh from state.equity rather than duplicating
  // equityTotals()'s internals, so it can never drift from that tab.
  const totalInvested = state.equity.reduce((s, r) => s + (Number(r.invested) || 0), 0);
  const allocPct = totalInvested > 0 ? (Number(row.invested) / totalInvested) * 100 : 0;
  const allocStatus = allocLimitStatus(allocPct, allocMax);

  const bankingLatest = d.isFinancial ? getLatestBankingMetrics(key) : null;
  const valuation = fundamentalValuationVerdict(d);
  const health = fundamentalHealthVerdict(d, bankingLatest);
  const growth = fundamentalGrowthVerdict(d);
  const knownCount = [valuation, health, growth].filter(v => v !== "unknown").length;

  const factorsText = describeInsightFactors(d);
  const allocText = allocMax !== null
    ? `Allocation ${fmtNum(allocPct, 1)}% / Max ${allocMax}% (${capCategory})`
    : `Allocation ${fmtNum(allocPct, 1)}% (cap category unknown — import Screener data)`;

  if (!screener || knownCount === 0) {
    return {
      row, category: "No Action", categoryClass: "none", allocPct, allocMax, allocStatus,
      // insufficientData is purely a display flag for the UI to group
      // these separately from genuine "No Action" verdicts below — the
      // underlying `category`/`categoryClass` a stock is assigned is
      // completely unchanged by this flag.
      insufficientData: true,
      reason: `Insufficient Data — ${!screener ? "no Screener fundamentals imported for this stock yet" : "not enough fundamental fields available to form a view"}. ${allocText}.`,
      d, screener, valuation: null, health: null, growth: null, bankingLatest, capCategory
    };
  }

  const negatives = [valuation === "unattractive", health === "weak", growth === "weak"].filter(Boolean).length;
  const positives = [valuation === "attractive", health === "strong", growth === "strong"].filter(Boolean).length;

  let category, categoryClass, reason;

  if (d.isFinancial && health === "weak") {
    // Weak profitability (ROA/ROE) for a lender/insurer is a
    // structural concern that fast growth or a fair valuation doesn't
    // offset — growth funded by weak unit economics is a warning
    // sign, not a mitigant — so this overrides valuation/growth and
    // allocation status entirely.
    category = "Reduce / Sell"; categoryClass = "reduce";
    reason = `Financial-sector holding with weak profitability (${factorsText}) — ROE/ROA are too low for a lender/insurer, which overrides otherwise reasonable growth or valuation. Consider reducing regardless of current allocation.`;
  } else if (negatives >= 3) {
    // Valuation, health AND growth all negative — a genuine Sell-level
    // read that overrides a low allocation; don't add regardless of
    // how little is currently held.
    category = "Reduce / Sell"; categoryClass = "reduce";
    reason = `Fundamental analysis indicates Sell — valuation, financial health and growth are all weak (${factorsText}). Do not increase allocation despite the current ${allocStatus === "above" ? "high" : "low"} portfolio allocation.`;
  } else if (allocStatus === "above") {
    if (negatives >= 1) {
      category = "Reduce / Sell"; categoryClass = "reduce";
      reason = `Allocation is already above your ${allocMax}% ${capCategory} limit (${fmtNum(allocPct, 1)}%), and fundamentals show weakness (${factorsText}). Consider trimming.`;
    } else {
      category = "Hold"; categoryClass = "hold";
      reason = `${allocText}. Fundamentals are reasonable, but the position is already above your configured limit — hold rather than add.`;
    }
  } else if (allocStatus === "approaching") {
    if (positives >= 2 && negatives === 0) {
      category = "Hold"; categoryClass = "hold";
      reason = `${allocText}. Fundamentals look good (${factorsText}), but allocation is already close to the limit — limited room to add more.`;
    } else if (negatives >= 1) {
      category = "Watch"; categoryClass = "watch";
      reason = `${allocText}, and approaching the limit. Fundamentals show some weakness (${factorsText}) — worth monitoring rather than adding.`;
    } else {
      category = "Watch"; categoryClass = "watch";
      reason = `${allocText}. Fundamentals are mixed/neutral — no strong case to add further while nearing the limit.`;
    }
  } else {
    // allocStatus is "within" or null (cap category not yet known) —
    // there's room to add, IF fundamentals actually support it. Low
    // allocation alone never implies Buy.
    if (positives >= 2 && negatives === 0) {
      category = "Consider Adding"; categoryClass = "add";
      reason = `${allocText}. Fundamental analysis is positive (${factorsText}) and valuation looks reasonable — may be worth considering for additional allocation.`;
    } else if (positives >= 2 && negatives === 1) {
      category = "Watch"; categoryClass = "watch";
      reason = `${allocText}. Fundamentals are mostly positive (${factorsText}), but one factor is a concern — worth watching before adding further rather than a clear add.`;
    } else if (negatives >= 1) {
      category = "No Action"; categoryClass = "none";
      reason = `${allocText}, but fundamentals/valuation do not support increasing the position (${factorsText}). No additional investment is suggested.`;
    } else {
      category = "Watch"; categoryClass = "watch";
      reason = `${allocText}. Fundamentals are neutral/mixed — not a clear enough signal either way${factorsText ? " (" + factorsText + ")" : ""}.`;
    }
  }

  return { row, category, categoryClass, allocPct, allocMax, allocStatus, reason, d, screener, valuation, health, growth, bankingLatest, capCategory };
}

// Six DISPLAY buckets shown as collapsible sections/filter tabs.
// "Insufficient Data" is not a new assignment rule — it's the exact
// same stocks computeStockInsight() already puts in "No Action" via
// its `insufficientData` flag (no screener match / not enough fields),
// split out here purely so the UI can show it as its own compact
// section instead of mixing it into "No Action". Every other bucket
// maps 1:1 to `category` from computeStockInsight(), unchanged.
const INSIGHT_CATEGORY_ORDER = [
  { key: "Consider Adding", cls: "add", icon: "↗" },
  { key: "Hold", cls: "hold", icon: "＝" },
  { key: "Watch", cls: "watch", icon: "👁" },
  { key: "Reduce / Sell", cls: "reduce", icon: "↘" },
  { key: "No Action", cls: "none", icon: "•" },
  { key: "Insufficient Data", cls: "insufficient", icon: "？" }
];

// Module-level UI state for the Intelligent Insights card — pure view
// state (filter/sort/collapse selections), never persisted to
// `state`/localStorage and never affecting any computed value above.
const iiUI = {
  filterCategory: "All",
  filterCap: "",
  sort: "score",
  openSections: {},   // { [displayCategoryKey]: true } — all start collapsed
  openWhy: {}         // { [stockKey]: true }
};

// Purely a DISPLAY aggregation of the exact same three verdicts
// (valuation/health/growth) computeStockInsight() already derives —
// mapped attractive/strong=+1, neutral=0, unattractive/weak=-1,
// unknown=skipped, averaged, then rescaled to a 0-100 gauge. This
// does NOT feed back into `category`/`categoryClass` anywhere — it
// exists only to draw the score ring, matching the reference design,
// without altering which bucket a stock is recommended into.
function computeInsightScoreDisplay(valuation, health, growth) {
  const toSignal = (v, goodVal, badVal) => v === goodVal ? 1 : v === badVal ? -1 : v && v !== "unknown" ? 0 : null;
  const signals = [
    toSignal(valuation, "attractive", "unattractive"),
    toSignal(health, "strong", "weak"),
    toSignal(growth, "strong", "weak")
  ].filter(s => s !== null);
  if (signals.length === 0) return { score: null, label: "—", cls: "none" };
  const avg = signals.reduce((a, b) => a + b, 0) / signals.length;
  const score = Math.round(((avg + 1) / 2) * 100);
  let label, cls;
  if (score >= 75) { label = "Strong"; cls = "strong"; }
  else if (score >= 55) { label = "Good"; cls = "good"; }
  else if (score >= 35) { label = "Moderate"; cls = "moderate"; }
  else { label = "Weak"; cls = "weak"; }
  return { score, label, cls };
}

const II_SCORE_RING_COLOR = { strong: "var(--positive)", good: "var(--gold)", moderate: "var(--warning)", weak: "var(--negative)", none: "var(--text-faint)" };

// Builds up to 5 small "vs industry/threshold" metric chips for a
// stock, reading only fields `stockAnalysisDerived()` already computed
// (`d`) plus saved Banking Metrics for lenders — the same figures
// describeInsightFactors() already surfaces as plain text, just laid
// out as chips here. No new figures are computed.
function getInsightKeyMetrics(d, bankingLatest) {
  const chips = [];
  const push = (label, valueText, compareText, dir) => chips.push({ label, valueText, compareText, dir });
  if (d.isFinancial) {
    if (d.pb !== null && d.industryPbv) push("P/B", fmtNum(d.pb, 1), `vs ${fmtNum(d.industryPbv, 1)}`, d.pb <= d.industryPbv ? "pos" : "neg");
    if (d.roe !== null) push("ROE", fmtNum(d.roe, 1) + "%", "", null);
    const isLender = /bank|nbfc/i.test(d.sector || "");
    if (isLender && bankingLatest && bankingLatest.metrics) {
      const m = bankingLatest.metrics;
      if (m.nim && m.nim.value != null) push("NIM", fmtNum(m.nim.value, 1) + "%", "", m.nim.value >= 3 ? "pos" : "neg");
      if (m.gnpa && m.gnpa.value != null) push("GNPA", fmtNum(m.gnpa.value, 2) + "%", "", m.gnpa.value <= 2 ? "pos" : "neg");
    } else if (d.roa !== null) {
      push("ROA", fmtNum(d.roa, 2) + "%", "", d.roa >= 1 ? "pos" : "neg");
    }
  } else {
    if (d.pe !== null && d.pe > 0 && d.industryPe !== null) push("PE", fmtNum(d.pe, 1), `vs ${fmtNum(d.industryPe, 1)}`, d.pe <= d.industryPe ? "pos" : "neg");
    else if (d.pb !== null && d.industryPbv) push("P/B", fmtNum(d.pb, 1), `vs ${fmtNum(d.industryPbv, 1)}`, d.pb <= d.industryPbv ? "pos" : "neg");
    if (d.roe !== null) push("ROE", fmtNum(d.roe, 1) + "%", "", d.roe >= 15 ? "pos" : d.roe < 10 ? "neg" : null);
    if (d.epsGrowth3y !== null) push("EPS 3Y", fmtNum(d.epsGrowth3y, 1) + "%", "", d.epsGrowth3y >= 10 ? "pos" : d.epsGrowth3y < 0 ? "neg" : null);
    if (d.debtToEquity !== null) push("D/E", fmtNum(d.debtToEquity, 2), "", d.debtToEquity <= 0.5 ? "pos" : d.debtToEquity >= 1.5 ? "neg" : null);
  }
  return chips.slice(0, 5);
}

// Reads the exact same Cap Allocation figures the old
// renderCapAllocationBreakdown() computed (getEquityCapCategory()/
// getEquityAllocLimit(), unchanged) — just returned as data instead of
// pre-built HTML so the new summary cards can lay it out differently.
function computeCapAllocationSummary() {
  const screenerMap = buildScreenerMap();
  const totalInvested = state.equity.reduce((s, r) => s + (Number(r.invested) || 0), 0);
  const buckets = { "Large Cap": 0, "Mid Cap": 0, "Small Cap": 0, "Unclassified": 0 };
  state.equity.forEach(row => {
    const cap = getEquityCapCategory(row, screenerMap) || "Unclassified";
    buckets[cap] = (buckets[cap] || 0) + (Number(row.invested) || 0);
  });
  const pct = (v) => totalInvested > 0 ? (v / totalInvested) * 100 : 0;
  // These cards describe each category's share of the WHOLE Equity
  // portfolio, so they compare against the overall category target
  // (getEquityCapAllocTarget(), e.g. Large Cap ~70%) — NOT the
  // per-stock limit (getEquityAllocLimit(), e.g. 15% per Large Cap
  // stock), which is a different number used elsewhere (Equity tab's
  // Alloc % column, Intelligent Insights' per-stock rows).
  return [
    { key: "large", label: "Large Cap", icon: "▮▮▮", cls: "large", pct: pct(buckets["Large Cap"]), max: getEquityCapAllocTarget("Large Cap") },
    { key: "mid", label: "Mid Cap", icon: "▮▮", cls: "mid", pct: pct(buckets["Mid Cap"]), max: getEquityCapAllocTarget("Mid Cap") },
    { key: "small", label: "Small Cap", icon: "▮", cls: "small", pct: pct(buckets["Small Cap"]), max: getEquityCapAllocTarget("Small Cap") },
    { key: "unclassified", label: "Unclassified", icon: "?", cls: "unclassified", pct: pct(buckets["Unclassified"]), max: null }
  ];
}

function renderIIAllocGrid() {
  const el = document.getElementById("iiAllocGrid");
  if (!el) return;
  if (state.equity.length === 0) { el.innerHTML = ""; return; }
  const data = computeCapAllocationSummary();
  el.innerHTML = data.map(b => {
    const overLimit = b.max !== null && b.pct > b.max;
    const barPct = Math.min(100, b.max ? (b.pct / b.max) * 100 : b.pct);
    const barColor = b.max === null ? "var(--blue)" : overLimit ? "var(--negative)" : (b.pct >= b.max * 0.8 ? "var(--warning)" : "var(--positive)");
    const statusHTML = b.max === null
      ? `<span class="ii-alloc-status none">No limit set</span>`
      : overLimit
        ? `<span class="ii-alloc-status over">+${fmtNum(b.pct - b.max, 1)}% over limit</span>`
        : `<span class="ii-alloc-status within">Within limit</span>`;
    return `
      <div class="ii-alloc-card">
        <div class="ii-alloc-top">
          <div class="ii-alloc-icon ${b.cls}">${b.icon}</div>
          <div>
            <div class="ii-alloc-label">${escapeAttr(b.label)}</div>
            <div class="ii-alloc-value">${fmtNum(b.pct, 1)}%</div>
            <div class="ii-alloc-sub">of ${b.max !== null ? b.max + "% limit" : "—"}</div>
          </div>
        </div>
        <div class="ii-alloc-bar-track"><div class="ii-alloc-bar-fill" style="width:${barPct}%;background:${barColor}"></div></div>
        ${statusHTML}
      </div>
    `;
  }).join("");
}

function renderIIPortfolioSummary(insights) {
  const el = document.getElementById("iiPortfolioSummary");
  if (!el) return;
  if (insights.length === 0) { el.innerHTML = ""; return; }
  const counts = {};
  INSIGHT_CATEGORY_ORDER.forEach(c => { counts[c.key] = 0; });
  insights.forEach(ins => {
    const dispKey = ins.insufficientData ? "Insufficient Data" : ins.category;
    counts[dispKey] = (counts[dispKey] || 0) + 1;
  });
  el.innerHTML = `<span class="ii-ps-label">Portfolio Summary</span>` + INSIGHT_CATEGORY_ORDER.map(c => `
    <div class="ii-ps-item">
      <span class="ii-ps-icon ${c.cls}">${c.icon}</span>
      <span class="ii-ps-n">${counts[c.key] || 0}</span>
      <span class="ii-ps-l">${escapeAttr(c.key)}</span>
    </div>
  `).join("");
}

function renderIIFilterTabs(insights) {
  const el = document.getElementById("iiFilterTabs");
  if (!el) return;
  const counts = { All: insights.length };
  INSIGHT_CATEGORY_ORDER.forEach(c => { counts[c.key] = 0; });
  insights.forEach(ins => {
    const dispKey = ins.insufficientData ? "Insufficient Data" : ins.category;
    counts[dispKey] = (counts[dispKey] || 0) + 1;
  });
  const tabs = [{ key: "All", label: "All" }, ...INSIGHT_CATEGORY_ORDER.map(c => ({ key: c.key, label: c.key }))];
  el.innerHTML = tabs.map(t => `
    <button type="button" class="ii-filter-tab${iiUI.filterCategory === t.key ? " active" : ""}" data-filter-cat="${escapeAttr(t.key)}">
      ${escapeAttr(t.label)}${t.key !== "All" ? ` (${counts[t.key] || 0})` : ""}
    </button>
  `).join("");
  el.querySelectorAll("[data-filter-cat]").forEach(btn => {
    btn.addEventListener("click", () => {
      iiUI.filterCategory = btn.dataset.filterCat;
      renderIntelligentInsights();
    });
  });
}

// One stock's row/card.
function renderIIStockRow(ins) {
  const { row, d, allocPct, allocMax, capCategory, reason, categoryClass, insufficientData, valuation, health, growth, bankingLatest } = ins;
  const key = (row.name || "").trim().toUpperCase();
  const overLimit = allocMax !== null && allocPct > allocMax;
  const roomPct = allocMax !== null ? allocMax - allocPct : null;
  const barPct = allocMax ? Math.min(100, (allocPct / allocMax) * 100) : Math.min(100, allocPct);
  const barColor = allocMax === null ? "var(--blue)" : overLimit ? "var(--negative)" : (allocPct >= allocMax * 0.8 ? "var(--warning)" : "var(--positive)");
  const score = insufficientData ? { score: null, label: "—", cls: "none" } : computeInsightScoreDisplay(valuation, health, growth);
  const ringColor = II_SCORE_RING_COLOR[score.cls] || II_SCORE_RING_COLOR.none;
  const metrics = insufficientData ? [] : getInsightKeyMetrics(d, bankingLatest);
  const whyOpen = !!iiUI.openWhy[key];
  const catCfg = INSIGHT_CATEGORY_ORDER.find(c => c.key === (insufficientData ? "Insufficient Data" : ins.category)) || { cls: categoryClass };

  return `
    <div class="ii-stock-row">
      <div class="ii-stock-name-cell">
        <span class="ii-stock-avatar">${escapeAttr(stockMonogram(row.name))}</span>
        <div>
          <div class="ii-stock-name" title="${escapeAttr(row.name || "")}">${escapeAttr(row.name || "(unnamed)")}</div>
          <div class="ii-stock-sector">${escapeAttr(d.sector || "Sector not set")}</div>
        </div>
      </div>
      <div class="ii-alloc-cell">
        <div class="ii-mobile-label">Allocation (vs Limit)</div>
        <div class="pct">${fmtNum(allocPct, 1)}%${allocMax !== null ? ` / ${allocMax}%` : ""}</div>
        ${roomPct !== null ? `<div class="room ${roomPct >= 0 ? "pos" : "neg"}">${roomPct >= 0 ? fmtNum(roomPct, 1) + "% room" : fmtNum(-roomPct, 1) + "% over limit"}</div>` : `<div class="room muted">Cap unknown</div>`}
        <div class="ii-mini-bar-track"><div class="ii-mini-bar-fill" style="width:${barPct}%;background:${barColor}"></div></div>
      </div>
      <div class="ii-cap-cell">
        <div class="ii-mobile-label">Market Cap</div>
        <div class="cap-label">${capCategory ? escapeAttr(capCategory) : '<span class="muted">Unclassified</span>'}</div>
        <div class="cap-value">${d.marketCap !== null ? "₹" + fmtNum(d.marketCap, 0) + " Cr" : "—"}</div>
      </div>
      <div class="ii-insight-cell${whyOpen ? " why-open" : ""}" data-why-key="${escapeAttr(key)}">
        <div class="ii-mobile-label">Insight</div>
        <span class="ii-cat-badge ii-cat-${catCfg.cls}">${insufficientData ? "Insufficient Data" : escapeAttr(ins.category)}</span>
        <div class="ii-insight-reason">${escapeAttr(reason.length > 90 ? reason.slice(0, 90).trim() + "…" : reason)}</div>
        <div class="ii-why-toggle" data-why-toggle="${escapeAttr(key)}">Why? <span class="chev">▾</span></div>
        <div class="ii-why-full">${escapeAttr(reason)}</div>
      </div>
      <div class="ii-metrics-cell">
        <div class="ii-mobile-label">Key Metrics ${d.isFinancial ? "" : "(vs Industry)"}</div>
        ${metrics.length === 0
          ? '<span class="muted" style="font-size:11.5px;">No fundamentals imported</span>'
          : metrics.map(m => `
            <div class="ii-metric-chip">
              <div class="l">${escapeAttr(m.label)}</div>
              <div class="v">${escapeAttr(m.valueText)}</div>
              ${m.compareText || m.dir ? `<div class="c ${m.dir || "muted"}">${escapeAttr(m.compareText || "")}</div>` : ""}
            </div>
          `).join("")}
      </div>
      <div class="ii-score-cell">
        <div class="ii-mobile-label">Score</div>
        <div class="ii-score-ring" style="--pct:${score.score ?? 0};--ring-color:${ringColor}"><span>${score.score ?? "—"}</span></div>
        <div class="ii-score-label">${escapeAttr(score.label)}</div>
      </div>
    </div>
  `;
}

// Renders the categorized, collapsible Intelligent Insights list — six
// compact section headers (collapsed by default), each expanding into
// the stock-row grid above. Filtering by category/market-cap and
// sorting only change what's displayed/in what order, exactly like the
// Equity/Debt/MF/Gold tables elsewhere in the app — every number shown
// still comes from computeStockInsight()/stockAnalysisDerived(),
// nothing recalculated differently for this view.
function renderIntelligentInsights() {
  const el = document.getElementById("intelligentInsightsBody");
  if (!el) return;
  renderIIAllocGrid();

  // ETFs are excluded here (see isETFEquity()) — they have no
  // company-level fundamentals to assess, so they'd otherwise sit
  // permanently in "Insufficient Data" for no useful reason. Still
  // fully shown on the Equity tab and counted in the Allocation
  // Summary above; only skipped from this fundamentals-driven list.
  const eligible = state.equity.filter(row => !isETFEquity(row));
  if (eligible.length === 0) {
    document.getElementById("iiPortfolioSummary").innerHTML = "";
    document.getElementById("iiFilterTabs").innerHTML = "";
    el.innerHTML = state.equity.length === 0
      ? '<div class="insights-empty">No Equity holdings yet — add stocks and import Screener Data to see Intelligent Insights.</div>'
      : '<div class="insights-empty">No non-ETF Equity holdings to assess — Intelligent Insights needs company-level fundamentals, which ETFs don\'t have.</div>';
    return;
  }
  const screenerMap = buildScreenerMap();
  const insights = eligible.map(row => computeStockInsight(row, screenerMap));

  renderIIPortfolioSummary(insights);
  renderIIFilterTabs(insights);

  // Filters (category tab + market-cap dropdown) only narrow which
  // rows are shown — never change any computed value above.
  let filtered = insights;
  if (iiUI.filterCategory !== "All") {
    filtered = filtered.filter(ins => (ins.insufficientData ? "Insufficient Data" : ins.category) === iiUI.filterCategory);
  }
  if (iiUI.filterCap) {
    filtered = filtered.filter(ins => (ins.capCategory || "Unclassified") === iiUI.filterCap);
  }

  const grouped = {};
  INSIGHT_CATEGORY_ORDER.forEach(c => { grouped[c.key] = []; });
  filtered.forEach(ins => {
    const dispKey = ins.insufficientData ? "Insufficient Data" : ins.category;
    (grouped[dispKey] || (grouped[dispKey] = [])).push(ins);
  });

  const sortFn = (a, b) => {
    if (iiUI.sort === "name") return (a.row.name || "").localeCompare(b.row.name || "");
    if (iiUI.sort === "alloc") return (b.allocPct - (b.allocMax ?? b.allocPct)) - (a.allocPct - (a.allocMax ?? a.allocPct));
    // "score" (default): highest display score first; insufficient-data
    // rows (score null) sort last within their own section anyway.
    const sa = a.insufficientData ? -1 : (computeInsightScoreDisplay(a.valuation, a.health, a.growth).score ?? -1);
    const sb = b.insufficientData ? -1 : (computeInsightScoreDisplay(b.valuation, b.health, b.growth).score ?? -1);
    return sb - sa;
  };

  const sectionsHTML = INSIGHT_CATEGORY_ORDER.map(cfg => {
    const items = grouped[cfg.key] || [];
    if (items.length === 0) return "";
    const sorted = [...items].sort(sortFn);
    const isOpen = !!iiUI.openSections[cfg.key];
    const rowsHTML = sorted.map(renderIIStockRow).join("");
    return `
      <div class="ii-section${isOpen ? " open" : ""}" data-section-key="${escapeAttr(cfg.key)}">
        <div class="ii-section-header" data-section-toggle="${escapeAttr(cfg.key)}">
          <div class="ii-section-left">
            <span class="ii-cat-badge ii-cat-${cfg.cls}">${cfg.icon} ${escapeAttr(cfg.key)}</span>
            <span class="ii-section-count">${items.length} stock${items.length === 1 ? "" : "s"}</span>
          </div>
          <span class="ii-section-chevron">▾</span>
        </div>
        <div class="ii-section-body">
          <div class="ii-stock-table-head">
            <div>Stock</div><div>Allocation (vs Limit)</div><div>Market Cap</div><div>Insight</div><div>Key Metrics</div><div>Score</div>
          </div>
          ${rowsHTML}
        </div>
      </div>
    `;
  }).join("");

  el.innerHTML = sectionsHTML || '<div class="insights-empty">No stocks match the current filter.</div>';

  el.querySelectorAll("[data-section-toggle]").forEach(header => {
    header.addEventListener("click", () => {
      const k = header.dataset.sectionToggle;
      iiUI.openSections[k] = !iiUI.openSections[k];
      renderIntelligentInsights();
    });
  });
  el.querySelectorAll("[data-why-toggle]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const k = btn.dataset.whyToggle;
      iiUI.openWhy[k] = !iiUI.openWhy[k];
      renderIntelligentInsights();
    });
  });
}

// Wires the two persistent filter/sort <select> controls once at
// startup (see INIT section) — separate from renderIntelligentInsights()
// itself, since that function's own DOM (tabs, sections, rows) is
// rebuilt via innerHTML on every call and safely re-wired each time,
// but these two <select> elements live in static HTML and would
// otherwise accumulate a duplicate listener on every 30-second
// auto-refresh re-render.
function setupIntelligentInsightsControls() {
  const capSelect = document.getElementById("iiMarketCapFilter");
  const sortSelect = document.getElementById("iiSortBy");
  if (capSelect) capSelect.addEventListener("change", () => { iiUI.filterCap = capSelect.value; renderIntelligentInsights(); });
  if (sortSelect) sortSelect.addEventListener("change", () => { iiUI.sort = sortSelect.value; renderIntelligentInsights(); });
}

function renderInsights() {
  // Chart.js can't size a canvas inside a display:none panel, so skip
  // all chart work until the Insights tab is actually the active one.
  // The tab-click handler and renderDashboard()'s piggyback call both
  // re-invoke this once it's visible, so nothing here goes stale.
  const panel = document.getElementById("panel-insights");
  if (!panel || !panel.classList.contains("active")) return;

  const { positives, negatives } = computeEquityPerformers();
  renderPerformersList("insightsTopPerformers", positives, "No profitable Equity positions yet.");
  renderPerformersList("insightsWorstPerformers", negatives, "No underperforming Equity positions right now.");

  const sectorData = computeSectorAllocation();
  const sectorTotal = sectorData.reduce((s, e) => s + e.value, 0);
  const sectorWrap = document.getElementById("sectorAllocChartWrap");
  const sectorEmpty = document.getElementById("sectorAllocEmpty");
  if (sectorData.length === 0 || sectorTotal <= 0) {
    if (sectorWrap) sectorWrap.style.display = "none";
    if (sectorEmpty) sectorEmpty.style.display = "block";
  } else {
    if (sectorWrap) sectorWrap.style.display = "";
    if (sectorEmpty) sectorEmpty.style.display = "none";
    sectorAllocChart = renderInsightsDonut(sectorAllocChart, "sectorAllocPie", sectorData, sectorTotal);
  }

  const mfCatData = computeMFCategoryAllocation();
  const mfCatTotal = mfCatData.reduce((s, e) => s + e.value, 0);
  const mfWrap = document.getElementById("mfCategoryChartWrap");
  const mfEmpty = document.getElementById("mfCategoryEmpty");
  if (mfCatData.length === 0 || mfCatTotal <= 0) {
    if (mfWrap) mfWrap.style.display = "none";
    if (mfEmpty) mfEmpty.style.display = "block";
  } else {
    if (mfWrap) mfWrap.style.display = "";
    if (mfEmpty) mfEmpty.style.display = "none";
    mfCategoryChart = renderInsightsDonut(mfCategoryChart, "mfCategoryPie", mfCatData, mfCatTotal);
  }

  const catTbody = document.getElementById("mfCategoryTableBody");
  if (catTbody) {
    if (mfCatData.length === 0) {
      catTbody.innerHTML = '<tr class="empty-row"><td colspan="3">No mutual funds yet.</td></tr>';
    } else {
      catTbody.innerHTML = mfCatData.map(e => {
        const pct = mfCatTotal > 0 ? (e.value / mfCatTotal) * 100 : 0;
        return `<tr>
          <td class="left" data-label="Category">${escapeAttr(e.label)}</td>
          <td data-label="Investment Value">${fmtINR(e.value)}</td>
          <td data-label="Investment %">${fmtNum(pct)}%</td>
        </tr>`;
      }).join("");
    }
  }
}

/* ============================================================
   STOCK ANALYSIS TAB
   Read-only fundamentals view: joins each Equity holding (Stock/
   Symbol, Sector, LTP — all from the Equity tab, never duplicated
   here) against an imported Screener dataset (state.screenerData,
   matched by Symbol). PE, P/B, Yield, Buy Reco and the Financial-
   sector P/B highlight are always calculated in-app from LTP +
   the Screener's EPS/Book Value/Industry PE — never taken as a
   pre-computed column from the source file. No fields here are
   ever hand-edited; the only inputs are a filter box and the
   Import Screener Data file picker.
   ============================================================ */

// Cleans a Screener cell into a plain number: strips ₹, thousands
// commas (including Indian-style lakh/crore grouping), "Cr."/"Cr"
// suffixes and "%" signs. Returns null (not 0) for blank/"-"/
// unparseable cells, so downstream calculations can tell "missing"
// apart from "zero" and skip gracefully instead of showing a
// misleading 0.
function parseScreenerNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isNaN(v) ? null : v;
  let s = String(v).trim();
  if (s === "" || s === "-" || s.toUpperCase() === "N/A") return null;
  s = s.replace(/₹/g, "").replace(/Cr\.?/gi, "").replace(/,/g, "").replace(/%/g, "").trim();
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// The Screener's `high_low` column packs 52-week High and Low into
// one cell as "High/Low" (e.g. "₹3,350/1,976"). Splits and cleans
// both sides; returns nulls if the cell doesn't look like that shape.
function parseHighLow(v) {
  if (v === null || v === undefined) return { high: null, low: null };
  const s = String(v).trim();
  const parts = s.split("/");
  if (parts.length !== 2) return { high: null, low: null };
  return { high: parseScreenerNum(parts[0]), low: parseScreenerNum(parts[1]) };
}

// Large/Mid/Small cap classification, derived purely from the Market
// Cap figure Screener import brings in (state.screenerData[].market_cap,
// already cleaned to a plain number in ₹ Crore by parseScreenerNum() —
// Screener exports market cap in Cr). This app has no per-company rank
// data (SEBI's own definition is rank-based: 1-100 Large, 101-250 Mid,
// 251+ Small), so it approximates using the commonly-used absolute
// thresholds instead: Large >= 20,000 Cr, Mid 5,000-20,000 Cr, Small
// below that. Returns null (never a guess) when Market Cap isn't known
// yet — i.e. Screener data hasn't been imported for that symbol —
// so callers can show a dash instead of a wrong classification.
const MARKET_CAP_LARGE_THRESHOLD_CR = 20000;
const MARKET_CAP_MID_THRESHOLD_CR = 5000;
function marketCapCategory(marketCapCr) {
  if (marketCapCr === null || marketCapCr === undefined || isNaN(marketCapCr)) return null;
  const n = Number(marketCapCr);
  if (n >= MARKET_CAP_LARGE_THRESHOLD_CR) return "Large Cap";
  if (n >= MARKET_CAP_MID_THRESHOLD_CR) return "Mid Cap";
  return "Small Cap";
}

// Builds a Map from Symbol (trimmed, uppercased) to that Screener
// row's cleaned fields — the single lookup used to join Screener
// data onto each Equity holding by Symbol.
function buildScreenerMap() {
  const map = new Map();
  (state.screenerData || []).forEach(row => {
    const key = String(row.symbol || "").trim().toUpperCase();
    if (key) map.set(key, row);
  });
  return map;
}

// Computes every derived Stock Analysis field for one Equity row.
// `screener` is the matched Screener row (already-cleaned numbers)
// or undefined if no Screener data has been imported for this
// Symbol yet — every derived value degrades to null in that case
// rather than showing a misleading 0.
function stockAnalysisDerived(equityRow, screener) {
  const ltp = Number(equityRow.ltp) || 0;
  const sector = equityRow.sector || "";
  const eps = screener ? screener.eps : null;
  const bookValue = screener ? screener.book_value : null;
  const industryPe = screener ? screener.industry_pe : null;
  const industryPbv = screener ? screener.industry_pbv : null;
  const hl = screener ? parseHighLow(screener.high_low) : { high: null, low: null };
  // 52W High/Low: the live-data endpoint (same one Equity's LTP refresh
  // already uses — see refreshEquityPrices()/row.high52Live/low52Live) is
  // the source of truth once it's been fetched at least once. Screener's
  // static high_low column is only a fallback before that first live
  // refresh completes, never used once live data is present.
  const low52 = (equityRow.low52Live !== undefined && equityRow.low52Live !== null) ? equityRow.low52Live : hl.low;
  const high52 = (equityRow.high52Live !== undefined && equityRow.high52Live !== null) ? equityRow.high52Live : hl.high;

  // PE and P/B are ALWAYS computed here from LTP — never read as a
  // pre-calculated column from the Screener file, per spec.
  const pe = (ltp > 0 && eps !== null && eps > 0) ? ltp / eps : null;
  const pb = (ltp > 0 && bookValue !== null && bookValue > 0) ? ltp / bookValue : null;
  const yieldPct = (pe !== null && pe > 0) ? (1 / pe) * 100 : null;

  const buyReco = (pe !== null && industryPe !== null) ? (pe < industryPe) : null;

  // Shared "is this a Financial-sector holding" check — drives both
  // the existing P/B highlight bands below and the ROA column, which
  // is only ever shown for Financial-sector rows (ROA is far more
  // meaningful for banks/NBFCs than for most other sectors, so it's
  // suppressed elsewhere rather than showing a number without context).
  const isFinancial = /financ/i.test(sector);

  // Financial-sector P/B highlight: strongest applicable band wins
  // (checked from tightest threshold outward), and only applies when
  // the holding's own Sector (from the Equity tab) looks Financial.
  let pbClass = "";
  if (pb !== null && isFinancial) {
    if (pb < 1) pbClass = "pb-green";
    else if (pb < 1.5) pbClass = "pb-yellow";
    else if (pb < 2) pbClass = "pb-orange";
  }

  const gainFromLow = (low52 !== null && low52 > 0 && ltp > 0) ? ((ltp - low52) / low52) * 100 : null;
  const dropFromHigh = (high52 !== null && high52 > 0 && ltp > 0) ? ((high52 - ltp) / high52) * 100 : null;

  const marketCap = screener ? screener.market_cap : null;
  const capCategory = marketCapCategory(marketCap);

  return {
    ltp, sector, isFinancial,
    low52, high52, gainFromLow, dropFromHigh,
    // Live OHLC/Prev Close, read straight off the Equity row that this
    // Stock Analysis row is joined from (same live-price refresh, no
    // separate fetch). Day Change % is always derived from LTP/Prev
    // Close here, never taken as a pre-supplied percentage.
    prevClose: (equityRow.prevClose === undefined) ? null : equityRow.prevClose,
    openPrice: (equityRow.openPrice === undefined) ? null : equityRow.openPrice,
    dayHigh: (equityRow.dayHigh === undefined) ? null : equityRow.dayHigh,
    dayLow: (equityRow.dayLow === undefined) ? null : equityRow.dayLow,
    dayChangePct: dayChangePct(ltp, equityRow.prevClose),
    marketDataStale: !!equityRow.marketDataStale,
    eps, pe, industryPe, buyReco,
    capCategory,
    bookValue, pb, pbClass, industryPbv,
    yieldPct,
    dividendYield: screener ? pctOrNull(screener.dividend_yield) : null,
    roe: screener ? pctOrNull(screener.roe) : null,
    roce: screener ? pctOrNull(screener.roce) : null,
    roa: screener ? pctOrNull(screener.return_on_assets) : null,
    debtToEquity: screener ? screener.debt_to_equity : null,
    promoterHolding: screener ? pctOrNull(screener.promoter_holding) : null,
    epsGrowth3y: screener ? pctOrNull(screener.eps_growth_3years) : null,
    epsGrowth5y: screener ? pctOrNull(screener.eps_growth_5years) : null,
    salesGrowth5y: screener ? pctOrNull(screener.sales_growth_5years) : null,
    qtrProfitVar: screener ? pctOrNull(screener.qtr_profit_var) : null,
    qtrSalesVar: screener ? pctOrNull(screener.qtr_sales_var) : null,
    // These five have no reliable webpage-only calculation (no LTP-based
    // formula applies), so they're taken straight from the Screener
    // import rather than derived — face value, market cap (current and
    // 5-year-back), interest coverage and free cash flow are all
    // absolute figures, not percentages, so no pctOrNull() conversion.
    faceValue: screener ? screener.face_value : null,
    marketCap,
    marketCap5y: screener ? screener.mar_cap_5yrs_back : null,
    intCoverage: screener ? screener.int_coverage : null,
    fcfPrevAnn: screener ? screener.fcf_prev_ann : null,
    profitVar3y: screener ? pctOrNull(screener.profit_var_3yrs) : null,
    profitVar5y: screener ? pctOrNull(screener.profit_var_5yrs) : null
  };
}

// Screener fractions (0.518) are stored as-is by the importer;
// convert to a percentage (51.8) at display/calc time here, in one
// place, so every fraction-based field is handled consistently.
function pctOrNull(v) {
  return (v === null || v === undefined) ? null : v * 100;
}

/* ============================================================
   SECTOR-AWARE FUNDAMENTAL VIEW (Stock Analysis)
   A basic "how healthy do this stock's fundamentals look for ITS
   sector" read — deliberately not a universal-threshold scorer.
   Each sector group below gets its own thresholds and its own mix
   of which metrics matter (e.g. Financials lean on ROA + P/B and
   skip Debt-to-Equity entirely, since leverage is structural for a
   bank; IT/FMCG expect high ROE and near-zero debt as normal).
   Everything not covered by a specific group falls back to "other"'s
   general-purpose thresholds. This is intentionally simple — a
   handful of named signals averaged together, not an institutional
   scoring model — and every signal shown is traceable in the reason
   text, never hidden inside one number.
   ============================================================ */

const SECTOR_PROFILES = {
  financial:  { label: "Banks / NBFC / Insurance", useROA: true, roaGood: 1.0, roaWeak: 0.5, pbWeight: true, peRelevant: false, deRelevant: false },
  it:         { label: "IT / Technology", roeGood: 18, roeWeak: 10, roceGood: 18, roceWeak: 10, deGood: 0.3, deWeak: 0.8, icRelevant: false },
  pharma:     { label: "Pharma / Healthcare", roeGood: 15, roeWeak: 8, roceGood: 15, roceWeak: 8, deGood: 0.5, deWeak: 1.2, icGood: 5, icWeak: 2 },
  auto:       { label: "Auto / Auto Ancillary", roeGood: 13, roeWeak: 6, roceGood: 13, roceWeak: 6, deGood: 0.7, deWeak: 1.5, icGood: 4, icWeak: 1.5 },
  energy:     { label: "Energy / Utilities", roeGood: 11, roeWeak: 5, roceGood: 11, roceWeak: 5, deGood: 1.5, deWeak: 2.5, icGood: 3, icWeak: 1.5 },
  fmcg:       { label: "FMCG / Consumer", roeGood: 20, roeWeak: 12, roceGood: 20, roceWeak: 12, deGood: 0.3, deWeak: 0.8, icGood: 6, icWeak: 2.5 },
  realestate: { label: "Real Estate / Infra / Construction", roeGood: 12, roeWeak: 6, roceGood: 10, roceWeak: 5, deGood: 1.2, deWeak: 2.2, icGood: 2.5, icWeak: 1.2 },
  industrial: { label: "Manufacturing / Industrial", roeGood: 14, roeWeak: 7, roceGood: 14, roceWeak: 7, deGood: 0.8, deWeak: 1.8, icGood: 4, icWeak: 1.5 },
  other:      { label: "General", roeGood: 15, roeWeak: 10, roceGood: 15, roceWeak: 10, deGood: 0.6, deWeak: 1.5, icGood: 5, icWeak: 2 }
};

// Coarse sector-group classifier off the free-text Sector field (from
// the Equity tab) — matched case-insensitively against common Indian
// market sector naming. Anything unmatched falls back to "other"
// rather than guessing.
function classifySectorGroup(sector) {
  const s = String(sector || "");
  if (/bank|financ|nbfc|insur/i.test(s)) return "financial";
  if (/\bit\b|software|technology|tech\b/i.test(s)) return "it";
  if (/pharma|healthcare|hospital/i.test(s)) return "pharma";
  if (/auto/i.test(s)) return "auto";
  if (/energy|oil|gas|power|utilit/i.test(s)) return "energy";
  if (/fmcg|consumer|food|beverage/i.test(s)) return "fmcg";
  if (/real estate|realty|construction|infra/i.test(s)) return "realestate";
  if (/metal|cement|chemical|manufactur|industrial|engineering/i.test(s)) return "industrial";
  return "other";
}

// The main entry point: one sector-aware Fundamental View per stock.
// `d` is the same stockAnalysisDerived() output the table row already
// uses (nothing recalculated differently). Returns
// { view, cls, sectorGroup, sectorLabel, reason } — view is one of
// Strong/Good/Neutral/Weak/Insufficient Data.
function computeFundamentalView(row, screener, d) {
  if (!screener) {
    return { view: "Insufficient Data", cls: "insuff", sectorGroup: null, sectorLabel: null, reason: "No Screener fundamentals imported yet for this stock." };
  }
  const group = classifySectorGroup(d.sector);
  const profile = { ...SECTOR_PROFILES.other, ...SECTOR_PROFILES[group] };
  const noteItems = []; // { text, signal: -1|0|1 } — collected so the
  // reason text can prioritize showing concerning (negative-signal)
  // factors instead of just the first few pushed.
  const notes = { push: (text, signal = 0) => noteItems.push({ text, signal }) };
  const signals = [];

  // Valuation — PE vs Industry PE is the default lens, but it is
  // deliberately NOT used at all for Financial-sector stocks
  // (peRelevant: false): bank/NBFC/insurance earnings can swing on
  // provisioning, write-offs or actuarial reserves, which makes PE
  // unreliable there — P/B vs Industry P/B is the appropriate lens
  // instead (profile.pbWeight is true for that profile). For every
  // other sector, PE is skipped (not penalized) when it's missing,
  // zero, negative, or the industry figure isn't usable — P/B fills
  // in as a fallback lens if available.
  let valSignal = null;
  if (profile.peRelevant !== false && d.pe !== null && d.pe > 0 && d.industryPe !== null && d.industryPe > 0) {
    const r = d.pe / d.industryPe;
    valSignal = r <= 0.9 ? 1 : r >= 1.15 ? -1 : 0;
    notes.push(`PE ${fmtNum(d.pe, 1)} vs Industry ${fmtNum(d.industryPe, 1)}`, valSignal);
  }
  if (d.pb !== null && d.industryPbv && (profile.pbWeight || valSignal === null)) {
    const rb = d.pb / d.industryPbv;
    const pbSignal = rb <= 0.9 ? 1 : rb >= 1.3 ? -1 : 0;
    valSignal = valSignal === null ? pbSignal : (valSignal + pbSignal) / 2;
    notes.push(`P/B ${fmtNum(d.pb, 2)} vs Industry ${fmtNum(d.industryPbv, 2)}${d.pe === null ? " (PE not meaningful)" : ""}`, pbSignal);
  }
  if (valSignal !== null) signals.push(valSignal);

  // Profitability — ROA for Financials (where ROE/ROCE are much less
  // standard), ROE/ROCE for everyone else, each against that sector's
  // own thresholds (e.g. FMCG's "good" ROE is IT's "weak" ROE).
  let profSignal = null;
  if (profile.useROA) {
    if (d.roa !== null) {
      profSignal = d.roa >= profile.roaGood ? 1 : d.roa <= profile.roaWeak ? -1 : 0;
      notes.push(`ROA ${fmtNum(d.roa, 2)}%`, profSignal);
    }
  } else {
    const parts = [];
    if (d.roe !== null) { const s = d.roe >= profile.roeGood ? 1 : d.roe <= profile.roeWeak ? -1 : 0; parts.push(s); notes.push(`ROE ${fmtNum(d.roe, 1)}%`, s); }
    if (d.roce !== null) { const s = d.roce >= profile.roceGood ? 1 : d.roce <= profile.roceWeak ? -1 : 0; parts.push(s); notes.push(`ROCE ${fmtNum(d.roce, 1)}%`, s); }
    if (parts.length) profSignal = parts.reduce((a, b) => a + b, 0) / parts.length;
  }
  if (profSignal !== null) signals.push(profSignal);

  // Growth — EVERY available growth figure (EPS 3Y/5Y, Profit 3Y/5Y,
  // Sales 5Y, and the latest Quarterly Profit/Sales growth) is weighed
  // together, not just whichever looks best. A strong 3Y number can
  // ride on an old low base and mask a recent slowdown or outright
  // decline that only shows up in the 5Y or quarterly figures — so all
  // of them count, and any negative one is called out by name below
  // rather than getting averaged away silently.
  const growthParts = [];
  const pushGrowth = (label, value, goodAt) => {
    if (value === null) return;
    const s = value >= goodAt ? 1 : value < 0 ? -1 : 0;
    growthParts.push(s);
    notes.push(`${label} ${fmtNum(value, 1)}%`, s);
  };
  pushGrowth("EPS Growth 3Y", d.epsGrowth3y, 10);
  pushGrowth("EPS Growth 5Y", d.epsGrowth5y, 10);
  pushGrowth("Profit Growth 3Y", d.profitVar3y, 10);
  pushGrowth("Profit Growth 5Y", d.profitVar5y, 10);
  pushGrowth("Sales Growth 5Y", d.salesGrowth5y, 8);
  pushGrowth("Quarterly Profit Growth", d.qtrProfitVar, 8);
  pushGrowth("Quarterly Sales Growth", d.qtrSalesVar, 8);
  if (growthParts.length) signals.push(growthParts.reduce((a, b) => a + b, 0) / growthParts.length);

  // Financial Health — Debt-to-Equity + Interest Coverage + Free Cash
  // Flow for non-Financials (skipped for banks/NBFCs, whose leverage
  // is structural, not a red flag); Banking Metrics (GNPA/CRAR/NIM)
  // for Financial-sector holdings instead, when researched.
  const healthParts = [];
  if (group === "financial") {
    // GNPA/CRAR/NIM are lender-specific (asset quality, capital
    // adequacy, lending margin) and don't apply to a pure insurer —
    // only pull them in for sector text that actually says
    // bank/NBFC, not just any "financial" match (which also covers
    // Insurance).
    const isLender = /bank|nbfc/i.test(d.sector || "");
    if (isLender) {
      const bm = getLatestBankingMetrics((row.name || "").trim().toUpperCase());
      if (bm && bm.metrics) {
        const m = bm.metrics;
        if (m.gnpa && m.gnpa.value !== null && m.gnpa.value !== undefined) { const s = m.gnpa.value <= 2 ? 1 : m.gnpa.value <= 4 ? 0 : -1; healthParts.push(s); notes.push(`GNPA ${fmtNum(m.gnpa.value, 2)}%`, s); }
        if (m.crar && m.crar.value !== null && m.crar.value !== undefined) { const s = m.crar.value >= 14 ? 1 : m.crar.value >= 11 ? 0 : -1; healthParts.push(s); notes.push(`CRAR ${fmtNum(m.crar.value, 2)}%`, s); }
        if (m.nim && m.nim.value !== null && m.nim.value !== undefined) healthParts.push(m.nim.value >= 3 ? 1 : m.nim.value >= 2 ? 0 : -1);
      }
    } else if (d.fcfPrevAnn !== null) {
      // Insurance (or another Financial-sector match that isn't a
      // lender): no bank-specific metrics to lean on, so Free Cash
      // Flow direction is used as a general health fallback instead
      // of leaving this dimension empty.
      const s = d.fcfPrevAnn > 0 ? 1 : -1;
      healthParts.push(s);
      notes.push(`Free Cash Flow ${fmtNum(d.fcfPrevAnn, 0)}`, s);
    }
  } else {
    if (d.debtToEquity !== null) { const s = d.debtToEquity <= profile.deGood ? 1 : d.debtToEquity >= profile.deWeak ? -1 : 0; healthParts.push(s); notes.push(`D/E ${fmtNum(d.debtToEquity, 2)}`, s); }
    if (profile.icRelevant !== false && d.intCoverage !== null) { const s = d.intCoverage >= (profile.icGood || 5) ? 1 : d.intCoverage <= (profile.icWeak || 2) ? -1 : 0; healthParts.push(s); notes.push(`Interest Coverage ${fmtNum(d.intCoverage, 1)}x`, s); }
    if (d.fcfPrevAnn !== null) healthParts.push(d.fcfPrevAnn > 0 ? 1 : -1);
  }
  if (healthParts.length) signals.push(healthParts.reduce((a, b) => a + b, 0) / healthParts.length);

  if (signals.length === 0) {
    return { view: "Insufficient Data", cls: "insuff", sectorGroup: group, sectorLabel: profile.label, reason: `Screener data is imported, but not enough of the metrics relevant to ${profile.label} are available to form a view.` };
  }

  const overall = signals.reduce((a, b) => a + b, 0) / signals.length;
  let view, cls, summary;
  if (overall >= 0.6) { view = "Strong"; cls = "strong"; summary = "Valuation, profitability and growth all look healthy for this sector."; }
  else if (overall >= 0.25) { view = "Good"; cls = "good"; summary = "Fundamentals are reasonable for this sector, with more positives than concerns."; }
  else if (overall > -0.25) { view = "Neutral"; cls = "neutral"; summary = "Fundamentals are broadly stable, without a strong case either way."; }
  else { view = "Weak"; cls = "weak"; summary = "Profitability, growth or valuation look weak relative to peers in this sector."; }

  // Reason text prioritizes negative-signal factors first (so a
  // declining metric is never pushed out by the slice cap below), then
  // neutral, then positive, capped at 5 factors shown.
  const orderedNotes = [...noteItems].sort((a, b) => a.signal - b.signal).slice(0, 5).map(n => n.text);
  return { view, cls, sectorGroup: group, sectorLabel: profile.label, reason: `${summary}${orderedNotes.length ? " (" + orderedNotes.join(", ") + ")" : ""}` };
}

// Renders a derived numeric field as fixed-decimal text, or an
// em-dash when the underlying Screener data hasn't been imported
// yet for that holding — distinguishes "missing data" from "0".
function fmtOrDash(v, decimals = 2, suffix = "") {
  return (v === null || v === undefined) ? '<span class="muted">—</span>' : fmtNum(v, decimals) + suffix;
}

// Visual 52-week range bar for the table's merged "52W Low / High"
// column — built entirely from d.low52/d.high52/d.ltp (already
// computed by stockAnalysisDerived(), nothing new fetched or stored).
// Falls back to a plain dash pair when either bound is missing (no
// Screener data imported yet for that holding).
function renderRangeBarHTML(d) {
  if (d.low52 === null || d.high52 === null || d.high52 <= d.low52) {
    return `<div class="sa-range-cell"><span class="muted">—</span></div>`;
  }
  const pct = Math.max(0, Math.min(100, ((d.ltp - d.low52) / (d.high52 - d.low52)) * 100));
  return `
    <div class="sa-range-cell">
      <div class="sa-range-track"><div class="sa-range-dot" style="left:${pct}%"></div></div>
      <div class="sa-range-labels"><span>${fmtNum(d.low52, 0)}</span><span>${fmtNum(d.high52, 0)}</span></div>
    </div>
  `;
}

// Short monogram for the stock avatar chip — first 1-2 letters of the
// holding's name/symbol, purely cosmetic (no logo data exists or is
// fetched anywhere in the app).
function stockMonogram(name) {
  const clean = String(name || "").replace(/[^A-Za-z]/g, "");
  return (clean.slice(0, 2) || "?").toUpperCase();
}

function stockAnalysisGetSearchText(row, screener, d) {
  return [
    row.name, row.sector, d.capCategory, d.ltp,
    d.low52, d.high52, d.gainFromLow, d.dropFromHigh,
    d.eps, d.pe, d.industryPe,
    d.buyReco === null ? "" : (d.buyReco ? "Buy" : "Hold"),
    d.fundamentalView, d.fundamentalSectorLabel,
    d.bookValue, d.pb, d.industryPbv,
    d.yieldPct, d.dividendYield, d.roe, d.roce, d.roa,
    d.debtToEquity, d.promoterHolding,
    d.epsGrowth3y, d.epsGrowth5y, d.salesGrowth5y,
    d.qtrProfitVar, d.qtrSalesVar,
    d.faceValue, d.marketCap, d.marketCap5y, d.intCoverage, d.fcfPrevAnn,
    d.profitVar3y, d.profitVar5y
  ].join(" ");
}

function stockAnalysisGetSortValue(d, col) {
  switch (col) {
    case "name": return d._name;
    case "sector": return d.sector || "";
    case "capCategory": return d.capCategory || "";
    case "ltp": return d.ltp;
    case "range52": return d.high52 ?? -Infinity;
    case "gainFromLow": return d.gainFromLow ?? -Infinity;
    case "dropFromHigh": return d.dropFromHigh ?? -Infinity;
    case "eps": return d.eps ?? -Infinity;
    case "pe": return d.pe ?? -Infinity;
    case "industryPe": return d.industryPe ?? -Infinity;
    case "fundamentalView": return d.fundamentalView || "";
    case "bookValue": return d.bookValue ?? -Infinity;
    case "pb": return d.pb ?? -Infinity;
    case "roe": return d.roe ?? -Infinity;
    case "roce": return d.roce ?? -Infinity;
    case "roa": return d.roa ?? -Infinity;
    case "faceValue": return d.faceValue ?? -Infinity;
    case "marketCap": return d.marketCap ?? -Infinity;
    case "marketCap5y": return d.marketCap5y ?? -Infinity;
    case "intCoverage": return d.intCoverage ?? -Infinity;
    case "fcfPrevAnn": return d.fcfPrevAnn ?? -Infinity;
    case "profitVar3y": return d.profitVar3y ?? -Infinity;
    case "profitVar5y": return d.profitVar5y ?? -Infinity;
    default: return 0;
  }
}

// Every toggleable Stock Analysis column, in the same left-to-right
// order as the table's <thead>/<colgroup>. "name" (Stock/Symbol) is
// intentionally excluded — it's the sticky row identifier and is
// always shown.
const STOCK_ANALYSIS_COLUMNS = [
  { key: "sector", label: "Sector" },
  { key: "capCategory", label: "Market Cap Category" },
  { key: "ltp", label: "LTP" },
  { key: "range52", label: "52W Low / High" },
  { key: "gainFromLow", label: "Gain from Low %" },
  { key: "dropFromHigh", label: "Drop from High %" },
  { key: "eps", label: "EPS" },
  { key: "pe", label: "PE" },
  { key: "industryPe", label: "Industry PE" },
  { key: "buyReco", label: "Buy Reco" },
  { key: "fundamentalView", label: "Fundamental View" },
  { key: "bookValue", label: "Book Value" },
  { key: "pb", label: "P/B" },
  { key: "industryPbv", label: "Industry P/B" },
  { key: "yieldPct", label: "Yield %" },
  { key: "dividendYield", label: "Dividend Yield" },
  { key: "roe", label: "ROE" },
  { key: "roce", label: "ROCE" },
  { key: "roa", label: "ROA" },
  { key: "debtToEquity", label: "Debt to Equity" },
  { key: "promoterHolding", label: "Promoter Holding" },
  { key: "epsGrowth3y", label: "EPS Growth (3Y)" },
  { key: "epsGrowth5y", label: "EPS Growth (5Y)" },
  { key: "salesGrowth5y", label: "Sales Growth (5Y)" },
  { key: "qtrProfitVar", label: "Quarterly Profit Growth" },
  { key: "qtrSalesVar", label: "Quarterly Sales Growth" },
  { key: "faceValue", label: "Face Value" },
  { key: "marketCap", label: "Market Cap" },
  { key: "marketCap5y", label: "Market Cap (5Y Ago)" },
  { key: "intCoverage", label: "Interest Coverage" },
  { key: "fcfPrevAnn", label: "Free Cash Flow (Previous FY)" },
  { key: "profitVar3y", label: "Profit Growth (3Y)" },
  { key: "profitVar5y", label: "Profit Growth (5Y)" }
];

// Shows/hides whole columns by toggling `visibility: collapse` on
// each <col> in the Stock Analysis <colgroup> — this keeps table
// structure/widths intact for the columns that stay visible, unlike
// `display:none` on individual cells which would misalign every row.
// Shows/hides whole columns. Earlier this toggled `visibility: collapse`
// on each <col>, but that CSS value is unreliably implemented for table
// columns across browsers (Chrome in particular often fails to actually
// reclaim the column's width, leaving a blank gap where the "hidden"
// column used to be) — so instead this injects real `display: none`
// rules targeting the exact <th data-col="..."> and <td data-label="...">
// elements for each hidden column, which every browser handles
// correctly and which also fully reclaims the width even under
// table-layout:fixed.
let stockAnalysisColStyleEl = null;
function applyStockAnalysisColumnVisibility() {
  if (!stockAnalysisColStyleEl) {
    stockAnalysisColStyleEl = document.createElement("style");
    stockAnalysisColStyleEl.id = "stockAnalysisColStyle";
    document.head.appendChild(stockAnalysisColStyleEl);
  }
  const hidden = new Set(state.stockAnalysisHiddenCols || []);
  const rules = STOCK_ANALYSIS_COLUMNS
    .filter(col => hidden.has(col.key))
    .map(col => `#panel-stockanalysis table.data-table th[data-col="${col.key}"], #panel-stockanalysis table.data-table td[data-label="${col.label}"] { display: none !important; }`)
    .join("\n");
  stockAnalysisColStyleEl.textContent = rules;
}

function openStockAnalysisColumnsModal() {
  const hidden = new Set(state.stockAnalysisHiddenCols || []);
  const checkboxesHTML = STOCK_ANALYSIS_COLUMNS.map(col => `
    <label style="display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;">
      <input type="checkbox" data-col-key="${col.key}" ${hidden.has(col.key) ? "" : "checked"}>
      <span>${escapeAttr(col.label)}</span>
    </label>
  `).join("");
  const html = `
    <p class="settings-note" style="margin-top:0">Choose which columns to show on the Stock Analysis table. "Stock / Symbol" is always shown.</p>
    <div class="settings-actions" style="margin-bottom:10px;">
      <button class="btn btn-sm" id="saColsSelectAll">Select all</button>
      <button class="btn btn-sm" id="saColsSelectNone">Select none</button>
    </div>
    <div id="saColsList">${checkboxesHTML}</div>
  `;
  openModal("Stock Analysis — Columns", html, [
    { label: "Cancel", onClick: closeModal },
    {
      label: "Apply", primary: true, onClick: () => {
        const checked = new Set(
          Array.from(document.querySelectorAll('#saColsList input[type=checkbox]:checked')).map(i => i.dataset.colKey)
        );
        state.stockAnalysisHiddenCols = STOCK_ANALYSIS_COLUMNS
          .map(c => c.key)
          .filter(k => !checked.has(k));
        saveState();
        applyStockAnalysisColumnVisibility();
        closeModal();
      }
    }
  ]);
  document.getElementById("saColsSelectAll").addEventListener("click", () => {
    document.querySelectorAll('#saColsList input[type=checkbox]').forEach(i => i.checked = true);
  });
  document.getElementById("saColsSelectNone").addEventListener("click", () => {
    document.querySelectorAll('#saColsList input[type=checkbox]').forEach(i => i.checked = false);
  });
}

document.getElementById("btnStockAnalysisColumns").addEventListener("click", openStockAnalysisColumnsModal);

// Shows/hides the "Hidden (N)" toolbar button and keeps its count
// current — called on every renderStockAnalysis() so it can never go
// stale (e.g. after a restore from the modal below).
function updateStockAnalysisHiddenButton() {
  const btn = document.getElementById("btnStockAnalysisHidden");
  if (!btn) return;
  const n = (state.stockAnalysisExcludedNames || []).length;
  btn.style.display = n > 0 ? "" : "none";
  btn.textContent = `Hidden (${n})`;
}

// Lets the person restore stocks previously removed from Stock
// Analysis via the row ✕ button. Mirrors openStockAnalysisColumnsModal()'s
// checkbox-list pattern; unlike that one, an empty result here just
// means "nothing hidden" rather than "everything hidden", so there's
// no separate Select All/None shortcut.
function openStockAnalysisHiddenModal() {
  const excludedNames = state.stockAnalysisExcludedNames || [];
  if (excludedNames.length === 0) return;
  // Map back to the Equity holding's actual display name (excludedNames
  // stores the uppercased match key) so the list reads naturally.
  const nameFor = (key) => {
    const match = state.equity.find(r => (r.name || "").trim().toUpperCase() === key);
    return match ? match.name : key;
  };
  const checkboxesHTML = excludedNames.map(key => `
    <label style="display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;">
      <input type="checkbox" data-hidden-key="${escapeAttr(key)}">
      <span>${escapeAttr(nameFor(key))}</span>
    </label>
  `).join("");
  const html = `
    <p class="settings-note" style="margin-top:0">These stocks are still on your Equity tab — they're only hidden from Stock Analysis. Check any you'd like to bring back, then click Restore.</p>
    <div id="saHiddenList">${checkboxesHTML}</div>
  `;
  openModal("Stock Analysis — Hidden Stocks", html, [
    { label: "Close", onClick: closeModal },
    {
      label: "Restore Checked", primary: true, onClick: () => {
        const checked = new Set(
          Array.from(document.querySelectorAll('#saHiddenList input[type=checkbox]:checked')).map(i => i.dataset.hiddenKey)
        );
        if (checked.size === 0) { closeModal(); return; }
        state.stockAnalysisExcludedNames = excludedNames.filter(k => !checked.has(k));
        saveState();
        renderStockAnalysis();
        closeModal();
      }
    }
  ]);
}

document.getElementById("btnStockAnalysisHidden").addEventListener("click", openStockAnalysisHiddenModal);

// Which row's detail panel is currently expanded below the table.
// Keyed the same way row matching already works elsewhere (trimmed,
// uppercased name) — deliberately NOT persisted to state, since it's
// pure UI/view state, not portfolio data.
let stockAnalysisSelectedKey = null;

// Aggregate stats shown in the summary cards above the table. Computed
// over every currently-visible (non-excluded) Equity holding — i.e.
// unaffected by the search box, so the cards always describe the
// whole tracked set, not just what's currently filtered into view.
function computeStockAnalysisSummary(joinedRows) {
  const total = joinedRows.length;
  let buyCount = 0, highRoeCount = 0, lowPbFinancialCount = 0, screenerMatched = 0;
  joinedRows.forEach(({ screener, d }) => {
    if (screener) screenerMatched++;
    if (d.buyReco === true) buyCount++;
    if (d.roe !== null && d.roe > 15) highRoeCount++;
    if (d.isFinancial && d.pb !== null && d.pb < 1) lowPbFinancialCount++;
  });
  return { total, buyCount, highRoeCount, lowPbFinancialCount, screenerMatched };
}

function renderStockAnalysisSummary(joinedRows) {
  const el = document.getElementById("saSummaryGrid");
  if (!el) return;
  const s = computeStockAnalysisSummary(joinedRows);
  const pct = (n) => s.total > 0 ? fmtNum((n / s.total) * 100, 0) + "%" : "0%";
  el.innerHTML = `
    <div class="sa-stat-card accent-gold">
      <div class="sa-stat-label">Total Stocks</div>
      <div class="sa-stat-value">${s.total}</div>
    </div>
    <div class="sa-stat-card accent-pos">
      <div class="sa-stat-label">Buy Recommendations</div>
      <div class="sa-stat-value pos">${s.buyCount}<span class="sa-stat-sub">${pct(s.buyCount)}</span></div>
    </div>
    <div class="sa-stat-card accent-blue">
      <div class="sa-stat-label">High ROE &gt; 15%</div>
      <div class="sa-stat-value">${s.highRoeCount}<span class="sa-stat-sub">${pct(s.highRoeCount)}</span></div>
    </div>
    <div class="sa-stat-card accent-pos">
      <div class="sa-stat-label">Low P/B (Financial)</div>
      <div class="sa-stat-value pos">${s.lowPbFinancialCount}<span class="sa-stat-sub">${pct(s.lowPbFinancialCount)}</span></div>
    </div>
    <div class="sa-stat-card accent-warn">
      <div class="sa-stat-label">Screener Coverage</div>
      <div class="sa-stat-value">${s.screenerMatched}<span class="sa-stat-sub">/ ${s.total}</span></div>
    </div>
  `;
}

// Renders the expandable detail panel for whichever row is currently
// selected (stockAnalysisSelectedKey), defaulting to the first visible
// row so the panel is never blank when holdings exist. Every figure
// here is read straight from the same `d` (stockAnalysisDerived()
// output) the table row already used — nothing recalculated
// differently, per the "no duplicate calculations" requirement.
// Preserves the detail panel's expand/collapse state across
// re-renders — the 30-second auto price refresh and every stock
// switch rebuild this panel's innerHTML, which would otherwise
// silently re-collapse an open <details> each time. Mobile-only UI
// state; desktop always shows the sections regardless (see CSS).
let saDetailPanelOpen = false;

function renderStockAnalysisDetailPanel(joinedRows) {
  const panel = document.getElementById("saDetailPanel");
  if (!panel) return;
  if (joinedRows.length === 0) {
    panel.innerHTML = '<div class="sa-detail-empty">No Equity holdings to show — add stocks on the Equity tab, then import Screener Data for fundamentals.</div>';
    return;
  }
  let entry = joinedRows.find(({ row }) => (row.name || "").trim().toUpperCase() === stockAnalysisSelectedKey);
  if (!entry) entry = joinedRows[0];
  stockAnalysisSelectedKey = (entry.row.name || "").trim().toUpperCase();

  const { row, d } = entry;
  const buyHTML = d.buyReco === null
    ? '<span class="muted">—</span>'
    : d.buyReco ? '<span class="buy-badge buy">Buy</span>' : '<span class="buy-badge no">Hold</span>';
  const roaRow = d.isFinancial
    ? `<div class="sa-detail-row"><span class="k">ROA</span><span class="v">${fmtOrDash(d.roa, 1, "%")}</span></div>`
    : "";
  // "X vs Industry" is a plain display-time percentage diff between two
  // values stockAnalysisDerived() already computed (pe/industryPe,
  // pb/industryPbv) — nothing recalculated differently, just formatted
  // for this one panel the way the reference screenshot shows it.
  const peVsIndustryHTML = (d.pe !== null && d.industryPe) ? pctDiffHTML(d.pe, d.industryPe) : '<span class="muted">—</span>';
  const pbVsIndustryHTML = (d.pb !== null && d.industryPbv) ? pctDiffHTML(d.pb, d.industryPbv) : '<span class="muted">—</span>';

  panel.innerHTML = `
    <div class="sa-detail-head">
      <div>
        <div class="sa-detail-name">${escapeAttr(row.name || "(unnamed)")}</div>
        <div class="sa-detail-meta">${escapeAttr(d.sector || "Sector not set")} · ${d.capCategory ? escapeAttr(d.capCategory) : '<span class="muted">Cap not set</span>'}</div>
      </div>
      <div style="text-align:right;">
        <div class="sa-detail-price">${fmtNum(d.ltp)}</div>
        <div class="sa-detail-meta">${renderDayChangeBadgeHTML(d.ltp, d.prevClose, d.marketDataStale)}</div>
        <div class="sa-detail-meta">${buyHTML}</div>
      </div>
    </div>
    <details class="sa-detail-toggle" id="saDetailToggle"${saDetailPanelOpen ? " open" : ""}>
      <summary>Full fundamentals</summary>
      <div class="sa-detail-sections">
        <div class="sa-detail-section">
          <div class="sa-detail-section-title">Live Market Data${d.marketDataStale ? ' <span class="sa-stale-tag" title="Some fields could not refresh this cycle — showing last known values">stale</span>' : ""}</div>
          <div class="sa-detail-row"><span class="k">Previous Close</span><span class="v">${fmtOrDash(d.prevClose)}</span></div>
          <div class="sa-detail-row"><span class="k">Open</span><span class="v">${fmtOrDash(d.openPrice)}</span></div>
          <div class="sa-detail-row"><span class="k">Day High / Low</span><span class="v">${fmtOrDash(d.dayHigh)} / ${fmtOrDash(d.dayLow)}</span></div>
          <div class="sa-detail-row"><span class="k">52W High / Low</span><span class="v">${fmtOrDash(d.high52)} / ${fmtOrDash(d.low52)}</span></div>
        </div>
        <div class="sa-detail-section">
          <div class="sa-detail-section-title">Valuation</div>
          <div class="sa-detail-row"><span class="k">PE / Industry PE</span><span class="v">${fmtOrDash(d.pe)} / ${fmtOrDash(d.industryPe)}</span></div>
          <div class="sa-detail-row"><span class="k">PE vs Industry</span><span class="v">${peVsIndustryHTML}</span></div>
          <div class="sa-detail-row"><span class="k">P/B / Industry P/B</span><span class="v ${d.pbClass}">${fmtOrDash(d.pb)} / ${fmtOrDash(d.industryPbv)}</span></div>
          <div class="sa-detail-row"><span class="k">P/B vs Industry</span><span class="v">${pbVsIndustryHTML}</span></div>
          <div class="sa-detail-row"><span class="k">Free Cash Flow (Prev FY)</span><span class="v">${fmtOrDash(d.fcfPrevAnn, 0)}</span></div>
          <div class="sa-detail-row"><span class="k">Market Cap</span><span class="v">${fmtOrDash(d.marketCap, 0)}</span></div>
        </div>
        <div class="sa-detail-section">
          <div class="sa-detail-section-title">Financial Health</div>
          <div class="sa-detail-row"><span class="k">ROE</span><span class="v">${fmtOrDash(d.roe, 1, "%")}</span></div>
          <div class="sa-detail-row"><span class="k">ROCE</span><span class="v">${fmtOrDash(d.roce, 1, "%")}</span></div>
          ${roaRow}
          <div class="sa-detail-row"><span class="k">Debt to Equity</span><span class="v">${fmtOrDash(d.debtToEquity)}</span></div>
          <div class="sa-detail-row"><span class="k">Interest Coverage</span><span class="v">${fmtOrDash(d.intCoverage)}</span></div>
          <div class="sa-detail-row"><span class="k">Promoter Holding</span><span class="v">${fmtOrDash(d.promoterHolding, 1, "%")}</span></div>
        </div>
        <div class="sa-detail-section">
          <div class="sa-detail-section-title">Growth</div>
          <div class="sa-detail-row"><span class="k">EPS Growth (3Y / 5Y)</span><span class="v">${fmtOrDash(d.epsGrowth3y, 1, "%")} / ${fmtOrDash(d.epsGrowth5y, 1, "%")}</span></div>
          <div class="sa-detail-row"><span class="k">Profit Growth (3Y / 5Y)</span><span class="v">${fmtOrDash(d.profitVar3y, 1, "%")} / ${fmtOrDash(d.profitVar5y, 1, "%")}</span></div>
          <div class="sa-detail-row"><span class="k">Sales Growth (5Y)</span><span class="v">${fmtOrDash(d.salesGrowth5y, 1, "%")}</span></div>
          <div class="sa-detail-row"><span class="k">Quarterly Profit Growth</span><span class="v">${fmtOrDash(d.qtrProfitVar, 1, "%")}</span></div>
          <div class="sa-detail-row"><span class="k">Quarterly Sales Growth</span><span class="v">${fmtOrDash(d.qtrSalesVar, 1, "%")}</span></div>
        </div>
        <div class="sa-detail-section">
          <div class="sa-detail-section-title">Dividend &amp; Recommendation</div>
          <div class="sa-detail-row"><span class="k">Yield % (calculated)</span><span class="v">${fmtOrDash(d.yieldPct, 2, "%")}</span></div>
          <div class="sa-detail-row"><span class="k">Dividend Yield</span><span class="v">${fmtOrDash(d.dividendYield, 2, "%")}</span></div>
          <div class="sa-detail-row"><span class="k">Book Value / Face Value</span><span class="v">${fmtOrDash(d.bookValue)} / ${fmtOrDash(d.faceValue)}</span></div>
          <div class="sa-detail-row"><span class="k">52W Low / High</span><span class="v">${fmtOrDash(d.low52)} / ${fmtOrDash(d.high52)}</span></div>
          <div class="sa-detail-row"><span class="k">Recommendation</span><span class="v">${buyHTML}</span></div>
        </div>
        ${renderFundamentalViewSectionHTML(d)}
        ${renderBankingMetricsSectionHTML(row, d)}
      </div>
    </details>
  `;

  const detailsEl = document.getElementById("saDetailToggle");
  if (detailsEl) {
    detailsEl.addEventListener("toggle", () => { saDetailPanelOpen = detailsEl.open; });
  }
}

// Full-width detail-panel section for the sector-aware Fundamental
// View — mirrors renderBankingMetricsSectionHTML()'s placement/layout
// pattern. Everything shown here is read straight from `d`
// (computeFundamentalView()'s output), nothing recalculated.
function renderFundamentalViewSectionHTML(d) {
  return `
    <div class="sa-detail-section" style="grid-column:1/-1;">
      <div class="sa-detail-section-title">Fundamental View${d.fundamentalSectorLabel ? " — " + escapeAttr(d.fundamentalSectorLabel) : ""}</div>
      <div class="sa-detail-row"><span class="k">Overall</span><span class="v"><span class="fv-badge fv-${d.fundamentalViewCls}">${escapeAttr(d.fundamentalView)}</span></span></div>
      <div class="sa-detail-row" style="border-bottom:none;"><span class="v" style="font-family:var(--font-body);font-weight:400;color:var(--text-muted);">${escapeAttr(d.fundamentalViewReason || "")}</span></div>
    </div>
  `;
}

// Formats a "vs industry" percentage difference as colored HTML —
// positive (above industry average) in red-ish for PE/PB since lower
// is generally cheaper/better for these two ratios, negative (below
// industry average) in green. Purely a display helper; the underlying
// pe/pb/industryPe/industryPbv numbers are untouched.
function pctDiffHTML(value, industryValue) {
  const diff = ((value - industryValue) / industryValue) * 100;
  const cls = diff <= 0 ? "pos" : "neg";
  const sign = diff >= 0 ? "+" : "";
  return `<span class="${cls}">${sign}${fmtNum(diff, 1)}%</span>`;
}

/* ============================================================
   BANKING METRICS (manual, free-tier workflow)
   No API key, no Cloud Function, no billing — this generates a
   research prompt for the person to paste into their own claude.ai
   chat (free or subscription, whichever they already have), and
   saves whatever JSON reply they paste back in, after validating
   its shape. Storage rides the same state/saveState() mechanism as
   everything else in the app (localStorage, and Firestore if signed
   in) — no separate backend.
   ============================================================ */

const BANKING_METRICS_FIELDS = [
  { key: "crar", label: "CRAR / Capital Adequacy" },
  { key: "nim", label: "NIM" },
  { key: "gnpa", label: "Gross NPA" },
  { key: "nnpa", label: "Net NPA" },
  { key: "costToIncome", label: "Cost to Income" },
  { key: "casa", label: "CASA Ratio" }
];

// Same "is this a Financial-sector holding" test stockAnalysisDerived()
// already uses for ROA/P-B highlighting — kept as one shared function
// so the two can never quietly drift apart.
function getFinancialSectorStocks() {
  return state.equity.filter(row => /financ/i.test(row.sector || ""));
}

// The exact text the person copies into their own Claude chat. Asks
// for strict JSON so it can be pasted straight back in and parsed —
// the person never has to reformat anything by hand.
function buildBankingMetricsPrompt(stock) {
  const todayStr = new Date().toISOString().slice(0, 10);
  return `Research the MOST RECENT reported quarterly results for the Indian bank/financial company below and extract exactly six metrics.

Company: ${stock.name}
Today's date: ${todayStr}

Metrics to find (different banks report these under different names — normalize to the fields below):
1. crar — Capital Adequacy Ratio / CRAR / CAR (%)
2. nim — Net Interest Margin / NIM (%)
3. gnpa — Gross NPA / GNPA (%)
4. nnpa — Net NPA / NNPA (%)
5. costToIncome — Cost to Income Ratio (%)
6. casa — CASA Ratio (%)

Rules:
- Use the LATEST quarter for which results have actually been reported. Do not guess or project a future quarter.
- Prefer sources in this order: (1) the official quarterly results press release, (2) the official investor presentation, (3) the official company website or a regulatory (BSE/NSE/RBI) filing, (4) other reputable financial sources (e.g. Moneycontrol, Screener) only if none of the above are available.
- Cross-check figures against more than one source where you reasonably can.
- For EACH metric, cite the source you actually used: its name, its URL, and the exact reporting period as stated by that source.
- Do NOT estimate, infer, or guess a value. If a metric cannot be reliably found for the latest reported quarter, set "value" to null and give a short "reason".
- Respond with ONLY valid JSON — no other text, no markdown code fences — matching exactly this shape:

{
  "quarterLabel": "Q1 FY27",
  "quarterKey": "FY2027-Q1",
  "reportingDate": "YYYY-MM-DD",
  "metrics": {
    "crar": { "value": number_or_null, "unit": "%", "source": "string", "sourceUrl": "string", "reportedPeriod": "string", "confidence": "high|medium|low", "reason": "string, only if value is null" },
    "nim": { "same shape as above": true },
    "gnpa": { "same shape as above": true },
    "nnpa": { "same shape as above": true },
    "costToIncome": { "same shape as above": true },
    "casa": { "same shape as above": true }
  }
}

quarterKey format: "FY<year>-Q<1-4>" using Indian FY (Apr-Mar) — e.g. Jul-Sep 2026 is "FY2027-Q2".`;
}

// Modern Clipboard API with a legacy textarea+execCommand fallback,
// so "Copy" still works on an older/locked-down browser.
async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to legacy method */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

// Pulls the JSON object out of whatever the person pasted, tolerant
// of a stray ```json fence or a little surrounding text (Claude's
// chat reply sometimes wraps JSON in a code block even when asked
// not to).
function parseClaudeBankingJSON(raw) {
  let cleaned = String(raw || "").trim()
    .replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("That doesn't look like JSON — make sure you pasted Claude's full reply, including the { } braces.");
  }
  cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Could not parse that as JSON: " + e.message);
  }
}

// Deterministic sanity checks on top of whatever Claude said — this
// app never trusts a pasted reply purely on its own say-so. Rejects
// a malformed quarter key, a missing/invalid reporting date, a
// future-dated reply (a common hallucination shape), or a metrics
// object missing one of the six required fields.
function validateBankingMetricsResult(parsed) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Empty or invalid response.");
  }
  if (!/^FY\d{4}-Q[1-4]$/.test(parsed.quarterKey || "")) {
    throw new Error(`Unexpected quarter format: "${parsed.quarterKey}". Expected something like "FY2027-Q1".`);
  }
  if (!parsed.quarterLabel) {
    throw new Error("Missing quarterLabel.");
  }
  if (!parsed.reportingDate || isNaN(Date.parse(parsed.reportingDate))) {
    throw new Error(`Unexpected reportingDate: "${parsed.reportingDate}".`);
  }
  if (new Date(parsed.reportingDate) > new Date()) {
    throw new Error("Reporting date is in the future — this looks wrong, not saved.");
  }
  if (!parsed.metrics || typeof parsed.metrics !== "object") {
    throw new Error('Missing "metrics" object.');
  }
  BANKING_METRICS_FIELDS.forEach(f => {
    if (!(f.key in parsed.metrics)) throw new Error(`Missing metric field: "${f.key}".`);
  });
}

function countBankingMetricsFound(metrics) {
  const found = BANKING_METRICS_FIELDS.filter(f => {
    const m = metrics[f.key];
    return m && m.value !== null && m.value !== undefined;
  }).length;
  return `${found}/${BANKING_METRICS_FIELDS.length}`;
}

// Saves one validated quarter's record for a stock — replaces that
// exact quarter if it's already there (e.g. re-pasting a corrected
// answer), otherwise adds it, and keeps history sorted newest-first
// so getLatestBankingMetrics() is a simple [0].
function saveBankingMetricsForStock(symbolKey, parsed) {
  if (!state.bankingMetrics) state.bankingMetrics = {};
  if (!state.bankingMetrics[symbolKey]) state.bankingMetrics[symbolKey] = { history: [] };
  const history = state.bankingMetrics[symbolKey].history;
  const record = {
    quarterLabel: parsed.quarterLabel,
    quarterKey: parsed.quarterKey,
    reportingDate: parsed.reportingDate,
    metrics: parsed.metrics,
    savedAt: new Date().toISOString()
  };
  const idx = history.findIndex(h => h.quarterKey === parsed.quarterKey);
  if (idx >= 0) history[idx] = record; else history.push(record);
  history.sort((a, b) => (a.quarterKey < b.quarterKey ? 1 : -1));
  saveState();
  renderStockAnalysis();
}

function getLatestBankingMetrics(symbolKey) {
  const entry = state.bankingMetrics && state.bankingMetrics[symbolKey];
  if (!entry || !entry.history || entry.history.length === 0) return null;
  return entry.history[0];
}

// Builds one financial stock's block inside the modal: a "Copy
// Research Prompt" button, a textarea to paste Claude's reply into,
// and a "Save" button that validates + stores it. Every block is
// independent, so the person can copy one stock's prompt, go answer
// it, come back and save it, then move to the next — no need to do
// all of them in one sitting.
function bankingMetricsModalBlockHTML(row) {
  const symbolKey = (row.name || "").trim().toUpperCase();
  const latest = getLatestBankingMetrics(symbolKey);
  const latestNote = latest
    ? `Latest saved: ${escapeAttr(latest.quarterLabel)} (${countBankingMetricsFound(latest.metrics)} metrics)`
    : "No data saved yet.";
  return `
    <div class="settings-field" style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;">
      <label style="margin-bottom:2px;">${escapeAttr(row.name)}</label>
      <div class="settings-note" style="margin:0 0 8px;">${latestNote}</div>
      <div class="settings-actions">
        <button class="btn btn-sm" data-copy-symbol="${escapeAttr(symbolKey)}">📋 Copy Research Prompt</button>
        <span class="status-tag" data-copy-status="${escapeAttr(symbolKey)}"></span>
      </div>
      <textarea data-paste-symbol="${escapeAttr(symbolKey)}" rows="3" placeholder="Paste Claude's JSON reply here..."
        style="width:100%;margin-top:8px;font-family:var(--font-mono);font-size:11.5px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:8px;resize:vertical;"></textarea>
      <div class="settings-actions" style="margin-top:6px;">
        <button class="btn btn-sm btn-primary" data-save-symbol="${escapeAttr(symbolKey)}">Save</button>
        <span class="status-tag" data-save-status="${escapeAttr(symbolKey)}"></span>
      </div>
    </div>
  `;
}

function openBankingMetricsModal() {
  const stocks = getFinancialSectorStocks();
  if (stocks.length === 0) {
    alert('No Financial-sector stocks found — set Sector to something containing "Financial" on the Equity tab first.');
    return;
  }
  const html = `
    <p class="settings-note" style="margin-top:0">For each stock: click "Copy Research Prompt", paste it into your own Claude chat (claude.ai — free or subscription, whatever you already use), copy Claude's reply, paste it into the box below, then Save. Nothing here calls a paid API or needs sign-in.</p>
    ${stocks.map(bankingMetricsModalBlockHTML).join("")}
  `;
  openModal("Banking Metrics — Research &amp; Save", html, [
    { label: "Done", primary: true, onClick: closeModal }
  ]);

  document.querySelectorAll("[data-copy-symbol]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const symbolKey = btn.dataset.copySymbol;
      const stock = stocks.find(r => (r.name || "").trim().toUpperCase() === symbolKey);
      const statusEl = document.querySelector(`[data-copy-status="${CSS.escape(symbolKey)}"]`);
      const ok = await copyTextToClipboard(buildBankingMetricsPrompt(stock));
      if (statusEl) statusEl.textContent = ok ? "Copied!" : "Could not copy — select the text yourself.";
    });
  });

  document.querySelectorAll("[data-save-symbol]").forEach(btn => {
    btn.addEventListener("click", () => {
      const symbolKey = btn.dataset.saveSymbol;
      const textarea = document.querySelector(`[data-paste-symbol="${CSS.escape(symbolKey)}"]`);
      const statusEl = document.querySelector(`[data-save-status="${CSS.escape(symbolKey)}"]`);
      try {
        const parsed = parseClaudeBankingJSON(textarea.value);
        validateBankingMetricsResult(parsed);
        saveBankingMetricsForStock(symbolKey, parsed);
        if (statusEl) { statusEl.textContent = `Saved — ${countBankingMetricsFound(parsed.metrics)} metrics found.`; statusEl.style.color = "var(--positive)"; }
        textarea.value = "";
      } catch (e) {
        if (statusEl) { statusEl.textContent = e.message; statusEl.style.color = "var(--negative)"; }
      }
    });
  });
}

document.getElementById("btnBankingMetrics").addEventListener("click", openBankingMetricsModal);

// Renders the "Banking Metrics" section of the Stock Analysis detail
// panel — only for Financial-sector holdings, and only once
// something has actually been saved for that stock. Every figure
// here is read straight from state.bankingMetrics; nothing is
// recalculated.
function renderBankingMetricsSectionHTML(row, d) {
  if (!d.isFinancial) return "";
  const key = (row.name || "").trim().toUpperCase();
  const latest = getLatestBankingMetrics(key);
  if (!latest) {
    return `
      <div class="sa-detail-section" style="grid-column:1/-1;">
        <div class="sa-detail-section-title">Banking Metrics</div>
        <div class="sa-detail-row"><span class="k">Status</span><span class="v muted">Not researched yet — use "🏦 Banking Metrics" above.</span></div>
      </div>
    `;
  }
  const metrics = latest.metrics || {};
  const rowsHTML = BANKING_METRICS_FIELDS.map(f => {
    const m = metrics[f.key];
    if (!m || m.value === null || m.value === undefined) {
      const reason = m && m.reason ? escapeAttr(m.reason) : "Not found from a reliable source";
      return `<div class="sa-detail-row"><span class="k">${escapeAttr(f.label)}</span><span class="v muted" title="${reason}">— (${reason})</span></div>`;
    }
    const conf = m.confidence ? ` <span class="muted" style="font-size:10.5px;">(${escapeAttr(m.confidence)} confidence)</span>` : "";
    return `<div class="sa-detail-row"><span class="k">${escapeAttr(f.label)}</span><span class="v">${fmtNum(m.value, 2)}${escapeAttr(m.unit || "%")}${conf}</span></div>`;
  }).join("");
  const seenUrls = new Set();
  const sourceLinks = BANKING_METRICS_FIELDS
    .map(f => metrics[f.key])
    .filter(m => m && m.sourceUrl && !seenUrls.has(m.sourceUrl) && seenUrls.add(m.sourceUrl))
    .map(m => `<a href="${escapeAttr(m.sourceUrl)}" target="_blank" rel="noopener">${escapeAttr(m.source || m.sourceUrl)}</a>`)
    .join(", ");
  return `
    <div class="sa-detail-section" style="grid-column:1/-1;">
      <div class="sa-detail-section-title">Banking Metrics — ${escapeAttr(latest.quarterLabel || "Latest Quarter")}</div>
      ${rowsHTML}
      <div class="sa-detail-row"><span class="k">Reporting Date</span><span class="v">${escapeAttr(latest.reportingDate || "—")}</span></div>
      ${sourceLinks ? `<div class="sa-detail-row"><span class="k">Sources</span><span class="v" style="font-family:var(--font-body);font-weight:400;">${sourceLinks}</span></div>` : ""}
    </div>
  `;
}

function renderStockAnalysis() {
  const tbody = document.getElementById("stockAnalysisTableBody");
  if (!tbody) return;
  applyStockAnalysisColumnVisibility();
  const screenerMap = buildScreenerMap();

  let rows = state.equity.map(row => {
    const screener = screenerMap.get((row.name || "").trim().toUpperCase());
    const d = stockAnalysisDerived(row, screener);
    d._name = row.name || "";
    const fv = computeFundamentalView(row, screener, d);
    d.fundamentalView = fv.view;
    d.fundamentalViewCls = fv.cls;
    d.fundamentalViewReason = fv.reason;
    d.fundamentalSectorLabel = fv.sectorLabel;
    return { row, screener, d };
  });

  // Rows the person has explicitly removed from this tab (see the
  // ✕ button below and the "Hidden (N)" restore control) — filtered
  // out here, after the join/derive step above, so a later restore
  // doesn't need to recompute anything.
  const excluded = new Set(state.stockAnalysisExcludedNames || []);
  rows = rows.filter(({ row }) => !excluded.has((row.name || "").trim().toUpperCase()));
  updateStockAnalysisHiddenButton();

  // Summary cards and the detail panel always describe this full
  // (excluded-stocks-removed, but NOT search-filtered) set — so
  // typing in the filter box narrows the table without the cards
  // above it jumping around, and the detail panel can keep showing
  // whatever's selected even if a search term would hide its row.
  renderStockAnalysisSummary(rows);
  renderStockAnalysisDetailPanel(rows);
  renderIntelligentInsights();

  const ui = tableUI.stockanalysis;
  if (ui.filter) {
    const q = ui.filter.toLowerCase();
    rows = rows.filter(({ row, screener, d }) => stockAnalysisGetSearchText(row, screener, d).toLowerCase().includes(q));
  }
  if (ui.sortCol) {
    rows = [...rows].sort((a, b) => {
      let va = stockAnalysisGetSortValue(a.d, ui.sortCol);
      let vb = stockAnalysisGetSortValue(b.d, ui.sortCol);
      if (typeof va === "string" || typeof vb === "string") {
        va = String(va ?? "").toLowerCase();
        vb = String(vb ?? "").toLowerCase();
        return va < vb ? -ui.sortDir : va > vb ? ui.sortDir : 0;
      }
      return ((va || 0) - (vb || 0)) * ui.sortDir;
    });
  }

  tbody.innerHTML = "";
  if (state.equity.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="35">No Equity holdings yet — add stocks on the Equity tab first.</td></tr>';
    document.getElementById("saPagination").innerHTML = "";
    renderStockAnalysisMobileDeck([]);
    return;
  }
  if (rows.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="35">${excluded.size > 0 ? 'No holdings match this filter (some may be hidden — see "Hidden" above).' : 'No holdings match this filter.'}</td></tr>`;
    document.getElementById("saPagination").innerHTML = "";
    renderStockAnalysisMobileDeck([]);
    return;
  }

  // Pagination: person-selectable holdings per page (see the dropdown
  // rendered in renderStockAnalysisPagination()). Clamp the stored page
  // against the current filtered/sorted result count so e.g. narrowing
  // a search doesn't leave the view stuck on a page number that no
  // longer exists. "All" (pageSize === Infinity) is handled specially
  // since (page-1) * Infinity would otherwise be NaN when page is 1.
  const pageSize = getStockAnalysisPageSize();
  const totalPages = pageSize === Infinity ? 1 : Math.max(1, Math.ceil(rows.length / pageSize));
  if (ui.page > totalPages) ui.page = totalPages;
  if (ui.page < 1) ui.page = 1;
  const startIdx = pageSize === Infinity ? 0 : (ui.page - 1) * pageSize;
  const pageRows = pageSize === Infinity ? rows.slice() : rows.slice(startIdx, startIdx + pageSize);

  pageRows.forEach(({ row, d }) => {
    const tr = document.createElement("tr");
    const rowKey = (row.name || "").trim().toUpperCase();
    tr.dataset.rowKey = rowKey;
    if (rowKey && rowKey === stockAnalysisSelectedKey) tr.classList.add("sa-row-selected");
    const buyHTML = d.buyReco === null
      ? '<span class="muted">—</span>'
      : d.buyReco
        ? '<span class="buy-badge buy">Buy</span>'
        : '<span class="buy-badge no">Hold</span>';
    tr.innerHTML = `
      <td class="left sticky-col" data-label="Stock / Symbol">
        <div class="stock-cell">
          <span class="stock-avatar">${escapeAttr(stockMonogram(row.name))}</span>
          <span class="stock-cell-text"><span class="stock-cell-name">${escapeAttr(row.name || "")}</span></span>
        </div>
      </td>
      <td class="left" data-label="Sector">${escapeAttr(d.sector || "—")}</td>
      <td class="left" data-label="Market Cap Category">${d.capCategory ? escapeAttr(d.capCategory) : '<span class="muted">—</span>'}</td>
      <td data-label="LTP"><div class="sa-ltp-cell"><span>${fmtNum(d.ltp)}</span>${renderDayChangeBadgeHTML(d.ltp, d.prevClose, d.marketDataStale)}</div></td>
      <td class="left" data-label="52W Low / High">${renderRangeBarHTML(d)}</td>
      <td class="${d.gainFromLow > 0 ? 'pos' : ''}" data-label="Gain from Low %">${fmtOrDash(d.gainFromLow, 1, "%")}</td>
      <td class="${d.dropFromHigh > 0 ? 'neg' : ''}" data-label="Drop from High %">${fmtOrDash(d.dropFromHigh, 1, "%")}</td>
      <td data-label="EPS">${fmtOrDash(d.eps)}</td>
      <td data-label="PE">${fmtOrDash(d.pe)}</td>
      <td data-label="Industry PE">${fmtOrDash(d.industryPe)}</td>
      <td class="left" data-label="Buy Reco">${buyHTML}</td>
      <td class="left" data-label="Fundamental View"><span class="fv-badge fv-${d.fundamentalViewCls}" title="${escapeAttr(d.fundamentalViewReason || "")}">${escapeAttr(d.fundamentalView)}</span></td>
      <td data-label="Book Value">${fmtOrDash(d.bookValue)}</td>
      <td class="${d.pbClass}" data-label="P/B">${fmtOrDash(d.pb)}</td>
      <td data-label="Industry P/B">${fmtOrDash(d.industryPbv)}</td>
      <td data-label="Yield %">${fmtOrDash(d.yieldPct, 2, "%")}</td>
      <td data-label="Dividend Yield">${fmtOrDash(d.dividendYield, 2, "%")}</td>
      <td data-label="ROE">${fmtOrDash(d.roe, 1, "%")}</td>
      <td data-label="ROCE">${fmtOrDash(d.roce, 1, "%")}</td>
      <td data-label="ROA">${d.isFinancial ? fmtOrDash(d.roa, 1, "%") : '<span class="muted">—</span>'}</td>
      <td data-label="Debt to Equity">${fmtOrDash(d.debtToEquity)}</td>
      <td data-label="Promoter Holding">${fmtOrDash(d.promoterHolding, 1, "%")}</td>
      <td data-label="EPS Growth (3Y)">${fmtOrDash(d.epsGrowth3y, 1, "%")}</td>
      <td data-label="EPS Growth (5Y)">${fmtOrDash(d.epsGrowth5y, 1, "%")}</td>
      <td data-label="Sales Growth (5Y)">${fmtOrDash(d.salesGrowth5y, 1, "%")}</td>
      <td data-label="Quarterly Profit Growth">${fmtOrDash(d.qtrProfitVar, 1, "%")}</td>
      <td data-label="Quarterly Sales Growth">${fmtOrDash(d.qtrSalesVar, 1, "%")}</td>
      <td data-label="Face Value">${fmtOrDash(d.faceValue)}</td>
      <td data-label="Market Cap">${fmtOrDash(d.marketCap, 0)}</td>
      <td data-label="Market Cap (5Y Ago)">${fmtOrDash(d.marketCap5y, 0)}</td>
      <td data-label="Interest Coverage">${fmtOrDash(d.intCoverage)}</td>
      <td data-label="Free Cash Flow (Previous FY)">${fmtOrDash(d.fcfPrevAnn, 0)}</td>
      <td data-label="Profit Growth (3Y)">${fmtOrDash(d.profitVar3y, 1, "%")}</td>
      <td data-label="Profit Growth (5Y)">${fmtOrDash(d.profitVar5y, 1, "%")}</td>
      <td class="row-actions"><button class="icon-btn" title="Remove from Stock Analysis (keeps the Equity holding)">✕</button></td>
    `;
    tr.querySelector(".icon-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const key = (row.name || "").trim().toUpperCase();
      if (!key) return;
      if (!state.stockAnalysisExcludedNames) state.stockAnalysisExcludedNames = [];
      if (!state.stockAnalysisExcludedNames.includes(key)) {
        state.stockAnalysisExcludedNames.push(key);
        saveState();
        renderStockAnalysis();
      }
    });
    tr.addEventListener("click", () => {
      if (!rowKey) return;
      selectStockAnalysisRow(rowKey, rows);
    });
    tbody.appendChild(tr);
  });

  renderStockAnalysisPagination(rows.length, ui.page, totalPages, pageSize);
  renderStockAnalysisMobileDeck(pageRows, rows);
}

// Shared row-selection logic used by both the desktop table's row
// click and the mobile deck's card tap — keeps the two views'
// highlighted/selected holding in sync since they render from the
// same underlying page slice.
function selectStockAnalysisRow(rowKey, fullFilteredRows) {
  if (!rowKey || stockAnalysisSelectedKey === rowKey) return;
  stockAnalysisSelectedKey = rowKey;
  document.querySelectorAll("#stockAnalysisTableBody tr.sa-row-selected, .sa-mobile-card.sa-row-selected").forEach(el => el.classList.remove("sa-row-selected"));
  const matchingTr = Array.from(document.querySelectorAll("#stockAnalysisTableBody tr")).find(r => r.dataset.rowKey === rowKey);
  if (matchingTr) matchingTr.classList.add("sa-row-selected");
  const matchingCard = Array.from(document.querySelectorAll(".sa-mobile-card")).find(c => c.dataset.rowKey === rowKey);
  if (matchingCard) matchingCard.classList.add("sa-row-selected");
  renderStockAnalysisDetailPanel(fullFilteredRows);
}

// Renders the Prev/Next + numbered pagination bar under the desktop
// table, along with a "Showing X–Y of N" label. Numbered buttons
// collapse to first/last + a window around the current page (with
// ellipses) once there are more than 7 pages, so this stays usable
// even with a couple hundred holdings.
function renderStockAnalysisPagination(totalCount, page, totalPages, pageSize) {
  const el = document.getElementById("saPagination");
  if (!el) return;
  if (totalCount === 0) { el.innerHTML = ""; return; }
  const startN = pageSize === Infinity ? 1 : (page - 1) * pageSize + 1;
  const endN = pageSize === Infinity ? totalCount : Math.min(totalCount, page * pageSize);

  const pageNumbers = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pageNumbers.push(i);
  } else {
    pageNumbers.push(1);
    if (page > 3) pageNumbers.push("…");
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pageNumbers.push(i);
    if (page < totalPages - 2) pageNumbers.push("…");
    pageNumbers.push(totalPages);
  }

  const btnsHTML = pageNumbers.map(n =>
    n === "…"
      ? `<span class="sa-page-ellipsis">…</span>`
      : `<button class="sa-page-btn${n === page ? " active" : ""}" data-page="${n}">${n}</button>`
  ).join("");

  const sizeSelectHTML = `
    <select class="filter-input sa-page-size-select" id="saPageSize" title="Holdings per page">
      ${STOCK_ANALYSIS_PAGE_SIZE_OPTIONS.map(opt => `<option value="${opt}" ${tableUI.stockanalysis.pageSize === opt ? "selected" : ""}>${opt === "all" ? "Show All" : opt + " / page"}</option>`).join("")}
    </select>`;

  el.innerHTML = `
    <div class="sa-pagination-info">Showing ${startN}–${endN} of ${totalCount}</div>
    <div class="sa-pagination-controls">
      <button class="sa-page-btn" id="saPagePrev" ${page <= 1 ? "disabled" : ""} title="Previous page">‹</button>
      ${btnsHTML}
      <button class="sa-page-btn" id="saPageNext" ${page >= totalPages ? "disabled" : ""} title="Next page">›</button>
      ${sizeSelectHTML}
    </div>
  `;
  el.querySelectorAll("button[data-page]").forEach(btn => {
    btn.addEventListener("click", () => { tableUI.stockanalysis.page = Number(btn.dataset.page); renderStockAnalysis(); });
  });
  const prevBtn = document.getElementById("saPagePrev");
  const nextBtn = document.getElementById("saPageNext");
  if (prevBtn) prevBtn.addEventListener("click", () => { tableUI.stockanalysis.page = Math.max(1, page - 1); renderStockAnalysis(); });
  if (nextBtn) nextBtn.addEventListener("click", () => { tableUI.stockanalysis.page = Math.min(totalPages, page + 1); renderStockAnalysis(); });
  const sizeSelect = document.getElementById("saPageSize");
  if (sizeSelect) sizeSelect.addEventListener("change", () => {
    tableUI.stockanalysis.pageSize = sizeSelect.value;
    tableUI.stockanalysis.page = 1;
    renderStockAnalysis();
  });
}

// Mobile/tablet swipe-card deck — one card per holding, same page
// slice (pageRows) the desktop table just rendered, so both views
// always show the same 7 holdings and the same pagination position.
// Uses horizontal scroll-snap rather than a JS carousel library, so
// it works with native touch swipe with no added dependency.
function renderStockAnalysisMobileDeck(pageRows, fullFilteredRows) {
  const scroller = document.getElementById("saMobileScroller");
  const dotsEl = document.getElementById("saMobileDots");
  const paginationEl = document.getElementById("saMobilePagination");
  if (!scroller || !dotsEl || !paginationEl) return;

  if (!pageRows || pageRows.length === 0) {
    scroller.innerHTML = '<div class="sa-detail-empty" style="min-width:100%">No holdings to show.</div>';
    dotsEl.innerHTML = "";
    paginationEl.innerHTML = "";
    return;
  }

  scroller.innerHTML = pageRows.map(({ row, d }) => {
    const rowKey = (row.name || "").trim().toUpperCase();
    const selected = rowKey === stockAnalysisSelectedKey;
    const buyHTML = d.buyReco === null
      ? '<span class="muted">—</span>'
      : d.buyReco
        ? '<span class="buy-badge buy">Buy</span>'
        : '<span class="buy-badge no">Hold</span>';
    return `
      <div class="sa-mobile-card${selected ? " sa-row-selected" : ""}" data-row-key="${escapeAttr(rowKey)}">
        <div class="sa-mobile-card-top">
          <div>
            <div class="sa-mobile-card-name">${escapeAttr(row.name || "")}</div>
            <div class="sa-mobile-card-sector">${escapeAttr(d.sector || "Sector not set")}${d.capCategory ? " · " + escapeAttr(d.capCategory) : ""}</div>
          </div>
          <div>
            <div class="sa-mobile-card-price">${fmtNum(d.ltp)}</div>
            <div class="sa-mobile-card-chg">${renderDayChangeBadgeHTML(d.ltp, d.prevClose, d.marketDataStale)}</div>
          </div>
        </div>
        <div class="sa-mobile-card-grid">
          <div class="sa-mobile-metric"><div class="l">PE</div><div class="v">${fmtOrDash(d.pe)}</div></div>
          <div class="sa-mobile-metric"><div class="l">P/B</div><div class="v">${fmtOrDash(d.pb)}</div></div>
          <div class="sa-mobile-metric"><div class="l">ROE</div><div class="v">${fmtOrDash(d.roe, 1, "%")}</div></div>
        </div>
        <div class="sa-mobile-card-footer">
          ${renderRangeBarHTML(d)}
          <span class="fv-badge fv-${d.fundamentalViewCls}" title="${escapeAttr(d.fundamentalViewReason || "")}">${escapeAttr(d.fundamentalView)}</span>
          ${buyHTML}
        </div>
      </div>
    `;
  }).join("");

  scroller.querySelectorAll(".sa-mobile-card").forEach(card => {
    card.addEventListener("click", () => selectStockAnalysisRow(card.dataset.rowKey, fullFilteredRows || pageRows));
  });

  dotsEl.innerHTML = pageRows.map((_, i) => `<span class="sa-mobile-dot${i === 0 ? " active" : ""}"></span>`).join("");
  const dots = dotsEl.querySelectorAll(".sa-mobile-dot");
  let scrollTimer = null;
  scroller.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const cardWidth = scroller.firstElementChild ? scroller.firstElementChild.getBoundingClientRect().width + 12 : 1;
      const idx = Math.round(scroller.scrollLeft / cardWidth);
      dots.forEach((d, i) => d.classList.toggle("active", i === idx));
    }, 80);
  });

  // Reuses the exact same Prev/Next page state as the desktop table
  // (tableUI.stockanalysis.page) so switching between mobile and
  // desktop widths never disagrees on which page is showing.
  const ui = tableUI.stockanalysis;
  const mobilePageSize = getStockAnalysisPageSize();
  const totalPages = mobilePageSize === Infinity ? 1 : Math.max(1, Math.ceil((fullFilteredRows || pageRows).length / mobilePageSize));
  paginationEl.innerHTML = `
    <button class="sa-page-btn" id="saMobilePagePrev" ${ui.page <= 1 ? "disabled" : ""}>‹ Prev</button>
    <span class="sa-pagination-info">Page ${ui.page} of ${totalPages}</span>
    <button class="sa-page-btn" id="saMobilePageNext" ${ui.page >= totalPages ? "disabled" : ""}>Next ›</button>
  `;
  const mPrev = document.getElementById("saMobilePagePrev");
  const mNext = document.getElementById("saMobilePageNext");
  if (mPrev) mPrev.addEventListener("click", () => { ui.page = Math.max(1, ui.page - 1); renderStockAnalysis(); });
  if (mNext) mNext.addEventListener("click", () => { ui.page = Math.min(totalPages, ui.page + 1); renderStockAnalysis(); });
}

/* ---- Import Screener Data (.xlsx) ----
   Header-name-driven (not positional) so column order in the
   source file doesn't matter — matches the exact header text from
   a Screener export (e.g. "symbol", "book_value", "industry_pe"),
   case-insensitively. Every recognized numeric column is cleaned
   via parseScreenerNum() at import time (not at render time), so
   renderStockAnalysis() always works with plain numbers or null.
   Replaces the whole dataset on import — same full-overwrite
   pattern Debt import already uses, since a partial merge-by-symbol
   has no real advantage here and adds complexity.
*/

// Every field this tab consumes, plus its accepted header spelling(s)
// in the source file. Extend this list if a future export adds more
// Screener columns the tab should pick up.
const SCREENER_FIELD_MAP = {
  symbol: ["symbol"],
  book_value: ["book_value"],
  debt_to_equity: ["debt_to_equity"],
  dividend_yield: ["dividend_yield"],
  eps: ["eps"],
  eps_growth_3years: ["eps_growth_3years"],
  eps_growth_5years: ["eps_growth_5years"],
  face_value: ["face_value"],
  fcf_prev_ann: ["fcf_prev_ann"],
  high_low: ["high_low"],
  industry_pbv: ["industry_pbv"],
  industry_pe: ["industry_pe"],
  int_coverage: ["int_coverage"],
  mar_cap_5yrs_back: ["mar_cap_5yrs_back"],
  market_cap: ["market_cap"],
  profit_var_3yrs: ["profit_var_3yrs"],
  profit_var_5yrs: ["profit_var_5yrs"],
  promoter_holding: ["promoter_holding"],
  qtr_profit_var: ["qtr_profit_var"],
  qtr_sales_var: ["qtr_sales_var"],
  return_on_assets: ["return_on_assets"],
  roce: ["roce"],
  roe: ["roe"],
  sales_growth_5years: ["sales_growth_5years"]
};

function parseScreenerWorkbookRows(headerRows) {
  if (headerRows.length === 0) return [];
  const headers = headerRows[0].map(h => String(h ?? "").trim().toLowerCase());
  const colIndexFor = (candidates) => headers.findIndex(h => candidates.includes(h));
  const symbolIdx = colIndexFor(SCREENER_FIELD_MAP.symbol);
  if (symbolIdx === -1) return [];

  const fieldIndexes = {};
  Object.keys(SCREENER_FIELD_MAP).forEach(field => {
    if (field === "symbol") return;
    fieldIndexes[field] = colIndexFor(SCREENER_FIELD_MAP[field]);
  });

  return headerRows.slice(1).map(r => {
    const symbol = String(r[symbolIdx] ?? "").trim().toUpperCase();
    if (!symbol) return null;
    const out = { symbol };
    Object.keys(fieldIndexes).forEach(field => {
      const idx = fieldIndexes[field];
      if (idx === -1) { out[field] = null; return; }
      // high_low is a "High/Low" text cell, not a plain number —
      // kept as a raw string here and parsed by parseHighLow() at
      // render time.
      out[field] = field === "high_low" ? String(r[idx] ?? "").trim() : parseScreenerNum(r[idx]);
    });
    return out;
  }).filter(Boolean);
}

function showScreenerImportPreview(newRows, statusEl) {
  const existingCount = (state.screenerData || []).length;
  const previewRows = newRows.slice(0, 10).map(r => `
    <tr>
      <td class="left">${escapeAttr(r.symbol)}</td>
      <td class="left">${r.eps ?? "—"}</td>
      <td class="left">${r.book_value ?? "—"}</td>
      <td class="left">${r.industry_pe ?? "—"}</td>
    </tr>`).join("");
  const html = `
    <div class="import-stat-row">
      <div class="import-stat"><div class="n">${existingCount}</div><div class="l">Current Rows</div></div>
      <div class="import-stat"><div class="n">${newRows.length}</div><div class="l">Rows In File</div></div>
      <div class="import-stat ${existingCount ? "warn" : ""}"><div class="n">${existingCount}</div><div class="l">Will Be Replaced</div></div>
    </div>
    <p>This <strong>replaces all ${existingCount} existing Screener ${existingCount === 1 ? "row" : "rows"}</strong> with the ${newRows.length} row${newRows.length === 1 ? "" : "s"} from this file — nothing is merged.</p>
    <div class="table-scroll-wrap">
      <table>
        <thead><tr><th class="left">Symbol</th><th class="left">EPS</th><th class="left">Book Value</th><th class="left">Industry PE</th></tr></thead>
        <tbody>${previewRows}</tbody>
      </table>
    </div>
    ${newRows.length > 10 ? `<p class="settings-note">…and ${newRows.length - 10} more.</p>` : ""}
  `;
  openModal(
    "Import Screener Data — Preview",
    html,
    [
      { label: "Cancel", onClick: () => { closeModal(); statusEl.textContent = ""; } },
      {
        label: `Replace ${existingCount} ${existingCount === 1 ? "row" : "rows"}`, primary: true, onClick: () => {
          state.screenerData = newRows;
          saveState();
          renderStockAnalysis();
          renderEquity();
          closeModal();
          statusEl.textContent = `Imported ${newRows.length} Screener row${newRows.length === 1 ? "" : "s"}.`;
        }
      }
    ]
  );
}

// "Import Screener Data" -> choose Local file or Google Drive, mirroring
// openImportChooser()'s pattern for Zerodha Holdings import.
function openScreenerImportChooser() {
  openModal(
    "Import Screener Data",
    `<p>Import fundamentals from a Screener export (.xlsx) — matched to your Equity holdings by Symbol. Choose a source:</p>
     <p class="settings-note">Re-importing replaces the whole Screener dataset, whichever source you pick.</p>`,
    [
      { label: "Import from Local File", onClick: () => { closeModal(); document.getElementById("importScreenerFile").click(); } },
      { label: "Import from Google Drive", primary: true, onClick: () => { closeModal(); runScreenerDriveImportPicker(); } }
    ]
  );
}

document.getElementById("btnImportScreener").addEventListener("click", openScreenerImportChooser);

document.getElementById("importScreenerFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const statusEl = document.getElementById("screenerImportStatus");
  if (!file) return;
  try {
    const rows = await readWorkbookRows(file);
    const newRows = parseScreenerWorkbookRows(rows);
    if (newRows.length === 0) {
      alert('No valid Screener rows found — make sure the file has a "symbol" column header and at least one data row.');
    } else {
      showScreenerImportPreview(newRows, statusEl);
    }
  } catch (err) {
    alert("Could not read that Excel file. Expected a header row including a \"symbol\" column, plus columns like book_value, eps, industry_pe, roe, roce, etc.");
  }
  e.target.value = "";
});

// Google Drive source for Screener import: reuses the exact same
// Picker/OAuth plumbing as the Zerodha Holdings Drive import
// (ensurePickerLoaded/ensureGisLoaded/requestDriveAccessToken/
// openDrivePicker/downloadDriveFileAsArrayBuffer — all defined
// above), just single-select and feeding into
// parseScreenerWorkbookRows() + showScreenerImportPreview() instead
// of the Zerodha flow. Uses the same Google Drive Client ID/API Key
// from Settings, so no separate setup is needed if Holdings import
// from Drive is already configured.
async function runScreenerDriveImportPicker() {
  const statusEl = document.getElementById("screenerImportStatus");
  if (!state.googleDriveClientId || !state.googleDriveApiKey) {
    alert('Google Drive import needs a one-time setup: add a "Google Drive Client ID" and "Google Drive API Key" in Settings. See the note there for how to create them in Google Cloud Console.');
    return;
  }
  if (statusEl) statusEl.textContent = "Opening Google Drive...";
  let files, accessToken;
  try {
    await ensurePickerLoaded();
    await ensureGisLoaded();
    accessToken = await requestDriveAccessToken();
    files = await openDrivePicker(accessToken, { multiSelect: false });
  } catch (err) {
    if (statusEl) statusEl.textContent = "";
    alert("Could not open Google Drive: " + (err && err.message ? err.message : "unknown error"));
    return;
  }
  if (!files || files.length === 0) { if (statusEl) statusEl.textContent = ""; return; } // person cancelled the picker

  const file = files[0];
  let rows;
  try {
    if (statusEl) statusEl.textContent = `Downloading "${file.name}"...`;
    const arrayBuffer = await downloadDriveFileAsArrayBuffer(file, accessToken);
    if (statusEl) statusEl.textContent = `Reading "${file.name}"...`;
    rows = workbookRowsFromArrayBuffer(arrayBuffer);
  } catch (err) {
    if (statusEl) statusEl.textContent = "";
    alert(err && err.message ? err.message : 'Could not read that file from Drive. Expected a header row including a "symbol" column, plus columns like book_value, eps, industry_pe, roe, roce, etc.');
    return;
  }
  if (statusEl) statusEl.textContent = "";
  const newRows = parseScreenerWorkbookRows(rows);
  if (newRows.length === 0) {
    alert('No valid Screener rows found in that file — make sure it has a "symbol" column header and at least one data row.');
    return;
  }
  showScreenerImportPreview(newRows, statusEl);
}

// The Cash on hand field displays a formatted currency value
// (matching the look of the other stat cards) whenever it isn't
// focused, and switches to a plain editable number while typing.
(() => {
  const cashInputEl = document.getElementById("cashInput");
  cashInputEl.addEventListener("focus", () => {
    cashInputEl.value = state.cash || "";
  });
  cashInputEl.addEventListener("blur", () => {
    const cleaned = cashInputEl.value.replace(/[^\d.-]/g, "");
    const val = parseFloat(cleaned) || 0;
    if (val !== state.cash) {
      state.cash = val;
      saveState();
    }
    renderDashboard();
  });
})();

/* ============================================================
   EXCEL IMPORT — Stocks, Mutual Funds, Gold
   Reads the file entirely in the browser via SheetJS (xlsx.js).
   Uses the first sheet in the workbook, treats row 1 as a
   header (skipped), and appends new rows to whatever's already
   in that tab — existing entries are never overwritten.
   ============================================================ */

function workbookRowsFromArrayBuffer(data) {
  const wb = XLSX.read(data, { type: "array", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}

async function readWorkbookRows(file) {
  const data = await file.arrayBuffer();
  return workbookRowsFromArrayBuffer(data);
}

// A blank cell (undefined/null/empty-after-trim) means "no update for
// this field" for per-tab Excel import — used so a partial-column
// import (e.g. only Category/Sub-category/Symbol filled in) never
// clobbers an existing Units/Invested value with 0 just because that
// column was left empty in the source sheet.
function cellIsBlank(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

// Normalizes a cell that might be a JS Date (from a date-formatted
// Excel cell), a plain "YYYY-MM-DD" string, or empty, into the
// yyyy-mm-dd format the app's <input type="date"> fields expect.
function toDateInputValue(v) {
  if (v instanceof Date && !isNaN(v)) {
    return v.toISOString().slice(0, 10);
  }
  const s = String(v ?? "").trim();
  // Matches a plain "YYYY-MM-DD" cell as well as a full ISO datetime
  // string (e.g. "2026-08-08T00:00:00.000Z", what Apps Script's
  // JSON.stringify produces for a Date cell) — takes just the date part.
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

// Debt / Fixed Income: Name, Category, Sub-category, Account No.,
// Invested Amount, ROI, Maturity Amount, Invested Date, Maturity
// Date, Tenure Months, Notes (Profit and Tenure Years are always
// calculated, never imported).
//
// Unlike the other three tabs' importers, Debt import is a full
// OVERWRITE, not an upsert/append: whatever's parsed from the file
// (or Google Sheet) entirely replaces state.debt. This is deliberate
// — FD names aren't a reliable unique key (two different FDs can
// share a bank name), so matching-by-name risked silently merging
// distinct entries; a clean replace sidesteps that instead of trying
// to solve it. Always shown as a preview + explicit confirm first,
// same pattern as the Zerodha Holdings importers use.
function parseDebtWorkbookRows(headerRows) {
  return headerRows.slice(1).map(r => {
    const name = String(r[0] ?? "").trim();
    if (!name) return null;
    return {
      id: uid(), name,
      category: String(r[1] ?? "").trim(),
      subcategory: String(r[2] ?? "").trim(),
      account: String(r[3] ?? "").trim(),
      invested: parseFloat(r[4]) || 0,
      roi: parseFloat(r[5]) || 0,
      maturityAmount: parseFloat(r[6]) || 0,
      investedDate: toDateInputValue(r[7]),
      maturityDate: toDateInputValue(r[8]),
      tenureMonths: parseFloat(r[9]) || 0,
      notes: String(r[10] ?? "").trim()
    };
  }).filter(Boolean);
}

// Same field set, but sourced from a Google Sheet row object (keyed
// by that sheet's actual header text) instead of a positional Excel
// row — mirrors the flexible-header-matching convention already used
// by buildMFCategoryMap() for the Mutual Funds tab.
function parseDebtSheetRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(obj => {
    const keys = Object.keys(obj);
    const findVal = (candidates) => {
      const k = keys.find(k => candidates.some(c => c.toLowerCase() === k.trim().toLowerCase()));
      return k ? String(obj[k] ?? "").trim() : "";
    };
    const name = findVal(["Name"]);
    if (!name) return null;
    return {
      id: uid(), name,
      category: findVal(["Category"]),
      subcategory: findVal(["Sub-category", "Sub-cateogry", "Subcategory", "Sub category"]),
      account: findVal(["Account No.", "Account No", "Account"]),
      invested: parseFloat(findVal(["Invested Amount", "Invested"])) || 0,
      roi: parseFloat(findVal(["ROI", "ROI %", "ROI Percent"])) || 0,
      maturityAmount: parseFloat(findVal(["Maturity Amount"])) || 0,
      investedDate: toDateInputValue(findVal(["Invested Date"])),
      maturityDate: toDateInputValue(findVal(["Maturity Date"])),
      tenureMonths: parseFloat(findVal(["Tenure Months", "Tenure (Months)"])) || 0,
      notes: findVal(["Notes"])
    };
  }).filter(Boolean);
}

function showDebtImportPreview(newRows, sourceLabel, statusEl) {
  const existingCount = state.debt.length;
  const previewRows = newRows.slice(0, 10).map(r => `
    <tr>
      <td class="left">${escapeAttr(r.name)}</td>
      <td class="left">${escapeAttr(r.category || "—")}</td>
      <td class="left">${fmtINR(r.invested)}</td>
      <td class="left">${escapeAttr(r.maturityDate || "—")}</td>
    </tr>`).join("");
  const html = `
    <div class="import-stat-row">
      <div class="import-stat"><div class="n">${existingCount}</div><div class="l">Current Entries</div></div>
      <div class="import-stat"><div class="n">${newRows.length}</div><div class="l">Entries In ${escapeAttr(sourceLabel)}</div></div>
      <div class="import-stat ${existingCount ? "warn" : ""}"><div class="n">${existingCount}</div><div class="l">Will Be Replaced</div></div>
    </div>
    <p>This <strong>replaces all ${existingCount} existing Debt ${existingCount === 1 ? "entry" : "entries"}</strong> with the ${newRows.length} entr${newRows.length === 1 ? "y" : "ies"} from ${escapeAttr(sourceLabel)} — nothing is merged. This can't be undone from within the app; export a backup first if you're not sure.</p>
    <div class="table-scroll-wrap">
      <table>
        <thead><tr><th class="left">Name</th><th class="left">Category</th><th class="left">Invested</th><th class="left">Maturity Date</th></tr></thead>
        <tbody>${previewRows}</tbody>
      </table>
    </div>
    ${newRows.length > 10 ? `<p class="settings-note">…and ${newRows.length - 10} more.</p>` : ""}
  `;
  openModal(
    `Import Debt from ${sourceLabel} — Preview`,
    html,
    [
      { label: "Cancel", onClick: () => { closeModal(); statusEl.textContent = ""; } },
      {
        label: `Replace ${existingCount} ${existingCount === 1 ? "entry" : "entries"}`, primary: true, onClick: () => {
          state.debt = newRows;
          saveState();
          renderDebt();
          renderDashboard();
          closeModal();
          statusEl.textContent = `Replaced Debt data with ${newRows.length} entr${newRows.length === 1 ? "y" : "ies"} from ${sourceLabel}.`;
        }
      }
    ]
  );
}

document.getElementById("importDebtFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const statusEl = document.getElementById("debtImportStatus");
  if (!file) return;
  try {
    const rows = await readWorkbookRows(file);
    const newRows = parseDebtWorkbookRows(rows);
    if (newRows.length === 0) {
      alert("No valid Debt rows found in that file — nothing to import.");
    } else {
      showDebtImportPreview(newRows, "Excel file", statusEl);
    }
  } catch (err) {
    alert("Could not read that Excel file. Expected columns: Name, Category, Sub-category, Account No., Invested Amount, ROI, Maturity Amount, Invested Date, Maturity Date, Tenure Months, Notes.");
  }
  e.target.value = "";
});

// Google Sheet import: reads the same Apps Script Web App already
// used for live prices (PRICE_API_URL) — the app just expects the
// JSON payload to also carry a "debt" array now, one object per row
// on a "Debt" tab, keyed by that tab's own header text (same
// convention as stocks/mf/gold). See PROJECT_CONTEXT.md for the
// doGet() change needed on Ganesh's Apps Script to add this.
document.getElementById("btnImportDebtSheet").addEventListener("click", async () => {
  const statusEl = document.getElementById("debtImportStatus");
  statusEl.textContent = "Fetching from Google Sheet...";
  let data;
  try {
    data = await fetchPriceData();
  } catch (e) {
    statusEl.textContent = sheetErrorMessage(e);
    return;
  }
  if (!Array.isArray(data.debt)) {
    statusEl.textContent = "";
    alert('Your Apps Script doesn\'t return a "debt" array yet. Add a Debt tab to the Sheet and extend doGet() to include it under a "debt" key, the same way Stocks/Mutual Funds/Gold are already returned — see PROJECT_CONTEXT.md for the exact snippet.');
    return;
  }
  const newRows = parseDebtSheetRows(data.debt);
  statusEl.textContent = "";
  if (newRows.length === 0) {
    alert('No valid Debt rows found on the Debt tab of your Google Sheet — check that each row has at least a Name.');
    return;
  }
  showDebtImportPreview(newRows, "Google Sheet", statusEl);
});

/* ============================================================
   IMPORT — Zerodha Holdings (single "Import" button per tab)
   Equity, Mutual Funds and Gold each have one "Import" button.
   Clicking it offers a choice — Import from Local (a Zerodha
   Console "Holdings Statement" .xlsx picked from disk) or Import
   from Google Drive (same Holdings Apps Script used before,
   scanning a designated Drive folder for the most recently
   modified export). Either source is parsed into the same
   holding-record shape below, so the rest of the flow (matching,
   multi-account combine, preview, apply) is shared.

   Column mapping (from the actual Zerodha Holdings Statement
   export — "Equity" and "Mutual Funds" sheets, each with a few
   summary rows above the real data table):
     Equity:        Symbol -> Stock/Symbol, Quantity Available ->
                    Units, Average Price -> Avg Price (Invested =
                    Units x Avg Price), Sector -> new Sector column.
     Mutual Funds:  Symbol (the fund's full scheme name in this
                    export) -> Name, Quantity Available -> Units,
                    Average Price -> Avg Price, Instrument Type ->
                    Category (Sub-category has been removed).
   Gold ETFs (e.g. GOLDBEES) live inside the Equity sheet in
   Zerodha's export, but get routed to the Gold tab instead of
   Equity — see isGoldSymbol().

   Multiple Zerodha accounts: every holding row keeps a hidden
   zerodhaAccounts map { <Client ID>: {qty, avgPrice, invested} }.
   Importing a file only ever writes that one Client ID's entry;
   Units/Invested shown in the tracker are always the sum across
   every account map key. That makes re-importing the same
   account's file a safe no-op re-apply, and importing a second or
   third account's file for a holding that already exists ADDS
   that account's slice instead of overwriting the row — see
   combineAccountTotals(). No duplicate rows are ever created;
   matching is by Symbol (Equity/Gold) or fund name (Mutual Funds),
   same convention the live-price refresh already uses.
   ============================================================ */

// Handles plain numbers, Indian-grouped strings ("4,12,685.77"),
// stray non-breaking spaces, and Zerodha's "-" placeholder for
// blank numeric cells. Returns null for anything not usable as a
// number so callers can treat that field as missing.
function parseIndianNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isNaN(v) ? null : v;
  const s = String(v).replace(/,/g, "").replace(/\u00a0/g, "").trim();
  if (s === "" || s === "-") return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Symbols that belong on the Gold tab even though Zerodha lists
// them on the Equity holdings sheet (Gold ETFs trade on the
// exchange like stocks). Matched case-insensitively anywhere in
// the symbol — covers GOLDBEES, GOLDIETF, GOLDCASE, HDFCGOLD,
// AXISGOLD, SETFGOLD and similar. If your broker export uses a
// Gold ETF ticker that doesn't contain "GOLD", add it here.
function isGoldSymbol(symbol) {
  return /GOLD/i.test(String(symbol || ""));
}

// Equity holdings that are themselves ETFs (index/sector ETFs like
// NIFTYBEES, BANKBEES, JUNIORBEES, or anything with "ETF" in the
// name) have no company-level fundamentals — no PE, EPS, ROE, growth
// rates, etc. apply to a basket of stocks — so Intelligent Insights
// skips them entirely rather than showing a perpetual "No Action —
// Insufficient Data" for something that will never get a Screener
// match. Gold ETFs never reach this check in the first place
// (isGoldSymbol() above already routes them to the Gold tab at
// import time); this catches other index/sector ETFs that stay on
// the Equity tab.
function isETFEquity(row) {
  return /\bETF\b|BEES/i.test(String(row.name || ""));
}

// Finds the "Client ID" label anywhere in a sheet's raw rows
// (array-of-arrays) and returns the value in the next non-empty
// cell on that same row — tags every holding parsed from a file
// with which Zerodha account it came from.
function findClientId(rawRows) {
  for (const r of rawRows) {
    const idx = r.findIndex(c => String(c ?? "").trim().toLowerCase() === "client id");
    if (idx === -1) continue;
    for (let i = idx + 1; i < r.length; i++) {
      const v = String(r[i] ?? "").trim();
      if (v) return v;
    }
  }
  return "";
}

// Zerodha's Holdings Statement export has several summary rows
// above the real data table (title, Invested/Present Value, P&L,
// etc.), and exactly how many depends on the account — so instead
// of assuming a fixed row number, this scans for the row that
// contains "Symbol" as a column header and treats every row below
// it (until the next blank row) as the data table.
function extractZerodhaSheetObjects(rawRows) {
  const headerIdx = rawRows.findIndex(r => r.some(c => String(c ?? "").trim().toLowerCase() === "symbol"));
  if (headerIdx === -1) return [];
  const headers = rawRows[headerIdx].map(h => String(h ?? "").trim());
  const objects = [];
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (!r || r.every(c => c === undefined || c === null || String(c).trim() === "")) break;
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = r[idx]; });
    objects.push(obj);
  }
  return objects;
}

// Turns one raw row-object (keyed by the sheet's real header text
// — whether parsed from a local .xlsx or returned as JSON by the
// Drive Apps Script) into the common shape the rest of the import
// flow uses. Also accepts the older Drive contract's header names
// (Qty. / Buy avg.) so an already-deployed Holdings Apps Script
// keeps working without changes. Returns null when Quantity or
// Average Price isn't a usable number.
function toHoldingRecord(obj, accountId) {
  const keys = Object.keys(obj);
  const findVal = (candidates) => {
    const k = keys.find(k => candidates.some(c => c.toLowerCase() === k.trim().toLowerCase()));
    return k !== undefined ? obj[k] : undefined;
  };
  const qty = parseIndianNumber(findVal(["Quantity Available", "Qty."]));
  const avgPrice = parseIndianNumber(findVal(["Average Price", "Buy avg."]));
  if (qty === null || avgPrice === null) return null;
  const investedRaw = parseIndianNumber(findVal(["Buy value"]));
  const invested = investedRaw !== null ? investedRaw : qty * avgPrice;
  const sector = String(findVal(["Sector"]) ?? "").trim();
  const instrumentType = String(findVal(["Instrument Type"]) ?? "").trim();
  return {
    accountId: accountId || "",
    qty, avgPrice, invested,
    sector: (sector && sector !== "-") ? sector : "",
    category: (instrumentType && instrumentType !== "-") ? instrumentType : ""
  };
}

// Splits a sheet's row-objects into usable holding records (paired
// with their Symbol) and an "attention" list of Symbols present in
// the file but missing a usable Quantity/Average Price — fully
// blank rows are ignored entirely rather than flagged.
function extractRecordsAndAttention(objects, accountId) {
  const records = [], attention = [];
  objects.forEach(obj => {
    const symbol = String(obj["Symbol"] ?? "").replace(/\u00a0/g, "").trim();
    if (!symbol) return;
    const rec = toHoldingRecord(obj, accountId);
    if (rec) records.push({ symbol, ...rec });
    else attention.push(symbol);
  });
  return { records, attention };
}

// Reads a local Zerodha Holdings Statement .xlsx and returns
// holding records for Equity, Mutual Funds and Gold (Gold-ETF
// symbols found on the Equity sheet are already split out), plus
// each sheet's "attention" list and the account's Client ID.
// Core parser: takes the raw workbook bytes (an ArrayBuffer) and
// returns Equity/Mutual Fund/Gold holding records exactly like
// before. Split out from the old parseLocalZerodhaWorkbook() so the
// same logic can run whether the bytes came from a local <input
// type=file> or were just downloaded from a Google Drive file the
// person picked via the Drive Picker — both paths converge here.
function parseZerodhaWorkbookFromArrayBuffer(wbData) {
  const wb = XLSX.read(wbData, { type: "array", cellDates: true });
  const findSheet = (nameSubstr) => {
    const sn = wb.SheetNames.find(n => n.toLowerCase().includes(nameSubstr));
    return sn ? wb.Sheets[sn] : null;
  };
  const readSheet = (sheet) => {
    if (!sheet) return { objects: [], clientId: "" };
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    return { objects: extractZerodhaSheetObjects(rawRows), clientId: findClientId(rawRows) };
  };
  const eqSheet = readSheet(findSheet("equity") || findSheet("stock"));
  const mfSheet = readSheet(findSheet("mutual"));
  const clientId = eqSheet.clientId || mfSheet.clientId || "";

  const eqParsed = extractRecordsAndAttention(eqSheet.objects, clientId);
  const mfParsed = extractRecordsAndAttention(mfSheet.objects, clientId);

  const equity = [], gold = [];
  eqParsed.records.forEach(r => (isGoldSymbol(r.symbol) ? gold : equity).push(r));

  return {
    clientId,
    equity, gold, mf: mfParsed.records,
    attention: { equity: eqParsed.attention, mf: mfParsed.attention }
  };
}

async function parseLocalZerodhaWorkbook(file) {
  const wbData = await file.arrayBuffer();
  return parseZerodhaWorkbookFromArrayBuffer(wbData);
}

// Legacy Drive path: reuses the older Holdings Apps Script contract
// (data.stocks / data.mf / data.gold), running each row through the
// same toHoldingRecord() so both old (Qty./Buy avg.) and new
// (Quantity Available/Average Price) header names work. Gold-ETF
// symbols found under "stocks" are pulled out and merged with
// data.gold (if the deployed script still returns one). Superseded by
// the Google Drive file picker below (runDriveImportPicker()), which
// lets the person browse and pick the exact file instead of relying
// on a folder-scanning script — kept here only in case the Holdings
// API URL in Settings is still wanted for something else.
async function fetchDriveZerodhaHoldings() {
  const data = await fetchHoldingsData();
  const accountIdFor = (obj) => {
    const keys = Object.keys(obj);
    const k = keys.find(k => k.trim().toLowerCase() === "client id");
    return k ? String(obj[k] || "").trim() : (data.sourceFileName || "Drive");
  };
  // Drive rows can each carry their own Client ID column (unlike a
  // local file, where the whole sheet shares one), so records are
  // built manually here instead of via extractRecordsAndAttention().
  const buildRecords = (rows) => {
    const records = [], attention = [];
    (Array.isArray(rows) ? rows : []).forEach(obj => {
      const symbol = String(obj["Symbol"] ?? "").replace(/\u00a0/g, "").trim();
      if (!symbol) return;
      const rec = toHoldingRecord(obj, accountIdFor(obj));
      if (rec) records.push({ symbol, ...rec }); else attention.push(symbol);
    });
    return { records, attention };
  };
  const stocks = buildRecords(data.stocks);
  const goldSheet = buildRecords(data.gold);
  const mf = buildRecords(data.mf);

  const equity = [], goldFromStocks = [];
  stocks.records.forEach(r => (isGoldSymbol(r.symbol) ? goldFromStocks : equity).push(r));

  return {
    sourceLabel: data.sourceFileName || "Google Drive",
    equity, mf: mf.records, gold: [...goldFromStocks, ...goldSheet.records],
    attention: { equity: stocks.attention, mf: mf.attention }
  };
}

// Merges one imported holding record into an existing row's (or a
// brand-new row's) hidden zerodhaAccounts map, keyed by Client ID,
// then recomputes Quantity/Invested as the sum across every account
// on file for that holding. This is what makes importing a second
// or third Zerodha account's file ADD to a holding instead of
// overwriting it, while re-importing the same account's file stays
// a safe no-op re-apply.
function combineAccountTotals(row, rec) {
  if (!row.zerodhaAccounts) row.zerodhaAccounts = {};
  const accountKey = rec.accountId || "default";
  row.zerodhaAccounts[accountKey] = { qty: rec.qty, avgPrice: rec.avgPrice, invested: rec.invested };
  const accounts = Object.values(row.zerodhaAccounts);
  const totalQty = accounts.reduce((s, a) => s + (Number(a.qty) || 0), 0);
  const totalInvested = accounts.reduce((s, a) => s + (Number(a.invested) || 0), 0);
  return { totalQty, totalInvested, accountCount: accounts.length };
}

// Builds the match/add plan for one asset class's imported records
// against its existing tracker rows. Records are first grouped by
// Symbol, then within each Symbol group by Account (Client ID) — a
// Symbol appearing under more than one Account is a genuine
// multi-account holding (e.g. the same stock held in two different
// Zerodha accounts' files) and every account's record is kept, to be
// folded together later via combineAccountTotals(). A Symbol
// repeated under the *same* Account (e.g. the same file selected
// twice, or the same account exported twice) is a true duplicate —
// the later occurrence wins and it's reported in the preview rather
// than silently dropped.
function planZerodhaImport(records, existingArray, matchFn) {
  const bySymbol = new Map();
  records.forEach(r => {
    const k = r.symbol.toUpperCase();
    if (!bySymbol.has(k)) bySymbol.set(k, []);
    bySymbol.get(k).push(r);
  });

  const duplicateKeys = [];
  const matched = [], added = [];
  bySymbol.forEach(recs => {
    const byAccount = new Map(); // accountId -> record (last occurrence wins)
    recs.forEach(r => {
      const acctKey = r.accountId || "default";
      if (byAccount.has(acctKey)) duplicateKeys.push(r.symbol);
      byAccount.set(acctKey, r);
    });
    const importedList = [...byAccount.values()];
    const symbol = importedList[0].symbol;
    const existing = existingArray.find(row => matchFn(row, importedList[0]));
    if (existing) matched.push({ existing, symbol, importedList });
    else added.push({ symbol, importedList });
  });

  return { matched, added, duplicateKeys: [...new Set(duplicateKeys)] };
}

function applyEquityZerodhaPlan(plan) {
  const newInvestments = [];
  plan.matched.forEach(({ existing, importedList }) => {
    importedList.forEach(imported => {
      const totals = combineAccountTotals(existing, imported);
      existing.units = totals.totalQty;
      existing.invested = totals.totalInvested;
      if (imported.sector) existing.sector = imported.sector; // don't clobber with blank
    });
  });
  plan.added.forEach(({ symbol, importedList }) => {
    const row = { id: uid(), name: symbol, invested: 0, units: 0, ltp: 0, sector: "", livePricePending: true };
    importedList.forEach(imported => {
      const totals = combineAccountTotals(row, imported);
      row.units = totals.totalQty;
      row.invested = totals.totalInvested;
      if (imported.sector) row.sector = imported.sector;
    });
    state.equity.push(row);
    newInvestments.push({ name: symbol, type: "Equity" });
  });
  saveState();
  renderEquity();
  renderDashboard();
  return newInvestments;
}

function applyGoldZerodhaPlan(plan) {
  const newInvestments = [];
  plan.matched.forEach(({ existing, importedList }) => {
    importedList.forEach(imported => {
      const totals = combineAccountTotals(existing, imported);
      existing.weight = totals.totalQty;
      existing.invested = totals.totalInvested;
      existing.purchaseRate = totals.totalQty > 0 ? totals.totalInvested / totals.totalQty : existing.purchaseRate;
    });
  });
  plan.added.forEach(({ symbol, importedList }) => {
    const row = { id: uid(), name: symbol, form: "ETF", weight: 0, purchaseRate: importedList[0].avgPrice, invested: 0, currentRate: 0, notes: "", livePricePending: true };
    importedList.forEach(imported => {
      const totals = combineAccountTotals(row, imported);
      row.weight = totals.totalQty;
      row.invested = totals.totalInvested;
      row.purchaseRate = totals.totalQty > 0 ? totals.totalInvested / totals.totalQty : imported.avgPrice;
    });
    state.gold.push(row);
    newInvestments.push({ name: symbol, type: "Gold" });
  });
  saveState();
  renderGold();
  renderDashboard();
  return newInvestments;
}

function applyMFZerodhaPlan(plan) {
  const newInvestments = [];
  plan.matched.forEach(({ existing, importedList }) => {
    importedList.forEach(imported => {
      const totals = combineAccountTotals(existing, imported);
      existing.units = totals.totalQty;
      existing.invested = totals.totalInvested;
      if (imported.category) existing.category = imported.category; // don't clobber with blank
    });
  });
  plan.added.forEach(({ symbol, importedList }) => {
    const row = { id: uid(), name: symbol, symbol: "", category: "", invested: 0, units: 0, unitPrice: 0, remarks: "", livePricePending: true };
    importedList.forEach(imported => {
      const totals = combineAccountTotals(row, imported);
      row.units = totals.totalQty;
      row.invested = totals.totalInvested;
      if (imported.category) row.category = imported.category;
    });
    state.mf.push(row);
    newInvestments.push({ name: symbol, type: "Mutual Fund" });
  });
  saveState();
  renderMF();
  renderDashboard();
  return newInvestments;
}

const ZERODHA_TAB_CONFIG = {
  equity: { label: "Equity", statusElId: "equityFetchStatus", getExisting: () => state.equity, matchFn: (row, r) => (row.name || "").trim().toUpperCase() === r.symbol.toUpperCase(), apply: applyEquityZerodhaPlan },
  mf:     { label: "Mutual Funds", statusElId: "mfFetchStatus", getExisting: () => state.mf, matchFn: (row, r) => (row.name || "").trim().toUpperCase() === r.symbol.toUpperCase(), apply: applyMFZerodhaPlan },
  gold:   { label: "Gold", statusElId: "goldFetchStatus", getExisting: () => state.gold, matchFn: (row, r) => (row.name || "").trim().toUpperCase() === r.symbol.toUpperCase(), apply: applyGoldZerodhaPlan }
};

function showNewInvestmentsReminder(newInvestments) {
  if (newInvestments.length === 0) return;
  const rows = newInvestments.map(n => `<tr><td class="left">${escapeAttr(n.name)}</td><td class="left">${n.type}</td></tr>`).join("");
  openModal(
    "New Investments Added — Live Price Pending",
    `<p>These were imported successfully but don't have a Google Finance symbol configured yet in your Apps Script sheet, so their live price will show as "Pending" until you add them.</p>
     <div class="table-scroll-wrap"><table><thead><tr><th class="left">Investment Name</th><th class="left">Asset Type</th></tr></thead><tbody>${rows}</tbody></table></div>
     <p>Once you add the mapping in Apps Script, the existing automatic refresh will start picking up prices for these with no further changes needed here.</p>`,
    [{ label: "Got it", primary: true, onClick: closeModal }]
  );
}

// Builds one asset class's slice of the combined preview: match/add
// counts, how many holdings now span more than one Zerodha account,
// duplicate rows within this file, and rows needing attention
// (Symbol present but Quantity/Average Price unusable).
function buildImportGroup(assetKey, records, attention) {
  const cfg = ZERODHA_TAB_CONFIG[assetKey];
  const plan = planZerodhaImport(records, cfg.getExisting(), cfg.matchFn);
  // "Combined" = this holding's account map will span more than one
  // distinct Client ID once this import is applied — checked without
  // mutating state, so the preview can run before Confirm. Covers both
  // an existing row gaining another account (matched) and a brand-new
  // holding that already appears in more than one of the selected
  // files (added).
  const combinedNames = [
    ...plan.matched
      .filter(m => {
        const existingKeys = new Set(Object.keys(m.existing.zerodhaAccounts || {}));
        m.importedList.forEach(imp => existingKeys.add(imp.accountId || "default"));
        return existingKeys.size > 1;
      })
      .map(m => m.symbol),
    ...plan.added.filter(a => a.importedList.length > 1).map(a => a.symbol)
  ];
  return { assetKey, cfg, records, plan, attention, combinedNames };
}

function importGroupSummaryHTML(group) {
  const { cfg, plan, attention, combinedNames } = group;
  if (plan.matched.length === 0 && plan.added.length === 0 && attention.length === 0) return "";
  let html = `<h4>${escapeAttr(cfg.label)}</h4>`;
  html += `<div class="import-stat-row">
    <div class="import-stat"><div class="n">${plan.matched.length}</div><div class="l">Existing Updated</div></div>
    <div class="import-stat"><div class="n">${plan.added.length}</div><div class="l">New Added</div></div>
    <div class="import-stat"><div class="n">${combinedNames.length}</div><div class="l">Multi-Account Combined</div></div>
    <div class="import-stat ${(plan.duplicateKeys.length + attention.length) ? "warn" : ""}"><div class="n">${plan.duplicateKeys.length + attention.length}</div><div class="l">Needs Attention</div></div>
  </div>`;
  html += `<ul>`;
  if (plan.matched.length) html += `<li>Quantity and Average Price will be updated for: ${plan.matched.slice(0, 8).map(m => escapeAttr(m.symbol)).join(", ")}${plan.matched.length > 8 ? "…" : ""}</li>`;
  if (plan.added.length) html += `<li>New entries will be added for: ${plan.added.slice(0, 8).map(a => escapeAttr(a.symbol)).join(", ")}${plan.added.length > 8 ? "…" : ""}</li>`;
  if (combinedNames.length) html += `<li>Now combines more than one Zerodha account: ${combinedNames.slice(0, 8).map(escapeAttr).join(", ")}${combinedNames.length > 8 ? "…" : ""}</li>`;
  if (plan.duplicateKeys.length) html += `<li class="warn">Duplicate rows within this file (last occurrence used): ${plan.duplicateKeys.slice(0, 8).map(escapeAttr).join(", ")}</li>`;
  if (attention.length) html += `<li class="warn">Symbol present but Quantity/Average Price missing or unreadable — skipped: ${attention.slice(0, 8).map(escapeAttr).join(", ")}</li>`;
  html += `</ul>`;
  return html;
}

// Shows one combined preview across every non-empty asset-class
// group passed in, then applies all of them together on confirm —
// used so importing on the Equity tab (which also finds Gold-ETF
// rows on the same sheet) shows Equity and Gold changes in a single
// preview/confirm instead of two separate modals.
function runCombinedImportPreview(groups, extraNoteHTML) {
  const nonEmpty = groups.filter(g => g.plan.matched.length || g.plan.added.length || g.attention.length);
  if (nonEmpty.length === 0) {
    alert("No valid holdings found in that file/source — nothing to import.");
    return;
  }
  const title = "Import Zerodha Holdings — Preview";
  const html = (extraNoteHTML || "") + nonEmpty.map(importGroupSummaryHTML).join("");
  openModal(
    title,
    html,
    [
      { label: "Cancel", onClick: closeModal },
      {
        label: "Confirm Import", primary: true, onClick: () => {
          let allNew = [];
          nonEmpty.forEach(g => {
            const added = g.cfg.apply(g.plan);
            allNew = allNew.concat(added);
          });
          closeModal();
          showNewInvestmentsReminder(allNew);
        }
      }
    ]
  );
}

// Combines several parsed workbooks (one per selected file — each
// file is one Zerodha account's export) into a single record set per
// asset class, so the same Symbol/fund appearing in more than one
// file is matched and combined (see planZerodhaImport) instead of
// being treated as separate imports.
function mergeZerodhaParsedResults(parsedList) {
  const equity = [], gold = [], mf = [];
  const attentionEquity = [], attentionMF = [];
  const clientIds = [];
  parsedList.forEach(p => {
    equity.push(...p.equity);
    gold.push(...p.gold);
    mf.push(...p.mf);
    attentionEquity.push(...p.attention.equity);
    attentionMF.push(...p.attention.mf);
    if (p.clientId) clientIds.push(p.clientId);
  });
  return { clientIds, equity, gold, mf, attention: { equity: attentionEquity, mf: attentionMF } };
}

// Turns one merged parse result (from one or more files/accounts,
// however their bytes were obtained — local file input or a Drive
// Picker download) into preview groups covering all three asset
// classes at once, so a single combined Import Investments action
// always previews/applies Equity, Mutual Funds and Gold together.
function buildZerodhaImportGroups(parsed) {
  return [
    buildImportGroup("equity", parsed.equity, parsed.attention.equity),
    buildImportGroup("gold", parsed.gold, []),
    buildImportGroup("mf", parsed.mf, parsed.attention.mf)
  ];
}

// "Import Investments" (Settings) -> choose Local files or Google Drive.
function openImportChooser() {
  openModal(
    "Import Investments",
    `<p>Import from your Zerodha Console Holdings Statement (.xlsx) — Equity, Mutual Funds and Gold are all picked up from a single file in one step. Choose a source:</p>
     <p class="settings-note">You can select more than one file at once — one per Zerodha account. If the same stock or fund appears in more than one file, its quantity and invested amount are combined and the average price is recalculated automatically; nothing is duplicated. Gold ETF holdings (e.g. GOLDBEES) are automatically routed to the Gold tab.</p>`,
    [
      { label: "Import from Local Files", onClick: () => { closeModal(); document.getElementById("importInvestmentsFile").click(); } },
      { label: "Import from Google Drive", primary: true, onClick: () => { closeModal(); runDriveImportPicker(); } }
    ]
  );
}

// Local files: reads every selected file (each one a separate Zerodha
// account's Holdings Statement export), then merges them before
// building one combined Equity + Mutual Funds + Gold preview.
async function handleLocalZerodhaFiles(fileList) {
  const statusEl = document.getElementById("investmentsImportStatus");
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  if (statusEl) statusEl.textContent = `Reading ${files.length} file${files.length > 1 ? "s" : ""}...`;
  const parsedList = [];
  try {
    for (const file of files) {
      parsedList.push(await parseLocalZerodhaWorkbook(file));
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = "";
    alert("Could not read one of the selected files. Make sure each is an unmodified Zerodha Console Holdings Statement .xlsx export.");
    return;
  }
  if (statusEl) statusEl.textContent = "";
  const merged = mergeZerodhaParsedResults(parsedList);
  const sourceLabel = files.map(f => f.name).join(", ");
  const noteHTML = `<p class="settings-note">Source: ${files.length} local file${files.length > 1 ? "s" : ""} — ${escapeAttr(sourceLabel)}${merged.clientIds.length ? " — Client ID(s): " + escapeAttr(merged.clientIds.join(", ")) : ""}</p>`;
  runCombinedImportPreview(buildZerodhaImportGroups(merged), noteHTML);
}

document.getElementById("importInvestmentsFile").addEventListener("change", async (e) => {
  await handleLocalZerodhaFiles(e.target.files);
  e.target.value = "";
});

/* ---- Google Drive Picker: browse & pick the exact .xlsx file ----
   Replaces the old folder-scanning Holdings Apps Script for this
   button. Flow: lazy-load Google's API/Picker/Identity Services
   scripts on first use -> get a short-lived OAuth token scoped to
   just the file the person picks (drive.file, not broad Drive
   access) -> show the Picker filtered to Excel files -> download the
   chosen file's bytes from the Drive API -> hand those bytes to the
   exact same parseZerodhaWorkbookFromArrayBuffer() + preview/apply
   flow the local file upload uses. Needs a one-time Client ID + API
   Key from Settings (see the note there for how to create them in
   Google Cloud Console) — without those there's nothing to open, so
   this fails fast with a message pointing at Settings instead of a
   silent/broken picker. */

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load " + src + " (check your internet connection)."));
    document.head.appendChild(s);
  });
}

let gapiLoadPromise = null;
let gisLoadPromise = null;
let pickerLoadPromise = null;
let driveTokenClient = null;
let driveAccessToken = null;

function ensureGapiLoaded() {
  if (!gapiLoadPromise) gapiLoadPromise = loadScriptOnce("https://apis.google.com/js/api.js");
  return gapiLoadPromise;
}
function ensureGisLoaded() {
  if (!gisLoadPromise) gisLoadPromise = loadScriptOnce("https://accounts.google.com/gsi/client");
  return gisLoadPromise;
}
async function ensurePickerLoaded() {
  await ensureGapiLoaded();
  if (!pickerLoadPromise) {
    pickerLoadPromise = new Promise((resolve, reject) => {
      gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("Could not load the Google Picker library.")) });
    });
  }
  return pickerLoadPromise;
}

// Requests a Drive access token scoped to just files the person
// explicitly picks (drive.file) — no standing access to their whole
// Drive. Re-uses a token client across calls so re-importing later in
// the same session doesn't always force a fresh consent screen.
function requestDriveAccessToken() {
  return new Promise((resolve, reject) => {
    if (!driveTokenClient) {
      driveTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: state.googleDriveClientId,
        scope: "https://www.googleapis.com/auth/drive.file",
        callback: () => {} // overridden per-request just below
      });
    }
    driveTokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error(resp.error)); return; }
      driveAccessToken = resp.access_token;
      resolve(driveAccessToken);
    };
    driveTokenClient.requestAccessToken({ prompt: driveAccessToken ? "" : "consent" });
  });
}

// Shows the Drive file picker filtered to Excel files (multi-select
// enabled, so several account exports can be picked in one go) and
// resolves with the chosen files as an array of { id, name, mimeType
// }, or null if cancelled.
function openDrivePicker(accessToken, options) {
  const multiSelect = !options || options.multiSelect !== false;
  return new Promise((resolve) => {
    const view = new google.picker.DocsView()
      .setIncludeFolders(false)
      .setSelectFolderEnabled(false)
      .setMimeTypes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.google-apps.spreadsheet");
    const pickerBuilder = new google.picker.PickerBuilder()
      .setOAuthToken(accessToken)
      .setDeveloperKey(state.googleDriveApiKey);
    if (multiSelect) pickerBuilder.enableFeature(google.picker.Feature.MULTISELECT_ENABLED);
    const picker = pickerBuilder
      .addView(view)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          resolve(data.docs || []);
        } else if (data.action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

// Downloads the chosen file's bytes. A native Google Sheet (rather
// than an uploaded .xlsx) can't be downloaded via `alt=media`, so
// that case is exported to .xlsx format instead — either way the
// result is bytes SheetJS can read.
async function downloadDriveFileAsArrayBuffer(file, accessToken) {
  const isGoogleSheet = file.mimeType === "application/vnd.google-apps.spreadsheet";
  const url = isGoogleSheet
    ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}`
    : `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
  if (!res.ok) throw new Error(`Could not download "${file.name}" from Drive (HTTP ${res.status}).`);
  return res.arrayBuffer();
}

async function runDriveImportPicker() {
  const statusEl = document.getElementById("investmentsImportStatus");
  if (!state.googleDriveClientId || !state.googleDriveApiKey) {
    alert('Google Drive import needs a one-time setup: add a "Google Drive Client ID" and "Google Drive API Key" in Settings. See the note there for how to create them in Google Cloud Console.');
    return;
  }
  if (statusEl) statusEl.textContent = "Opening Google Drive...";
  let files, accessToken;
  try {
    await ensurePickerLoaded();
    await ensureGisLoaded();
    accessToken = await requestDriveAccessToken();
    files = await openDrivePicker(accessToken);
  } catch (err) {
    if (statusEl) statusEl.textContent = "";
    alert("Could not open Google Drive: " + (err && err.message ? err.message : "unknown error"));
    return;
  }
  if (!files || files.length === 0) { if (statusEl) statusEl.textContent = ""; return; } // person cancelled the picker

  const parsedList = [];
  try {
    for (const file of files) {
      if (statusEl) statusEl.textContent = `Downloading "${file.name}"...`;
      const arrayBuffer = await downloadDriveFileAsArrayBuffer(file, accessToken);
      if (statusEl) statusEl.textContent = `Reading "${file.name}"...`;
      parsedList.push(parseZerodhaWorkbookFromArrayBuffer(arrayBuffer));
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = "";
    alert(err && err.message ? err.message : "Could not read one of the selected files. Make sure each is an unmodified Zerodha Console Holdings Statement .xlsx export.");
    return;
  }
  if (statusEl) statusEl.textContent = "";
  const merged = mergeZerodhaParsedResults(parsedList);
  const sourceLabel = files.map(f => f.name).join(", ");
  const noteHTML = `<p class="settings-note">Source: Google Drive — ${escapeAttr(sourceLabel)}${merged.clientIds.length ? " — Client ID(s): " + escapeAttr(merged.clientIds.join(", ")) : ""}</p>`;
  runCombinedImportPreview(buildZerodhaImportGroups(merged), noteHTML);
}


/* ============================================================
   IMPORT — Trade Book (Zerodha Console Tradebook CSV exports)
   Separate from the Holdings import above: a Tradebook export is
   trade-level (every buy/sell, not a current-holdings snapshot) and
   has no Client ID column, so the person labels each file with an
   account name at import time instead. Parsed rows are stored in
   `tradeBook` (see the TRADE BOOK block near saveState() above) —
   never in `state`, never pushed to Firestore. Local files only for
   now; Drive-backed import is a later phase (per plan doc §3b).
   ============================================================ */

// Minimal CSV parser (quoted fields with embedded commas/escaped
// double-quotes handled) — sufficient for Zerodha Console's Tradebook
// export, which occasionally quotes Mutual Fund scheme names that
// contain commas. Blank trailing rows are dropped.
function parseCSVText(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\r') {
      // ignore — the paired \n (or end of file) closes the row
    } else if (c === '\n') {
      pushRow();
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) pushRow();
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ""));
}

// Composite dedup key: account (as labelled at import time) + exchange
// + segment + trade_id. trade_id alone isn't safely unique across
// exchanges/segments, and the file itself never carries an account
// identifier the way the Holdings Statement's "Client ID" row does.
function tradeKey(t) {
  return [t.accountId || "", t.exchange || "", t.segment || "", t.tradeId || ""].join("|");
}

// Zerodha Console "Tradebook" CSV columns: symbol, isin, trade_date,
// exchange, segment, series, trade_type, auction, quantity, price,
// trade_id, order_id, order_execution_time. Matched by header name
// (case-insensitive) rather than fixed position, same convention as
// the rest of the app's importers. Rows missing Symbol/Trade ID or a
// usable Quantity/Price are skipped and counted rather than crashing
// the whole import.
function parseTradeBookCSV(text, accountId) {
  const rows = parseCSVText(text);
  if (rows.length === 0) return { trades: [], skipped: 0 };
  const headers = rows[0].map(h => String(h || "").trim().toLowerCase());
  const idx = (name) => headers.indexOf(name);
  const iSymbol = idx("symbol"), iIsin = idx("isin"), iDate = idx("trade_date"),
    iExchange = idx("exchange"), iSegment = idx("segment"), iSeries = idx("series"),
    iType = idx("trade_type"), iAuction = idx("auction"), iQty = idx("quantity"),
    iPrice = idx("price"), iTradeId = idx("trade_id"), iOrderId = idx("order_id"),
    iExecTime = idx("order_execution_time");
  if (iSymbol === -1 || iTradeId === -1) return { trades: [], skipped: Math.max(0, rows.length - 1) };

  const trades = [];
  let skipped = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c => String(c ?? "").trim() === "")) continue;
    const symbol = String(row[iSymbol] ?? "").trim();
    const tradeId = String(row[iTradeId] ?? "").trim();
    const qty = parseFloat(row[iQty]);
    const price = parseFloat(row[iPrice]);
    if (!symbol || !tradeId || isNaN(qty) || isNaN(price)) { skipped++; continue; }
    const segment = iSegment !== -1 ? String(row[iSegment] ?? "").trim().toUpperCase() : "";
    trades.push({
      accountId,
      symbol,
      isin: iIsin !== -1 ? String(row[iIsin] ?? "").trim() : "",
      tradeDate: iDate !== -1 ? String(row[iDate] ?? "").trim() : "",
      exchange: iExchange !== -1 ? String(row[iExchange] ?? "").trim().toUpperCase() : "",
      segment,
      series: iSeries !== -1 ? String(row[iSeries] ?? "").trim() : "",
      tradeType: iType !== -1 ? String(row[iType] ?? "").trim().toLowerCase() : "",
      auction: iAuction !== -1 ? String(row[iAuction] ?? "").trim().toLowerCase() === "true" : false,
      quantity: qty,
      price: price,
      tradeId,
      orderId: iOrderId !== -1 ? String(row[iOrderId] ?? "").trim() : "",
      orderExecutionTime: iExecTime !== -1 ? String(row[iExecTime] ?? "").trim() : "",
      // Gold ETFs (e.g. GOLDBEES) live inside the Equity (EQ) segment
      // of the export, exactly like on the Holdings side — reuse the
      // same isGoldSymbol() routing rather than a second regex.
      assetClass: segment === "MF" ? "mf" : (isGoldSymbol(symbol) ? "gold" : "equity")
    });
  }
  return { trades, skipped };
}

// Builds the add/skip/conflict plan for one batch of newly-parsed
// trades against whatever's already stored. Mirrors the spirit of
// planZerodhaImport() above: a key repeated within THIS batch (same
// account, same trade_id — e.g. the same file picked twice) is a
// true duplicate and the later row wins; a key that already exists in
// `tradeBook.trades` with IDENTICAL data is a silent no-op re-import;
// a key that already exists with DIFFERENT data is a genuine conflict
// and is only ever flagged here, never auto-resolved — the person
// decides in the preview modal whether to overwrite it.
function planTradeBookImport(newTrades, existingTrades) {
  const byKey = new Map();
  const batchDuplicates = [];
  newTrades.forEach(t => {
    const k = tradeKey(t);
    if (byKey.has(k)) batchDuplicates.push(k);
    byKey.set(k, t);
  });

  const existingByKey = new Map(existingTrades.map(t => [tradeKey(t), t]));
  const toAdd = [], unchanged = [], conflicts = [];
  byKey.forEach((t, k) => {
    const existing = existingByKey.get(k);
    if (!existing) { toAdd.push(t); return; }
    const same = existing.symbol === t.symbol && existing.quantity === t.quantity &&
      existing.price === t.price && existing.tradeDate === t.tradeDate &&
      existing.tradeType === t.tradeType;
    if (same) unchanged.push(t); else conflicts.push({ key: k, existing, incoming: t });
  });

  return { toAdd, unchanged, conflicts, batchDuplicates: [...new Set(batchDuplicates)] };
}

function showTradeBookImportPreview(newTrades, sourceLabel, statusEl) {
  const plan = planTradeBookImport(newTrades, tradeBook.trades);
  const totalExisting = tradeBook.trades.length;

  const conflictRows = plan.conflicts.slice(0, 10).map(c => `
    <tr>
      <td class="left">${escapeAttr(c.incoming.symbol)}</td>
      <td class="left">${escapeAttr(c.incoming.tradeId)}</td>
      <td class="left">${escapeAttr(c.existing.quantity + " @ " + c.existing.price)}</td>
      <td class="left">${escapeAttr(c.incoming.quantity + " @ " + c.incoming.price)}</td>
    </tr>`).join("");

  const html = `
    <div class="import-stat-row">
      <div class="import-stat"><div class="n">${totalExisting}</div><div class="l">Trades On File</div></div>
      <div class="import-stat"><div class="n">${newTrades.length}</div><div class="l">Trades In File(s)</div></div>
      <div class="import-stat"><div class="n">${plan.toAdd.length}</div><div class="l">New Trades To Add</div></div>
      <div class="import-stat"><div class="n">${plan.unchanged.length}</div><div class="l">Already Imported</div></div>
      <div class="import-stat ${plan.conflicts.length ? "warn" : ""}"><div class="n">${plan.conflicts.length}</div><div class="l">Conflicting Duplicates</div></div>
    </div>
    <p>Trade book data is stored only in this browser (never synced to the cloud) and is used by the Dashboard's Portfolio performance chart — it doesn't change your Equity, Mutual Funds or Gold holdings above.</p>
    ${plan.batchDuplicates.length ? `<p class="settings-note">${plan.batchDuplicates.length} repeated trade_id${plan.batchDuplicates.length === 1 ? "" : "s"} within the selected file(s) themselves — the later row won for each.</p>` : ""}
    ${plan.conflicts.length ? `
      <h4>Conflicting duplicates <span class="hint">same account + exchange + segment + trade ID, different data</span></h4>
      <div class="table-scroll-wrap">
        <table>
          <thead><tr><th class="left">Symbol</th><th class="left">Trade ID</th><th class="left">Stored (Qty @ Price)</th><th class="left">Incoming (Qty @ Price)</th></tr></thead>
          <tbody>${conflictRows}</tbody>
        </table>
      </div>
      ${plan.conflicts.length > 10 ? `<p class="settings-note">…and ${plan.conflicts.length - 10} more.</p>` : ""}
      <div class="settings-field">
        <label style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" id="tbOverwriteConflicts" style="width:auto;">
          Overwrite these ${plan.conflicts.length} conflicting ${plan.conflicts.length === 1 ? "entry" : "entries"} with the incoming data
        </label>
      </div>
    ` : ""}
  `;

  openModal(
    `Import Trade Book from ${escapeAttr(sourceLabel)} — Preview`,
    html,
    [
      { label: "Cancel", onClick: () => { closeModal(); if (statusEl) statusEl.textContent = ""; } },
      {
        label: `Add ${plan.toAdd.length} Trade${plan.toAdd.length === 1 ? "" : "s"}`, primary: true, onClick: () => {
          plan.toAdd.forEach(t => tradeBook.trades.push(t));
          const overwriteEl = document.getElementById("tbOverwriteConflicts");
          const overwrite = plan.conflicts.length > 0 && overwriteEl && overwriteEl.checked;
          if (overwrite) {
            plan.conflicts.forEach(c => {
              const i = tradeBook.trades.findIndex(t => tradeKey(t) === c.key);
              if (i !== -1) tradeBook.trades[i] = c.incoming; else tradeBook.trades.push(c.incoming);
            });
          }
          tradeBook.imports.push({
            id: uid(), fileName: sourceLabel, importedAt: new Date().toISOString(),
            tradeCount: newTrades.length, added: plan.toAdd.length,
            conflicts: plan.conflicts.length, overwritten: overwrite ? plan.conflicts.length : 0
          });
          saveTradeBook();
          renderDashboard(); // picks up the new/changed trade count for the Portfolio performance chart
          closeModal();
          if (statusEl) {
            statusEl.textContent = `Added ${plan.toAdd.length} new trade${plan.toAdd.length === 1 ? "" : "s"}` +
              (overwrite ? `, overwrote ${plan.conflicts.length}.` : (plan.conflicts.length ? ` — ${plan.conflicts.length} conflicting duplicate${plan.conflicts.length === 1 ? "" : "s"} left as-is.` : "."));
          }
        }
      }
    ]
  );
}

// Remembers the account label typed for each filename within this
// browser tab's session only (not persisted) — just a convenience so
// re-importing the same account's updated export doesn't require
// re-typing the label.
let lastTradeBookAccountLabels = {};

function openTradeBookAccountLabelModal(files) {
  const rows = files.map((f, i) => `
    <div class="settings-field">
      <label for="tbAccountLabel${i}">${escapeAttr(f.name)}</label>
      <input type="text" id="tbAccountLabel${i}" placeholder="e.g. Zerodha - Primary" value="${escapeAttr(lastTradeBookAccountLabels[f.name] || "")}">
    </div>`).join("");
  openModal(
    "Label each file with an account",
    `<p>A Tradebook export doesn't carry an account/Client ID the way the Holdings Statement does — give each file a short account label so trades from your different demat accounts can be told apart and deduplicated correctly. Using the same label on two files is correct when they really are the same account.</p>${rows}`,
    [
      { label: "Cancel", onClick: closeModal },
      {
        label: "Continue", primary: true, onClick: async () => {
          const labels = files.map((f, i) => {
            const el = document.getElementById(`tbAccountLabel${i}`);
            const v = (el && el.value || "").trim() || f.name;
            lastTradeBookAccountLabels[f.name] = v;
            return v;
          });
          closeModal();
          await processTradeBookFiles(files, labels);
        }
      }
    ]
  );
}

async function processTradeBookFiles(files, labels) {
  const statusEl = document.getElementById("tradeBookImportStatus");
  if (statusEl) statusEl.textContent = `Reading ${files.length} file${files.length > 1 ? "s" : ""}...`;
  let allTrades = [];
  let totalSkipped = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const text = await files[i].text();
      const { trades, skipped } = parseTradeBookCSV(text, labels[i]);
      allTrades = allTrades.concat(trades);
      totalSkipped += skipped;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = "";
    alert("Could not read one of the selected files. Make sure each is an unmodified Zerodha Console Tradebook .csv export.");
    return;
  }
  if (statusEl) statusEl.textContent = "";
  if (allTrades.length === 0) {
    alert("No valid trade rows found in the selected file(s). Expected columns: symbol, isin, trade_date, exchange, segment, series, trade_type, auction, quantity, price, trade_id, order_id, order_execution_time.");
    return;
  }
  const sourceLabel = files.map(f => f.name).join(", ");
  showTradeBookImportPreview(allTrades, sourceLabel, statusEl);
  if (totalSkipped > 0) {
    console.warn(`Trade Book import: ${totalSkipped} row(s) skipped (missing Symbol/Trade ID/Quantity/Price).`);
  }
}

function openTradeBookImportChooser() {
  openModal(
    "Import Trade Book",
    `<p>Import Zerodha Console Tradebook CSV exports — trade-level history (every buy/sell) used by the Dashboard's Portfolio performance chart. Equity, Mutual Fund and Gold ETF trades (e.g. GOLDBEES) are all detected automatically; you can select several files at once.</p>
     <p class="settings-note">This is stored only in this browser (not synced to the cloud) and is separate from your Equity/Mutual Funds/Gold holdings — importing it never changes those tabs.</p>`,
    [
      { label: "Cancel", onClick: closeModal },
      { label: "Choose Files", primary: true, onClick: () => { closeModal(); document.getElementById("importTradeBookFile").click(); } }
    ]
  );
}

document.getElementById("importTradeBookFile").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  if (files.length === 0) return;
  openTradeBookAccountLabelModal(files);
});


/* ============================================================
   EXPORT / IMPORT (full JSON backup)
   ============================================================ */

function downloadBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `networth-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Called from the Settings modal's "Export JSON" button.
function runJsonExport() {
  downloadBackup();
  state.lastBackup = new Date().toISOString();
  saveState();
}

document.getElementById("importFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      state = mergeIntoState(parsed);
      saveState();
      renderAll();
    } catch (err) {
      alert("Could not read that file — make sure it's a JSON backup exported from this app.");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

/* ============================================================
   DEMO DATA
   Loads a fully synthetic ~₹2 crore sample portfolio so the app
   can be shown/previewed without exposing any real holdings.
   Every name is clearly labelled "Demo ...", and dates are
   computed relative to today (rather than hardcoded) so Debt's
   maturity highlighting still demonstrates correctly whenever
   this is run. Numbers are hand-picked to land on a clean
   ₹2,00,00,000 net worth split roughly along the app's own
   default ideal allocation (5/30/30/25/10).

   This REPLACES whatever is currently in the tracker, so if
   there's real data present it's backed up (silent JSON
   download, same file downloadBackup() already produces)
   before being overwritten — same safety-first pattern used
   elsewhere in the app (weekly auto-backup, cloud conflict
   resolution).
   ============================================================ */

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function demoDateMonths(offsetMonths) {
  const d = new Date();
  d.setMonth(d.getMonth() + offsetMonths);
  return isoDate(d);
}
function demoDateDays(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return isoDate(d);
}

function buildDemoState() {
  return {
    cash: 1000000, // ₹10,00,000
    equity: [
      { id: uid(), name: "Demo Tech Ltd", invested: 1000000, units: 2000, ltp: 650, sector: "IT" },
      { id: uid(), name: "Demo Bank Corp", invested: 800000, units: 4000, ltp: 250, sector: "Banking" },
      { id: uid(), name: "Demo Pharma Inc", invested: 900000, units: 3000, ltp: 400, sector: "Pharma" },
      { id: uid(), name: "Demo Energy Co", invested: 700000, units: 1000, ltp: 900, sector: "Energy" },
      { id: uid(), name: "Demo Auto Motors", invested: 800000, units: 1500, ltp: 400, sector: "Auto" }
    ], // ₹42,00,000 invested -> ₹50,00,000 current
    mf: [
      { id: uid(), name: "Demo Bluechip Growth Fund", symbol: "", category: "Large Cap", invested: 1500000, units: 10000, unitPrice: 170, remarks: "Demo data" },
      { id: uid(), name: "Demo Flexicap Fund", symbol: "", category: "Flexi Cap", invested: 1400000, units: 8000, unitPrice: 200, remarks: "Demo data" },
      { id: uid(), name: "Demo Midcap Opportunities Fund", symbol: "", category: "Mid Cap", invested: 1300000, units: 6000, unitPrice: 250, remarks: "Demo data" },
      { id: uid(), name: "Demo Hybrid Balanced Fund", symbol: "", category: "Hybrid", invested: 1000000, units: 4000, unitPrice: 300, remarks: "Demo data" }
    ], // ₹52,00,000 invested -> ₹60,00,000 current
    debt: [
      { id: uid(), name: "Demo Fixed Deposit - Bank A", category: "Fixed Deposit", subcategory: "Bank FD", account: "DEMO-FD-001", invested: 2000000, roi: 7.1, maturityAmount: 2142000, investedDate: demoDateMonths(-12), maturityDate: demoDateDays(5), tenureMonths: 12, notes: "Demo data" },
      { id: uid(), name: "Demo Corporate Bond", category: "Bond", subcategory: "Corporate Bond", account: "DEMO-BOND-002", invested: 1500000, roi: 8.5, maturityAmount: 1750000, investedDate: demoDateMonths(-6), maturityDate: demoDateMonths(18), tenureMonths: 24, notes: "Demo data" },
      { id: uid(), name: "Demo Public Provident Fund", category: "PPF", subcategory: "Govt Scheme", account: "DEMO-PPF-003", invested: 1500000, roi: 7.1, maturityAmount: 2900000, investedDate: demoDateMonths(-24), maturityDate: demoDateMonths(156), tenureMonths: 180, notes: "Demo data" },
      { id: uid(), name: "Demo National Savings Certificate", category: "NSC", subcategory: "Govt Scheme", account: "DEMO-NSC-004", invested: 1000000, roi: 7.7, maturityAmount: 1385000, investedDate: demoDateMonths(-65), maturityDate: demoDateDays(-10), tenureMonths: 60, notes: "Demo data" }
    ], // ₹60,00,000 invested (Debt is valued at invested amount on the dashboard)
    gold: [
      { id: uid(), name: "Demo Gold ETF", form: "ETF", weight: 1500, purchaseRate: 700, invested: 1050000, currentRate: 800, notes: "Demo data" },
      { id: uid(), name: "Demo Sovereign Gold Bond", form: "SGB", weight: 130, purchaseRate: 5000, invested: 650000, currentRate: 6153.85, notes: "Demo data" }
    ] // ₹17,00,000 invested -> ₹20,00,000 current
  };
  // Totals: Cash 10L + Debt 60L + MF 60L (current) + Equity 50L (current) + Gold 20L (current) = ₹2,00,00,000
}

// Snapshotting the real data for demo mode uses a second localStorage
// key rather than a JSON file download — no export, nothing leaves
// the browser. DEMO_ACTIVE_KEY just marks "currently in demo mode" so
// the topbar knows whether to show "Demo Data" or "Exit Demo Data";
// DEMO_BACKUP_KEY holds the actual pre-demo state and is only written
// when there was real data worth restoring.
const DEMO_ACTIVE_KEY = "ledger_demo_active_v1";
const DEMO_BACKUP_KEY = "ledger_data_pre_demo_v1";

function isDemoActive() {
  return localStorage.getItem(DEMO_ACTIVE_KEY) === "1";
}

function updateDemoButtons() {
  const loadBtn = document.getElementById("btnLoadDemo");
  const exitBtn = document.getElementById("btnExitDemo");
  if (!loadBtn || !exitBtn) return;
  const active = isDemoActive();
  loadBtn.style.display = active ? "none" : "";
  exitBtn.style.display = active ? "" : "none";
}

function openDemoDataModal() {
  const hasReal = !isStateEmpty(state);
  const existingCounts = (state.equity?.length || 0) + (state.debt?.length || 0) + (state.mf?.length || 0) + (state.gold?.length || 0);
  const html = `
    <div class="import-stat-row">
      <div class="import-stat"><div class="n">${existingCounts}</div><div class="l">Current Entries</div></div>
      <div class="import-stat"><div class="n">15</div><div class="l">Demo Entries</div></div>
      <div class="import-stat"><div class="n">${fmtINR(20000000)}</div><div class="l">Demo Net Worth</div></div>
    </div>
    <p>This loads a fully synthetic sample portfolio (5 stocks, 4 mutual funds, 4 debt entries, 2 gold holdings, plus cash) totalling around ${fmtINR(20000000)}, split roughly across the app's own default ideal allocation. Every entry is clearly named "Demo ..." — none of it is your real data.</p>
    ${hasReal
      ? `<p class="settings-note">You currently have ${existingCounts} real ${existingCounts === 1 ? "entry" : "entries"} plus cash/settings. Clicking Confirm saves that data locally in this browser (no file is downloaded) and swaps in the demo portfolio. Use the "Exit Demo Data" button that appears in the topbar to bring your real data straight back.</p>`
      : `<p class="settings-note">Your tracker is currently empty, so nothing will be lost.</p>`}
  `;
  openModal(
    "Load Demo Data",
    html,
    [
      { label: "Cancel", onClick: closeModal },
      {
        label: "Load Demo Data", primary: true, onClick: () => {
          if (hasReal) {
            localStorage.setItem(DEMO_BACKUP_KEY, JSON.stringify(state));
          } else {
            localStorage.removeItem(DEMO_BACKUP_KEY);
          }
          localStorage.setItem(DEMO_ACTIVE_KEY, "1");
          const demo = buildDemoState();
          const keepSettings = { ownerName: state.ownerName, priceApiUrl: state.priceApiUrl, holdingsApiUrl: state.holdingsApiUrl, googleDriveClientId: state.googleDriveClientId, googleDriveApiKey: state.googleDriveApiKey };
          state = { ...blankState(), ...demo, ...keepSettings, portfolioLocked: false };
          saveState();
          renderAll();
          updateDemoButtons();
          closeModal();
          const tag = document.getElementById("lastUpdatedTag");
          if (tag) tag.textContent = "Demo data loaded" + (hasReal ? " — click \"Exit Demo Data\" anytime to restore your real data" : "");
        }
      }
    ]
  );
}

document.getElementById("btnLoadDemo").addEventListener("click", openDemoDataModal);

// Exit Demo Data: restores whatever was snapshotted to DEMO_BACKUP_KEY
// right before entering demo mode, or — if there was nothing real to
// restore (tracker was empty) — just clears back to a blank tracker.
// Either way both localStorage keys are cleaned up afterwards.
document.getElementById("btnExitDemo").addEventListener("click", () => {
  const backupRaw = localStorage.getItem(DEMO_BACKUP_KEY);
  const ok = confirm(
    backupRaw
      ? "Exit demo mode and restore your real data from before you loaded the demo?"
      : "Exit demo mode? Your tracker was empty before the demo, so this just clears the demo data."
  );
  if (!ok) return;
  if (backupRaw) {
    try {
      const restored = JSON.parse(backupRaw);
      state = mergeIntoState(restored);
    } catch (e) {
      alert("Could not read your saved pre-demo data — it may have been cleared from this browser. Starting from a blank tracker instead.");
      state = blankState();
    }
  } else {
    state = blankState();
  }
  localStorage.removeItem(DEMO_ACTIVE_KEY);
  localStorage.removeItem(DEMO_BACKUP_KEY);
  saveState();
  renderAll();
  updateDemoButtons();
  const tag = document.getElementById("lastUpdatedTag");
  if (tag) tag.textContent = backupRaw ? "Your real data has been restored" : "Demo data cleared";
});

/* ============================================================
   EXCEL EXPORT — full backup as a readable .xlsx workbook
   A parallel option to the JSON backup above: if a JSON file is
   ever hard to make sense of by eye, this gives every tab's data
   in a normal spreadsheet, plus a Dashboard Summary and Settings
   sheet, all computed the same way the app itself displays them.
   ============================================================ */

function buildExcelWorkbook() {
  const wb = XLSX.utils.book_new();

  const eq = equityTotals(), debt = debtTotals(), mf = mfTotals(), gold = goldTotals();
  const cash = Number(state.cash) || 0;
  const netWorth = cash + debt.invested + mf.current + eq.current + gold.current;

  // Dashboard Summary
  const summaryRows = [
    ["Ganesh's Net Worth & Allocation Tracker — Summary"],
    ["Exported", new Date().toLocaleString()],
    [],
    ["Asset Class", "Current Value", "Invested Amount", "P&L", "Ideal %"],
    ["Cash", cash, cash, 0, state.ideal.cash],
    ["Debt / Fixed Income", debt.invested, debt.invested, debt.profit, state.ideal.debt],
    ["Equity Mutual Funds", mf.current, mf.invested, mf.pl, state.ideal.mf],
    ["Equity Stocks", eq.current, eq.invested, eq.pl, state.ideal.equity],
    ["Gold", gold.current, gold.invested, gold.pl, state.ideal.gold],
    [],
    ["Net Worth", netWorth]
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary["!cols"] = [{ wch: 26 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, "Dashboard Summary");

  // Stock Holdings
  const eqRows = [["Name/Symbol", "Invested Amount", "Units", "Avg Price", "LTP", "Current Value", "P&L", "P&L %", "Alloc %", "Sector"]];
  state.equity.forEach(r => {
    const d = equityDerived(r);
    const allocPct = eq.invested > 0 ? (Number(r.invested) / eq.invested) * 100 : 0;
    eqRows.push([r.name, r.invested, r.units, d.avgPrice, r.ltp, d.currentValue, d.pl, d.plPct, allocPct, r.sector]);
  });
  const wsEq = XLSX.utils.aoa_to_sheet(eqRows);
  wsEq["!cols"] = [{ wch: 20 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsEq, "Stock Holdings");

  // Mutual Funds
  const mfRows = [["Name", "Symbol", "Category", "Invested Amount", "Units", "Avg Price", "NAV", "Current Value", "P&L", "P&L %", "Remarks"]];
  state.mf.forEach(r => {
    const d = mfDerived(r);
    mfRows.push([r.name, r.symbol, r.category, r.invested, r.units, d.avgPrice, r.unitPrice, d.currentValue, d.pl, d.plPct, r.remarks]);
  });
  const wsMF = XLSX.utils.aoa_to_sheet(mfRows);
  wsMF["!cols"] = [{ wch: 28 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, wsMF, "Mutual Funds");

  // Gold
  const goldRows = [["Name/Symbol", "Form", "Weight/Units", "Purchase Rate", "Invested Amount", "Current Rate", "Current Value", "P&L", "P&L %", "Notes"]];
  state.gold.forEach(r => {
    const d = goldDerived(r);
    goldRows.push([r.name, r.form, r.weight, r.purchaseRate, r.invested, r.currentRate, d.currentValue, d.pl, d.plPct, r.notes]);
  });
  const wsGold = XLSX.utils.aoa_to_sheet(goldRows);
  wsGold["!cols"] = [{ wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, wsGold, "Gold");

  // Debt
  const debtRows = [["Name", "Category", "Sub-category", "Account No.", "Invested Amount", "ROI %", "Maturity Amount", "Profit", "Invested Date", "Maturity Date", "Tenure (Months)", "Tenure (Years)", "Notes"]];
  state.debt.forEach(r => {
    const d = debtDerived(r);
    debtRows.push([r.name, r.category, r.subcategory, r.account, r.invested, r.roi, r.maturityAmount, d.profit, r.investedDate, r.maturityDate, r.tenureMonths, d.years, r.notes]);
  });
  const wsDebt = XLSX.utils.aoa_to_sheet(debtRows);
  wsDebt["!cols"] = [{ wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, wsDebt, "Debt");

  // Settings
  const settingsRows = [
    ["Setting", "Value"],
    ["Cash on hand", state.cash],
    ["Ideal % - Cash", state.ideal.cash],
    ["Ideal % - Debt", state.ideal.debt],
    ["Ideal % - Mutual Funds", state.ideal.mf],
    ["Ideal % - Equity", state.ideal.equity],
    ["Ideal % - Gold", state.ideal.gold],
    ["Portfolio Locked", state.portfolioLocked ? "Yes" : "No"],
    ["Last Saved", state.lastSaved],
    ["Last Backup", state.lastBackup]
  ];
  const wsSettings = XLSX.utils.aoa_to_sheet(settingsRows);
  wsSettings["!cols"] = [{ wch: 24 }, { wch: 26 }];
  XLSX.utils.book_append_sheet(wb, wsSettings, "Settings");

  return wb;
}

// Called from the Settings modal's "Export Excel" button.
function runExcelExport() {
  try {
    const wb = buildExcelWorkbook();
    XLSX.writeFile(wb, `networth-backup-${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) {
    console.error("Excel export failed:", e);
    alert("Could not build the Excel export: " + (e && e.message ? e.message : "unknown error"));
  }
}

/* ============================================================
   WEEKLY AUTO-BACKUP
   A static page can't run anything while it's closed, so this
   can only check "has it been a while?" at the moment the app
   is actually opened — not on a true unattended schedule. If
   it's Sunday, or 7+ days have passed since the last backup,
   a JSON download triggers automatically on load.
   ============================================================ */

function maybeRunWeeklyBackup() {
  const hasData = state.equity.length || state.debt.length || state.mf.length || state.gold.length || state.cash;
  if (!hasData) return;
  const now = new Date();
  const isSunday = now.getDay() === 0;
  const daysSinceLastBackup = state.lastBackup
    ? (now - new Date(state.lastBackup)) / (1000 * 60 * 60 * 24)
    : Infinity;
  const due = isSunday || daysSinceLastBackup >= 7;
  if (!due) return;
  // Avoid re-triggering multiple times on the same day if the
  // page is reloaded repeatedly.
  const today = now.toDateString();
  if (state.lastBackup && new Date(state.lastBackup).toDateString() === today) return;
  downloadBackup();
  state.lastBackup = now.toISOString();
  saveState();
}

/* ============================================================
   CLOUD SYNC — Firebase Auth (Google Sign-In) + Firestore
   Firestore (portfolios/{uid}, one doc holding every tab's data —
   Equity, Debt, Mutual Funds, Gold, settings, everything in
   `state`) is the single source of truth once signed in.
   localStorage is kept ONLY as a read-only cache so the app still
   has something to display while offline — it is never diffed
   against Firestore and never treated as a thing that needs
   "syncing up" later.

   Sync rules, all gated on navigator.onLine:
     - Sign-in (or coming back online while signed in): fetch the
       Firestore doc. If it exists, it wins outright — local state
       is replaced with it, no comparison, no merge prompt. If it
       doesn't exist yet, whatever's currently loaded is pushed up
       to create it.
     - Every edit (saveState -> scheduleCloudPush): pushed straight
       to Firestore, but ONLY while navigator.onLine is true.
     - Going offline: Firestore's network connection is explicitly
       cut (fbDb.disableNetwork()) so nothing gets queued locally to
       replay later — offline truly means "no cloud writes happen",
       not "writes happen once we reconnect".
     - While offline, isReadOnly() already makes every editable
       field read-only app-wide, so there is nothing to push once
       back online beyond what's already in Firestore.
   ============================================================ */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDhaP5WPnVHD5PXTg3O6wJeJOlG51NJ6xI",
  authDomain: "networth-tracker-f101b.firebaseapp.com",
  projectId: "networth-tracker-f101b",
  storageBucket: "networth-tracker-f101b.firebasestorage.app",
  messagingSenderId: "638244383857",
  appId: "1:638244383857:web:84431ad971b2fee7e47fd0"
};

let fbAuth = null;
let fbDb = null;
let cloudUser = null;
let cloudSyncTimer = null;

// Safety-net snapshot taken immediately before any cloud-fetched data
// is allowed to overwrite `state` — completely separate from the
// Demo Data backup key. This is what makes a bad sync (e.g. an empty
// or stale cloud document) recoverable from Settings -> "Restore
// Pre-Sync Backup" instead of being an unrecoverable data-loss event.
// Deliberately NOT wiped/rotated automatically — it always holds
// whatever `state` looked like right before the most recent cloud
// overwrite, so it stays useful even if the person doesn't notice a
// problem until later.
const PRE_CLOUD_SYNC_BACKUP_KEY = "ledger_pre_cloud_sync_backup_v1";

function savePreCloudSyncBackup() {
  try {
    localStorage.setItem(PRE_CLOUD_SYNC_BACKUP_KEY, JSON.stringify({ state, savedAt: new Date().toISOString() }));
  } catch (e) {
    console.error("Could not save pre-cloud-sync backup:", e);
  }
}

function getPreCloudSyncBackup() {
  try {
    const raw = localStorage.getItem(PRE_CLOUD_SYNC_BACKUP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// Still useful for the "is there anything worth pushing yet" check
// when a brand-new sign-in finds no Firestore doc at all.
function isStateEmpty(s) {
  return !s.cash &&
    (!s.equity || s.equity.length === 0) &&
    (!s.debt || s.debt.length === 0) &&
    (!s.mf || s.mf.length === 0) &&
    (!s.gold || s.gold.length === 0);
}

function updateCloudSyncUI(statusOverride) {
  const btn = document.getElementById("btnCloudSync");
  if (!btn) return;
  if (cloudUser) {
    btn.textContent = "☁️ " + (statusOverride || cloudUser.email || "Synced");
    btn.classList.add("synced");
    btn.title = "Signed in as " + (cloudUser.email || cloudUser.uid) + " — data syncs automatically. Click to sign out.";
  } else {
    btn.textContent = statusOverride ? "☁️ " + statusOverride : "☁️ Sign in with Google";
    btn.classList.remove("synced");
    btn.title = "Sign in to sync your data across devices via Firestore.";
  }
}

// The one and only place that writes to Firestore. Refuses to run
// unless the browser is actually online — offline never queues a
// write for later, it just doesn't happen.
async function pushStateToCloud() {
  if (!cloudUser || !fbDb || !navigator.onLine) return;
  try {
    await fbDb.collection("portfolios").doc(cloudUser.uid).set(state);
  } catch (e) {
    console.error("Cloud push failed:", e);
    updateCloudSyncUI("Sync failed");
  }
}

// Called from saveState() on every local change; debounced so a
// burst of edits (e.g. typing) doesn't fire a write per keystroke.
// No-ops entirely while offline (see pushStateToCloud/isReadOnly —
// editing is already disabled app-wide while offline anyway).
function scheduleCloudPush() {
  if (!cloudUser || !navigator.onLine) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(pushStateToCloud, 2000);
}

// Fetches the Firestore doc and treats it as authoritative — no
// comparison against local/cached data, no merge prompt. Only runs
// while online; called on sign-in and again whenever the browser
// comes back online while already signed in.
async function resolveCloudSync() {
  if (!cloudUser || !fbDb || !navigator.onLine) return;
  updateCloudSyncUI("Syncing…");
  try {
    const snap = await fbDb.collection("portfolios").doc(cloudUser.uid).get({ source: "server" });
    if (snap.exists) {
      const cloud = snap.data();
      // Guard against exactly what caused a real data-loss incident:
      // an empty (or effectively empty) Firestore document — e.g. from
      // an earlier sign-in before any real data existed — silently
      // overwriting a device that actually has real holdings on it.
      // The cloud doc existing is no longer treated as automatically
      // authoritative; it only wins outright when it actually has data,
      // or when local has nothing to lose anyway.
      if (isStateEmpty(cloud) && !isStateEmpty(state)) {
        savePreCloudSyncBackup();
        updateCloudSyncUI("Sync paused");
        openCloudConflictModal(cloud);
        return;
      }
      // Snapshot whatever's currently loaded BEFORE it's replaced —
      // this is the one-click-recoverable safety net (Settings ->
      // "Restore Pre-Sync Backup") for every other overwrite case,
      // not just the empty-doc one caught above.
      savePreCloudSyncBackup();
      state = mergeIntoState(cloud);
      state.lastSaved = new Date().toISOString();
      // Refresh the offline-viewing cache only — this does NOT
      // trigger another push back up to Firestore.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      renderAll();
    } else if (!isStateEmpty(state)) {
      // Nothing in Firestore yet for this account — seed it from
      // whatever's currently loaded (e.g. the local offline cache).
      await pushStateToCloud();
    }
    updateCloudSyncUI();
  } catch (e) {
    console.error("Cloud sync failed:", e);
    updateCloudSyncUI("Sync error");
  }
}

// Shown only in the specific conflict case above: an empty cloud
// document was fetched while this device actually has real data.
// Pauses automatic resolution and asks explicitly which side should
// win, rather than ever guessing. A pre-cloud-sync backup has already
// been saved by the time this opens, so either choice here is safe to
// reverse afterwards via Settings -> "Restore Pre-Sync Backup".
function openCloudConflictModal(cloudData) {
  const html = `
    <p>Your Google account's cloud data is empty, but this device currently has real portfolio data. To avoid accidentally erasing it, cloud sync has been paused — nothing has been changed yet.</p>
    <p>Which should be kept?</p>
    <p class="settings-note">"Keep This Device's Data" pushes what's currently loaded here up to the cloud, replacing the empty cloud document. "Use Cloud Data" replaces what's on this device with the (empty) cloud document — only choose this if you're sure this device's data is stale or test data. A backup of this device's current data has already been saved locally either way (Settings → Restore Pre-Sync Backup).</p>
  `;
  openModal("Cloud Sync — Data Conflict", html, [
    {
      label: "Use Cloud Data", onClick: async () => {
        state = mergeIntoState(cloudData);
        state.lastSaved = new Date().toISOString();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        renderAll();
        updateCloudSyncUI();
        closeModal();
      }
    },
    {
      label: "Keep This Device's Data", primary: true, onClick: async () => {
        updateCloudSyncUI("Syncing…");
        await pushStateToCloud();
        updateCloudSyncUI();
        closeModal();
      }
    }
  ]);
}

document.getElementById("btnCloudSync").addEventListener("click", async () => {
  if (!fbAuth) {
    alert("Cloud sync isn't available right now — the Firebase SDK didn't load (check your internet connection).");
    return;
  }
  if (cloudUser) {
    const ok = confirm("Sign out of cloud sync? Your data stays on this device but will stop syncing to other devices.");
    if (ok) await fbAuth.signOut();
    return;
  }
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await fbAuth.signInWithPopup(provider);
  } catch (e) {
    console.error("Sign-in failed:", e);
    alert(
      "Sign-in failed: " + (e && e.message ? e.message : "unknown error") +
      "\n\nIf this is the first time, make sure in the Firebase console: Google sign-in is enabled " +
      "(Authentication → Sign-in method), and this site's domain is added under Authentication → Settings → Authorized domains."
    );
  }
});

function initCloudSync() {
  if (typeof firebase === "undefined") {
    console.warn("Firebase SDK not loaded — cloud sync disabled for this session.");
    return;
  }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
    fbAuth.onAuthStateChanged(async (user) => {
      cloudUser = user;
      updateCloudSyncUI();
      if (user && navigator.onLine) await resolveCloudSync();
    });
  } catch (e) {
    console.error("Firebase init failed:", e);
  }
}

/* ============================================================
   INIT
   ============================================================ */

function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Updates the header title and the browser tab title from
// state.ownerName — called once at startup and again after Settings
// is saved.
function renderBrand() {
  const name = state.ownerName || "Ganesh";
  const markEl = document.querySelector(".brand .mark");
  if (markEl) markEl.innerHTML = `${escapeAttr(name)}<span>'s</span> Net Worth &amp; Allocation Tracker`;
  document.title = `${name}'s Net Worth & Allocation Tracker`;
}

/* ============================================================
   SETTINGS MODAL
   Holds things that used to be scattered in the topbar (Export
   Excel/JSON, Import JSON) plus two things that were previously
   hardcoded in app.js: the display name shown in the header, and
   the two Apps Script Web App URLs (Price API / Holdings API) —
   editable here now so a redeployed /exec URL never requires a
   code change. Reuses the app's one generic modal; the body HTML
   (including the Export/Import controls) is rebuilt fresh every
   time the modal opens, so its buttons are wired right after
   openModal() runs rather than once at page load.
   ============================================================ */

function openSettingsModal() {
  const tbByAccount = {};
  tradeBook.trades.forEach(t => { tbByAccount[t.accountId || "(unlabeled)"] = (tbByAccount[t.accountId || "(unlabeled)"] || 0) + 1; });
  const tbAccountNames = Object.keys(tbByAccount);
  const tbSummaryText = tradeBook.trades.length
    ? `${tradeBook.trades.length} trade${tradeBook.trades.length === 1 ? "" : "s"} stored across ${tbAccountNames.length} account${tbAccountNames.length === 1 ? "" : "s"} (${tbAccountNames.map(a => `${a}: ${tbByAccount[a]}`).join(", ")}).`
    : "No trade book data imported yet.";

  const html = `
    <h4>Display</h4>
    <div class="settings-field">
      <label for="settingsOwnerName">Your name (shown in the title)</label>
      <input type="text" id="settingsOwnerName" value="${escapeAttr(state.ownerName || "Ganesh")}">
    </div>

    <h4>Equity Allocation Limits (Per Stock)</h4>
    <p class="settings-note" style="margin-top:0">Maximum recommended allocation (% of total Equity Invested Amount) for any ONE stock, per market-cap category. The Equity tab's Alloc % column and Intelligent Insights' per-stock rows use these live — a stock's category comes from its imported Screener Market Cap.</p>
    <div class="settings-field">
      <label for="settingsAllocLarge">Large Cap — max % per stock</label>
      <input type="text" inputmode="decimal" id="settingsAllocLarge" value="${escapeAttr(String(state.equityAllocLimits?.large ?? DEFAULT_EQUITY_ALLOC_LIMITS.large))}">
    </div>
    <div class="settings-field">
      <label for="settingsAllocMid">Mid Cap — max % per stock</label>
      <input type="text" inputmode="decimal" id="settingsAllocMid" value="${escapeAttr(String(state.equityAllocLimits?.mid ?? DEFAULT_EQUITY_ALLOC_LIMITS.mid))}">
    </div>
    <div class="settings-field">
      <label for="settingsAllocSmall">Small Cap — max % per stock</label>
      <input type="text" inputmode="decimal" id="settingsAllocSmall" value="${escapeAttr(String(state.equityAllocLimits?.small ?? DEFAULT_EQUITY_ALLOC_LIMITS.small))}">
    </div>

    <h4>Equity Allocation Targets (Overall Portfolio, by Market Cap)</h4>
    <p class="settings-note" style="margin-top:0">Target % of your TOTAL Equity portfolio for each market-cap category as a whole (e.g. Large Cap should make up around 70% overall). Shown in the "Cap Allocation" cards on Stock Analysis → Intelligent Insights — separate from the per-stock limits above.</p>
    <div class="settings-field">
      <label for="settingsCapTargetLarge">Large Cap — target % of portfolio</label>
      <input type="text" inputmode="decimal" id="settingsCapTargetLarge" value="${escapeAttr(String(state.equityCapAllocTargets?.large ?? DEFAULT_EQUITY_CAP_ALLOC_TARGETS.large))}">
    </div>
    <div class="settings-field">
      <label for="settingsCapTargetMid">Mid Cap — target % of portfolio</label>
      <input type="text" inputmode="decimal" id="settingsCapTargetMid" value="${escapeAttr(String(state.equityCapAllocTargets?.mid ?? DEFAULT_EQUITY_CAP_ALLOC_TARGETS.mid))}">
    </div>
    <div class="settings-field">
      <label for="settingsCapTargetSmall">Small Cap — target % of portfolio</label>
      <input type="text" inputmode="decimal" id="settingsCapTargetSmall" value="${escapeAttr(String(state.equityCapAllocTargets?.small ?? DEFAULT_EQUITY_CAP_ALLOC_TARGETS.small))}">
    </div>

    <h4>Live Price API</h4>
    <p class="settings-note" style="margin-top:0">Your Google Apps Script Web App URL. Update it here if you ever redeploy and get a new <code>/exec</code> link — no code changes needed.</p>
    <div class="settings-field">
      <label for="settingsPriceApiUrl">Price API URL (Stocks / Mutual Funds / Gold / Debt)</label>
      <input type="text" id="settingsPriceApiUrl" placeholder="https://script.google.com/macros/s/.../exec" value="${escapeAttr(state.priceApiUrl || "")}">
    </div>
    <div class="settings-field">
      <label for="settingsHoldingsApiUrl">Holdings API URL (legacy — superseded by Google Drive import below)</label>
      <input type="text" id="settingsHoldingsApiUrl" placeholder="https://script.google.com/macros/s/.../exec" value="${escapeAttr(state.holdingsApiUrl || "")}">
    </div>

    <h4>Google Drive Import</h4>
    <p class="settings-note" style="margin-top:0">"Import from Google Drive" opens a picker so you browse and choose the exact Zerodha Holdings .xlsx file — it never gets standing access to your whole Drive, only the file you pick. One-time setup in <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a>: enable the "Google Picker API" and "Google Drive API", create an OAuth 2.0 Client ID (Web application) with this site's URL under Authorized JavaScript origins, and create an API key (restrict it to the Picker API). Paste both below.</p>
    <div class="settings-field">
      <label for="settingsGoogleDriveClientId">Google Drive OAuth Client ID</label>
      <input type="text" id="settingsGoogleDriveClientId" placeholder="xxxxxxxxxx.apps.googleusercontent.com" value="${escapeAttr(state.googleDriveClientId || DEFAULT_GOOGLE_DRIVE_CLIENT_ID)}">
    </div>
    <div class="settings-field">
      <label for="settingsGoogleDriveApiKey">Google Drive API Key</label>
      <input type="text" id="settingsGoogleDriveApiKey" placeholder="AIza..." value="${escapeAttr(state.googleDriveApiKey || DEFAULT_GOOGLE_DRIVE_API_KEY)}">
    </div>

    <h4>Import Investments</h4>
    <p class="settings-note" style="margin-top:0">Import Zerodha Holdings for Equity, Mutual Funds and Gold together in one step. Pick a source below — local file selection supports choosing several files at once (one per Zerodha account); matching holdings across files are combined automatically and you'll see a full preview before anything is applied.</p>
    <div class="settings-actions">
      <button class="btn" id="settingsBtnImportInvestments">Import Investments</button>
      <span class="status-tag" id="investmentsImportStatus"></span>
    </div>

    <h4>Import Trade Book</h4>
    <p class="settings-note" style="margin-top:0">Import Zerodha Console Tradebook CSV exports (per demat account) to build trade-level history for the Dashboard's "Portfolio performance" chart below. Stored only in this browser — never synced to the cloud — and separate from your Equity/Mutual Funds/Gold holdings above; importing it never changes those tabs.</p>
    <div class="settings-actions">
      <button class="btn" id="settingsBtnImportTradeBook">Import Trade Book</button>
      <span class="status-tag" id="tradeBookImportStatus"></span>
      ${tradeBook.trades.length ? `<button class="btn btn-ghost" id="settingsBtnClearTradeBook">Clear Trade Book Data</button>` : ""}
    </div>
    <p class="settings-note">${escapeAttr(tbSummaryText)}</p>

    <h4>Portfolio Performance Chart</h4>
    <p class="settings-note" style="margin-top:0">The Dashboard's "Portfolio performance" card compares your net invested capital (from the Trade Book above) against a Nifty 50 equivalent, using a small Apps Script Web App that serves your "Nifty History" sheet as JSON — same pattern as the Price/Holdings API URLs above, deployed separately. One-time setup: open the "Nifty Live (helper)" sheet → Extensions → Apps Script → make sure it has the <code>doGet()</code> function from the latest <code>nifty_daily_capture.gs</code> → Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone) → paste the resulting URL below.</p>
    <div class="settings-field">
      <label for="settingsNiftyHistoryApiUrl">Nifty History API URL</label>
      <input type="text" id="settingsNiftyHistoryApiUrl" placeholder="https://script.google.com/macros/s/.../exec" value="${escapeAttr(state.niftyHistoryApiUrl || "")}">
    </div>

    <h4>Backup &amp; Restore</h4>
    <div class="settings-actions">
      <button class="btn" id="settingsBtnExportExcel">Export Excel</button>
      <button class="btn" id="settingsBtnExportJSON">Export JSON</button>
      <label class="btn btn-ghost" for="importFile">Import JSON</label>
      <button class="btn btn-ghost" id="settingsBtnRestorePreCloudSync" style="display:none">Restore Pre-Sync Backup</button>
    </div>
    <p class="settings-note" id="preCloudSyncBackupNote" style="display:none"></p>
  `;
  openModal("Settings", html, [
    { label: "Cancel", onClick: closeModal },
    {
      label: "Save", primary: true, onClick: () => {
        state.ownerName = document.getElementById("settingsOwnerName").value.trim() || "Ganesh";
        state.priceApiUrl = document.getElementById("settingsPriceApiUrl").value.trim() || DEFAULT_PRICE_API_URL;
        state.holdingsApiUrl = document.getElementById("settingsHoldingsApiUrl").value.trim() || DEFAULT_HOLDINGS_API_URL;
        state.googleDriveClientId = document.getElementById("settingsGoogleDriveClientId").value.trim() || DEFAULT_GOOGLE_DRIVE_CLIENT_ID;
        state.googleDriveApiKey = document.getElementById("settingsGoogleDriveApiKey").value.trim() || DEFAULT_GOOGLE_DRIVE_API_KEY;
        const newNiftyHistoryApiUrl = document.getElementById("settingsNiftyHistoryApiUrl").value.trim();
        if (newNiftyHistoryApiUrl !== state.niftyHistoryApiUrl) {
          // URL actually changed — drop the cached fetch/series so the
          // Portfolio performance chart re-fetches from the new source
          // instead of silently continuing to show the old one's data.
          niftyHistoryCache = null;
          niftyHistoryLoadPromise = null;
          portfolioPerfFullSeries = null;
          portfolioPerfFullSeriesKey = "";
        }
        state.niftyHistoryApiUrl = newNiftyHistoryApiUrl;
        const parseLimit = (id, fallback) => {
          const v = parseFloat(document.getElementById(id).value);
          return (isNaN(v) || v < 0) ? fallback : v;
        };
        state.equityAllocLimits = {
          large: parseLimit("settingsAllocLarge", DEFAULT_EQUITY_ALLOC_LIMITS.large),
          mid: parseLimit("settingsAllocMid", DEFAULT_EQUITY_ALLOC_LIMITS.mid),
          small: parseLimit("settingsAllocSmall", DEFAULT_EQUITY_ALLOC_LIMITS.small)
        };
        state.equityCapAllocTargets = {
          large: parseLimit("settingsCapTargetLarge", DEFAULT_EQUITY_CAP_ALLOC_TARGETS.large),
          mid: parseLimit("settingsCapTargetMid", DEFAULT_EQUITY_CAP_ALLOC_TARGETS.mid),
          small: parseLimit("settingsCapTargetSmall", DEFAULT_EQUITY_CAP_ALLOC_TARGETS.small)
        };
        saveState();
        renderBrand();
        renderEquity();
        renderStockAnalysis();
        renderDashboard();
        closeModal();
      }
    }
  ]);
  // The buttons above are re-created every time this modal opens, so
  // wire them fresh each time rather than once at page load.
  document.getElementById("settingsBtnExportExcel").addEventListener("click", runExcelExport);
  document.getElementById("settingsBtnExportJSON").addEventListener("click", runJsonExport);
  document.getElementById("settingsBtnImportInvestments").addEventListener("click", () => {
    closeModal();
    openImportChooser();
  });
  document.getElementById("settingsBtnImportTradeBook").addEventListener("click", () => {
    closeModal();
    openTradeBookImportChooser();
  });
  const clearTradeBookBtn = document.getElementById("settingsBtnClearTradeBook");
  if (clearTradeBookBtn) {
    clearTradeBookBtn.addEventListener("click", () => {
      const ok = confirm(`Delete all ${tradeBook.trades.length} stored trade book records? This can't be undone. (Your Equity/Mutual Funds/Gold holdings are unaffected — this only clears trade-book data used by the Portfolio performance chart.)`);
      if (!ok) return;
      tradeBook = blankTradeBook();
      saveTradeBook();
      renderDashboard();
      closeModal();
    });
  }

  // Only shown when a pre-cloud-sync snapshot actually exists — this
  // is the recovery path for the empty-cloud-doc scenario (and any
  // other cloud overwrite) now that resolveCloudSync() always saves
  // one before replacing `state` with cloud data.
  const preSyncBackup = getPreCloudSyncBackup();
  if (preSyncBackup) {
    const restoreBtn = document.getElementById("settingsBtnRestorePreCloudSync");
    const restoreNote = document.getElementById("preCloudSyncBackupNote");
    restoreBtn.style.display = "";
    restoreNote.style.display = "block";
    restoreNote.textContent = `A snapshot from ${new Date(preSyncBackup.savedAt).toLocaleString()} — taken automatically just before the last cloud sync overwrite — is available to restore.`;
    restoreBtn.addEventListener("click", () => {
      const ok = confirm("Restore your data from just before the last cloud sync? This replaces whatever is currently loaded in the app (both on this device and, once saved, in the cloud).");
      if (!ok) return;
      state = mergeIntoState(preSyncBackup.state);
      saveState();
      renderAll();
      closeModal();
    });
  }
}

document.getElementById("btnSettings").addEventListener("click", openSettingsModal);

function renderAll() {
  renderEquity();
  renderDebt();
  renderMF();
  renderGold();
  renderStockAnalysis();
  renderDashboard();
  const tag = document.getElementById("lastUpdatedTag");
  tag.textContent = state.lastSaved ? "Saved " + new Date(state.lastSaved).toLocaleTimeString() : "Not saved yet";
}

setupSortAndFilter("equity", "#panel-equity thead", "equityFilter", () => { renderEquity(); });
setupSortAndFilter("debt", "#panel-debt thead", "debtFilter", () => { renderDebt(); });
setupSortAndFilter("mf", "#panel-mf thead", "mfFilter", () => { renderMF(); });
setupSortAndFilter("gold", "#panel-gold thead", "goldFilter", () => { renderGold(); });
setupSortAndFilter("stockanalysis", "#panel-stockanalysis thead", "stockAnalysisFilter", () => { tableUI.stockanalysis.page = 1; renderStockAnalysis(); });

markInitialSortIndicator("equity", "#panel-equity thead");
markInitialSortIndicator("debt", "#panel-debt thead");
markInitialSortIndicator("mf", "#panel-mf thead");
markInitialSortIndicator("gold", "#panel-gold thead");
markInitialSortIndicator("stockanalysis", "#panel-stockanalysis thead");

setupMobileSort("equity", "equityMobileSort", "equityMobileSortDir", "#panel-equity thead", () => { renderEquity(); });
setupMobileSort("debt", "debtMobileSort", "debtMobileSortDir", "#panel-debt thead", () => { renderDebt(); });
setupMobileSort("mf", "mfMobileSort", "mfMobileSortDir", "#panel-mf thead", () => { renderMF(); });
setupMobileSort("gold", "goldMobileSort", "goldMobileSortDir", "#panel-gold thead", () => { renderGold(); });
setupMobileSort("stockanalysis", "stockAnalysisMobileSort", "stockAnalysisMobileSortDir", "#panel-stockanalysis thead", () => { tableUI.stockanalysis.page = 1; renderStockAnalysis(); });

setupOverflowToggle("debtOverflowToggle", "debtToolbarSecondary");

// New Debt Dashboard wiring — the holdings-list search box shares the
// exact same tableUI.debt.filter state as the classic table's own
// #debtFilter box (kept in sync both ways) so search behaves
// identically whichever view is on screen.
document.getElementById("debtHoldingsSearch")?.addEventListener("input", (e) => {
  tableUI.debt.filter = e.target.value;
  const classicFilter = document.getElementById("debtFilter");
  if (classicFilter) classicFilter.value = e.target.value;
  renderDebtHoldingsList();
});
document.getElementById("debtFilter")?.addEventListener("input", (e) => {
  const searchBox = document.getElementById("debtHoldingsSearch");
  if (searchBox) searchBox.value = e.target.value;
});

// Sort shortcuts — set the same tableUI.debt sort state the column
// headers already use, so "Highest Rate" etc. is just a one-click
// alias for clicking that header, not a separate sort implementation.
document.querySelectorAll(".debt-sort-shortcut").forEach(btn => {
  btn.addEventListener("click", () => {
    tableUI.debt.sortCol = btn.dataset.sortCol;
    tableUI.debt.sortDir = Number(btn.dataset.sortDir);
    document.querySelectorAll(".debt-sort-shortcut").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderDebtHoldingsList();
  });
});

document.querySelectorAll(".debt-cal-range-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    debtUI.calendarMonths = Number(btn.dataset.months);
    debtUI.selectedMonthIdx = null;
    document.querySelectorAll(".debt-cal-range-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderDebtCalendar();
  });
});

document.getElementById("debtKpiRebalanceBtn")?.addEventListener("click", () => {
  goToTab("dashboard");
  setTimeout(openIdealTargetsModal, 150);
});

document.getElementById("btnDebtColumns")?.addEventListener("click", openDebtColumnsModal);

document.getElementById("debtReinvestViewRebalance")?.addEventListener("click", () => {
  goToTab("dashboard");
  setTimeout(openIdealTargetsModal, 150);
});
document.getElementById("debtReinvestRenew")?.addEventListener("click", () => {
  openModal(
    "Renew FD",
    `<p class="settings-note" style="margin-top:0">Automatic renewal isn't wired up yet — for now, add a new entry via "+ Add Investment" for the renewed term, then remove or update this one once the old FD actually matures.</p>`,
    [{ label: "Got it", primary: true, onClick: closeModal }]
  );
});
document.getElementById("debtReinvestDecideLater")?.addEventListener("click", () => {
  debtUI.reinvestDismissed = true;
  renderDebtReinvestmentPlanner();
});
document.getElementById("debtAttnFilter")?.addEventListener("change", (e) => {
  debtUI.attnFilter = e.target.value;
  renderDebtAttention();
});

setupIntelligentInsightsControls();
setupFilterClearButtons();
setupAttentionToggle("dashAttnCard", "dashAttnToggle");
setupAttentionToggle("debtAttnCard", "debtAttnToggle");

setupFabAdd("fabAddDebt", "btnAddDebt");

setupColumnResize("col-eq-name", "#panel-equity .col-resizer");
setupColumnResize("col-debt-name", "#panel-debt .col-resizer");
setupColumnResize("col-mf-name", "#panel-mf .col-resizer");
setupColumnResize("col-gold-name", "#panel-gold .col-resizer");
setupColumnResize("col-sa-name", "#panel-stockanalysis .col-resizer");

updateLockButton();
updateDemoButtons();
updateOfflineBanner();
renderBrand();
renderAll();
maybeRunWeeklyBackup();
initCloudSync();

// Live-price auto-refresh, per tab (Debt is intentionally skipped —
// it has no live-price mechanism). Runs once immediately on load,
// then every 30 seconds in the background; each tab's own status tag
// and fail panel update in place once a fetch resolves. There's no
// manual "Refresh" button anymore — Equity/MF/Gold data now only
// changes via this auto-refresh or a Zerodha Holdings import.
const LIVE_REFRESH_INTERVAL_MS = 30000;
function runAllLiveRefreshes() {
  runEquityRefresh(document.getElementById("equityFetchStatus"));
  runMFRefresh(document.getElementById("mfFetchStatus"));
  runGoldRefresh(document.getElementById("goldFetchStatus"));
  refreshIndexData();
}
runAllLiveRefreshes();
setInterval(runAllLiveRefreshes, LIVE_REFRESH_INTERVAL_MS);
