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
const PRICE_API_URL = "https://script.google.com/macros/s/AKfycbxT5Mgu9hhXdIA6kbfRfT_RhyWJNb6UYbbWBjte0jWh-9Zk4QmyiTLNJveQYLeUoTNBHw/exec";

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
    portfolioLocked: false
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
  equity: { sortCol: null, sortDir: 1, filter: "" },
  debt:   { sortCol: null, sortDir: 1, filter: "" },
  mf:     { sortCol: null, sortDir: 1, filter: "" },
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
    btn.title = "Portfolio locked — Equity/Debt/Mutual Funds/Gold fields, Cash on hand, and Ideal % are read-only until unlocked (or, for Equity/MF/Gold Units & Invested, via Import Holdings). Click to unlock.";
  } else {
    btn.textContent = "🔓 Unlocked";
    btn.classList.remove("locked");
    btn.title = "Click to lock all data fields (Equity, Debt, Mutual Funds, Gold, Cash, Ideal %) against accidental edits.";
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
  return [row.name, row.invested, row.units, d.avgPrice, row.ltp, d.currentValue, d.pl, d.plPct].join(" ");
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
    default: return 0;
  }
}

function renderEquity() {
  const tbody = document.getElementById("equityTableBody");
  tbody.innerHTML = "";
  const totals = equityTotals();
  const displayRows = applySortFilter("equity", state.equity, equityGetSearchText, equityGetSortValue);

  if (state.equity.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="10">No stocks added yet. Click "+ Add stock" to begin.</td></tr>';
  } else if (displayRows.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="10">No stocks match this filter.</td></tr>';
  }

  const locked = state.portfolioLocked;
  displayRows.forEach(row => {
    const d = equityDerived(row);
    // Alloc % reflects each stock's share of total invested capital,
    // not its share of current market value.
    const allocPct = totals.invested > 0 ? (Number(row.invested) / totals.invested) * 100 : 0;
    const pendingBadge = row.livePricePending ? '<span class="pending-badge">Pending</span>' : "";
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td class="left"><input type="text" value="${escapeAttr(row.name || "")}" data-field="name" placeholder="e.g. TCS.NS" ${locked ? "disabled" : ""}></td>
      <td><input type="number" step="any" value="${row.invested ?? ""}" data-field="invested" ${locked ? "disabled" : ""}></td>
      <td><input type="number" step="any" value="${row.units ?? ""}" data-field="units" ${locked ? "disabled" : ""}></td>
      <td class="c-avg">${fmtNum(d.avgPrice)}</td>
      <td><div class="price-cell"><input type="number" step="any" value="${row.ltp ?? ""}" data-field="ltp" ${locked ? "disabled" : ""}>${pendingBadge}</div></td>
      <td class="c-cv">${fmtNum(d.currentValue)}</td>
      <td class="c-pl ${plClass(d.pl)}">${fmtNum(d.pl)}</td>
      <td class="c-plpct ${plClass(d.pl)}">${fmtPct(d.plPct)}</td>
      <td class="c-alloc">${fmtNum(allocPct)}%</td>
      <td class="row-actions"><button class="icon-btn" title="Remove">✕</button></td>
    `;
    tr.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("change", () => {
        const field = inp.dataset.field;
        row[field] = field === "name" ? inp.value : parseFloat(inp.value) || 0;
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
}

document.getElementById("btnAddStock").addEventListener("click", () => {
  state.equity.push({ id: uid(), name: "", invested: 0, units: 0, ltp: 0 });
  saveState();
  renderEquity();
  renderDashboard();
});

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
    res = await fetch(PRICE_API_URL, { cache: "no-store" });
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
            <td class="left">${escapeAttr(f.name)}</td>
            <td class="left">${assetType}</td>
            <td class="left">${escapeAttr(f.key || "(blank)")}</td>
            <td class="left">Verify the Google Finance ticker or update the symbol mapping in your Apps Script sheet.</td>
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

document.getElementById("btnRefreshStocks").addEventListener("click", () => {
  runEquityRefresh(document.getElementById("equityFetchStatus"));
});

/* ============================================================
   DEBT TAB
   ============================================================ */

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

  const locked = state.portfolioLocked;
  displayRows.forEach(row => {
    const d = debtDerived(row);
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td class="left"><input type="text" value="${escapeAttr(row.name || "")}" data-field="name" ${locked ? "disabled" : ""}></td>
      <td class="left"><input type="text" value="${escapeAttr(row.category || "")}" data-field="category" ${locked ? "disabled" : ""}></td>
      <td class="left"><input type="text" value="${escapeAttr(row.subcategory || "")}" data-field="subcategory" ${locked ? "disabled" : ""}></td>
      <td class="left"><input type="text" value="${escapeAttr(row.account || "")}" data-field="account" ${locked ? "disabled" : ""}></td>
      <td><input type="number" step="any" value="${row.invested ?? ""}" data-field="invested" ${locked ? "disabled" : ""}></td>
      <td><input type="number" step="any" value="${row.roi ?? ""}" data-field="roi" ${locked ? "disabled" : ""}></td>
      <td><input type="number" step="any" value="${row.maturityAmount ?? ""}" data-field="maturityAmount" ${locked ? "disabled" : ""}></td>
      <td class="c-profit ${plClass(d.profit)}">${fmtNum(d.profit)}</td>
      <td><input type="date" value="${row.investedDate || ""}" data-field="investedDate" ${locked ? "disabled" : ""}></td>
      <td><input type="date" value="${row.maturityDate || ""}" data-field="maturityDate" ${locked ? "disabled" : ""}></td>
      <td><input type="number" step="any" value="${row.tenureMonths ?? ""}" data-field="tenureMonths" ${locked ? "disabled" : ""}></td>
      <td class="c-years">${fmtNum(d.years, 1)}</td>
      <td class="left"><input type="text" value="${escapeAttr(row.notes || "")}" data-field="notes" ${locked ? "disabled" : ""}></td>
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
  });
  const totals = debtTotals();
  document.getElementById("debtTotalInvested").textContent = fmtINR(totals.invested);
  document.getElementById("debtTotalMaturity").textContent = fmtINR(totals.maturity);
  const totalProfitCell = document.getElementById("debtTotalProfit");
  totalProfitCell.textContent = fmtINR(totals.profit);
  totalProfitCell.className = plClass(totals.profit);
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
  return [row.name, row.symbol, row.category, row.subcategory, row.invested, row.units, d.avgPrice, row.unitPrice, d.currentValue, d.pl, d.plPct, row.remarks].join(" ");
}

function mfGetSortValue(row, col) {
  const d = mfDerived(row);
  switch (col) {
    case "name": return row.name || "";
    case "symbol": return row.symbol || "";
    case "category": return row.category || "";
    case "subcategory": return row.subcategory || "";
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
    tbody.innerHTML = '<tr class="empty-row"><td colspan="13">No mutual funds added yet. Click "+ Add fund" to begin.</td></tr>';
  } else if (displayRows.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="13">No funds match this filter.</td></tr>';
  }

  const locked = state.portfolioLocked;
  displayRows.forEach(row => {
    const d = mfDerived(row);
    const allocPct = totals.current > 0 ? (d.currentValue / totals.current) * 100 : 0;
    const pendingBadge = row.livePricePending ? '<span class="pending-badge">Pending</span>' : "";
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td class="left"><input type="text" value="${escapeAttr(row.name || "")}" data-field="name" ${locked ? "disabled" : ""}></td>
      <td class="left"><input type="text" value="${escapeAttr(row.symbol || "")}" data-field="symbol" placeholder="Symbol" ${locked ? "disabled" : ""}></td>
      <td class="left"><input type="text" value="${escapeAttr(row.category || "")}" data-field="category" ${locked ? "disabled" : ""}></td>
      <td class="left"><input type="text" value="${escapeAttr(row.subcategory || "")}" data-field="subcategory" ${locked ? "disabled" : ""}></td>
      <td><input type="number" step="any" value="${row.invested ?? ""}" data-field="invested" ${locked ? "disabled" : ""}></td>
      <td><input type="number" step="any" value="${row.units ?? ""}" data-field="units" ${locked ? "disabled" : ""}></td>
      <td class="c-avg">${fmtNum(d.avgPrice)}</td>
      <td><div class="price-cell"><input type="number" step="any" value="${row.unitPrice ?? ""}" data-field="unitPrice" ${locked ? "disabled" : ""}>${pendingBadge}</div></td>
      <td class="c-cv">${fmtNum(d.currentValue)}</td>
      <td class="c-pl ${plClass(d.pl)}">${fmtNum(d.pl)}</td>
      <td class="c-plpct ${plClass(d.pl)}">${fmtPct(d.plPct)}</td>
      <td class="c-alloc">${fmtNum(allocPct)}%</td>
      <td class="left"><input type="text" value="${escapeAttr(row.remarks || "")}" data-field="remarks" ${locked ? "disabled" : ""}></td>
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
}

document.getElementById("btnAddMF").addEventListener("click", () => {
  state.mf.push({ id: uid(), name: "", symbol: "", category: "", subcategory: "", invested: 0, units: 0, unitPrice: 0, remarks: "" });
  saveState();
  renderMF();
  renderDashboard();
});

/* ---- live NAV fetch: mutual funds (Google Sheet, refreshed by Apps Script) ---- */

async function refreshMFPrices() {
  if (state.mf.length === 0) return { ok: 0, fail: 0, failedRows: [], skipped: true };
  const data = await fetchPriceData();
  const navMap = buildPriceMap(data.mf, ["MF Name", "Symbol"], ["Live Price", "NAV", "Price"]);
  let ok = 0;
  const failedRows = [];
  state.mf.forEach(row => {
    const key = (row.symbol || "").trim().toUpperCase();
    if (key && navMap.has(key)) {
      row.unitPrice = navMap.get(key);
      row.livePricePending = false;
      ok++;
    } else {
      failedRows.push({ name: row.name || "(unnamed)", key });
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

document.getElementById("btnRefreshMF").addEventListener("click", () => {
  runMFRefresh(document.getElementById("mfFetchStatus"));
});

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
    tbody.innerHTML = '<tr class="empty-row"><td colspan="11">No gold holdings yet. Click "+ Add holding" to begin.</td></tr>';
  } else if (displayRows.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="11">No holdings match this filter.</td></tr>';
  }

  const locked = state.portfolioLocked;
  displayRows.forEach(row => {
    const d = goldDerived(row);
    const pendingBadge = row.livePricePending ? '<span class="pending-badge">Pending</span>' : "";
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td class="left"><input type="text" value="${escapeAttr(row.name || "")}" data-field="name" placeholder="e.g. GOLDBEES.NS" ${locked ? "disabled" : ""}></td>
      <td class="left">
        <select data-field="form" ${locked ? "disabled" : ""}>
          <option value="Physical" ${row.form === "Physical" ? "selected" : ""}>Physical</option>
          <option value="Digital" ${row.form === "Digital" ? "selected" : ""}>Digital</option>
          <option value="SGB" ${row.form === "SGB" ? "selected" : ""}>SGB</option>
          <option value="ETF" ${row.form === "ETF" ? "selected" : ""}>ETF</option>
        </select>
      </td>
      <td><input type="number" step="any" value="${row.weight ?? ""}" data-field="weight" ${locked ? "disabled" : ""}></td>
      <td><input type="number" step="any" value="${row.purchaseRate ?? ""}" data-field="purchaseRate" ${locked ? "disabled" : ""}></td>
      <td><input type="number" step="any" value="${row.invested ?? ""}" data-field="invested" ${locked ? "disabled" : ""}></td>
      <td><div class="price-cell"><input type="number" step="any" value="${row.currentRate ?? ""}" data-field="currentRate" ${locked ? "disabled" : ""}>${pendingBadge}</div></td>
      <td class="c-cv">${fmtNum(d.currentValue)}</td>
      <td class="c-pl ${plClass(d.pl)}">${fmtNum(d.pl)}</td>
      <td class="c-plpct ${plClass(d.pl)}">${fmtPct(d.plPct)}</td>
      <td class="left"><input type="text" value="${escapeAttr(row.notes || "")}" data-field="notes" ${locked ? "disabled" : ""}></td>
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
}

document.getElementById("btnAddGold").addEventListener("click", () => {
  state.gold.push({ id: uid(), name: "", form: "ETF", weight: 0, purchaseRate: 0, invested: 0, currentRate: 0, notes: "" });
  saveState();
  renderGold();
  renderDashboard();
});

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

document.getElementById("btnRefreshGold").addEventListener("click", () => {
  runGoldRefresh(document.getElementById("goldFetchStatus"));
});

/* ============================================================
   DASHBOARD
   ============================================================ */

function renderDashboard() {
  const cashInput = document.getElementById("cashInput");
  if (document.activeElement !== cashInput) cashInput.value = state.cash || "";
  cashInput.disabled = state.portfolioLocked;

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
  const locked = state.portfolioLocked;
  classes.forEach(c => {
    const currentPct = netWorth > 0 ? (c.current / netWorth) * 100 : 0;
    const idealPct = Number(state.ideal[c.key]) || 0;
    const diffPct = currentPct - idealPct;
    const diffAmount = (diffPct / 100) * netWorth;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="left"><div class="alloc-name"><span class="swatch" style="background:${ASSET_COLORS[c.key]}"></span>${c.label}</div></td>
      <td>${fmtINR(c.current)}</td>
      <td>${fmtNum(currentPct)}%</td>
      <td><input class="ideal-input" type="number" step="any" value="${idealPct}" data-key="${c.key}" ${locked ? "disabled" : ""}></td>
      <td class="${plClass(diffPct)}">${diffPct >= 0 ? "+" : ""}${fmtNum(diffPct)}%</td>
      <td class="${plClass(diffAmount)}">${diffAmount >= 0 ? "+" : ""}${fmtINR(diffAmount)}</td>
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

document.getElementById("cashInput").addEventListener("change", (e) => {
  state.cash = parseFloat(e.target.value) || 0;
  saveState();
  renderDashboard();
});

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
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

// Stocks: Name/Symbol, Invested Amount, Units
document.getElementById("importStockFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const statusEl = document.getElementById("equityFetchStatus");
  if (!file) return;
  try {
    const rows = (await readWorkbookRows(file)).slice(1);
    let added = 0, updated = 0;
    rows.forEach(r => {
      const name = String(r[0] ?? "").trim();
      if (!name) return;
      // Blank Invested Amount / Units cells leave that field untouched
      // on an existing row (partial-column updates, e.g. re-importing
      // just to fix a name, won't zero out real data).
      const fields = { name };
      if (!cellIsBlank(r[1])) fields.invested = parseFloat(r[1]) || 0;
      if (!cellIsBlank(r[2])) fields.units = parseFloat(r[2]) || 0;
      const result = upsertRow(
        state.equity,
        row => (row.name || "").trim().toUpperCase() === name.toUpperCase(),
        fields,
        { ltp: 0 }
      );
      result === "added" ? added++ : updated++;
    });
    saveState();
    renderEquity();
    renderDashboard();
    statusEl.textContent = `Imported: ${added} new, ${updated} updated.`;
  } catch (err) {
    alert("Could not read that Excel file. Expected columns: Name/Symbol, Invested Amount, Units.");
  }
  e.target.value = "";
});

// Mutual Funds: Name, Symbol, Category, Sub-category, Units, Remarks
document.getElementById("importMFFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const statusEl = document.getElementById("mfFetchStatus");
  if (!file) return;
  try {
    const rows = (await readWorkbookRows(file)).slice(1);
    let added = 0, updated = 0;
    rows.forEach(r => {
      const name = String(r[0] ?? "").trim();
      if (!name) return;
      const symbol = String(r[1] ?? "").trim();
      // Blank cells leave that field untouched on an existing row, so
      // a sheet that only fills in Symbol/Category/Sub-category (e.g.
      // to wire up live NAV lookup) won't wipe out real Units.
      const fields = { name };
      if (symbol) fields.symbol = symbol;
      if (!cellIsBlank(r[2])) fields.category = String(r[2]).trim();
      if (!cellIsBlank(r[3])) fields.subcategory = String(r[3]).trim();
      if (!cellIsBlank(r[4])) fields.units = parseFloat(r[4]) || 0;
      if (!cellIsBlank(r[5])) fields.remarks = String(r[5]).trim();
      const result = upsertRow(
        state.mf,
        row => {
          // Prefer matching on an existing Symbol (the stable key once
          // a fund is mapped). But if the imported row has a Symbol
          // and the existing row doesn't have one yet — exactly the
          // "assign a Symbol to a fund for the first time" case — fall
          // back to matching by Name so this updates that row instead
          // of creating a duplicate.
          const rowSymbol = (row.symbol || "").trim().toUpperCase();
          const rowName = (row.name || "").trim().toUpperCase();
          if (symbol) {
            if (rowSymbol) return rowSymbol === symbol.toUpperCase();
            return rowName === name.toUpperCase();
          }
          return rowName === name.toUpperCase();
        },
        fields,
        { unitPrice: 0 }
      );
      result === "added" ? added++ : updated++;
    });
    saveState();
    renderMF();
    renderDashboard();
    statusEl.textContent = `Imported: ${added} new, ${updated} updated.`;
  } catch (err) {
    alert("Could not read that Excel file. Expected columns: Name, Symbol, Category, Sub-category, Units, Remarks.");
  }
  e.target.value = "";
});

// Gold: Name/Symbol, Form, Weight/Units, Purchase Rate, Invested Amount, Notes
document.getElementById("importGoldFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const statusEl = document.getElementById("goldFetchStatus");
  if (!file) return;
  try {
    const rows = (await readWorkbookRows(file)).slice(1);
    let added = 0, updated = 0;
    rows.forEach(r => {
      const name = String(r[0] ?? "").trim();
      if (!name) return;
      const formRaw = String(r[1] ?? "").trim();
      // Blank cells leave that field untouched on an existing row
      // (partial-column updates don't zero out real Weight/Invested).
      // Form always gets set (defaulting to ETF), matching the "new
      // rows default to ETF" convention used elsewhere.
      const fields = { name, form: ["Physical", "Digital", "SGB", "ETF"].includes(formRaw) ? formRaw : "ETF" };
      if (!cellIsBlank(r[2])) fields.weight = parseFloat(r[2]) || 0;
      if (!cellIsBlank(r[3])) fields.purchaseRate = parseFloat(r[3]) || 0;
      if (!cellIsBlank(r[4])) fields.invested = parseFloat(r[4]) || 0;
      if (!cellIsBlank(r[5])) fields.notes = String(r[5]).trim();
      const result = upsertRow(
        state.gold,
        row => (row.name || "").trim().toUpperCase() === name.toUpperCase(),
        fields,
        { currentRate: 0 }
      );
      result === "added" ? added++ : updated++;
    });
    saveState();
    renderGold();
    renderDashboard();
    statusEl.textContent = `Imported: ${added} new, ${updated} updated.`;
  } catch (err) {
    alert("Could not read that Excel file. Expected columns: Name/Symbol, Form, Weight/Units, Purchase Rate, Invested Amount, Notes.");
  }
  e.target.value = "";
});

// Debt / Fixed Income: Name, Category, Sub-category, Account No.,
// Invested Amount, ROI, Maturity Amount, Invested Date, Maturity
// Date, Tenure Months, Notes (Profit and Tenure Years are always
// calculated, never imported).
document.getElementById("importDebtFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const statusEl = document.getElementById("debtImportStatus");
  if (!file) return;
  try {
    const rows = (await readWorkbookRows(file)).slice(1);
    let count = 0;
    rows.forEach(r => {
      const name = String(r[0] ?? "").trim();
      if (!name) return;
      state.debt.push({
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
      });
      count++;
    });
    saveState();
    renderDebt();
    renderDashboard();
    statusEl.textContent = `Imported ${count} debt row(s) from Excel.`;
  } catch (err) {
    alert("Could not read that Excel file. Expected columns: Name, Category, Sub-category, Account No., Invested Amount, ROI, Maturity Amount, Invested Date, Maturity Date, Tenure Months, Notes.");
  }
  e.target.value = "";
});

/* ============================================================
   IMPORT ZERODHA HOLDINGS
   One workbook, three sheets named exactly "Stocks", "Mutual
   funds", "Gold" (Zerodha Console's Holdings export) — same file
   every time. Each of the three tabs (Equity, Mutual Funds, Gold)
   has its own "Import Zerodha Holdings" button; whichever button
   is used, only that tab's sheet is read and only that asset
   class's data is touched, even though the other two sheets are
   sitting in the same uploaded workbook. Each real holding is
   followed by two export-artifact rows (a stray quantity string,
   and a "ZZ..." code) — those are dropped by requiring both Qty.
   and Buy avg. to be present and numeric, rather than pattern-
   matching the "ZZ" text specifically.

   Matching: Equity and Gold match by Symbol against the app's
   Name field (same convention the live-price refresh already
   uses). Mutual Funds match by Name — Zerodha's MF "Symbol"
   column in this export is actually the full scheme name, not a
   code, and doesn't correspond to the app's own `symbol` field
   (which is reserved for the separate Google-Sheet live-NAV
   lookup) — so Name is the only reliable key here.

   Update logic: only Quantity/Units and Average Price/Invested
   are overwritten (never merged or averaged) — everything else,
   including any live-fetched price, is left untouched. Unmatched
   rows become new entries with livePricePending = true.
   ============================================================ */

const ZERODHA_SHEETS = { equity: "Stocks", mf: "Mutual funds", gold: "Gold" };

// Handles plain numbers, Indian-grouped strings ("4,12,685.77"),
// and stray non-breaking spaces from the export. Returns null for
// anything blank/non-numeric so callers can treat a row as invalid.
function parseIndianNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isNaN(v) ? null : v;
  const s = String(v).replace(/,/g, "").replace(/\u00a0/g, "").trim();
  if (s === "") return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Row 1 is the header (skipped). A row only counts as a real
// holding if it has both a Qty. and a Buy avg. — the two junk
// rows Zerodha's export leaves behind never have both, so this
// one rule is enough to filter them out.
function parseHoldingsSheetRows(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const symbol = String(r[0] ?? "").replace(/\u00a0/g, "").trim();
    const qty = parseIndianNumber(r[1]);
    const buyAvg = parseIndianNumber(r[2]);
    if (!symbol || qty === null || buyAvg === null) continue;
    const buyValue = parseIndianNumber(r[3]);
    out.push({ symbol, qty, buyAvg, buyValue: buyValue !== null ? buyValue : qty * buyAvg });
  }
  return out;
}

// Builds the match/add/duplicate plan for one asset class. Later
// occurrences of the same key within the import win (last row is
// treated as the true value); earlier ones are reported as
// duplicates rather than silently dropped.
function planAssetClass(importedRows, existingArray, keyFn, matchFn) {
  const byKey = new Map();
  const duplicateKeys = new Set();
  importedRows.forEach(r => {
    const k = keyFn(r);
    if (byKey.has(k)) duplicateKeys.add(k);
    byKey.set(k, r);
  });
  const matched = [];
  const added = [];
  byKey.forEach(r => {
    const existing = existingArray.find(row => matchFn(row, r));
    if (existing) matched.push({ existing, imported: r });
    else added.push(r);
  });
  return { matched, added, duplicateKeys: [...duplicateKeys] };
}

function singleAssetPlanSummaryHTML(label, plan) {
  let html = `<div class="import-stat-row">
    <div class="import-stat"><div class="n">${plan.matched.length}</div><div class="l">Will Update</div></div>
    <div class="import-stat"><div class="n">${plan.added.length}</div><div class="l">New Entries</div></div>
    <div class="import-stat ${plan.duplicateKeys.length ? "warn" : ""}"><div class="n">${plan.duplicateKeys.length}</div><div class="l">Duplicate Rows</div></div>
  </div>`;

  if (plan.matched.length === 0 && plan.added.length === 0) {
    html += `<p>No valid ${label} holdings found in this sheet — nothing to import.</p>`;
    return html;
  }

  html += `<ul>`;
  if (plan.matched.length) html += `<li>${plan.matched.length} existing entr${plan.matched.length === 1 ? "y" : "ies"} will have Quantity and Average Price overwritten: ${plan.matched.slice(0, 8).map(m => escapeAttr(m.imported.symbol)).join(", ")}${plan.matched.length > 8 ? "…" : ""}</li>`;
  if (plan.added.length) html += `<li>${plan.added.length} new entr${plan.added.length === 1 ? "y" : "ies"} will be added: ${plan.added.slice(0, 8).map(a => escapeAttr(a.symbol)).join(", ")}${plan.added.length > 8 ? "…" : ""}</li>`;
  if (plan.duplicateKeys.length) html += `<li class="warn">${plan.duplicateKeys.length} duplicate row(s) in the sheet — the last occurrence was used for each: ${plan.duplicateKeys.slice(0, 8).map(escapeAttr).join(", ")}</li>`;
  html += `</ul>`;

  return html;
}

function applyEquityZerodhaPlan(plan) {
  const newInvestments = [];
  plan.matched.forEach(({ existing, imported }) => {
    existing.invested = imported.buyValue;
    existing.units = imported.qty;
  });
  plan.added.forEach(imported => {
    state.equity.push({ id: uid(), name: imported.symbol, invested: imported.buyValue, units: imported.qty, ltp: 0, livePricePending: true });
    newInvestments.push({ name: imported.symbol, type: "Equity" });
  });
  saveState();
  renderEquity();
  renderDashboard();
  return newInvestments;
}

function applyGoldZerodhaPlan(plan) {
  const newInvestments = [];
  plan.matched.forEach(({ existing, imported }) => {
    existing.invested = imported.buyValue;
    existing.weight = imported.qty;
    existing.purchaseRate = imported.buyAvg;
  });
  plan.added.forEach(imported => {
    state.gold.push({ id: uid(), name: imported.symbol, form: "ETF", weight: imported.qty, purchaseRate: imported.buyAvg, invested: imported.buyValue, currentRate: 0, notes: "", livePricePending: true });
    newInvestments.push({ name: imported.symbol, type: "Gold" });
  });
  saveState();
  renderGold();
  renderDashboard();
  return newInvestments;
}

// Looks up a fund's Symbol/Category/Sub-category on the live-price
// Google Sheet's Mutual Funds tab (matched by fund name — Zerodha's
// MF "Symbol" column is really the scheme name, same convention used
// for the match itself). Returns null if the sheet has no row for
// that name, or if categoryMap is null (lookup wasn't available).
function lookupMFCategoryData(name, categoryMap) {
  if (!categoryMap) return null;
  return categoryMap.get(String(name || "").trim().toUpperCase()) || null;
}

// existing/new rows only have Symbol/Category/Sub-category overwritten
// when the sheet actually has a non-blank value for that specific
// field — a blank column on the sheet leaves whatever was already
// there untouched, same "don't clobber with blank" rule used by the
// per-tab Excel importers.
function applyMFCategoryData(row, catData) {
  if (!catData) return;
  if (catData.symbol) row.symbol = catData.symbol;
  if (catData.category) row.category = catData.category;
  if (catData.subcategory) row.subcategory = catData.subcategory;
}

function applyMFZerodhaPlan(plan, categoryMap) {
  const newInvestments = [];
  plan.matched.forEach(({ existing, imported }) => {
    existing.invested = imported.buyValue;
    existing.units = imported.qty;
    applyMFCategoryData(existing, lookupMFCategoryData(imported.symbol, categoryMap));
  });
  plan.added.forEach(imported => {
    const row = { id: uid(), name: imported.symbol, symbol: "", category: "", subcategory: "", invested: imported.buyValue, units: imported.qty, unitPrice: 0, remarks: "", livePricePending: true };
    applyMFCategoryData(row, lookupMFCategoryData(imported.symbol, categoryMap));
    state.mf.push(row);
    newInvestments.push({ name: imported.symbol, type: "Mutual Fund" });
  });
  saveState();
  renderMF();
  renderDashboard();
  return newInvestments;
}

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

// One button per tab (Equity / Mutual Funds / Gold), each reading the
// *same* Zerodha Console Holdings export workbook but only looking at
// its own sheet ("Stocks" / "Mutual funds" / "Gold") and only touching
// that one asset class's data — so importing on the Equity tab never
// touches Mutual Funds or Gold, even though all three live in the one
// uploaded file.
const ZERODHA_TAB_CONFIG = {
  equity: { sheetName: ZERODHA_SHEETS.equity, label: "Equity (Stocks)", getExisting: () => state.equity, apply: applyEquityZerodhaPlan },
  mf:     { sheetName: ZERODHA_SHEETS.mf,     label: "Mutual Funds",    getExisting: () => state.mf,     apply: applyMFZerodhaPlan, needsCategoryEnrich: true },
  gold:   { sheetName: ZERODHA_SHEETS.gold,   label: "Gold",            getExisting: () => state.gold,   apply: applyGoldZerodhaPlan }
};

// Counts, out of `names`, how many have a row in categoryMap — used
// to tell Ganesh up front how many funds will actually get Symbol/
// Category/Sub-category auto-filled vs. left as-is.
function countCategoryMatches(names, categoryMap) {
  let found = 0;
  names.forEach(n => { if (categoryMap.has(String(n || "").trim().toUpperCase())) found++; });
  return { found, total: names.length };
}

function setupZerodhaTabImport(inputId, assetKey) {
  const cfg = ZERODHA_TAB_CONFIG[assetKey];
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    let sheetFound = false;
    let rows = [];
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: "array", cellDates: true });
      const ws = wb.Sheets[cfg.sheetName];
      sheetFound = !!ws;
      if (ws) rows = parseHoldingsSheetRows(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }));
    } catch (err) {
      alert(`Could not read that file. Expected a Zerodha Console Holdings export (.xlsx) with a "${cfg.sheetName}" sheet.`);
      e.target.value = "";
      return;
    }
    if (!sheetFound) {
      alert(`That workbook doesn't have a sheet named exactly "${cfg.sheetName}" — check the tab name in the Zerodha export (the file can still contain the other asset classes' sheets too; only "${cfg.sheetName}" is read here).`);
      e.target.value = "";
      return;
    }
    const norm = s => String(s || "").trim().toUpperCase();
    const plan = planAssetClass(rows, cfg.getExisting(), r => norm(r.symbol), (row, r) => norm(row.name) === norm(r.symbol));

    // Mutual Funds only: also fetch the live-price sheet so Symbol/
    // Category/Sub-category can be auto-filled alongside Units/
    // Invested, instead of needing a separate manual Excel import.
    let categoryMap = null;
    let categoryFetchError = null;
    let categoryHTML = "";
    if (cfg.needsCategoryEnrich) {
      const statusEl = document.getElementById("mfFetchStatus");
      if (statusEl) statusEl.textContent = "Fetching Category/Sub-category/Symbol from live-price sheet...";
      try {
        const data = await fetchPriceData();
        categoryMap = buildMFCategoryMap(data.mf);
      } catch (err) {
        categoryFetchError = err;
      }
      if (statusEl) statusEl.textContent = "";
      if (categoryFetchError) {
        categoryHTML = `<p style="color:var(--negative)">Could not fetch Symbol/Category/Sub-category from your live-price sheet (${escapeAttr(sheetErrorMessage(categoryFetchError))}). Units and Invested Amount will still be updated normally — Symbol/Category/Sub-category will be left as they are.</p>`;
      } else {
        const allNames = [...plan.matched.map(m => m.imported.symbol), ...plan.added.map(a => a.symbol)];
        const stats = countCategoryMatches(allNames, categoryMap);
        categoryHTML = `<p>${stats.found} of ${stats.total} fund(s) matched a row on your live-price sheet's Mutual Funds tab — Symbol, Category and Sub-category will be filled in for those automatically. The rest are left as-is; add them to the sheet and re-import to pick them up.</p>`;
      }
    }

    openModal(
      `Import Zerodha Holdings — ${cfg.label} — Preview`,
      singleAssetPlanSummaryHTML(cfg.label, plan) + categoryHTML,
      [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Confirm Import", primary: true, onClick: () => {
            const newInvestments = cfg.apply(plan, categoryMap);
            closeModal();
            showNewInvestmentsReminder(newInvestments);
          }
        }
      ]
    );
    e.target.value = "";
  });
}

setupZerodhaTabImport("importZerodhaEquityFile", "equity");
setupZerodhaTabImport("importZerodhaMFFile", "mf");
setupZerodhaTabImport("importZerodhaGoldFile", "gold");

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

document.getElementById("btnExport").addEventListener("click", () => {
  downloadBackup();
  state.lastBackup = new Date().toISOString();
  saveState();
});

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
  const eqRows = [["Name/Symbol", "Invested Amount", "Units", "Avg Price", "LTP", "Current Value", "P&L", "P&L %", "Alloc %"]];
  state.equity.forEach(r => {
    const d = equityDerived(r);
    const allocPct = eq.invested > 0 ? (Number(r.invested) / eq.invested) * 100 : 0;
    eqRows.push([r.name, r.invested, r.units, d.avgPrice, r.ltp, d.currentValue, d.pl, d.plPct, allocPct]);
  });
  const wsEq = XLSX.utils.aoa_to_sheet(eqRows);
  wsEq["!cols"] = [{ wch: 20 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsEq, "Stock Holdings");

  // Mutual Funds
  const mfRows = [["Name", "Symbol", "Category", "Sub-category", "Invested Amount", "Units", "Avg Price", "NAV", "Current Value", "P&L", "P&L %", "Remarks"]];
  state.mf.forEach(r => {
    const d = mfDerived(r);
    mfRows.push([r.name, r.symbol, r.category, r.subcategory, r.invested, r.units, d.avgPrice, r.unitPrice, d.currentValue, d.pl, d.plPct, r.remarks]);
  });
  const wsMF = XLSX.utils.aoa_to_sheet(mfRows);
  wsMF["!cols"] = [{ wch: 28 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 22 }];
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

document.getElementById("btnExportExcel").addEventListener("click", () => {
  try {
    const wb = buildExcelWorkbook();
    XLSX.writeFile(wb, `networth-backup-${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) {
    console.error("Excel export failed:", e);
    alert("Could not build the Excel export: " + (e && e.message ? e.message : "unknown error"));
  }
});

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

setupColumnResize("col-eq-name", "#panel-equity .col-resizer");
setupColumnResize("col-debt-name", "#panel-debt .col-resizer");
setupColumnResize("col-mf-name", "#panel-mf .col-resizer");
setupColumnResize("col-gold-name", "#panel-gold .col-resizer");

updateLockButton();
renderAll();
maybeRunWeeklyBackup();
initCloudSync();

// Auto-refresh live prices on open, per tab (Debt is intentionally
// skipped — it has no live-price mechanism). Runs quietly in the
// background; each tab's own status tag and fail panel update in
// place once its fetch resolves, same as clicking Refresh by hand.
runEquityRefresh(document.getElementById("equityFetchStatus"));
runMFRefresh(document.getElementById("mfFetchStatus"));
runGoldRefresh(document.getElementById("goldFetchStatus"));
