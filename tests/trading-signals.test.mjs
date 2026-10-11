import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('../decide-worker.js', import.meta.url), 'utf8')
  .replace('export class TraderEngine', 'class TraderEngine')
  .replace('export default {', 'const worker = {');
const context = vm.createContext({ Date, console, AbortSignal });
vm.runInContext(source, context);
const run = (code) => vm.runInContext(code, context);
const end = 180000 * 1000;
const rows = Array.from({ length: 64 }, (_, i) => {
  const ts = end - 63 * 60000 + i * 60000;
  return [ts, '100', '101', '99', '100', '1', ts + 60000, i >= 60 ? '50' : '10'];
});
context.rows = rows;
context.end = end;

test('uses only complete three-minute buckets and sums actual quote volume', () => {
  const candles = run('buildClosedCandles(rows, end)');
  assert.equal(candles.length, 20);
  assert.equal(candles.at(-1).ts, end - 180000);
  assert.equal(candles.at(-1).volume, 150);
  assert.equal(candles.at(-2).volume, 30);
  context.candles = candles;
  assert.match(run("describeVolume({priceHistory:{BTCUSDT:candles}},'BTCUSDT')"), /5\.0배/);
});
test('repeated fetches cannot add extra samples; duplicates do not inflate volume', () => {
  assert.equal(run('buildClosedCandles([...rows, rows[60]], end).at(-1).volume'), 150);
  assert.equal(run('buildClosedCandles(rows, end).length'), 20);
});
test('missing, stale, and invalid volume data reject the signal', () => {
  assert.throws(() => run('buildClosedCandles(rows.filter((_, i) => i !== 60), end)'));
  assert.throws(() => run('buildClosedCandles(rows, end + 180000)'));
  assert.throws(() => run('buildClosedCandles(rows.map(r => [...r.slice(0,7), null]), end)'));
});
test('a flat candle does not extend an upward streak', () => {
  assert.match(run("describeTrend({priceHistory:{BTCUSDT:[{price:100},{price:101},{price:101}]}},'BTCUSDT')"), /보합 0연속/);
});
function setup() {
  run(`globalThis.state = defaultState();
    state.priceHistory.BTCUSDT = candles;
    globalThis.tickers = {BTCUSDT:{lastPrice:100}};
    state.portfolios.A = {cash:8000000,holdings:{BTCUSDT:{qty:10,avgPrice:100,margin:2000000,side:'long',openedAt:Date.now(),peakPnlPct:1.6}}};`);
}
test('blocks immediate small-noise exit, but permits a material adverse move', () => {
  setup();
  run("applyDecision(state,'A',{action:'sell',symbol:'BTCUSDT',amountKrw:2000000,reason:'test'},tickers)");
  assert.equal(run('state.portfolios.A.holdings.BTCUSDT.qty'), 10);
  run("tickers.BTCUSDT.lastPrice=99; applyDecision(state,'A',{action:'sell',symbol:'BTCUSDT',amountKrw:2000000,reason:'test'},tickers)");
  assert.equal(run('state.portfolios.A.holdings.BTCUSDT.qty'), 0);
});
test('confirmed adverse candles allow early exit and partial exits preserve risk metadata', () => {
  setup();
  run("state.priceHistory.BTCUSDT=[{price:100.3},{price:100.2},{price:100}]; applyDecision(state,'A',{action:'sell',symbol:'BTCUSDT',amountKrw:1000000,reason:'test'},tickers)");
  assert.equal(run('state.portfolios.A.holdings.BTCUSDT.qty'), 5);
  assert.equal(run('state.portfolios.A.holdings.BTCUSDT.peakPnlPct'), 1.6);
  assert.ok(run('state.portfolios.A.holdings.BTCUSDT.openedAt'));
});
test('cooldown prevents reentry and automatic stops still close positions', () => {
  setup();
  run("state.tradeHistory.A=[{symbol:'BTCUSDT',ts:Date.now(),pnl:-1}]; applyDecision(state,'A',{action:'buy',symbol:'BTCUSDT',amountKrw:100000,reason:'test'},tickers)");
  assert.equal(run('state.portfolios.A.holdings.BTCUSDT.qty'), 10);
  run('tickers.BTCUSDT.lastPrice=97; checkStopLossAndTakeProfit(state,tickers)');
  assert.equal(run('state.portfolios.A.holdings.BTCUSDT.qty'), 0);
});
test('invalid amounts and unsupported symbols cannot affect holdings', () => {
  setup();
  assert.throws(() => run("applyDecision(state,'A',{action:'sell',symbol:'BTCUSDT',amountKrw:-1,reason:'test'},tickers)"));
  assert.throws(() => run("applyDecision(state,'A',{action:'buy',symbol:'FAKE',amountKrw:100,reason:'test'},tickers)"));
});

function freshPosition(side = 'buy', cash = 10000000) {
  run(`globalThis.state=defaultState(); state.priceHistory.BTCUSDT=candles;
    globalThis.tickers={BTCUSDT:{lastPrice:100}};
    state.tickers=tickers; state.portfolios.A.cash=${cash}; initializeCostTracking(state);
    applyDecision(state,'A',{action:'${side}',symbol:'BTCUSDT',amountKrw:1000000,reason:'signal'},tickers);`);
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.0001, `${actual} != ${expected}`);
test('flat long and short round trips lose modeled costs and reconcile cash exactly', () => {
  for (const side of ['buy','short']) {
    freshPosition(side);
    near(run('state.portfolios.A.cash'), 8996500);
    run("closePosition(state,'A','BTCUSDT',100,1,'test',true)");
    const trade = run('state.tradeHistory.A.at(-1)');
    near(trade.grossPnl, 0);
    near(trade.pnl, -trade.totalCosts);
    near(run('state.portfolios.A.cash') - 10000000, trade.pnl);
    assert.equal(trade.costVersion, 1);
    assert.equal(trade.entryReason, 'signal');
    assert.equal(trade.entryLegs.length, 1);
  }
});
test('partial exits allocate entry costs without double charging and preserve remaining metadata', () => {
  freshPosition();
  run("closePosition(state,'A','BTCUSDT',101,0.4,'partial',true); closePosition(state,'A','BTCUSDT',101,1,'rest',true)");
  const trades = run('state.tradeHistory.A');
  near(trades.reduce((sum,t)=>sum+t.entryFeeKrw,0),2500);
  near(trades.reduce((sum,t)=>sum+t.entrySlippageKrw,0),1000);
  near(trades.reduce((sum,t)=>sum+t.pnl,0),run('state.portfolios.A.cash')-10000000);
});
test('funding accrues with holding time and an add-on does not reset existing accrual', () => {
  freshPosition();
  run('state.portfolios.A.holdings.BTCUSDT.costStartedAt=Date.now()-COST_MODEL.fundingPeriodMs');
  near(run('fundingCost(state.portfolios.A.holdings.BTCUSDT)'),500);
  run("applyDecision(state,'A',{action:'buy',symbol:'BTCUSDT',amountKrw:1000000,reason:'add'},tickers)");
  assert.ok(run('fundingCost(state.portfolios.A.holdings.BTCUSDT)') >= 500);
  near(run('state.portfolios.A.holdings.BTCUSDT.fundingNotionalKrw'),10000000);
  assert.equal(run('state.portfolios.A.holdings.BTCUSDT.entryLegs.length'),2);
});
test('legacy migration is idempotent and does not retroactively charge entry costs', () => {
  setup();
  run('state.tickers=tickers; initializeCostTracking(state)');
  const cash = run('state.portfolios.A.cash');
  const started = run('state.portfolios.A.holdings.BTCUSDT.costStartedAt');
  run('initializeCostTracking(state)');
  assert.equal(run('state.portfolios.A.cash'),cash);
  assert.equal(run('state.portfolios.A.holdings.BTCUSDT.costStartedAt'),started);
  run("closePosition(state,'A','BTCUSDT',100,1,'legacy',true)");
  assert.equal(run('state.tradeHistory.A.at(-1).entryFeeKrw'),0);
  assert.equal(run('computePerformanceStats(state,"A").count'),0);
  assert.equal(run('computePerformanceStats(state,"A").legacyCount'),1);
});
test('fees are included in cash constraints, and forced liquidation cannot produce negative cash', () => {
  freshPosition('buy',100000);
  assert.ok(run('state.portfolios.A.cash') >= -0.000001);
  run("closePosition(state,'A','BTCUSDT',1,1,'liquidated',true)");
  assert.ok(run('state.portfolios.A.cash') >= -0.000001);
});
test('net liquidation value includes exit costs; drawdown tracks losses after initialization', () => {
  freshPosition();
  assert.ok(run('portfolioValue(state.portfolios.A,tickers)') < 10000000);
  run('trackPerformance(state,tickers)');
  assert.ok(run('computePerformanceStats(state,"A").maxDrawdownPct') > 0);
});
test('a reached daily target remains locked after close costs reduce the final return', () => {
  freshPosition();
  run('state.dailyBase.A={value:10000000,hitTarget:true}; state.portfolios.A.holdings.BTCUSDT.qty=0');
  assert.equal(run('goalReached(state,"A",tickers)'),true);
});

test('net target resumes a gross-only stopped day and closes only after net 1%', () => {
  freshPosition();
  run('state.dailyBase.A={date:todayDateStr(),value:10000000,paidCostsKrw:0,pendingExitCostsKrw:0,hitTarget:true,returnBasis:"gross"}; tickers.BTCUSDT.lastPrice=102; migrateNetGoal(state,tickers)');
  near(run('todayGrossPct(state,"A",tickers)'),1);
  assert.equal(run('goalReached(state,"A",tickers)'),false);
  assert.equal(run('state.dailyBase.A.returnBasis'), 'net');
  run('markGoalHitToday(state,tickers); closeOpenPositionsOnGoalHit(state,tickers)');
  assert.ok(run('state.portfolios.A.holdings.BTCUSDT.qty') > 0);
  run('tickers.BTCUSDT.lastPrice=103; markGoalHitToday(state,tickers); closeOpenPositionsOnGoalHit(state,tickers)');
  assert.ok(run('todayPct(state,"A",tickers)') >= 1);
  assert.equal(run('state.portfolios.A.holdings.BTCUSDT.qty'),0);
  assert.equal(run('goalReached(state,"A",tickers)'),true);
  run('migrateNetGoal(state,tickers)');
  assert.equal(run('state.dailyBase.A.hitTarget'),true);
});
test('flat round trip has zero gross return while net return includes costs', () => {
  freshPosition();
  run('state.dailyBase.A={value:10000000,paidCostsKrw:0,pendingExitCostsKrw:0,hitTarget:false}');
  near(run('todayGrossPct(state,"A",tickers)'),0);
  run("closePosition(state,'A','BTCUSDT',100,1,'flat',true)");
  near(run('todayGrossPct(state,"A",tickers)'),0);
  assert.ok(run('todayNetPct(state,"A",tickers)') < 0);
});
test('costs paid before a new daily baseline are not added to the next daily return', async () => {
  freshPosition();
  run('state.dailyBase.A=null');
  await run('rolloverDayIfNeeded({},state,tickers)');
  near(run('todayGrossPct(state,"A",tickers)'),0);
  run("closePosition(state,'A','BTCUSDT',100,1,'flat',true)");
  near(run('todayGrossPct(state,"A",tickers)'),0);
});
test('cost ledger can be restored from closed records without counting costs twice', () => {
  freshPosition();
  run("closePosition(state,'A','BTCUSDT',100,0.5,'partial',true)");
  const paid = run('paidTradingCosts(state,"A")');
  run('delete state.portfolios.A.paidCostsKrw');
  near(run('paidTradingCosts(state,"A")'),paid);
  run('state.dailyBase.A={date:todayDateStr(),value:10000000,hitTarget:false}; migrateGoalCostBasis(state); migrateGoalCostBasis(state)');
  near(run('paidTradingCosts(state,"A")'),paid);
  assert.equal(run('state.dailyBase.A.paidCostsKrw'),0);
});

test('entry classification uses numeric trend, RSI and volume and respects position direction', () => {
  run('globalThis.signalState={priceHistory:{BTCUSDT:Array.from({length:20},(_,i)=>({price:100+i,volume:i===19?50:10}))}}');
  assert.equal(run("classifyEntrySignals(signalState,'BTCUSDT','long').tags[0].key"),'trend:trend_following');
  assert.equal(run("classifyEntrySignals(signalState,'BTCUSDT','short').tags[0].key"),'trend:counter_trend');
  assert.equal(run("classifyEntrySignals(signalState,'BTCUSDT','long').tags[1].key"),'rsi:overbought');
  assert.equal(run("classifyEntrySignals(signalState,'BTCUSDT','long').tags[2].key"),'volume:high');
});
test('signal outcomes count one completed position and sum partial exits', () => {
  freshPosition();
  run("closePosition(state,'A','BTCUSDT',101,0.5,'partial',true)");
  assert.equal(run('computePerformanceStats(state,"A").signalPerformance.completedPositions'),0);
  run("closePosition(state,'A','BTCUSDT',102,1,'rest',true)");
  const result=run('computePerformanceStats(state,"A").signalPerformance');
  assert.equal(result.completedPositions,1);
  assert.equal(result.groups.length,4);
  for(const g of result.groups) {
    assert.equal(g.count,1);
    assert.equal(g.winRate,100);
    near(g.netPnl,run('state.tradeHistory.A.reduce((sum,h)=>sum+h.pnl,0)'));
    assert.equal(g.sampleStatus,'collecting');
  }
});
test('unclassified legacy trades do not contaminate signal samples', () => {
  assert.equal(run('computeSignalPerformance([{pnl:100,marginKrw:1000,partial:false}]).completedPositions'),0);
});

function frameRows(duration, count = 62, mode = 'up') {
  const now = Math.floor(Date.now() / duration) * duration;
  return Array.from({length:count},(_,i)=>{
    const ts=now-(count-1-i)*duration;
    const price=mode==='up'?100+i:mode==='down'?200-i:100;
    return [ts,price,price+0.1,price-0.1,price,10,ts+duration,1000];
  });
}
test('higher timeframe candles exclude active bars and reject gaps or old data',()=>{
  context.frameRows=frameRows(900000); context.duration=900000;
  const data=run('buildTimeframeCandles(frameRows,duration)');
  assert.equal(data.length,60);
  assert.ok(data.at(-1).ts+900000<=Date.now());
  assert.throws(()=>run('buildTimeframeCandles(frameRows.filter((_,i)=>i!==50),duration)'));
  assert.throws(()=>run('buildTimeframeCandles(frameRows.slice(0,-1),duration,Date.now()+duration)'));
  assert.equal(run('buildTimeframeCandles([...frameRows,frameRows[50]],duration).length'),60);
});
test('timeframe classifier distinguishes up/down trends and flat markets',()=>{
  for(const [mode,regime] of [['up','trend_up'],['down','trend_down'],['flat','range']]) {
    context.frameRows=frameRows(900000,62,mode);
    const result=run('analyzeTimeframe(buildTimeframeCandles(frameRows,900000),900000)');
    assert.equal(result.regime,regime);
    assert.ok(result.atrPct>0);
    assert.ok(result.efficiency>=0 && result.efficiency<=1);
  }
});
test('conflicting fifteen-minute and hourly trends remain mixed, not a confident direction',()=>{
  context.midRows=frameRows(900000,62,'up');context.longRows=frameRows(3600000,62,'down');
  run("globalThis.multiState={priceHistory:{},timeframeHistory:{BTCUSDT:{'15m':buildTimeframeCandles(midRows,900000),'1h':buildTimeframeCandles(longRows,3600000)}}}");
  const result=run("analyzeMarket(multiState,'BTCUSDT')");
  assert.equal(result.contextAvailable,true);
  assert.equal(result.regime,'transition');
  context.longRows=frameRows(3600000,62,'up');
  run("multiState.timeframeHistory.BTCUSDT['1h']=buildTimeframeCandles(longRows,3600000)");
  assert.equal(run("analyzeMarket(multiState,'BTCUSDT').regime"),'trend_up');
});
test('missing or stale higher timeframe data stays unknown without inventing a trend',()=>{
  run("multiState.timeframeHistory.BTCUSDT['1h']=[]");
  assert.equal(run("analyzeMarket(multiState,'BTCUSDT').contextAvailable"),false);
  assert.equal(run("analyzeMarket(multiState,'BTCUSDT').regime"),'unknown');
  assert.equal(run("analyzeTimeframe(buildTimeframeCandles(midRows,900000),900000,Date.now()+900000).available"),false);
});
test('entry snapshots retain multi-timeframe context and aggregate alignment outcomes',()=>{
  freshPosition();
  context.midRows=frameRows(900000,62,'up');context.longRows=frameRows(3600000,62,'up');
  run("state.timeframeHistory={BTCUSDT:{'15m':buildTimeframeCandles(midRows,900000),'1h':buildTimeframeCandles(longRows,3600000)}}; state.tradeHistory.A=[]; state.portfolios.A={cash:10000000,holdings:{}}; applyDecision(state,'A',{action:'short',symbol:'BTCUSDT',amountKrw:1000000,reason:'counter'},tickers); closePosition(state,'A','BTCUSDT',99,1,'exit',true)");
  assert.equal(run('state.tradeHistory.A[0].entrySignals.marketContext.alignment'),'opposed');
  const perf=run('computePerformanceStats(state,"A").signalPerformance');
  assert.equal(perf.completedPositions,1);
  assert.equal(perf.groups.length,6);
  assert.ok(perf.groups.some(g=>g.key==='alignment:opposed'));
});
test('failed higher-timeframe fetch preserves available short candles and cannot reuse stale context',async()=>{
  const now=Math.floor(Date.now()/180000)*180000;
  const minutes=Array.from({length:65},(_,i)=>{
    const ts=now-(64-i)*60000;return [ts,100,101,99,100,1,ts+60000,100];
  });
  context.mockMinutes=minutes;
  run("globalThis.refreshState={priceHistory:{},timeframeHistory:{}}; globalThis.fetch=async url=>{ if(url.includes('interval=1m&')) return {ok:true,json:async()=>mockMinutes}; throw new Error('unavailable') }");
  await run('updatePriceHistory(refreshState)');
  assert.equal(run('refreshState.priceHistory.BTCUSDT.length'),20);
  assert.equal(run("refreshState.timeframeHistory.BTCUSDT['1h'].length"),0);
});

test('expanded history storage preserves legacy records and round-trips split snapshots',async()=>{
  const values=new Map();
  const storage={
    async get(keys){return Array.isArray(keys)?new Map(keys.filter(k=>values.has(k)).map(k=>[k,values.get(k)])):values.get(keys)},
    async put(items){for(const [key,value] of Object.entries(items))values.set(key,value)},
    async delete(keys){for(const key of keys)values.delete(key)},
    async transaction(callback){await callback(this)},
    async getAlarm(){return 1},
  };
  context.mockContext={storage,blockConcurrencyWhile:callback=>callback()};
  run('globalThis.storageEngine=new TraderEngine(mockContext,{})');
  const legacy=run('defaultState()');
  legacy.tradeHistory.A=[{symbol:'BTCUSDT',pnl:123,ts:1}];values.set('state',legacy);
  const loaded=await run('storageEngine.loadState()');
  assert.equal(loaded.tradeHistory.A[0].pnl,123);
  const entries=Array.from({length:50},(_,i)=>({symbol:'BTCUSDT',pnl:i,ts:i,reason:'상세'.repeat(2000)}));
  loaded.tradeHistory.A=entries;context.toSave=loaded;
  await run('storageEngine.saveState(toSave)');
  assert.ok(values.get('state').historyChunkKeys.A.length>1);
  const restored=await run('storageEngine.loadState()');
  assert.equal(restored.tradeHistory.A.length,50);
  assert.equal(restored.tradeHistory.A[49].pnl,49);
  context.toSave.tradeHistory.A=[];
  await run('storageEngine.saveState(toSave)');
  assert.equal([...values.keys()].filter(k=>k.startsWith('tradeHistory:')).length,0);
});
