"use strict";
// Part of Ledger. Loaded as a plain classic script in index.html, in order:
// data -> render -> app. No modules and no build step, so the file still opens from disk.

const PESO = "₱";
const $ = s => document.querySelector(s);
const money = n => PESO + (n<0?"-":"") + Math.abs(n).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2});
const r2 = n => Math.round((Number(n)||0)*100)/100;
const uid = () => Math.random().toString(36).slice(2,9);
const esc = s => String(s).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

// Local calendar date. toISOString() would shift PH (UTC+8) back a day before 8am.
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const today = () => iso(new Date());
const daysTo = d => Math.round((new Date(d+"T00:00:00") - new Date(today()+"T00:00:00"))/864e5);
const nice = d => new Date(d+"T00:00:00").toLocaleDateString("en-PH",{month:"short",day:"2-digit"});
const niceY = d => new Date(d+"T00:00:00").toLocaleDateString("en-PH",{month:"short",day:"2-digit",year:"numeric"});
const monthName = d => new Date(d+"T00:00:00").toLocaleDateString("en-PH",{month:"long",year:"numeric"});

const addDays = (s,n) => { const d=new Date(s+"T00:00:00"); d.setDate(d.getDate()+n); return iso(d); };
// Clamps to end of month: Jan 31 + 1 month = Feb 28, not Mar 3.
function addMonths(s,n){
  const d = new Date(s+"T00:00:00"), day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth()+n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth()+1, 0).getDate()));
  return iso(d);
}
const dayOf = (s,day) => s.slice(0,8) + String(day).padStart(2,"0");

function gen(start, count, freq, amount){
  const out = []; let d = start;
  for(let i=0;i<count;i++){
    out.push({due:d, amount:r2(amount), paid:false});
    d = freq==="month" ? addMonths(d,1) : addDays(d, freq==="2weeks"?14:7);
  }
  return out;
}
// Credit-card cycle: a purchase on or after the statement day lands on NEXT month's statement.
// Buy Aug 05 (sDay 9) -> billed Aug 09, due Aug 19. Buy Aug 11 -> billed Sep 09, due Sep 19.
function cycleFor(date, sDay, dDay){
  let m = date.slice(0,7) + "-01";
  if(+date.slice(8,10) >= sDay) m = addMonths(m,1);
  return {stmt: dayOf(m,sDay), due: dayOf(m,dDay)};
}
// A card's statements are derived from its purchases, so they can never drift apart.
function rebuildCard(L){
  // Carry the whole previous row forward, not just its paid flag — it also holds where the
  // payment came from, which is what lets "mark unpaid" put the money back.
  const prev = Object.fromEntries((L.items||[]).map(i=>[i.due, i]));
  const by = new Map();
  for(const p of L.purchases){
    const c = cycleFor(p.date, L.sDay, L.dDay);
    if(!by.has(c.due)){
      const was = prev[c.due];
      by.set(c.due, {due:c.due, stmt:c.stmt, amount:0, paid:!!was?.paid,
        ...(was?.paidFrom ? {paidFrom:was.paidFrom, paidAmt:r2(was.paidAmt)} : {}),
        ...(was?.carryId  ? {carryId:was.carryId} : {})});
    }
    by.get(c.due).amount = r2(by.get(c.due).amount + p.amount);
  }
  L.items = [...by.values()].filter(i=>i.amount!==0).sort((a,b)=> a.due<b.due?-1:1);
  return L;
}
const isCard = L => L.freq === "card";
const purchasesIn = (L,due) => L.purchases.filter(p=>cycleFor(p.date,L.sDay,L.dDay).due===due)
                                          .sort((a,b)=> a.date<b.date?-1:1);
const outstanding = L => r2(unpaid(L).reduce((s,i)=>s+i.amount,0));
const available = L => r2(L.limit - outstanding(L));

const COLORS = ["#5b9dff","#3ecf9a","#e0a44f","#ff6b60","#b38cff","#4fd1e0"];

// A starting colour per provider so a new card is not born grey. These are eyeballed
// approximations, not official brand values — every one is editable per card and per
// wallet, and anything not listed falls back to a stable colour derived from the name.
const BRAND_HINT = {
  atome:"#f0355f", gotyme:"#f5b301", gcash:"#1f7aec", maya:"#18e08b",
  billease:"#f2761b", seabank:"#f5502d", unionbank:"#ef7622", bpi:"#b3131f", landbank:"#0f7a3d",
};
function brandOf(x){
  if(x?.brand) return x.brand;
  const key = String(x?.provider || x?.name || "").toLowerCase().replace(/[^a-z]/g,"");
  for(const k in BRAND_HINT) if(key.includes(k)) return BRAND_HINT[k];
  let h = 0; for(const ch of key) h = (h*31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 58% 45%)`;
}
// Logos ride along inside the synced JSON, so they are downscaled hard before storage.
function shrinkImage(file, max){
  return new Promise((res,rej)=>{
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = ()=>{
      URL.revokeObjectURL(url);
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width*k)); c.height = Math.max(1, Math.round(img.height*k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL("image/webp", .82));
    };
    img.onerror = ()=>{ URL.revokeObjectURL(url); rej(new Error("could not read that image")); };
    img.src = url;
  });
}
// 1st, 2nd, 3rd, 4th … 11th/12th/13th are the exceptions.
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function ord(n){
  const v = Math.abs(Number(n) || 0);
  const suffix = (v % 100 >= 11 && v % 100 <= 13) ? "th"
    : ["th","st","nd","rd"][v % 10] || "th";
  return v + suffix;
}
const brandMark = (x, fallback) => x?.logo
  ? `<img class="mark" src="${esc(x.logo)}" alt="">`
  : `<span class="mark txt">${esc(fallback)}</span>`;
const colorOf = L => COLORS[Math.max(0,S.loans.findIndex(x=>x.id===L.id)) % COLORS.length];

// ---------- data ----------
const DATA_V = 6;
const blank = () => ({v:DATA_V, accounts:[], loans:[], log:[], wish:[], owed:[], people:[]});

function starter(){
  const main = uid();
  return {v:DATA_V, accounts:[
    {id:main,  parent:null, name:"GoTyme Main",  kind:"gotyme", bal:0, loanId:""},
    {id:uid(), parent:main, name:"Myself",       kind:"gotyme", bal:0, loanId:"income"},
    {id:uid(), parent:null, name:"GCash",        kind:"gcash",  bal:0, loanId:""},
    {id:uid(), parent:null, name:"Cash on hand", kind:"cash",   bal:0, loanId:""},
  ], loans:[], log:[], wish:[], owed:[], people:[]};
}

// Fictional numbers, purely so a first-time visitor can see how the pieces fit.
function demoData(){
  const main=uid(), a=uid(), b=uid(), card=uid(), pur=uid(), sam=uid(), alex=uid();
  return {v:DATA_V, accounts:[
    {id:main,  parent:null, name:"Main bank",    kind:"gotyme", bal:250,  loanId:""},
    {id:uid(), parent:main, name:"Myself",       kind:"gotyme", bal:2000, loanId:"income"},
    {id:uid(), parent:main, name:"Groceries plan", kind:"gotyme", bal:300, loanId:a},
    {id:uid(), parent:main, name:"Laptop plan",  kind:"gotyme", bal:0,    loanId:b},
    {id:uid(), parent:main, name:"Card",         kind:"gotyme", bal:0,    loanId:card},
    {id:uid(), parent:null, name:"E-wallet",     kind:"gcash",  bal:420,  loanId:""},
    {id:uid(), parent:null, name:"Cash on hand", kind:"cash",   bal:180,  loanId:""},
  ], loans:[
    {id:a, provider:"Instalment", label:"Groceries plan", ref:"#DEMO-1", freq:"week",
     items: gen(addDays(today(),3), 10, "week", 65)},
    {id:b, provider:"Instalment", label:"Laptop plan", ref:"#DEMO-2", freq:"2weeks",
     items: gen(addDays(today(),10), 4, "2weeks", 1250)},
    rebuildCard({id:card, provider:"Card", label:"Credit card", ref:"", freq:"card",
     limit:8000, sDay:9, dDay:19, items:[],
     purchases:[{id:pur, date:addDays(today(),-2), label:"Subscription", amount:1410.39}]}),
  ], log:[], allowance:{weekday:new Date().getDay(), amount:2500, lastAdded:today()},
  people:[{id:sam, name:"Sam", brand:"#b38cff"}, {id:alex, name:"Alex", brand:"#4fd1e0"}],
  owed:[{id:uid(), personId:sam, amount:0, note:"", loanId:card, purchaseId:pur, settled:false},
        {id:uid(), personId:alex, amount:400, note:"Lunch", loanId:"", purchaseId:"", settled:false},
        {id:uid(), personId:alex, amount:250, note:"Concert ticket", loanId:"", purchaseId:"", settled:false}],
  wish:[
    {id:uid(), name:"Mechanical keyboard", cost:4800, brand:"#2997ff", logo:""},
    {id:uid(), name:"Weekend trip", cost:12000, brand:"#3ecf9a", logo:""},
  ]};
}

// Saved data survives upgrades — balances you already edited are never overwritten.
// Every field is coerced to its expected type: a corrupted or hand-edited backup should
// degrade to sane defaults, never poison the render pipeline with undefined/NaN.
function migrate(s){
  if(!s || typeof s !== "object") s = {};
  if(!Array.isArray(s.accounts)) s.accounts = [];
  if(!Array.isArray(s.loans))    s.loans = [];
  if(!Array.isArray(s.log))      s.log = [];
  // People who owe you money. A debt points at a profile rather than carrying a name, so
  // renaming someone or giving them a colour happens once instead of per debt.
  s.people = Array.isArray(s.people) ? s.people.filter(x => x && typeof x === "object" && x.id).map(x => ({
    ...x, name:String(x.name ?? "Someone"), brand: typeof x.brand === "string" ? x.brand : "",
  })) : [];
  // An amount and a description are only stored for debts that are NOT on a card; a linked
  // one reads both straight off the purchase, so the two can never drift apart.
  s.owed = Array.isArray(s.owed) ? s.owed.filter(o => o && typeof o === "object" && o.id).map(o => ({
    ...o, amount:r2(o.amount),
    note: typeof o.note === "string" ? o.note : "",
    personId:   typeof o.personId   === "string" ? o.personId   : "",
    loanId:     typeof o.loanId     === "string" ? o.loanId     : "",
    purchaseId: typeof o.purchaseId === "string" ? o.purchaseId : "",
    settled: !!o.settled,
  })) : [];
  // Older data stored the name on the debt itself; promote each distinct name to a profile.
  // This also catches a debt whose profile has since been deleted.
  const pids = new Set(s.people.map(x => x.id));
  for(const o of s.owed){
    if(o.personId && pids.has(o.personId)) continue;
    const nm = String(o.who || "Someone").trim() || "Someone";
    let who = s.people.find(x => x.name.toLowerCase() === nm.toLowerCase());
    if(!who){ who = {id:uid(), name:nm, brand:""}; s.people.push(who); pids.add(who.id); }
    o.personId = who.id;
  }
  for(const o of s.owed){ delete o.who; delete o.due; }

  // A wish can either track a real section's balance or hold a number you keep yourself.
  s.wish = Array.isArray(s.wish) ? s.wish.filter(w => w && typeof w === "object" && w.id).map(w => ({
    ...w, name:String(w.name ?? "Untitled"), cost:r2(w.cost), saved:r2(w.saved),
    accId: typeof w.accId === "string" ? w.accId : "",
    brand: typeof w.brand === "string" ? w.brand : "",
    logo:  typeof w.logo  === "string" ? w.logo  : "",
  })) : [];
  s.accounts = s.accounts.filter(a=>a && typeof a==="object" && a.id).map(a=>({
    ...a, name:String(a.name ?? "Untitled"), bal:r2(a.bal),
    parent:a.parent || null, loanId:a.loanId ?? "", kind:a.kind || "gotyme",
    brand: typeof a.brand === "string" ? a.brand : "",
    logo: typeof a.logo === "string" ? a.logo : "",
  }));
  // An orphan (parent id pointing at a deleted account) would vanish from the UI entirely,
  // since it is neither a parent nor anyone's child. Promote it to top level instead.
  const ids = new Set(s.accounts.map(a=>a.id));
  for(const a of s.accounts) if(a.parent && !ids.has(a.parent)) a.parent = null;
  for(const w of s.wish) if(w.accId && !ids.has(w.accId)) w.accId = "";
  // A purchase that has since been deleted must not leave a dangling link behind.
  for(const o of s.owed){
    if(!o.purchaseId) continue;
    const L = s.loans.find(x => x.id === o.loanId);
    if(!L || !isCard(L) || !(L.purchases||[]).some(pp => pp.id === o.purchaseId)){
      o.loanId = ""; o.purchaseId = "";
    }
  }
  s.loans = s.loans.filter(L => L && typeof L === "object" && L.id);
  for(const L of s.loans){
    if(typeof L.brand !== "string") L.brand = "";
    if(typeof L.logo !== "string") L.logo = "";
    if(isCard(L)){
      if(!Array.isArray(L.purchases)) L.purchases = [];
      // Amounts come back from JSON as whatever was in the file; an un-coerced string or
      // null here turns every derived statement total into NaN.
      L.purchases = L.purchases.filter(x => x && x.id).map(x => ({...x, amount:r2(x.amount)}));
      L.sDay = +L.sDay || 9; L.dDay = +L.dDay || 19; L.limit = r2(L.limit); rebuildCard(L);
    } else {
      L.items = Array.isArray(L.items)
        ? L.items.filter(i => i && i.due).map(i => ({...i, amount:r2(i.amount), paid:!!i.paid}))
        : [];
    }
  }
  s.assumePaid = !!s.assumePaid;
  s.allowance = normAllowance(s.allowance);
  s.v = DATA_V;
  return s;
}

// S.allowance = {weekday:0-6 (Sun=0), amount, lastAdded:"YYYY-MM-DD"|""} | null
const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
// Anything partial, out-of-range, or non-numeric collapses to null (= "no schedule"),
// so downstream math can trust weekday is 0-6 and amount is a real number.
function normAllowance(a){
  if(!a || typeof a !== "object") return null;
  const weekday = Number(a.weekday), amount = r2(a.amount);
  if(!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
  if(!Number.isFinite(amount) || amount <= 0) return null;
  return {weekday, amount, lastAdded: typeof a.lastAdded === "string" ? a.lastAdded : ""};
}
// The most recent scheduled allowance date on or before today — "this week's" allowance.
// Returns today itself when today is the scheduled weekday.
const allowanceDateFor = wd => addDays(today(), -(((new Date().getDay() - wd) + 7) % 7));
function lastAllowanceDate(){ return S.allowance ? allowanceDateFor(S.allowance.weekday) : null; }
// Has the allowance for the current week already been added to the balances?
// lastAdded is a plain YYYY-MM-DD, so a string compare is a date compare.
function allowanceClaimed(){
  const d = lastAllowanceDate();
  return !!d && (S.allowance.lastAdded || "") >= d;
}
// Claimable whenever this week's allowance has not been added yet — not only on the day
// itself. Missing the exact weekday used to make the prompt vanish for a whole week.
function isAllowanceDay(){ return !!S.allowance && !allowanceClaimed(); }
// Days until the next scheduled allowance — the window "safe to spend" and the weekly
// outlook both use. No schedule set = a plain 7-day week, same idea without the exact date.
function daysUntilAllowance(){
  if(!S.allowance) return 7;
  const delta = (S.allowance.weekday - new Date().getDay() + 7) % 7;
  return delta === 0 ? 7 : delta; // today IS allowance day: the relevant horizon is the week starting now
}

let S = load();
function load(){
  try{ const raw = localStorage.getItem("ledger");
       if(raw) return migrate(JSON.parse(raw)); }
  catch(e){ console.warn("unreadable save, starting blank", e); }
  return blank();
}
const save = () => { try{ localStorage.setItem("ledger", JSON.stringify(S)); }
                     catch(e){ console.warn("could not save", e); } };

// ---------- cloud sync ----------
// The sync code is a random UUID generated on-device — it never touches any
// server until you paste it into a second device. It is the sole credential:
// the database has no table listing or auth, only "give the exact code back".
const SUPA_URL = "https://fzdaszlzelrtsrzffpnm.supabase.co";
const SUPA_KEY = "sb_publishable_L3ygAIqbM71V1Hnm_c56xQ_MlQW_oTH";
const syncCode = () => localStorage.getItem("syncCode") || "";
const rpc = (fn, body) => fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
  method:"POST",
  headers:{ "content-type":"application/json", apikey:SUPA_KEY, authorization:`Bearer ${SUPA_KEY}` },
  body: JSON.stringify(body),
}).then(r=>{ if(!r.ok) throw new Error("sync request failed ("+r.status+")"); return r.json(); });

let syncTimer = null;
// Nothing may be pushed until the boot pull has settled. render() runs the moment the
// script does, which queued a push of whatever this device had in localStorage 1200ms
// later — and on a connection slower than that, the push landed FIRST and overwrote
// newer cloud data with this device's stale copy. That is how a section added or edited
// on one device would silently vanish everywhere: last-write-wins, and the stale device
// happened to write last. The push now waits for the pull it was racing.
let syncReady = false;
function setSyncNote(t){ const el = $("#syncNote"); if(el) el.textContent = t; }

async function pushCloud(){
  const code = syncCode(); if(!code) return;
  setSyncNote("Syncing…");
  try{
    const stamp = await rpc("ledger_push", { p_code:code, p_data:S });
    localStorage.setItem("syncStamp", stamp);
    setSyncNote("Synced just now");
  } catch(e){ console.warn(e); setSyncNote("Sync failed — will retry"); }
}
// Waits for a clean, settled frame before a big DOM rewrite lands — mutating mid
// momentum-scroll is what was producing the smeared/ghosted text on iPhone.
const renderNextFrame = ()=> requestAnimationFrame(()=> requestAnimationFrame(render));

// Runs once on boot: if another device pushed since our last known sync stamp,
// adopt the cloud copy. Simple last-write-wins — fine for one person's own devices,
// not built for two people editing the same code at the same moment.
async function bootSync(){
  const code = syncCode(); if(!code){ syncReady = true; return; }
  setSyncNote("Checking sync…");
  // Anything edited while the pull is in flight still has to reach the cloud, but a boot
  // that changed nothing must not write: a pointless push bumps updated_at and makes
  // every other device think it is behind.
  const atBoot = JSON.stringify(S);
  let adopted = false;
  try{
    const row = await pullCloud(code);
    if(row && row.updated_at !== localStorage.getItem("syncStamp")){
      S = migrate(row.data); localStorage.setItem("syncStamp", row.updated_at);
      logIt("Synced newer data from another device"); adopted = true;
    } else if(!row){
      await pushCloud(); // brand-new code with nothing on it yet
    }
  } catch(e){ console.warn("sync check failed", e); }
  // Set even when the pull failed, or an offline start would block syncing for the
  // whole session.
  syncReady = true;
  if(adopted) return renderNextFrame();
  setSyncNote("Synced across your devices");
  if(JSON.stringify(S) !== atBoot) queuePush();
}
// Debounced: typing several edits in a row should send one request, not one per keystroke.
function queuePush(){
  if(!syncCode() || !syncReady) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushCloud, 1200);
}
async function pullCloud(code){
  const [row] = await rpc("ledger_pull", { p_code:code });
  return row || null; // null = a fresh code with nothing saved to it yet
}
async function setupSync(){
  const has = syncCode();
  ask(has ? "Sync code" : "Turn on sync", [
    {name:"code", label: has ? "This device's code — enter it on another device to link them"
                              : "Paste a code from another device, or leave blank to generate a new one",
     value: has}], async (v,d)=>{
    if(v!=="ok") return;
    if(has && d.code===has) return; // unchanged
    let code = (d.code||"").trim();
    if(code && !/^[0-9a-f-]{36}$/i.test(code)) return alert("That does not look like a sync code.");
    if(!code){ code = crypto.randomUUID(); localStorage.setItem("syncCode", code); syncReady = true; await pushCloud(); return renderSyncBtn(); }
    setSyncNote("Connecting…");
    try{
      const row = await pullCloud(code);
      localStorage.setItem("syncCode", code); syncReady = true;
      if(row){ localStorage.setItem("syncStamp", row.updated_at);
        S = migrate(row.data); logIt("Pulled data from sync"); renderNextFrame(); }
      else await pushCloud(); // brand-new code with nothing on it yet: seed it with what's here
      renderSyncBtn();
    } catch(e){ alert("Could not reach sync: "+e.message); }
  });
}
function renderSyncBtn(){
  const b = $("#syncBtn"); if(!b) return;
  const has = syncCode();
  b.textContent = has ? "Synced ⇄" : "Set up sync";
  setSyncNote(has ? "Synced across your devices" : "Stored only in this browser");
}

// The funding window, read off the segmented control.
const horizon = () => Number(document.querySelector('input[name="hz"]:checked')?.value) || 14;

const acc = id => S.accounts.find(a=>a.id===id);
const loan = id => S.loans.find(L=>L.id===id);
const parents = () => S.accounts.filter(a=>!a.parent);
const kidsOf = id => S.accounts.filter(a=>a.parent===id);
const mainAcc = () => S.accounts.find(a=>a.kind==="gotyme" && !a.parent) || parents()[0];
const envelopes = () => kidsOf(mainAcc()?.id).filter(a=>a.loanId && a.loanId!=="income");
const incomeAcc = () => S.accounts.find(a=>a.loanId==="income") || mainAcc();
const groupTotal = a => r2(a.bal + kidsOf(a.id).reduce((s,k)=>s+k.bal,0));
const envelopeFor = loanId => S.accounts.find(a=>a.loanId===loanId);
const unpaid = L => (L.items||[]).filter(i=>!i.paid);
const LOG_MAX = 600;
const logIt = t => { S.log.unshift({id:uid(), t, when:new Date().toISOString()}); S.log = S.log.slice(0,LOG_MAX); };

function duesOf(days, L){
  const out = [];
  for(const x of (L?[L]:S.loans)) for(const it of (x.items||[]))
    if(!it.paid && daysTo(it.due) <= days) out.push({L:x, it});
  return out.sort((a,b)=> a.it.due < b.it.due ? -1 : 1);
}
const dues = (days, L) => duesOf(days, L);

// How far this envelope's balance stretches down its own schedule.
function coverage(env){
  const L = loan(env.loanId); if(!L) return null;
  let bal = env.bal, n = 0, through = null;
  for(const it of unpaid(L)){
    if(bal + 1e-9 >= it.amount){ bal = r2(bal - it.amount); n++; through = it.due; }
    else return {n, through, shortNext:r2(it.amount-bal), nextDue:it.due, done:false};
  }
  return {n, through, shortNext:0, nextDue:null, done:true};
}

// One line telling you exactly how far this envelope goes and what closes the gap.
function covText(env){
  const L = loan(env.loanId);
  if(!L) return `<span class="dim">not linked to a loan</span>`;
  const left = unpaid(L), n = left.length;
  if(!n) return `<span class="ok">${esc(L.label)} is fully paid off</span>`;
  const total = r2(left.reduce((s,i)=>s+i.amount,0));
  const c = coverage(env), gap = r2(total - env.bal);
  if(c.done) return `<span class="ok">Covers ${n}/${n} — all funded</span>`
    + (env.bal>total ? ` <span class="dim">· ${money(r2(env.bal-total))} spare</span>` : "");
  const all = `<span class="warn">${money(gap)} more covers all ${n}</span>`;
  return c.n
    ? `Covers <b>${c.n}/${n}</b> · ${all}`
    : `<span class="bad">Covers 0/${n}</span> · ${money(c.shortNext)} short for ${nice(c.nextDue)} · ${all}`;
}

// Top up each envelope to cover its own dues in the window. Pull from Myself, then the main wallet.
function fundingPlan(days){
  const srcs = [incomeAcc(), mainAcc()].filter((a,i,arr)=>a && arr.indexOf(a)===i);
  const pool = r2(srcs.reduce((s,a)=>s+a.bal,0));
  const rows = [];
  for(const env of envelopes()){
    const need = r2(dues(days, loan(env.loanId)).reduce((s,d)=>s+d.it.amount,0));
    const gap = r2(need - env.bal);
    if(gap > 0) rows.push({env, need, gap});
  }
  rows.sort((a,b)=>{
    const da = unpaid(loan(a.env.loanId))[0]?.due || "9999", db = unpaid(loan(b.env.loanId))[0]?.due || "9999";
    return da<db?-1:1;
  });
  let left = pool, short = 0;
  for(const r of rows){ r.give = r2(Math.min(left, r.gap)); left = r2(left - r.give); short = r2(short + r.gap - r.give); }
  const orphanNeed = r2(S.loans.filter(L=>!envelopeFor(L.id))
    .reduce((s,L)=>s+dues(days,L).reduce((t,d)=>t+d.it.amount,0),0));
  return {rows, short, pool, orphanNeed, srcs};
}
