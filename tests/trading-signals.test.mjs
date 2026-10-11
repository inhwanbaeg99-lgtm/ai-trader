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
