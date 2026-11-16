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
  renderPortfolio();
}

document.addEventListener("DOMContentLoaded", () => {
  const portfolioTickers = portfolio.map(p => p.ticker);
  refresh([...screenerTickers(), ...watchlist, ...portfolioTickers]).catch(() => {
    const err = document.getElementById("loadError");
    if (err) {
      err.textContent = "Não foi possível obter cotações.";
      err.classList.remove("hidden");
    }
  });
  setInterval(() => {
    if (document.hidden) return;
    const pTickers = portfolio.map(p => p.ticker);
    refresh([...screenerTickers(), ...watchlist, ...pTickers]).catch(() => {});
  }, 30000);
  injectFooter();
  renderPortfolio();
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
  const c = document.getElementById("tabBtnPortfolio");
  const modelsBar = document.getElementById("globalModelsBar");

  a.className = "px-4 py-2 rounded-lg font-bold text-sm transition text-slate-400 hover:text-white";
  b.className = "px-4 py-2 rounded-lg font-bold text-sm transition text-slate-400 hover:text-white";
  c.className = "px-4 py-2 rounded-lg font-bold text-sm transition text-slate-400 hover:text-white";

  if (tabName === "screener") {
    document.getElementById("tabScreener").classList.add("active");
    a.className = "px-4 py-2 rounded-lg font-bold text-sm transition bg-blue-600 text-white shadow";
    if (modelsBar) modelsBar.classList.remove("hidden");
  } else if (tabName === "watchlist") {
    document.getElementById("tabWatchlist").classList.add("active");
    b.className = "px-4 py-2 rounded-lg font-bold text-sm transition bg-blue-600 text-white shadow";
    if (modelsBar) modelsBar.classList.remove("hidden");
    renderWatchlistTable();
  } else if (tabName === "portfolio") {
    document.getElementById("tabPortfolio").classList.add("active");
    c.className = "px-4 py-2 rounded-lg font-bold text-sm transition bg-blue-600 text-white shadow";
    if (modelsBar) modelsBar.classList.add("hidden");
    renderPortfolio();
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
      if (!stock) return `<tr><td class="p-3 text-slate-500" colspan="12">${ticker} · a carregar</td></tr>`;
      return `<tr>
        <td class="p-3"><button onclick="toggleWatchlist('${ticker}')" class="text-yellow-400">★</button></td>
        <td class="p-3 font-bold text-white">${stock.ticker}<span class="block text-xs font-normal text-slate-400">${stock.name}</span></td>
        <td class="p-3 text-emerald-400">€${money(stock.price)}</td>
        <td class="p-3">${peHtml(stock)}</td>
        <td class="p-3 text-xs ${tone(stock.ret1D)}">${pct(stock.ret1D)}</td>
        <td class="p-3 text-xs ${tone(stock.ret1W)}">${pct(stock.ret1W)}</td>
        <td class="p-3 text-xs ${tone(stock.ret1M)}">${pct(stock.ret1M)}</td>
        <td class="p-3 text-xs ${tone(stock.ret1Y)}">${pct(stock.ret1Y)}</td>
        <td class="p-3 text-xs ${tone(stock.ret3Y)}">${pct(stock.ret3Y)}</td>
        <td class="p-3 text-xs ${tone(stock.ret5Y)}">${pct(stock.ret5Y)}</td>
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

/* ============================================================================
   SEPARADOR PORTEFÓLIO — OS 6 ANALISTAS (BUFFETT, LYNCH, FISHER, BOGLE, SWENSEN, BERNSTEIN)
   ============================================================================ */

const ASSET_TYPES = [
  { id: "stock", label: "Ação individual", isStock: true },
  { id: "etf_broad", label: "ETF de ações", isStock: false, isEtf: true },
  { id: "etf_bond", label: "ETF de obrigações", isStock: false, isEtf: true },
  { id: "etf_thematic", label: "ETF temático / setorial", isStock: false, isEtf: true },
  { id: "crypto", label: "Cripto / especulativo", isStock: false },
  { id: "cash", label: "Liquidez / cash", isStock: false },
];

const PORTFOLIO_ANALYSTS = [
  {
    id: "buffett",
    name: "Warren Buffett",
    tagline: "Qualidade, vantagens competitivas (moats) e múltiplos P/E comportáveis.",
    weights: [
      { key: "qualityConcentration", label: "Foco e peso das empresas", weight: 35 },
      { key: "valuationPe", label: "Rácio P/E comportável", weight: 25 },
      { key: "sectorSpread", label: "Diversificação setorial", weight: 25 },
      { key: "lowSpec", label: "Ausência de especulação", weight: 15 },
    ],
  },
  {
    id: "lynch",
    name: "Peter Lynch",
    tagline: "GARP, portefólio equilibrado (6 a 15 posições) e crescimento.",
    weights: [
      { key: "sweetSpotCount", label: "Número ideal de posições (6-15)", weight: 35 },
      { key: "noDominantConcentration", label: "Equilíbrio de pesos", weight: 30 },
      { key: "growthPotential", label: "Potencial de mercado", weight: 20 },
      { key: "lowSpec", label: "Controlo de risco", weight: 15 },
    ],
  },
  {
    id: "fisher",
    name: "Philip Fisher",
    tagline: "Empresas excecionais de crescimento e concentração em líderes.",
    weights: [
      { key: "focusQuality", label: "Concentração em líderes", weight: 40 },
      { key: "sectorSpread", label: "Diversificação por indústrias", weight: 30 },
      { key: "lowSpec", label: "Zero apostas puramente especulativas", weight: 30 },
    ],
  },
  {
    id: "bogle",
    name: "John Bogle",
    tagline: "Custos baixos, fundos de índice amplos e simplicidade.",
    weights: [
      { key: "costs", label: "Custos e comissões (TER)", weight: 35 },
      { key: "broad", label: "Exposição a índices amplos", weight: 30 },
      { key: "simplicity", label: "Simplicidade da carteira", weight: 20 },
      { key: "lowSpec", label: "Baixa especulação", weight: 15 },
    ],
  },
  {
    id: "swensen",
    name: "David Swensen",
    tagline: "Alocação diversificada entre classes de ativos e reequilíbrio.",
    weights: [
      { key: "multiAsset", label: "Diversificação multicalasse", weight: 35 },
      { key: "broad", label: "Núcleo em ativos globais", weight: 25 },
      { key: "costs", label: "Custos controlados", weight: 20 },
      { key: "lowSpec", label: "Disciplina institucional", weight: 20 },
    ],
  },
  {
    id: "bernstein",
    name: "William Bernstein",
    tagline: "Controlo de risco, obrigações estabilizadoras e custos baixos.",
    weights: [
      { key: "riskBalance", label: "Proteção e obrigações", weight: 35 },
      { key: "diversification", label: "Diversificação global", weight: 30 },
      { key: "costs", label: "Custos baixos", weight: 20 },
      { key: "simplicity", label: "Simplicidade", weight: 15 },
    ],
  },
];

let portfolio = JSON.parse(localStorage.getItem("aa_portfolio_all_v1") || "[]");
let selectedPortfolioAnalyst = localStorage.getItem("aa_portfolio_analyst_all_v1") || "buffett";
let pendingPortfolioAsset = null;
let portfolioSearchTimeout = null;

function savePortfolio() {
  localStorage.setItem("aa_portfolio_all_v1", JSON.stringify(portfolio));
}

function classifyAsset(item) {
  const qType = (item.type || item.quoteType || "").toUpperCase();
  const text = `${item.symbol || ""} ${item.name || ""}`.toUpperCase();
  if (qType === "CRYPTOCURRENCY" || /(BTC|ETH|SOL|CRYPTO|BITCOIN|ETHEREUM)/.test(text)) return "crypto";
  if (qType === "ETF" || qType === "MUTUALFUND" || /(ETF|UCITS|ISHARES|VANGUARD|AMUNDI|XTRACKERS|SPDR|INVESCO)/.test(text)) {
    if (/(BOND|AGGREGATE|TREASURY|GILT|OBRIG|GOVT|CORP BOND)/.test(text)) return "etf_bond";
    if (/(GOLD|SILVER|COMMODIT)/.test(text)) return "etf_gold";
    if (/(AI|ROBOT|CLEAN ENERGY|SEMICONDUCTOR|TECH)/.test(text)) return "etf_thematic";
    return "etf_broad";
  }
  return "stock";
}

function handlePortfolioSearchInput(e) {
  clearTimeout(portfolioSearchTimeout);
  pendingPortfolioAsset = null;
  const query = e.target.value.trim();
  const dropdown = document.getElementById("portfolioSearchDropdown");
  if (query.length < 2) {
    dropdown.classList.add("hidden");
    return;
  }
  portfolioSearchTimeout = setTimeout(async () => {
    try {
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
            `<button type="button" onclick='selectPortfolioCandidate(${JSON.stringify({
              symbol: item.symbol,
              name: item.name,
              exch: item.exch || "",
              type: item.type || "",
            }).replace(/'/g, "&#39;")})' class="w-full text-left p-3 hover:bg-slate-800 cursor-pointer flex justify-between items-center border-b border-slate-800">
              <div>
                <span class="font-bold text-white text-sm">${esc(item.symbol)}</span>
                <span class="text-xs text-slate-400 block">${esc(item.name)}</span>
              </div>
              <span class="text-[10px] bg-blue-900 text-blue-300 px-2 py-1 rounded">${esc(item.exch)}</span>
            </button>`
        )
        .join("");
      dropdown.classList.remove("hidden");
    } catch {
      dropdown.classList.add("hidden");
    }
  }, 260);
}

function selectPortfolioCandidate(item) {
  pendingPortfolioAsset = item;
  document.getElementById("portfolioSearchInput").value = `${item.name} (${item.symbol})`;
  document.getElementById("portfolioSearchDropdown").classList.add("hidden");
  document.getElementById("portfolioSharesInput").focus();
}

async function addPortfolioPosition() {
  const searchInput = document.getElementById("portfolioSearchInput");
  const sharesInput = document.getElementById("portfolioSharesInput");
  const feedback = document.getElementById("portfolioFeedback");

  const rawQuery = searchInput.value.trim();
  const sharesVal = parseFloat(String(sharesInput.value).replace(",", "."));

  if (!rawQuery) {
    feedback.textContent = "Procura primeiro um ativo (nome, ticker ou ISIN).";
    feedback.className = "text-sm text-amber-400";
    return;
  }
  if (!Number.isFinite(sharesVal) || sharesVal <= 0) {
    feedback.textContent = "Indica um número de ações/unidades válido (ex.: 10 ou 1.5).";
    feedback.className = "text-sm text-amber-400";
    sharesInput.focus();
    return;
  }

  let candidate = pendingPortfolioAsset;
  if (!candidate) {
    try {
      const res = await fetch("/api/search?q=" + encodeURIComponent(rawQuery));
      const data = await res.json();
      if (data && data.length) {
        candidate = data[0];
      }
    } catch {}
  }

  if (!candidate) {
    feedback.textContent = "Não foi encontrado nenhum ativo com essa pesquisa.";
    feedback.className = "text-sm text-red-400";
    return;
  }

  let quoteData = null;
  try {
    const qRes = await fetch("/api/quote?symbol=" + encodeURIComponent(candidate.symbol));
    if (qRes.ok) {
      quoteData = await qRes.json();
      quotes[candidate.symbol.toUpperCase()] = quoteData;
    }
  } catch {}

  const finalName = (quoteData && quoteData.name) || candidate.name || candidate.symbol;
  const detectedType = classifyAsset({
    symbol: candidate.symbol,
    name: finalName,
    type: (quoteData && quoteData.quoteType) || candidate.type,
  });
  const detectedTer = quoteData && typeof quoteData.ter === "number" ? quoteData.ter : null;

  const existingIndex = portfolio.findIndex((p) => p.ticker.toUpperCase() === candidate.symbol.toUpperCase());
  if (existingIndex >= 0) {
    portfolio[existingIndex].shares = portfolio[existingIndex].shares + sharesVal;
  } else {
    portfolio.push({
      id: Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      ticker: candidate.symbol.toUpperCase(),
      name: finalName,
      type: detectedType,
      shares: sharesVal,
      ter: detectedTer,
    });
  }

  savePortfolio();
  pendingPortfolioAsset = null;
  searchInput.value = "";
  sharesInput.value = "";
  document.getElementById("portfolioSearchDropdown").classList.add("hidden");

  feedback.textContent = `Adicionado/Atualizado: ${finalName}.`;
  feedback.className = "text-sm text-slate-300";
  
  if (!quotes[candidate.symbol.toUpperCase()]) {
    refresh([candidate.symbol.toUpperCase()]);
  } else {
    renderPortfolio();
  }
}

function updatePositionType(index, newType) {
  if (!portfolio[index]) return;
  portfolio[index].type = newType;
  const typeMeta = ASSET_TYPES.find((t) => t.id === newType);
  if (!typeMeta || !typeMeta.isEtf) {
    portfolio[index].ter = null;
  }
  savePortfolio();
  renderPortfolio();
}

function updatePositionShares(index, rawVal) {
  if (!portfolio[index]) return;
  const parsed = parseFloat(String(rawVal).replace(",", "."));
  portfolio[index].shares = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  savePortfolio();
  renderPortfolio();
}

function updatePositionTer(index, rawTer) {
  if (!portfolio[index]) return;
  const cleaned = String(rawTer).trim().replace(",", ".");
  if (!cleaned || cleaned.toLowerCase() === "n/d") {
    portfolio[index].ter = null;
  } else {
    const parsed = parseFloat(cleaned);
    portfolio[index].ter = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  savePortfolio();
  renderPortfolio();
}

function removePortfolioPosition(index) {
  portfolio.splice(index, 1);
  savePortfolio();
  renderPortfolio();
}

function clearPortfolio() {
  portfolio = [];
  savePortfolio();
  const feedback = document.getElementById("portfolioFeedback");
  if (feedback) feedback.classList.add("hidden");
  renderPortfolio();
}

function selectPortfolioAnalyst(analystId) {
  selectedPortfolioAnalyst = analystId;
  localStorage.setItem("aa_portfolio_analyst_all_v1", analystId);
  renderPortfolio();
}

function scoreColorClass(score) {
  if (score >= 7) return "text-emerald-400";
  if (score >= 5) return "text-amber-400";
  return "text-red-400";
}

function barColorClass(score) {
  if (score >= 7) return "bg-emerald-400";
  if (score >= 5) return "bg-amber-400";
  return "bg-red-400";
}

function scoreLabelPt(score) {
  if (score >= 9) return "excelente";
  if (score >= 7) return "boa";
  if (score >= 5) return "razoável";
  return "fraca";
}

function computeUnifiedPortfolioMetrics() {
  let total = 0;
  const processedPositions = portfolio.map(p => {
    const q = quotes[p.ticker];
    const price = q ? q.price : 0;
    const sector = q ? q.sector : "Geral";
    const pe = q ? q.pe : null;
    const value = (p.shares || 0) * price;
    total += value;
    return { ...p, price, sector, pe, value };
  });

  if (total <= 0) return { total: 0, processedPositions, metrics: null };

  const count = portfolio.length;
  const maxWeight = Math.max(...processedPositions.map(p => (p.value / total) * 100));
  const sectorsSet = new Set(processedPositions.map(p => p.sector));
  const distinctSectors = sectorsSet.size;

  let broadWeight = 0;
  let bondWeight = 0;
  let goldWeight = 0;
  let specValue = 0;
  let validPeCount = 0;
  let sumPe = 0;
  let etfTotalWeight = 0;
  let etfKnownTerWeight = 0;
  let weightedTerSum = 0;

  for (const p of processedPositions) {
    const w = (p.value / total) * 100;
    if (p.type === "etf_broad") broadWeight += w;
    else if (p.type === "etf_bond" || p.type === "cash") bondWeight += w;
    else if (p.type === "etf_gold") goldWeight += w;
    else if (p.type === "crypto") specValue += p.value;

    if (p.type && p.type.startsWith("etf_")) {
      etfTotalWeight += w;
      if (p.ter != null && Number.isFinite(p.ter)) {
        etfKnownTerWeight += w;
        weightedTerSum += w * p.ter;
      }
    }

    if (p.pe != null && p.pe > 0) {
      validPeCount++;
      sumPe += p.pe;
    }
  }

  const specWeight = (specValue / total) * 100;
  const avgPe = validPeCount > 0 ? sumPe / validPeCount : 18;

  const unknownEtfWeight = Math.max(0, etfTotalWeight - etfKnownTerWeight);
  const effectiveTer = etfTotalWeight > 0 ? (weightedTerSum + unknownEtfWeight * 0.30) / etfTotalWeight : 0.15;
  const majorityMissingTer = etfTotalWeight > 0 && etfKnownTerWeight < etfTotalWeight * 0.5;

  let costsScore = 10;
  if (effectiveTer <= 0.15) costsScore = 10;
  else if (effectiveTer <= 0.25) costsScore = 8;
  else if (effectiveTer <= 0.40) costsScore = 6;
  else costsScore = 4;
  if (majorityMissingTer && costsScore > 6) costsScore = 6;

  let qualityConcentrationScore = maxWeight > 50 ? 4 : maxWeight > 30 ? 7 : 10;
  let valuationPeScore = avgPe > 30 ? 4 : avgPe > 20 ? 7 : 10;
  let sectorSpreadScore = distinctSectors >= 3 ? 10 : distinctSectors === 2 ? 7 : 4;
  let lowSpecScore = specWeight <= 2 ? 10 : specWeight <= 10 ? 7 : 3;

  let sweetSpotCountScore = (count >= 6 && count <= 15) ? 10 : count <= 20 ? 7 : 4;
  let noDominantConcentrationScore = maxWeight <= 25 ? 10 : maxWeight <= 40 ? 7 : 4;
  let growthPotentialScore = 8;
  let focusQualityScore = (count >= 5 && count <= 15) ? 10 : 7;

  let broadScore = Math.min(10, Math.max(0, Math.round(((broadWeight || (count >= 5 ? 60 : 30)) / 85) * 10)));
  let simplicityScore = count <= 6 ? 10 : count <= 12 ? 7 : 4;
  let diversificationScore = Math.min(10, Math.max(2, Math.round(distinctSectors * 2.5)));
  let riskBalanceScore = (bondWeight >= 15) ? 9 : 6;
  let multiAssetScore = (distinctSectors >= 3 || bondWeight > 0) ? 9 : 6;

  return {
    total,
    processedPositions,
    metrics: {
      count,
      maxWeight,
      distinctSectors,
      avgPe,
      specWeight,
      broadWeight,
      bondWeight,
      effectiveTer,
      missingEtfTer: majorityMissingTer,
      scores: {
        qualityConcentration: qualityConcentrationScore,
        valuationPe: valuationPeScore,
        sectorSpread: sectorSpreadScore,
        lowSpec: lowSpecScore,
        sweetSpotCount: sweetSpotCountScore,
        noDominantConcentration: noDominantConcentrationScore,
        growthPotential: growthPotentialScore,
        focusQuality: focusQualityScore,
        costs: costsScore,
        broad: broadScore,
        simplicity: simplicityScore,
        diversification: diversificationScore,
        riskBalance: riskBalanceScore,
        multiAsset: multiAssetScore,
      }
    }
  };
}

function evaluateAnalystUnified(analyst, metrics) {
  let weightedSum = 0;
  const breakdown = analyst.weights.map((item) => {
    const s = metrics.scores[item.key] ?? 7;
    weightedSum += s * (item.weight / 100);
    return { ...item, score: s };
  });

  const finalScore = Math.min(10, Math.max(1, Math.round(weightedSum)));
  const sorted = [...breakdown].sort((a, b) => b.score - a.score);
  const bestCriterion = sorted[0];
  const worstCriterion = sorted[sorted.length - 1];

  const strengths = [];
  const weaknesses = [];
  const improvements = [];

  if (metrics.count >= 5 && metrics.count <= 15) {
    strengths.push(`Número equilibrado de ativos (${metrics.count}), ideal para acompanhamento.`);
  } else if (metrics.count > 15) {
    strengths.push(`Diversificação alargada com ${metrics.count} posições.`);
    weaknesses.push("Demasiadas posições podem diluir o potencial de retorno das melhores convicções.");
    improvements.push("Foca o capital nas tuas principais apostas.");
  } else {
    strengths.push(`Portefólio focado com ${metrics.count} posições.`);
    weaknesses.push("Baixo número de ativos eleva o risco individual.");
    improvements.push("Considera adicionar mais 2 a 3 ativos para mitigar volatilidade.");
  }

  if (metrics.specWeight > 10) {
    weaknesses.push(`Exposição especulativa elevada (${metrics.specWeight.toFixed(1)}%).`);
    improvements.push("Reduz o peso de ativos altamente especulativos.");
  } else {
    strengths.push("Exposição a ativos especulativos controlada.");
  }

  if (!strengths.length) strengths.push("Boa estrutura geral de ativos.");
  if (!weaknesses.length) weaknesses.push("Nenhum desequilíbrio grave detetado.");
  if (!improvements.length) improvements.push("Manter consistência no plano de aportes.");

  return {
    score: finalScore,
    breakdown,
    bestCriterion,
    worstCriterion,
    strengths,
    weaknesses,
    improvements,
  };
}

function renderPortfolio() {
  const tbody = document.getElementById("portfolioTableBody");
  const empty = document.getElementById("portfolioEmptyState");
  const wrap = document.getElementById("portfolioTableWrapper");
  const warning = document.getElementById("portfolioTerWarning");
  const analystsSection = document.getElementById("portfolioAnalystsSection");

  if (!tbody) return;

  if (!portfolio.length) {
    empty.classList.remove("hidden");
    wrap.classList.add("hidden");
    if (warning) warning.classList.add("hidden");
    analystsSection.classList.add("hidden");
    tbody.innerHTML = "";
    document.getElementById("portfolioTotalValue").textContent = "0,00 €";
    return;
  }

  empty.classList.add("hidden");
  wrap.classList.remove("hidden");
  analystsSection.classList.remove("hidden");

  const { total, processedPositions, metrics } = computeUnifiedPortfolioMetrics();

  document.getElementById("portfolioTotalValue").textContent = `${money(total)} €`;
  if (warning) warning.classList.toggle("hidden", !(metrics && metrics.missingEtfTer));

  const missingTickers = portfolio.filter(p => !quotes[p.ticker]).map(p => p.ticker);
  if (missingTickers.length > 0) {
    refresh(missingTickers);
  }

  tbody.innerHTML = processedPositions
    .map((pos, idx) => {
      const weightPct = total > 0 ? (pos.value / total) * 100 : 0;
      const typeMeta = ASSET_TYPES.find((t) => t.id === pos.type) || ASSET_TYPES[0];
      
      const terCell = typeMeta.isEtf
        ? `<div class="inline-flex flex-col items-start">
            <input
              type="text"
              value="${pos.ter != null ? esc(String(pos.ter).replace(".", ",")) : ""}"
              placeholder="n/d"
              onchange="updatePositionTer(${idx}, this.value)"
              class="w-20 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200 text-xs focus:outline-none focus:border-blue-500"
            >
            <span class="text-[10px] text-slate-500 mt-0.5">%</span>
          </div>`
        : `<span class="text-slate-500">—</span>`;

      return `<tr class="hover:bg-slate-800/40">
        <td class="p-3">
          <div class="font-bold text-white leading-snug">${esc(pos.name)}</div>
          <div class="text-xs text-slate-400 mt-0.5">${esc(pos.ticker)} · Preço: <span class="text-emerald-400">€${money(pos.price)}</span></div>
        </td>
        <td class="p-3">
          <select
            onchange="updatePositionType(${idx}, this.value)"
            class="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
          >
            ${ASSET_TYPES.map(
              (t) => `<option value="${t.id}" ${pos.type === t.id ? "selected" : ""}>${esc(t.label)}</option>`
            ).join("")}
          </select>
        </td>
        <td class="p-3">
          <input
            type="number"
            step="any"
            min="0"
            value="${pos.shares}"
            onchange="updatePositionShares(${idx}, this.value)"
            class="w-28 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500"
          >
          <div class="text-[10px] text-slate-400 mt-1">= €${money(pos.value)}</div>
        </td>
        <td class="p-3 font-bold text-white">
          ${weightPct.toLocaleString("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
        </td>
        <td class="p-3">${terCell}</td>
        <td class="p-3 text-right">
          <button
            type="button"
            onclick="removePortfolioPosition(${idx})"
            title="Remover posição"
            class="text-slate-500 hover:text-red-400 px-2 py-1 text-sm transition"
          >✕</button>
        </td>
      </tr>`;
    })
    .join("");

  if (!metrics) return;

  const cardsContainer = document.getElementById("portfolioAnalystCards");
  const evaluations = {};

  cardsContainer.innerHTML = PORTFOLIO_ANALYSTS.map((analyst) => {
    const ev = evaluateAnalystUnified(analyst, metrics);
    evaluations[analyst.id] = ev;
    const isSelected = analyst.id === selectedPortfolioAnalyst;
    return `<button
      type="button"
      onclick="selectPortfolioAnalyst('${analyst.id}')"
      class="p-4 rounded-xl border text-center transition flex flex-col items-center justify-center min-h-[110px] ${
        isSelected
          ? "border-blue-500 bg-blue-950/50 shadow-lg"
          : "border-slate-700 bg-slate-900/60 hover:border-slate-500"
      }"
    >
      <div class="text-xs font-bold ${isSelected ? "text-blue-400" : "text-slate-200"} leading-snug mb-2">
        ${esc(analyst.name)}
      </div>
      <div class="flex items-baseline justify-center">
        <span class="text-2xl font-extrabold ${scoreColorClass(ev.score)}">${ev.score}</span>
        <span class="text-xs font-bold text-slate-400 ml-0.5">/10</span>
      </div>
    </button>`;
  }).join("");

  const activeAnalyst =
    PORTFOLIO_ANALYSTS.find((a) => a.id === selectedPortfolioAnalyst) || PORTFOLIO_ANALYSTS[0];
  const activeEval = evaluations[activeAnalyst.id];

  const detailContainer = document.getElementById("portfolioAnalystDetail");
  detailContainer.innerHTML = `
    <div class="flex items-center gap-4 pt-2">
      <div class="flex items-baseline">
        <span class="text-4xl font-extrabold ${scoreColorClass(activeEval.score)}">${activeEval.score}</span>
        <span class="text-base font-bold text-slate-400 ml-1">/10</span>
      </div>
      <div>
        <h3 class="text-lg font-bold text-white">${esc(activeAnalyst.name)}</h3>
        <p class="text-xs text-slate-400">${esc(activeAnalyst.tagline)}</p>
      </div>
    </div>

    <p class="text-sm text-slate-200 leading-relaxed">
      A nota é ${activeEval.score}/10 (${scoreLabelPt(activeEval.score)}). Sob a perspetiva de ${esc(activeAnalyst.name)}
      (${esc(activeAnalyst.tagline.toLowerCase().replace(/\.$/, ""))}), o ponto forte é «${esc(activeEval.bestCriterion.label.toLowerCase())}»
      e o ponto de atenção é «${esc(activeEval.worstCriterion.label.toLowerCase())}».
    </p>

    <div class="space-y-2.5">
      <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider">Critérios de Avaliação</h4>
      <div class="space-y-2">
        ${activeEval.breakdown
          .map(
            (b) => `
          <div class="grid grid-cols-12 items-center gap-3 text-xs">
            <div class="col-span-5 sm:col-span-4 text-slate-200">
              ${esc(b.label)} <span class="text-slate-500">(${b.weight}%)</span>
            </div>
            <div class="col-span-5 sm:col-span-7 bg-slate-950 rounded-full h-2.5 overflow-hidden">
              <div class="${barColorClass(b.score)} h-2.5 rounded-full transition-all" style="width: ${b.score * 10}%"></div>
            </div>
            <div class="col-span-2 sm:col-span-1 text-right font-semibold text-slate-200">
              ${b.score}/10
            </div>
          </div>`
          )
          .join("")}
      </div>
    </div>

    <div class="space-y-2">
      <h4 class="text-xs font-bold text-emerald-400 uppercase tracking-wider">Pontos fortes</h4>
      <ul class="list-disc list-inside space-y-1 text-sm text-slate-200">
        ${activeEval.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}
      </ul>
    </div>

    <div class="space-y-2">
      <h4 class="text-xs font-bold text-red-400 uppercase tracking-wider">Pontos de atenção</h4>
      <ul class="list-disc list-inside space-y-1 text-sm text-slate-200">
        ${activeEval.weaknesses.map((w) => `<li>${esc(w)}</li>`).join("")}
      </ul>
    </div>

    <div class="space-y-2">
      <h4 class="text-xs font-bold text-blue-400 uppercase tracking-wider">Como otimizar</h4>
      <ol class="list-decimal list-inside space-y-1 text-sm text-slate-200">
        ${activeEval.improvements.map((imp) => `<li>${esc(imp)}</li>`).join("")}
      </ol>
    </div>

    <p class="text-[11px] text-slate-500 pt-2 border-t border-slate-800">
      Avaliação inspirada nos princípios de ${esc(activeAnalyst.name)}. Não constitui recomendação financeira.
    </p>
  `;
}