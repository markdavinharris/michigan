'use strict';
/* ---------- helpers ---------- */
const YEARS = ['2026','2024','2022'];
const PARTIES = ['R','D','O'];
const PNAME = {R:'Republican', D:'Democratic', O:'Other / unaffiliated'};
// state-specific labels are applied after D.state is read (see ST below)
const PSHORT = {R:'Rep', D:'Dem', O:'Other'};
const MBASE = {req:1, ret:4, eip:7};
const MNAME = {ev:'Early votes (mail + in person)', ret:'Mail ballots returned', eip:'Early in-person votes', req:'Mail ballots requested'};
const MSHORT = {ev:'Early votes', ret:'Mail returned', eip:'In person', req:'Requested'};
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const COL = () => ({R:css('--rep'), D:css('--dem'), O:css('--oth'), y2026:css('--y26'), y2024:css('--y24'), y2022:css('--y22')});
const fmt = n => n==null||isNaN(n) ? '–' : Math.round(n).toLocaleString('en-US');
const fmtK = n => Math.abs(n)>=1e6 ? (n/1e6).toFixed(1)+'M' : Math.abs(n)>=1e3 ? Math.round(n/1e3)+'k' : String(Math.round(n));
const pct = (n,d,dp=1) => d ? (100*n/d).toFixed(dp)+'%' : '–';
const pts = (v,dp=1) => (v>0?'+':'')+v.toFixed(dp);
const sign = v => v>0?'up':v<0?'down':'';
const title = s => s.toLowerCase().replace(/\b\w/g, c=>c.toUpperCase());
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,'-');
const esc = s => String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const dateOf = (year, d) => { const ed = new Date(D.ed[year]+'T12:00:00'); ed.setDate(ed.getDate()-d); return ed; };
const fmtDate = dt => dt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
const fmtDateY = dt => dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});

const ST = D.state; // {name, abbr, party_note, pacing_note, unmatched_pct}
if (ST.other_label) PNAME.O = ST.other_label;
const ASOF = D.asof.d;
const COUNTIES = Object.keys(D.county['2026']).sort();
const SLUGS = Object.fromEntries(COUNTIES.map(c=>[slug(c), c]));

/* rows: [d, reqR,reqD,reqO, retR,retD,retO, eipR,eipD,eipO] */
function rowsFor(scope, year){ return scope==='STATE' ? D.daily[year] : (D.county[year][scope]||[]); }
function val(row, metric, party){
  const ps = party==='all' ? [0,1,2] : [PARTIES.indexOf(party)];
  let s = 0;
  for (const p of ps){
    if (metric==='ev') s += row[MBASE.ret+p] + row[MBASE.eip+p];
    else s += row[MBASE[metric]+p];
  }
  return s;
}
/* cumulative total for d >= dmin (dmin=null → everything in window) */
function cum(scope, year, metric, party, dmin){
  let s=0; for (const r of rowsFor(scope,year)) if (dmin==null || r[0]>=dmin) s += val(r,metric,party); return s;
}
/* cumulative series over d from dstart down to dend */
function cumSeries(scope, year, metric, party, dstart, dend){
  const rows = rowsFor(scope,year); const by = new Map(rows.map(r=>[r[0], r]));
  let s = 0;
  for (const r of rows) if (r[0] > dstart) s += val(r,metric,party);
  const out = [];
  for (let d=dstart; d>=dend; d--){ const r = by.get(d); if (r) s += val(r,metric,party); out.push({d, v:s}); }
  return out;
}
function dminOf(year){ return year==='2026' ? ASOF : 0; }
/* precinct rows: [code, regR,regD,regO, reqR,reqD,reqO, retR,retD,retO, eipR,eipD,eipO] */
function regFor(scope){
  const out={R:0,D:0,O:0};
  const cs = scope==='STATE' ? COUNTIES : [scope];
  for (const c of cs) for (const r of (D.precinct[c]||[])){ out.R+=r[1]; out.D+=r[2]; out.O+=r[3]; }
  return out;
}

/* ---------- SVG chart primitives ---------- */
const NS='http://www.w3.org/2000/svg';
function el(tag, attrs, parent){ const e=document.createElementNS(NS,tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
function niceTicks(max, n=5){
  if (max<=0) return [0];
  const raw = max/n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1,2,2.5,5,10].map(m=>m*mag).find(s=>max/s<=n) || 10*mag;
  const k = Math.ceil(max/step-1e-9); const out=[]; for (let i=0;i<=k;i++) out.push(+(i*step).toFixed(6)); return out;
}
/* Line chart: series = [{name,color,dash,pts:[{x,y,...}]}], x descending (days out) left→right */
function lineChart(box, cfg){
  box.innerHTML='';
  const W=640, H=cfg.height||300, m={t:14,r:16,b:34,l:48};
  const svg = el('svg',{viewBox:`0 0 ${W} ${H}`, role:'img', 'aria-label':cfg.aria||''}, box);
  const xs = cfg.xDomain; // [xmax(left) , xmin(right)]
  const allY = cfg.series.flatMap(s=>s.pts.map(p=>p.y));
  let yMax = cfg.yMax!=null ? cfg.yMax : Math.max(1, ...allY), yMin = cfg.yMin!=null ? cfg.yMin : Math.min(0, ...allY);
  if (cfg.symmetric){ const a=Math.max(Math.abs(yMax),Math.abs(yMin),1); yMax=a; yMin=-a; }
  const ticks = cfg.symmetric ? (()=>{const t=niceTicks(yMax,3); return [...t.slice(1).reverse().map(v=>-v), ...t];})() : niceTicks(yMax,5);
  if (!cfg.symmetric) yMax = ticks[ticks.length-1]; else { yMax = ticks[ticks.length-1]; yMin = -yMax; }
  const X = x => m.l + (xs[0]-x)/(xs[0]-xs[1]) * (W-m.l-m.r);
  const Y = y => m.t + (yMax-y)/(yMax-yMin) * (H-m.t-m.b);
  const g = el('g',{class:'grid'},svg);
  for (const t of ticks){ el('line',{x1:m.l,x2:W-m.r,y1:Y(t),y2:Y(t), ...(t===0?{stroke:'var(--line)','stroke-width':1.5}:{})},g); el('text',{x:m.l-8,y:Y(t)+4,'text-anchor':'end',class:'ax'},svg).textContent = (cfg.yFmt||fmtK)(t); }
  const xt = cfg.xTicks || (()=>{const o=[]; const step = (xs[0]-xs[1])>40?10:5; for (let d=Math.floor(xs[0]/step)*step; d>=xs[1]; d-=step) o.push(d); return o;})();
  for (const d of xt){ el('text',{x:X(d),y:H-m.b+16,'text-anchor':'middle',class:'ax'},svg).textContent = cfg.xFmt ? cfg.xFmt(d) : (d===0?'Election Day':d); }
  if (cfg.xTitle) el('text',{x:(m.l+W-m.r)/2,y:H-4,'text-anchor':'middle',class:'ax'},svg).textContent=cfg.xTitle;
  el('line',{x1:m.l,x2:W-m.r,y1:H-m.b,y2:H-m.b,class:'axis'},svg);
  // marker line (e.g. as-of)
  if (cfg.marker!=null && cfg.marker>=xs[1] && cfg.marker<=xs[0]){ el('line',{x1:X(cfg.marker),x2:X(cfg.marker),y1:m.t,y2:H-m.b,stroke:'var(--muted)','stroke-dasharray':'3 4'},svg); el('text',{x:X(cfg.marker)+4,y:m.t+10,class:'ax'},svg).textContent=cfg.markerLabel||''; }
  // spread end labels that would collide
  const ends = cfg.series.filter(s=>s.pts.length && s.endLabel).map(s=>({s, y:Y(s.pts[s.pts.length-1].y)})).sort((a,b)=>a.y-b.y);
  for (let i=1;i<ends.length;i++){ if (ends[i].y-ends[i-1].y<13) ends[i].y = ends[i-1].y+13; }
  for (const e of ends) e.s._ly = e.y;
  for (const s of cfg.series){
    if (!s.pts.length) continue;
    const dpath = s.pts.map((p,i)=>(i?'L':'M')+X(p.x).toFixed(1)+' '+Y(p.y).toFixed(1)).join(' ');
    if (s.area){ el('path',{d:dpath+` L${X(s.pts[s.pts.length-1].x).toFixed(1)} ${Y(0)} L${X(s.pts[0].x).toFixed(1)} ${Y(0)} Z`, fill:s.color, opacity:.08},svg); }
    el('path',{d:dpath, fill:'none', stroke:s.color, 'stroke-width':s.width||2.25, 'stroke-dasharray':s.dash||'none', 'stroke-linejoin':'round','stroke-linecap':'round'},svg);
    const last = s.pts[s.pts.length-1];
    el('circle',{cx:X(last.x),cy:Y(last.y),r:3.5,fill:s.color,stroke:'var(--surface)','stroke-width':2},svg);
    if (s.endLabel){ const t = el('text',{x:X(last.x)+(last.x<=xs[1]+3?-8:8),y:(s._ly!=null?s._ly:Y(last.y))+4,class:'lbl','text-anchor':last.x<=xs[1]+3?'end':'start',fill:s.color},svg); t.textContent=s.endLabel; }
  }
  // hover
  const tip = document.createElement('div'); tip.className='tip'; box.appendChild(tip);
  const cross = el('line',{y1:m.t,y2:H-m.b,stroke:'var(--muted)','stroke-width':1,opacity:0},svg);
  const dots = cfg.series.map(s=>el('circle',{r:4.5,fill:s.color,stroke:'#fff','stroke-width':1.5,opacity:0},svg));
  const xsAll = [...new Set(cfg.series.flatMap(s=>s.pts.map(p=>p.x)))].sort((a,b)=>b-a);
  function move(ev){
    const rect = svg.getBoundingClientRect(); const px = (ev.clientX-rect.left)/rect.width*W;
    const xv = xs[0] - (px-m.l)/(W-m.l-m.r)*(xs[0]-xs[1]);
    let best=xsAll[0], bd=1e9; for (const x of xsAll){ const dd=Math.abs(x-xv); if (dd<bd){bd=dd;best=x;} }
    cross.setAttribute('x1',X(best)); cross.setAttribute('x2',X(best)); cross.setAttribute('opacity',1);
    let html = `<b>${cfg.tipTitle ? cfg.tipTitle(best) : (best===0?'Election Day':best+' days out')}</b>`;
    cfg.series.forEach((s,i)=>{ const p=s.pts.find(q=>q.x===best); if (p){ dots[i].setAttribute('cx',X(p.x)); dots[i].setAttribute('cy',Y(p.y)); dots[i].setAttribute('opacity',1); html += `<div class="row"><span><i style="background:${s.color}"></i>${esc(s.name)}${p.date?' · '+esc(p.date):''}</span><span>${(cfg.tipFmt||fmt)(p.y, p)}</span></div>`; } else dots[i].setAttribute('opacity',0); });
    tip.innerHTML=html; tip.style.display='block';
    const bw = box.clientWidth, tx = (ev.clientX-rect.left); tip.style.left = Math.min(Math.max(0, tx + (tx>bw*0.6 ? -tip.offsetWidth-14 : 14)), bw-tip.offsetWidth) + 'px'; tip.style.top = Math.max(0,(ev.clientY-rect.top)-tip.offsetHeight-12)+'px';
  }
  function leave(){ tip.style.display='none'; cross.setAttribute('opacity',0); dots.forEach(d=>d.setAttribute('opacity',0)); }
  svg.addEventListener('pointermove',move); svg.addEventListener('pointerleave',leave);
}
/* Stacked bar chart over days: data=[{x, parts:{R,D,O}, date}] */
function stackChart(box, cfg){
  box.innerHTML='';
  const W=640, H=cfg.height||300, m={t:14,r:16,b:34,l:48};
  const svg = el('svg',{viewBox:`0 0 ${W} ${H}`, role:'img','aria-label':cfg.aria||''}, box);
  const data = cfg.data; const n = data.length; if (!n){ box.innerHTML='<p class="hint">No data yet.</p>'; return; }
  const tot = d => PARTIES.reduce((s,p)=>s+d.parts[p],0);
  const ticks = niceTicks(Math.max(1,...data.map(tot)),5); const yMax = ticks[ticks.length-1];
  const bw = (W-m.l-m.r)/n, pad = Math.min(4, bw*0.2);
  const X = i => m.l + i*bw; const Y = y => m.t + (yMax-y)/yMax*(H-m.t-m.b);
  const g = el('g',{class:'grid'},svg);
  for (const t of ticks){ el('line',{x1:m.l,x2:W-m.r,y1:Y(t),y2:Y(t)},g); el('text',{x:m.l-8,y:Y(t)+4,'text-anchor':'end',class:'ax'},svg).textContent=fmtK(t); }
  const C = COL();
  data.forEach((d,i)=>{
    let y0=0;
    for (const p of PARTIES){ const v=d.parts[p]; if (v>0){ const y1=y0+v; const r = el('rect',{x:X(i)+pad/2,width:Math.max(1,bw-pad),y:Y(y1),height:Math.max(0,Y(y0)-Y(y1)-1),fill:C[p]},svg); if (y1===tot(d)) r.setAttribute('rx',2); y0=y1; } }
    if (n<=40 || i%Math.ceil(n/14)===0){ el('text',{x:X(i)+bw/2,y:H-m.b+16,'text-anchor':'middle',class:'ax'},svg).textContent = cfg.xFmt(d); }
  });
  el('line',{x1:m.l,x2:W-m.r,y1:H-m.b,y2:H-m.b,class:'axis'},svg);
  if (cfg.xTitle) el('text',{x:(m.l+W-m.r)/2,y:H-4,'text-anchor':'middle',class:'ax'},svg).textContent=cfg.xTitle;
  const tip = document.createElement('div'); tip.className='tip'; box.appendChild(tip);
  const hl = el('rect',{y:m.t,height:H-m.t-m.b,fill:'var(--fg)',opacity:0},svg);
  svg.addEventListener('pointermove',ev=>{
    const rect=svg.getBoundingClientRect(); const px=(ev.clientX-rect.left)/rect.width*W; const i=Math.min(n-1,Math.max(0,Math.floor((px-m.l)/bw))); const d=data[i];
    hl.setAttribute('x',X(i)); hl.setAttribute('width',bw); hl.setAttribute('opacity',.06);
    const t=tot(d); tip.innerHTML = `<b>${esc(cfg.tipTitle(d))}</b>` + PARTIES.map(p=>`<div class="row"><span><i style="background:${C[p]}"></i>${PNAME[p]}</span><span>${fmt(d.parts[p])} · ${pct(d.parts[p],t,0)}</span></div>`).join('') + `<div class="row"><span>Total</span><span>${fmt(t)}</span></div>`;
    tip.style.display='block'; const bwid=box.clientWidth, tx=ev.clientX-rect.left; tip.style.left=Math.min(Math.max(0,tx+(tx>bwid*0.6?-tip.offsetWidth-14:14)),bwid-tip.offsetWidth)+'px'; tip.style.top=Math.max(0,(ev.clientY-rect.top)-tip.offsetHeight-12)+'px';
  });
  svg.addEventListener('pointerleave',()=>{tip.style.display='none'; hl.setAttribute('opacity',0);});
}
function legend(box, items){ box.innerHTML = items.map(it=>`<span><i class="${it.sq?'sq':''}${it.dash?' dash':''}" style="${it.dash?'color':'background'}:${it.color}"></i>${esc(it.name)}</span>`).join(''); }

/* ---------- state ---------- */
const state = { scope:'STATE', metric:'ev', party:'all', sort:{key:null,dir:-1}, q:'', mapMetric:'net', pmapMetric:'net', pfilter:null, heatMeasure:'count', heatCompare:'same', cmp24:true };
try { if (localStorage.getItem('cmp24')==='0') state.cmp24=false; } catch(e){}
const YRS = () => state.cmp24 ? YEARS : YEARS.filter(y=>y!=='2024');

function setScope(s, push=true){
  state.scope = s; state.q=''; state.sort={key:null,dir:-1}; state.pfilter=null;
  const sel = document.getElementById('scope'); if (sel.value!==s) sel.value=s;
  if (push){ try{ history.replaceState(null,'', s==='STATE' ? location.pathname+location.search : '#'+slug(s)); }catch(e){} }
  render();
}

/* ---------- render ---------- */
function render(){
  const sc = state.scope, C = COL();
  const name = sc==='STATE' ? ST.name : title(sc)+' County';
  document.getElementById('title').textContent = (sc==='STATE'?ST.name:title(sc)+' County, '+ST.name)+' Early Vote 2026';
  seg('cmp24', ['both','only22'], {both:'2024 + 2022', only22:'2022 only'}, state.cmp24?'both':'only22', v=>{ state.cmp24 = v==='both'; try{ localStorage.setItem('cmp24', state.cmp24?'1':'0'); }catch(e){} _cstats=null; render(); });
  const c24 = state.cmp24;
  const asofDt = dateOf('2026', ASOF);
  document.getElementById('subtitle').textContent = `Mail and early in-person voting through ${fmtDateY(asofDt)} · ${ASOF} days before the November 3 election`;
  /* headline numbers */
  const ev26 = cum(sc,'2026','ev','all',ASOF), ret26=cum(sc,'2026','ret','all',ASOF), eip26=cum(sc,'2026','eip','all',ASOF), req26=cum(sc,'2026','req','all',ASOF);
  const same = y => cum(sc,y,'ev','all',ASOF), fin = y => cum(sc,y,'ev','all',null);
  const ev24s=same('2024'), ev22s=same('2022'), ev24f=fin('2024'), ev22f=fin('2022');
  const byP = (y,dmin) => Object.fromEntries(PARTIES.map(p=>[p, cum(sc,y,'ev',p,dmin)]));
  const p26=byP('2026',ASOF), p24s=byP('2024',ASOF), p22s=byP('2022',ASOF), p24f=byP('2024',null), p22f=byP('2022',null);
  const net = o => { const t=o.R+o.D+o.O; return t? 100*(o.R-o.D)/t : 0; };
  const reg = regFor(sc); const regT = reg.R+reg.D+reg.O;
  const chg = (a,b) => b ? `<b class="${sign(a-b)}">${pts(100*(a-b)/b,0)}%</b> vs ${fmt(b)}` : '–';
  document.getElementById('chips').innerHTML = [`${fmt(regT)} registered voters`, sc==='STATE'?`${COUNTIES.length} counties`:`${(D.precinct[sc]||[]).length} precincts`, `Updated ${D.built}`].map(t=>`<span class="chip">${esc(t)}</span>`).join('');
  const kp = [
    {l:'Early votes cast', v:fmt(ev26), d:`${c24?`<span>${chg(ev26,ev24s)} in 2024 at this point</span>`:''}<span>${chg(ev26,ev22s)} in 2022${c24?'':' at this point'}</span>`},
    c24 ? {l:'Share of 2024 final early vote', v:pct(ev26,ev24f,0), d:`<span>2024 finished at <b>${fmt(ev24f)}</b></span><span>2024 was at <b>${pct(ev24s,ev24f,0)}</b> of its final at this point</span>`}
        : {l:'Share of 2022 final early vote', v:pct(ev26,ev22f,0), d:`<span>2022 finished at <b>${fmt(ev22f)}</b></span><span>2022 was at <b>${pct(ev22s,ev22f,0)}</b> of its final at this point</span>`},
    {l:'Mail ballots returned', v:fmt(ret26), d:`${c24?`<span>${chg(ret26,cum(sc,'2024','ret','all',ASOF))} in 2024 at this point</span>`:''}<span>${chg(ret26,cum(sc,'2022','ret','all',ASOF))} in 2022${c24?'':' at this point'}</span>`},
    ST.no_requests ? {l:'Mail share of early vote', v:pct(ret26,ev26,0), d:`<span>2022 at this point <b>${pct(cum(sc,'2022','ret','all',ASOF),cum(sc,'2022','ev','all',ASOF),0)}</b>${c24?` · 2024 <b>${pct(cum(sc,'2024','ret','all',ASOF),cum(sc,'2024','ev','all',ASOF),0)}</b>`:''}</span>`} :
    {l:'Mail ballots outstanding', v:fmt(req26-ret26), d:`<span><b>${fmt(req26)}</b> requested · return rate <b>${pct(ret26,req26,0)}</b></span><span>${c24?'2024':'2022'} return rate at this point <b>${c24?pct(cum(sc,'2024','ret','all',ASOF),cum(sc,'2024','req','all',ASOF),0):pct(cum(sc,'2022','ret','all',ASOF),cum(sc,'2022','req','all',ASOF),0)}</b></span>`},
    {l:'Early in-person votes', v:fmt(eip26), d:`${c24?`<span>${chg(eip26,cum(sc,'2024','eip','all',ASOF))} in 2024 at this point</span>`:''}<span>${chg(eip26,cum(sc,'2022','eip','all',ASOF))} in 2022${c24?'':' at this point'}</span>`},
    {l:'Partisan split of early votes', v:`<span style="color:${C.R}">${pct(p26.R,ev26,0)}</span><small>R</small> <span style="color:${C.D}">${pct(p26.D,ev26,0)}</span><small>D</small>`, d:`<span>${PNAME.O} <b>${pct(p26.O,ev26,0)}</b></span>`, bar:p26},
    {l:'Net Republican minus Democratic', v:`<span class="${sign(net(p26))}">${pts(net(p26))}</span><small>pts</small>`, d:`${c24?`<span>2024 at this point <b>${pts(net(p24s))}</b> · final <b>${pts(net(p24f))}</b></span>`:''}<span>2022 at this point <b>${pts(net(p22s))}</b> · final <b>${pts(net(p22f))}</b></span>`},
    {l:'Share of registered voters', v:pct(ev26,regT), d:`<span>Rep <b>${pct(p26.R,reg.R)}</b> · Dem <b>${pct(p26.D,reg.D)}</b> · Other <b>${pct(p26.O,reg.O)}</b></span>`},
  ];
  document.getElementById('kpis').innerHTML = kp.map(k=>`<div class="kpi"><div class="l">${k.l}</div><div class="v num">${k.v}</div>${k.bar?`<div class="party-bar" aria-hidden="true"><span class="pr" style="flex:${k.bar.R}"></span><span class="pd" style="flex:${k.bar.D}"></span><span class="po" style="flex:${k.bar.O}"></span></div>`:''}<div class="d num">${k.d}</div></div>`).join('');

  /* pacing chart */
  seg('pace-metric', ['ev','ret','eip','req'], MSHORT, state.metric, v=>{state.metric=v; render();});
  seg('pace-party', ['all','R','D','O'], {all:'All', R:'Rep', D:'Dem', O:'Other'}, state.party, v=>{state.party=v; render();});
  const xStart = state.metric==='req' ? 60 : 32;
  const pname = state.party==='all' ? '' : ' · '+PNAME[state.party];
  document.getElementById('pace-title').textContent = `Cumulative ${MNAME[state.metric].toLowerCase()}${pname}`;
  document.getElementById('pace-h2').innerHTML = `Pacing against ${c24?'2024 and 2022':'2022'} <small>cumulative, by days before Election Day</small>`;
  const series = YRS().map(y=>{ const pts_ = cumSeries(sc,y,state.metric,state.party,xStart,dminOf(y)).map(p=>({x:p.d,y:p.v,date:fmtDate(dateOf(y,p.d))})); return {name:y, color:C['y'+y], dash:y==='2022'?'6 5':(y==='2024'?'2 4':null), width:y==='2026'?3:2, pts:pts_, endLabel:y, labelDy:y==='2024'?-6:(y==='2022'?12:4)}; });
  lineChart(document.getElementById('pace-chart'), {series, xDomain:[xStart,0], xTitle:'Days before Election Day', marker:ASOF, markerLabel:'latest 2026 data', aria:'Cumulative pacing chart', tipFmt:(v,p)=>fmt(v)});
  const yearLegend = [{name:'2026',color:C.y2026},{name:'2024',color:C.y2024},{name:'2022 (dashed)',color:C.y2022,dash:true}].filter(l=>c24||l.name!=='2024');
  legend(document.getElementById('pace-legend'), yearLegend);

  /* daily stacked bars, 2026 */
  const rows26 = rowsFor(sc,'2026').filter(r=>r[0]>=ASOF && r[0]<=30).sort((a,b)=>b[0]-a[0]);
  const dmetric = state.metric==='req' ? 'req' : state.metric;
  document.getElementById('daily-title').textContent = `Each day in 2026 · ${MSHORT[dmetric].toLowerCase()}`;
  stackChart(document.getElementById('daily-chart'), {data: rows26.map(r=>({x:r[0], parts:Object.fromEntries(PARTIES.map(p=>[p, val(r,dmetric,p)])), date:dateOf('2026',r[0])})), xFmt:d=>d.date.toLocaleDateString('en-US',{month:'numeric',day:'numeric'}), tipTitle:d=>`${fmtDate(d.date)} · ${d.x} days out`, xTitle:'Date (weekends have little or no early voting)', aria:'Daily early votes by party'});
  legend(document.getElementById('daily-legend'), PARTIES.map(p=>({name:PNAME[p],color:C[p],sq:true})));

  /* shares */
  const shareRows = [['2026 so far',p26,`${ASOF} days out`],['2024 same point',p24s,`${ASOF} days out`],['2024 final',p24f,'all early votes'],['2022 same point',p22s,`${ASOF} days out`],['2022 final',p22f,'all early votes']].filter(r=>c24||!r[0].startsWith('2024'));
  document.getElementById('shares').innerHTML = shareRows.map(([lab,o,sub])=>{ const t=o.R+o.D+o.O||1; return `<div class="share"><div class="lab">${lab}<small>${sub} · ${fmt(t)}</small></div><div class="bar" role="img" aria-label="${lab}: Republican ${pct(o.R,t,0)}, Democratic ${pct(o.D,t,0)}, Other ${pct(o.O,t,0)}">${PARTIES.map(p=>`<span style="flex:${o[p]};background:${C[p]}">${o[p]/t>0.09?pct(o[p],t,0):''}</span>`).join('')}</div><div class="net num ${sign(net(o))}">${pts(net(o))}</div></div>`; }).join('');

  /* net chart */
  const netSeries = YRS().map(y=>{ const r=cumSeries(sc,y,'ev','R',32,dminOf(y)), d_=cumSeries(sc,y,'ev','D',32,dminOf(y)), o=cumSeries(sc,y,'ev','O',32,dminOf(y)); const pts_=[]; for (let i=0;i<r.length;i++){ const t=r[i].v+d_[i].v+o[i].v; if (t>=50) pts_.push({x:r[i].d, y:100*(r[i].v-d_[i].v)/t, date:fmtDate(dateOf(y,r[i].d))}); } return {name:y,color:C['y'+y],dash:y==='2022'?'6 5':(y==='2024'?'2 4':null),width:y==='2026'?3:2,pts:pts_,endLabel:y}; });
  lineChart(document.getElementById('net-chart'), {series:netSeries, xDomain:[32,0], symmetric:true, yFmt:v=>pts(v,0), tipFmt:v=>pts(v)+' pts', xTitle:'Days before Election Day', marker:ASOF, markerLabel:'latest 2026 data', aria:'Net Republican minus Democratic share by year', height:260});
  legend(document.getElementById('net-legend'), yearLegend);

  /* daily mix */
  const mixRows = rowsFor(sc,'2026').filter(r=>r[0]>=ASOF && r[0]<=30 && val(r,'ev','all')>=100).sort((a,b)=>b[0]-a[0]);
  const mixSeries = PARTIES.map(p=>({name:PNAME[p], color:C[p], pts:mixRows.map(r=>({x:r[0], y:100*val(r,'ev',p)/val(r,'ev','all'), date:fmtDate(dateOf('2026',r[0]))})), endLabel:PSHORT[p]}));
  if (mixRows.length) lineChart(document.getElementById('mix-chart'), {series:mixSeries, xDomain:[Math.max(...mixRows.map(r=>r[0])),Math.min(...mixRows.map(r=>r[0]))], yMax:Math.min(100, Math.ceil(Math.max(...mixSeries.flatMap(s=>s.pts.map(p=>p.y)))/10)*10+10), yFmt:v=>v+'%', tipFmt:v=>v.toFixed(1)+'%', xTitle:'Days before Election Day (days with fewer than 100 votes omitted)', aria:'Daily party mix', height:260});
  else document.getElementById('mix-chart').innerHTML='<p class="hint">Not enough daily volume yet.</p>';
  legend(document.getElementById('mix-legend'), PARTIES.map(p=>({name:PNAME[p],color:C[p]})));

  /* turnout by party (horizontal bars) */
  turnoutChart(document.getElementById('turnout-chart'), PARTIES.map(p=>({p, reg:reg[p], ev:p26[p], ret:cum(sc,'2026','ret',p,ASOF), eip:cum(sc,'2026','eip',p,ASOF)})));
  document.getElementById('turnout-hint').textContent = `Registered voters from the current voter file (${fmt(regT)} in ${name}). Early votes here count only records that match a voter in the file.`;

  /* heat table, map + table */
  heatTable();
  renderMap();
  if (sc==='STATE'){ document.getElementById('s-pmap').hidden=true; countyTable(); }
  else { precinctTable(sc); renderPrecinctMap(sc); }
  methodology();
}

function seg(id, keys, names, cur, on){
  const box = document.getElementById(id); box.innerHTML = keys.map(k=>`<button type="button" id="${id}-${k}" aria-pressed="${k===cur}">${names[k]}</button>`).join('');
  keys.forEach(k=>box.querySelector('#'+id+'-'+k).addEventListener('click',()=>on(k)));
}

function turnoutChart(box, rows){
  box.innerHTML=''; const C=COL(); const W=640, H=170, m={t:8,r:70,b:24,l:150};
  const svg=el('svg',{viewBox:`0 0 ${W} ${H}`,role:'img','aria-label':'Early-vote turnout by party'},box);
  const max = Math.max(0.05, ...rows.map(r=>r.reg?r.ev/r.reg:0)); const ticks=niceTicks(max*100,4); const xMax=ticks[ticks.length-1]/100;
  const X=v=>m.l+v/xMax*(W-m.l-m.r); const bh=(H-m.t-m.b)/rows.length;
  const g=el('g',{class:'grid'},svg); for (const t of ticks){ el('line',{x1:X(t/100),x2:X(t/100),y1:m.t,y2:H-m.b},g); el('text',{x:X(t/100),y:H-m.b+14,'text-anchor':'middle',class:'ax'},svg).textContent=t+'%'; }
  rows.forEach((r,i)=>{ const y=m.t+i*bh+bh*0.2, h=bh*0.6; const v=r.reg?r.ev/r.reg:0;
    el('text',{x:m.l-10,y:y+h/2+4,'text-anchor':'end',class:'lbl'},svg).textContent=PNAME[r.p];
    el('rect',{x:m.l,y,width:Math.max(0,X(v)-m.l),height:h,fill:C[r.p],rx:3},svg);
    const t=el('text',{x:X(v)+8,y:y+h/2+4,class:'lbl'},svg); t.textContent=(100*v).toFixed(1)+'%';
    const t2=el('text',{x:m.l-10,y:y+h+14,'text-anchor':'end',class:'ax'},svg); t2.textContent=`${fmt(r.ev)} of ${fmt(r.reg)}`;
  });
}

/* ---------- tables ---------- */
function sortable(cols, rows, foot, onRow){
  const tbl=document.getElementById('tbl'); const thead=tbl.querySelector('thead'), tbody=tbl.querySelector('tbody'), tfoot=tbl.querySelector('tfoot');
  if (!state.sort.key) state.sort={key:cols.find(c=>c.defaultSort)?.key||cols[1].key, dir:-1};
  thead.innerHTML='<tr>'+cols.map(c=>`<th scope="col" data-key="${c.key}" aria-sort="${state.sort.key===c.key?(state.sort.dir<0?'descending':'ascending'):'none'}" title="${esc(c.tip||'')}">${c.label}</th>`).join('')+'</tr>';
  thead.querySelectorAll('th').forEach(th=>th.addEventListener('click',()=>{ const k=th.dataset.key; state.sort = state.sort.key===k ? {key:k,dir:-state.sort.dir} : {key:k,dir:cols.find(c=>c.key===k).text?1:-1}; render(); }));
  const col = Object.fromEntries(cols.map(c=>[c.key,c]));
  const sorted = rows.slice().sort((a,b)=>{ const k=state.sort.key, va=a[k], vb=b[k]; if (col[k].text) return state.sort.dir*String(va).localeCompare(String(vb)); return state.sort.dir*((va??-Infinity)-(vb??-Infinity)); });
  tbody.innerHTML = sorted.map(r=>`<tr class="${onRow?'link':''}" data-id="${esc(r.id)}">`+cols.map(c=>`<td class="num">${c.fmt?c.fmt(r[c.key],r):esc(r[c.key])}</td>`).join('')+'</tr>').join('');
  if (onRow) tbody.querySelectorAll('tr').forEach(tr=>tr.addEventListener('click',()=>onRow(tr.dataset.id)));
  tfoot.innerHTML = foot ? '<tr>'+cols.map(c=>`<td class="num">${c.fmt&&foot[c.key]!=null?c.fmt(foot[c.key],foot):esc(foot[c.key]??'')}</td>`).join('')+'</tr>' : '';
}
const netCell = v => { if (v==null) return '–'; const w=Math.min(50,Math.abs(v)); return `<span class="netcell"><span class="${sign(v)}">${pts(v)}</span><span class="bar"><span style="${v>=0?'left:50%':'right:50%'};width:${w}%;background:${v>=0?css('--rep'):css('--dem')}"></span></span></span>`; };
const pctCell = v => v==null?'–':v.toFixed(1)+'%';
const chgCell = v => v==null?'–':`<span class="${sign(v)}">${pts(v,0)}%</span>`;

let _cstats = null;
function countyStats(){
  if (_cstats) return _cstats;
  _cstats = COUNTIES.map(c=>{
    const ev=cum(c,'2026','ev','all',ASOF), s24=cum(c,'2024','ev','all',ASOF), s22=cum(c,'2022','ev','all',ASOF), f24=cum(c,'2024','ev','all',null);
    const P=Object.fromEntries(PARTIES.map(p=>[p,cum(c,'2026','ev',p,ASOF)])), P24=Object.fromEntries(PARTIES.map(p=>[p,cum(c,'2024','ev',p,ASOF)])), P22=Object.fromEntries(PARTIES.map(p=>[p,cum(c,'2022','ev',p,ASOF)]));
    const t24=P24.R+P24.D+P24.O, t22=P22.R+P22.D+P22.O; const reg=regFor(c); const regT=reg.R+reg.D+reg.O;
    const n26 = ev?100*(P.R-P.D)/ev:null, n24 = t24?100*(P24.R-P24.D)/t24:null, n22 = t22?100*(P22.R-P22.D)/t22:null;
    return {id:c, county:title(c), ev, ret:cum(c,'2026','ret','all',ASOF), eip:cum(c,'2026','eip','all',ASOF), v24:s24?100*(ev-s24)/s24:null, v22:s22?100*(ev-s22)/s22:null, of24:f24?100*ev/f24:null, turnout:regT?100*ev/regT:null, reg:regT, rp:ev?100*P.R/ev:null, dp:ev?100*P.D/ev:null, op:ev?100*P.O/ev:null, net:n26, net24:n24, shift:(n26!=null&&n24!=null)?n26-n24:null, net22:n22, shift22:(n26!=null&&n22!=null)?n26-n22:null, of22:(()=>{const f22=cum(c,'2022','ev','all',null); return f22?100*ev/f22:null;})()};
  });
  return _cstats;
}


/* ---------- party x vote history heat table ---------- */
const HEATM = { share:{name:'Early votes so far as a share of registered voters', fmt:v=>v.toFixed(1)+'%'}, count:{name:'Early votes so far', fmt:v=>fmt(v)}, mix:{name:'Share of all early votes so far', fmt:v=>v.toFixed(1)+'%'} };
const HISTN = ['0 of 4','1 of 4','2 of 4','3 of 4','4 of 4'];
function heatCells(year, scope){
  // returns {R:{0:{reg,ev,evf},...},D:..,O:..} summed over scope
  const src = D.heat[year]; const cols = src.cols; const iReg=cols.indexOf('reg'), iEv=cols.indexOf('ev_now'), iF=cols.indexOf('ev_final');
  const out = {}; for (const p of PARTIES){ out[p]={}; for (let h=0;h<5;h++) out[p][h]={reg:0,ev:0,evf:0}; }
  const cs = scope==='STATE' ? Object.keys(src.data) : [scope];
  for (const c of cs){ const cd=src.data[c]||{}; for (const p of PARTIES) for (const row of (cd[p]||[])){ const o=out[p][row[0]]; o.reg+=row[iReg]; o.ev+=row[iEv]; o.evf+= iF>=0 ? row[iF] : 0; } }
  return out;
}
function heatTable(){
  seg('heat-measure', ['share','count','mix'], {share:'% of registered', count:'Votes', mix:'% of early vote'}, state.heatMeasure, v=>{state.heatMeasure=v; heatTable();});
  seg('heat-compare', ['same','final'], {same:'vs 2022 same point', final:'vs 2022 final'}, state.heatCompare, v=>{state.heatCompare=v; heatTable();});
  const sc=state.scope, m=HEATM[state.heatMeasure], C=COL();
  const A=heatCells('2026',sc), B=heatCells('2022',sc); const useF = state.heatCompare==='final';
  const get = (cells,p,h,fin)=>{ let reg=0,ev=0; const ps=p==='all'?PARTIES:[p]; const hs=h==='all'?[0,1,2,3,4]:[h]; for (const pp of ps) for (const hh of hs){ reg+=cells[pp][hh].reg; ev+= fin ? cells[pp][hh].evf : cells[pp][hh].ev; } return {reg,ev}; };
  const totA = get(A,'all','all',false).ev, totB = get(B,'all','all',useF).ev;
  const val = (o,tot)=> state.heatMeasure==='share' ? (o.reg?100*o.ev/o.reg:null) : state.heatMeasure==='count' ? o.ev : (tot?100*o.ev/tot:null);
  const rows=[...PARTIES,'all'], cols=[0,1,2,3,4,'all'];
  // scale for the diverging fill: difference 2026 - 2022 in the measure's own units
  const diffs=[]; for (const p of rows) for (const h of cols){ const a=val(get(A,p,h,false),totA), b=val(get(B,p,h,useF),totB); if (a!=null&&b!=null) diffs.push(state.heatMeasure==='count' ? (b?100*(a-b)/b:0) : a-b); }
  const q=(arr,pp)=>{ const s=arr.slice().sort((x,y)=>x-y); return s.length? s[Math.min(s.length-1,Math.floor(pp*(s.length-1)))]:1; };
  const abs=Math.max(0.5, q(diffs.map(Math.abs),0.9)); const col={neg:css('--y24'), mid:css('--surface2'), pos:css('--y26')};
  document.getElementById('heat-title').textContent = m.name + (useF ? ', 2026 so far vs 2022 final' : ', 2026 vs 2022 at the same point');
  document.getElementById('heat-sub').textContent = `${sc==='STATE'?ST.name:title(sc)+' County'} · ${fmtDate(dateOf('2026',ASOF))} (${ASOF} days out)`;
  let html = `<thead><tr><th>${(ST.party_label||'registered party').replace(/^./,c=>c.toUpperCase())} \\ generals voted (last 4)</th>` + cols.map(h=>`<th>${h==='all'?'All voters':HISTN[h]}</th>`).join('') + '</tr></thead><tbody>';
  for (const p of rows){
    const regAll=get(A,p,'all',false).reg;
    html += `<tr class="${p==='all'?'tot':''}"><th>${p==='all'?'All parties':PNAME[p]}<small>${fmt(regAll)} registered</small></th>`;
    for (const h of cols){
      const oa=get(A,p,h,false), ob=get(B,p,h,useF); const a=val(oa,totA), b=val(ob,totB);
      const diff = (a==null||b==null) ? null : (state.heatMeasure==='count' ? (ob.ev?100*(a-b)/b:null) : a-b);
      const t = diff==null ? 0 : Math.max(-1,Math.min(1,diff/abs)); const bg = t<0 ? mix(col.mid,col.neg,Math.pow(-t,0.8)) : mix(col.mid,col.pos,Math.pow(t,0.8));
      const dark = Math.abs(t)>0.55;
      const dlabel = diff==null?'–': state.heatMeasure==='count' ? pts(diff,0)+'%' : pts(diff,1)+' pts';
      html += `<td class="num${h==='all'?' tot':''}${dark?' dark':''}" style="background:${bg};${dark?'color:#fff':''}" title="2026: ${fmt(oa.ev)} of ${fmt(oa.reg)} registered · 2022${useF?' final':''}: ${fmt(ob.ev)} of ${fmt(ob.reg)}"><span class="v">${a==null?'–':m.fmt(a)}</span><span class="c">2022: ${b==null?'–':m.fmt(b)}</span><span class="d">${dlabel}</span></td>`;
    }
    html += '</tr>';
  }
  document.getElementById('heat').innerHTML = html + '</tbody>';
  document.getElementById('heat-legend').innerHTML = `<span><i class="sq" style="background:${col.neg}"></i>Behind 2022</span><span><i class="sq" style="background:${col.mid}"></i>Even</span><span><i class="sq" style="background:${col.pos}"></i>Ahead of 2022</span><span>Shading is the 2026 − 2022 difference in each cell (${state.heatMeasure==='count'?'percent change':'points'}); the chip in each cell gives the number.</span>`;
  document.getElementById('heat-hint').textContent = `Vote history is how many of the four general elections before each cycle the voter took part in (2026: 2018–2024; 2022: 2014–2020), from that year's voter file, so the rows compare like with like. Registered counts are all voters in each year's file. Early votes here count only records that match a voter in the file, so totals run slightly below the headline figures. "Same point" is ${ASOF} days before Election Day in both years.`;
}

/* ---------- county map ---------- */
const MAPM = {
  net:     {name:'Net R−D of early votes', unit:'pts', type:'div', fmt:v=>pts(v,1)+' pts', key:'net', neg:'D', pos:'R', ends:['More Democratic','More Republican']},
  shift:   {name:'Shift in net R−D vs 2024 at this point', unit:'pts', type:'div', fmt:v=>pts(v,1)+' pts', key:'shift', neg:'D', pos:'R', ends:['Moved toward Dems','Moved toward GOP']},
  v24:     {name:'Early votes vs 2024 at this point', unit:'%', type:'div', fmt:v=>pts(v,0)+'%', key:'v24', neg:'Y', pos:'B', ends:['Behind 2024','Ahead of 2024']},
  turnout: {name:'Early votes as share of registered voters', unit:'%', type:'seq', fmt:v=>v.toFixed(1)+'%', key:'turnout', ends:['Lower','Higher']},
  shift22: {name:'Shift in net R−D vs 2022 at this point', unit:'pts', type:'div', fmt:v=>pts(v,1)+' pts', key:'shift22', neg:'D', pos:'R', ends:['Moved toward Dems','Moved toward GOP']},
  v22:     {name:'Early votes vs 2022 at this point', unit:'%', type:'div', fmt:v=>pts(v,0)+'%', key:'v22', neg:'Y', pos:'B', ends:['Behind 2022','Ahead of 2022']},
};
function hex2rgb(h){ h=h.replace('#',''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
function mix(a,b,t){ const A=hex2rgb(a),B=hex2rgb(b); return 'rgb('+A.map((v,i)=>Math.round(v+(B[i]-v)*t)).join(',')+')'; }
function mapColors(m){
  const C=COL(); const mid = css('--surface2')||'#EDF1F4';
  if (m.type==='seq') return {lo:mid, hi:css('--y26')};
  const negC = m.neg==='D' ? C.D : css('--y24'); const posC = m.pos==='R' ? C.R : css('--y26');
  return {neg:negC, mid, pos:posC};
}
function colorFor(m, v, scale){
  if (v==null || isNaN(v)) return css('--line');
  const col = mapColors(m);
  if (m.type==='seq'){ const t=Math.max(0,Math.min(1,(v-scale.min)/(scale.max-scale.min||1))); return mix(col.lo, col.hi, Math.pow(t,0.8)); }
  const t=Math.max(-1,Math.min(1, v/scale.abs)); return t<0 ? mix(col.mid,col.neg,Math.pow(-t,0.7)) : mix(col.mid,col.pos,Math.pow(t,0.7));
}
function renderMap(){
  if (!state.cmp24 && state.mapMetric==='shift') state.mapMetric='shift22'; if (!state.cmp24 && state.mapMetric==='v24') state.mapMetric='v22'; if (state.cmp24 && state.mapMetric==='shift22') state.mapMetric='shift'; if (state.cmp24 && state.mapMetric==='v22') state.mapMetric='v24';
  const m = MAPM[state.mapMetric]; const rows = countyStats(); const byId = Object.fromEntries(rows.map(r=>[r.id,r]));
  seg('map-metric', state.cmp24 ? ['net','shift','v24','turnout'] : ['net','shift22','v22','turnout'], {net:'Net R−D', shift:'Shift vs 2024', v24:'Pace vs 2024', shift22:'Shift vs 2022', v22:'Pace vs 2022', turnout:'% of registered'}, state.mapMetric, v=>{state.mapMetric=v; renderMap();});
  document.getElementById('map-title').textContent = m.name;
  const vals = rows.map(r=>r[m.key]).filter(v=>v!=null);
  const q = (arr,p)=>{ const s=arr.slice().sort((a,b)=>a-b); return s[Math.min(s.length-1,Math.floor(p*(s.length-1)))]; };
  const scale = m.type==='seq' ? {min:q(vals,0.02), max:q(vals,0.98)} : {abs: Math.max(1, q(vals.map(Math.abs),0.95))};
  const box = document.getElementById('map'); box.innerHTML='';
  const G = D.geo; const svg = el('svg',{viewBox:`0 0 ${G.w} ${G.h}`, role:'img','aria-label':ST.name+' county map: '+m.name},box);
  const sel = state.scope;
  const col = mapColors(m);
  for (const c of COUNTIES){
    const r = byId[c]; const p = el('path',{d:G.paths[c], class:'county'+(c===sel?' sel':''), fill:colorFor(m, r[m.key], scale), 'data-c':c, tabindex:0, role:'button','aria-label':`${title(c)} County, ${m.fmt(r[m.key]??0)}`},svg);
    p.addEventListener('mouseenter',()=>mapInfo(c)); p.addEventListener('mouseleave',()=>mapInfo(null));
    p.addEventListener('click',()=>{ setScope(c); document.getElementById('s-counties').scrollIntoView({behavior:'smooth'}); });
    p.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); setScope(c); } });
  }
  if (sel!=='STATE'){ svg.appendChild(svg.querySelector(`[data-c="${sel}"]`)); }
  // labels for the biggest counties
  rows.slice().sort((a,b)=>b.reg-a.reg).slice(0,14).forEach(r=>{ const [x,y]=G.centroids[r.id]; el('text',{x,y:y+3,class:'county-label'},svg).textContent = title(r.id); });
  const lg = document.getElementById('map-legend');
  if (m.type==='seq') lg.innerHTML = `<div class="ramp seq" style="--l0:${col.lo};--l2:${col.hi}"></div><div class="ends"><span>${m.ends[0]} · ${m.fmt(scale.min)}</span><span>${m.ends[1]} · ${m.fmt(scale.max)}</span></div>`;
  else lg.innerHTML = `<div class="ramp" style="--l0:${col.neg};--l1:${col.mid};--l2:${col.pos}"></div><div class="ends"><span>${m.ends[0]} · ${m.fmt(-scale.abs)}</span><span>0</span><span>${m.ends[1]} · ${m.fmt(scale.abs)}</span></div>`;
  mapInfo(null);
}
function mapInfo(c){
  const target = c || (state.scope!=='STATE' ? state.scope : null); const box = document.getElementById('map-info');
  if (!target){ const rows=countyStats(); const m=MAPM[state.mapMetric]; const top=rows.filter(r=>r[m.key]!=null).sort((a,b)=>b[m.key]-a[m.key]);
    box.innerHTML = `<div class="big">${ST.name}<small>${COUNTIES.length} counties</small></div><p class="hint" style="margin:0 0 8px">Hover a county for its numbers; click to open its precincts.</p><dl><dt>Highest</dt><dd>${top[0].county} · ${m.fmt(top[0][m.key])}</dd><dt>Lowest</dt><dd>${top[top.length-1].county} · ${m.fmt(top[top.length-1][m.key])}</dd></dl>`; return; }
  const r = countyStats().find(x=>x.id===target); const C=COL();
  box.innerHTML = `<div class="big">${r.county} County<small>${fmt(r.reg)} registered</small></div>
  <div class="party-bar" aria-hidden="true" style="margin-bottom:8px"><span class="pr" style="flex:${r.rp||0}"></span><span class="pd" style="flex:${r.dp||0}"></span><span class="po" style="flex:${r.op||0}"></span></div>
  <dl><dt>Early votes</dt><dd>${fmt(r.ev)}</dd><dt>Mail returned</dt><dd>${fmt(r.ret)}</dd><dt>In person</dt><dd>${fmt(r.eip)}</dd>${state.cmp24?`<dt>vs 2024 same point</dt><dd class="${sign(r.v24)}">${r.v24==null?'–':pts(r.v24,0)+'%'}</dd>`:''}<dt>vs 2022 same point</dt><dd class="${sign(r.v22)}">${r.v22==null?'–':pts(r.v22,0)+'%'}</dd><dt>Rep / Dem / Other</dt><dd><span style="color:${C.R}">${pctCell(r.rp)}</span> / <span style="color:${C.D}">${pctCell(r.dp)}</span> / ${pctCell(r.op)}</dd><dt>Net R−D</dt><dd class="${sign(r.net)}">${r.net==null?'–':pts(r.net)} pts</dd><dt>${state.cmp24?'2024':'2022'} net at this point</dt><dd>${(state.cmp24?r.net24:r.net22)==null?'–':pts(state.cmp24?r.net24:r.net22)} pts</dd><dt>Share of registered</dt><dd>${pctCell(r.turnout)}</dd></dl>
  <button type="button" class="open" id="map-open">Open ${r.county} County precincts →</button>`;
  box.querySelector('#map-open').addEventListener('click',()=>{ setScope(target); document.getElementById('s-counties').scrollIntoView({behavior:'smooth'}); });
}

/* ---------- precinct map (geometry fetched per county from precincts/<COUNTY>.json) ---------- */
const PMAPM = {
  net:     {name:'Net R−D of 2026 early votes', type:'div', fmt:v=>pts(v,1)+' pts', neg:'D', pos:'R', ends:['More Democratic','More Republican']},
  turnout: {name:'2026 early votes as share of registered voters', type:'seq', fmt:v=>v.toFixed(1)+'%', ends:['Lower','Higher']},
  regnet:  {name:(ST.party_label==='modeled party'?'Modeled party: net R−D share of registered voters':'Registration: net R−D share of registered voters'), type:'div', fmt:v=>pts(v,1)+' pts', neg:'D', pos:'R', ends:['More Democratic','More Republican']},
  pres24:  {name:'2024 presidential margin (Trump minus Harris)', type:'div', fmt:v=>pts(v,1)+' pts', neg:'D', pos:'R', ends:['Harris','Trump']},
};
const _pgeo = {}; let _pmapReq = 0;
function precinctRows(c){
  return (D.precinct[c]||[]).map(r=>({code:r[0], reg:r[1]+r[2]+r[3], regR:r[1], regD:r[2], R:r[7]+r[10], Dm:r[8]+r[11], O:r[9]+r[12], ret:r[7]+r[8]+r[9], eip:r[10]+r[11]+r[12], req:r[4]+r[5]+r[6]}));
}
function shapeStats(sh, byCode){
  const s={reg:0,regR:0,regD:0,R:0,Dm:0,O:0,ret:0,eip:0,req:0}; for (const code of sh.p){ const r=byCode[code]; if (r) for (const k in s) s[k]+=r[k]; }
  const ev=s.R+s.Dm+s.O;
  return {...s, ev, net: ev?100*(s.R-s.Dm)/ev:null, turnout: s.reg?100*ev/s.reg:null, regnet: s.reg?100*(s.regR-s.regD)/s.reg:null, pres24: sh.tot?100*(sh.rep-sh.dem)/sh.tot:null};
}
async function renderPrecinctMap(c){
  const sec=document.getElementById('s-pmap'); sec.hidden=false;
  document.getElementById('pmap-h2').innerHTML = `${title(c)} County precinct map <small>click a precinct to find it in the table</small>`;
  seg('pmap-metric', Object.keys(PMAPM), {net:'Net R−D', turnout:'% of registered', regnet:'Registration', pres24:'2024 president'}, state.pmapMetric, v=>{state.pmapMetric=v; renderPrecinctMap(c);});
  const req=++_pmapReq;
  if (!_pgeo[c]){
    try { const res = await fetch(`precincts/${c.replace(/ /g,'_')}.json`); if (!res.ok) throw new Error(res.status); _pgeo[c] = await res.json(); }
    catch(e){ document.getElementById('pmap').innerHTML='<p class="hint">Precinct boundaries could not be loaded.</p>'; return; }
  }
  if (req!==_pmapReq || state.scope!==c) return;
  const G=_pgeo[c], m=PMAPM[state.pmapMetric]; const byCode=Object.fromEntries(precinctRows(c).map(r=>[r.code,r]));
  const stats = G.shapes.map(sh=>shapeStats(sh, byCode));
  document.getElementById('pmap-title').textContent = m.name;
  const vals = stats.map(s=>s[state.pmapMetric]).filter(v=>v!=null);
  const q=(arr,p)=>{ const s=arr.slice().sort((a,b)=>a-b); return s.length? s[Math.min(s.length-1,Math.floor(p*(s.length-1)))] : 0; };
  const scale = m.type==='seq' ? {min:q(vals,0.02), max:q(vals,0.98)} : {abs: Math.max(1, q(vals.map(Math.abs),0.95))};
  const box=document.getElementById('pmap'); box.innerHTML='';
  const svg=el('svg',{viewBox:`0 0 ${G.w} ${G.h}`, role:'img','aria-label':`${title(c)} County precincts: ${m.name}`},box);
  const selCodes = state.pfilter||[];
  G.shapes.forEach((sh,i)=>{
    const st=stats[i]; const has = sh.p.length>0; const v = st[state.pmapMetric];
    const p=el('path',{d:sh.d, class:'prec'+(has?'':' none')+(sh.p.some(x=>selCodes.includes(x))?' sel':''), fill: has && v!=null ? colorFor(m, v, scale) : 'var(--line2)', tabindex:has?0:-1, role:'button','aria-label':`${sh.p.join(', ')||sh.name}, ${v==null?'no data':m.fmt(v)}`},svg);
    p.addEventListener('mouseenter',()=>pmapInfo(sh,st)); p.addEventListener('mouseleave',()=>pmapInfo(null));
    const pick=()=>{ if(!has) return; state.pfilter = sh.p.slice(); state.q=''; precinctTable(c); renderPrecinctMap(c); document.getElementById('s-counties').scrollIntoView({behavior:'smooth'}); };
    p.addEventListener('click',pick); p.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){e.preventDefault();pick();} });
  });
  const col=mapColors(m); const lg=document.getElementById('pmap-legend');
  if (m.type==='seq') lg.innerHTML = `<div class="ramp seq" style="--l0:${col.lo};--l2:${col.hi}"></div><div class="ends"><span>${m.ends[0]} · ${m.fmt(scale.min)}</span><span>${m.ends[1]} · ${m.fmt(scale.max)}</span></div>`;
  else lg.innerHTML = `<div class="ramp" style="--l0:${col.neg};--l1:${col.mid};--l2:${col.pos}"></div><div class="ends"><span>${m.ends[0]} · ${m.fmt(-scale.abs)}</span><span>0</span><span>${m.ends[1]} · ${m.fmt(scale.abs)}</span></div>`;
  const shared = G.shapes.filter(s=>s.p.length>1).length, empty = G.shapes.filter(s=>!s.p.length).length;
  document.getElementById('pmap-note').textContent = `Boundaries are the 2024 general-election precincts (Redistricting Data Hub via The New York Times), matched to the current voter file’s precinct codes by where each precinct’s voters live. ${G.shapes.length} shapes, ${(D.precinct[c]||[]).length} current precincts${shared?`; ${shared} shape${shared>1?'s':''} now hold more than one precinct code`:''}${empty?`; ${empty} shape${empty>1?'s':''} (gray) have no voters coded to them in the current file`:''}${G.unmatched.length?`; ${G.unmatched.length} precinct code${G.unmatched.length>1?'s':''} could not be placed`:''}.`;
  pmapInfo(null);
}
function pmapInfo(sh, st){
  const box=document.getElementById('pmap-info'); const C=COL(); const c=state.scope;
  if (!sh){ const n=(D.precinct[c]||[]).length; box.innerHTML = `<div class="big">${title(c)} County<small>${n} precincts</small></div><p class="hint" style="margin:0">Hover a precinct for its numbers; click to show only that precinct in the table below.</p>`; return; }
  if (!sh.p.length){ box.innerHTML = `<div class="big">${esc(sh.name)}<small>2024 precinct</small></div><p class="hint" style="margin:0">No voters in the current file are coded to this 2024 precinct; it was probably merged or renumbered.</p>${sh.tot?`<dl><dt>2024 president</dt><dd>${pts(100*(sh.rep-sh.dem)/sh.tot)} pts</dd></dl>`:''}`; return; }
  box.innerHTML = `<div class="big">${sh.p.map(esc).join(', ')}<small>${esc(sh.name)}</small></div>
  <div class="party-bar" aria-hidden="true" style="margin-bottom:8px"><span class="pr" style="flex:${st.R}"></span><span class="pd" style="flex:${st.Dm}"></span><span class="po" style="flex:${st.O}"></span></div>
  <dl><dt>Registered</dt><dd>${fmt(st.reg)}</dd><dt>Early votes</dt><dd>${fmt(st.ev)}</dd><dt>Mail returned / in person</dt><dd>${fmt(st.ret)} / ${fmt(st.eip)}</dd><dt>Share of registered</dt><dd>${pctCell(st.turnout)}</dd><dt>Rep / Dem / Other</dt><dd><span style="color:${C.R}">${fmt(st.R)}</span> / <span style="color:${C.D}">${fmt(st.Dm)}</span> / ${fmt(st.O)}</dd><dt>Net R−D</dt><dd class="${sign(st.net)}">${st.net==null?'–':pts(st.net)+' pts'}</dd><dt>Registration net R−D</dt><dd>${st.regnet==null?'–':pts(st.regnet)+' pts'}</dd><dt>2024 president (T−H)</dt><dd class="${sign(st.pres24)}">${st.pres24==null?'–':pts(st.pres24)+' pts'}</dd></dl>`;
}

function countyTable(){
  document.getElementById('tbl-title').innerHTML = 'Counties <small>click a county for its precincts</small>';
  document.getElementById('tbl-note').textContent = `Early votes cast through ${fmtDate(dateOf('2026',ASOF))}, compared with each county ${ASOF} days before Election Day in ${state.cmp24?'2024 and 2022':'2022'}. Sort by any column.`;
  document.getElementById('tbl-tools').innerHTML='';
  const rows = countyStats();
  const sum = k => rows.reduce((s,r)=>s+r[k],0);
  const ev=sum('ev'), s24=cum('STATE','2024','ev','all',ASOF), s22=cum('STATE','2022','ev','all',ASOF), f24=cum('STATE','2024','ev','all',null);
  const P=Object.fromEntries(PARTIES.map(p=>[p,cum('STATE','2026','ev',p,ASOF)])), P24=Object.fromEntries(PARTIES.map(p=>[p,cum('STATE','2024','ev',p,ASOF)])); const t24=P24.R+P24.D+P24.O; const reg=regFor('STATE'); const regT=reg.R+reg.D+reg.O;
  const P22=Object.fromEntries(PARTIES.map(p=>[p,cum('STATE','2022','ev',p,ASOF)])); const t22=P22.R+P22.D+P22.O; const f22=cum('STATE','2022','ev','all',null);
  const foot={county:ST.name, ev, ret:sum('ret'), eip:sum('eip'), v24:100*(ev-s24)/s24, v22:100*(ev-s22)/s22, of24:100*ev/f24, of22:100*ev/f22, turnout:100*ev/regT, rp:100*P.R/ev, dp:100*P.D/ev, op:100*P.O/ev, net:100*(P.R-P.D)/ev, net24:100*(P24.R-P24.D)/t24, net22:100*(P22.R-P22.D)/t22}; foot.shift=foot.net-foot.net24; foot.shift22=foot.net-foot.net22;
  sortable([
    {key:'county',label:'County',text:true},
    {key:'ev',label:'Early votes',fmt:fmt,defaultSort:true,tip:'Mail ballots returned plus early in-person votes'},
    {key:'ret',label:'Mail',fmt:fmt},{key:'eip',label:'In person',fmt:fmt},
    ...(state.cmp24?[{key:'v24',label:'vs 2024',fmt:chgCell,tip:'Change from the same day in 2024'}]:[]),{key:'v22',label:'vs 2022',fmt:chgCell,tip:'Change from the same day in 2022'},
    state.cmp24?{key:'of24',label:'% of 2024 final',fmt:pctCell}:{key:'of22',label:'% of 2022 final',fmt:pctCell},{key:'turnout',label:'% of reg.',fmt:pctCell,tip:'Early votes as a share of registered voters'},
    {key:'rp',label:'Rep',fmt:pctCell},{key:'dp',label:'Dem',fmt:pctCell},{key:'op',label:'Other',fmt:pctCell},
    {key:'net',label:'Net R−D',fmt:netCell},
    ...(state.cmp24?[{key:'net24',label:'2024 net',fmt:v=>v==null?'–':pts(v),tip:'Net R−D at the same point in 2024'},{key:'shift',label:'Shift',fmt:v=>v==null?'–':`<span class="${sign(v)}">${pts(v)}</span>`,tip:'2026 net minus 2024 net at the same point'}]
                     :[{key:'net22',label:'2022 net',fmt:v=>v==null?'–':pts(v),tip:'Net R−D at the same point in 2022'},{key:'shift22',label:'Shift',fmt:v=>v==null?'–':`<span class="${sign(v)}">${pts(v)}</span>`,tip:'2026 net minus 2022 net at the same point'}]),
  ], rows, foot, id=>{ setScope(id); window.scrollTo({top:0,behavior:'smooth'}); });
  document.getElementById('tbl-hint').textContent='Percent changes compare cumulative early votes on the same day before Election Day. Net R−D is Republican share minus Democratic share of early votes, in points.';
}

function precinctTable(c){
  document.getElementById('tbl-title').innerHTML = `${title(c)} County precincts <small>2026 early votes by precinct</small>`;
  document.getElementById('tbl-note').textContent = `Every precinct in ${title(c)} County from the voter file, with registered voters by party and who has voted so far. Precinct codes are the county board’s.`;
  const tools=document.getElementById('tbl-tools'); tools.innerHTML = `<button type="button" class="chip" id="back" style="background:var(--navy);border-color:var(--navy);color:#fff">← All counties</button><input type="search" id="q" placeholder="Filter precincts…" value="${esc(state.q)}" aria-label="Filter precincts">${state.pfilter?`<button type="button" class="chip" id="clearp" style="background:var(--gold);border-color:var(--gold);color:var(--navy)">Map pick: ${esc(state.pfilter.join(', '))} ✕</button>`:''}<span class="count" id="cnt"></span>`;
  tools.querySelector('#back').addEventListener('click',()=>{ setScope('STATE'); document.getElementById('s-counties').scrollIntoView({behavior:'smooth'}); });
  const q=tools.querySelector('#q'); q.addEventListener('input',()=>{ state.q=q.value; state.pfilter=null; precinctTable(c); if (_pgeo[c]) renderPrecinctMap(c); });
  const cp=tools.querySelector('#clearp'); if (cp) cp.addEventListener('click',()=>{ state.pfilter=null; precinctTable(c); renderPrecinctMap(c); });
  const all = (D.precinct[c]||[]).map(r=>{ const reg=r[1]+r[2]+r[3]; const R=r[7]+r[10], Dm=r[8]+r[11], O=r[9]+r[12]; const ev=R+Dm+O; const ret=r[7]+r[8]+r[9], eip=r[10]+r[11]+r[12], req=r[4]+r[5]+r[6];
    return {id:r[0], precinct:r[0], reg, regR:r[1], regD:r[2], ev, turnout:reg?100*ev/reg:null, req, ret, eip, R, D:Dm, O, rp:ev?100*R/ev:null, dp:ev?100*Dm/ev:null, net:ev?100*(R-Dm)/ev:null, regnet:reg?100*(r[1]-r[2])/reg:null}; });
  const rows = state.pfilter ? all.filter(r=>state.pfilter.includes(r.precinct)) : (state.q ? all.filter(r=>r.precinct.toLowerCase().includes(state.q.toLowerCase())) : all);
  tools.querySelector('#cnt').textContent = `${rows.length} of ${all.length} precincts`;
  const sum=k=>rows.reduce((s,r)=>s+r[k],0); const reg=sum('reg'), ev=sum('ev'), R=sum('R'), Dm=sum('D'), regR=sum('regR'), regD=sum('regD');
  const foot={precinct:state.q?'Filtered total':`${title(c)} County`, reg, regR, regD, ev, turnout:reg?100*ev/reg:null, req:sum('req'), ret:sum('ret'), eip:sum('eip'), R, D:Dm, O:sum('O'), rp:ev?100*R/ev:null, dp:ev?100*Dm/ev:null, net:ev?100*(R-Dm)/ev:null, regnet:reg?100*(regR-regD)/reg:null};
  sortable([
    {key:'precinct',label:'Precinct',text:true},
    {key:'reg',label:'Registered',fmt:fmt},
    {key:'ev',label:'Early votes',fmt:fmt,defaultSort:true},
    {key:'turnout',label:'% of reg.',fmt:pctCell},
    {key:'req',label:'Requested',fmt:fmt},{key:'ret',label:'Mail returned',fmt:fmt},{key:'eip',label:'In person',fmt:fmt},
    {key:'R',label:'Rep votes',fmt:fmt},{key:'D',label:'Dem votes',fmt:fmt},{key:'O',label:'Other votes',fmt:fmt},
    {key:'rp',label:'Rep %',fmt:pctCell},{key:'dp',label:'Dem %',fmt:pctCell},
    {key:'net',label:'Net R−D',fmt:netCell},
    {key:'regnet',label:'Reg. net R−D',fmt:v=>v==null?'–':pts(v),tip:'Registered Republicans minus Democrats as a share of all registered voters'},
  ], rows, foot, null);
  document.getElementById('tbl-hint').textContent='Precinct figures count only early-vote records that match a voter in the current file (about ${ST.unmatched_pct}% of ${ST.name} records do not match). Registered-party totals include all voters in the file, regardless of status.';
}

function methodology(){
  const m=D.meta; const part=D.partial; const partN = part.slice(3,9).reduce((a,b)=>a+b,0), partReq = part.slice(0,3).reduce((a,b)=>a+b,0);
  document.getElementById('meth').innerHTML = `
  <p><b>Source.</b> ColdSpark’s national voter file and daily absentee / early-vote (ABEV) feeds, loaded in Google BigQuery. ${ST.name} 2026 figures run through ${fmtDateY(dateOf('2026',ASOF))}, the last complete day in the feed (${fmt(m['2026'].rows_total)} ${ST.name} records). ${partN||partReq ? `A partial later day with ${fmt(partReq)} new requests and ${fmt(partN)} votes is held back until it is complete.` : ''} Comparisons use the 2024 and 2022 feeds (${fmt(m['2024'].rows_total)} and ${fmt(m['2022'].rows_total)} records) and the voter file as it stood in each of those years.</p>
  <p><b>Definitions.</b> “Early votes” are mail ballots returned plus early in-person votes. Mail requests and returns exclude records the county flagged as rejected (${fmt(m['2026'].rejected_rows)} in 2026, ${fmt(m['2024'].rejected_rows)} in 2024, ${fmt(m['2022'].rejected_rows)} in 2022). Outstanding ballots are requested but not yet returned. ${ST.party_note} ${ST.no_requests ? 'Records that did not match a voter are counted as “'+PNAME.O+'”' : 'Voters with no party on file are “Other / unaffiliated,” as are the few records that did not match a voter'} (${fmt(m['2026'].unmatched_rows)} in 2026).</p>
  <p><b>Pacing.</b> Years are aligned on days before Election Day (November 3, 2026; November 5, 2024; November 8, 2022), so “same point” compares equal time remaining. ${ST.pacing_note} “Final” totals include ballots that arrived in the days after Election Day.</p>
  <p><b>Counties and precincts.</b> County figures come straight from the ABEV feed. Precinct figures are built by matching each early-vote record to its voter in the current file and taking the voter’s precinct and party; registered voter counts are all voters in the file for that precinct. Precinct lines and codes are the county board’s as of the current file.</p>`;
  document.getElementById('built').textContent = `data refreshed ${D.built}`;
}

/* ---------- boot ---------- */
(function init(){
  const sel=document.getElementById('scope');
  sel.innerHTML = `<option value="STATE">${ST.name} statewide</option>` + COUNTIES.map(c=>`<option value="${esc(c)}">${title(c)} County</option>`).join('');
  sel.addEventListener('change',()=>{ setScope(sel.value); });
  const h = (location.hash||'').replace('#','');
  const start = SLUGS[h] || 'STATE';
  setScope(start, false); if (start!=='STATE') sel.value=start;
  window.addEventListener('hashchange',()=>{ const s=SLUGS[(location.hash||'').replace('#','')]||'STATE'; if (s!==state.scope) setScope(s,false); });
  const mq = window.matchMedia('(prefers-color-scheme: dark)'); mq.addEventListener && mq.addEventListener('change',()=>render());
  new MutationObserver(()=>render()).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
})();
