/**
 * Check October 2025 performance in detail
 */
import fs from 'fs';
import path from 'path';

const dataDir = path.join(process.cwd(), 'data');
const SYMBOLS = ['SOL', 'ETH', 'BTC', 'AVAX', 'LINK', 'DOT', 'DOGE', 'XRP', 'ATOM'];

const CONFIG = {
  LONG: { BB_PERIOD: 20, BB_STD: 2, ROC_MIN: 2.5, VOL_MULTIPLIER: 1.5, MAX_CONSEC_UP: 5 },
  EXIT: { STOP_LOSS_ATR_MULT: 3.0, STOP_LOSS_MIN: 1.0, STOP_LOSS_MAX: 4.5, TRAILING_ACTIVATION: 0.5, TRAILING_DISTANCE: 0.3 },
  COSTS: { TRADING_FEE_PCT: 0.04, SLIPPAGE_PCT: 0.05, FUNDING_RATE_PCT: 0.01, FUNDING_INTERVAL_BARS: 32 },
  DEFAULT_LEVERAGE: 4.5,
};

function calcSMA(v, p) { if (v.length < p) return v[v.length-1]||0; return v.slice(-p).reduce((a,b)=>a+b,0)/p; }
function calcBB(c, p=20, m=2) { if(c.length<p)return{upper:0}; const s=c.slice(-p),mid=s.reduce((a,b)=>a+b,0)/p,v=s.reduce((x,y)=>x+Math.pow(y-mid,2),0)/p; return{upper:mid+Math.sqrt(v)*m}; }
function calcROC(c,p){if(c.length<p+1)return 0;return((c[c.length-1]-c[c.length-p-1])/c[c.length-p-1])*100;}
function calcVolRatio(v){if(v.length<21)return 0;const avg=v.slice(-21,-1).reduce((a,b)=>a+b,0)/20;return avg>0?v[v.length-1]/avg:0;}
function calcATR(c,p=14){if(c.length<p+1)return null;let s=0;for(let i=c.length-p;i<c.length;i++){s+=Math.max(c[i].h-c[i].l,Math.abs(c[i].h-(c[i-1]?.c||c[i].o)),Math.abs(c[i].l-(c[i-1]?.c||c[i].o)));}return s/p;}
function countConsecUp(c){let n=0;for(let i=c.length-1;i>=0;i--){if(c[i].c>c[i].o)n++;else break;}return n;}
function isBtcBull(btc){if(btc.length<200)return true;const cl=btc.map(x=>x.c);return cl[cl.length-1]>calcSMA(cl,200);}

function load(sym){const f=`${dataDir}/${sym}_USDT_15m.json`;if(!fs.existsSync(f))return null;return JSON.parse(fs.readFileSync(f,'utf-8')).map(x=>({ts:x.timestamp||x.openTime,o:x.open,h:x.high,l:x.low,c:x.close,v:x.volume}));}
function resample(c){const r=[];for(let i=0;i<c.length;i+=4){if(i+3>=c.length)break;const g=c.slice(i,i+4);r.push({ts:g[0].ts,o:g[0].o,h:Math.max(...g.map(x=>x.h)),l:Math.min(...g.map(x=>x.l)),c:g[3].c,v:g.reduce((s,x)=>s+x.v,0)});}return r;}

function simTrade(c,idx,entry,atr){
  const lev=CONFIG.DEFAULT_LEVERAGE;let sl=atr?(atr/entry)*100*CONFIG.EXIT.STOP_LOSS_ATR_MULT:2.5;
  sl=Math.max(CONFIG.EXIT.STOP_LOSS_MIN,Math.min(CONFIG.EXIT.STOP_LOSS_MAX,sl));
  const stop=entry*(1-sl/100);let hwm=entry,trail=false,ts=0,bars=0;
  for(let i=idx+1;i<c.length&&bars<192;i++){const x=c[i];bars++;if(x.h>hwm){hwm=x.h;if(((hwm-entry)/entry)*100>=CONFIG.EXIT.TRAILING_ACTIVATION)trail=true;if(trail)ts=Math.max(ts,hwm*(1-CONFIG.EXIT.TRAILING_DISTANCE/100));}
  let ex=null,reason=null;if(x.l<=stop){ex=stop;reason='SL';}else if(trail&&x.l<=ts){ex=ts;reason='TRAIL';}
  if(ex){const gr=((ex-entry)/entry)*100*lev,cost=(CONFIG.COSTS.TRADING_FEE_PCT*2+CONFIG.COSTS.SLIPPAGE_PCT*2+Math.floor(bars/32)*CONFIG.COSTS.FUNDING_RATE_PCT)*lev;return{pnl:gr-cost,reason,bars};}}
  return{pnl:((c[Math.min(idx+192,c.length-1)].c-entry)/entry)*100*lev-0.5,reason:'TIME',bars:192};
}

console.log('╔═══════════════════════════════════════════════════════════════╗');
console.log('║              OCTOBER 2025 - Detailed Analysis                ║');
console.log('╚═══════════════════════════════════════════════════════════════╝\\n');

const btc=resample(load('BTC'));
const monthlyTrades = {};

for(const sym of SYMBOLS){
  const c=load(sym);if(!c)continue;const c1h=resample(c);let last=0;
  for(let i=50;i<c1h.length-50;i++){
    if(i<last+8)continue;
    const w=c1h.slice(0,i+1),bw=btc.slice(0,i+1),curr=w[w.length-1];
    if(curr.c<=curr.o)continue;if(!isBtcBull(bw))continue;
    const cl=w.map(x=>x.c),vol=w.map(x=>x.v);
    if(curr.c<=calcBB(cl).upper)continue;
    if(calcROC(cl,10)<CONFIG.LONG.ROC_MIN)continue;
    if(calcVolRatio(vol)<CONFIG.LONG.VOL_MULTIPLIER)continue;
    if(countConsecUp(w)>CONFIG.LONG.MAX_CONSEC_UP)continue;
    
    const t=simTrade(c1h,i,curr.c,calcATR(w));last=i+t.bars;
    const d=new Date(curr.ts),m=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if(!monthlyTrades[m])monthlyTrades[m]=[];
    monthlyTrades[m].push({sym,date:d.toISOString().split('T')[0],...t});
  }
}

// Sort by month
const months = Object.keys(monthlyTrades).sort();
console.log('Month     │ Trades │ Wins │  WR%  │ Total PnL │ Avg PnL');
console.log('──────────┼────────┼──────┼───────┼───────────┼─────────');

for(const m of months){
  const trades=monthlyTrades[m];
  const wins=trades.filter(t=>t.pnl>0).length;
  const total=trades.reduce((s,t)=>s+t.pnl,0);
  const avg=total/trades.length;
  const isOct2025 = m === '2025-10' ? ' ◀◀◀' : '';
  console.log(`${m}   │ ${String(trades.length).padStart(5)}  │ ${String(wins).padStart(4)} │ ${((wins/trades.length)*100).toFixed(0).padStart(4)}% │ ${(total>=0?'+':'')+total.toFixed(0).padStart(8)}% │ ${(avg>=0?'+':'')+avg.toFixed(2)}%${isOct2025}`);
}

// October 2025 detail
console.log('\\n═══ OCTOBER 2025 TRADES DETAIL ═══\\n');
const oct = monthlyTrades['2025-10'] || [];
if(oct.length > 0) {
  console.log('Symbol │ Date       │ PnL    │ Exit');
  console.log('───────┼────────────┼────────┼──────');
  for(const t of oct) {
    console.log(`${t.sym.padEnd(6)} │ ${t.date} │ ${(t.pnl>=0?'+':'')+t.pnl.toFixed(1).padStart(5)}% │ ${t.reason}`);
  }
  console.log('');
  const wins = oct.filter(t=>t.pnl>0).length;
  const sls = oct.filter(t=>t.reason==='SL').length;
  console.log(`Résumé Oct 2025: ${oct.length} trades, ${wins} wins (${((wins/oct.length)*100).toFixed(0)}% WR), ${sls} SL`);
  console.log(`Total PnL: ${oct.reduce((s,t)=>s+t.pnl,0).toFixed(1)}%`);
}
