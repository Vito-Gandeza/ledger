// Vercel function: one year of daily closes per symbol, trimmed to what the invest page needs.
// Yahoo's chart API refuses browser requests (no CORS header), so it has to be called from here.
// GET /api/chart?s=VOO,VTI  ->  {VOO:{name,price,chg,high52,low52,t:[],c:[]}, VTI:{error}}
const SYM = /^[A-Z][A-Z0-9.\-]{0,9}$/;

async function one(sym){
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`,
    { headers: { "user-agent": "Mozilla/5.0" } });
  if(!r.ok) return { error: `no data (${r.status})` };
  const x = (await r.json())?.chart?.result?.[0];
  if(!x?.meta?.regularMarketPrice) return { error: "no data" };
  const m = x.meta, c = x.indicators?.quote?.[0]?.close || [], t = x.timestamp || [];
  // Holidays and half-days come back as null closes; drop them so averages stay honest.
  const keep = c.map((v,i) => v == null ? -1 : i).filter(i => i >= 0);
  return {
    name: m.longName || m.shortName || sym, price: m.regularMarketPrice,
    // chartPreviousClose is the close before the whole 1y range, not yesterday's.
    chg: m.regularMarketChangePercent ?? null,
    high52: m.fiftyTwoWeekHigh ?? null, low52: m.fiftyTwoWeekLow ?? null,
    t: keep.map(i => t[i]), c: keep.map(i => Math.round(c[i] * 100) / 100),
  };
}

module.exports = async (req, res) => {
  const q = new URL(req.url, "http://x").searchParams.get("s") || "";
  const syms = [...new Set(q.toUpperCase().split(",").map(s => s.trim()).filter(Boolean))];
  res.setHeader("content-type", "application/json");
  if(!syms.length || syms.length > 20 || !syms.every(s => SYM.test(s))){
    res.statusCode = 400; return res.end(JSON.stringify({ error: "pass ?s=VOO,VTI (up to 20 tickers)" }));
  }
  const out = {};
  await Promise.all(syms.map(async s => { try { out[s] = await one(s); } catch(e){ out[s] = { error: "fetch failed" }; } }));
  // Delayed quotes anyway; a 10-minute edge cache keeps Yahoo from rate-limiting us.
  res.setHeader("cache-control", "public, s-maxage=600, stale-while-revalidate=3600");
  res.end(JSON.stringify(out));
};
