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
    lastBackup: null
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
  scheduleCloudSync();
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

  displayRows.forEach(row => {
    const d = equityDerived(row);
    // Alloc % reflects each stock's share of total invested capital,
    // not its share of current market value.
    const allocPct = totals.invested > 0 ? (Number(row.invested) / totals.invested) * 100 : 0;
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td class="left"><input type="text" value="${escapeAttr(row.name || "")}" data-field="name" placeholder="e.g. TCS.NS"></td>
      <td><input type="number" step="any" value="${row.invested ?? ""}" data-field="invested"></td>
      <td><input type="number" step="any" value="${row.units ?? ""}" data-field="units"></td>
      <td class="c-avg">${fmtNum(d.avgPrice)}</td>
      <td><input type="number" step="any" value="${row.ltp ?? ""}" data-field="ltp"></td>
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

/* ---- live price fetch: stocks ---- */

document.getElementById("btnRefreshStocks").addEventListener("click", async () => {
  const statusEl = document.getElementById("equityFetchStatus");
  if (state.equity.length === 0) {
    statusEl.textContent = "No stocks to refresh.";
    return;
  }
  statusEl.textContent = "Fetching...";
  let ok = 0, fail = 0;
  try {
    const data = await fetchPriceData();
    const priceMap = buildPriceMap(data.stocks, ["Stock Name", "Symbol"], ["Live Price", "Price"]);
    state.equity.forEach(row => {
      const key = (row.name || "").trim().toUpperCase();
      if (key && priceMap.has(key)) { row.ltp = priceMap.get(key); ok++; }
      else fail++;
    });
  } catch (e) {
    statusEl.textContent = sheetErrorMessage(e);
    return;
  }
  saveState();
  renderEquity();
  renderDashboard();
  statusEl.textContent = `Updated ${ok} of ${ok + fail}. ${fail > 0 ? "Failed rows: check symbol format (e.g. RELIANCE.NS) or edit LTP manually." : ""}`;
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

  displayRows.forEach(row => {
    const d = debtDerived(row);
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td class="left"><input type="text" value="${escapeAttr(row.name || "")}" data-field="name"></td>
      <td class="left"><input type="text" value="${escapeAttr(row.category || "")}" data-field="category"></td>
      <td class="left"><input type="text" value="${escapeAttr(row.subcategory || "")}" data-field="subcategory"></td>
      <td class="left"><input type="text" value="${escapeAttr(row.account || "")}" data-field="account"></td>
      <td><input type="number" step="any" value="${row.invested ?? ""}" data-field="invested"></td>
      <td><input type="number" step="any" value="${row.roi ?? ""}" data-field="roi"></td>
      <td><input type="number" step="any" value="${row.maturityAmount ?? ""}" data-field="maturityAmount"></td>
      <td class="c-profit ${plClass(d.profit)}">${fmtNum(d.profit)}</td>
      <td><input type="date" value="${row.investedDate || ""}" data-field="investedDate"></td>
      <td><input type="date" value="${row.maturityDate || ""}" data-field="maturityDate"></td>
      <td><input type="number" step="any" value="${row.tenureMonths ?? ""}" data-field="tenureMonths"></td>
      <td class="c-years">${fmtNum(d.years, 1)}</td>
      <td class="left"><input type="text" value="${escapeAttr(row.notes || "")}" data-field="notes"></td>
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

function mfDerived(row) {
  const unitPrice = Number(row.unitPrice) || 0;
  const units = Number(row.units) || 0;
  const amount = unitPrice * units;
  return { amount };
}

function mfTotals() {
  let amount = 0;
  state.mf.forEach(r => { amount += mfDerived(r).amount; });
  return { amount };
}

function mfGetSearchText(row) {
  const d = mfDerived(row);
  return [row.name, row.symbol, row.category, row.subcategory, row.unitPrice, row.units, d.amount, row.remarks].join(" ");
}

function mfGetSortValue(row, col) {
  const d = mfDerived(row);
  switch (col) {
    case "name": return row.name || "";
    case "symbol": return row.symbol || "";
    case "category": return row.category || "";
    case "subcategory": return row.subcategory || "";
    case "unitPrice": return Number(row.unitPrice) || 0;
    case "units": return Number(row.units) || 0;
    case "amount": return d.amount;
    case "allocPct": return d.amount;
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
    tbody.innerHTML = '<tr class="empty-row"><td colspan="10">No mutual funds added yet. Click "+ Add fund" to begin.</td></tr>';
  } else if (displayRows.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="10">No funds match this filter.</td></tr>';
  }

  displayRows.forEach(row => {
    const d = mfDerived(row);
    const allocPct = totals.amount > 0 ? (d.amount / totals.amount) * 100 : 0;
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td class="left"><input type="text" value="${escapeAttr(row.name || "")}" data-field="name"></td>
      <td class="left"><input type="text" value="${escapeAttr(row.symbol || "")}" data-field="symbol" placeholder="Symbol"></td>
      <td class="left"><input type="text" value="${escapeAttr(row.category || "")}" data-field="category"></td>
      <td class="left"><input type="text" value="${escapeAttr(row.subcategory || "")}" data-field="subcategory"></td>
      <td><input type="number" step="any" value="${row.unitPrice ?? ""}" data-field="unitPrice"></td>
      <td><input type="number" step="any" value="${row.units ?? ""}" data-field="units"></td>
      <td class="c-amount">${fmtNum(d.amount)}</td>
      <td class="c-alloc">${fmtNum(allocPct)}%</td>
      <td class="left"><input type="text" value="${escapeAttr(row.remarks || "")}" data-field="remarks"></td>
      <td class="row-actions"><button class="icon-btn" title="Remove">✕</button></td>
    `;
    tr.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("change", () => {
        const field = inp.dataset.field;
        const numericFields = ["unitPrice", "units"];
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

  document.getElementById("mfTotalAmount").textContent = fmtINR(totals.amount);
}

function updateMFComputed() {
  const tbody = document.getElementById("mfTableBody");
  const totals = mfTotals();
  state.mf.forEach(row => {
    const tr = tbody.querySelector(`tr[data-id="${row.id}"]`);
    if (!tr) return;
    const d = mfDerived(row);
    const allocPct = totals.amount > 0 ? (d.amount / totals.amount) * 100 : 0;
    tr.querySelector(".c-amount").textContent = fmtNum(d.amount);
    tr.querySelector(".c-alloc").textContent = fmtNum(allocPct) + "%";
  });
  document.getElementById("mfTotalAmount").textContent = fmtINR(totals.amount);
}

document.getElementById("btnAddMF").addEventListener("click", () => {
  state.mf.push({ id: uid(), name: "", symbol: "", category: "", subcategory: "", unitPrice: 0, units: 0, remarks: "" });
  saveState();
  renderMF();
  renderDashboard();
});

/* ---- live NAV fetch: mutual funds (Google Sheet, refreshed by Apps Script) ---- */

document.getElementById("btnRefreshMF").addEventListener("click", async () => {
  const statusEl = document.getElementById("mfFetchStatus");
  if (state.mf.length === 0) {
    statusEl.textContent = "No funds to refresh.";
    return;
  }
  statusEl.textContent = "Fetching...";
  let ok = 0, fail = 0;
  try {
    const data = await fetchPriceData();
    const navMap = buildPriceMap(data.mf, ["MF Name", "Symbol"], ["Live Price", "NAV", "Price"]);
    state.mf.forEach(row => {
      const key = (row.symbol || "").trim().toUpperCase();
      if (key && navMap.has(key)) { row.unitPrice = navMap.get(key); ok++; }
      else fail++;
    });
  } catch (e) {
    statusEl.textContent = sheetErrorMessage(e);
    return;
  }
  saveState();
  renderMF();
  renderDashboard();
  statusEl.textContent = `Updated ${ok} of ${ok + fail}. ${fail > 0 ? "Unmatched rows: check the Symbol matches your sheet exactly, or edit NAV manually." : ""}`;
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

  displayRows.forEach(row => {
    const d = goldDerived(row);
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td class="left"><input type="text" value="${escapeAttr(row.name || "")}" data-field="name" placeholder="e.g. GOLDBEES.NS"></td>
      <td class="left">
        <select data-field="form">
          <option value="Physical" ${row.form === "Physical" ? "selected" : ""}>Physical</option>
          <option value="Digital" ${row.form === "Digital" ? "selected" : ""}>Digital</option>
          <option value="SGB" ${row.form === "SGB" ? "selected" : ""}>SGB</option>
          <option value="ETF" ${row.form === "ETF" ? "selected" : ""}>ETF</option>
        </select>
      </td>
      <td><input type="number" step="any" value="${row.weight ?? ""}" data-field="weight"></td>
      <td><input type="number" step="any" value="${row.purchaseRate ?? ""}" data-field="purchaseRate"></td>
      <td><input type="number" step="any" value="${row.invested ?? ""}" data-field="invested"></td>
      <td><input type="number" step="any" value="${row.currentRate ?? ""}" data-field="currentRate"></td>
      <td class="c-cv">${fmtNum(d.currentValue)}</td>
      <td class="c-pl ${plClass(d.pl)}">${fmtNum(d.pl)}</td>
      <td class="c-plpct ${plClass(d.pl)}">${fmtPct(d.plPct)}</td>
      <td class="left"><input type="text" value="${escapeAttr(row.notes || "")}" data-field="notes"></td>
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

document.getElementById("btnRefreshGold").addEventListener("click", async () => {
  const statusEl = document.getElementById("goldFetchStatus");
  if (state.gold.length === 0) {
    statusEl.textContent = "No holdings to refresh.";
    return;
  }
  statusEl.textContent = "Fetching...";
  let ok = 0, fail = 0;
  try {
    const data = await fetchPriceData();
    const priceMap = buildPriceMap(data.gold, ["Stock Name", "Symbol"], ["Live Price", "Price"]);
    state.gold.forEach(row => {
      const key = (row.name || "").trim().toUpperCase();
      if (key && priceMap.has(key)) { row.currentRate = priceMap.get(key); ok++; }
      else fail++;
    });
  } catch (e) {
    statusEl.textContent = sheetErrorMessage(e);
    return;
  }
  saveState();
  renderGold();
  renderDashboard();
  statusEl.textContent = `Updated ${ok} of ${ok + fail}. ${fail > 0 ? "Unmatched rows: check the Symbol matches your sheet exactly (e.g. GOLDBEES.NS)." : ""}`;
});

/* ============================================================
   DASHBOARD
   ============================================================ */

function renderDashboard() {
  const cashInput = document.getElementById("cashInput");
  if (document.activeElement !== cashInput) cashInput.value = state.cash || "";

  const eq = equityTotals();
  const debt = debtTotals();
  const mf = mfTotals();
  const gold = goldTotals();
  const cash = Number(state.cash) || 0;

  const classes = [
    { key: "cash",   label: "Cash",                     current: cash,          invested: cash },
    { key: "debt",   label: "Debt / Fixed Investments",  current: debt.invested, invested: debt.invested },
    { key: "mf",     label: "Equity Mutual Funds",       current: mf.amount,     invested: mf.amount },
    { key: "equity", label: "Equity Stocks",             current: eq.current,    invested: eq.invested },
    { key: "gold",   label: "Gold",                      current: gold.current,  invested: gold.invested }
  ];

  const netWorth = classes.reduce((s, c) => s + c.current, 0);
  const totalInvested = debt.invested + mf.amount + eq.invested + gold.invested; // cash excluded from "invested"
  const overallPL = eq.pl + gold.pl; // debt/mf/cash don't have a live mark-to-market P&L here
  const overallPLBase = eq.invested + gold.invested;
  const overallPLPct = overallPLBase > 0 ? (overallPL / overallPLBase) * 100 : 0;

  document.getElementById("statNetWorth").textContent = fmtINR(netWorth);
  document.getElementById("statTotalInvested").textContent = fmtINR(totalInvested);
  const plEl = document.getElementById("statOverallPL");
  plEl.textContent = fmtINR(overallPL);
  plEl.className = "value " + plClass(overallPL);
  const plPctEl = document.getElementById("statOverallPLPct");
  plPctEl.textContent = fmtPct(overallPLPct) + " (Equity + Gold only)";

  // allocation table
  const idealTotal = Object.values(state.ideal).reduce((a, b) => a + (Number(b) || 0), 0);
  const tbody = document.getElementById("allocTableBody");
  tbody.innerHTML = "";
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
      <td><input class="ideal-input" type="number" step="any" value="${idealPct}" data-key="${c.key}"></td>
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
      const fields = { name, invested: parseFloat(r[1]) || 0, units: parseFloat(r[2]) || 0 };
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
      const fields = {
        name, symbol,
        category: String(r[2] ?? "").trim(),
        subcategory: String(r[3] ?? "").trim(),
        units: parseFloat(r[4]) || 0,
        remarks: String(r[5] ?? "").trim()
      };
      const result = upsertRow(
        state.mf,
        row => symbol
          ? (row.symbol || "").trim().toUpperCase() === symbol.toUpperCase()
          : (row.name || "").trim().toUpperCase() === name.toUpperCase(),
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
      const form = String(r[1] ?? "Physical").trim();
      const fields = {
        name,
        form: ["Physical", "Digital", "SGB", "ETF"].includes(form) ? form : "ETF",
        weight: parseFloat(r[2]) || 0,
        purchaseRate: parseFloat(r[3]) || 0,
        invested: parseFloat(r[4]) || 0,
        notes: String(r[5] ?? "").trim()
      };
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
   EXPORT TO EXCEL (full human-readable backup)
   Builds a multi-sheet workbook entirely in the browser via
   SheetJS (already loaded for the Import from Excel feature).
   Dashboard Summary is informational only — Settings is what
   actually round-trips cash/ideal-allocation on restore.
   ============================================================ */

function sheetFromRows(headerRow, dataRows, colWidths) {
  const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  if (colWidths) ws["!cols"] = colWidths.map(w => ({ wch: w }));
  return ws;
}

function buildBackupWorkbook() {
  const wb = XLSX.utils.book_new();
  const eq = equityTotals(), debt = debtTotals(), mf = mfTotals(), gold = goldTotals();
  const cash = Number(state.cash) || 0;
  const netWorth = cash + debt.invested + mf.amount + eq.current + gold.current;

  // --- Dashboard Summary ---
  const classes = [
    { label: "Cash", current: cash },
    { label: "Debt / Fixed Investments", current: debt.invested },
    { label: "Equity Mutual Funds", current: mf.amount },
    { label: "Equity Stocks", current: eq.current },
    { label: "Gold", current: gold.current }
  ];
  const summaryRows = [
    ["Net Worth", netWorth],
    ["Total Amount Invested", debt.invested + mf.amount + eq.invested + gold.invested],
    ["Overall Profit/Loss (Equity + Gold)", eq.pl + gold.pl],
    ["Cash on Hand", cash],
    ["Last Saved", state.lastSaved ? new Date(state.lastSaved).toLocaleString() : ""],
    [],
    ["Asset Class", "Current Value", "Current %", "Ideal %", "Diff %", "Diff Amount"],
    ...classes.map(c => {
      const currentPct = netWorth > 0 ? (c.current / netWorth) * 100 : 0;
      const idealPct = Number(state.ideal[c.label === "Cash" ? "cash" : c.label.includes("Debt") ? "debt" : c.label.includes("Mutual") ? "mf" : c.label.includes("Stocks") ? "equity" : "gold"]) || 0;
      const diffPct = currentPct - idealPct;
      return [c.label, c.current, +currentPct.toFixed(2), idealPct, +diffPct.toFixed(2), +((diffPct / 100) * netWorth).toFixed(2)];
    })
  ];
  const summaryWs = XLSX.utils.aoa_to_sheet(summaryRows);
  summaryWs["!cols"] = [{ wch: 30 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, summaryWs, "Dashboard Summary");

  // --- Stock Holdings ---
  const eqRows = state.equity.map(r => {
    const d = equityDerived(r);
    return [r.name, r.invested, r.units, +d.avgPrice.toFixed(2), r.ltp, +d.currentValue.toFixed(2), +d.pl.toFixed(2), +d.plPct.toFixed(2), eq.invested > 0 ? +((r.invested / eq.invested) * 100).toFixed(2) : 0];
  });
  XLSX.utils.book_append_sheet(wb, sheetFromRows(
    ["Name/Symbol", "Invested Amount", "Units", "Avg Price", "LTP", "Current Value", "P&L", "P&L %", "Alloc % (Invested)"],
    eqRows, [16, 14, 8, 10, 10, 14, 12, 10, 16]
  ), "Stock Holdings");

  // --- Mutual Funds ---
  const mfRows = state.mf.map(r => {
    const d = mfDerived(r);
    return [r.name, r.symbol, r.category, r.subcategory, r.unitPrice, r.units, +d.amount.toFixed(2), mf.amount > 0 ? +((d.amount / mf.amount) * 100).toFixed(2) : 0, r.remarks];
  });
  XLSX.utils.book_append_sheet(wb, sheetFromRows(
    ["Name", "Symbol", "Category", "Sub-category", "NAV", "Units", "Amount", "Alloc %", "Remarks"],
    mfRows, [22, 16, 12, 14, 10, 10, 12, 10, 20]
  ), "Mutual Funds");

  // --- Gold ---
  const goldRows = state.gold.map(r => {
    const d = goldDerived(r);
    return [r.name, r.form, r.weight, r.purchaseRate, r.invested, r.currentRate, +d.currentValue.toFixed(2), +d.pl.toFixed(2), +d.plPct.toFixed(2), r.notes];
  });
  XLSX.utils.book_append_sheet(wb, sheetFromRows(
    ["Name/Symbol", "Form", "Weight/Units", "Purchase Rate", "Invested Amount", "Current Rate", "Current Value", "P&L", "P&L %", "Notes"],
    goldRows, [16, 10, 12, 12, 14, 12, 14, 12, 10, 20]
  ), "Gold");

  // --- Debt / Fixed Income ---
  const debtRows = state.debt.map(r => {
    const d = debtDerived(r);
    return [r.name, r.category, r.subcategory, r.account, r.invested, r.roi, r.maturityAmount, +d.profit.toFixed(2), r.investedDate, r.maturityDate, r.tenureMonths, +d.years.toFixed(1), r.notes];
  });
  XLSX.utils.book_append_sheet(wb, sheetFromRows(
    ["Name", "Category", "Sub-category", "Account No.", "Invested Amount", "ROI %", "Maturity Amount", "Profit", "Invested Date", "Maturity Date", "Tenure (Mo)", "Tenure (Yr)", "Notes"],
    debtRows, [18, 12, 14, 14, 14, 8, 14, 12, 14, 14, 10, 10, 20]
  ), "Debt");

  // --- Settings (round-trips on restore) ---
  const settingsRows = [
    ["Cash on Hand", cash],
    [],
    ["Ideal Allocation %", ""],
    ["Cash", state.ideal.cash],
    ["Debt", state.ideal.debt],
    ["Mutual Funds", state.ideal.mf],
    ["Equity", state.ideal.equity],
    ["Gold", state.ideal.gold]
  ];
  XLSX.utils.book_append_sheet(wb, sheetFromRows(["Setting", "Value"], settingsRows, [22, 14]), "Settings");

  return wb;
}

document.getElementById("btnExportExcel").addEventListener("click", () => {
  const wb = buildBackupWorkbook();
  XLSX.writeFile(wb, `networth-backup-${new Date().toISOString().slice(0, 10)}.xlsx`);
});

/* ---- Restore from Excel: full-state rebuild from a backup workbook ----
   This REPLACES all current holdings/settings — unlike the per-tab
   Import from Excel (which appends/upserts), this is meant for
   disaster recovery: rebuilding everything from one backup file. */

function sheetRows(wb, name) {
  const sheet = wb.Sheets[name];
  if (!sheet) return null;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}

document.getElementById("restoreExcelFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const proceed = confirm(
    "This will REPLACE all current holdings and settings with the contents of this Excel file. " +
    "This cannot be undone (though your last JSON export, if any, would still be safe). Continue?"
  );
  if (!proceed) { e.target.value = ""; return; }

  try {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: "array", cellDates: true });

    const newState = blankState();

    const eqRows = sheetRows(wb, "Stock Holdings");
    if (eqRows) {
      eqRows.slice(1).forEach(r => {
        const name = String(r[0] ?? "").trim();
        if (!name) return;
        newState.equity.push({ id: uid(), name, invested: parseFloat(r[1]) || 0, units: parseFloat(r[2]) || 0, ltp: parseFloat(r[4]) || 0 });
      });
    }

    const mfRows = sheetRows(wb, "Mutual Funds");
    if (mfRows) {
      mfRows.slice(1).forEach(r => {
        const name = String(r[0] ?? "").trim();
        if (!name) return;
        newState.mf.push({
          id: uid(), name, symbol: String(r[1] ?? "").trim(), category: String(r[2] ?? "").trim(),
          subcategory: String(r[3] ?? "").trim(), unitPrice: parseFloat(r[4]) || 0, units: parseFloat(r[5]) || 0,
          remarks: String(r[8] ?? "").trim()
        });
      });
    }

    const goldRows = sheetRows(wb, "Gold");
    if (goldRows) {
      goldRows.slice(1).forEach(r => {
        const name = String(r[0] ?? "").trim();
        if (!name) return;
        const form = String(r[1] ?? "ETF").trim();
        newState.gold.push({
          id: uid(), name, form: ["Physical", "Digital", "SGB", "ETF"].includes(form) ? form : "ETF",
          weight: parseFloat(r[2]) || 0, purchaseRate: parseFloat(r[3]) || 0, invested: parseFloat(r[4]) || 0,
          currentRate: parseFloat(r[5]) || 0, notes: String(r[9] ?? "").trim()
        });
      });
    }

    const debtRows = sheetRows(wb, "Debt");
    if (debtRows) {
      debtRows.slice(1).forEach(r => {
        const name = String(r[0] ?? "").trim();
        if (!name) return;
        newState.debt.push({
          id: uid(), name, category: String(r[1] ?? "").trim(), subcategory: String(r[2] ?? "").trim(),
          account: String(r[3] ?? "").trim(), invested: parseFloat(r[4]) || 0, roi: parseFloat(r[5]) || 0,
          maturityAmount: parseFloat(r[6]) || 0, investedDate: toDateInputValue(r[8]), maturityDate: toDateInputValue(r[9]),
          tenureMonths: parseFloat(r[10]) || 0, notes: String(r[12] ?? "").trim()
        });
      });
    }

    const settingsRows = sheetRows(wb, "Settings");
    if (settingsRows) {
      settingsRows.forEach(r => {
        const label = String(r[0] ?? "").trim();
        const val = parseFloat(r[1]);
        if (label === "Cash on Hand" && !isNaN(val)) newState.cash = val;
        if (label === "Cash") newState.ideal.cash = isNaN(val) ? newState.ideal.cash : val;
        if (label === "Debt") newState.ideal.debt = isNaN(val) ? newState.ideal.debt : val;
        if (label === "Mutual Funds") newState.ideal.mf = isNaN(val) ? newState.ideal.mf : val;
        if (label === "Equity") newState.ideal.equity = isNaN(val) ? newState.ideal.equity : val;
        if (label === "Gold") newState.ideal.gold = isNaN(val) ? newState.ideal.gold : val;
      });
    }

    state = newState;
    saveState();
    renderAll();
    alert("Restore complete — all holdings and settings were rebuilt from this Excel file.");
  } catch (err) {
    alert("Could not restore from that file. Make sure it's a backup produced by 'Export to Excel' from this app.");
  }
  e.target.value = "";
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
   One document per signed-in user (keyed by their Google uid)
   holds the full app state, mirroring the localStorage shape.
   localStorage stays the instant local cache — every UI action
   still reads/writes it exactly as before — and a debounced
   background push mirrors changes to Firestore whenever signed
   in. Conflict handling is recency-based, not a true merge: on
   sign-in (including a restored session on page load), whichever
   copy — local or cloud — was saved more recently wins and gets
   loaded. This is a known, disclosed tradeoff for a single-user
   tool, not a full multi-device merge.
   ============================================================ */

const firebaseConfig = {
  apiKey: "AIzaSyDhaP5WPnVHD5PXTg3O6wJeJOlG51NJ6xI",
  authDomain: "networth-tracker-f101b.firebaseapp.com",
  projectId: "networth-tracker-f101b",
  storageBucket: "networth-tracker-f101b.firebasestorage.app",
  messagingSenderId: "638244383857",
  appId: "1:638244383857:web:84431ad971b2fee7e47fd0"
};

let fbAuth = null, fbDb = null, cloudUser = null, cloudSyncTimer = null;

function initFirebase() {
  try {
    firebase.initializeApp(firebaseConfig);
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
  } catch (err) {
    console.error("Firebase failed to initialize:", err);
    const statusEl = document.getElementById("cloudSyncStatus");
    if (statusEl) statusEl.textContent = "Cloud sync unavailable";
  }
}

function setCloudStatus(text) {
  const el = document.getElementById("cloudSyncStatus");
  if (el) el.textContent = text;
}

function updateCloudButton() {
  const btn = document.getElementById("btnCloudSignIn");
  if (!btn) return;
  if (cloudUser) {
    btn.textContent = "Sign out (" + (cloudUser.displayName || cloudUser.email || "account") + ")";
  } else {
    btn.textContent = "Sign in with Google";
    setCloudStatus("");
  }
}

async function pushToCloud() {
  if (!cloudUser || !fbDb) return;
  setCloudStatus("Syncing…");
  try {
    await fbDb.collection("portfolios").doc(cloudUser.uid).set({
      state,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    setCloudStatus("Synced " + new Date().toLocaleTimeString());
  } catch (err) {
    console.error("Cloud push failed:", err);
    setCloudStatus("Cloud sync error — will retry on next change");
  }
}

// Called from saveState() on every local change. Debounced so
// rapid edits (e.g. typing) don't fire a write per keystroke.
function scheduleCloudSync() {
  if (!cloudUser) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(pushToCloud, 2000);
}

// Runs once per sign-in event (fresh popup login, or a restored
// session on page load). Resolves local-vs-cloud by recency.
async function resolveCloudSync() {
  if (!cloudUser || !fbDb) return;
  setCloudStatus("Checking cloud data…");
  try {
    const snap = await fbDb.collection("portfolios").doc(cloudUser.uid).get();
    if (!snap.exists) {
      // First time this account has connected — seed the cloud
      // copy from whatever's on this device right now.
      await pushToCloud();
      return;
    }
    const cloudData = snap.data();
    const cloudUpdatedAt = cloudData.updatedAt && cloudData.updatedAt.toMillis ? cloudData.updatedAt.toMillis() : 0;
    const localUpdatedAt = state.lastSaved ? new Date(state.lastSaved).getTime() : 0;
    if (cloudUpdatedAt > localUpdatedAt && cloudData.state) {
      state = {
        ...blankState(),
        ...cloudData.state,
        ideal: { ...DEFAULT_IDEAL, ...(cloudData.state.ideal || {}) }
      };
      saveState();
      renderAll();
      setCloudStatus("Loaded newer cloud data");
    } else {
      await pushToCloud();
    }
  } catch (err) {
    console.error("Cloud sync check failed:", err);
    setCloudStatus("Cloud sync error");
  }
}

document.getElementById("btnCloudSignIn").addEventListener("click", () => {
  if (!fbAuth) {
    alert("Cloud sync isn't available right now — check your internet connection and reload.");
    return;
  }
  if (cloudUser) {
    fbAuth.signOut();
    return;
  }
  const provider = new firebase.auth.GoogleAuthProvider();
  fbAuth.signInWithPopup(provider).catch(err => {
    alert("Sign-in failed: " + err.message);
  });
});

initFirebase();
if (fbAuth) {
  fbAuth.onAuthStateChanged(user => {
    cloudUser = user;
    updateCloudButton();
    if (user) resolveCloudSync();
  });
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

renderAll();
maybeRunWeeklyBackup();
