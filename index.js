import express from "express";
import cron from "node-cron";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_, res) => res.status(200).send("ok"));

const BINANCE_BASE = process.env.BINANCE_BASE || "https://data-api.binance.vision"; // public market data :contentReference[oaicite:2]{index=2}

function cleanTicker(s) {
  if (!s) return "";
  s = String(s).toUpperCase().trim();
  s = s.replace(/^BINANCE:/, "");
  s = s.replace(/(USDT|USD|BTC|ETH)$/, "");
  s = s.replace(/[-/]/g, "");
  s = s.replace(/[^A-Z0-9]/g, "");
  return s;
}

async function fetchKlines(symbol, limit = 260) {
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`; // :contentReference[oaicite:3]{index=3}
  const r = await fetch(url);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(data)) return null;

  const ohlc = data.map(k => ({
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
  })).filter(x => Number.isFinite(x.close));
  return ohlc.length ? ohlc : null;
}

function percentileLinear(arr, p) {
  const a = [...arr].sort((x,y)=>x-y);
  const n = a.length;
  if (!n) return NaN;
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  const w = idx - lo;
  return a[lo] + (a[hi] - a[lo]) * w;
}

function ema(series, len) {
  const k = 2 / (len + 1);
  const out = [];
  let prev = series[0];
  out.push(prev);
  for (let i = 1; i < series.length; i++) {
    const v = series[i];
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rma(series, len) { // Wilder
  const out = [];
  if (series.length < len) return [];
  let sum = 0;
  for (let i = 0; i < len; i++) sum += series[i];
  let prev = sum / len;
  for (let i = 0; i < series.length; i++) {
    if (i < len) out.push(NaN);
    else {
      prev = (prev * (len - 1) + series[i]) / len;
      out.push(prev);
    }
  }
  // set first defined value at index len-1 to the SMA (closer to Pine feel)
  out[len - 1] = sum / len;
  return out;
}

function trueRange(ohlc, i) {
  if (i === 0) return ohlc[i].high - ohlc[i].low;
  const h = ohlc[i].high, l = ohlc[i].low, pc = ohlc[i-1].close;
  return Math.max(h - l, Math.max(Math.abs(h - pc), Math.abs(l - pc)));
}

function flagBTC_P75(closes, pctLen = 180) {
  if (closes.length < pctLen + 2) return -1;
  const wNow = closes.slice(-pctLen);
  const wPrev = closes.slice(-pctLen - 1, -1);
  const pNow = percentileLinear(wNow, 75);
  const pPrev = percentileLinear(wPrev, 75);
  if (!Number.isFinite(pNow) || !Number.isFinite(pPrev)) return -1;
  const cNow = closes[closes.length - 1];
  return (cNow > pNow && pNow > pPrev) ? 1 : 0;
}

function flagETH_EKT(ohlc, maLen=55, atrLen=20, mult=1.6) {
  if (ohlc.length < Math.max(maLen, atrLen) + 5) return -1;
  const closes = ohlc.map(x=>x.close);

  const tr = ohlc.map((_,i)=>trueRange(ohlc,i));
  const atr = rma(tr, atrLen);
  const basis = ema(closes, maLen);

  if (!atr.length || !basis.length) return -1;

  const upper = closes.map((_,i)=> (Number.isFinite(basis[i]) && Number.isFinite(atr[i])) ? (basis[i] + mult*atr[i]) : NaN);
  const lower = closes.map((_,i)=> (Number.isFinite(basis[i]) && Number.isFinite(atr[i])) ? (basis[i] - mult*atr[i]) : NaN);

  let dir = 0;
  for (let i = 1; i < closes.length; i++) {
    if (!Number.isFinite(upper[i]) || !Number.isFinite(lower[i])) continue;
    const c0 = closes[i-1], c1 = closes[i];
    if (c0 <= upper[i-1] && c1 > upper[i]) dir = 1;
    else if (c0 >= lower[i-1] && c1 < lower[i]) dir = -1;
  }
  return dir === 1 ? 1 : 0;
}

function flagUSD_MedianSupertrend(ohlc, medLen=100, atrLen=10, mult=3.0) {
  const n = ohlc.length;
  if (n < Math.max(medLen, atrLen) + 5) return -1;

  const closes = ohlc.map(x=>x.close);
  const tr = ohlc.map((_,i)=>trueRange(ohlc,i));
  const atr = rma(tr, atrLen);
  if (!atr.length) return -1;

  // rolling median series (percentile 50)
  const med = new Array(n).fill(NaN);
  for (let i = medLen - 1; i < n; i++) {
    const win = closes.slice(i - medLen + 1, i + 1);
    med[i] = percentileLinear(win, 50);
  }

  let finalUpper = NaN, finalLower = NaN;
  let dir = 1;

  for (let i = 1; i < n; i++) {
    if (!Number.isFinite(med[i]) || !Number.isFinite(atr[i])) continue;

    const basicUpper = med[i] + mult * atr[i];
    const basicLower = med[i] - mult * atr[i];

    if (!Number.isFinite(finalUpper)) finalUpper = basicUpper;
    else {
      if (basicUpper < finalUpper || closes[i-1] > finalUpper) finalUpper = basicUpper;
    }

    if (!Number.isFinite(finalLower)) finalLower = basicLower;
    else {
      if (basicLower > finalLower || closes[i-1] < finalLower) finalLower = basicLower;
    }

    if (closes[i] > finalUpper) dir = 1;
    else if (closes[i] < finalLower) dir = -1;
  }

  return dir === 1 ? 1 : 0;
}

async function runScan() {
  const secret = process.env.TV_SECRET;
  const gas = process.env.APPS_SCRIPT_URL;
  if (!secret || !gas) throw new Error("Missing TV_SECRET or APPS_SCRIPT_URL");

  // 1) Read live tickers from sheet
  const listUrl = `${gas}?key=${encodeURIComponent(secret)}`;
  const listResp = await fetch(listUrl);
  const listJson = await listResp.json();
  const tickers = (listJson && listJson.tickers) ? listJson.tickers : [];

  const updates = [];
  for (const item of tickers) {
    const t = cleanTicker(item.ticker);
    if (!t) continue;

    const symBTC = `${t}BTC`;
    const symETH = `${t}ETH`;
    const symUSD = `${t}USDT`;

    // BTC
    let btc = -1;
    const ohlcBTC = await fetchKlines(symBTC, 260);
    if (ohlcBTC) btc = flagBTC_P75(ohlcBTC.map(x=>x.close));

    // ETH
    let eth = -1;
    const ohlcETH = await fetchKlines(symETH, 260);
    if (ohlcETH) eth = flagETH_EKT(ohlcETH);

    // USD
    let usd = -1;
    const ohlcUSD = await fetchKlines(symUSD, 260);
    if (ohlcUSD) usd = flagUSD_MedianSupertrend(ohlcUSD);

    updates.push({ ticker: t, btc, eth, usd });
  }

  // 2) Batch write back to sheet
  const writeResp = await fetch(gas, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: secret, updates }),
  });
  const writeText = await writeResp.text();
  return { count: updates.length, write_status: writeResp.status, write_body: writeText };
}

// Keep your existing /tv webhook (still works if you want it)
app.post("/tv", async (req, res) => {
  try {
    const body = req.body || {};
    const secret = process.env.TV_SECRET;
    if (!secret || body.key !== secret) return res.status(401).json({ ok:false, error:"bad key" });

    const r = await fetch(process.env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await r.text();
    res.status(200).json({ ok:true, forwarded_status:r.status, forwarded_body:text });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// NEW: manual scan endpoint
app.post("/scan", async (req, res) => {
  try {
    const secret = process.env.TV_SECRET;
    if (!secret || req.body?.key !== secret) return res.status(401).json({ ok:false, error:"bad key" });
    const result = await runScan();
    res.status(200).json({ ok:true, ...result });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// Optional: auto-scan schedule (UTC). Example "10 0 * * *" = 00:10 daily.
const cronExpr = process.env.SCAN_CRON;
if (cronExpr) {
  cron.schedule(cronExpr, async () => {
    try { await runScan(); } catch (e) { console.error("scan failed:", e); }
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
