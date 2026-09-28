"use strict";
// Part of Ledger. Loaded as a plain classic script in index.html, in order:
// data -> render -> app. No modules and no build step, so the file still opens from disk.

// ---------- dialog ----------
// Read-only sheet. Clears ask()'s submit handler, or the previous form's callback would
// fire again when this one closes.
function info(title, html){
  const f = $("#dlgForm");
  f.onsubmit = null;
  f.innerHTML = `<h3>${esc(title)}</h3>${html}
    <div class="dact"><button value="cancel" class="btn">Done</button></div>`;
  $("#dlg").showModal();
}

function ask(title, fields, onOk){
  const f = $("#dlgForm");
  f.innerHTML = `<h3>${esc(title)}</h3>` + (fields.hint?`<p class="hint">${fields.hint}</p>`:"") + fields.map(x=>{
    if(x.type==="select") return `<label><span class="eyebrow">${x.label}</span><select name="${x.name}">${
      x.options.map(o=>`<option value="${esc(o.v)}"${String(o.v)===String(x.value)?" selected":""}>${esc(o.t)}</option>`).join("")}</select></label>`;
    // Native colour well and file picker — no dependency, and the OS picker is better
    // than anything worth hand-rolling here.
    if(x.type==="brand") return `<label><span class="eyebrow">${x.label}</span>
      <span class="brandpick">
        <span class="logoprev" id="lp_${x.name}">${x.value?.logo?`<img src="${esc(x.value.logo)}" alt="">`:"&mdash;"}</span>
        <input type="color" name="${x.name}_brand" value="${esc(x.value?.brand || x.value?.fallback || "#0066cc")}" aria-label="Colour">
        <input type="hidden" name="${x.name}_logo" value="${esc(x.value?.logo || "")}">
        <label class="btn mini logobtn">Logo&hellip;<input type="file" accept="image/*" data-logo-for="${x.name}" hidden></label>
        <button type="button" class="btn mini ghost" data-logo-clear="${x.name}">Clear</button>
      </span></label>`;
    return `<label><span class="eyebrow">${x.label}</span><input name="${x.name}" type="${x.type||"text"}"
      ${x.type==="number"?'step="0.01" inputmode="decimal"':""} value="${esc(x.value??"")}" ${x.placeholder?`placeholder="${esc(x.placeholder)}"`:""} ${x.required?"required":""}></label>`;
  }).join("") + `<div class="dact">
      ${fields.del?`<button type="button" id="dlgDel" class="btn ghost bad" style="margin-right:auto">Delete</button>`:""}
      <button type="button" id="dlgCancel" class="btn">Cancel</button><button value="ok" class="btn primary">Save</button></div>`;
  $("#dlg").showModal();
  // Save is deliberately the only submit button left, so a browser's implicit submission
  // (Enter, or an on-screen keyboard's Go key) does the expected thing and still runs
  // required-field validation.
  f.querySelector("#dlgCancel").onclick = () => $("#dlg").close("cancel");
  f.querySelectorAll("[data-logo-for]").forEach(inp=>{
    inp.onchange = async e => {
      const file = e.target.files[0]; if(!file) return;
      try{
        const uri = await shrinkImage(file, 96);
        f.querySelector(`input[name="${inp.dataset.logoFor}_logo"]`).value = uri;
        f.querySelector(`#lp_${inp.dataset.logoFor}`).innerHTML = `<img src="${esc(uri)}" alt="">`;
      } catch(err){ alert(err.message); }
      e.target.value = "";
    };
  });
  f.querySelectorAll("[data-logo-clear]").forEach(b=>{
    b.onclick = () => {
      const n = b.dataset.logoClear;
      f.querySelector(`input[name="${n}_logo"]`).value = "";
      f.querySelector(`#lp_${n}`).innerHTML = "&mdash;";
    };
  });
  const del = f.querySelector("#dlgDel");
  if(del) del.onclick = () => {
    if(!confirm(typeof fields.del === "string" ? fields.del : "Delete this? It cannot be undone.")) return;
    const data = Object.fromEntries(new FormData(f));
    $("#dlg").close("del");
    setTimeout(()=>onOk("del", data), 0);
  };
  f.onsubmit = () => { const data = Object.fromEntries(new FormData(f));
    setTimeout(()=>onOk($("#dlg").returnValue, data),0); };
}
const loanOptions = () => [{v:"",t:"— not linked —"},{v:"income",t:"Allowance pool (money comes from here)"},
  ...S.loans.map(L=>({v:L.id,t:`${L.provider} · ${L.label}`}))];

// Balances are edited in place on the number itself. Enter or tapping away saves, Escape
// backs out, and an empty or unreadable entry changes nothing rather than zeroing a wallet.
function editBalance(btn){
  const a = acc(btn.dataset.bal); if(!a) return;
  const inp = document.createElement("input");
  inp.type = "number"; inp.step = "0.01"; inp.inputMode = "decimal";
  inp.className = "balin num"; inp.value = a.bal;
  inp.setAttribute("aria-label", `New balance for ${a.name}`);
  btn.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = keep => {
    if(done) return; done = true;
    const raw = inp.value.trim(), v = r2(raw);
    if(keep && raw !== "" && Number.isFinite(Number(raw)) && v !== a.bal){
      logIt(`${a.name}: ${money(a.bal)} → ${money(v)}`);
      a.bal = v;
      return render();
    }
    // Nothing changed: put the number back without redrawing the page. A redraw here would
    // replace the very balance you tapped next, and that tap would be lost.
    if(inp.isConnected) inp.replaceWith(btn);
  };
  inp.onkeydown = e => {
    if(e.key === "Enter"){ e.preventDefault(); finish(true); }
    else if(e.key === "Escape"){ e.preventDefault(); finish(false); }
  };
  inp.onblur = () => finish(true);
}

// ---------- your QR, and the image that carries it ----------
// Reads a QR out of a screenshot. Screenshots are tried small first, which is fast and finds a
// large code easily, then full size for a code that is small in the frame; both polarities,
// since a dark-mode wallet app draws it light-on-dark.
async function decodeQrImage(file){
  await loadScript(QR_DECODER);
  const url = URL.createObjectURL(file);
  try{
    const img = await new Promise((res, rej) => { const i = new Image();
      i.onload = () => res(i); i.onerror = () => rej(new Error("Could not read that image.")); i.src = url; });
    for(const max of [900, 1800, Infinity]){
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width*k)); c.height = Math.max(1, Math.round(img.height*k));
      const g = c.getContext("2d", {willReadFrequently:true});
      g.drawImage(img, 0, 0, c.width, c.height);
      const hit = jsQR(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, {inversionAttempts:"attemptBoth"});
      if(hit?.data) return hit.data;
      if(k === 1) break;
    }
  } finally { URL.revokeObjectURL(url); }
  throw new Error("Couldn't find a QR code in that image. Try a screenshot where the code is fully visible.");
}

function openMyQr(){
  const has = !!S.me?.qr;
  info("Your payment QR", `
    <p class="hint">Upload a screenshot of your receive-money QR from GCash, Maya or your bank. Only the code itself is kept: it is read out of the image, stored as a short piece of text in your own data, and redrawn to match the app on every image you send.</p>
    <div class="qrbox" id="qrBox">${has ? "" : `<span class="sub">No QR yet</span>`}</div>
    ${has ? `<label><span class="eyebrow">Name shown on the image</span>
      <input id="qrName" value="${esc(S.me.name || "")}" placeholder="${esc(qrPayee(S.me.qr) || "Your name")}"></label>` : ""}
    <div class="dact" style="justify-content:flex-start;margin-bottom:10px">
      <label class="btn${has?"":" primary"}" style="margin:0">${has ? "Replace" : "Upload screenshot"}<input type="file" accept="image/*" id="qrFile" hidden></label>
      ${has ? `<button type="button" class="btn ghost bad" id="qrRemove">Remove</button>` : ""}
    </div>`);
  if(has) qrMatrix(S.me.qr).then(m => {
    const c = document.createElement("canvas"); c.width = c.height = 440;
    paintQr(c.getContext("2d"), m, 0, 0, 440);
    const box = $("#qrBox"); if(box) box.replaceChildren(c);
  }).catch(err => { const box = $("#qrBox"); if(box) box.textContent = err.message; });
  $("#qrFile").onchange = async e => {
    const file = e.target.files[0]; if(!file) return;
    const box = $("#qrBox"); if(box) box.innerHTML = `<span class="sub">Reading…</span>`;
    try{
      const text = await decodeQrImage(file);
      S.me = {qr:text, name:S.me?.name || ""};
      logIt("Payment QR updated"); render(); openMyQr();
    } catch(err){ if(box) box.innerHTML = `<span class="sub bad">${esc(err.message)}</span>`; }
  };
  const nameIn = $("#qrName");
  if(nameIn) nameIn.onchange = () => { S.me.name = nameIn.value.trim(); render(); };
  const rm = $("#qrRemove");
  if(rm) rm.onclick = () => { if(!confirm("Remove your payment QR from the app?")) return;
    S.me = null; logIt("Payment QR removed"); render(); openMyQr(); };
}

// Makes the image, previews it, and hands it to the phone's share sheet (Messenger, Viber,
// Photos …). Where sharing files is not supported it falls back to saving the image.
async function shareOwed(personId){
  const who = person(personId); if(!who) return;
  let cv;
  try{ cv = await drawOwedImage(personId); } catch(err){ return alert(err.message); }
  const blob = await new Promise(res => cv.toBlob(res, "image/png"));
  const name = `${who.name.replace(/[^\w-]+/g, "-")}-owes.png`;
  const file = new File([blob], name, {type:"image/png"});
  const url = URL.createObjectURL(blob);
  const canShare = !!navigator.canShare?.({files:[file]});
  info(`What ${who.name} owes`, `
    ${S.me?.qr ? "" : `<p class="hint">Add your payment QR and it goes on the image too.</p>`}
    <img class="sharepreview" src="${url}" alt="Summary of what ${esc(who.name)} owes">
    <div class="dact" style="justify-content:flex-start;margin-bottom:10px">
      ${canShare ? `<button type="button" class="btn primary" id="shareGo">Share</button>` : ""}
      <a class="btn${canShare ? "" : " primary"}" href="${url}" download="${esc(name)}">Save image</a>
      <button type="button" class="btn ghost" id="shareQr">${S.me?.qr ? "Change QR" : "Add your QR"}</button>
    </div>`);
  $("#dlg").addEventListener("close", () => URL.revokeObjectURL(url), {once:true});
  const go = $("#shareGo");
  if(go) go.onclick = () => navigator.share({files:[file], title:`What ${who.name} owes`}).catch(()=>{});
  $("#shareQr").onclick = openMyQr;
}

// When the purchase a debt points at is deleted, the debt keeps what it was worth and what it
// was for — otherwise a derived debt would fall back to its stored amount, often zero.
function keepAmountAndUnlink(o){
  o.amount = owedAmount(o); o.note = owedLabel(o) || o.note;
  o.loanId = ""; o.purchaseId = ""; o.share = 1;
}

// ---------- purchases not on a card ----------
const buyFields = b => [
  {name:"label",label:"What was it",value:b?.label ?? "",required:1},
  {name:"amount",label:"How much",type:"number",value:b?.amount ?? "",required:1},
  {name:"date",label:"Date",type:"date",value:b?.date ?? today(),required:1},
  {name:"via",label:"Paid with",value:b?.via ?? "",placeholder:"Cash, GCash, bank transfer…"},
];
$("#addBuy").onclick = ()=>{
  const f = buyFields(null);
  f.hint = "A record only — it does not change any wallet. Link a debt to it and the amount and split come from here.";
  ask("New purchase", f, (v,d)=>{ if(v!=="ok") return;
    const amt = r2(d.amount); if(!(amt > 0)) return;
    S.buys.push({id:uid(), label:d.label, amount:amt, date:d.date||today(), via:(d.via||"").trim()});
    logIt(`Logged ${d.label} ${money(amt)}`); render(); });
};
$("#myQrBtn").onclick = openMyQr;

// ---------- welcome ----------
$("#wStart").onclick = ()=>{ S = starter(); logIt("Started a new ledger"); render(); };
$("#wDemo").onclick  = ()=>{ S = demoData(); render(); };
$("#wImport").onclick = ()=> $("#importFile").click();
$("#wSync").onclick = setupSync;
$("#syncBtn").onclick = setupSync;
$("#undoBtn").onclick = undo;
$("#assumeChk").onchange = e => { S.assumePaid = e.target.checked; render(); };

// ---------- actions ----------
$("#addAcc").onclick = ()=> addSection(mainAcc()?.id);
function addSection(parentId){
  const p = acc(parentId);
  if(!p) return alert("Add a wallet first.");
  const f = [{name:"name",label:"Name",required:1},
             {name:"loanId",label:"What it is for",type:"select",options:loanOptions()},
             {name:"bal",label:"Starting balance",type:"number",value:"0"}];
  f.hint = `Sections live inside ${p.name} and hold money the main wallet cannot spend.`;
  ask(`New section under ${p.name}`, f, (v,d)=>{ if(v!=="ok") return;
    S.accounts.push({id:uid(), parent:p.id, name:d.name, kind:p.kind, bal:r2(d.bal), loanId:d.loanId});
    logIt(`Added section ${d.name}`); render(); });
}

// Every purchase you could have fronted, as "sourceId:purchaseId" so one select carries both
// halves of the link — card purchases first, then the ones made outside a card.
const purchaseOptions = () => [{v:"",t:"— not linked to a purchase —"},
  ...S.loans.filter(isCard).flatMap(L => (L.purchases||[]).filter(pu => !pu.carry)
    .slice().sort((a,b)=> a.date<b.date?1:-1)
    .map(pu => ({v:`${L.id}:${pu.id}`, t:`${L.label} · ${pu.label} · ${money(pu.amount)} · ${nice(pu.date)}`}))),
  ...[...S.buys].sort((a,b)=> a.date<b.date?1:-1)
    .map(b => ({v:`${BUYS_ID}:${b.id}`, t:`${b.via || "Paid directly"} · ${b.label} · ${money(b.amount)} · ${nice(b.date)}`}))];
// The purchase a "sourceId:purchaseId" value points at, from either kind of source.
const purchaseFromValue = v => {
  const {loanId, purchaseId} = splitPur(v);
  if(!purchaseId) return null;
  if(loanId === BUYS_ID) return S.buys.find(b => b.id === purchaseId) || null;
  const L = loan(loanId);
  return L && isCard(L) ? (L.purchases||[]).find(x => x.id === purchaseId) || null : null;
};

const owedFields = o => [
  {name:"personId",label:"Who owes you",type:"select",value:o?.personId ?? "",
   options:[{v:"",t:"— someone new —"}, ...S.people.map(x=>({v:x.id,t:x.name}))]},
  {name:"newName",label:"Their name",value:""},
  {name:"pur",label:"Linked to one of your purchases",type:"select",options:purchaseOptions(),
   value: o?.purchaseId ? `${o.loanId}:${o.purchaseId}` : ""},
  {name:"share",label:"How much of it is theirs",type:"select",
   options:SHARES.map(x=>({v:x.v,t:x.t})), value: o ? shareOf(o) : 1},
  {name:"amount",label:"How much",type:"number",value:o?.amount ?? ""},
  {name:"note",label:"What for",value:o?.note ?? ""},
];
const splitPur = v => { const [loanId, purchaseId] = String(v||"").split(":"); return {loanId:loanId||"", purchaseId:purchaseId||""}; };

// Picking a purchase fills the amount and description from it and locks both — a linked
// debt IS the purchase, so letting the two be edited apart invites drift. Fields that do not
// apply are hidden rather than greyed out: the name box only matters for someone new, and
// a share only means anything against a purchase.
function wireOwedDialog(){
  const f = $("#dlgForm");
  const pur = f.querySelector('select[name="pur"]');
  const share = f.querySelector('select[name="share"]');
  const amt = f.querySelector('input[name="amount"]');
  const note = f.querySelector('input[name="note"]');
  const who = f.querySelector('select[name="personId"]');
  const nm  = f.querySelector('input[name="newName"]');
  const sync = ()=>{
    const bought = purchaseFromValue(pur.value);
    const sh = Number(share.value);
    share.closest("label").hidden = !bought;
    const derived = !!bought && sh > 0;
    amt.readOnly = derived;
    amt.classList.toggle("locked", derived);
    note.readOnly = !!bought;
    note.classList.toggle("locked", !!bought);
    if(bought){
      note.value = bought.label;
      if(derived) amt.value = r2(bought.amount * sh);
    }
    nm.closest("label").hidden = !!who.value;
  };
  pur.onchange = sync; share.onchange = sync; who.onchange = sync; sync();
}
// Resolves the person select plus the "someone new" box down to a single profile id,
// reusing an existing profile when the typed name already matches one.
function resolvePerson(d){
  if(d.personId && person(d.personId)) return d.personId;
  const nm = String(d.newName || "").trim() || "Someone";
  const existing = S.people.find(x => x.name.toLowerCase() === nm.toLowerCase());
  if(existing) return existing.id;
  const made = {id:uid(), name:nm, brand:""};
  S.people.push(made);
  return made.id;
}

$("#addOwed").onclick = ()=>{
  const f = owedFields(null);
  f.hint = "Link the purchase if you paid for it — the amount and what it was for then come straight from it. If you only covered part of a shared bill, set their share.";
  ask("Someone owes you", f, (v,d)=>{ if(v!=="ok") return;
    const link = splitPur(d.pur), amt = r2(d.amount);
    if(!link.purchaseId && !(amt > 0))
      return alert("Enter an amount, or link the purchase it was for.");
    const personId = resolvePerson(d);
    const row = {id:uid(), personId, amount:amt, note:d.note||"",
                 share: link.purchaseId ? Number(d.share) : 1, ...link, settled:false};
    S.owed.push(row);
    logIt(`${person(personId).name} owes you ${money(owedAmount(row))}`); render(); });
  wireOwedDialog();
};

const wishFields = w => [
  {name:"name",label:"What is it",value:w?.name ?? "",required:1},
  {name:"cost",label:"How much does it cost",type:"number",value:w?.cost ?? "",required:1},
  {name:"helpPct",label:"Someone else is covering (%)",type:"number",value:w?.helpPct ?? "0"},
  {name:"bd",label:"Colour and logo",type:"brand",value:{brand:w?.brand, logo:w?.logo, fallback:"#0066cc"}},
];
$("#addWish").onclick = ()=>{
  const f = wishFields(null);
  f.hint = "Progress is measured against everything across all your wallets. If somebody else is putting in part of the price, say what share and only the rest counts as yours to find.";
  ask("Add to the wishlist", f, (v,d)=>{ if(v!=="ok") return;
    S.wish.push({id:uid(), name:d.name, cost:r2(d.cost), helpPct:r2(d.helpPct)||0,
                 brand:d.bd_brand||"", logo:d.bd_logo||""});
    logIt(`Added ${d.name} to the wishlist`); render(); });
};

const lenderField = L => ({name:"lender",label:"Who lent it",type:"select",value:L?.fromPerson?"person":"app",
  options:[{v:"app",t:"A lending app or bank"},{v:"person",t:"A person (no interest)"}]});
// The one figure the interest is worked out from — a schedule alone cannot say how much of it
// is interest. Asked for only when editing, so adding a loan stays short.
const principalField = L => ({name:"principal",label:"How much you borrowed (to show the interest)",type:"number",
  value: L?.principal || ""});
// A loan from a person carries no interest, so the amount borrowed means nothing there.
function wireLoanDialog(){
  const f = $("#dlgForm"), lender = f.querySelector('select[name="lender"]');
  const pr = f.querySelector('input[name="principal"]');
  if(!pr) return;
  const sync = ()=>{ pr.closest("label").hidden = lender.value === "person"; };
  lender.onchange = sync; sync();
}

$("#addLoan").onclick = ()=>{
  const f = [lenderField(null),
    {name:"provider",label:"Lender's name",value:"",required:1},
    {name:"label",label:"What for",required:1},
    {name:"ref",label:"Reference #",value:""},
    {name:"freq",label:"Schedule",type:"select",options:[{v:"week",t:"Every week"},{v:"2weeks",t:"Every 2 weeks"},{v:"month",t:"Every month"}],value:"week"},
    {name:"amount",label:"Amount per instalment",type:"number",required:1},
    {name:"count",label:"How many instalments",type:"number",value:"4",required:1},
    {name:"start",label:"First due date",type:"date",value:today(),required:1}];
  ask("New loan", f, (v,d)=>{ if(v!=="ok") return;
    const fromPerson = d.lender === "person";
    S.loans.push({id:uid(), provider:d.provider||(fromPerson?"A friend":"Loan"), label:d.label, ref:d.ref, freq:d.freq,
                  fromPerson, principal:0, items:gen(d.start, +d.count, d.freq, +d.amount)});
    logIt(`Added loan ${d.label}${fromPerson?` from ${d.provider}`:""}`); render(); });
};

$("#addCard").onclick = ()=> ask("New credit card",[
  {name:"provider",label:"Issuer",value:"Atome"},
  {name:"label",label:"Card name",value:"Card",required:1},
  {name:"limit",label:"Credit limit",type:"number",required:1},
  {name:"sDay",label:"Billed on day of month",type:"number",value:"9",required:1},
  {name:"dDay",label:"Due on day of month",type:"number",value:"19",required:1}],
  (v,d)=>{ if(v!=="ok") return;
    S.loans.push(rebuildCard({id:uid(), provider:d.provider||"Card", label:d.label, ref:"", freq:"card",
      limit:r2(d.limit), sDay:+d.sDay, dDay:+d.dDay, items:[], purchases:[]}));
    logIt(`Added card ${d.label}`); render(); });

$("#addPurchase").onclick = ()=>{
  const cards = S.loans.filter(isCard);
  if(!cards.length) return alert("Add a card first.");
  ask("New purchase",[
    ...(cards.length>1?[{name:"card",label:"Card",type:"select",options:cards.map(c=>({v:c.id,t:c.label}))}]:[]),
    {name:"label",label:"What did you buy",required:1},
    {name:"amount",label:"Amount",type:"number",required:1},
    {name:"date",label:"Date",type:"date",value:today(),required:1}],
    (v,d)=>{ if(v!=="ok") return;
      const L = cards.length>1 ? loan(d.card) : cards[0], amt = r2(d.amount);
      if(amt > available(L) && !confirm(`That is ${money(r2(amt-available(L)))} over the available credit. Add anyway?`)) return;
      L.purchases.push({id:uid(), date:d.date, label:d.label, amount:amt});
      rebuildCard(L);
      logIt(`${L.provider}: ${d.label} ${money(amt)} · due ${niceY(cycleFor(d.date,L.sDay,L.dDay).due)}`);
      render(); });
};

// Returns a recorded payment to the wallet it came from. Silent when the wallet has since
// been deleted or the row predates payment tracking — there is nowhere to put it back.
function refund(it, what){
  const src = it.paidFrom && acc(it.paidFrom);
  const amt = r2(it.paidAmt);
  if(src && amt > 0){
    src.bal = r2(src.bal + amt);
    logIt(`Returned ${money(amt)} to ${src.name} — ${what} marked unpaid`);
  }
  delete it.paidFrom; delete it.paidAmt;
}

function reorder(id, dir){
  const a = acc(id), sibs = kidsOf(a.parent);
  const at = sibs.indexOf(a), to = at + dir;
  if(to < 0 || to >= sibs.length) return;
  const i = S.accounts.indexOf(a), j = S.accounts.indexOf(sibs[to]);
  S.accounts[i] = sibs[to]; S.accounts[j] = a;
  render();
}

document.body.addEventListener("click", e=>{
  const t = e.target.closest("[data-bal],[data-edit-acc],[data-add-kid],[data-mv],[data-unpay],[data-edit-inst],[data-extend],[data-edit-pur],[data-pay-card],[data-unpay-card],[data-edit-card],[data-link],[data-allowance-claimed],[data-day],[data-edit-wish],[data-edit-owed],[data-owed-settle],[data-edit-person],[data-mark-paid],[data-mark-card],[data-edit-loan],[data-owed-unsettle],[data-share-owed],[data-edit-buy]");
  if(!t) return;
  const pick = k => { const [id,i] = (t.dataset[k]||"").split(":"); return [loan(id), +i]; };
  const pickCard = k => { const [id,key] = (t.dataset[k]||"").split(":"); return [loan(id), key]; };
  e.preventDefault();

  if(t.dataset.bal) return editBalance(t);
  if(t.dataset.shareOwed) return shareOwed(t.dataset.shareOwed);
  if(t.dataset.editBuy){
    const b = S.buys.find(x => x.id === t.dataset.editBuy); if(!b) return;
    const linked = S.owed.filter(o => o.loanId === BUYS_ID && o.purchaseId === b.id);
    const f = buyFields(b);
    f.del = linked.length
      ? `Delete ${b.label}? ${plural(linked.length, "debt")} linked to it will keep their amount but lose the link.`
      : `Delete ${b.label}?`;
    return ask("Edit purchase", f, (v,d)=>{
      if(v==="del"){
        // Keep what they owe: the amount is copied onto the debt before the link goes.
        for(const o of linked) keepAmountAndUnlink(o);
        S.buys = S.buys.filter(x => x.id !== b.id);
        logIt(`Removed ${b.label}`); return render();
      }
      if(v!=="ok") return;
      b.label = d.label; b.amount = r2(d.amount); b.date = d.date || b.date; b.via = (d.via||"").trim();
      render(); });
  }

  // Pick the funding wallet from the loan's own side. One wallet per loan, so linking moves it.
  if(t.dataset.link){
    const L = loan(t.dataset.link), cur = envelopeFor(L.id);
    const pickable = kidsOf(mainAcc()?.id).filter(a=>a.loanId!=="income");
    if(!pickable.length) return alert("Add a section under your main wallet first.");
    ask(`Which wallet pays ${L.label}?`,[{name:"env",label:"Section",type:"select",value:cur?.id||"",
      options:[{v:"",t:"— none, pays from the main wallet —"},
        ...pickable.map(a=>({v:a.id, t:`${a.name} (${money(a.bal)})${a.loanId&&a.loanId!==L.id?" — taken by "+(loan(a.loanId)?.label||"?"):""}`}))]}],
      (v,d)=>{ if(v!=="ok") return;
        S.accounts.forEach(a=>{ if(a.loanId===L.id) a.loanId=""; });
        if(d.env){ acc(d.env).loanId = L.id; logIt(`${acc(d.env).name} now funds ${L.label}`); }
        else logIt(`${L.label} unlinked`);
        render(); });
  }

  if(t.dataset.day){
    const d = t.dataset.day, hit = dues(9999).filter(x=>x.it.due===d);
    info(niceY(d), hit.map(x=>`<div class="wkl">
        <span class="t"><span class="dot" style="background:${colorOf(x.L)};display:inline-block;vertical-align:middle;margin-right:8px"></span>${esc(x.L.provider)} · ${esc(x.L.label)}</span>
        <span class="m num">${money(x.it.amount)}</span></div>`).join("")
      + `<div class="grand"><span class="grow eyebrow">Total · ${hit.length} payment${hit.length>1?"s":""}</span>
         <span class="num" style="font-size:19px;font-weight:600">${money(r2(hit.reduce((s,x)=>s+x.it.amount,0)))}</span></div>`);
  }

  if(t.dataset.editOwed){
    const o = S.owed.find(x=>x.id===t.dataset.editOwed); if(!o) return;
    const f = owedFields(o);
    f.del = `Delete the ${money(owedAmount(o))} ${person(o.personId)?.name || "someone"} owes you?`;
    ask("Edit debt", f, (v,d)=>{
      if(v==="del"){ S.owed = S.owed.filter(x=>x.id!==o.id); logIt("Removed a debt"); return render(); }
      if(v!=="ok") return;
      const link = splitPur(d.pur), amt = r2(d.amount);
      if(!link.purchaseId && !(amt > 0))
        return alert("Enter an amount, or link the purchase it was for.");
      o.personId = resolvePerson(d); o.amount = amt; o.note = d.note||"";
      o.share = link.purchaseId ? Number(d.share) : 1;
      Object.assign(o, link);
      render(); });
    wireOwedDialog();
  }
  if(t.dataset.editPerson){
    const who = person(t.dataset.editPerson); if(!who) return;
    const mine = S.owed.filter(o=>o.personId===who.id);
    const f = [{name:"name",label:"Name",value:who.name,required:1},
               {name:"bd",label:"Colour",type:"brand",value:{brand:who.brand, fallback:"#0066cc"}}];
    f.del = `Delete ${who.name} and the ${mine.length} debt${mine.length===1?"":"s"} recorded against them?`;
    ask("Edit "+who.name, f, (v,d)=>{
      if(v==="del"){
        S.people = S.people.filter(x=>x.id!==who.id);
        S.owed = S.owed.filter(o=>o.personId!==who.id);
        logIt(`Removed ${who.name}`); return render();
      }
      if(v!=="ok") return;
      who.name = d.name; who.brand = d.bd_brand||"";
      render(); });
  }
  // Marks it repaid without moving money, matching how wallet balances are kept by hand.
  if(t.dataset.owedSettle){
    const o = S.owed.find(x=>x.id===t.dataset.owedSettle); if(!o) return;
    o.settled = true; o.settledOn = today();
    logIt(`${person(o.personId)?.name || "Someone"} paid back ${money(owedAmount(o))}`); render();
  }

  if(t.dataset.owedUnsettle){
    const o = S.owed.find(x=>x.id===t.dataset.owedUnsettle); if(!o) return;
    o.settled = false; delete o.settledOn;
    logIt(`${money(owedAmount(o))} from ${person(o.personId)?.name || "someone"} is owed again`); render();
  }

  if(t.dataset.editWish){
    const w = S.wish.find(x=>x.id===t.dataset.editWish); if(!w) return;
    const f = wishFields(w);
    f.del = `Remove ${w.name} from the wishlist?`;
    ask("Edit "+w.name, f, (v,d)=>{
      if(v==="del"){ S.wish = S.wish.filter(x=>x.id!==w.id); logIt(`Removed ${w.name} from the wishlist`); return render(); }
      if(v!=="ok") return;
      w.name=d.name; w.cost=r2(d.cost); w.helpPct=r2(d.helpPct)||0;
      w.brand=d.bd_brand||""; w.logo=d.bd_logo||"";
      render(); });
  }
  if(t.dataset.addKid) addSection(t.dataset.addKid);
  if(t.dataset.mv){ const [id,dir] = t.dataset.mv.split(":"); reorder(id, +dir); }

  if(t.dataset.editCard){
    const L = loan(t.dataset.editCard);
    const f = [{name:"label",label:"Name",value:L.label},
      {name:"limit",label:"Credit limit",type:"number",value:L.limit},
      {name:"sDay",label:"Billed on day",type:"number",value:L.sDay},
      {name:"dDay",label:"Due on day",type:"number",value:L.dDay},
      {name:"bd",label:"Card colour and logo",type:"brand",
       value:{brand:L.brand, logo:L.logo, fallback:brandOf(L)}}];
    f.del = `Delete ${L.label} and every purchase on it?`;
    ask("Edit "+L.label, f, (v,d)=>{
      if(v==="del"){
        for(const o of S.owed) if(o.loanId===L.id) keepAmountAndUnlink(o);   // before the card goes
        S.loans = S.loans.filter(x=>x.id!==L.id);
        S.accounts.forEach(a=>{ if(a.loanId===L.id) a.loanId=""; });
        return render(); }
      if(v!=="ok") return;
      L.label=d.label; L.limit=r2(d.limit); L.sDay=+d.sDay; L.dDay=+d.dDay;
      L.brand=d.bd_brand||""; L.logo=d.bd_logo||"";
      rebuildCard(L); render(); });
  }

  if(t.dataset.editPur){
    const [L,pid] = pickCard("editPur"), p = L.purchases.find(x=>x.id===pid);
    const f = [{name:"label",label:"What",value:p.label},{name:"amount",label:"Amount",type:"number",value:p.amount},
               {name:"date",label:"Date",type:"date",value:p.date}];
    f.del = `Delete the purchase "${p.label}" for ${money(p.amount)}?`;
    ask("Edit purchase", f, (v,d)=>{
      if(v==="del"){
        for(const o of S.owed) if(o.loanId===L.id && o.purchaseId===pid) keepAmountAndUnlink(o);   // before it goes
        L.purchases = L.purchases.filter(x=>x.id!==pid);
        rebuildCard(L); return render();
      }
      if(v!=="ok") return;
      p.label=d.label; p.amount=r2(d.amount); p.date=d.date; rebuildCard(L); render(); });
  }

  if(t.dataset.payCard){
    // Records a payment smaller than the statement; nothing is taken from any wallet, since
    // balances are kept by hand. The remainder rolls into the next cycle as a purchase.
    const [L,due] = pickCard("payCard"), it = L.items.find(i=>i.due===due);
    const f = [{name:"amount",label:"How much you paid",type:"number",value:it.amount,required:1}];
    f.hint = `The statement is ${money(it.amount)}. Whatever you did not pay carries to the next cycle.`;
    ask(`Paid part of ${L.label} · ${niceY(it.due)}`, f, (v,dd)=>{ if(v!=="ok") return;
      const amt = r2(dd.amount), rest = r2(it.amount - amt);
      if(!(amt > 0)) return;
      it.paid = true;
      if(rest > 0){
        const carryId = uid();
        L.purchases.push({id:carryId, date:addDays(it.due,1), label:`Carried from ${nice(it.due)}`, amount:rest, carry:true});
        it.carryId = carryId;   // removed again if this payment is undone
        logIt(`${L.label}: ${money(rest)} carried to the next cycle`);
      }
      logIt(`Paid ${money(amt)} of ${L.label} ${niceY(it.due)}`);
      rebuildCard(L); render(); });
  }
  if(t.dataset.unpayCard){
    const [L,due] = pickCard("unpayCard"), it = L.items.find(i=>i.due===due);
    if(!it) return;
    refund(it, `${L.label} ${niceY(it.due)}`);
    // A partial payment pushed the remainder forward as a purchase; undoing the payment
    // has to take that back out, or the balance is counted twice.
    if(it.carryId){ L.purchases = L.purchases.filter(x=>x.id!==it.carryId); delete it.carryId; }
    it.paid = false; rebuildCard(L); render();
  }

  // Paid somewhere else already: record it and move no money. The wallet figures are kept
  // by hand, so deducting here would take the same payment out twice.
  if(t.dataset.markPaid){
    const [L,i] = pick("markPaid"), it = L.items[i]; if(!it) return;
    it.paid = true;
    logIt(`Marked ${L.label} ${niceY(it.due)} paid (${money(it.amount)})`); render();
  }
  if(t.dataset.markCard){
    const [L,due] = pickCard("markCard"), it = L.items.find(i=>i.due===due); if(!it) return;
    it.paid = true; rebuildCard(L);
    logIt(`Marked ${L.label} statement ${niceY(due)} paid (${money(it.amount)})`); render();
  }
  if(t.dataset.editLoan){
    const L = loan(t.dataset.editLoan); if(!L) return;
    const f = [lenderField(L),
      {name:"provider",label:"Lender's name",value:L.provider,required:1},
      {name:"label",label:"What for",value:L.label,required:1},
      {name:"ref",label:"Reference #",value:L.ref||""},
      principalField(L)];
    f.hint = `The schedule adds up to ${money(loanScheduled(L))}. Say how much you borrowed and the difference is the interest.`;
    f.del = `Delete ${L.provider} · ${L.label} and its whole schedule?`;
    ask("Edit "+L.label, f, (v,d)=>{
      if(v==="del"){
        S.loans = S.loans.filter(x=>x.id!==L.id);
        S.accounts.forEach(a=>{ if(a.loanId===L.id) a.loanId=""; });
        logIt(`Deleted loan ${L.label}`); return render();
      }
      if(v!=="ok") return;
      L.fromPerson = d.lender === "person";
      L.provider = d.provider; L.label = d.label; L.ref = d.ref;
      L.principal = L.fromPerson ? 0 : (r2(d.principal)||0);
      render(); });
    wireLoanDialog();
  }

  if(t.dataset.editAcc){
    const a = acc(t.dataset.editAcc), kids = kidsOf(a.id), isAllowanceAcc = a.loanId==="income";
    const f = [{name:"name",label:"Name",value:a.name},
               {name:"bal",label:"Balance",type:"number",value:a.bal},
               {name:"bd",label:"Colour and logo",type:"brand",
                value:{brand:a.brand, logo:a.logo, fallback:brandOf(a)}}];
    if(a.parent) f.splice(1,0,{name:"loanId",label:"What it is for",type:"select",options:loanOptions(),value:a.loanId});
    if(isAllowanceAcc) f.push(
      {name:"aday",label:"Allowance day",type:"select",value:S.allowance?.weekday ?? "",
        options:[{v:"",t:"— not scheduled —"},...WEEKDAYS.map((w,i)=>({v:i,t:"Every "+w}))]},
      {name:"aamt",label:"Allowance amount",type:"number",value:S.allowance?.amount ?? ""});
    f.del = kids.length
      ? `Delete ${a.name} and its ${kids.length} section${kids.length>1?"s":""}? This cannot be undone.`
      : `Delete ${a.name}? Its ${money(a.bal)} balance goes with it and this cannot be undone.`;
    ask("Edit "+a.name, f, (v,d)=>{
      if(v==="del"){
        S.accounts = S.accounts.filter(x=>x.id!==a.id && x.parent!==a.id);
        logIt(`Removed ${a.name}`); return render();
      }
      if(v!=="ok") return;
      if(r2(d.bal)!==a.bal) logIt(`${a.name}: ${money(a.bal)} → ${money(r2(d.bal))}`);
      a.name=d.name; a.bal=r2(d.bal); if("loanId" in d) a.loanId=d.loanId;
      a.brand=d.bd_brand||""; a.logo=d.bd_logo||"";
      if(isAllowanceAcc){
        // A brand-new schedule set mid-week must not immediately offer the occurrence that
        // already passed — that money is either already in the balance or was never coming.
        // Setting one up ON the day is left unclaimed, since it may still be owed.
        let seed = S.allowance?.lastAdded || "";
        if(!S.allowance && d.aday !== ""){
          const prev = allowanceDateFor(Number(d.aday));
          if(prev !== today()) seed = prev;
        }
        const next = normAllowance({weekday:d.aday, amount:d.aamt, lastAdded:seed});
        if(next){ S.allowance = next; logIt(`Allowance set: ${money(next.amount)} every ${WEEKDAYS[next.weekday]}`); }
        else if(S.allowance){ S.allowance = null; logIt("Allowance schedule cleared"); }
      }
      render(); });
  }
  // Marks the week handled without touching the balance — the usual case, because the
  // wallet figure is edited by hand when the money actually lands.
  if(t.hasAttribute("data-allowance-claimed") && S.allowance){
    S.allowance.lastAdded = today();
    logIt(`Marked this week's allowance as received`); render();
  }
  // Payments are recorded without touching wallets now, but anything paid through the old
  // Pay flow still carries where its money came from, so undoing it still gives that back.
  if(t.dataset.unpay){
    const [L,i] = pick("unpay"), it = L.items[i];
    refund(it, `${L.label} ${niceY(it.due)}`);
    it.paid = false; render();
  }
  if(t.dataset.editInst){
    const [L,i] = pick("editInst"), it = L.items[i];
    const f = [{name:"due",label:"Due date",type:"date",value:it.due},{name:"amount",label:"Amount",type:"number",value:it.amount}];
    f.del = `Delete the ${money(it.amount)} instalment due ${niceY(it.due)}?`;
    ask("Edit instalment", f, (v,d)=>{
      if(v==="del"){ L.items.splice(i,1); return render(); }
      if(v!=="ok") return;
      it.due = d.due; it.amount = r2(d.amount);
      L.items.sort((a,b)=> a.due<b.due?-1:1); render(); });
  }
  if(t.dataset.extend){
    const L = loan(t.dataset.extend), last = L.items[L.items.length-1];
    if(!last) return alert("Nothing to extend from.");
    ask("Extend "+L.label,[{name:"count",label:"Add how many",type:"number",value:"4",required:1},
                           {name:"amount",label:"Amount each",type:"number",value:last.amount}],
      (v,d)=>{ if(v!=="ok") return;
        const from = L.freq==="week" ? addDays(last.due,7) : L.freq==="2weeks" ? addDays(last.due,14) : addMonths(last.due,1);
        L.items.push(...gen(from, +d.count, L.freq, +d.amount)); render(); });
  }
});


$("#horizon").onchange = renderPlan;
$("#tlFilter").onchange = renderTimeline;
$("#clearLog").onclick = ()=>{ S.log=[]; render(); };
$("#exportBtn").onclick = ()=>{
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(S,null,2)],{type:"application/json"}));
  a.download = `ledger-${today()}.json`; a.click(); URL.revokeObjectURL(a.href);
};
// One-time .ics with every unpaid due date + a day-before alarm. Import it into Calendar
// once and every due date shows up on iPhone, iPad, and Apple Watch — no app needed.
// Not a live feed (there's no server to host one): re-export and re-import after changes.
const icsEsc = s => String(s).replace(/[\\;,]/g, m=>"\\"+m);
$("#icsBtn").onclick = ()=>{
  const rows = dues(9999);
  if(!rows.length) return alert("Nothing scheduled to export.");
  const stamp = new Date().toISOString().replace(/[-:]/g,"").split(".")[0]+"Z";
  const lines = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Ledger//EN","CALSCALE:GREGORIAN"];
  for(const {L,it} of rows) lines.push(
    "BEGIN:VEVENT",
    `UID:${L.id}-${it.due}@ledger.local`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${it.due.replace(/-/g,"")}`,
    `SUMMARY:${icsEsc(L.provider)} ${icsEsc(L.label)} — ${icsEsc(money(it.amount))}`,
    "BEGIN:VALARM","ACTION:DISPLAY","DESCRIPTION:Payment due","TRIGGER:-P1D","END:VALARM",
    "END:VEVENT");
  lines.push("END:VCALENDAR");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], {type:"text/calendar"}));
  a.download = "ledger-payments.ics"; a.click(); URL.revokeObjectURL(a.href);
};
$("#importBtn").onclick = ()=> $("#importFile").click();
$("#importFile").onchange = async e=>{
  const f = e.target.files[0]; if(!f) return;
  try{ const s = JSON.parse(await f.text());
       if(!Array.isArray(s.accounts)) throw new Error("this is not a ledger backup");
       S = migrate(s); logIt("Imported a backup"); render(); }
  catch(err){ alert("Import failed: " + err.message); }
  e.target.value = "";
};
$("#resetBtn").onclick = ()=>{ if(confirm("Erase everything stored in this browser?")){ S = blank(); save(); render(); } };

// The top bar is frosted glass; its hairline only appears once content is behind it.
addEventListener("scroll", ()=> document.body.classList.toggle("scrolled", scrollY > 4), {passive:true});
// Calendar day cells are divs with role="button" — give them the keyboard behaviour that implies.
document.body.addEventListener("keydown", e=>{
  if((e.key==="Enter" || e.key===" ") && e.target.dataset?.day){ e.preventDefault(); e.target.click(); }
});

if("serviceWorker" in navigator) addEventListener("load", ()=> navigator.serviceWorker.register("sw.js").catch(()=>{}));

// ---------- self-check: open with ?test ----------
function demo(){
  const ok = (c,m,x) => { if(!c) console.error("FAIL:",m,x??""); else console.log("ok:",m); };
  ok(addMonths("2026-01-31",1)==="2026-02-28", "month clamps to short month");
  ok(addDays("2026-08-31",7)==="2026-09-07", "week crosses month");
  ok(gen("2026-08-10",4,"2weeks",1322.93).map(x=>x.due).join()==="2026-08-10,2026-08-24,2026-09-07,2026-09-21",
     "biweekly schedule");
  ok(cycleFor("2026-08-05",9,19).due==="2026-08-19", "buy before the 9th bills this month");
  ok(cycleFor("2026-08-09",9,19).due==="2026-09-19", "buy on the 9th rolls to next statement");
  ok(cycleFor("2026-12-20",9,19).due==="2027-01-19", "cycle rolls across the year");

  const save0 = S;
  S = {v:DATA_V, log:[], accounts:[
    {id:"m",parent:null,name:"Main",kind:"gotyme",bal:0,loanId:""},
    {id:"i",parent:"m",name:"Myself",kind:"gotyme",bal:2000,loanId:"income"},
    {id:"k",parent:"m",name:"Key",kind:"gotyme",bal:495.39,loanId:"K"},
    {id:"n",parent:"m",name:"Mon",kind:"gotyme",bal:0,loanId:"C"}],
   loans:[
    {id:"K",provider:"BillEase",label:"Key",ref:"",freq:"week",items:gen("2026-08-17",14,"week",40.21)},
    {id:"C",provider:"BillEase",label:"Cash-in",ref:"",freq:"2weeks",items:gen("2026-08-24",3,"2weeks",1322.93)}]};
  const key = acc("k"), mon = acc("n");
  ok(coverage(key).n===12 && !coverage(key).done, "495.39 covers 12 of 14", coverage(key));
  ok(r2(14*40.21-495.39)===67.55, "gap to cover the whole run");
  ok(covText(key).includes("12/14") && covText(key).includes("67.55"), "coverage reads n/max plus the gap", covText(key));
  ok(covText(mon).includes("0/3") && covText(mon).includes("3,968.79"), "empty envelope shows both shortfalls", covText(mon));
  ok(covText({...key, bal:9999}).includes("14/14"), "fully funded reads n/n");
  ok(r2(3*1322.93)===3968.79, "cash-in remaining");

  const card = rebuildCard({id:"X",freq:"card",limit:8480,sDay:9,dDay:19,items:[],
    purchases:[{id:"1",date:"2026-08-11",label:"a",amount:1410.39},{id:"2",date:"2026-08-12",label:"b",amount:89.61}]});
  ok(card.items.length===1 && card.items[0].amount===1500, "same-cycle purchases merge", card.items);
  ok(available(card)===6980, "available credit = limit - outstanding", available(card));
  ok(migrate({accounts:[],loans:[],log:[]}).v===DATA_V, "migration stamps the version");

  const todayDow = new Date().getDay();
  S.allowance = {weekday:(todayDow+3)%7, amount:2000, lastAdded:""};
  ok(daysUntilAllowance()===3, "3 days until an allowance set 3 weekdays out", daysUntilAllowance());
  S.allowance = {weekday:todayDow, amount:2000, lastAdded:""};
  ok(daysUntilAllowance()===7, "allowance today means a full week ahead, not 0");
  ok(isAllowanceDay()===true, "today matches the scheduled weekday");
  S.allowance.lastAdded = today();
  ok(isAllowanceDay()===false, "already added today does not re-fire");

  S.allowance = {weekday:todayDow, amount:1000, lastAdded:""};
  const wk = weeklyOutlook(2);
  // Arrears are held out of the weekly rows entirely and taken off the opening balance
  // instead, so a week reports only what is still to come.
  const wantObl = r2(S.loans.flatMap(unpaid).filter(i=>i.due>=wk[0].wStart && i.due<=wk[0].wEnd).reduce((s,i)=>s+i.amount,0));
  ok(wk[0].obligations===wantObl, "week 0 carries only what falls inside it", {got:wk[0].obligations, want:wantObl});
  ok(wk[0].items.every(x=>x.it.due >= wk[0].wStart), "nothing overdue leaks into a week");
  ok(arrearsTotal() > 0, "...but the backlog is still counted somewhere", arrearsTotal());
  ok(wk[0].open===r2(S.accounts.reduce((s,a)=>s+a.bal,0) - arrearsTotal()),
     "the projection opens on what is left after clearing it", wk[0].open);
  ok(wk[1].items.every(x=>x.it.due>=wk[1].wStart && x.it.due<=wk[1].wEnd), "later weeks stay inside their own window");
  ok(wk[0].income===1000, "allowance falling in week 0 counts once", wk[0]);
  ok(wk[0].pays.length===1 && wk[0].pays[0].claimed===false, "the unclaimed occurrence is flagged as expected");
  ok(r2(wk[0].open + wk[0].income - wk[0].obligations)===wk[0].bal, "running balance = open + income - obligations");

  // The bug this section exists for: an allowance already added sits in the balance, so
  // counting the same occurrence again as future income double-counts it.
  S.allowance = {weekday:todayDow, amount:1000, lastAdded:today()};
  const wkC = weeklyOutlook(2);
  ok(wkC[0].income===0, "an allowance already claimed this week is not counted again", wkC[0]);
  ok(wkC[0].pays[0].claimed===true, "the claimed occurrence is flagged as claimed");
  ok(wkC[1].income===1000, "next week's allowance is still counted", wkC[1]);
  ok(r2(wkC[0].bal + 1000)===wk[0].bal, "claiming shifts week 0 down by exactly one allowance");
  ok(allowanceClaimed()===true, "this week reads as claimed");
  S.allowance = {weekday:todayDow, amount:1000, lastAdded:""};
  ok(allowanceClaimed()===false, "an unclaimed week reads as unclaimed");
  ok(lastAllowanceDate()===today(), "today is this week's allowance date when today is the weekday");
  S.allowance = {weekday:(todayDow+6)%7, amount:1000, lastAdded:""};
  ok(lastAllowanceDate()===addDays(today(),-1), "yesterday's weekday resolves to yesterday");
  ok(isAllowanceDay()===true, "a missed allowance stays claimable after its day");
  S.allowance.lastAdded = addDays(today(),-1);
  ok(isAllowanceDay()===false, "claiming a missed allowance clears the prompt");
  S.allowance = null;

  // --- allowance edge cases: anything partial or out of range must collapse to null ---
  ok(normAllowance(null)===null, "no allowance stays null");
  ok(normAllowance({weekday:2})===null, "weekday without amount is rejected");
  ok(normAllowance({weekday:2, amount:null})===null, "null amount is rejected");
  ok(normAllowance({weekday:9, amount:100})===null, "out-of-range weekday is rejected");
  ok(normAllowance({weekday:-1, amount:100})===null, "negative weekday is rejected");
  ok(normAllowance({weekday:"3", amount:"2000"}).weekday===3, "numeric strings are coerced");
  ok(normAllowance({weekday:0, amount:0})===null, "zero amount is rejected");
  S.allowance = null;
  ok(daysUntilAllowance()===7, "no schedule falls back to a 7-day week");
  ok(isAllowanceDay()===false, "no schedule never fires allowance day");
  ok(weeklyOutlook(3).every(w=>Number.isFinite(w.bal) && w.income===0),
     "weekly outlook stays finite with no allowance", weeklyOutlook(3));
  S.allowance = {weekday:todayDow, amount:2000, lastAdded:""};
  ok(weeklyOutlook(3).every(w=>Number.isFinite(w.bal)), "weekly outlook stays finite with a schedule");
  S.allowance = null;

  // --- the reported bug: edit a subwallet, it must keep its parent link and stay visible ---
  const before = acc("i");
  ok(before.parent==="m" && before.loanId==="income", "Myself starts parented to main as the pool");
  before.name = "Myself"; before.bal = r2("1234.5"); // what the edit handler writes
  ok(acc("i").parent==="m", "editing balance/name preserves the parent link");
  ok(acc("i").loanId==="income", "editing preserves the allowance-pool flag");
  ok(kidsOf("m").some(k=>k.id==="i"), "edited subwallet is still rendered under its parent");
  ok(incomeAcc().id==="i", "allowance pool still resolves after an edit");

  // --- creating a new subwallet under a parent ---
  const nAcc = S.accounts.length;
  S.accounts.push({id:"new1", parent:"m", name:"New section", kind:"gotyme", bal:0, loanId:""});
  ok(S.accounts.length===nAcc+1 && kidsOf("m").some(k=>k.id==="new1"), "new subwallet attaches to its parent");
  ok(parents().every(p=>p.id!=="new1"), "a subwallet is not also treated as a top-level wallet");

  // --- migrate must not silently drop or orphan accounts ---
  const orphaned = migrate({accounts:[
    {id:"p",parent:null,name:"P",kind:"gotyme",bal:1},
    {id:"c",parent:"GONE",name:"C",kind:"gotyme",bal:2}], loans:[], log:[]});
  ok(orphaned.accounts.length===2, "migration keeps an account whose parent vanished");
  ok(orphaned.accounts.find(a=>a.id==="c").parent===null, "orphan is promoted to top level so it stays visible");
  ok(migrate({}).accounts.length===0, "migrating an empty object does not throw");
  ok(migrate({accounts:"nope",loans:null,log:5}).accounts.length===0, "migration repairs wrong-typed fields");
  ok(migrate({accounts:[{id:"z",bal:"12.5"}],loans:[],log:[]}).accounts[0].bal===12.5, "string balances are coerced to numbers");

  // --- a corrupt loans array must not take the whole app down ---
  ok(migrate({accounts:[],loans:[null,{},{id:"L",freq:"week",items:null}],log:[]}).loans.length===1,
     "migration drops junk loan entries and keeps the real one");
  ok(migrate({accounts:[],loans:[{id:"L",freq:"week",items:null}],log:[]}).loans[0].items.length===0,
     "a loan with no items array degrades to an empty schedule");
  ok(migrate({accounts:[],loans:[{id:"L",freq:"week",items:[{due:"2026-01-01",amount:"40.21"},{amount:5}]}],log:[]})
       .loans[0].items.every(i=>Number.isFinite(i.amount) && i.due),
     "instalment amounts are coerced and dateless rows dropped");
  const badCard = migrate({accounts:[],log:[],loans:[{id:"C",freq:"card",limit:"1000",sDay:9,dDay:19,
    purchases:[{id:"p",date:"2026-01-02",label:"x",amount:"10.5"},{amount:1}]}]}).loans[0];
  ok(badCard.items.every(i=>Number.isFinite(i.amount)) && outstanding(badCard)===10.5,
     "string purchase amounts are coerced instead of turning totals into NaN", badCard.items);

  // --- partial payment on an instalment must leave the remainder owed ---
  const payL = {id:"P", provider:"x", label:"Part", ref:"", freq:"week", items:gen("2026-01-05",2,"week",100)};
  const payIt = payL.items[0];
  const part = 40;                       // what the click handler does when amt < it.amount
  payIt.amount = r2(payIt.amount - part);
  ok(payIt.paid===false && payIt.amount===60, "underpaying leaves the instalment open for the rest", payIt);
  ok(r2(payL.items.reduce((s,i)=>s+(i.paid?0:i.amount),0))===160,
     "the shortfall is still counted in what is owed");

  // --- undo restores exact parent/child relations, no orphans or duplicate ids ---
  undoStack = []; suppressHistory = false;
  const snapA = {v:DATA_V, log:[], allowance:null, loans:[], accounts:[
    {id:"m",parent:null,name:"Main",kind:"gotyme",bal:0,loanId:""},
    {id:"i",parent:"m",name:"Myself",kind:"gotyme",bal:2000,loanId:"income"}]};
  undoStack.push(JSON.stringify(snapA));
  const snapB = JSON.parse(JSON.stringify(snapA));
  snapB.accounts.push({id:"k2",parent:"m",name:"Added",kind:"gotyme",bal:5,loanId:""});
  undoStack.push(JSON.stringify(snapB));
  ok(undoStack.length===2, "two checkpoints recorded");
  undoStack.pop();
  const restored = migrate(JSON.parse(undoStack[undoStack.length-1]));
  ok(restored.accounts.length===2, "undo removes the added subwallet", restored.accounts.length);
  ok(restored.accounts.find(a=>a.id==="i").parent==="m", "undo restores the parent link exactly");
  ok(new Set(restored.accounts.map(a=>a.id)).size===restored.accounts.length, "undo leaves no duplicate ids");
  // snapshots are serialized, so mutating restored state cannot write back into the stack
  restored.accounts[0].bal = 999;
  ok(JSON.parse(undoStack[0]).accounts[0].bal===0, "checkpoints are deep copies, not shared references");

  // --- wishlist: rate, progress and the edges that make it lie ---
  S = {v:DATA_V, log:[], wish:[], allowance:{weekday:new Date().getDay(), amount:1000, lastAdded:today()},
       accounts:[{id:"m",parent:null,name:"Main",kind:"gotyme",bal:750,loanId:""},
                 {id:"p",parent:"m",name:"Pot",kind:"gotyme",bal:250,loanId:""}],
       loans:[]};
  ok(savingRate()===1000, "with no obligations the rate is the whole allowance", savingRate());
  ok(walletTotal()===1000, "progress counts every wallet, parent and section alike", walletTotal());
  const w1 = {id:"w1", name:"Thing", cost:4000, brand:"", logo:""};
  ok(wishProgress(w1,1000).saved===1000, "a wish is measured against the wallet total");
  ok(wishProgress(w1,1000).left===3000 && wishProgress(w1,1000).weeks===3, "three weeks of surplus closes a 3000 gap");
  ok(Math.round(wishProgress(w1,1000).pct)===25, "progress is the wallet total over cost");
  ok(wishProgress({...w1,cost:1000},1000).weeks===0, "an affordable wish needs no more weeks");
  ok(wishProgress({...w1,cost:800},1000).left===0, "already affordable never reports a negative gap");
  const keepAllowance = S.allowance;
  S.allowance = null;                       // no income at all: nothing to simulate either
  ok(wishProgress(w1,0).weeks===null, "no surplus means no date rather than Infinity");
  ok(wishProgress(w1,-50).weeks===null, "a negative surplus also reports no date");
  S.allowance = keepAllowance;
  ok(wishProgress({...w1,cost:0},1000).pct===100, "a free wish is complete, not NaN");
  // the rate must ignore week 0, which carries the overdue backlog
  S.loans = [{id:"L",provider:"x",label:"Old",ref:"",freq:"week",
              items:[{due:addDays(today(),-60),amount:5000,paid:false}]}];
  ok(savingRate()===1000, "an overdue backlog does not drag the weekly rate to zero", savingRate());
  ok(arrearsTotal()===5000 && weeklyOutlook(2)[0].obligations===0,
     "the backlog is held as arrears rather than charged to a week", arrearsTotal());
  ok(migrate({accounts:[],loans:[],log:[],wish:"nope"}).wish.length===0, "a wrong-typed wishlist degrades to empty");
  ok(migrate({accounts:[],loans:[],log:[],wish:[null,{}]}).wish.length===0, "junk wish entries are dropped");
  ok(ord(1)==="1st" && ord(11)==="11th" && ord(22)==="22nd" && ord(13)==="13th", "ordinals handle the teens");

  // --- confirming the allowance records the week without moving money ---
  S.allowance = {weekday:new Date().getDay(), amount:1000, lastAdded:""};
  const balBefore = walletTotal();
  ok(isAllowanceDay()===true, "an unclaimed allowance prompts");
  S.allowance.lastAdded = today();                       // what "Yes, it's in" does
  ok(isAllowanceDay()===false, "confirming clears the prompt");
  ok(walletTotal()===balBefore, "confirming does not touch any balance");
  ok(weeklyOutlook(2)[0].income===0, "a confirmed allowance is not counted as income again");

  // --- money other people owe you ---
  S = {v:DATA_V, log:[], wish:[], allowance:null,
       accounts:[{id:"m",parent:null,name:"Main",kind:"gotyme",bal:1000,loanId:""}],
       loans:[rebuildCard({id:"C",provider:"Card",label:"Card",ref:"",freq:"card",limit:9000,
              sDay:9,dDay:19,items:[],purchases:[{id:"P",date:today(),label:"Thing",amount:600}]})],
       people:[{id:"s",name:"Sam",brand:""},{id:"a",name:"Alex",brand:""}],
       owed:[{id:"o1",personId:"s",amount:0,note:"",loanId:"C",purchaseId:"P",settled:false},
             {id:"o2",personId:"a",amount:200,note:"Lunch",loanId:"",purchaseId:"",settled:false},
             {id:"o3",personId:"a",amount:150,note:"Ticket",loanId:"",purchaseId:"",settled:false},
             {id:"o4",personId:"s",amount:900,note:"Old",loanId:"",purchaseId:"",settled:true}]};

  // a card-backed debt takes its amount and description from the purchase, not its own fields
  ok(owedAmount(S.owed[0])===600, "a linked debt is worth what the purchase cost", owedAmount(S.owed[0]));
  // --- splitting a shared bill ---
  S.owed[0].share = 0.5;
  ok(owedAmount(S.owed[0])===300, "half a 600 purchase is 300", owedAmount(S.owed[0]));
  ok(owedToMe()===r2(300+200+150), "a share counts as a share in the totals", owedToMe());
  S.assumePaid = true;   // offsets only exist in assume-settled mode
  ok(cardOffsets().get("C|"+cycleFor(today(),9,19).due)===300,
     "and only their half is offset against the statement", [...cardOffsets()]);
  ok(cashOwed()===350 && cardOwed()===300, "the other two debts stay spendable cash", [cashOwed(), cardOwed()]);
  S.assumePaid = false;
  S.loans[0].purchases[0].amount = 800; rebuildCard(S.loans[0]);
  ok(owedAmount(S.owed[0])===400, "a share still follows the purchase when it is corrected");
  S.owed[0].share = 1/3;
  ok(owedAmount(S.owed[0])===266.67, "a third rounds to cents", owedAmount(S.owed[0]));
  S.owed[0].share = 0; S.owed[0].amount = 125;
  ok(owedAmount(S.owed[0])===125, "share 0 means the amount is kept explicitly");
  ok(shareLabel(1)==="" && shareLabel(0.5)==="half of " && shareLabel(1/3)==="a third of ",
     "shares read as words");
  ok(migrate({accounts:[],loans:[],log:[],wish:[],people:[],
     owed:[{id:"x",personId:"p",amount:5}]}).owed[0].share===1,
     "data from before splitting means the whole purchase");
  S.owed[0].share = 1; S.owed[0].amount = 0;
  S.loans[0].purchases[0].amount = 600; rebuildCard(S.loans[0]);
  ok(owedLabel(S.owed[0])==="Thing", "a linked debt is described by the purchase");
  ok(owedAmount(S.owed[1])===200 && owedLabel(S.owed[1])==="Lunch", "an unlinked debt uses its own fields");
  S.loans[0].purchases[0].amount = 750; rebuildCard(S.loans[0]);
  ok(owedAmount(S.owed[0])===750, "editing the purchase moves the debt with it");

  ok(owedToMe()===1100, "settled debts drop out of what you are owed", owedToMe());
  ok(owedOnCard()===750, "only the card-backed part counts as already a liability", owedOnCard());
  ok(receivables().length===3, "settled debts drop out of the list");

  // grouping: one row per person, biggest debtor first, settled excluded
  const gs = owedByPerson();
  ok(gs.length===2, "debts are grouped per person", gs.length);
  ok(gs[0].who.name==="Sam" && gs[0].total===750, "the biggest debtor leads", gs[0]);
  ok(gs[1].who.name==="Alex" && gs[1].items.length===2 && gs[1].total===350, "a person's debts are gathered together", gs[1]);
  ok(gs.every(g=>g.items.every(o=>!o.settled)), "settled debts never appear in a group");

  // the net position is unchanged by a receivable; only the "once settled" figure moves
  const netNow = r2(S.accounts.reduce((x,a)=>x+a.bal,0) - S.loans.reduce((x,L)=>x+unpaid(L).reduce((t,i)=>t+i.amount,0),0));
  ok(r2(netNow + owedToMe()) - netNow === 1100, "once settled adds back exactly what you are owed");
  S.owed[0].settled = true;
  ok(owedToMe()===350 && owedOnCard()===0, "settling removes it from both totals");

  // --- lumpy obligations: the date is walked, not divided ---
  // 1000 a week clear, with one 900 instalment landing in week six. Five weeks of saving
  // really does reach 5000, because nothing has been deducted yet. An average smears that
  // 900 across every week (871.43 a week) and says six.
  S = {v:DATA_V, log:[], wish:[], people:[], owed:[], assumePaid:false,
       allowance:{weekday:new Date().getDay(), amount:1000, lastAdded:today()},
       accounts:[{id:"m",parent:null,name:"Main",kind:"gotyme",bal:0,loanId:""}],
       loans:[{id:"L",provider:"x",label:"Lump",ref:"",freq:"week",
               items:[{due:addDays(today(),45),amount:900,paid:false}]}]};
  ok(weeksToAfford(4500, savingRate())===5, "the gap closes the week the money is there", weeksToAfford(4500, savingRate()));
  ok(Math.ceil(4500/savingRate())===6, "...which an average would have called six", Math.ceil(4500/savingRate()));
  ok(weeksToAfford(0, 1000)===0, "nothing to save means no wait");
  ok(weeksToAfford(-5, 1000)===0, "an overshoot is not a negative wait");
  // beyond the projection the flat rate extrapolates, and without one there is no date
  ok(weeksToAfford(999999, 1000) > WK_WEEKS, "a gap past the projection extrapolates", weeksToAfford(999999,1000));
  ok(weeksToAfford(999999, 0)===null, "no rate past the projection means no date");

  // --- a debt you fronted on a card cancels against the statement it will pay ---
  S = {v:DATA_V, log:[], wish:[], allowance:null, assumePaid:true,
       accounts:[{id:"m",parent:null,name:"Main",kind:"gotyme",bal:5000,loanId:""}],
       loans:[rebuildCard({id:"C",provider:"Card",label:"Card",ref:"",freq:"card",limit:9000,
              sDay:9,dDay:19,items:[],purchases:[{id:"P",date:today(),label:"Thing",amount:600}]})],
       people:[{id:"s",name:"Sam",brand:""},{id:"a",name:"Alex",brand:""}],
       owed:[{id:"o1",personId:"s",amount:0,note:"",loanId:"C",purchaseId:"P",settled:false},
             {id:"o2",personId:"a",amount:400,note:"Cash",loanId:"",purchaseId:"",settled:false}]};
  ok(cashOwed()===400 && cardOwed()===600, "cash and card-backed debts are separated", [cashOwed(), cardOwed()]);
  ok(walletTotal()===5400, "only the cash part is spendable", walletTotal());
  const stmtDue = cycleFor(today(), 9, 19).due;
  ok(cardOffsets().get("C|"+stmtDue)===600, "the offset lands on the statement the purchase bills to");
  const covRows = weeklyOutlook(WK_WEEKS);
  const cardRow = covRows.flatMap(r=>r.items).find(x=>x.L.id==="C");
  ok(cardRow.covered===600 && cardRow.due===0, "the statement costs nothing once it is covered", cardRow);
  ok(covRows.every(r=>r.bal>=5400), "the projection never dips for money someone else is repaying",
     covRows.map(r=>r.bal));
  S.assumePaid = false;
  ok(walletTotal()===5000 && cardOffsets().size===0, "with the mode off nothing is netted out");
  ok(weeklyOutlook(WK_WEEKS).some(r=>r.bal<5000), "...and the statement shows as a real cost again");

  // --- marking a payment unpaid must return the money, not just the debt ---
  S = {v:DATA_V, log:[], wish:[], owed:[], people:[], allowance:null, assumePaid:false,
       accounts:[{id:"m",parent:null,name:"Main",kind:"gotyme",bal:1000,loanId:""}],
       loans:[{id:"L",provider:"p",label:"L",ref:"",freq:"week",items:gen(today(),2,"week",100)}]};
  const netOf = () => r2(S.accounts.reduce((x,a)=>x+a.bal,0) - S.loans.reduce((x,L)=>x+unpaid(L).reduce((t,i)=>t+i.amount,0),0));
  const net0 = netOf(), it0 = S.loans[0].items[0];
  S.accounts[0].bal = r2(S.accounts[0].bal - 100);          // what Pay does
  it0.paid = true; it0.paidFrom = "m"; it0.paidAmt = 100;
  ok(netOf()===net0, "paying moves money without changing the net position", netOf());
  refund(it0, "test"); it0.paid = false;                     // what "mark unpaid" does
  ok(S.accounts[0].bal===1000, "the money goes back to the wallet it came from", S.accounts[0].bal);
  ok(netOf()===net0, "and the net position is exactly where it started", netOf());
  ok(it0.paidFrom===undefined && it0.paidAmt===undefined, "the payment record is cleared");
  refund(it0, "test");
  ok(S.accounts[0].bal===1000, "refunding twice cannot pay you twice", S.accounts[0].bal);
  const orphanIt = {due:today(), amount:50, paid:true, paidFrom:"GONE", paidAmt:50};
  refund(orphanIt, "test");
  ok(S.accounts[0].bal===1000, "a refund to a deleted wallet is dropped, not thrown");

  // a card rebuild must not lose the payment record, or the refund silently stops working
  const cardL = rebuildCard({id:"C",provider:"C",label:"C",ref:"",freq:"card",limit:5000,sDay:9,dDay:19,
    items:[],purchases:[{id:"P",date:today(),label:"x",amount:300}]});
  cardL.items[0].paid = true; cardL.items[0].paidFrom = "m"; cardL.items[0].paidAmt = 300;
  cardL.purchases.push({id:"P2",date:today(),label:"y",amount:20});
  rebuildCard(cardL);
  ok(cardL.items[0].paidFrom==="m" && cardL.items[0].paidAmt===300,
     "rebuilding a card keeps where its statement was paid from", cardL.items[0]);

  // --- a fronted purchase stops being a pass-through once you have paid the statement ---
  S = {v:DATA_V, log:[], wish:[], allowance:null, assumePaid:true, people:[{id:"s",name:"Sam",brand:""}],
       accounts:[{id:"m",parent:null,name:"Main",kind:"gotyme",bal:5000,loanId:""}],
       loans:[rebuildCard({id:"C",provider:"Card",label:"Card",ref:"",freq:"card",limit:9000,sDay:9,dDay:19,
              items:[],purchases:[{id:"P",date:addDays(today(),-40),label:"Thing",amount:600}]})],
       owed:[{id:"o",personId:"s",amount:600,note:"",loanId:"C",purchaseId:"P",settled:false}]};
  ok(isPassThrough(S.owed[0])===true, "while the statement is unpaid it is earmarked for the card");
  ok(cashOwed()===0 && cardOwed()===600 && walletTotal()===5000, "so none of it is spendable yet");
  S.loans[0].items.forEach(i=>i.paid = true);          // you paid that statement yourself
  ok(isPassThrough(S.owed[0])===false, "once you have paid it, their repayment is yours");
  ok(cashOwed()===600 && cardOwed()===0, "it moves from earmarked to spendable", [cashOwed(), cardOwed()]);
  ok(walletTotal()===5600, "and it finally reaches the pot instead of vanishing", walletTotal());
  ok(cardOffsets().size===0, "a paid statement is never offset twice");
  ok(owedToMe()===600, "what you are owed is unchanged by any of this");

  // --- "assume settled" moves every stock of money, and nothing else ---
  S = {v:DATA_V, log:[], allowance:{weekday:new Date().getDay(), amount:1000, lastAdded:today()},
       accounts:[{id:"m",parent:null,name:"Main",kind:"gotyme",bal:1000,loanId:""}],
       loans:[], people:[{id:"s",name:"Sam",brand:""}], wish:[{id:"w",name:"Thing",cost:2500,brand:"",logo:""}],
       owed:[{id:"o",personId:"s",amount:500,note:"",loanId:"",purchaseId:"",settled:false}],
       assumePaid:false};
  const offPot = walletTotal(), offWeek = weeklyOutlook(2)[0].open, offRate = savingRate();
  ok(assumePaid()===false && cashOwed()===0, "the mode is off by default");
  ok(offPot===1000, "off, the pot is only what is in the wallets", offPot);

  S.assumePaid = true;
  ok(assumePaid()===true && cashOwed()===500 && cardOwed()===0, "on, a cash debt is spendable and nothing is card-backed");
  ok(walletTotal()===1500, "on, the wishlist pot includes what you are owed", walletTotal());
  ok(weeklyOutlook(2)[0].open===r2(offWeek+500), "on, the weekly projection opens 500 higher");
  ok(weeklyOutlook(2)[0].bal===r2(weeklyOutlook(2)[0].open + weeklyOutlook(2)[0].income), "the projection still balances");
  ok(savingRate()===offRate, "a one-off repayment never changes the weekly rate", savingRate());
  ok(wishProgress(S.wish[0], savingRate()).saved===1500, "a wish is measured against the boosted pot");
  // 2500 to find, 1000 a week: 1500 still needed with the debt counted, 2500 without —
  // two weeks becomes one, which is the whole point of the mode.
  ok(wishProgress(S.wish[0], savingRate()).left === 1000, "the gap shrinks by what you are owed");
  // --- somebody else covering part of the price ---
  const helped = {id:"h", name:"Thing", cost:10000, helpPct:40, brand:"", logo:""};
  ok(wishTarget(helped)===6000, "40% covered leaves 6000 to find", wishTarget(helped));
  ok(wishProgress(helped, 1000, 3000).left===3000, "the gap is measured against the target, not the price");
  ok(Math.round(wishProgress(helped, 1000, 3000).pct)===50, "so is the ring", wishProgress(helped,1000,3000).pct);
  ok(wishProgress(helped, 1000, 3000).covered===4000, "what somebody else puts in is reported");
  ok(wishProgress(helped, 1000, 6000).left===0 && wishProgress(helped,1000,6000).weeks===0,
     "reaching the target is enough — the rest is not yours to find");
  ok(wishTarget({cost:10000, helpPct:100})===0, "fully covered needs nothing");
  ok(wishProgress({id:"z",name:"z",cost:10000,helpPct:100}, 1000, 0).pct===100, "and reads as complete, not NaN");
  ok(wishTarget({cost:10000, helpPct:0})===10000, "no help means the whole price");
  ok(wishTarget({cost:10000})===10000, "a wish from before this existed is uncovered");
  ok(wishTarget({cost:10000, helpPct:-50})===10000 && wishTarget({cost:10000, helpPct:150})===0,
     "a nonsense percentage is clamped rather than inverting the target");
  ok(migrate({accounts:[],loans:[],log:[],owed:[],people:[],
     wish:[{id:"w",name:"x",cost:100,helpPct:"25"}]}).wish[0].helpPct===25, "a string percentage is coerced");
  ok(migrate({accounts:[],loans:[],log:[],owed:[],people:[],
     wish:[{id:"w",name:"x",cost:100,helpPct:999}]}).wish[0].helpPct===100, "and clamped on the way in");
  ok(wishProgress(S.wish[0], savingRate()).weeks === 1
     && wishProgress(S.wish[0], savingRate(), offPot).weeks === 2,
     "assuming payment brings the date forward",
     [wishProgress(S.wish[0], savingRate()).weeks, wishProgress(S.wish[0], savingRate(), offPot).weeks]);

  // settling for real must land in exactly the same place the assumption predicted
  const predicted = walletTotal();
  S.assumePaid = false; S.owed[0].settled = true; S.accounts[0].bal = r2(S.accounts[0].bal + 500);
  ok(walletTotal()===predicted, "actually being paid matches what the mode projected", walletTotal());
  ok(owedToMe()===0 && cashOwed()===0, "a settled debt stops being counted either way");
  S.owed[0].settled = false; S.accounts[0].bal = 1000; S.assumePaid = false;
  ok(migrate({accounts:[],loans:[],log:[],wish:[],owed:[],people:[]}).assumePaid===false, "the mode defaults off on migration");
  ok(migrate({accounts:[],loans:[],log:[],wish:[],owed:[],people:[],assumePaid:"yes"}).assumePaid===true, "the mode is coerced to a boolean");

  // --- migration: names become profiles, dangling links are cleaned up ---
  const up = migrate({accounts:[], loans:[], log:[], wish:[],
    owed:[{id:"x",who:"Sam",amount:10},{id:"y",who:"sam",amount:5},{id:"z",who:"Jo",amount:7}]});
  ok(up.people.length===2, "one profile per distinct name, matched case-insensitively", up.people.map(x=>x.name));
  ok(up.owed[0].personId===up.owed[1].personId, "two debts from the same name share a profile");
  ok(up.owed.every(o=>o.who===undefined && o.due===undefined), "the old name and due fields are dropped");
  const orphan = migrate({accounts:[], loans:[], log:[], wish:[], people:[],
    owed:[{id:"o",personId:"GONE",amount:5}]});
  ok(orphan.people.length===1 && orphan.owed[0].personId===orphan.people[0].id,
     "a debt whose profile vanished is given one rather than dropped");
  const dangling = migrate({accounts:[], log:[], wish:[], loans:[], people:[],
    owed:[{id:"o",who:"Sam",amount:10,loanId:"GONE",purchaseId:"NOPE"}]});
  ok(dangling.owed[0].loanId==="" && dangling.owed[0].purchaseId==="",
     "a debt survives its linked purchase being deleted, unlinked");
  ok(migrate({accounts:[],loans:[],log:[],wish:[],owed:"nope",people:"nope"}).owed.length===0, "wrong-typed lists degrade to empty");
  ok(migrate({accounts:[],loans:[],log:[],wish:[],owed:[null,{}],people:[null]}).owed.length===0, "junk entries are dropped");
  ok(migrate({accounts:[],loans:[],log:[],wish:[],people:[],owed:[{id:"x",who:"A",amount:"12.5"}]}).owed[0].amount===12.5,
     "string amounts are coerced");

  // --- what a loan costs ---
  const lendL = {id:"I",provider:"App",label:"Phone",ref:"",freq:"month",principal:1000,
                 items:gen("2026-01-15",12,"month",100)};
  const lc = loanCost(lendL);
  ok(lc.total===1200 && lc.interest===200, "interest is the schedule less what you received", lc);
  ok(Math.round(lc.markup)===20, "markup is interest over what you received", lc.markup);
  // the yearly rate is whatever makes the repayments worth exactly what you received
  const t0 = new Date(addMonths("2026-01-15",-1)+"T00:00:00");
  const pv = lendL.items.reduce((acc,i)=>acc + i.amount / Math.pow(1+lc.apr/100,
    (new Date(i.due+"T00:00:00")-t0)/864e5/365), 0);
  ok(Math.abs(pv-1000) < 0.01, "the yearly rate discounts the schedule back to the amount received", {apr:lc.apr, pv});
  ok(lc.apr > lc.markup, "a year-long 20% markup paid monthly costs more than 20% a year", lc.apr);
  ok(loanCost({...lendL, principal:1200}).interest===0 && Math.abs(loanCost({...lendL, principal:1200}).apr) < 1e-6,
     "a schedule that only returns what you received costs nothing");
  ok(loanCost({...lendL, principal:0})===null, "no amount received means the cost is unknown, not zero");
  ok(loanCost({...lendL, fromPerson:true}).interest===0 && loanCost({...lendL, fromPerson:true}).apr===0,
     "a loan from a person is interest-free whatever you entered");
  const partL = {...lendL, items:[{due:"2026-02-15",amount:40,partPaid:60,paid:false}], principal:90};
  ok(loanScheduled(partL)===100, "money handed over on a part-paid instalment still counts toward the cost");
  const mig = migrate({accounts:[],log:[],wish:[],owed:[],people:[],
    loans:[{id:"L",freq:"week",fromPerson:"yes",principal:"500",items:[{due:"2026-01-01",amount:5}]}]}).loans[0];
  ok(mig.fromPerson===true && mig.principal===500, "person flag and amount received are coerced");

  // --- how much of a card is really yours ---
  S = {v:DATA_V, log:[], wish:[], allowance:null, assumePaid:false,
       accounts:[{id:"m",parent:null,name:"Main",kind:"gotyme",bal:0,loanId:""}],
       people:[{id:"s",name:"Sam",brand:""},{id:"a",name:"Alex",brand:""}],
       loans:[rebuildCard({id:"C",provider:"C",label:"Card",ref:"",freq:"card",limit:9000,sDay:9,dDay:19,items:[],
         purchases:[{id:"P1",date:today(),label:"Dinner",amount:1000},
                    {id:"P2",date:today(),label:"Mine",amount:500},
                    {id:"PC",date:today(),label:"Carried from Aug 19",amount:200,carry:true}]})],
       owed:[{id:"o1",personId:"s",amount:0,share:0.5,note:"",loanId:"C",purchaseId:"P1",settled:false},
             {id:"o2",personId:"a",amount:0,share:0.25,note:"",loanId:"C",purchaseId:"P1",settled:true}]};
  ok(othersShare(S.loans[0], S.loans[0].purchases[0])===750, "every share on a purchase counts, settled or not");
  const sp = cardSplit(S.loans[0]);
  ok(sp.out===1700 && sp.outOthers===750 && sp.outMine===950, "outstanding splits into yours and others'", sp);
  ok(sp.spent===1500 && sp.spentMine===750, "all-time spend leaves carried remainders out", sp);
  S.owed.push({id:"o3",personId:"s",amount:0,share:1,note:"",loanId:"C",purchaseId:"P1",settled:false});
  ok(othersShare(S.loans[0], S.loans[0].purchases[0])===1000, "an over-recorded split is capped at the purchase");
  ok(migrate({accounts:[],log:[],wish:[],owed:[],people:[],loans:[{id:"C",freq:"card",limit:1,sDay:9,dDay:19,
     purchases:[{id:"x",date:"2026-01-01",label:"Carried from Dec 19",amount:5}]}]}).loans[0].purchases[0].carry===true,
     "older carried remainders are recognised by their label");

  // --- paid-back history ---
  S.owed.pop();
  const led = owedLedger();
  const samL = led.find(g=>g.who.name==="Sam"), alexL = led.find(g=>g.who.name==="Alex");
  ok(samL.ever===500 && samL.back===0 && samL.left===500, "an open debt is all still to come back", samL);
  ok(alexL.ever===250 && alexL.back===250 && alexL.left===0, "a settled one fills the bar", alexL);
  ok(owedToMe()===500, "only open debts count as still owed");

  // --- purchases outside a card ---
  S = {v:DATA_V, log:[], wish:[], allowance:null, assumePaid:true, me:null,
       accounts:[{id:"m",parent:null,name:"Main",kind:"gotyme",bal:1000,loanId:""}], loans:[],
       people:[{id:"g",name:"Giorgia",brand:""}],
       buys:[{id:"B",date:today(),label:"Banh mi",amount:398,via:"GCash"}],
       owed:[{id:"o",personId:"g",amount:0,share:0.5,note:"",loanId:BUYS_ID,purchaseId:"B",settled:false}]};
  ok(purchaseOf(S.owed[0]).pu.label==="Banh mi", "a debt can point at a purchase made outside any card");
  ok(owedAmount(S.owed[0])===199 && owedLabel(S.owed[0])==="Banh mi", "and takes its amount, split and description from it");
  ok(othersShare(BUYS, S.buys[0])===199, "their share of it is counted against the purchase");
  ok(isPassThrough(S.owed[0])===false && cashOwed()===199, "you already paid it, so it is spendable cash when they pay you back");
  ok(linkTag(purchaseOf(S.owed[0]))==="via GCash", "it says how you paid");
  keepAmountAndUnlink(S.owed[0]);
  ok(S.owed[0].amount===199 && S.owed[0].note==="Banh mi" && !S.owed[0].purchaseId,
     "deleting the purchase leaves the debt worth what it was, not zero");
  const mb = migrate({accounts:[],loans:[],log:[],wish:[],people:[],
    buys:[null,{id:"b",label:"x",amount:"12.5"}],
    owed:[{id:"o",personId:"p",amount:5,loanId:BUYS_ID,purchaseId:"GONE"}], me:{qr:"",name:"x"}});
  ok(mb.buys.length===1 && mb.buys[0].amount===12.5 && mb.buys[0].date, "purchases are coerced and dated");
  ok(mb.owed[0].loanId==="" && mb.owed[0].purchaseId==="", "a link to a deleted purchase is dropped");
  ok(mb.me===null, "an empty QR is no QR");
  ok(migrate({accounts:[],loans:[],log:[],wish:[],owed:[],people:[],me:{qr:"000201",name:"V"}}).me.qr==="000201",
     "your QR text survives a reload");

  // --- reading who a QR Ph code pays ---
  const emv = "000201010211" + "5912VITO GANDEZA" + "6006MANILA" + "6304ABCD";
  ok(qrPayee(emv)==="VITO GANDEZA", "the payee name is read from tag 59");
  ok(qrPayee("https://example.com/pay")==="", "anything that is not an EMV code has no payee");
  ok(qrPayee("")==="", "an empty code has no payee");

  ok(r2(0.1+0.2)===0.3, "rounding");
  S = save0; undoStack = []; suppressHistory = false;
}
if(location.search.includes("test")) demo();

render();
renderSyncBtn();
if(syncCode()) bootSync();
// Tied to DOMContentLoaded, not the network 'load' event — on slow mobile data 'load' can
// fire seconds late (images, the service worker registration), which was stretching the
// window where a background sync render could collide with the entrance animation above.
const clearBoot = ()=> setTimeout(()=>document.body.classList.remove("boot"), 1100); // covers the last staggered child (.44s delay + .6s)
if(document.readyState === "loading") addEventListener("DOMContentLoaded", clearBoot); else clearBoot();
