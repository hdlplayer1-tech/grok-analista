import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "../frontend");
const PORT = Number(process.env.PORT) || 3000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CHART_TTL = 20_000;
const FUND_TTL = 6 * 60 * 60 * 1000;
const FX_TTL = 15 * 60 * 1000;
const SYMBOL = /^[A-Z0-9.^=-]{1,24}$/;
const FX_FALLBACK = {
  USD: 0.92,
  INR: 0.011,
  BRL: 0.16,
  GBP: 1.17,
  GBp: 0.0117,
  JPY: 0.0061,
  CHF: 1.04,
  SEK: 0.088,
  DKK: 0.134,
  NOK: 0.087,
  CAD: 0.66,
  AUD: 0.6,
  HKD: 0.12,
};

const cache = new Map();

function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.val);
  const pendKey = `${key}:pending`;
  const pending = cache.get(pendKey);
  if (pending && pending.exp > Date.now()) return pending.val;
  const promise = fn()
    .then((val) => {
      cache.set(key, { exp: Date.now() + ttl, val });
      cache.delete(pendKey);
      return val;
    })
    .catch((error) => {
      cache.delete(pendKey);
      throw error;
    });
  cache.set(pendKey, { exp: Date.now() + 8_000, val: promise });
  return promise;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function loadChart(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const json = await fetchJson(url);
  const result = json.chart?.result?.[0];
  if (!result) throw new Error("sem gráfico");
  const meta = result.meta ?? {};
  const price = num(meta.regularMarketPrice);
  if (price == null || price <= 0) throw new Error("sem preço");
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (typeof close === "number" && Number.isFinite(close)) bars.push({ ts: timestamps[i], close });
  }
  return {
    price,
    currency: typeof meta.currency === "string" ? meta.currency : "USD",
    name: meta.shortName || meta.longName || symbol,
    exchange: meta.fullExchangeName || meta.exchangeName || "Global",
    changePercent: num(meta.regularMarketChangePercent),
    gmtoffset: num(meta.gmtoffset) ?? 0,
    bars,
  };
}

function lastPoint(series) {
  if (!Array.isArray(series)) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    const row = series[i];
    const raw = row?.reportedValue?.raw;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return { raw, asOf: typeof row.asOfDate === "string" ? row.asOfDate : null };
    }
  }
  return null;
}

async function loadFundamentals(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 800 * 24 * 3600;
  const url =
    `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
    `?symbol=${encodeURIComponent(symbol)}&type=trailingDilutedEPS,trailingPeRatio&period1=${start}&period2=${now}`;
  const json = await fetchJson(url);
  const rows = json.timeseries?.result ?? [];
  let eps = null;
  let epsAsOf = null;
  let peReported = null;
  let peAsOf = null;
  for (const row of rows) {
    const type = row.meta?.type?.[0];
    if (type === "trailingDilutedEPS") {
      const point = lastPoint(row.trailingDilutedEPS);
      if (point) {
        eps = point.raw;
        epsAsOf = point.asOf;
      }
    }
    if (type === "trailingPeRatio") {
      const point = lastPoint(row.trailingPeRatio);
      if (point) {
        peReported = point.raw;
        peAsOf = point.asOf;
      }
    }
  }
  return { eps, epsAsOf, peReported, peAsOf };
}

function utcDate(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function closeOnOrBefore(bars, date) {
  let best = null;
  for (const bar of bars) {
    if (utcDate(bar.ts) <= date) best = bar.close;
    else break;
  }
  return best;
}

function closeAtOrBeforeTs(bars, target) {
  let best = null;
  for (const bar of bars) {
    if (bar.ts <= target) best = bar.close;
    else break;
  }
  return best;
}

function windowReturn(price, bars, days) {
  if (bars.length < 2) return null;
  const target = bars[bars.length - 1].ts - days * 86400;
  if (bars[0].ts > target + 21 * 86400) return null;
  const past = closeAtOrBeforeTs(bars, target);
  if (past == null || past === 0) return null;
  return ((price - past) / past) * 100;
}

function ytdReturn(price, bars, gmtoffset) {
  if (!bars.length) return null;
  const last = bars[bars.length - 1].ts;
  const year = new Date((last + gmtoffset) * 1000).getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1) / 1000 - gmtoffset;
  const first = bars.find((bar) => bar.ts >= yearStart);
  if (!first || first.close === 0) return null;
  return ((price - first.close) / first.close) * 100;
}

function chooseLivePe(price, eps, peReported, closeOnReport) {
  const fromEps = eps != null && Math.abs(eps) > 1e-6 ? price / eps : null;
  const fromAnchor =
    peReported != null && closeOnReport != null && closeOnReport > 0
      ? peReported * (price / closeOnReport)
      : null;
  if (fromEps != null && fromAnchor != null && fromAnchor !== 0) {
    const ratio = fromEps / fromAnchor;
    if (ratio > 1.35 || ratio < 1 / 1.35) return { pe: fromAnchor, live: true, method: "anchor" };
    return { pe: fromEps, live: true, method: "eps" };
  }
  if (fromEps != null) return { pe: fromEps, live: true, method: "eps" };
  if (fromAnchor != null) return { pe: fromAnchor, live: true, method: "anchor" };
  if (peReported != null) return { pe: peReported, live: false, method: "reported" };
  return { pe: null, live: false, method: "none" };
}

function sectorOf(symbol, name) {
  const s = `${symbol} ${name}`.toUpperCase();
  if (/(NVDA|TCS|INFY|AAPL|MSFT|ASML|GOOGL|META|AMD)/.test(s)) return "Tecnologia";
  if (/(GALP|PETR|RELIANCE|SHEL|XOM|BP\b)/.test(s)) return "Energia";
  if (/(EDP|ENEL|ENGIE|IBER)/.test(s)) return "Utilidades Públicas";
  if (/(PG|KO\b|PEP|ULVR|\bUL\b|BEI|JNJ|NESN)/.test(s)) return "Consumo Defensivo";
  if (/(AMZN|TSLA|NKE|WHR)/.test(s)) return "Consumo Cíclico";
  if (/(JPM|BAC|BNP|HDB|HSBA)/.test(s)) return "Serviços Financeiros";
  if (/(PFE|AZN|LLY|NOVO)/.test(s)) return "Saúde";
  return "Geral";
}

function round2(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

async function rateToEur(currency) {
  const code = currency.toUpperCase();
  if (code === "EUR") return 1;
  return cached(`fx:${code}`, FX_TTL, async () => {
    try {
      const chart = await loadChart(`${code}EUR=X`, "5d");
      return chart.price;
    } catch {
      return FX_FALLBACK[code] ?? 1;
    }
  });
}

async function getQuote(symbol) {
  const [chart, fund] = await Promise.all([
    cached(`chart:${symbol}`, CHART_TTL, () => loadChart(symbol, "5y")),
    cached(`fund:${symbol}`, FUND_TTL, () => loadFundamentals(symbol)).catch(() => ({
      eps: null,
      epsAsOf: null,
      peReported: null,
      peAsOf: null,
    })),
  ]);
  const closeOnReport = fund.peAsOf ? closeOnOrBefore(chart.bars, fund.peAsOf) : null;
  const chosen = chooseLivePe(chart.price, fund.eps, fund.peReported, closeOnReport);
  const rate = await rateToEur(chart.currency);
  const sector = sectorOf(symbol, chart.name);
  const day =
    chart.changePercent != null
      ? chart.changePercent
      : chart.bars.length >= 2
        ? ((chart.price - chart.bars[chart.bars.length - 2].close) / chart.bars[chart.bars.length - 2].close) * 100
        : null;
  const spark = chart.bars.slice(-22).map((bar) => Math.round(bar.close * rate * 100) / 100);
  if (spark.length) spark[spark.length - 1] = Math.round(chart.price * rate * 100) / 100;
  return {
    ticker: symbol,
    name: chart.name,
    market: chart.exchange,
    sector,
    origCurrency: chart.currency,
    origPrice: round2(chart.price) ?? chart.price,
    price: round2(chart.price * rate) ?? chart.price * rate,
    ret1D: round2(day),
    ret1W: round2(windowReturn(chart.price, chart.bars, 7)),
    ret1M: round2(windowReturn(chart.price, chart.bars, 30)),
    ret3M: round2(windowReturn(chart.price, chart.bars, 91)),
    ret6M: round2(windowReturn(chart.price, chart.bars, 182)),
    ret1Y: round2(windowReturn(chart.price, chart.bars, 365)),
    retYTD: round2(ytdReturn(chart.price, chart.bars, chart.gmtoffset)),
    ret3Y: round2(windowReturn(chart.price, chart.bars, 365 * 3)),
    ret5Y: round2(windowReturn(chart.price, chart.bars, 365 * 5)),
    pe: round2(chosen.pe),
    peReported: round2(fund.peReported),
    peLive: chosen.live,
    peMethod: chosen.method,
    eps: fund.eps != null ? Math.round(fund.eps * 1000) / 1000 : null,
    epsAsOf: fund.epsAsOf,
    peAsOf: fund.peAsOf,
    isTech: sector === "Tecnologia",
    spark,
    updatedAt: Date.now(),
  };
}

async function searchSymbols(query) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}`;
  const json = await fetchJson(url);
  return (json.quotes ?? [])
    .filter((item) => typeof item.symbol === "string")
    .slice(0, 8)
    .map((item) => ({
      symbol: String(item.symbol),
      name: String(item.shortname || item.longname || item.symbol),
      exch: String(item.exchange || ""),
      type: String(item.quoteType || ""),
    }));
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function sendJson(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleQuote(url, res) {
  const raw = url.searchParams.get("symbols") ?? url.searchParams.get("symbol") ?? "";
  const symbols = [...new Set(raw.split(",").map((part) => part.trim().toUpperCase()).filter(Boolean))].slice(0, 12);
  if (!symbols.length) return sendJson(res, { error: "Símbolo em falta." }, 400);
  if (symbols.some((symbol) => !SYMBOL.test(symbol))) return sendJson(res, { error: "Símbolo inválido." }, 400);
  const single = !url.searchParams.get("symbols");
  const results = await mapPool(symbols, 4, async (symbol) => {
    try {
      return { ok: true, quote: await getQuote(symbol) };
    } catch (error) {
      console.error(`[quote] ${symbol}`, error instanceof Error ? error.message : error);
      return { ok: false, symbol, error: "Sem cotação para este símbolo." };
    }
  });
  if (single) {
    const first = results[0];
    if (!first.ok) return sendJson(res, { error: first.error }, 404);
    return sendJson(res, first.quote);
  }
  return sendJson(res, {
    quotes: results.flatMap((result) => (result.ok ? [result.quote] : [])),
    errors: results.flatMap((result) => (result.ok ? [] : [{ symbol: result.symbol, error: result.error }])),
  });
}

async function handleSearch(url, res) {
  const query = (url.searchParams.get("q") ?? "").replace(/[^\p{L}\p{N} .&-]/gu, "").trim();
  if (query.length < 2 || query.length > 40) return sendJson(res, []);
  try {
    return sendJson(res, await searchSymbols(query));
  } catch (error) {
    console.error("[search]", error instanceof Error ? error.message : error);
    return sendJson(res, []);
  }
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function handleStatic(pathname, res) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = normalize(join(publicDir, rel));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Não encontrado");
  }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/quote") return await handleQuote(url, res);
    if (req.method === "GET" && url.pathname === "/api/search") return await handleSearch(url, res);
    if (req.method === "GET") return await handleStatic(url.pathname, res);
    res.writeHead(405);
    res.end("Method not allowed");
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, { error: "Erro interno." }, 500);
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Alentejano Analista a escutar na porta ${PORT}`);
});
