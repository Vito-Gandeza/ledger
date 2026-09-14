"use strict";
// Part of Ledger. Loaded as a plain classic script in index.html, in order:
// data -> render -> app. No modules and no build step, so the file still opens from disk.

// ---------- render ----------
let booted = false;
// The crossfade is decoration and must NEVER be load-bearing. startViewTransition can abort
// ("InvalidStateError: Transition was aborted because of invalid state" — e.g. a hidden
// document or an overlapping transition) and then never invoke its update callback, which
// silently skipped paint() entirely: state changed, UI froze, and because
// body[data-state=empty] hides .dash, the whole dashboard disappeared and its buttons went
// dead. paint() is now guaranteed to run whether or not the transition survives.
function render(){
  let painted = false;
  const go = ()=>{ painted = true; paint(); };
  const midEntrance = document.body.classList.contains("boot");
  const canAnimate = booted && !midEntrance && document.startViewTransition
    && document.visibilityState === "visible"
    && !matchMedia("(prefers-reduced-motion:reduce)").matches;
  booted = true;
  if(!canAnimate) return go();
  try{
    const t = document.startViewTransition(go);
    // Rejects if the transition is aborted before the callback runs — repaint directly then.
    // Also swallows what would otherwise surface as an unhandled promise rejection.
    t.updateCallbackDone?.catch(()=>{ if(!painted) go(); });
    t.ready?.catch(()=>{});
    t.finished?.catch(()=>{});
  } catch(e){ if(!painted) go(); }
}

function paint(){
  document.body.dataset.state = (S.accounts.length || S.loans.length) ? "ready" : "empty";
  // Reset the flag on the way out too, or a suppressed undo checkpoint would leak into
  // whatever the next paint happens to be and silently swallow that checkpoint instead.
  if(document.body.dataset.state === "empty"){ save(); suppressHistory = false; return; }

  const assets = r2(S.accounts.reduce((s,a)=>s+a.bal,0) + cashOwed());
  const owed   = r2(S.loans.reduce((s,L)=>s+unpaid(L).reduce((t,i)=>t+i.amount,0),0) - cardOwed());
  tween($("#net"), r2(assets-owed));
  $("#net").className = "net num " + (assets-owed<0?"bad":"");
  tween($("#assets"), assets);
  tween($("#owed"), owed);

  // Safe to spend = allowance left after every envelope is topped up before the next allowance
  // lands (defaults to a plain 7-day week if no allowance schedule is set).
  const horizonDays = daysUntilAllowance(); // never name this `window` — it shadows the global
  const gaps = r2(fundingPlan(horizonDays).rows.reduce((s,r)=>s+r.gap,0));
  const safe = r2((incomeAcc()?.bal || 0) - gaps);
  tween($("#safe"), safe);
  $("#safe").className = "v num " + (safe<0 ? "bad" : safe===0 ? "warn" : "ok");
  $("#safeNote").textContent = gaps>0
    ? `after ${money(gaps)} of top-ups, until your next allowance` : "until your next allowance";
  // The one supporting figure that stays on the surface: what you can spend today.
  $("#netNote").innerHTML = `<b class="${safe<0?"bad":safe===0?"warn":"ok"}">${money(safe)}</b> safe to spend until your next allowance`;
  // "Owed" quietly means something different with the mode on, so it has to say so.
  $("#owedNoteHero").textContent = cardOwed() > 0 ? `less ${money(cardOwed())} being reimbursed` : "";

  // Money coming back to you is not an asset yet, so it never moves the headline number —
  // it sits beside it as the figure that number becomes once people pay.
  const back = owedToMe();
  $("#owedMeWrap").hidden = back <= 0;
  $("#assumeWrap").hidden = back <= 0;
  $("#assumeChk").checked = !!S.assumePaid;
  if(back > 0){
    $("#assumeAmt").textContent = money(back);
    tween($("#owedMe"), back);
    $("#owedMeNote").textContent = assumePaid()
      ? "already counted in the figures above"
      : `net ${money(r2(assets - owed + back))} once settled`;
  }

  const last = S.loans.flatMap(unpaid).map(i=>i.due).sort().pop();
  $("#freeBy").textContent = last ? niceY(last) : "clear";
  $("#freeNote").textContent = last ? `${Math.ceil(daysTo(last)/7)} weeks left` : "";

  const late = dues(9999).filter(d=>daysTo(d.it.due)<0);
  let alertHtml = late.length
    ? `<div class="alertbar bad">${late.length} payment${late.length>1?"s":""} overdue ·
       ${money(r2(late.reduce((s,d)=>s+d.it.amount,0)))} — ${esc(late[0].L.label)} since ${nice(late[0].it.due)}</div>` : "";
  if(isAllowanceDay() && incomeAcc()){
    const on = lastAllowanceDate();
    alertHtml += `<div class="alertbar ok">
      <span class="grow">${on===today() ? "It&rsquo;s allowance day" : `Your ${WEEKDAYS[S.allowance.weekday]} allowance was due ${nice(on)}`}
        — is the ${money(S.allowance.amount)} already in ${esc(incomeAcc().name)}?</span>
      <button class="btn mini primary" data-allowance-claimed>Yes, it&rsquo;s in</button>
      <button class="btn mini" data-allowance-add>Add it for me</button></div>`;
  }
  $("#alert").innerHTML = alertHtml;

  renderAccounts(); renderCards(); renderLoans(); renderPlan(); renderTimeline(); renderWeekly(); renderWish(); renderOwed(); renderCatch();
  const lc = $("#logCount"); if(lc) lc.textContent = S.log.length ? `${S.log.length} entries` : "nothing yet";
  $("#log").innerHTML = S.log.map(l=>`<div class="row"><div class="grow"><div class="name">${esc(l.t)}</div>
      <div class="sub">${new Date(l.when).toLocaleString("en-PH",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</div></div></div>`
    ).join("") || `<div class="empty">Nothing logged yet.</div>`;
  save(); renderSyncBtn(); queuePush(); pushHistory();
  const u = $("#undoBtn"); if(u) u.disabled = undoStack.length < 2;
}

// ---------- undo ----------
// Every render() call follows a real data change, so a state snapshot at the end of each
// one is a natural checkpoint. "Undo" just steps back one.
let undoStack = [], suppressHistory = false;
function pushHistory(){
  if(suppressHistory){ suppressHistory = false; return; }
  undoStack.push(JSON.stringify(S));
  if(undoStack.length > 25) undoStack.shift();
}
function undo(){
  if(undoStack.length < 2) return;
  undoStack.pop();
  suppressHistory = true;
  S = migrate(JSON.parse(undoStack[undoStack.length - 1]));
  render();
}

// count-up so a balance change is felt, not just seen
function tween(el, to){
  const from = Number(el.dataset.v ?? to);
  el.dataset.v = to;
  if(from === to || matchMedia("(prefers-reduced-motion:reduce)").matches){ el.textContent = money(to); return; }
  const t0 = performance.now(), dur = 480;
  const step = t => {
    const k = Math.min(1, (t-t0)/dur), e = 1-Math.pow(1-k,3);
    el.textContent = money(r2(from + (to-from)*e));
    if(k<1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// A tinted disc per wallet: a list of same-looking rows is the hardest thing to scan.
const KIND_ICON = {
  gotyme: `<svg viewBox="0 0 24 24"><path d="M3 9.5 12 4l9 5.5"/><path d="M5 10v8m4-8v8m6-8v8m4-8v8"/><path d="M3 20h18"/></svg>`,
  gcash:  `<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M16 12.5h2.5"/></svg>`,
  cash:   `<svg viewBox="0 0 24 24"><rect x="2.5" y="6.5" width="19" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/></svg>`,
};
// How much of everything still owed on this envelope's loan its balance already covers.
function covBar(env){
  const L = loan(env.loanId); if(!L) return "";
  const left = unpaid(L); if(!left.length) return "";
  const total = r2(left.reduce((s,i)=>s+i.amount,0));
  const pct = total > 0 ? Math.min(100, Math.max(0, env.bal / total * 100)) : 100;
  const cls = pct >= 100 ? "full" : pct <= 0 ? "none" : "";
  return `<div class="cov"><i class="${cls}" style="width:${pct.toFixed(1)}%"></i></div>`;
}

function renderAccounts(){
  const m = mainAcc();
  $("#accounts").innerHTML = parents().map(p=>{
    const kids = kidsOf(p.id);
    const head = `<div class="row head-row">
        <span class="ico" style="${p.brand||p.logo?`background:color-mix(in srgb,${brandOf(p)} 18%,transparent);color:${brandOf(p)}`:""}">${
          p.logo ? brandMark(p,"") : (KIND_ICON[p.kind] || KIND_ICON.gotyme)}</span>
        <div class="grow"><div class="name">${esc(p.name)}${p.id===m?.id?` <span class="pill">main</span>`:""}</div>
          <div class="sub">${kids.length? `wallet ${money(p.bal)} · group ${money(groupTotal(p))}`
                                        : ({cash:"Physical cash",gcash:"E-wallet",gotyme:"Bank"})[p.kind]}</div></div>
        <div class="amt num">${money(p.bal)}</div>
        <div class="rowacts">
          <button class="iconbtn" data-xfer="${p.id}" title="Transfer" aria-label="Transfer">⇄</button>
          ${p.id===m?.id?`<button class="iconbtn" data-add-kid="${p.id}" title="Add section" aria-label="Add section">+</button>`:""}
          <button class="iconbtn" data-edit-acc="${p.id}" title="Edit" aria-label="Edit">Edit</button>
        </div>
      </div>`;
    return head + kids.map((k,i)=>{
      const L = loan(k.loanId);
      // A section's own brand colour wins; otherwise it borrows the colour of the loan it
      // funds, so the section and its payments read as the same thing across the app.
      const tint = k.brand || (L ? colorOf(L) : "var(--accent)");
      const note = k.loanId==="income" ? `<span class="pill">allowance pool</span>` : covText(k);
      return `<div class="row kid">
        <div class="mvs">
          <button class="iconbtn" data-mv="${k.id}:-1" aria-label="Move up" ${i===0?"disabled":""}>▲</button>
          <button class="iconbtn" data-mv="${k.id}:1" aria-label="Move down" ${i===kids.length-1?"disabled":""}>▼</button>
        </div>
        <span class="ico" style="background:color-mix(in srgb,${tint} 20%,transparent);color:${tint}">${
          k.logo ? brandMark(k,"") : esc(k.name.trim()[0] || "?").toUpperCase()}</span>
        <div class="grow"><div class="name">${esc(k.name)}</div><div class="sub">${note}</div>${covBar(k)}</div>
        <div class="amt num">${money(k.bal)}</div>
        <div class="rowacts">
          ${k.loanId==="income"?"":`<button class="btn mini" data-fund="${k.id}">Fund</button>`}
          <button class="iconbtn" data-xfer="${k.id}" title="Transfer" aria-label="Transfer">⇄</button>
          <button class="iconbtn" data-edit-acc="${k.id}" title="Edit" aria-label="Edit">Edit</button>
        </div>
      </div>`;
    }).join("");
  }).join("") || `<div class="empty">No wallets yet.</div>`;
}

function renderCards(){
  const cards = S.loans.filter(isCard);
  $("#cardsWrap").style.display = cards.length ? "" : "none";
  $("#cards").innerHTML = cards.map(L=>{
    const out = outstanding(L), avail = available(L), env = envelopeFor(L.id);
    const openDue = cycleFor(today(), L.sDay, L.dDay).due;
    const stmts = L.items.filter(i=>i.due!==openDue);
    const open = L.items.find(i=>i.due===openDue);
    const settled = stmts.filter(i=>i.paid).sort((a,b)=> a.due<b.due?1:-1);  // newest first
    const billed = r2(stmts.filter(i=>!i.paid).reduce((s,i)=>s+i.amount,0));
    const openAmt = open ? open.amount : 0;
    // A card with no limit set would make every bar width NaN/Infinity.
    const pct = v => L.limit > 0 ? Math.min(100, Math.max(0, v / L.limit * 100)) : 0;

    const cyc = (it,isOpen)=>{
      const n = daysTo(it.due);
      const cls = it.paid ? "dim" : n<0 ? "bad" : n<=3 ? "warn" : "";
      const when = it.paid ? "settled" : n<0 ? `${-n}d overdue` : n===0 ? "due today" : `due in ${n}d`;
      return `<div class="cyc${isOpen?" openc":""}">
        <div class="cychead">
          <span class="grow"><b>${isOpen?"Open cycle":"Statement "+nice(it.stmt)}</b>
            <span class="sub">${isOpen?`closes ${nice(it.stmt)} · `:""}pay by ${niceY(it.due)}</span></span>
          <span class="num">${money(it.amount)}</span></div>
        <div class="sub ${cls}">${isOpen && !it.paid ? "not billed yet" : when}</div>
        ${purchasesIn(L,it.due).map(p=>`<div class="pur">
            <span class="sub" style="width:52px">${nice(p.date)}</span>
            <span class="grow">${esc(p.label)}</span>
            <span class="num">${money(p.amount)}</span>
            <button class="iconbtn" data-edit-pur="${L.id}:${p.id}">edit</button></div>`).join("")}
        ${it.paid ? `<button class="btn mini" data-unpay-card="${L.id}:${it.due}" style="margin-top:9px">mark unpaid</button>`
                  : `<button class="btn ${isOpen?"mini":"primary"}" data-pay-card="${L.id}:${it.due}" style="margin-top:9px">Pay ${money(it.amount)}</button>`}
      </div>`;
    };

    return `<div class="card ccwrap" style="--b:${brandOf(L)}; margin-bottom:14px">
      <div class="cardface">
        <div class="ccband">
          <div class="cchead">${brandMark(L, L.provider)}
            <span class="grow"></span>
            <button class="btn mini ccbtn" data-link="${L.id}">${env?`⇄ ${esc(env.name)}`:"Link a wallet"}</button>
            <button class="btn mini ccbtn" data-edit-card="${L.id}">Edit</button></div>
          <div class="cclabel">Available credit</div>
          <div class="ccbig num">${money(avail)}</div>
          <div class="cctrack">
            <i class="used" style="width:${pct(billed)}%"></i>
            <i class="open" style="width:${Math.min(pct(openAmt), 100-pct(billed))}%"></i></div>
          <div class="ccstats">
            <span>${money(out)} used of ${money(L.limit)}</span>
            <span class="ccright">Billed ${ord(L.sDay)} · due ${ord(L.dDay)}</span></div>
        </div>
        <div class="cardmeta">
          ${env?`<div class="sub">Funded by ${esc(env.name)}</div>`:""}
          ${out? `<div class="sub" style="margin-top:4px">
            ${billed? `<i class="dot" style="background:var(--accent);display:inline-block;vertical-align:middle;margin-right:4px"></i>${money(billed)} billed &amp; unpaid`:""}
            ${billed&&openAmt?" · ":""}
            ${openAmt? `<i class="dot" style="background:var(--warn);display:inline-block;vertical-align:middle;margin-right:4px"></i>${money(openAmt)} not billed yet`:""}
          </div>`:""}
        </div>
      </div>
      ${open ? cyc(open,true) : `<div class="empty">Nothing charged this cycle. Next statement ${niceY(cycleFor(today(),L.sDay,L.dDay).stmt)}.</div>`}
      ${stmts.filter(i=>!i.paid).sort((a,b)=> a.due<b.due?-1:1).map(i=>cyc(i,false)).join("")}
      ${settled.length ? `<details class="fold">
        <summary class="foldhead"><span class="chev">&rsaquo;</span>
          <span class="grow">${settled.length} settled statement${settled.length>1?"s":""}</span>
          <span class="sub num">${money(r2(settled.reduce((s,i)=>s+i.amount,0)))} paid</span></summary>
        ${settled.map(i=>cyc(i,false)).join("")}</details>` : ""}
    </div>`;
  }).join("");
}

function renderLoans(){
  const list = S.loans.filter(L=>!isCard(L));
  $("#loans").innerHTML = list.map(L=>{
    const left = unpaid(L), next = left[0], env = envelopeFor(L.id);
    const n = next ? daysTo(next.due) : null;
    const cls = !next ? "" : n<0 ? "bad" : n<=3 ? "warn" : "dim";
    const when = !next ? "cleared" : n<0 ? `${-n}d overdue` : n===0 ? "due today" : `in ${n}d`;
    return `<details><summary class="row">
      <span class="dot" style="background:${colorOf(L)}"></span>
      <div class="grow"><div class="name"><span class="chev">›</span> ${esc(L.provider)} · ${esc(L.label)}</div>
        <div class="sub ${cls}">${next?`next ${niceY(next.due)} · ${when}`:"all paid"} · ${L.items.length-left.length}/${L.items.length} paid${env?` · ${esc(env.name)}`:""}</div></div>
      <div class="amt num">${next?money(next.amount):"—"}</div>
      <div class="sub num" style="width:76px;text-align:right">${money(r2(left.reduce((s,i)=>s+i.amount,0)))}</div>
      </summary>
      <div class="inst" style="border-top-style:solid">
        <span class="grow sub">${esc(L.ref||"no ref")} · every ${L.freq==="2weeks"?"2 weeks":L.freq}</span>
        <button class="btn mini" data-link="${L.id}">${env?`⇄ ${esc(env.name)}`:"link a wallet"}</button>
        <button class="btn mini" data-extend="${L.id}">+ extend</button>
        <button class="btn mini" data-del-loan="${L.id}">delete</button>
      </div>
      ${L.items.map((it,i)=>{
        const dn = daysTo(it.due);
        const c = it.paid ? "dim" : dn<0 ? "bad" : dn<=3 ? "warn" : "";
        return `<div class="inst" style="${it.paid?"opacity:.45":""}">
          <span class="grow ${c}">${niceY(it.due)}</span>
          <span class="num">${money(it.amount)}</span>
          ${it.paid?`<button class="iconbtn" data-unpay="${L.id}:${i}">undo</button>`
                   :`<button class="btn mini" data-pay="${L.id}:${i}">Pay</button>`}
          <button class="iconbtn" data-edit-inst="${L.id}:${i}">edit</button>
        </div>`;}).join("")}
      </details>`;
  }).join("") || `<div class="empty">No instalment loans yet.</div>`;
}

function renderPlan(){
  const days = horizon();
  const {rows, short, orphanNeed, srcs} = fundingPlan(days);
  const need = r2(dues(days).reduce((s,d)=>s+d.it.amount,0));
  const gapTotal = r2(rows.reduce((s,r)=>s+r.gap,0));

  let html = `<div class="eyebrow">Due in window</div><div class="big num">${money(need)}</div>
    <div class="sub">${srcs.map(a=>`${esc(a.name)} ${money(a.bal)}`).join(" · ")}</div>
    <div class="bar"><i style="width:${need?Math.min(100,(need-gapTotal)/need*100):100}%"></i></div>`;

  if(!rows.length && !orphanNeed)
    html += `<p class="ok" style="margin-top:14px">Every envelope already holds enough. Nothing to move.</p>`;
  else {
    if(rows.length){
      html += `<div class="eyebrow" style="margin:16px 0 4px">Top up from ${esc(srcs[0].name)}</div>`
        + rows.map(r=>`<div class="move">
            <span class="dot" style="background:${colorOf(loan(r.env.loanId))}"></span>
            <span class="grow" style="font-size:14px">${esc(r.env.name)}
              <span class="dim">has ${money(r.env.bal)}, needs ${money(r.need)}</span></span>
            <span class="num${r.give<r.gap?" warn":""}">${money(r.give)}</span></div>`).join("")
        + `<button class="btn primary" id="doPlan" style="margin-top:14px">Apply transfers</button>`;
      if(short>0) html += `<p class="bad" style="margin-top:12px">Short ${money(short)} — ${esc(srcs[0].name)} and the main wallet cannot cover every envelope.</p>`;
    }
    if(orphanNeed>0) html += `<p class="warn" style="margin-top:12px;font-size:13px">${money(orphanNeed)} due on loans with no envelope — pays straight from the main wallet.</p>`;
  }

  // Grouped by loan: each payment on its own line, a subtotal per loan, the grand total last.
  const list = dues(days), byLoan = new Map();
  for(const d of list){
    if(!byLoan.has(d.L.id)) byLoan.set(d.L.id, {L:d.L, its:[]});
    byLoan.get(d.L.id).its.push(d.it);
  }
  if(byLoan.size) html += `<div class="eyebrow" style="margin:18px 0 2px">Covering</div>`
    + [...byLoan.values()].map(g=>{
      const sub = r2(g.its.reduce((s,i)=>s+i.amount,0));
      const late = g.its.filter(i=>daysTo(i.due)<0).length;
      return `<details class="grp">
        <summary class="top"><span class="chev">&rsaquo;</span>
          <span class="dot" style="background:${colorOf(g.L)}"></span>
          <span class="grow">${esc(g.L.label)}${late?` <span class="bad" style="font-size:13px">· ${late} late</span>`:""}</span>
          <span class="cnt">×${g.its.length}</span>
          <span class="num"><b>${money(sub)}</b></span></summary>
        ${g.its.map(i=>`<div class="line"><span class="grow">${niceY(i.due)}${daysTo(i.due)<0?' <b class="bad">late</b>':""}</span>
          <span class="num">${money(i.amount)}</span></div>`).join("")}
      </details>`;
    }).join("")
    + `<div class="grand"><span class="grow eyebrow">Grand total · ${list.length} payments</span>
        <span class="num" style="font-size:18px">${money(need)}</span></div>`;

  $("#plan").innerHTML = html;
  const b = $("#doPlan");
  if(b) b.onclick = ()=>{
    for(const r of rows){
      let want = r.give;
      for(const s of srcs){
        if(want<=0) break;
        const take = r2(Math.min(s.bal, want));
        if(take<=0) continue;
        s.bal = r2(s.bal-take); r.env.bal = r2(r.env.bal+take); want = r2(want-take);
        logIt(`Funded ${r.env.name} ${money(take)} from ${s.name}`);
      }
    }
    render();
  };
}

// Total assets today, carried forward week by week: minus everything due that week,
// plus allowance if the schedule lands in it. Conservative on purpose — no allowance
// configured means 0 income assumed, never a fabricated number.
//
// Two things this has to get right, because both silently mis-state the balance:
//  1. Anything already overdue is still money that must be found, so it belongs in
//     week 0. Filtering on `due >= today` dropped it from the outlook entirely.
//  2. The starting balance ALREADY contains an allowance that was claimed this week.
//     Counting that same occurrence again as future income double-counts it, so each
//     occurrence is only income while its date is newer than `lastAdded`.
// Everything already past its due date. Treated as a standing backlog rather than part of
// any week: it is one debt to clear, not a recurring cost, and folding it into week zero
// buried the ongoing rhythm underneath it.
const arrears = () => S.loans.flatMap(L => unpaid(L).filter(i => i.due < today()).map(it => ({L, it})));
const arrearsTotal = () => r2(arrears().reduce((s,x) => s + x.it.amount, 0));

function weeklyOutlook(weeks){
  // The projection opens on what is left AFTER the backlog is cleared, and the weeks
  // themselves carry only what is still to come. The arrears are still fully accounted
  // for — they come off the opening balance — but they no longer drown week zero.
  let bal = r2(S.accounts.reduce((s,a)=>s+a.bal,0) + cashOwed() - arrearsTotal());
  const start = today(), rows = [];
  const claimedTo = S.allowance?.lastAdded || "";
  const offsets = cardOffsets();
  for(let w=0; w<weeks; w++){
    const wStart = addDays(start, w*7), wEnd = addDays(start, w*7+6);
    const items = [];
    for(const L of S.loans) for(const it of unpaid(L))
      if(it.due >= wStart && it.due <= wEnd){
        // A statement someone else is covering costs you only the remainder.
        const covered = offsets.get(`${L.id}|${it.due}`) || 0;
        const due = r2(Math.max(0, it.amount - covered));
        items.push({L, it, due, covered: r2(Math.min(covered, it.amount))});
      }
    items.sort((a,b)=> a.it.due < b.it.due ? -1 : 1);
    const obligations = r2(items.reduce((s,x)=>s+x.due,0));

    const pays = [];
    if(S.allowance) for(let d=0; d<7; d++){
      const day = addDays(wStart, d);
      if(new Date(day+"T00:00:00").getDay() === S.allowance.weekday)
        pays.push({date:day, amount:S.allowance.amount, claimed: day <= claimedTo});
    }
    const income = r2(pays.filter(p=>!p.claimed).reduce((s,p)=>s+p.amount, 0));

    const open = bal;
    bal = r2(bal + income - obligations);
    rows.push({wStart, wEnd, items, obligations, income, pays, open, bal});
  }
  return rows;
}

const WK_WEEKS = 8;

// Eight weeks of closing balance as one column chart. Everything else in this app is a
// list of numbers; the shape of the next two months is the one thing a list cannot show.
// preserveAspectRatio="none" lets it stretch to any card width, so the zero line needs
// non-scaling-stroke (set in CSS) to stay 1px.
function weeklyChart(rows){
  const W = 100, H = 40, n = rows.length || 1;
  const vals = rows.map(r => r.bal);
  const hi = Math.max(0, ...vals), lo = Math.min(0, ...vals);
  const span = (hi - lo) || 1;
  const zero = H * (hi / span);            // y of the zero line
  const bw = W / n;
  const bars = rows.map((r,i) => {
    const h = Math.abs(H * (r.bal / span));
    const y = r.bal >= 0 ? zero - h : zero;
    return `<rect x="${(i*bw + bw*.2).toFixed(2)}" y="${y.toFixed(2)}"
      width="${(bw*.6).toFixed(2)}" height="${Math.max(h,.5).toFixed(2)}"
      class="${r.bal < 0 ? "neg" : "pos"}${i===0?" sel":""}"></rect>`;
  }).join("");
  return `<div class="wkchartwrap">
    <svg class="wkchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="Projected balance for the next ${n} weeks">
      ${bars}<line class="zero" x1="0" y1="${zero.toFixed(2)}" x2="${W}" y2="${zero.toFixed(2)}"/>
    </svg>
    <div class="wkaxis"><span>${nice(rows[0].wStart)}</span>
      <span class="${lo<0?"bad":""}">low ${money(lo)}</span>
      <span>${nice(rows[rows.length-1].wEnd)}</span></div>
  </div>`;
}

function renderWeekly(){
  const box = $("#weekly");
  // A re-render rebuilds the markup, so carry over which weeks the user had expanded.
  // First paint opens this week only.
  const wasOpen = [...box.querySelectorAll("details.wkw")].map(d=>d.open);
  const rows = weeklyOutlook(WK_WEEKS);

  const note = $("#wkNote");
  const flag = assumePaid() ? ` · <span class="pill due">incl. ${money(owedToMe())} owed to you</span>` : "";
  if(note) note.innerHTML = (!S.allowance
    ? `<span class="dim">No allowance scheduled — income is assumed to be zero</span>`
    : allowanceClaimed()
      ? `${money(S.allowance.amount)} every ${WEEKDAYS[S.allowance.weekday]} · <span class="ok">this week claimed</span>`
      : `${money(S.allowance.amount)} every ${WEEKDAYS[S.allowance.weekday]} · <span class="warn">this week not claimed yet</span>`) + flag;

  box.innerHTML = weeklyChart(rows) + rows.map((r,i)=>{
    const label = i===0 ? "This week" : i===1 ? "Next week" : `In ${i} weeks`;
    const dueTxt = r.obligations
      ? `${money(r.obligations)} due`
      : `<span class="dim">Nothing due</span>`;

    // Allowance lines first — whether the money is already in the balance is the thing
    // that most often makes a week read wrong.
    const incLines = r.pays.map(p=>`<div class="wkl inc">
        <span class="d">${nice(p.date)}</span>
        <span class="t">Allowance ${p.claimed
          ? `<span class="pill on">claimed</span>`
          : `<span class="pill due">expected</span>`}</span>
        <span class="m num${p.claimed?" dim":""}">${p.claimed?"":"+"}${money(p.amount)}</span>
      </div>`).join("");

    // A red date is the whole overdue signal — a chip or an "overdue" suffix just wrapped
    // onto a second line and doubled the height of every late row. The count is in the summary.
    const dueLines = r.items.map(x=>{
      const late = x.it.due < today();
      return `<div class="wkl${late?" late":""}">
        <span class="d">${nice(x.it.due)}</span>
        <span class="t"><span class="dot" style="background:${colorOf(x.L)};display:inline-block;vertical-align:middle;margin-right:7px"></span>${esc(x.L.label)}${
          x.covered>0?` <span class="ok" style="font-size:13px">&minus;${money(x.covered)} covered</span>`:""}</span>
        <span class="m num">&minus;${money(x.due)}</span>
      </div>`;
    }).join("");

    const body = (incLines + dueLines) || `<div class="empty">Nothing moves this week.</div>`;
    const openAttr = (wasOpen[i] ?? i===0) ? " open" : "";

    return `<details class="wkw${i===0?" now":""}"${openAttr}>
      <summary>
        <span class="chev">&rsaquo;</span>
        <span class="wkt"><b>${label}</b><span class="sub">${nice(r.wStart)} &ndash; ${nice(r.wEnd)}</span></span>
        <span class="wkn"><span class="bal num ${r.bal<0?"bad":""}">${money(r.bal)}</span>
          <span class="sub">${dueTxt}</span></span>
      </summary>
      <div class="wkb">${body}
        <div class="wkl sum">
          <span class="t">Opens ${money(r.open)}</span>
          <span class="d" style="width:auto">closes</span>
          <span class="m num ${r.bal<0?"bad":""}">${money(r.bal)}</span>
        </div>
      </div>
    </details>`;
  }).join("");

  const late = arrearsTotal();
  if(late > 0) box.insertAdjacentHTML("afterbegin",
    `<div class="wkfoot bad" style="border-bottom:1px solid var(--line-soft)">
       Opens after clearing ${money(late)} already overdue &mdash; see Catching up.</div>`);

  const worst = rows.find(r=>r.bal<0);
  if(worst) box.insertAdjacentHTML("beforeend",
    `<div class="wkfoot bad">Balance goes negative in the week of ${nice(worst.wStart)}.</div>`);
}

// ---------- owed to you ----------
const person = id => S.people.find(p => p.id === id);
const purchaseOf = o => {
  const L = loan(o.loanId);
  if(!L || !isCard(L)) return null;
  const pu = (L.purchases || []).find(x => x.id === o.purchaseId);
  return pu ? {L, pu} : null;
};
// A card-backed debt IS the purchase: its amount and what it was for come from there, so
// editing the purchase moves the debt with it and neither can go stale.
const owedAmount = o => { const l = purchaseOf(o); return l ? r2(l.pu.amount) : r2(o.amount); };
const owedLabel  = o => { const l = purchaseOf(o); return l ? l.pu.label : (o.note || ""); };

const receivables = () => S.owed.filter(o => !o.settled);
// "Assume settled" mode. Off by default, because a figure that counts money you have not
// been given yet is a figure that lies. On, every stock of money in the app — the net
// position, the weekly projection's opening balance, the pot a wish is measured against —
// is computed as if these debts had been paid. Rates are untouched: being owed money is a
// one-off, not income that arrives every week.
const assumePaid = () => !!S.assumePaid && owedToMeRaw() > 0;
// Two kinds of debt owed to you, and only one of them ever becomes spendable money.
// Cash someone owes you is yours the moment they hand it over. Something you fronted on a
// card is a pass-through: they pay you, you pay the card, and it was never your money —
// so it is netted out of BOTH sides rather than inflating what you hold.
const cashOwed = () => assumePaid() ? r2(owedToMeRaw() - owedOnCard()) : 0;
const cardOwed = () => assumePaid() ? owedOnCard() : 0;
// Which statement each fronted purchase belongs to, so it can be cancelled against the
// exact payment it will cover instead of being averaged across the schedule.
function cardOffsets(){
  const out = new Map();
  if(!assumePaid()) return out;
  for(const o of receivables()){
    if(!isPassThrough(o)) continue;
    const link = purchaseOf(o);
    const due = cycleFor(link.pu.date, link.L.sDay, link.L.dDay).due;
    const key = `${link.L.id}|${due}`;
    out.set(key, r2((out.get(key) || 0) + owedAmount(o)));
  }
  return out;
}
const owedToMeRaw = () => r2(receivables().reduce((s,o) => s + owedAmount(o), 0));
const owedToMe = owedToMeRaw;
// The part you fronted on a card: it sits in `owed` as a liability AND is coming back to
// you, which is what makes the headline number read worse than reality.
// Fronted spending is only a pass-through while the statement it bills to is still unpaid.
// Once you have settled that statement out of your own pocket, their repayment stops being
// earmarked and becomes plain cash coming back to you — before this, it was written off
// from every projection permanently.
function isPassThrough(o){
  const link = purchaseOf(o);
  if(!link) return false;
  const due = cycleFor(link.pu.date, link.L.sDay, link.L.dDay).due;
  const it = (link.L.items || []).find(i => i.due === due);
  return !!it && !it.paid;
}
const owedOnCard = () => r2(receivables().filter(isPassThrough).reduce((s,o) => s + owedAmount(o), 0));
// Debts grouped under the person who owes them, biggest debtor first.
function owedByPerson(){
  const groups = new Map();
  for(const o of receivables()){
    if(!groups.has(o.personId)) groups.set(o.personId, {who:person(o.personId), items:[], total:0});
    const g = groups.get(o.personId);
    g.items.push(o); g.total = r2(g.total + owedAmount(o));
  }
  return [...groups.values()].filter(g => g.who).sort((a,b) => b.total - a.total);
}

// ---------- wishlist ----------
// What is genuinely spare each week: allowance in, scheduled payments out, averaged.
// Week 0 is skipped because its allowance may already have been claimed, which would
// report a week of zero income as though it were the norm. The overdue backlog is not a
// factor here at all — it is held out of the weekly rows entirely.
function savingRate(){
  const rows = weeklyOutlook(WK_WEEKS).slice(1);
  if(!rows.length) return 0;
  const income = rows.reduce((s,r)=>s+r.income, 0);
  const out    = rows.reduce((s,r)=>s+r.obligations, 0);
  return r2((income - out) / rows.length);
}
// Progress is measured against everything you actually hold, across every wallet — there
// is no separate pot that has to be kept in step with reality.
const walletTotal = () => r2(S.accounts.reduce((s,a)=>s+a.bal, 0) + cashOwed());
// (savingRate still skips week zero: its allowance may already have been claimed, which
// would understate the steady rate.)
// Walk the projection week by week and return the first week the money is actually there,
// rather than dividing the gap by an average. Obligations are lumpy — a fortnightly
// instalment and a monthly statement land unevenly — so an average assumes you save the
// worst week's surplus every week and pushes the date out well past reality.
// Past the end of the projection there is nothing left to simulate, so the flat rate is
// used to extrapolate; that is the one place an average is the right tool.
function weeksToAfford(gap, rate){
  if(gap <= 0) return 0;
  const rows = weeklyOutlook(WK_WEEKS).slice(1);
  let run = 0;
  for(let i = 0; i < rows.length; i++){
    run = r2(run + rows[i].income - rows[i].obligations);
    if(run >= gap) return i + 1;
  }
  if(!(rate > 0)) return null;
  return rows.length + Math.ceil((gap - run) / rate);
}
function wishProgress(w, rate, pot){
  const saved = pot === undefined ? walletTotal() : r2(pot);
  const cost  = r2(w.cost);
  const left  = r2(Math.max(0, cost - saved));
  const weeks = weeksToAfford(left, rate);
  return { saved, cost, left,
           pct: cost > 0 ? Math.min(100, Math.max(0, saved / cost * 100)) : 100,
           when: (weeks === null || weeks === 0) ? null : addDays(today(), weeks * 7),
           weeks };
}

function renderCatch(){
  const box = $("#catch"); if(!box) return;
  const late = arrears(), total = arrearsTotal();
  $("#catchWrap").style.display = late.length ? "" : "none";
  if(!late.length) return;

  const oldest = late.reduce((a,b) => a.it.due < b.it.due ? a : b);
  const rate = savingRate();
  const weeks = rate > 0 ? Math.ceil(total / rate) : null;
  const note = $("#catchNote");
  if(note) note.textContent = `${plural(late.length, "payment")} · oldest ${plural(-daysTo(oldest.it.due), "day")}`;

  // Grouped by loan and ordered oldest-first: the order you would actually work through,
  // and the one that stops anything ageing further.
  const byLoan = new Map();
  for(const x of late){
    if(!byLoan.has(x.L.id)) byLoan.set(x.L.id, {L:x.L, items:[], total:0});
    const g = byLoan.get(x.L.id);
    g.items.push(x.it); g.total = r2(g.total + x.it.amount);
  }
  const groups = [...byLoan.values()].sort((a,b) =>
    (a.items[0]?.due || "9999") < (b.items[0]?.due || "9999") ? -1 : 1);

  box.innerHTML = `<div class="catchhead">
      <div class="eyebrow">Behind by</div>
      <div class="catchbig num bad">${money(total)}</div>
      <div class="sub">${weeks === null
        ? "Nothing spare each week — this will not clear on the current schedule"
        : `About <b>${plural(weeks, "week")}</b> of everything you can spare, clear around <b>${niceY(addDays(today(), weeks*7))}</b>`}</div>
    </div>`
    + groups.map(g=>{
      const isCard_ = isCard(g.L);
      return `<div class="row head-row">
        <span class="dot" style="background:${colorOf(g.L)}"></span>
        <div class="grow"><div class="name">${esc(g.L.label)}</div>
          <div class="sub">${g.items.length} behind &middot; oldest ${nice(g.items[0].due)}</div></div>
        <div class="amt num bad">${money(g.total)}</div>
      </div>` + g.items.map(it=>{
        const i = g.L.items.indexOf(it);
        return `<div class="row kid">
          <div class="grow"><div class="name">${niceY(it.due)}</div>
            <div class="sub bad">${plural(-daysTo(it.due), "day")} late</div></div>
          <div class="amt num">${money(it.amount)}</div>
          <div class="rowacts">
            <button class="btn mini primary" data-${isCard_?`pay-card="${g.L.id}:${it.due}`:`pay="${g.L.id}:${i}`}">Pay</button>
          </div>
        </div>`;
      }).join("");
    }).join("");
}

function renderOwed(){
  const box = $("#owedList"); if(!box) return;
  const groups = owedByPerson();
  const total = owedToMe(), onCard = owedOnCard();
  const assets = r2(S.accounts.reduce((s,a)=>s+a.bal,0));
  const owedOut = r2(S.loans.reduce((s,L)=>s+unpaid(L).reduce((t,i)=>t+i.amount,0),0));
  const now = r2(assets - owedOut), after = r2(now + total);

  const note = $("#owedNote");
  if(note) note.textContent = groups.length ? `${groups.length} ${groups.length>1?"people":"person"}` : "";

  if(!groups.length){
    box.innerHTML = `<div class="empty">Nobody owes you anything right now. Add a debt here and the difference it makes to your position shows above.</div>`;
    return;
  }

  // The point of the section: what the headline number says versus what it will say once
  // these land. Both bars share a scale, so the gap between them is the message.
  const span = Math.max(Math.abs(now), Math.abs(after), 1);
  const bar = (v, cls) => `<div class="track"><i class="${cls}" style="width:${(Math.abs(v)/span*100).toFixed(1)}%"></i></div>`;

  box.innerHTML = `<div class="owedviz">
      <div class="owedrow"><span class="lbl">Right now</span>
        ${bar(now, now<0?"neg":"pos")}<span class="num ${now<0?"bad":""}">${money(now)}</span></div>
      <div class="owedrow"><span class="lbl">Once they pay</span>
        ${bar(after, after<0?"neg":"pos")}<span class="num ${after<0?"bad":"ok"}">${money(after)}</span></div>
      <div class="owedsum"><span>${money(total)} coming back to you</span>
        ${onCard>0?`<span class="sub">${money(onCard)} of it already on a card</span>`:""}</div>
    </div>`
    + groups.map(g=>{
      const tint = g.who.brand || "var(--accent)";
      return `<div class="row head-row">
        <span class="ico" style="background:color-mix(in srgb,${tint} 18%,transparent);color:${tint}">${
          esc(g.who.name.trim()[0] || "?").toUpperCase()}</span>
        <div class="grow"><div class="name">${esc(g.who.name)}</div>
          <div class="sub">${g.items.length} ${g.items.length>1?"debts":"debt"}</div></div>
        <div class="amt num ok">${money(g.total)}</div>
        <div class="rowacts">
          <button class="iconbtn" data-edit-person="${g.who.id}" aria-label="Edit person">Edit</button>
        </div>
      </div>` + g.items.map(o=>{
        const link = purchaseOf(o);
        return `<div class="row kid">
          <div class="grow"><div class="name">${esc(owedLabel(o) || "No description")}</div>
            ${link?`<div class="sub"><span class="pill due">on ${esc(link.L.label)}</span> ${nice(link.pu.date)}</div>`
                  :`<div class="sub">not on a card</div>`}</div>
          <div class="amt num">${money(owedAmount(o))}</div>
          <div class="rowacts">
            <button class="btn mini" data-owed-settle="${o.id}">Settled</button>
            <button class="iconbtn" data-edit-owed="${o.id}" aria-label="Edit">Edit</button>
          </div>
        </div>`;
      }).join("");
    }).join("");
}

function renderWish(){
  const rate = savingRate(), pot = walletTotal();
  const note = $("#wishNote");
  if(note) note.innerHTML = (rate > 0
    ? `${money(pot)} saved · about <b>${money(rate)}</b> a week`
    : `${money(pot)} saved · <span class="warn">nothing spare each week right now</span>`)
    + (assumePaid() ? ` · <span class="pill due">incl. ${money(owedToMe())} owed to you</span>` : "");

  if(!S.wish.length){
    $("#wish").innerHTML = `<div class="empty">Nothing on the list yet. Add something you are saving for and this will tell you when you can afford it.</div>`;
    return;
  }
  const rows = S.wish.map(w => ({w, p: wishProgress(w, rate, pot)}));
  rows.sort((a,b) => b.p.pct - a.p.pct);   // closest to done first: the list is for momentum
  const C = 2 * Math.PI * 15.5;

  $("#wish").innerHTML = rows.map(({w,p}) => {
    const tint = w.brand || "var(--accent)";
    const done = p.left <= 0;
    const when = done ? `<span class="ok">You can afford this now</span>`
      : p.weeks === null ? `<span class="warn">No spare money at this rate</span>`
      : `Ready around <b>${niceY(p.when)}</b> · ${p.weeks} week${p.weeks>1?"s":""}`;
    return `<div class="wish">
      <span class="ringwrap">
        <svg class="ring" viewBox="0 0 36 36" style="--b:${tint}" aria-hidden="true">
          <circle class="track" cx="18" cy="18" r="15.5"/>
          <circle class="fill${done?" done":""}" cx="18" cy="18" r="15.5"
            stroke-dasharray="${(C*p.pct/100).toFixed(2)} ${C.toFixed(2)}"/>
        </svg>
        <span class="ringpct num">${done?"&#10003;":Math.round(p.pct)+"%"}</span>
      </span>
      <div class="grow">
        <div class="name">${w.logo?brandMark(w,""):""}${esc(w.name)}</div>
        <div class="sub">${money(p.cost)}${p.left>0?` · ${money(p.left)} to go`:""}</div>
        <div class="sub">${when}</div>
      </div>
      <div class="rowacts">
        <button class="iconbtn" data-edit-wish="${w.id}" aria-label="Edit">Edit</button>
      </div>
    </div>`;
  }).join("");

  const total = r2(rows.reduce((s,x)=>s+x.p.left, 0));
  if(total > 0) $("#wish").insertAdjacentHTML("beforeend",
    `<div class="wishfoot"><span class="grow">Everything on the list</span>
     <span class="num">${money(total)} to go</span></div>`);
}

const TL_MONTHS = 2;
function renderTimeline(){
  const sel = $("#tlFilter"), keep = sel.value;
  sel.innerHTML = `<option value="">All loans</option>` + S.loans.map(L=>`<option value="${L.id}">${esc(L.label)}</option>`).join("");
  sel.value = S.loans.some(L=>L.id===keep) ? keep : "";
  const only = sel.value ? loan(sel.value) : null;

  const byDate = new Map();
  for(const {L,it} of dues(9999, only)){
    if(!byDate.has(it.due)) byDate.set(it.due, []);
    byDate.get(it.due).push({L,it});
  }
  if(!byDate.size){ $("#timeline").innerHTML = `<div class="empty">Nothing scheduled.</div>`; return; }

  const dates = [...byDate.keys()].sort();
  const totalOf = d => r2(byDate.get(d).reduce((s,x)=>s+x.it.amount,0));
  const grand = r2(dates.reduce((s,d)=>s+totalOf(d),0));
  const shown = only ? [only] : S.loans.filter(L=>unpaid(L).length);
  const short = n => n>=1000 ? (n/1000).toFixed(n>=10000?0:1)+"k" : Math.round(n);

  // Only the next two months fit on a screen without scrolling; the rest is summarised below.
  const allMonths = [...new Set(dates.map(d=>d.slice(0,7)))];
  const months = allMonths.slice(0, TL_MONTHS);
  const beyond = dates.filter(d=>!months.includes(d.slice(0,7)));

  let html = `<div class="legend">${shown.map(L=>`<span><i class="dot" style="background:${colorOf(L)}"></i>${esc(L.label)}</span>`).join("")}
    <span style="margin-left:auto" class="num">${money(grand)} left</span></div>`;

  const next = dates[0];
  html += `<div class="nextup"><span class="grow">Next up · <b>${niceY(next)}</b>
      <span class="sub">${daysTo(next)<0?`${-daysTo(next)}d overdue`:daysTo(next)===0?"today":`in ${daysTo(next)} days`}</span></span>
      <span class="num">${money(totalOf(next))}</span></div>`;

  html += months.map(ym=>{
    const inMonth = dates.filter(d=>d.startsWith(ym));
    const mTotal = r2(inMonth.reduce((s,d)=>s+totalOf(d),0));
    const first = ym+"-01";
    const pad = new Date(first+"T00:00:00").getDay();
    const dim = new Date(+ym.slice(0,4), +ym.slice(5,7), 0).getDate();
    const cells = Array(pad).fill(`<div class="day blank"></div>`);
    for(let n=1; n<=dim; n++){
      const d = dayOf(first,n), hit = byDate.get(d), isToday = d===today();
      if(!hit){
        cells.push(isToday
          ? `<div class="day today"><span class="n">${n}</span><span class="tag">today</span></div>`
          : `<div class="day"><span class="n">${n}</span></div>`);
        continue;
      }
      const cls = ["day","has", daysTo(d)<0?"late":"", isToday?"today":""].filter(Boolean).join(" ");
      // data-day makes the cell tappable — `title` alone is a desktop-only affordance and
      // this is used mostly on a phone.
      cells.push(`<div class="${cls}" role="button" tabindex="0" data-day="${d}"
        title="${hit.map(x=>esc(x.L.label)+" "+money(x.it.amount)).join(" · ")}">
        <span class="n">${n}</span>
        <span class="dots">${hit.map(x=>`<i style="background:${colorOf(x.L)}"></i>`).join("")}</span>
        <span class="a num">${short(totalOf(d))}</span>
        ${isToday?`<span class="tag">today</span>`:""}</div>`);
    }
    return `<div class="mon">
      <div class="monhead"><b class="grow">${monthName(first)}</b><span class="num sub">${money(mTotal)}</span></div>
      <div class="dow"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
      <div class="days">${cells.join("")}</div></div>`;
  }).join("");

  if(beyond.length) html += `<div class="tlfoot"><span class="grow">+ ${beyond.length} more payment${beyond.length>1?"s":""}
      after ${monthName(months[months.length-1]+"-01")}, through ${niceY(beyond[beyond.length-1])}</span>
      <span class="num">${money(r2(beyond.reduce((s,d)=>s+totalOf(d),0)))}</span></div>`;
  $("#timeline").innerHTML = html;
}
