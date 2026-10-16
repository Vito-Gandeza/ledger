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
  return {v:1, set,
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
function project(startVal, startIn){
  const {weekly:W, every:k, ret, years, fee, spread} = P.set, g = Math.pow(1 + ret/100, 1/52);
  let val = startVal, put = startIn, held = 0;
  const pts = [{y:0, val, put}];
  for(let w = 1; w <= years * 52; w++){
    val *= g; held += W;
    if(w % k === 0 && held > fee){ put += held; val += (held - fee) / (1 + spread/100); held = 0; }
    if(w % 52 === 0) pts.push({y:w/52, val:r2(val + held), put:r2(put + held)});
  }
  return pts;
}

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
    : "Nothing logged yet. Log your first deposit under Activity.";
  $("#hSplit").innerHTML = [
    ["Invested", usd(w.val)], ["Cash on Gotrade", usd(b.cash)],
    ["If withdrawn today", fx ? php0(out) : "—"], ["Dividends", usd(b.divs)],
  ].map(([k,v]) => `<div><div class="eyebrow">${k}</div><div class="v num">${v}</div></div>`).join("");

  drawCoach(b, L);
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
      tips.push(["dim", "Next", `Next deposit <b>${niceY(next)}</b> (every ${plural(k, "week")}). Set aside ${money(W)} a week until then${L.aside.length ? ` — ${money(L.asideBal)} in your ${esc(L.aside[0].name)} section so far` : ""}.`]);
    }
  }
  $("#coach").innerHTML = tips.map(([c,l,t]) => `<div class="tip ${c === "ok" ? "" : c}"><span class="lbl">${l}</span>${t}</div>`).join("");
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

function drawProj(startVal, startIn){
  const pts = project(startVal, startIn), last = pts.at(-1), {years, ret, weekly, every} = P.set;
  $("#projSub").textContent = `${php0(weekly)}/week, deposited every ${plural(every, "week")}, at ${ret}%/yr`;
  const W = 600, H = 250, l = 52, r = 14, t = 14, bt = 26;
  const ymax = Math.max(...pts.map(p => p.val), 1) * 1.05;
  const X = y => l + y / years * (W - l - r), Y = v => t + (1 - v / ymax) * (H - t - bt);
  const ticks = [0, .25, .5, .75, 1].map(f => ymax * f);
  const step = years <= 10 ? 1 : years <= 25 ? 5 : 10;
  const line = k => pts.map((p,i) => `${i ? "L" : "M"}${X(p.y).toFixed(1)},${Y(p[k]).toFixed(1)}`).join("");
  const gap = line("val") + pts.slice().reverse().map(p => `L${X(p.y).toFixed(1)},${Y(p.put).toFixed(1)}`).join("") + "Z";
  $("#proj").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Projected value over ${years} years">
    <g class="grid">${ticks.map(v => `<line x1="${l}" x2="${W-r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${l-8}" y="${Y(v)+4}" text-anchor="end">${phpK(v)}</text>`).join("")}</g>
    ${pts.filter(p => p.y % step === 0).map(p => `<text x="${X(p.y)}" y="${H-8}" text-anchor="middle">${p.y ? "Yr " + p.y : "Now"}</text>`).join("")}
    <path class="gap" d="${gap}"/><path class="l1" d="${line("put")}"/><path class="l2" d="${line("val")}"/>
    <line class="xh" y1="${t}" y2="${H-bt}" visibility="hidden"/><circle class="dot1" r="4" visibility="hidden"/><circle class="dot2" r="4" visibility="hidden"/>
    <rect x="${l}" y="0" width="${W-l-r}" height="${H}" fill="transparent" class="hit"/></svg><div class="tt"></div>`;
  const svg = $("#proj svg"), tt = $("#proj .tt"), xh = svg.querySelector(".xh"), d1 = svg.querySelector(".dot1"), d2 = svg.querySelector(".dot2");
  const show = e => {
    const box = svg.getBoundingClientRect(), sx = (e.clientX - box.left) / box.width * W;
    const p = pts[Math.max(0, Math.min(pts.length - 1, Math.round((sx - l) / (W - l - r) * years)))];
    for(const el of [xh, d1, d2]) el.setAttribute("visibility", "visible");
    xh.setAttribute("x1", X(p.y)); xh.setAttribute("x2", X(p.y));
    d1.setAttribute("cx", X(p.y)); d1.setAttribute("cy", Y(p.put)); d2.setAttribute("cx", X(p.y)); d2.setAttribute("cy", Y(p.val));
    tt.innerHTML = `<b>${p.y ? "Year " + p.y : "Now"}</b><br><span class="sw" style="background:var(--s2)"></span>Value ${php0(p.val)}<br><span class="sw" style="background:var(--s1)"></span>Put in ${php0(p.put)}<br><span class="dim">Growth ${php0(p.val - p.put)}</span>`;
    tt.style.left = Math.max(70, Math.min(box.width - 70, X(p.y) / W * box.width)) + "px";
    tt.style.top = (Y(p.val) / H * box.height - 8) + "px"; tt.style.opacity = 1;
  };
  svg.addEventListener("pointermove", show); svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", () => { tt.style.opacity = 0; for(const el of [xh, d1, d2]) el.setAttribute("visibility", "hidden"); });

  const hit = v => pts.find(p => p.val >= v);
  const cross = pts.find(p => p.y > 0 && p.val - p.put >= p.put);
  const ms = [1e5, 5e5, 1e6, 5e6].map(v => [v, hit(v)]).filter(([v,p]) => p && p.y > 0 && v > startVal).slice(0, 3);
  $("#miles").innerHTML = `In ${years} years: <b>${php0(last.val)}</b>, of which <b>${php0(last.put)}</b> is what you put in and <b>${php0(last.val - last.put)}</b> is growth. `
    + (ms.length ? ms.map(([v,p]) => `${phpK(v)} around year ${p.y}`).join(" · ") + ". " : "")
    + (cross ? `From year ${cross.y}, growth is bigger than everything you put in — that's compounding doing more work than you are. ` : "")
    + `<span class="dim">An assumption, not a promise: real years swing from −40% to +30%. In today's pesos, not adjusted for inflation.</span>`;
}

// ---------- logging ----------
const TX_FIELDS = {deposit:["php","usd"], withdraw:["usd","php"], buy:["sym","usd","shares"], sell:["sym","shares","usd"], div:["sym","usd"]};
const TX_TEXT = {
  deposit:["Log a deposit", "Amount deposited (₱)", "You'll receive ($) — copy it from Gotrade", "Pre-filled from today's rate; type the exact figure Gotrade showed."],
  withdraw:["Log a withdrawal", "Received in your bank (₱)", "Amount withdrawn ($)", ""],
  buy:["Log a buy", "", "Amount spent ($)", "Shares fill in from the live price; correct them to what Gotrade shows."],
  sell:["Log a sale", "", "Received ($)", "Selling locks in the FX cost and any loss. The plan never needs it."],
  div:["Log a dividend", "", "Dividend received after tax ($)", ""],
};
function openTx(type){
  const f = $("#txForm"), [title, phpL, usdL, hint] = TX_TEXT[type];
  f.reset(); f.dataset.type = type;
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
$("#setBtn").addEventListener("click", () => {
  const f = $("#setForm");
  for(const k in SET0) if(f[k]) f[k].type === "checkbox" ? (f[k].checked = P.set[k]) : (f[k].value = P.set[k]);
  f.plan.value = P.targets.map(t => `${t.sym} ${t.pct}`).join(", ");
  f.watch.value = P.watch.join(", ");
  $("#setDlg").returnValue = ""; $("#setDlg").showModal();
});
$("#setDlg").addEventListener("close", () => {
  if($("#setDlg").returnValue !== "ok") return;
  const f = $("#setForm"), plan = parsePlan(f.plan.value);
  if(!plan) return alert('Couldn\'t read the plan. Write it like "VOO 80, QQQM 20".');
  const watch = f.watch.value.toUpperCase().split(/[\s,;]+/).filter(Boolean);
  if(!watch.every(s => SYM.test(s))) return alert("One of the watched tickers doesn't look right.");
  const set = {};
  for(const k in SET0) set[k] = f[k].type === "checkbox" ? f[k].checked : +f[k].value;
  P = norm({...P, set, targets:plan, watch});
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
  ok(Math.abs(pts.at(-1).val - (52000 - 13 * 45)) < 0.01, "0% return: value = contributions - fees");
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
