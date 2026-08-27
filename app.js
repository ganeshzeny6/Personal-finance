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

const DEFAULT_IDEAL = { cash: 5, debt: 30, mf: 30, equity: 25, gold: 10 };

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
  renderEquity(); renderDebt(); renderMF(); renderGold(); renderDashboard();
});
window.addEventListener("offline", () => {
  updateOfflineBanner();
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
    equity: [],
    debt: [],
    mf: [],
    gold: [],
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
    // One-time Google Cloud credentials for the "Import from Google
    // Drive" file picker (see Settings for setup steps). Blank by
    // default — Drive import shows a setup message until these are
    // filled in.
    googleDriveClientId: "",
    googleDriveApiKey: ""
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return blankState();
    const parsed = JSON.parse(raw);
    return { ...blankState(), ...parsed, ideal: { ...DEFAULT_IDEAL, ...(parsed.ideal || {}) } };
  } catch (e) {
    console.error("Failed to load saved data, starting fresh.", e);
    return blankState();
  }
}

function saveState() {
  state.lastSaved = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const tag = document.getElementById("lastUpdatedTag");
  if (tag) tag.textContent = "Saved " + new Date(state.lastSaved).toLocaleTimeString();
  scheduleCloudPush();
}

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

function fmtPct(n) {
  n = Number(n) || 0;
  return (n >= 0 ? "" : "") + n.toFixed(2) + "%";
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
  gold:   { sortCol: null, sortDir: 1, filter: "" }
};

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
  });
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

function equityGetSearchText(row) {
  const d = equityDerived(row);
  return [row.name, row.invested, row.units, d.avgPrice, row.ltp, d.currentValue, d.pl, d.plPct, row.sector].join(" ");
}

function equityGetSortValue(row, col) {
  const d = equityDerived(row);
  switch (col) {
    case "name": return row.name || "";
    case "invested": return Number(row.invested) || 0;
    case "units": return Number(row.units) || 0;
    case "avgPrice": return d.avgPrice;
    case "ltp": return Number(row.ltp) || 0;
    case "currentValue": return d.currentValue;
    case "pl": return d.pl;
    case "plPct": return d.plPct;
    case "allocPct": return Number(row.invested) || 0; // alloc% is invested-based, same sort order
    case "sector": return row.sector || "";
    default: return 0;
  }
}

function renderEquity() {
  const tbody = document.getElementById("equityTableBody");
  tbody.innerHTML = "";
  const totals = equityTotals();
  const displayRows = applySortFilter("equity", state.equity, equityGetSearchText, equityGetSortValue);

  if (state.equity.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="11">No stocks yet. Use "Import Holdings" to bring in your Zerodha Console export.</td></tr>';
  } else if (displayRows.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="11">No stocks match this filter.</td></tr>';
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
    const pendingBadge = row.livePricePending ? '<span class="pending-badge">Pending</span>' : "";
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td class="left sticky-col"><input type="text" value="${escapeAttr(row.name || "")}" data-field="name" placeholder="e.g. TCS.NS" disabled></td>
      <td class="left" data-label="Sector"><input type="text" value="${escapeAttr(row.sector || "")}" data-field="sector" placeholder="e.g. IT" ${notesLocked ? "disabled" : ""}></td>
      <td data-label="Invested Amt"><input type="number" step="any" value="${roundedInputValue(row.invested)}" data-field="invested" disabled></td>
      <td data-label="Units"><input type="number" step="any" value="${roundedInputValue(row.units)}" data-field="units" disabled></td>
      <td class="c-avg" data-label="Avg Price">${fmtNum(d.avgPrice)}</td>
      <td data-label="LTP"><div class="price-cell"><input type="number" step="any" value="${roundedInputValue(row.ltp)}" data-field="ltp" disabled>${pendingBadge}</div></td>
      <td class="c-cv" data-label="Current Value">${fmtNum(d.currentValue)}</td>
      <td class="c-pl ${plClass(d.pl)}" data-label="P&amp;L">${fmtNum(d.pl)}</td>
      <td class="c-plpct ${plClass(d.pl)}" data-label="P&amp;L %">${fmtPct(d.plPct)}</td>
      <td class="c-alloc" data-label="Alloc %">${fmtNum(allocPct)}%</td>
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
}

// Lightweight refresh used on every keystroke-commit (input `change`):
// updates only the read-only derived cells and footer totals, and never
// touches the <input> elements themselves — so focus/Tab order across
// fields in the same row (and across rows) is never disturbed.
function updateEquityComputed() {
  const tbody = document.getElementById("equityTableBody");
  const totals = equityTotals();
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
    tr.querySelector(".c-alloc").textContent = fmtNum(allocPct) + "%";
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
  let ok = 0;
  const failedRows = [];
  state.equity.forEach(row => {
    const key = (row.name || "").trim().toUpperCase();
    if (key && priceMap.has(key)) {
      row.ltp = priceMap.get(key);
      row.livePricePending = false;
      ok++;
    } else {
      failedRows.push({ name: row.name || "(unnamed)", key });
    }
  });
  saveState();
  return { ok, fail: failedRows.length, failedRows };
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
   DASHBOARD
   ============================================================ */

function renderDashboard() {
  const cashInput = document.getElementById("cashInput");
  if (document.activeElement !== cashInput) cashInput.value = state.cash ? fmtINR(state.cash) : "";
  cashInput.disabled = isReadOnly();

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
  const totalInvested = debt.invested + mf.invested + eq.invested + gold.invested; // cash excluded from "invested"
  // Debt/cash don't have a live mark-to-market P&L (FDs are valued
  // at invested amount, not fluctuating day-to-day) — Equity, MF
  // and Gold all now carry real invested-vs-current P&L.
  const overallPL = eq.pl + mf.pl + gold.pl;
  const overallPLBase = eq.invested + mf.invested + gold.invested;
  const overallPLPct = overallPLBase > 0 ? (overallPL / overallPLBase) * 100 : 0;

  document.getElementById("statNetWorth").textContent = fmtINR(netWorth);
  document.getElementById("statTotalInvested").textContent = fmtINR(totalInvested);
  const plEl = document.getElementById("statOverallPL");
  plEl.textContent = fmtINR(overallPL);
  plEl.className = "value " + plClass(overallPL);
  const plPctEl = document.getElementById("statOverallPLPct");
  plPctEl.textContent = fmtPct(overallPLPct) + " (Equity + MF + Gold)";

  // allocation table
  const idealTotal = Object.values(state.ideal).reduce((a, b) => a + (Number(b) || 0), 0);
  const tbody = document.getElementById("allocTableBody");
  tbody.innerHTML = "";
  const locked = isReadOnly();
  classes.forEach(c => {
    const currentPct = netWorth > 0 ? (c.current / netWorth) * 100 : 0;
    const idealPct = Number(state.ideal[c.key]) || 0;
    const diffPct = currentPct - idealPct;
    const diffAmount = (diffPct / 100) * netWorth;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="left"><div class="alloc-name"><span class="swatch" style="background:${ASSET_COLORS[c.key]}"></span>${c.label}</div></td>
      <td data-label="Current Value">${fmtINR(c.current)}</td>
      <td data-label="Current %">${fmtNum(currentPct)}%</td>
      <td data-label="Ideal %"><input class="ideal-input" type="number" step="any" value="${idealPct}" data-key="${c.key}" ${locked ? "disabled" : ""}></td>
      <td class="${plClass(diffPct)}" data-label="Diff %">${diffPct >= 0 ? "+" : ""}${fmtNum(diffPct)}%</td>
      <td class="${plClass(diffAmount)}" data-label="Diff Amount">${diffAmount >= 0 ? "+" : ""}${fmtINR(diffAmount)}</td>
    `;
    tr.querySelector(".ideal-input").addEventListener("change", (e) => {
      state.ideal[c.key] = parseFloat(e.target.value) || 0;
      saveState();
      renderDashboard();
    });
    tbody.appendChild(tr);
  });

  document.getElementById("allocTotalValue").textContent = fmtINR(netWorth);
  document.getElementById("allocTotalCurrentPct").textContent = "100%";
  document.getElementById("allocTotalIdealPct").textContent = fmtNum(idealTotal) + "%";

  renderPieChart(classes, netWorth);
  // Keeps Insights live whenever it's the visible tab (e.g. during the
  // 30-second auto price refresh); renderInsights() itself no-ops if
  // that tab isn't currently open.
  renderInsights();
}

function renderPieChart(classes, netWorth) {
  const ctx = document.getElementById("allocPie");
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
  const labels = entries.map(e => e.label);
  const data = entries.map(e => totalValue > 0 ? +(e.value / totalValue * 100).toFixed(2) : 0);
  const colors = entries.map((_, i) => INSIGHTS_PALETTE[i % INSIGHTS_PALETTE.length]);

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

async function readWorkbookRows(file) {
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: "array", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
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
    <table>
      <thead><tr><th class="left">Name</th><th class="left">Category</th><th class="left">Invested</th><th class="left">Maturity Date</th></tr></thead>
      <tbody>${previewRows}</tbody>
    </table>
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
     <table><thead><tr><th class="left">Investment Name</th><th class="left">Asset Type</th></tr></thead><tbody>${rows}</tbody></table>
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
function openDrivePicker(accessToken) {
  return new Promise((resolve) => {
    const view = new google.picker.DocsView()
      .setIncludeFolders(false)
      .setSelectFolderEnabled(false)
      .setMimeTypes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.google-apps.spreadsheet");
    const picker = new google.picker.PickerBuilder()
      .setOAuthToken(accessToken)
      .setDeveloperKey(state.googleDriveApiKey)
      .addView(view)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
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
      state = { ...blankState(), ...parsed, ideal: { ...DEFAULT_IDEAL, ...(parsed.ideal || {}) } };
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
      state = { ...blankState(), ...restored, ideal: { ...DEFAULT_IDEAL, ...(restored.ideal || {}) } };
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
   localStorage stays the instant local cache (nothing about
   normal app usage changes when signed out). Firestore doc at
   portfolios/{uid} mirrors it once signed in. saveState()
   triggers a debounced (2s) background push. On sign-in,
   resolveCloudSync() reconciles local vs. cloud using safe rules
   that never silently discard real data on either side:
     - empty cloud + real local  -> push local automatically
     - empty local + real cloud  -> pull cloud automatically
     - both empty                -> no-op
     - both non-empty, identical -> no-op (no nagging every load)
     - both non-empty, different -> ask which one wins
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

function isStateEmpty(s) {
  return !s.cash &&
    (!s.equity || s.equity.length === 0) &&
    (!s.debt || s.debt.length === 0) &&
    (!s.mf || s.mf.length === 0) &&
    (!s.gold || s.gold.length === 0);
}

// Compares two state objects ignoring lastSaved/lastBackup, which
// change on every save and would otherwise make "identical" data
// look different and trigger a needless conflict prompt.
function stateContentEqual(a, b) {
  const strip = (s) => {
    const c = { ...s };
    delete c.lastSaved;
    delete c.lastBackup;
    return JSON.stringify(c);
  };
  return strip(a) === strip(b);
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

async function pushStateToCloud() {
  if (!cloudUser || !fbDb) return;
  try {
    await fbDb.collection("portfolios").doc(cloudUser.uid).set(state);
  } catch (e) {
    console.error("Cloud push failed:", e);
    updateCloudSyncUI("Sync failed");
  }
}

// Called from saveState() on every local change; debounced so a
// burst of edits (e.g. typing) doesn't fire a write per keystroke.
function scheduleCloudPush() {
  if (!cloudUser) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(pushStateToCloud, 2000);
}

async function resolveCloudSync() {
  if (!cloudUser || !fbDb) return;
  updateCloudSyncUI("Syncing…");
  try {
    const snap = await fbDb.collection("portfolios").doc(cloudUser.uid).get();
    const cloud = snap.exists ? snap.data() : null;
    const localEmpty = isStateEmpty(state);
    const cloudEmpty = !cloud || isStateEmpty(cloud);

    if (cloudEmpty && !localEmpty) {
      await pushStateToCloud();
    } else if (!cloudEmpty && localEmpty) {
      state = { ...blankState(), ...cloud, ideal: { ...DEFAULT_IDEAL, ...(cloud.ideal || {}) } };
      saveState();
      renderAll();
    } else if (cloudEmpty && localEmpty) {
      // nothing on either side yet
    } else if (stateContentEqual(state, cloud)) {
      // already in sync, don't nag
    } else {
      const useCloud = confirm(
        "Your local data on this device and your cloud data are different.\n\n" +
        "Click OK to use the CLOUD version (this device's local data will be overwritten).\n" +
        "Click Cancel to keep THIS DEVICE's version (the cloud will be overwritten with it)."
      );
      if (useCloud) {
        state = { ...blankState(), ...cloud, ideal: { ...DEFAULT_IDEAL, ...(cloud.ideal || {}) } };
        saveState();
        renderAll();
      } else {
        await pushStateToCloud();
      }
    }
    updateCloudSyncUI();
  } catch (e) {
    console.error("Cloud sync failed:", e);
    updateCloudSyncUI("Sync error");
  }
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
      if (user) await resolveCloudSync();
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
  const html = `
    <h4>Display</h4>
    <div class="settings-field">
      <label for="settingsOwnerName">Your name (shown in the title)</label>
      <input type="text" id="settingsOwnerName" value="${escapeAttr(state.ownerName || "Ganesh")}">
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
      <input type="text" id="settingsGoogleDriveClientId" placeholder="xxxxxxxxxx.apps.googleusercontent.com" value="${escapeAttr(state.googleDriveClientId || "638244383857-oe1ea4pb1l64a79d34d7j64uclmpmqv9.apps.googleusercontent.com")}">
    </div>
    <div class="settings-field">
      <label for="settingsGoogleDriveApiKey">Google Drive API Key</label>
      <input type="text" id="settingsGoogleDriveApiKey" placeholder="AIza..." value="${escapeAttr(state.googleDriveApiKey || "AIzaSyB0waRuXkp9Bh1k0CcmSea-BXcM6yY8WQs")}">
    </div>

    <h4>Import Investments</h4>
    <p class="settings-note" style="margin-top:0">Import Zerodha Holdings for Equity, Mutual Funds and Gold together in one step. Pick a source below — local file selection supports choosing several files at once (one per Zerodha account); matching holdings across files are combined automatically and you'll see a full preview before anything is applied.</p>
    <div class="settings-actions">
      <button class="btn" id="settingsBtnImportInvestments">Import Investments</button>
      <span class="status-tag" id="investmentsImportStatus"></span>
    </div>

    <h4>Backup &amp; Restore</h4>
    <div class="settings-actions">
      <button class="btn" id="settingsBtnExportExcel">Export Excel</button>
      <button class="btn" id="settingsBtnExportJSON">Export JSON</button>
      <label class="btn btn-ghost" for="importFile">Import JSON</label>
    </div>
  `;
  openModal("Settings", html, [
    { label: "Cancel", onClick: closeModal },
    {
      label: "Save", primary: true, onClick: () => {
        state.ownerName = document.getElementById("settingsOwnerName").value.trim() || "Ganesh";
        state.priceApiUrl = document.getElementById("settingsPriceApiUrl").value.trim() || DEFAULT_PRICE_API_URL;
        state.holdingsApiUrl = document.getElementById("settingsHoldingsApiUrl").value.trim() || DEFAULT_HOLDINGS_API_URL;
        state.googleDriveClientId = document.getElementById("settingsGoogleDriveClientId").value.trim();
        state.googleDriveApiKey = document.getElementById("settingsGoogleDriveApiKey").value.trim();
        saveState();
        renderBrand();
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
}

document.getElementById("btnSettings").addEventListener("click", openSettingsModal);

function renderAll() {
  renderEquity();
  renderDebt();
  renderMF();
  renderGold();
  renderDashboard();
  const tag = document.getElementById("lastUpdatedTag");
  tag.textContent = state.lastSaved ? "Saved " + new Date(state.lastSaved).toLocaleTimeString() : "Not saved yet";
}

setupSortAndFilter("equity", "#panel-equity thead", "equityFilter", () => { renderEquity(); });
setupSortAndFilter("debt", "#panel-debt thead", "debtFilter", () => { renderDebt(); });
setupSortAndFilter("mf", "#panel-mf thead", "mfFilter", () => { renderMF(); });
setupSortAndFilter("gold", "#panel-gold thead", "goldFilter", () => { renderGold(); });

markInitialSortIndicator("equity", "#panel-equity thead");
markInitialSortIndicator("debt", "#panel-debt thead");
markInitialSortIndicator("mf", "#panel-mf thead");
markInitialSortIndicator("gold", "#panel-gold thead");

setupMobileSort("equity", "equityMobileSort", "equityMobileSortDir", "#panel-equity thead", () => { renderEquity(); });
setupMobileSort("debt", "debtMobileSort", "debtMobileSortDir", "#panel-debt thead", () => { renderDebt(); });
setupMobileSort("mf", "mfMobileSort", "mfMobileSortDir", "#panel-mf thead", () => { renderMF(); });
setupMobileSort("gold", "goldMobileSort", "goldMobileSortDir", "#panel-gold thead", () => { renderGold(); });

setupOverflowToggle("debtOverflowToggle", "debtToolbarSecondary");

setupFabAdd("fabAddDebt", "btnAddDebt");

setupColumnResize("col-eq-name", "#panel-equity .col-resizer");
setupColumnResize("col-debt-name", "#panel-debt .col-resizer");
setupColumnResize("col-mf-name", "#panel-mf .col-resizer");
setupColumnResize("col-gold-name", "#panel-gold .col-resizer");

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
}
runAllLiveRefreshes();
setInterval(runAllLiveRefreshes, LIVE_REFRESH_INTERVAL_MS);
