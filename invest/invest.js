"use strict";
// Invest: a Gotrade companion to Ledger. A classic script loaded after ../data.js, so it reuses
// Ledger's helpers (money, r2, uid, esc, today, addDays, dues, loanCost, rpc, pullCloud…) and
// reads Ledger's state S. It never calls save() or pushCloud(): Ledger data is read, never written.

const SYM = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const usd = (n, d=2) => (n<0?"-":"") + "$" + Math.abs(n).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const php0 = n => (n<0?"-":"") + PESO + Math.round(Math.abs(n)).toLocaleString("en-PH");
const phpK = n => n >= 1e6 ? PESO + (n/1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? PESO + Math.round(n/1e3) + "k" : PESO + Math.round(n);
const sgn = (n, d=1) => (n>0?"+":"") + n.toFixed(d) + "%";
const tone = n => n>0 ? "ok" : n<0 ? "bad" : "dim";
const avg = a => a.reduce((s,x)=>s+x,0) / (a.length || 1);
const readJSON = k => { try{ return JSON.parse(localStorage.getItem(k) || "null"); } catch(e){ return null; } };

// ---------- state ----------
// minDep is Gotrade's ₱643.58 minimum (≈ $10 at their rate on the day it was read).
const SET0 = {weekly:1500, every:4, ret:8, years:20, buffer:5000, fee:45, wdFee:5, spread:2,
              minDep:643.58, dipPct:10, tilt:true};
const TX_TYPES = ["deposit","buy","sell","div","withdraw"];
// Every field coerced, so a hand-edited or old backup degrades to defaults instead of NaN.
function norm(p){
  p = p && typeof p === "object" ? p : {};
  const set = {...SET0};
  for(const k in SET0) if(p.set && k in p.set)
    set[k] = typeof SET0[k] === "boolean" ? !!p.set[k] : (Number.isFinite(+p.set[k]) && +p.set[k] >= 0 ? +p.set[k] : SET0[k]);
  set.every = Math.min(26, Math.max(1, Math.round(set.every)));
  set.years = Math.min(50, Math.max(1, Math.round(set.years)));
  return {v:1, set, chosen:!!p.chosen,   // chosen: the plan was picked by you, not left at the default
    targets: Array.isArray(p.targets)
      ? p.targets.filter(t => t && SYM.test(t.sym) && +t.pct > 0).map(t => ({sym:t.sym, pct:+t.pct}))
      : [{sym:"VOO", pct:100}],
    watch: Array.isArray(p.watch) ? p.watch.filter(s => SYM.test(s)) : ["VTI","SPY","QQQM"],
    tx: Array.isArray(p.tx) ? p.tx.filter(t => t && t.id && TX_TYPES.includes(t.type)).map(t => ({
      id:String(t.id), type:t.type, date: /^\d{4}-\d\d-\d\d$/.test(t.date) ? t.date : today(),
      sym: SYM.test(t.sym) ? t.sym : "", php:r2(t.php), usd:r2(t.usd),
      shares: Math.round((+t.shares || 0) * 1e6) / 1e6, mid: +t.mid || 0,
    })) : [],
  };
}
let P = norm(readJSON("invest"));
// Last good prices and peso rate, so a reload offline still shows numbers (marked stale).
let M = readJSON("investMkt") || {at:0, q:{}, fx:null};

function persist(){
  try{ localStorage.setItem("invest", JSON.stringify(P)); } catch(e){ console.warn("could not save", e); }
  queueInvestPush(); draw();
}

// ---------- sync ----------
// Rides on Ledger's sync code: the investing row's code is derived from it, so any device
// already linked to Ledger gets this too, and it is a separate row so neither page can
// overwrite the other's data. Same last-write-wins rules as Ledger.
async function investCode(){
  const c = syncCode(); if(!c || !crypto.subtle) return "";
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("invest:" + c)))]
    .map(b => b.toString(16).padStart(2,"0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-${(8 | parseInt(h[16],16) & 3).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;
}
let investReady = false, investTimer = null;
const setNote = t => { $("#note").textContent = t; };
async function investPush(){
  const code = await investCode(); if(!code) return;
  try{ localStorage.setItem("investStamp", await rpc("ledger_push", {p_code:code, p_data:P})); setNote("Synced"); }
  catch(e){ console.warn(e); setNote("Sync failed — will retry on next change"); }
}
function queueInvestPush(){
  if(!investReady || !syncCode()) return;
  clearTimeout(investTimer); investTimer = setTimeout(investPush, 1200);
}
async function bootInvestSync(){
  const code = await investCode();
  if(!code){ investReady = true; setNote("This browser only · turn on sync in Ledger"); return; }
  try{
    const row = await pullCloud(code);
    if(row && row.updated_at !== localStorage.getItem("investStamp")){
      P = norm(row.data); localStorage.setItem("investStamp", row.updated_at);
      try{ localStorage.setItem("invest", JSON.stringify(P)); } catch(e){}
    } else if(!row && P.tx.length) await investPush();
    setNote("Synced");
  } catch(e){ console.warn("invest sync check failed", e); setNote("Offline"); }
  investReady = true;
  // Ledger's own copy in the cloud may be newer than this browser's. Read it, never write it.
  try{
    const row = await pullCloud(syncCode());
    if(row && row.updated_at !== localStorage.getItem("syncStamp")) S = migrate(row.data);
  } catch(e){ console.warn("ledger pull failed", e); }
  draw();
}

// ---------- market data ----------
const symsWanted = () => [...new Set([...P.targets.map(t=>t.sym), ...P.watch, ...Object.keys(book().pos)])];
async function fetchFx(){
  const j = await (await fetch(`https://api.frankfurter.dev/v1/${addDays(today(),-95)}..?base=USD&symbols=PHP`)).json();
  const pts = Object.entries(j.rates || {}).map(([d,r]) => [d, r.PHP]).filter(x => x[1] > 0).sort();
  if(!pts.length) throw new Error("no rate");
  const v = pts.map(x => x[1]), last30 = v.slice(-21);   // ~21 business days
  return {mid:v.at(-1), date:pts.at(-1)[0], avg30:avg(last30), lo:Math.min(...v), hi:Math.max(...v)};
}
async function refresh(){
  setNote("Updating prices…");
  const syms = symsWanted();
  const [q, fx] = await Promise.allSettled([
    syms.length ? fetch("/api/chart?s=" + syms.join(",")).then(r => r.ok ? r.json() : Promise.reject(new Error(r.status))) : {},
    fetchFx(),
  ]);
  if(q.status === "fulfilled") M.q = {...M.q, ...q.value}, M.at = Date.now();
  if(fx.status === "fulfilled") M.fx = fx.value;
  try{ localStorage.setItem("investMkt", JSON.stringify(M)); } catch(e){}
  setNote(q.status === "fulfilled" ? "Prices updated " + new Date().toLocaleTimeString("en-PH",{hour:"numeric",minute:"2-digit"})
    : "Prices unavailable" + (M.at ? " · showing " + new Date(M.at).toLocaleString("en-PH",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}) : ""));
  draw();
}
function stat(sym){
  const q = M.q[sym]; if(!q || q.error || !(q.price > 0)) return null;
  const c = q.c || [], ma200 = c.length >= 200 ? avg(c.slice(-200)) : null;
  return {...q,
    off: q.high52 ? (q.price / q.high52 - 1) * 100 : null,     // % below the 52-week high
    vsMa: ma200 ? (q.price / ma200 - 1) * 100 : null,          // % above/below the 200-day average
    y1: c.length ? (q.price / c[0] - 1) * 100 : null};
}
const priceOf = sym => stat(sym)?.price ?? null;
// Mid-market pesos per dollar. Before the first fetch, fall back to the last deposit's own rate.
function mid(){
  if(M.fx?.mid) return M.fx.mid;
  const d = [...P.tx].reverse().find(t => t.type === "deposit" && t.usd > 0);
  return d ? (d.php - P.set.fee) / d.usd : 0;
}
const buyRate = () => mid() * (1 + P.set.spread/100);
const sellRate = () => mid() * (1 - P.set.spread/100);

// ---------- the book ----------
// Replays every transaction in date order. Average-cost basis: a sale removes its share of cost.
function book(tx = P.tx){
  let cash = 0, phpIn = 0, divs = 0, deps = 0, lastDep = "";
  const pos = {};
  for(const t of [...tx].sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)){
    const p = t.sym ? (pos[t.sym] ||= {shares:0, cost:0}) : null;
    if(t.type === "deposit"){ cash += t.usd; phpIn += t.php; deps++; lastDep = t.date; }
    if(t.type === "withdraw"){ cash -= t.usd; phpIn -= t.php; }
    if(t.type === "buy" && p){ cash -= t.usd; p.shares += t.shares; p.cost += t.usd; }
    if(t.type === "sell" && p){ cash += t.usd; p.cost -= p.shares > 0 ? p.cost * Math.min(1, t.shares / p.shares) : p.cost; p.shares -= t.shares; }
    if(t.type === "div"){ cash += t.usd; divs += t.usd; }
  }
  for(const s in pos){
    pos[s].shares = Math.round(pos[s].shares * 1e6) / 1e6; pos[s].cost = r2(pos[s].cost);
    if(pos[s].shares <= 0) delete pos[s];
  }
  return {cash:r2(cash), phpIn:r2(phpIn), divs:r2(divs), deps, lastDep, pos};
}
function worth(b){
  let val = 0, cost = 0;
  for(const [s,p] of Object.entries(b.pos)){
    p.px = priceOf(s) ?? p.cost / p.shares;    // unpriced: carry at cost rather than at zero
    p.val = r2(p.shares * p.px); val += p.val; cost += p.cost;
  }
  return {val:r2(val), cost:r2(cost), total:r2(b.cash + val)};
}

// ---------- what Ledger says ----------
function ledgerView(){
  const has = S.accounts.length > 0 || S.loans.length > 0;
  const liquid = r2(S.accounts.reduce((s,a) => s + a.bal, 0));
  const all = dues(30);
  const due = r2(all.reduce((s,d) => s + d.it.amount, 0));
  const overdue = r2(all.filter(d => daysTo(d.it.due) < 0).reduce((s,d) => s + d.it.amount, 0));
  const aside = S.accounts.filter(a => /gotrade|invest/i.test(a.name));
  const costly = S.loans.filter(L => !isCard(L) && unpaid(L).length)
    .map(L => ({L, c:loanCost(L)})).filter(x => x.c && x.c.apr > P.set.ret);
  return {has, liquid, due, overdue, aside, asideBal:r2(aside.reduce((s,a) => s + a.bal, 0)),
    free:r2(liquid - due - P.set.buffer), costly, allowance:S.allowance?.amount || 0};
}

// ---------- deposits ----------
// What a deposit cadence costs per year: the flat fee on every deposit, against the return lost
// while set-aside cash waits — on average (k-1)/2 weeks for a deposit every k weeks.
function cadence(){
  const {weekly:W, ret, fee, minDep} = P.set, r = ret / 100;
  return [1,2,4,8,13].map(k => {
    const dep = W * k, fees = fee * 52 / k, drag = W * 52 * r * (k - 1) / 104;
    return {k, dep, fees, drag, cost:fees + drag, feePct:dep ? fee / dep * 100 : 0, ok:dep >= minDep};
  });
}
const bestK = () => cadence().filter(x => x.ok).sort((a,b) => a.cost - b.cost)[0]?.k;
function depositQuote(php, rate = buyRate()){
  const got = rate > 0 && php > P.set.fee ? r2((php - P.set.fee) / rate) : 0;
  const atMid = mid() > 0 ? php / mid() : 0;
  return {usd:got, lost: atMid && got ? (1 - got / atMid) * 100 : null};
}
const kName = k => k === 1 ? "Every week" : k === 4 ? "Every 4 weeks (~monthly)" : k === 13 ? "Every 13 weeks (quarterly)" : `Every ${k} weeks`;

// ---------- projection ----------
// Week by week: the set-aside piles up, then lands every k weeks minus the fee and the spread.
// Value is in pesos at today's rate; the future peso/dollar rate is unknowable, so it is held flat.
// One entry per week: inv is what sits in funds, held is set-aside cash not yet deposited.
function simulate(weeks, startVal, startIn){
  const {weekly:W, every:k, ret, fee, spread} = P.set, g = Math.pow(1 + ret/100, 1/52);
  let inv = startVal, put = startIn, held = 0;
  const out = [{inv, held, val:inv, put}];
  for(let w = 1; w <= weeks; w++){
    inv *= g; held += W;
    if(w % k === 0 && held > fee){ put += held; inv += (held - fee) / (1 + spread/100); held = 0; }
    out.push({inv, held, val:inv + held, put:put + held});
  }
  return out;
}
// Every 4th week for the chart, tagged with its year (w/52) and calendar date.
function project(startVal, startIn){
  return simulate(P.set.years * 52, startVal, startIn)
    .map((p,w) => ({...p, w, y:w/52, date:addDays(today(), Math.round(w * 365.25 / 52))})).filter(p => p.w % 4 === 0);
}
// Pesos you'd actually get if you withdrew everything at week w: spread out, $5 fee, plus the
// set-aside cash that never left the bank.
const takeHome = p => Math.max(0, p.inv * (1 - P.set.spread/100) - (p.inv > 0 ? P.set.wdFee * sellRate() : 0)) + p.held;
const monthYear = d => new Date(d + "T00:00:00").toLocaleDateString("en-PH",{month:"short", year:"numeric"});

// ---------- buy plan ----------
// Splits cash so holdings move toward the plan's weights (rebalancing by buying, never by
// selling). With the tilt on, a fund that is down from its high counts double this round.
function buyPlan(cash, b){
  const T = P.targets; if(!T.length || !(cash >= 1)) return [];
  const cur = s => b.pos[s] ? b.pos[s].shares * (priceOf(s) ?? b.pos[s].cost / b.pos[s].shares) : 0;
  const sumPct = T.reduce((s,t) => s + t.pct, 0);
  const after = T.reduce((s,t) => s + cur(t.sym), 0) + cash;
  const rows = T.map(t => {
    const st = stat(t.sym), dip = !!(P.set.tilt && st?.off != null && st.off <= -P.set.dipPct);
    return {sym:t.sym, st, dip, pct:t.pct, w:Math.max(0, after * t.pct / sumPct - cur(t.sym)) * (dip ? 2 : 1)};
  });
  if(rows.every(r => r.w <= 0)) rows.forEach(r => r.w = r.pct * (r.dip ? 2 : 1));
  const sw = rows.reduce((s,r) => s + r.w, 0);
  return rows.map(r => {
    const amt = Math.floor(cash * r.w / sw * 100) / 100;   // floored so the total never exceeds the cash
    return {...r, amt, shares:r.st ? amt / r.st.price : null};
  });
}

// ---------- drawing ----------
function draw(){
  const b = book(), w = worth(b), L = ledgerView(), fx = mid();
  const valPhp = w.total * fx, out = Math.max(0, w.total - P.set.wdFee) * sellRate();
  const gain = valPhp - b.phpIn;

  $("#hVal").textContent = fx ? php0(valPhp) : usd(w.total);
  $("#hSub").innerHTML = P.tx.length
    ? `${usd(w.total)} on Gotrade · ${fx ? `<span class="${tone(gain)}">${gain >= 0 ? "+" : ""}${php0(gain)}</span> vs the ${php0(b.phpIn)} you put in` : ""}`
    : "Nothing yet. Follow the steps under “What to do next” to make your first investment.";
  $("#hSplit").innerHTML = [
    ["You put in", php0(b.phpIn)], ["Growth so far", fx && P.tx.length ? `<span class="${tone(gain)}">${gain >= 0 ? "+" : ""}${php0(gain)}</span>` : "—"],
    ["If you took it all out today", fx ? php0(out) : "—"], ["Dividends received", usd(b.divs)],
  ].map(([k,v]) => `<div><div class="eyebrow">${k}</div><div class="v num">${v}</div></div>`).join("");

  drawCoach(b, L);
  drawFlow(b, w, L);
  drawPlan();
  drawGoals(valPhp || 0);
  drawNow(L);
  drawBuy(b);
  drawHold(b, w);
  drawAct();
  drawDep(L);
  drawMkt(b);
  drawProj(valPhp || 0, b.phpIn);
}

function nextDepDate(b){ return b.lastDep ? addDays(b.lastDep, P.set.every * 7) : today(); }

// One prioritised to-do list: problems Ledger can see first, then the plan's next step.
function drawCoach(b, L){
  const tips = [], {weekly:W, every:k} = P.set, batch = W * k, next = nextDepDate(b);
  if(L.overdue > 0) tips.push(["bad", "First", `${money(L.overdue)} is overdue in Ledger. Clear it before investing — late fees cost more than the market returns.`]);
  if(L.has && L.free < 0) tips.push(["warn", "Hold", `Cash in Ledger minus the next 30 days of payments and your ${php0(P.set.buffer)} buffer is ${php0(L.free)}. Skip this deposit until that's positive.`]);
  if(b.cash >= 1) tips.push(["ok", "Buy", `${usd(b.cash)} is sitting uninvested on Gotrade. The buy plan below says how to split it.`]);
  if(!tips.some(t => t[0] !== "ok")){
    if(next <= today()){
      const amt = L.has ? Math.min(batch, Math.max(0, L.free)) : batch;
      tips.push(amt >= P.set.minDep
        ? ["ok", "Deposit", `Deposit <b>${money(amt)}</b> now${mid() ? ` — about <b>${usd(depositQuote(amt).usd)}</b> after the ₱${P.set.fee} fee at ~${money(buyRate())}/$` : ""}. Then log it here.`]
        : ["dim", "Wait", `Your next deposit is due, but there isn't ${money(P.set.minDep)} free to deposit yet.`]);
    } else {
      // With a Gotrade section in Ledger, show how full the next deposit already is.
      const fill = L.aside.length ? Math.min(100, L.asideBal / batch * 100) : null;
      tips.push(["dim", "Next", `Next deposit <b>${niceY(next)}</b> (in ${plural(daysTo(next), "day")}, every ${plural(k, "week")}). Set aside ${money(W)} a week until then.`
        + (fill != null ? `<div class="progress" role="img" aria-label="${Math.round(fill)}% of the next deposit set aside"><i style="width:${fill}%"></i></div>
          <div class="sub" style="margin-top:6px">${money(L.asideBal)} of ${money(batch)} set aside in your ${esc(L.aside[0].name)} section</div>` : "")]);
    }
  }
  // Until the first buy is logged, a numbered checklist explains the whole loop once.
  const bought = P.tx.some(t => t.type === "buy"), steps = [
    [P.chosen, `<b>Pick your plan</b> below — what to buy and how much a week.`],
    [b.deps > 0, `<b>Deposit</b> in Gotrade (Funding → Deposit), at least ${money(P.set.minDep)}. Then tap <b>Deposit</b> on the map below and copy what Gotrade showed.`],
    [bought, `<b>Buy</b> in Gotrade: search the ticker, enter a dollar amount from "What to buy". Then log it with <b>Buy</b>.`],
    [false, `<b>Repeat</b> every ${plural(k, "week")}. Log dividends when they arrive. Don't sell in dips.`],
  ];
  const first = steps.findIndex(x => !x[0]);
  const check = bought ? "" : `<ol class="check">${steps.map(([done, t], i) => `<li class="${done ? "done" : i === first ? "now" : ""}"><span class="box">${done ? "✓" : i + 1}</span><span>${t}</span></li>`).join("")}</ol>`;
  $("#coach").innerHTML = check + tips.filter(t => bought || t[0] !== "dim").map(([c,l,t]) => `<div class="tip ${c === "ok" ? "" : c}"><span class="lbl">${l}</span>${t}</div>`).join("");
}

function drawNow(L){
  if(!L.has){
    $("#now").innerHTML = `<div class="empty">No Ledger data on this device. Open <a href="../">Ledger</a> here, or turn on sync there, and this section fills in — cash, upcoming payments and what's free to invest.</div>`;
    return;
  }
  const rows = [
    ["All wallets", money(L.liquid), ""],
    ["Due in the next 30 days", "−" + money(L.due), L.overdue ? `<span class="bad">${money(L.overdue)} of it overdue</span>` : "loans and card statements"],
    ["Emergency buffer", "−" + money(P.set.buffer), "kept out of the market"],
    ["Free to invest", money(L.free), "", L.free < 0 ? "bad" : "ok"],
  ];
  let h = rows.map(([n,v,s,c]) => `<div class="row"><div class="grow"><div>${n}</div>${s ? `<div class="sub">${s}</div>` : ""}</div><div class="amt num ${c||""}">${v}</div></div>`).join("");
  if(L.allowance) h += `<div class="row"><div class="grow sub">Your plan sets aside ${money(P.set.weekly)} of your ${money(L.allowance)} weekly allowance (${Math.round(P.set.weekly / L.allowance * 100)}%).</div></div>`;
  h += L.aside.length
    ? `<div class="row"><div class="grow"><div>Set aside for Gotrade</div><div class="sub">${L.aside.map(a => esc(a.name)).join(", ")} in Ledger</div></div><div class="amt num">${money(L.asideBal)}</div></div>`
    : `<div class="row"><div class="grow sub">Tip: add a section named <b>Gotrade</b> under your main wallet in Ledger and move each week's set-aside there. This page reads it, and it keeps the money from being spent before deposit day.</div></div>`;
  for(const x of L.costly) h += `<div class="row"><div class="grow sub"><span class="warn">${esc(x.L.label || x.L.provider)}</span> costs about ${Math.round(x.c.apr)}% a year — more than the ${P.set.ret}% you expect from stocks. Borrowing like this while investing loses money overall; avoid new instalment loans while you build this up.</div></div>`;
  $("#now").innerHTML = h;
}

function drawBuy(b){
  const def = b.cash >= 1 ? b.cash : depositQuote(P.set.weekly * P.set.every).usd;
  const el = $("#buy"), input = el.querySelector("input");
  // Follow the default (cash after a new deposit, say) until the user types their own figure.
  if(input && input.dataset.def === input.value) input.value = input.dataset.def = r2(def);
  const cash = input ? +input.value || 0 : r2(def);
  if(!input) el.innerHTML = `<div class="calc"><label>Dollars to invest<input id="buyAmt" type="number" min="0" step="0.01" inputmode="decimal" value="${r2(def)}" data-def="${r2(def)}"></label></div>
    <p class="sub" id="buyHint" style="margin-bottom:10px"></p><div id="buyRows"></div>`;
  $("#buyHint").textContent = b.cash >= 1 ? "Your uninvested cash on Gotrade." : "Your next deposit, estimated. Change it to plan any amount.";
  const plan = buyPlan(cash, b);
  if(!P.targets.length){ $("#buyRows").innerHTML = `<p class="dim">Set your plan in Plan &amp; settings first.</p>`; return; }
  if(!plan.length){ $("#buyRows").innerHTML = `<p class="dim">Enter at least $1.</p>`; return; }
  $("#buyRows").innerHTML = plan.map(r => `<div class="row" style="padding:10px 0">
      <div class="grow"><b>${esc(r.sym)}</b> <span class="sub">target ${r.pct}%</span>
        ${r.dip ? `<span class="chip sale">${r.st.off.toFixed(0)}% under high · double weight</span>` : ""}</div>
      <div style="text-align:right"><div class="amt num">${r.amt >= 1 ? usd(r.amt) : "—"}</div>
        <div class="sub">${r.amt < 1 ? "below $1, skip" : r.shares != null ? `≈ ${r.shares.toFixed(4)} shares` : "no price yet"}</div></div></div>`).join("")
    + `<p class="sub" style="margin-top:8px">Buy each as a dollar amount in Gotrade (fractional shares), then log it under Activity.</p>`;
}

function drawHold(b, w){
  const syms = Object.keys(b.pos);
  if(!syms.length){ $("#hold").innerHTML = `<div class="empty">No holdings yet.</div>`; return; }
  const tgt = Object.fromEntries(P.targets.map(t => [t.sym, t.pct]));
  const sumPct = P.targets.reduce((s,t) => s + t.pct, 0) || 1;
  $("#hold").innerHTML = `<div class="scroll"><table><thead><tr><th>Fund</th><th>Shares</th><th>Avg cost</th><th>Value</th><th>Gain</th><th>Weight</th></tr></thead><tbody>`
    + syms.map(s => { const p = b.pos[s], g = p.cost ? (p.val / p.cost - 1) * 100 : 0;
        return `<tr><td><b>${esc(s)}</b></td><td>${p.shares.toFixed(4)}</td><td>${usd(p.cost / p.shares)}</td><td>${usd(p.val)}</td>
          <td class="${tone(g)}">${sgn(g)}</td><td>${w.val ? Math.round(p.val / w.val * 100) : 0}%${tgt[s] ? ` <span class="dim">/ ${Math.round(tgt[s] / sumPct * 100)}%</span>` : ""}</td></tr>`; }).join("")
    + `</tbody></table></div>`;
}

const TX_LABEL = {deposit:"Deposit", buy:"Bought", sell:"Sold", div:"Dividend", withdraw:"Withdrew"};
function drawAct(){
  if(!P.tx.length){ $("#act").innerHTML = `<div class="empty">Log each deposit and buy as you make it in Gotrade. Everything above is worked out from this list.</div>`; return; }
  const rows = [...P.tx].sort((a,b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  $("#act").innerHTML = rows.slice(0, 60).map(t => {
    const what = t.type === "deposit" ? `${money(t.php)} → ${usd(t.usd)}` + (t.usd ? ` <span class="sub">at ${money((t.php - P.set.fee) / t.usd)}/$</span>` : "")
      : t.type === "withdraw" ? `${usd(t.usd)} → ${money(t.php)}`
      : t.type === "div" ? `${esc(t.sym)} · ${usd(t.usd)}`
      : `${esc(t.sym)} · ${t.shares.toFixed(4)} sh · ${usd(t.usd)}`;
    return `<div class="row"><div class="grow"><div>${TX_LABEL[t.type]} <span class="sub">${niceY(t.date)}</span></div><div class="sub">${what}</div></div>
      <button class="x" data-del="${esc(t.id)}" aria-label="Delete this entry">&times;</button></div>`;
  }).join("") + (rows.length > 60 ? `<div class="empty">${rows.length - 60} older entries hidden (still counted).</div>` : "");
}

function drawDep(L){
  const el = $("#dep"), rows = cadence(), best = bestK(), fx = M.fx;
  const deps = P.tx.filter(t => t.type === "deposit" && t.usd > 0 && t.mid > 0);
  const realSpread = deps.length ? avg(deps.map(t => ((t.php - P.set.fee) / t.usd / t.mid - 1) * 100)) : null;
  const input = el.querySelector("#depAmt");
  const amt = input ? +input.value || 0 : P.set.weekly * P.set.every;
  if(!input) el.innerHTML = `<div class="calc"><label>If I deposit (₱)<input id="depAmt" type="number" min="0" step="100" inputmode="decimal" value="${amt}"></label>
      <label>at Gotrade's rate (₱/$)<input id="depRate" type="number" min="0" step="0.01" inputmode="decimal" placeholder=""></label></div>
    <p id="depOut" style="margin:8px 0 14px"></p>
    <div class="eyebrow" style="margin-bottom:4px">How often to deposit ${money(P.set.weekly)}/week</div>
    <div class="scroll"><table id="cad"></table></div><p class="sub" id="cadNote" style="margin-top:10px"></p><p class="sub" id="fxNote" style="margin-top:10px"></p>`;
  const rateIn = $("#depRate");
  rateIn.placeholder = buyRate() ? buyRate().toFixed(2) : "e.g. 64.36";
  const q = depositQuote(amt, +rateIn.value || buyRate());
  $("#depOut").innerHTML = amt < P.set.minDep ? `<span class="warn">Below Gotrade's ${money(P.set.minDep)} minimum.</span>`
    : `You'd receive about <b>${usd(q.usd)}</b>. Fee ₱${P.set.fee} = <b>${(P.set.fee / amt * 100).toFixed(2)}%</b> of it${q.lost != null ? `; fee and exchange rate together cost <b>${q.lost.toFixed(2)}%</b> vs the mid-market rate` : ""}.`;
  $("#cad").innerHTML = `<thead><tr><th>Cadence</th><th>Each deposit</th><th>Fee %</th><th>Fees/yr</th><th>Waiting cost/yr</th><th>Total/yr</th></tr></thead><tbody>`
    + rows.map(r => `<tr class="${r.k === best ? "best" : ""}"><td>${kName(r.k)}${r.k === P.set.every ? ` <span class="chip">yours</span>` : ""}</td><td>${money(r.dep)}</td>
        <td>${r.ok ? r.feePct.toFixed(2) + "%" : `<span class="warn">below min</span>`}</td><td>${php0(r.fees)}</td><td>${php0(r.drag)}</td><td><b>${php0(r.cost)}</b></td></tr>`).join("") + `</tbody>`;
  const mine = rows.find(r => r.k === P.set.every), top = rows.find(r => r.k === best);
  $("#cadNote").innerHTML = (top && mine && top.k !== mine.k
      ? `<b>${kName(top.k)}</b> is cheapest for you — ${php0(mine.cost - top.cost)} a year less than your current cadence. `
      : top ? `Your cadence is the cheapest option. ` : "")
    + `"Waiting cost" is the return missed while set-aside cash waits for deposit day, at your ${P.set.ret}% assumption. Keep the waiting money in a Ledger section so it isn't spent.`;
  $("#fxNote").innerHTML = (fx ? `Mid-market today ${money(fx.mid)}/$ (ECB, ${nice(fx.date)}). 30-day average ${money(fx.avg30)}, 90-day range ${money(fx.lo)}–${money(fx.hi)}. ` : "")
    + (realSpread != null ? `Your logged deposits got rates ${realSpread.toFixed(2)}% worse than mid-market on average. ` : "")
    + `Trying to time the peso rarely beats depositing on schedule: a 1% better rate on ₱6,000 is ₱60.`;
}

function spark(c){
  if(!c || c.length < 2) return "";
  const lo = Math.min(...c), hi = Math.max(...c), n = c.length;
  const pts = c.map((v,i) => `${(i / (n-1) * 108 + 1).toFixed(1)},${(29 - (v - lo) / (hi - lo || 1) * 27).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 110 30" role="img" aria-label="one-year price line"><title>1 year: ${usd(c[0])} → ${usd(c.at(-1))}</title><polyline points="${pts}"/></svg>`;
}
function drawMkt(b){
  const syms = symsWanted();
  $("#mktSub").textContent = M.at ? "as of " + new Date(M.at).toLocaleString("en-PH",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}) : "";
  if(!syms.length){ $("#mkt").innerHTML = `<div class="empty">Add tickers in Plan &amp; settings.</div>`; return; }
  $("#mkt").innerHTML = `<table><thead><tr><th>Ticker</th><th>Price</th><th>Today</th><th>From 52-wk high</th><th>vs 200-day avg</th><th>1 year</th><th></th></tr></thead><tbody>`
    + syms.map(s => {
      const st = stat(s), err = M.q[s]?.error;
      if(!st) return `<tr><td><b>${esc(s)}</b></td><td colspan="6" class="dim" style="text-align:left">${err ? esc(err) : "no price yet"}</td></tr>`;
      const tag = st.off != null && st.off <= -P.set.dipPct ? `<span class="chip sale">dip</span>` : st.off != null && st.off > -2 ? `<span class="chip">near high</span>` : "";
      return `<tr><td><b>${esc(s)}</b> ${P.targets.some(t => t.sym === s) ? `<span class="chip">plan</span>` : ""} ${tag}<div class="sub">${esc(st.name).slice(0,30)}</div></td>
        <td>${usd(st.price)}</td><td class="${tone(st.chg ?? 0)}">${st.chg != null ? sgn(st.chg, 2) : "—"}</td>
        <td>${st.off != null ? sgn(st.off) : "—"}</td><td>${st.vsMa != null ? sgn(st.vsMa) : "—"}</td>
        <td class="${tone(st.y1 ?? 0)}">${st.y1 != null ? sgn(st.y1) : "—"}</td><td>${spark(st.c)}</td></tr>`;
    }).join("") + `</tbody></table>`;
}

// ---------- plan builder ----------
// Common starting points, described by what they hold and how much they swing. The page applies
// whichever you pick; it doesn't pick for you.
const PRESETS = [
  {id:"sp500", name:"Just the S&P 500", plan:[{sym:"VOO", pct:100}], swing:2,
   text:"The 500 biggest US companies (Apple, Microsoft, Nvidia, Amazon…) in one fund. One thing to buy, nothing to balance — the usual first pick."},
  {id:"total", name:"Whole US market", plan:[{sym:"VTI", pct:100}], swing:2,
   text:"About 3,500 US companies, big and small. Moves almost exactly like the S&P 500, so choose this or that, not both."},
  {id:"tech", name:"S&P 500 + extra tech", plan:[{sym:"VOO", pct:80}, {sym:"QQQM", pct:20}], swing:3,
   text:"Adds weight in the 100 biggest Nasdaq companies, mostly tech. Has grown faster in recent years and falls harder in crashes."},
];
const sameMix = (a, b) => a.length === b.length && a.every(x => b.some(y => y.sym === x.sym && y.pct === x.pct));
const mixText = plan => plan.map(t => `${t.sym} ${t.pct}%`).join(" + ");
const meter = n => `<span class="meter" aria-label="${["","low","medium","high"][n]} swings">${[1,2,3].map(i => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;
const RETURNS = [[5, "Cautious"], [8, "Middle"], [10, "Long-run S&P avg"]];

function drawPlan(){
  const cur = PRESETS.find(p => sameMix(p.plan, P.targets));
  $("#presets").innerHTML = PRESETS.map(p => `<label class="preset"><input type="radio" name="preset" value="${p.id}" ${cur === p ? "checked" : ""}>
      <div class="t">${p.name}</div><div class="mix">${mixText(p.plan)}</div><p>${p.text}</p>
      <div class="sw2">Ups and downs ${meter(p.swing)}</div></label>`).join("")
    + `<label class="preset"><input type="radio" name="preset" value="custom" ${cur ? "" : "checked"}>
      <div class="t">Your own mix</div><div class="mix">${cur ? "e.g. VOO 90 + NVDA 10" : esc(mixText(P.targets)) || "nothing yet"}</div>
      <p>Add a single company you believe in as a small slice. One company can drop 50% and stay down, so keep it small.</p>
      <div class="sw2">Ups and downs ${meter(3)} · <a href="#" data-edit-plan>${cur ? "Set it up" : "Edit"}</a></div></label>`;

  const s = P.set, el = $("#controls");
  if(!el.firstChild){
    el.innerHTML = `<div class="ctl"><div class="top"><span>Put aside each week</span><b id="cWeeklyV"></b></div>
        <input type="range" id="cWeekly" min="200" max="5000" step="50" aria-label="Pesos per week"><div class="sub" id="cWeeklyS"></div></div>
      <div class="ctl"><div class="top"><span>Deposit to Gotrade every</span><span class="sub">₱${s.fee} fee each time</span></div>
        <div class="seg" id="cEvery">${[1,2,4,8].map(k => `<label><input type="radio" name="cEvery" value="${k}"><span>${k === 1 ? "week" : k + " weeks"}<small></small></span></label>`).join("")}</div>
        <div class="sub" id="cEveryS" style="margin-top:6px"></div></div>
      <div class="ctl"><div class="top"><span>Assume it grows</span><span class="sub">a guess, not a promise</span></div>
        <div class="seg" id="cRet">${RETURNS.map(([v,l]) => `<label><input type="radio" name="cRet" value="${v}"><span>${v}% a year<small>${l}</small></span></label>`).join("")}</div></div>
      <div class="ctl"><div class="top"><span>Look ahead</span><b id="cYearsV"></b></div>
        <input type="range" id="cYears" min="1" max="40" step="1" aria-label="Years to project"></div>
      <p class="sub">Fees, exchange rate and the rest are in <a href="#" data-open-set>Plan &amp; settings</a>.</p>`;
  }
  $("#cWeekly").value = s.weekly; $("#cYears").value = s.years;
  $("#cWeeklyV").textContent = money(s.weekly).replace(".00", "");
  $("#cWeeklyS").textContent = `≈ ${php0(s.weekly * 52 / 12)} a month · ${php0(s.weekly * 52)} a year`;
  $("#cYearsV").textContent = plural(s.years, "year");
  const cad = cadence();
  el.querySelectorAll('[name="cEvery"]').forEach(r => {
    const c = cad.find(x => x.k === +r.value);
    r.checked = +r.value === s.every;
    r.nextElementSibling.querySelector("small").textContent = c.ok ? `${c.feePct.toFixed(1)}% fee` : "below min";
  });
  const mine = cad.find(x => x.k === s.every), best = cad.find(x => x.k === bestK());
  $("#cEveryS").innerHTML = `${php0(s.weekly * s.every)} per deposit · ${php0(mine?.fees || 0)} a year in fees`
    + (best && mine && best.k !== mine.k && mine.cost - best.cost >= 100 ? ` · <span class="warn">every ${plural(best.k, "week")} saves ${php0(mine.cost - best.cost)}/yr</span>` : "");
  el.querySelectorAll('[name="cRet"]').forEach(r => r.checked = +r.value === s.ret);
}
let planTimer = null;
// Sliders redraw live but save once you stop dragging, so sync isn't hit on every pixel.
function setPlan(patch, now){
  Object.assign(P.set, patch); P = norm(P);
  drawPlan(); draw();
  clearTimeout(planTimer); planTimer = setTimeout(persist, now ? 0 : 500);
}
$("#controls").addEventListener("input", e => {
  if(e.target.id === "cWeekly") setPlan({weekly:+e.target.value});
  if(e.target.id === "cYears") setPlan({years:+e.target.value});
  if(e.target.name === "cEvery") setPlan({every:+e.target.value}, true);
  if(e.target.name === "cRet") setPlan({ret:+e.target.value}, true);
});
$("#presets").addEventListener("change", e => {
  const p = PRESETS.find(x => x.id === e.target.value);
  if(!p){ openSettings(); return; }
  P.targets = p.plan.map(t => ({...t})); P.chosen = true; persist(); refresh();
});
document.addEventListener("click", e => {
  if(e.target.closest("[data-edit-plan], [data-open-set]")){ e.preventDefault(); openSettings(); }
});

// ---------- projection ----------
function drawProj(startVal, startIn){
  const pts = project(startVal, startIn), last = pts.at(-1), {years, ret} = P.set, r = ret / 100;
  const at = y => pts.find(p => p.y >= y) || last;
  const perMonth = p => p.inv * (Math.pow(1 + r, 1/12) - 1);   // what the money earns by itself in a month

  const tileYears = [...new Set([5, 10, years].filter(y => y <= years))].slice(-3);
  $("#tiles").innerHTML = tileYears.map(y => { const p = at(y), g = Math.max(0, p.val - p.put);
    return `<div class="tile"><div class="eyebrow">In ${plural(y, "year")} · ${monthYear(p.date)}</div><div class="v num">${php0(p.val)}</div>
      <div class="bar2"><i style="flex:${p.put || 1}"></i><i style="flex:${g}"></i></div>
      <div class="sub">${php0(p.put)} put in + <b class="num">${php0(g)}</b> growth</div></div>`; }).join("");

  const W = 640, H = 270, l = 56, rr = 12, t = 12, bt = 26;
  const ymax = Math.max(...pts.map(p => Math.max(p.val, p.put)), 1) * 1.06;
  const X = y => l + y / years * (W - l - rr), Y = v => t + (1 - v / ymax) * (H - t - bt);
  const ticks = [0, .25, .5, .75, 1].map(f => ymax * f);
  const step = years <= 5 ? 1 : years <= 15 ? 2 : years <= 25 ? 5 : 10;
  const path = k => pts.map((p,i) => `${i ? "L" : "M"}${X(p.y).toFixed(1)},${Y(k(p)).toFixed(1)}`).join("");
  const top = p => Math.max(p.val, p.put);
  const area = (hi, lo) => path(hi) + pts.slice().reverse().map(p => `L${X(p.y).toFixed(1)},${Y(lo(p)).toFixed(1)}`).join("") + "Z";
  const gEnd = last.val - last.put, lab = (txt, y) => `<text class="lbl" x="${W - rr - 8}" y="${y}" text-anchor="end">${txt}</text>`;
  $("#proj").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Projected value over ${years} years: ${php0(last.val)}, of which ${php0(last.put)} put in">
    <g class="grid">${ticks.map(v => `<line x1="${l}" x2="${W-rr}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${l-8}" y="${Y(v)+4}" text-anchor="end">${phpK(v)}</text>`).join("")}</g>
    ${pts.filter(p => Number.isInteger(p.y) && p.y % step === 0).map(p => `<text x="${X(p.y)}" y="${H-8}" text-anchor="middle">${p.y ? new Date(p.date + "T00:00:00").getFullYear() : "Now"}</text>`).join("")}
    <path class="a1" d="${area(p => p.put, () => 0)}"/><path class="a2" d="${area(top, p => p.put)}"/>
    <path class="sep" d="${path(p => p.put)}"/>
    ${Y(last.put) - Y(0) < -22 ? lab("Put in " + phpK(last.put), (Y(last.put) + Y(0)) / 2 + 4) : ""}
    ${Y(last.val) - Y(last.put) < -22 ? lab("Growth " + phpK(gEnd), (Y(last.val) + Y(last.put)) / 2 + 4) : ""}
    <line class="xh" y1="${t}" y2="${H-bt}" visibility="hidden"/><circle class="dot2" r="4.5" visibility="hidden"/>
    <rect x="${l}" y="0" width="${W-l-rr}" height="${H}" fill="transparent"/></svg><div class="tt"></div>`;
  const svg = $("#proj svg"), tt = $("#proj .tt"), xh = svg.querySelector(".xh"), d2 = svg.querySelector(".dot2");
  const show = e => {
    const box = svg.getBoundingClientRect(), sx = (e.clientX - box.left) / box.width * W;
    const p = pts[Math.max(0, Math.min(pts.length - 1, Math.round((sx - l) / (W - l - rr) * (pts.length - 1))))];
    xh.setAttribute("visibility", "visible"); d2.setAttribute("visibility", "visible");
    xh.setAttribute("x1", X(p.y)); xh.setAttribute("x2", X(p.y)); d2.setAttribute("cx", X(p.y)); d2.setAttribute("cy", Y(top(p)));
    tt.innerHTML = `<b>${p.w ? monthYear(p.date) : "Now"}</b> <span class="dim">${p.w ? "· year " + p.y.toFixed(1) : ""}</span><br>
      Worth <b>${php0(p.val)}</b><br><span class="sw" style="background:var(--s1)"></span>Put in ${php0(p.put)}<br>
      <span class="sw" style="background:var(--s2)"></span>Growth ${php0(p.val - p.put)}<br><span class="dim">Earning ~${php0(perMonth(p))}/month by itself</span>`;
    tt.style.left = Math.max(90, Math.min(box.width - 90, X(p.y) / W * box.width)) + "px";
    tt.style.top = (Y(top(p)) / H * box.height - 10) + "px"; tt.style.opacity = 1;
  };
  svg.addEventListener("pointermove", show); svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", () => { tt.style.opacity = 0; xh.setAttribute("visibility", "hidden"); d2.setAttribute("visibility", "hidden"); });

  const cross = pts.find(p => p.w && p.val - p.put >= p.put);
  $("#miles").innerHTML = `By ${monthYear(last.date)} the money would be earning about <b>${php0(perMonth(last))} a month on its own</b>`
    + ` — ${perMonth(last) >= P.set.weekly * 52 / 12 ? "more than you'd be putting in" : `vs the ${php0(P.set.weekly * 52 / 12)} a month you put in`}. `
    + (cross ? `From ${monthYear(cross.date)} (year ${Math.ceil(cross.y)}), growth is bigger than everything you've put in: that's compounding. ` : "")
    + `<span class="dim">Real years swing from −40% to +30%; this is the smooth average. In today's pesos, before inflation.</span>`;

  const rows = [1,2,3,5,7,10,15,20,25,30,35,40].filter(y => y <= years);
  $("#ytab").innerHTML = `<table><thead><tr><th>Year</th><th>Put in so far</th><th>Growth so far</th><th>Worth</th><th>Earns by itself / month</th></tr></thead><tbody>`
    + rows.map(y => { const p = at(y); return `<tr><td>${y} · ${new Date(p.date + "T00:00:00").getFullYear()}</td><td>${php0(p.put)}</td>
      <td>${php0(p.val - p.put)}</td><td><b>${php0(p.val)}</b></td><td>${php0(perMonth(p))}</td></tr>`; }).join("") + `</tbody></table>`;
}

// ---------- wishlist goals ----------
// Weeks until a goal is affordable two ways, both starting from what you have now: investing on
// the plan and withdrawing, or putting the same pesos a week in the bank.
function goalWeeks(need, startVal, sim = simulate(52 * 40, startVal, 0)){
  const start = takeHome({inv:startVal, held:0}), W = P.set.weekly;
  const cash = need <= start ? 0 : W > 0 ? Math.ceil((need - start) / W) : null;
  const i = sim.findIndex(p => takeHome(p) >= need);
  return {cash, inv: i < 0 ? null : i};
}
let tryGoal = 0;
function drawGoals(startVal){
  const wishes = (S.wish || []).map(w => ({name:w.name, need:r2(w.cost * (1 - (w.helpPct || 0) / 100)), help:w.helpPct || 0}));
  if(tryGoal > 0) wishes.push({name:"Your what-if", need:tryGoal, help:0, what:true});
  const sim = simulate(52 * 40, startVal, 0);
  const rows = wishes.filter(w => w.need > 0).map(w => ({...w, ...goalWeeks(w.need, startVal, sim)})).sort((a,b) => a.need - b.need);
  const span = Math.max(26, ...rows.flatMap(r => [r.inv, r.cash]).filter(x => x != null && x <= 52 * 10)) * 1.08;
  const pos = wk => Math.min(100, wk / span * 100);
  const when = wk => wk == null ? "not within 40 years" : wk === 0 ? "now" : `${monthYear(addDays(today(), wk * 7))} <span class="dim">(${wk < 9 ? plural(wk, "week") : wk < 104 ? Math.round(wk / 4.345) + " months" : (wk / 52).toFixed(1) + " years"})</span>`;
  const verdict = r => r.cash === 0 && r.inv === 0 ? `<b class="ok">You could already afford this</b> with what's on Gotrade — though spending it stops it growing.`
    : r.inv == null ? `<span class="warn">Out of reach at ${php0(P.set.weekly)}/week</span>`
    : r.cash != null && r.inv > r.cash ? `<b>Save this in the bank.</b> Investing takes ${plural(r.inv - r.cash, "week")} longer — the deposit fee and exchange rate eat the early growth.`
    : r.cash != null && r.inv === r.cash ? `<b>Same time either way</b>, so keep it in the bank: no fees, and no dip can delay it.`
    : r.inv < 156 ? `<b>Investing is ${plural(r.cash - r.inv, "week")} faster</b>, but under 3 years a market drop could easily delay it.`
    : `<b>Investing gets there ${r.cash - r.inv >= 104 ? ((r.cash - r.inv) / 52).toFixed(1) + " years" : plural(r.cash - r.inv, "week")} sooner.</b>`;
  const ticks = [0, ...[13, 26, 52, 104, 156, 260, 520].filter(w => w < span * 0.92).slice(-4)];
  const tickLbl = w => w === 0 ? "Now" : w < 52 ? Math.round(w / 4.345) + " mo" : (w / 52) + " yr";

  $("#goals").innerHTML = (rows.length ? `<div class="glegend"><span><span class="pin inv"></span>Investing ${php0(P.set.weekly)}/week on your plan</span>
      <span><span class="pin cash"></span>Saving ${php0(P.set.weekly)}/week in the bank</span></div>`
    + rows.map(r => `<div class="goal"><div class="gname"><b title="${esc(r.name)}">${esc(r.name)}</b>
        <span class="sub">${money(r.need)}${r.help ? ` (your ${100 - r.help}%)` : ""}</span></div>
        <div class="track" title="Investing: ${r.inv ?? "never"} weeks · Bank: ${r.cash ?? "never"} weeks">
          ${r.inv != null ? `<i class="bar inv" style="width:${pos(r.inv)}%"></i><span class="pin inv" style="left:${pos(r.inv)}%"></span>` : ""}
          ${r.cash != null ? `<i class="bar cash" style="width:${pos(r.cash)}%"></i><span class="pin cash" style="left:${pos(r.cash)}%"></span>` : ""}</div>
        <div class="gwhen">Investing: ${when(r.inv)}<br>Bank: ${when(r.cash)}<br>${verdict(r)}</div></div>`).join("")
    + `<div class="axisrow"><span></span><div class="axis">${ticks.map(w => `<span style="left:${pos(w)}%">${tickLbl(w)}</span>`).join("")}</div><span></span></div>`
    : `<p class="dim">No wishlist items found. Add them in <a href="../">Ledger</a>'s Wishlist (or turn on sync there), or try an amount below.</p>`)
    + `<div class="try"><label>What if I want something that costs (₱)<input id="tryAmt" type="number" min="0" step="500" inputmode="decimal" placeholder="e.g. 50000" value="${tryGoal || ""}"></label>
      <p class="sub" style="flex:2 1 260px">Each item is timed on its own, as if it were your only goal. Taking money out to buy something also stops it compounding — the projection above assumes you never withdraw.</p></div>`;
}
$("#goals").addEventListener("change", e => {
  if(e.target.id !== "tryAmt") return;
  tryGoal = Math.max(0, +e.target.value || 0); const b = book(); drawGoals(worth(b).total * mid());
});

// ---------- money map ----------
function drawFlow(b, w, L){
  const arrow = (type, dir, label, cost) => `<button class="arrow" data-log="${type}"><span class="gl ${dir === "→" ? "r" : "l"}">${dir}</span><span><b>${label}</b><small>${cost}</small></span></button>`;
  $("#flow").innerHTML = `
    <div class="node"><div class="eyebrow">Bank (Ledger)</div><div class="v num">${L.has ? money(Math.max(0, L.free)) : "—"}</div>
      <div class="sub">${L.has ? "free to invest after bills and buffer" : "open Ledger on this device to see it"}</div></div>
    <div class="link">${arrow("deposit", "→", "Deposit", `₱${P.set.fee} + ~${P.set.spread}% rate`)}${arrow("withdraw", "←", "Withdraw", `$${P.set.wdFee} + ~${P.set.spread}% rate`)}</div>
    <div class="node ${b.cash >= 1 ? "here" : ""}"><div class="eyebrow">Gotrade cash</div><div class="v num">${usd(b.cash)}</div>
      <div class="sub">${b.cash >= 1 ? "not growing yet — buy with it" : "dollars waiting to be invested"}</div></div>
    <div class="link">${arrow("buy", "→", "Buy", "no fee, fractions OK")}${arrow("div", "←", "Dividend", "funds pay you cash")}${arrow("sell", "←", "Sell", "only to take money out")}</div>
    <div class="node"><div class="eyebrow">Your funds</div><div class="v num">${usd(w.val)}</div>
      <div class="sub">${Object.keys(b.pos).length ? Object.keys(b.pos).join(", ") + " — this is the part that grows" : "the part that grows"}</div></div>`;
}
$("#flow").addEventListener("click", e => { const t = e.target.closest("[data-log]")?.dataset.log; if(t) openTx(t); });

// ---------- logging ----------
const TX_FIELDS = {deposit:["php","usd"], withdraw:["usd","php"], buy:["sym","usd","shares"], sell:["sym","shares","usd"], div:["sym","usd"]};
const TX_TEXT = {
  deposit:["Log a deposit", "Amount deposited (₱)", "You'll receive ($) — copy it from Gotrade", "Pre-filled from today's rate; type the exact figure Gotrade showed."],
  withdraw:["Log a withdrawal", "Received in your bank (₱)", "Amount withdrawn ($)", ""],
  buy:["Log a buy", "", "Amount spent ($)", "Shares fill in from the live price; correct them to what Gotrade shows."],
  sell:["Log a sale", "", "Received ($)", "Selling locks in the FX cost and any loss. The plan never needs it."],
  div:["Log a dividend", "", "Dividend received after tax ($)", ""],
};
// What each step actually is, shown at the top of its dialog.
const TX_WHAT = {
  deposit:"Pesos from your bank into Gotrade. Gotrade keeps ₱45 and converts the rest to dollars, which sit as Gotrade cash until you buy.",
  buy:"Gotrade cash into shares of a fund. This is the step that invests: cash doesn't grow, shares do.",
  div:"A fund paid you part of its companies' profits. It arrives as Gotrade cash (US tax already taken out). Buy more with it.",
  sell:"Shares back into Gotrade cash. You only need this to take money out — and selling in a dip makes the loss real.",
  withdraw:"Dollars from Gotrade back to your bank as pesos. Costs $5 plus Gotrade's exchange rate.",
};
function openTx(type){
  const f = $("#txForm"), [title, phpL, usdL, hint] = TX_TEXT[type];
  f.reset(); f.dataset.type = type;
  $("#txWhat").textContent = TX_WHAT[type];
  $("#txTitle").textContent = title; $("#phpLbl").textContent = phpL; $("#usdLbl").textContent = usdL; $("#txHint").textContent = hint;
  for(const el of f.querySelectorAll("[data-f]")) el.hidden = !TX_FIELDS[type].includes(el.dataset.f);
  f.date.value = today();
  if(type !== "deposit" && type !== "withdraw") f.sym.value = P.targets[0]?.sym || "";
  if(type === "deposit"){ const a = P.set.weekly * P.set.every; f.php.value = a; f.usd.value = depositQuote(a).usd || ""; }
  $("#txDlg").returnValue = ""; $("#txDlg").showModal();   // Esc keeps the last returnValue otherwise
}
$("#txForm").addEventListener("input", e => {
  const f = $("#txForm"), type = f.dataset.type, px = priceOf(f.sym.value.trim().toUpperCase());
  if(type === "deposit" && e.target.name === "php") f.usd.value = depositQuote(+f.php.value).usd || "";
  if(type === "withdraw" && e.target.name === "usd") f.php.value = r2(Math.max(0, +f.usd.value - P.set.wdFee) * sellRate()) || "";
  if(type === "buy" && (e.target.name === "usd" || e.target.name === "sym") && px) f.shares.value = (+f.usd.value / px).toFixed(6);
  if(type === "sell" && (e.target.name === "shares" || e.target.name === "sym") && px) f.usd.value = r2(+f.shares.value * px) || "";
});
$("#txDlg").addEventListener("close", () => {
  if($("#txDlg").returnValue !== "ok") return;
  const f = $("#txForm"), type = f.dataset.type, need = TX_FIELDS[type];
  const t = {id:uid(), type, date:f.date.value || today(), sym:f.sym.value.trim().toUpperCase(),
             php:r2(f.php.value), usd:r2(f.usd.value), shares:+f.shares.value || 0, mid:M.fx?.mid || 0};
  if(need.includes("sym") && !SYM.test(t.sym)) return alert("That ticker doesn't look right (e.g. VOO).");
  for(const k of need) if(k !== "sym" && !(t[k] > 0)) return alert("Fill in every amount with a number above zero.");
  if(type === "sell" && t.shares > (book().pos[t.sym]?.shares || 0) + 1e-6) return alert(`You hold fewer ${t.sym} shares than that.`);
  if(!need.includes("sym")) t.sym = "";
  P.tx.push(t);
  if(type === "buy" && !symsWanted().every(s => M.q[s])) refresh();
  persist();
});

$("#act").addEventListener("click", e => {
  const id = e.target.closest("[data-del]")?.dataset.del; if(!id) return;
  if(!confirm("Delete this entry? Every total recalculates without it.")) return;
  P.tx = P.tx.filter(t => t.id !== id); persist();
});
document.querySelectorAll("[data-log]").forEach(bn => bn.addEventListener("click", () => openTx(bn.dataset.log)));
$("#buy").addEventListener("input", e => { if(e.target.id === "buyAmt") drawBuy(book()); });
$("#dep").addEventListener("input", e => { if(e.target.id === "depAmt" || e.target.id === "depRate") drawDep(ledgerView()); });

// ---------- settings ----------
// "VOO 80, QQQM 20" -> [{sym,pct}]. Returns null on anything it cannot read.
function parsePlan(s){
  const parts = String(s).toUpperCase().split(/[,\n;]+/).map(x => x.trim()).filter(Boolean), out = [];
  for(const p of parts){
    const m = p.match(/^([A-Z][A-Z0-9.\-]{0,9})\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%?$/);
    if(!m || !(+m[2] > 0)) return null;
    out.push({sym:m[1], pct:+m[2]});
  }
  return out;
}
$("#setBtn").addEventListener("click", () => openSettings());
function openSettings(){
  const f = $("#setForm");
  for(const k in SET0) if(f[k]) f[k].type === "checkbox" ? (f[k].checked = P.set[k]) : (f[k].value = P.set[k]);
  f.plan.value = P.targets.map(t => `${t.sym} ${t.pct}`).join(", ");
  f.watch.value = P.watch.join(", ");
  $("#setDlg").returnValue = ""; $("#setDlg").showModal();
}
// Cancelling the custom-mix dialog must not leave "Your own mix" ticked over the real plan.
$("#setDlg").addEventListener("close", () => drawPlan());
$("#setDlg").addEventListener("close", () => {
  if($("#setDlg").returnValue !== "ok") return;
  const f = $("#setForm"), plan = parsePlan(f.plan.value);
  if(!plan) return alert('Couldn\'t read the plan. Write it like "VOO 80, QQQM 20".');
  const watch = f.watch.value.toUpperCase().split(/[\s,;]+/).filter(Boolean);
  if(!watch.every(s => SYM.test(s))) return alert("One of the watched tickers doesn't look right.");
  const set = {};
  for(const k in SET0) set[k] = f[k].type === "checkbox" ? f[k].checked : +f[k].value;
  P = norm({...P, set, targets:plan, watch, chosen:true});
  const total = plan.reduce((s,t) => s + t.pct, 0);
  if(plan.length && Math.abs(total - 100) > 0.01) alert(`Your plan adds up to ${total}%. It's used as relative weights, so it still works.`);
  persist(); refresh();
});
$("#refreshBtn").addEventListener("click", refresh);

// ---------- backup ----------
$("#expBtn").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(P, null, 2)], {type:"application/json"}));
  a.download = `invest-${today()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("#impBtn").addEventListener("click", () => $("#impFile").click());
$("#impFile").addEventListener("change", async e => {
  const file = e.target.files[0]; e.target.value = ""; if(!file) return;
  try{
    const data = JSON.parse(await file.text());
    if(!Array.isArray(data.tx)) throw new Error("not an Invest backup");
    if(!confirm(`Replace what's here with ${data.tx.length} entries from ${file.name}?`)) return;
    P = norm(data); persist(); refresh();
  } catch(err){ alert("Couldn't import: " + err.message); }
});

// ---------- self-check: open with ?test and read the console ----------
function selfTest(){
  const ok = (c, m) => console[c ? "log" : "error"]((c ? "ok: " : "FAIL: ") + m);
  const saved = P;
  P = norm({set:{fee:45, weekly:1000, ret:0, every:4, spread:0, years:1}, targets:[{sym:"AAA", pct:50}, {sym:"BBB", pct:50}]});
  const b = book([
    {id:"1", type:"deposit", date:"2026-01-01", php:6045, usd:100},
    {id:"2", type:"buy", date:"2026-01-02", sym:"AAA", usd:60, shares:2},
    {id:"3", type:"sell", date:"2026-01-03", sym:"AAA", usd:40, shares:1},
    {id:"4", type:"div", date:"2026-01-04", sym:"AAA", usd:1.5},
  ].map(t => ({sym:"", php:0, shares:0, ...t})));
  ok(b.cash === 81.5, "cash = deposits - buys + sells + dividends");
  ok(b.pos.AAA.shares === 1 && b.pos.AAA.cost === 30, "a sale removes its share of average cost");
  ok(b.phpIn === 6045 && b.lastDep === "2026-01-01", "pesos in and last deposit tracked");
  const c = cadence();
  ok(c[0].fees === 2340 && c[0].drag === 0, "weekly: 52 fees, no waiting cost");
  ok(Math.abs(c[2].feePct - 1.125) < 1e-9, "every 4 weeks: ₱45 on ₱4,000 is 1.125%");
  const pts = project(0, 0);
  ok(Math.abs(pts.at(-1).val - (52000 - 13 * 45)) < 0.01 && pts.at(-1).y === 1, "0% return: value = contributions - fees");
  ok(takeHome({inv:0, held:500}) === 500, "take-home: cash still in the bank costs nothing to withdraw");
  ok(goalWeeks(4000, 0).cash === 4, "saving ₱1,000/week reaches ₱4,000 in 4 weeks");
  const plan = buyPlan(100, {pos:{AAA:{shares:1, cost:50}}});
  ok(plan.reduce((s,r) => s + r.amt, 0) <= 100, "buy plan never spends more than the cash");
  ok(plan.find(r => r.sym === "BBB").amt > plan.find(r => r.sym === "AAA").amt, "buy plan fills the underweight fund first");
  ok(JSON.stringify(parsePlan("voo 80, qqqm 20%")) === '[{"sym":"VOO","pct":80},{"sym":"QQQM","pct":20}]' && parsePlan("VOO lots") === null, "plan parser");
  P = saved;
}

// ---------- boot ----------
if(location.search.includes("test")) selfTest();
draw();
refresh();
bootInvestSync();
