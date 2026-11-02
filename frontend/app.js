const BASE = ["RELIANCE.NS", "TCS.NS", "GALP.LS", "EDP.LS", "PETR4.SA", "NVDA"];
const PROFILES = ["HDL", "Buffett", "Graham", "Simons", "Burry", "Dalio"];
const COPY = {
  HDL: "Queda de 1 ano ≥ 30% e P/E < 25 (tecnologia) ou < 15.",
  Buffett: "P/E < 20 e queda de 1 ano inferior a 20%.",
  Graham: "P/E < 15 e cotação abaixo de há um ano.",
  Simons: "Variação positiva no dia ou no mês.",
  Burry: "Queda de 1 ano ≥ 25% e P/E < 18.",
  Dalio: "P/E < 22 em setor defensivo, ou ano resiliente.",
};

let quotes = {};
let watchlist = JSON.parse(localStorage.getItem("aa_watchlist_v7") || "null") || ["RELIANCE.NS", "GALP.LS", "NVDA", "PETR4.SA"];
let recent = JSON.parse(localStorage.getItem("aa_recent_v1") || "null") || [];
let profile = "HDL";
let overrides = {};
let footer = "HDL";

function esc(value) {
  return String(value)
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;")
    .replace(/'/g, "\u0026#39;");
}
function money(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return sign + n.toLocaleString("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
}
function tone(n) {
  if (n == null) return "";
  return n >= 0 ? "positive" : "negative";
}
function peOk(pe, max) {
  return pe != null && pe > 0 && pe < max;
}
function fmtRet(v) {
  return v == null ? "n/d" : pct(v);
}

function evaluateSignal(stock, prof) {
  const pe = stock.pe;
  const y = stock.ret1Y;
  const limit = stock.isTech ? 25 : 15;
  if (prof === "HDL") {
    const pass = y != null && y <= -30 && peOk(pe, limit);
    return { pass, text: pass ? "APROVADO HDL" : "REPROVADO HDL", detail: `1 ano ${fmtRet(y)} · P/E ${money(pe)} (< ${limit})` };
  }
  if (prof === "Buffett") {
    const pass = peOk(pe, 20) && y != null && y > -20;
    return { pass, text: pass ? "APROVADO BUFFETT" : "REPROVADO BUFFETT", detail: `P/E ${money(pe)} (< 20) · 1 ano ${fmtRet(y)}` };
  }
  if (prof === "Graham") {
    const pass = peOk(pe, 15) && y != null && y < 0;
    return { pass, text: pass ? "APROVADO GRAHAM" : "REPROVADO GRAHAM", detail: `P/E ${money(pe)} (< 15) · 1 ano ${fmtRet(y)}` };
  }
  if (prof === "Simons") {
    const pass = (stock.ret1D != null && stock.ret1D > 0) || (stock.ret1M != null && stock.ret1M > 0);
    return { pass, text: pass ? "COMPRA QUANT" : "NEUTRO QUANT", detail: `1D ${fmtRet(stock.ret1D)} · 1M ${fmtRet(stock.ret1M)}` };
  }
  if (prof === "Burry") {
    const pass = y != null && y <= -25 && peOk(pe, 18);
    return { pass, text: pass ? "APROVADO BURRY" : "REPROVADO BURRY", detail: `1 ano ${fmtRet(y)} · P/E ${money(pe)} (< 18)` };
  }
  const sector = stock.sector || "";
  const defensive = /Energia|Utilidades|Consumo/.test(sector);
  const pass = peOk(pe, 22) && (defensive || (y != null && y > -10));
  return { pass, text: pass ? "APROVADO DALIO" : "REPROVADO DALIO", detail: `${sector} · P/E ${money(pe)} (< 22)` };
}

function peHtml(stock) {
  if (stock.pe == null) return `<span class="text-slate-500">N/A</span>`;
  let note = "publicado";
  let title = "Último P/E publicado";
  if (stock.peLive && stock.peMethod === "eps" && stock.eps != null) {
    note = "ao vivo";
    title = `P/E = ${stock.origPrice} ${stock.origCurrency} ÷ EPS ${stock.eps} (12 meses${stock.epsAsOf ? ", " + stock.epsAsOf : ""})`;
  } else if (stock.peLive) {
    note = "ao vivo";
    title = `P/E publicado${stock.peAsOf ? " em " + stock.peAsOf : ""} ajustado ao preço atual`;
  }
  return `<div title="${title}"><div class="font-semibold text-white">${money(stock.pe)}</div><div class="text-[10px] text-emerald-400">${note}</div></div>`;
}

function spark(points) {
  if (!points || points.length < 2) return "";
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const w = 80;
  const h = 24;
  const d = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - 2 - ((v - min) / span) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = points[points.length - 1] >= points[0];
  return `<svg width="${w}" height="${h}"><polyline fill="none" stroke="${up ? "#4ade80" : "#f87171"}" stroke-width="2" points="${d}"/></svg>`;
}

function screenerTickers() {
  return recent.length ? recent.slice(0, 10) : BASE.slice();
}

async function refresh(symbols) {
  const unique = [...new Set(symbols.map((s) => s.toUpperCase()))];
  if (!unique.length) return;
  const res = await fetch("/api/quote?symbols=" + encodeURIComponent(unique.join(",")));
  if (!res.ok) throw new Error("falha");
  const body = await res.json();
  for (const quote of body.quotes || []) quotes[quote.ticker] = quote;
  const missing = (body.errors || []).map((e) => e.symbol);
  const err = document.getElementById("loadError");
  if (err) {
    err.textContent = missing.length ? "Sem dados para " + missing.join(", ") : "";
    err.classList.toggle("hidden", !missing.length);
  }
  const clock = document.getElementById("clock");
  if (clock) clock.textContent = "atualizado " + new Date().toLocaleTimeString("pt-PT");
  renderScreenerTable();
  renderWatchlistTable();
}

document.addEventListener("DOMContentLoaded", () => {
  refresh([...screenerTickers(), ...watchlist]).catch(() => {
    const err = document.getElementById("loadError");
    if (err) {
      err.textContent = "Não foi possível obter cotações.";
      err.classList.remove("hidden");
    }
  });
  setInterval(() => {
    if (document.hidden) return;
    refresh([...screenerTickers(), ...watchlist]).catch(() => {});
  }, 30000);
  injectFooter();
});

let searchTimeout;
function handleSearchInput(e) {
  clearTimeout(searchTimeout);
  const query = e.target.value.trim();
  const dropdown = document.getElementById("searchResultsDropdown");
  if (query.length < 2) {
    dropdown.classList.add("hidden");
    return;
  }
  searchTimeout = setTimeout(async () => {
    const res = await fetch("/api/search?q=" + encodeURIComponent(query));
    const data = await res.json();
    if (!data.length) {
      dropdown.classList.add("hidden");
      return;
    }
    dropdown.innerHTML = data
      .filter((item) => /^[A-Z0-9.^=-]{1,24}$/i.test(item.symbol))
      .map(
        (item) =>
          `<button type="button" onclick="selectStock('${esc(item.symbol)}')" class="w-full text-left p-3 hover:bg-slate-800 cursor-pointer flex justify-between border-b border-slate-800"><div><span class="font-bold text-white text-sm">${esc(item.symbol)}</span><span class="text-xs text-slate-400 block">${esc(item.name)}</span></div><span class="text-[10px] bg-blue-900 text-blue-300 px-2 py-1 rounded">${esc(item.exch)}</span></button>`,
      )
      .join("");
    dropdown.classList.remove("hidden");
  }, 280);
}

async function selectStock(symbol) {
  document.getElementById("searchResultsDropdown").classList.add("hidden");
  document.getElementById("searchInput").value = "";
  recent = [symbol, ...recent.filter((s) => s !== symbol)].slice(0, 10);
  localStorage.setItem("aa_recent_v1", JSON.stringify(recent));
  await refresh([symbol]);
}

function switchTab(tabName) {
  document.querySelectorAll(".tab-content").forEach((el) => el.classList.remove("active"));
  const a = document.getElementById("tabBtnScreener");
  const b = document.getElementById("tabBtnWatchlist");
  a.className = "px-4 py-2 rounded-lg font-bold text-sm transition text-slate-400 hover:text-white";
  b.className = "px-4 py-2 rounded-lg font-bold text-sm transition text-slate-400 hover:text-white";
  if (tabName === "screener") {
    document.getElementById("tabScreener").classList.add("active");
    a.className = "px-4 py-2 rounded-lg font-bold text-sm transition bg-blue-600 text-white shadow";
  } else {
    document.getElementById("tabWatchlist").classList.add("active");
    b.className = "px-4 py-2 rounded-lg font-bold text-sm transition bg-blue-600 text-white shadow";
    renderWatchlistTable();
  }
}

function setGlobalProfile(next) {
  profile = next;
  PROFILES.forEach((p) => {
    const btn = document.getElementById("btn-" + p);
    if (!btn) return;
    btn.className =
      p === next
        ? "p-3 rounded-lg border text-center font-bold transition border-blue-500 bg-blue-900/40 text-blue-400 text-xs"
        : "p-3 rounded-lg border text-center font-bold transition border-slate-700 bg-slate-800 text-slate-300 text-xs";
  });
  document.getElementById("activeProfileBadgeScreener").textContent = "Analista: " + next;
  document.getElementById("activeProfileBadgeWatchlist").textContent = "Analista: " + next;
  renderScreenerTable();
  renderWatchlistTable();
}

function changeStockAnalyst(ticker, next) {
  overrides[ticker] = next;
  renderScreenerTable();
  renderWatchlistTable();
}

function toggleWatchlist(ticker) {
  watchlist = watchlist.includes(ticker) ? watchlist.filter((t) => t !== ticker) : [...watchlist, ticker];
  localStorage.setItem("aa_watchlist_v7", JSON.stringify(watchlist));
  if (!quotes[ticker]) refresh([ticker]);
  else {
    renderScreenerTable();
    renderWatchlistTable();
  }
}

function signalCell(stock) {
  const used = overrides[stock.ticker] || profile;
  const signal = evaluateSignal(stock, used);
  return `<div class="space-y-1"><span class="px-2 py-0.5 rounded text-[10px] font-bold ${signal.pass ? "badge-pass" : "badge-fail"}" title="${signal.detail}">${signal.text}</span><div class="text-[10px] text-slate-400 max-w-[220px]">${signal.detail}</div><select onchange="changeStockAnalyst('${stock.ticker}', this.value)" class="bg-slate-900 border border-slate-700 text-[10px] text-slate-300 rounded px-1 py-0.5">${PROFILES.map((p) => `<option value="${p}" ${used === p ? "selected" : ""}>${p}</option>`).join("")}</select></div>`;
}

function renderScreenerTable() {
  const tbody = document.getElementById("screenerTableBody");
  tbody.innerHTML = screenerTickers()
    .map((ticker) => {
      const stock = quotes[ticker];
      if (!stock) return `<tr><td class="p-3 text-slate-500" colspan="10">${ticker} · a carregar</td></tr>`;
      const starred = watchlist.includes(ticker);
      return `<tr class="hover:bg-slate-800/50">
        <td class="p-3 text-center"><button onclick="toggleWatchlist('${ticker}')" class="text-lg ${starred ? "text-yellow-400" : "text-slate-600"}">★</button></td>
        <td class="p-3 font-bold text-white">${stock.ticker}<span class="block text-xs font-normal text-slate-400">${stock.name}</span></td>
        <td class="p-3 text-xs">${stock.market}</td>
        <td class="p-3 text-xs text-blue-300">${stock.sector}</td>
        <td class="p-3 font-semibold text-emerald-400">€${money(stock.price)}</td>
        <td class="p-3 text-xs text-slate-400">${money(stock.origPrice)} ${stock.origCurrency}</td>
        <td class="p-3 font-bold ${tone(stock.ret1D)}">${pct(stock.ret1D)}</td>
        <td class="p-3">${peHtml(stock)}</td>
        <td class="p-3">${spark(stock.spark)}</td>
        <td class="p-3">${signalCell(stock)}</td>
      </tr>`;
    })
    .join("");
}

function renderWatchlistTable() {
  const tbody = document.getElementById("watchlistTableBody");
  const empty = document.getElementById("watchlistEmptyState");
  const wrap = document.getElementById("watchlistTableWrapper");
  document.getElementById("watchlistCountBadge").textContent = watchlist.length;
  const rows = watchlist.map((t) => quotes[t]).filter(Boolean);
  if (!watchlist.length) {
    empty.classList.remove("hidden");
    wrap.classList.add("hidden");
    tbody.innerHTML = "";
    return;
  }
  empty.classList.add("hidden");
  wrap.classList.remove("hidden");
  tbody.innerHTML = watchlist
    .map((ticker) => {
      const stock = quotes[ticker];
      if (!stock) return `<tr><td class="p-3 text-slate-500" colspan="10">${ticker} · a carregar</td></tr>`;
      return `<tr>
        <td class="p-3"><button onclick="toggleWatchlist('${ticker}')" class="text-yellow-400">★</button></td>
        <td class="p-3 font-bold text-white">${stock.ticker}<span class="block text-xs font-normal text-slate-400">${stock.name}</span></td>
        <td class="p-3 text-emerald-400">€${money(stock.price)}</td>
        <td class="p-3">${peHtml(stock)}</td>
        <td class="p-3 text-xs ${tone(stock.ret1D)}">${pct(stock.ret1D)}</td>
        <td class="p-3 text-xs ${tone(stock.ret1W)}">${pct(stock.ret1W)}</td>
        <td class="p-3 text-xs ${tone(stock.ret1M)}">${pct(stock.ret1M)}</td>
        <td class="p-3 text-xs ${tone(stock.ret1Y)}">${pct(stock.ret1Y)}</td>
        <td class="p-3 text-xs ${tone(stock.retYTD)}">${pct(stock.retYTD)}</td>
        <td class="p-3">${signalCell(stock)}</td>
      </tr>`;
    })
    .join("");
}

function injectFooter() {
  const html = `<div class="card p-4"><h3 class="text-xs font-bold text-slate-300 uppercase mb-3">Modelos</h3><div class="flex flex-wrap gap-2 mb-3">${PROFILES.map((p) => `<button onclick="selectFooter('${p}')" class="px-3 py-2 rounded-lg text-xs font-bold border ${footer === p ? "bg-blue-600 border-blue-500 text-white" : "bg-slate-800 border-slate-700 text-slate-300"}">${p}</button>`).join("")}</div><p id="footerCopy" class="text-xs text-slate-300">${COPY[footer]}</p></div>`;
  document.querySelectorAll(".analyst-footer-bar").forEach((el) => el.remove());
  for (const id of ["tabScreener", "tabWatchlist"]) {
    const div = document.createElement("div");
    div.className = "analyst-footer-bar";
    div.innerHTML = html;
    document.getElementById(id).appendChild(div);
  }
}
function selectFooter(p) {
  footer = p;
  injectFooter();
}
