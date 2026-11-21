// Split the bill: everyone enters their name, ticks what they had and sees what they owe.
// The whole bill is set in bill.json. You don't need to change this file.
//
// How it works:
// - A Cloudflare Worker serves the page and a small API (/api/...).
// - A Durable Object keeps the shared state (who ticked what). Writes go through
//   one at a time, so two people ticking at the same moment don't overwrite each other.
// - The page reloads the state every 4 seconds.

import { DurableObject } from "cloudflare:workers";
import BILL from "../bill.json";

// Prices are kept in cents to avoid rounding errors (0.1 + 0.2 ≠ 0.3).
const cents = (x) => Math.round(Number(x) * 100);

const ITEMS = BILL.items.map((it, i) => ({
  id: "i" + i,
  name: String(it.name),
  quantity: Math.max(1, Math.round(Number(it.quantity) || 1)),
  price: cents(it.price),
}));

// A "unit" is one copy of a dish. 3 coffees = 3 units, each can be ticked separately.
const UNITS = ITEMS.flatMap((it) =>
  Array.from({ length: it.quantity }, (_, i) => ({ id: `${it.id}-${i + 1}`, item: it.id, price: it.price }))
);
const UNIT_IDS = new Set(UNITS.map((u) => u.id));
const TOTAL = UNITS.reduce((s, u) => s + u.price, 0);
const MAX_PEOPLE = 60;

const cleanName = (n) => String(n || "").trim().replace(/\s+/g, " ").slice(0, 30);
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

export class Bill extends DurableObject {
  async load() {
    return (await this.ctx.storage.get("state")) || { people: {}, table: [] };
  }

  async handle(method, path, body) {
    const state = await this.load();
    if (method !== "POST") return state;

    if (path === "/api/claim") {
      const name = cleanName(body.name);
      if (!name) return { error: "missing name", status: 400 };
      const units = [...new Set((body.units || []).filter((u) => UNIT_IDS.has(u)))];
      const key = Object.keys(state.people).find((k) => sameName(k, name)) || name;
      if (!(key in state.people) && Object.keys(state.people).length >= MAX_PEOPLE) {
        return { error: "too many people", status: 400 };
      }
      state.people[key] = units;
    } else if (path === "/api/table") {
      if (!UNIT_IDS.has(body.unit)) return { error: "unknown dish", status: 400 };
      const table = new Set(state.table);
      body.on ? table.add(body.unit) : table.delete(body.unit);
      state.table = [...table];
    } else if (path === "/api/remove") {
      const name = cleanName(body.name);
      for (const k of Object.keys(state.people)) if (sameName(k, name)) delete state.people[k];
    } else {
      return { error: "not found", status: 404 };
    }

    await this.ctx.storage.put("state", state);
    return state;
  }
}

const json = (d, status = 200) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      // One bill = one Durable Object. Changing the title or date starts from an empty bill.
      const name = BILL.id || `${BILL.title}-${BILL.date}`;
      const stub = env.BILL.get(env.BILL.idFromName(name));
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : null;
      const out = await stub.handle(req.method, url.pathname, body);
      return json(out, out.status || 200);
    }
    if (url.pathname !== "/") return new Response("Not found", { status: 404 });
    return new Response(PAGE, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  },
};

// Data handed to the page, without a single "<" (so it can never close the <script>).
const forScript = (x) => JSON.stringify(x).replace(/</g, "\\u003c");
const escape = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const PAGE = `<!doctype html>
<html lang="${BILL.language === "fr" ? "fr" : "en"}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(BILL.title)}</title>
<style>
:root{--bg:#f6f3ee;--card:#fff;--ink:#1d1b18;--mute:#6f685f;--line:#e6e0d6;--acc:#c2410c;--acc2:#fff1e8;--chip:#efe9df}
@media (prefers-color-scheme:dark){:root{--bg:#141210;--card:#1e1b18;--ink:#f1ece4;--mute:#a39b90;--line:#332e28;--acc:#fb923c;--acc2:#3a2416;--chip:#2b2621}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.4 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;padding-bottom:110px}
.wrap{max-width:560px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:4px 0 2px}.sub{color:var(--mute);font-size:14px;margin:0 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:14px}
label.lbl{font-size:13px;color:var(--mute);display:block;margin-bottom:6px}
input[type=text]{width:100%;font-size:17px;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
.row{display:flex;gap:10px;align-items:center;padding:11px 0;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.row input[type=checkbox]{width:24px;height:24px;accent-color:var(--acc);flex:none}
.row .main{flex:1;min-width:0}.row .nm{font-weight:600;font-size:15px}
.row .who{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.chip{background:var(--chip);border-radius:99px;padding:1px 8px;font-size:12px;color:var(--mute)}
.chip.me{background:var(--acc2);color:var(--acc)}
.price{font-variant-numeric:tabular-nums;text-align:right;font-size:14px;white-space:nowrap}
.price small{display:block;color:var(--mute);font-size:12px}
.tbl{border:1px solid var(--line);background:transparent;color:var(--mute);border-radius:8px;font-size:12px;padding:5px 7px;flex:none}
.tbl.on{background:var(--acc);border-color:var(--acc);color:#fff}
.row.disabled .nm{color:var(--mute)}
.sum{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}
.sum:first-child{border-top:0}.sum.warn{color:var(--acc)}.sum.tot{font-weight:700}
.sum .x{border:0;background:transparent;color:var(--mute);font-size:16px;padding:0 6px}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px calc(12px + env(safe-area-inset-bottom))}
.bar .in{max-width:560px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:10px}
.big{font-size:26px;font-weight:800;font-variant-numeric:tabular-nums}
.btn{display:inline-block;background:var(--acc);color:#fff;text-decoration:none;border:0;border-radius:10px;padding:12px 16px;font-weight:700;font-size:15px}
.kv{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}
.kv span{color:var(--mute);font-size:13px}.kv b{font-family:ui-monospace,Menlo,monospace;font-size:14px;word-break:break-all}
.copy{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:8px;padding:5px 9px;font-size:12px;flex:none}
.links .btn{width:100%;text-align:center;margin-bottom:10px}
.hint{font-size:13px;color:var(--mute);margin:0 0 6px}
.lang{float:right;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:4px 8px;font-size:13px}
h2{font-size:16px;margin:0 0 8px}
</style></head><body>
<div class="wrap">
  <button class="lang" id="lang"></button>
  <h1 id="title"></h1>
  <p class="sub" id="t-sub"></p>

  <div class="card">
    <label class="lbl" for="name" id="t-name"></label>
    <input type="text" id="name" autocomplete="given-name" maxlength="30">
  </div>

  <div class="card"><h2 id="t-dishes"></h2><p class="hint" id="t-help"></p><div id="dishes"></div></div>

  <div class="card"><h2 id="t-recap"></h2><div id="recap"></div></div>

  <div class="card" id="pay">
    <h2 id="t-pay"></h2>
    <div class="links" id="links"></div>
    <div id="texts"></div>
  </div>
</div>
<div class="bar"><div class="in"><div><div style="font-size:12px;color:var(--mute)" id="t-share"></div><div class="big" id="myshare">0</div></div><a class="btn" href="#pay" id="t-button"></a></div></div>

<script>
const B=${forScript({
  title: BILL.title,
  date: BILL.date,
  people: Math.max(1, Math.round(Number(BILL.people) || 1)),
  currency: BILL.currency || "USD",
  language: BILL.language === "fr" ? "fr" : "en",
  payer: BILL.payer || "",
  payments: BILL.payments || [],
})};
const ITEMS=${forScript(ITEMS)}, TOTAL=${TOTAL}, N=B.people;
const T={
 en:{sub:(d,t)=>"Bill of "+d+" · "+t+" · "+N+" people",name:"Your first name",dishes:"Tick what you had",
  help:"Several people can tick the same dish: it is split between them. \\"Table\\" = shared by all "+N+".",
  recap:"Who owes what",pay:"Pay back "+B.payer,share:"Your share",button:"Pay",table:"Table",
  unclaimed:"Not claimed yet",total:"Bill total",copied:"copied",copy:"copy",
  nameFirst:"Enter your name first",tableShare:"split by "+N,remove:"Remove this person?",
  missing:n=>n+" × ? (table)",perHead:"/ person",other:"FR"},
 fr:{sub:(d,t)=>"Addition du "+d+" · "+t+" · "+N+" personnes",name:"Ton prénom",dishes:"Coche ce que tu as pris",
  help:"Plusieurs personnes peuvent cocher le même plat : il est divisé entre elles. « Table » = partagé entre les "+N+".",
  recap:"Qui doit quoi",pay:"Rembourser "+B.payer,share:"Ta part",button:"Payer",table:"Table",
  unclaimed:"Pas encore attribué",total:"Total de l'addition",copied:"copié",copy:"copier",
  nameFirst:"Mets ton prénom d'abord",tableShare:"partagé à "+N,remove:"Retirer cette personne ?",
  missing:n=>n+" × ? (table)",perHead:"/ pers.",other:"EN"}};
const store={get:k=>{try{return localStorage.getItem(k)}catch(e){return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}}};
let lang=store.get("lang")||B.language;
let S={people:{},table:[]};
const $=id=>document.getElementById(id);
const money=c=>new Intl.NumberFormat(lang==="fr"?"fr-FR":"en-US",{style:"currency",currency:B.currency}).format(c/100);
const niceDate=()=>{const d=new Date(B.date+"T12:00:00");return isNaN(d)?B.date:d.toLocaleDateString(lang==="fr"?"fr-FR":"en-US")};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const units=[];ITEMS.forEach(it=>{for(let i=1;i<=it.quantity;i++)units.push({id:it.id+"-"+i,item:it,i})});
const me=()=>$("name").value.trim().replace(/\\s+/g," ");
const myKey=()=>Object.keys(S.people).find(k=>k.toLowerCase()===me().toLowerCase());
const myUnits=()=>new Set(S.people[myKey()]||[]);

function shares(){
  const table=new Set(S.table),owe={};Object.keys(S.people).forEach(p=>owe[p]=0);
  let tableTotal=0,unclaimed=0;
  units.forEach(u=>{
    const price=u.item.price;
    if(table.has(u.id)){tableTotal+=price;return}
    const who=Object.keys(S.people).filter(p=>S.people[p].includes(u.id));
    if(!who.length){unclaimed+=price;return}
    who.forEach(p=>owe[p]+=price/who.length);
  });
  const perHead=tableTotal/N;
  Object.keys(owe).forEach(p=>owe[p]+=perHead);
  return {owe,perHead,unclaimed};
}

function render(){
  const t=T[lang];
  document.documentElement.lang=lang;
  $("title").textContent=B.title;
  $("lang").textContent=t.other;
  $("t-sub").textContent=t.sub(niceDate(),money(TOTAL));
  ["name","dishes","help","recap","pay","share","button"].forEach(k=>$("t-"+k).textContent=t[k]);
  const mine=myUnits(),table=new Set(S.table);
  $("dishes").innerHTML=units.map(u=>{
    const who=Object.keys(S.people).filter(p=>S.people[p].includes(u.id));
    const onTable=table.has(u.id);
    const label=u.item.name+(u.item.quantity>1?" · "+u.i+"/"+u.item.quantity:"");
    const detail=onTable?t.tableShare:(who.length>1?"÷"+who.length+" = "+money(Math.round(u.item.price/who.length)):"");
    const chips=onTable?'<span class="chip me">'+t.table+'</span>':who.map(p=>'<span class="chip'+(p===myKey()?" me":"")+'">'+esc(p)+'</span>').join("");
    return '<div class="row'+(onTable?" disabled":"")+'"><input type="checkbox" data-u="'+u.id+'"'+(mine.has(u.id)&&!onTable?" checked":"")+(onTable?" disabled":"")+'>'+
      '<div class="main"><div class="nm">'+esc(label)+'</div><div class="who">'+chips+'</div></div>'+
      '<div class="price">'+money(u.item.price)+(detail?'<small>'+detail+'</small>':'')+'</div>'+
      '<button class="tbl'+(onTable?" on":"")+'" data-t="'+u.id+'">'+t.table+'</button></div>';
  }).join("");
  const {owe,perHead,unclaimed}=shares();
  const names=Object.keys(owe).sort((a,b)=>a.localeCompare(b));
  let html=names.map(p=>'<div class="sum"><span>'+esc(p)+'</span><span><b>'+money(Math.round(owe[p]))+'</b><button class="x" data-remove="'+esc(p)+'" aria-label="x">×</button></span></div>').join("");
  const missing=N-names.length;
  if(missing>0&&perHead>0)html+='<div class="sum warn"><span>'+t.missing(missing)+'</span><span>'+money(Math.round(perHead))+' '+t.perHead+'</span></div>';
  if(unclaimed>0)html+='<div class="sum warn"><span>'+t.unclaimed+'</span><b>'+money(unclaimed)+'</b></div>';
  html+='<div class="sum tot"><span>'+t.total+'</span><b>'+money(TOTAL)+'</b></div>';
  $("recap").innerHTML=html;
  const k=myKey();
  $("myshare").textContent=money(Math.round(k?owe[k]:perHead));
  $("links").innerHTML=B.payments.filter(p=>p.link&&/^https?:\\/\\//.test(p.link)).map(p=>'<a class="btn" target="_blank" rel="noopener" href="'+esc(p.link)+'">'+esc(p.name)+'</a>').join("");
  $("texts").innerHTML=B.payments.filter(p=>p.text).map(p=>'<div class="kv"><div><span>'+esc(p.name)+'</span><br><b>'+esc(p.text)+'</b></div><button class="copy" data-c="'+esc(String(p.text).replace(/\\s+/g,""))+'">'+t.copy+'</button></div>').join("");
}

async function api(path,body){
  const r=await fetch(path,body?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{cache:"no-store"});
  if(r.ok){S=await r.json();render()}
}
let busy=false;
document.addEventListener("change",async e=>{
  const u=e.target.dataset&&e.target.dataset.u;if(!u)return;
  if(!me()){e.target.checked=false;askName();return}
  const s=myUnits();e.target.checked?s.add(u):s.delete(u);
  busy=true;await api("/api/claim",{name:me(),units:[...s]});busy=false;
});
document.addEventListener("click",async e=>{
  const t=e.target.closest("[data-t]");
  if(t){if(!me()){askName();return}busy=true;await api("/api/table",{unit:t.dataset.t,on:!t.classList.contains("on")});busy=false;return}
  const x=e.target.closest("[data-remove]");
  if(x){if(confirm(T[lang].remove+" ("+x.dataset.remove+")")){busy=true;await api("/api/remove",{name:x.dataset.remove});busy=false}return}
  const c=e.target.closest("[data-c]");
  if(c){navigator.clipboard&&navigator.clipboard.writeText(c.dataset.c);const o=c.textContent;c.textContent=T[lang].copied;setTimeout(()=>c.textContent=o,1200);return}
  if(e.target.id==="lang"){lang=lang==="fr"?"en":"fr";store.set("lang",lang);render()}
});
function askName(){const n=$("name");n.focus();n.placeholder=T[lang].nameFirst;n.style.borderColor="var(--acc)"}
$("name").value=store.get("name")||"";
$("name").addEventListener("input",()=>{store.set("name",me());$("name").style.borderColor="";render()});
$("name").addEventListener("change",()=>{if(me()&&!myKey())api("/api/claim",{name:me(),units:[]})});
render();api("/api/state");
setInterval(()=>{if(!busy&&document.visibilityState==="visible")api("/api/state")},4000);
</script>
</body></html>`;
