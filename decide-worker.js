// AI 가상 트레이더용 Cloudflare Worker --
// 상태/루프를 전부 Durable Object(TraderEngine) 하나가 들고 있다. DO의
// Alarm이 스스로를 계속 재예약하면서 15초마다 시세 확인 -> 손절/익절 체크
// -> Claude 판단(3명 동시) -> 체결을 돌린다. Cron Trigger(최소 1분 단위)로는
// 이 주기를 못 맞춰서 DO+Alarm으로 옮겼다 (Workers 유료 플랜 필요).
// 바깥쪽 fetch()는 그냥 이 DO로 요청을 그대로 넘겨주는 얇은 라우터다.
//
// 배포 후 `wrangler secret put ANTHROPIC_API_KEY`로 키를 등록해야 동작한다.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

const START_BALANCE = 10000000; // 트레이더당 가상 시드머니 1천만원
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
const KRW_RATE = 1400; // 대략치, 실제 환율 API 붙이기 전까지 고정값
// 모의 비용 가정이며 실제 거래소 요율/펀딩 정산을 뜻하지 않는다.
const COST_MODEL = { version: 1, feeRate: 0.0005, slippageRate: 0.0002,
  fundingRatePer8h: 0.0001, fundingPeriodMs: 8 * 60 * 60 * 1000 };
const INTERVAL_SECONDS = 180; // 판단 주기 -- 당분간 비용 아끼면서 전적 데이터부터 쌓는 단계라 3분으로 조정

// 시세 소스 변천사: Binance(fapi/api 전부)·Bybit·CoinGecko는 Cloudflare
// Workers 엣지 IP를 아예 차단(403/451/429)한다. OKX는 처음엔 됐지만 이후
// 우리 쪽 요청에도 계속 429를 줘서(공유 엣지 IP 풀의 다른 트래픽 영향일
// 가능성) 신뢰할 수 없었음. MEXC가 바이낸스와 거의 동일한 API 포맷을
// 쓰면서 Workers에서 막히지 않아 최종적으로 이걸 사용.

// 위험도(공격/안정/역발상)가 아니라 "어떤 신호에 반응하는 매매 스타일인가"로
// 성격을 나눈다. 목표가 하루 +1%로 작아졌으니 셋 다 큰 승부를 걸 필요 없이
// 여러 트레이더로 나눠서 경쟁시키던 컨셉은 걷어내고, 혼자 쓸 용도로
// 투자에 특화된 트레이더 1명만 둔다. 특정 패턴(모멘텀/되돌림/레인지)에
// 갇히지 않고 상황에 맞는 전략을 유연하게 골라 쓰게 한다 -- 예를 들어
// 뚜렷한 하락 추세면 숏으로 추세를 따라가는 것도 포함.
const TRADERS = [
  {
    id: 'A',
    name: 'Trader X',
    badge: '',
    desc: '모멘텀 돌파, 과열/과매도 되돌림, 레인지 매매, 추세추종까지 상황에 맞춰 유연하게 구사하는 숙련된 트레이더.',
    persona: '너는 다양한 전략(모멘텀 돌파, 과열/과매도 되돌림, 레인지 매매, 추세추종)을 상황에 맞게 유연하게 구사하는 숙련된 트레이더다. 시장이 뚜렷한 방향성(추세)을 보이면 그 추세를 거스르지 않고 롱이든 숏이든 따라간다 -- 하락 추세가 명확하면 숏으로 베팅하는 것도 적극적으로 고려해라. 반대로 뚜렷한 방향이 없고 좁은 범위에서만 오간다면 레인지 매매로, 급등락 뒤에는 되돌림을 노리는 식으로 상황에 맞는 접근을 고른다. 큰 승부보다 확률 높은 기회를 자주 포착하는 걸 우선하되, 명확한 추세에서는 작은 이익에 서둘러 만족하기보다 추세가 꺾이는 신호가 나올 때까지 유연하게 들고 가도 된다. 리스크 관리는 항상 최우선이다.',
    stopLossPct: 2.5,
    takeProfitPct: 5,
    leverage: 5,
    dailyTargetPct: 1,
  },
];

function defaultState() {
  const portfolios = {};
  const dailyBase = {};
  const tradeHistory = {};
  const dailyHistory = {};
  TRADERS.forEach((t) => {
    portfolios[t.id] = { cash: START_BALANCE, holdings: {} };
    dailyBase[t.id] = null;
    tradeHistory[t.id] = [];
    dailyHistory[t.id] = [];
  });
  return { portfolios, dailyBase, tradeLog: [], tickers: {}, tradeHistory, dailyHistory, priceHistory: {}, performanceTracking: {}, costEnabledAt: null, lastCycleAt: null };
}

// 1분봉 3개를 묶어 완전히 종료된 3분봉만 사용한다.
// 조회 횟수나 수동 판단 호출이 지표의 시간 간격을 바꾸지 않는다.
const PRICE_HISTORY_LIMIT = 20;
const CANDLE_MS = 3 * 60 * 1000;

function buildClosedCandles(rows, now = Date.now()) {
  const minutes = new Map();
  for (const row of rows) {
    const ts = Number(row[0]);
    const price = Number(row[4]);
    const volume = Number(row[7]); // quote asset volume (USDT)
    if (!Number.isFinite(ts) || ts % 60000 !== 0 || !Number.isFinite(price) || price <= 0 ||
        row[7] == null || !Number.isFinite(volume) || volume < 0 || ts + 60000 > now) continue;
    minutes.set(ts, { price, volume });
  }
  const groups = new Map();
  for (const [ts, candle] of minutes) {
    const bucket = Math.floor(ts / CANDLE_MS) * CANDLE_MS;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push({ ts, ...candle });
  }
  const candles = [];
  for (const [ts, group] of [...groups].sort((a, b) => a[0] - b[0])) {
    group.sort((a, b) => a.ts - b.ts);
    if (group.length !== 3 || group[0].ts !== ts || group[2].ts !== ts + 120000 || ts + CANDLE_MS > now) continue;
    candles.push({ ts, price: group[2].price, volume: group.reduce((sum, c) => sum + c.volume, 0) });
  }
  const recent = candles.slice(-PRICE_HISTORY_LIMIT);
  if (recent.length < PRICE_HISTORY_LIMIT || now - (recent.at(-1).ts + CANDLE_MS) >= CANDLE_MS ||
      recent.some((c, i) => i > 0 && c.ts - recent[i - 1].ts !== CANDLE_MS)) {
    throw new Error('완료된 연속 3분봉 데이터 부족 또는 지연');
  }
  return recent;
}

async function updatePriceHistory(state) {
  const results = await Promise.allSettled(SYMBOLS.map(async (symbol) => {
    const res = await fetch(`https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=65`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`캔들 조회 실패: ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('잘못된 캔들 응답');
    return buildClosedCandles(rows);
  }));
  state.priceHistory = {};
  results.forEach((result, i) => {
    // 실패한 종목은 이전 지표를 재사용하지 않는다. 기존 포지션 손절은 시세로 계속 처리한다.
    state.priceHistory[SYMBOLS[i]] = result.status === 'fulfilled' ? result.value : [];
  });
}

function describeTrend(state, sym) {
  const hist = (state.priceHistory && state.priceHistory[sym]) || [];
  if (hist.length < 2) return '데이터 쌓이는 중 (아직 추세 판단 불가)';
  let dir = null;
  let streak = 0;
  for (let i = hist.length - 1; i > 0; i--) {
    if (hist[i].price === hist[i - 1].price) break;
    const curDir = hist[i].price > hist[i - 1].price ? 'up' : 'down';
    if (dir === null) { dir = curDir; streak = 1; continue; }
    if (curDir === dir) streak++;
    else break;
  }
  const first = hist[0].price;
  const last = hist[hist.length - 1].price;
  const pct = first > 0 ? ((last - first) / first) * 100 : 0;
  const dirLabel = dir === null ? '보합' : dir === 'up' ? '상승' : '하락';
  return `최근 ${hist.length}개 완료 3분봉 중 ${dirLabel} ${streak}연속, 구간 수익률 ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

// recentTrend(연속 streak)만으로는 "가격만 보고" 판단하는 거라 횡보장
// 노이즈에 잘 속는다. RSI와 거래량을 보조 신호로 추가해서 판단 근거를
// 좀 더 단단하게 만든다 -- RSI는 과매수/과매도, 거래량은 "그 움직임이
// 진짜 수급을 동반했는지"를 보여준다.
function computeRSI(hist, period = 14) {
  if (hist.length < period + 1) return null;
  const recent = hist.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i].price - recent[i - 1].price;
    if (diff > 0) gains += diff;
    else losses += -diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function describeRSI(state, sym) {
  const hist = (state.priceHistory && state.priceHistory[sym]) || [];
  const rsi = computeRSI(hist);
  if (rsi === null) return null;
  const rounded = Math.round(rsi * 10) / 10;
  let label = '중립';
  if (rsi >= 70) label = '과매수';
  else if (rsi <= 30) label = '과매도';
  return { value: rounded, label };
}

// 최신 완료 3분봉의 거래대금을 이전 19개 완료 봉의 평균과 비교한다.
function describeVolume(state, sym) {
  const hist = (state.priceHistory && state.priceHistory[sym]) || [];
  if (hist.length < PRICE_HISTORY_LIMIT) return '거래량 데이터 부족';
  const baseline = hist.slice(0, -1);
  const avg = baseline.reduce((sum, c) => sum + c.volume, 0) / baseline.length;
  if (avg <= 0) return '거래량 데이터 부족';
  const ratio = hist.at(-1).volume / avg;
  if (ratio >= 1.5) return `거래량 급증 (이전 완료 3분봉 평균 대비 ${ratio.toFixed(1)}배)`;
  if (ratio <= 0.5) return `거래량 저조 (이전 완료 3분봉 평균 대비 ${ratio.toFixed(1)}배)`;
  return `거래량 평이 (이전 완료 3분봉 평균 대비 ${ratio.toFixed(1)}배)`;
}

// 실제 모델 파인튜닝은 아니고, 트레이더별 "청산된 거래의 실현손익" 기록을
// 따로 모아뒀다가 다음 판단 프롬프트에 요약해서 넣어주는 식의 자기반성
// 피드백 루프 -- 최근 전적(승률/평균손익)을 보고 스스로 전략을 미세조정하게 한다.
const TRADE_HISTORY_LIMIT = 1000;

function recordClosedTrade(state, traderId, entry) {
  const hist = state.tradeHistory[traderId] || (state.tradeHistory[traderId] = []);
  hist.push(entry);
  if (hist.length > TRADE_HISTORY_LIMIT) hist.splice(0, hist.length - TRADE_HISTORY_LIMIT);
}

function computePerformanceStats(state, traderId) {
  const all = state.tradeHistory[traderId] || [];
  const hist = all.filter((h) => h.costVersion === COST_MODEL.version);
  const wins = hist.filter((h) => h.pnl > 0).length;
  const totalPnl = hist.reduce((sum, h) => sum + h.pnl, 0);
  const totalCosts = hist.reduce((sum, h) => sum + h.totalCosts, 0);
  const grouped = {};
  hist.forEach((h) => {
    const key = `${h.symbol}:${h.side}`;
    const row = grouped[key] || (grouped[key] = { symbol: h.symbol, side: h.side, count: 0, netPnl: 0 });
    row.count++;
    row.netPnl += h.pnl;
  });
  return { count: hist.length, wins, winRate: hist.length ? wins / hist.length * 100 : 0,
    avgPnl: hist.length ? totalPnl / hist.length : 0, totalPnl, totalCosts,
    legacyCount: all.length - hist.length, recent: hist.slice(-5), groups: Object.values(grouped),
    maxDrawdownPct: state.performanceTracking?.[traderId]?.maxDrawdownPct || 0 };
}

function buildPerformanceSummary(state, traderId) {
  const stats = computePerformanceStats(state, traderId);
  if (!stats.count) return '비용 적용 후 신규 포지션의 청산 기록이 아직 없음. 이전 무비용 거래와 비교하지 마라.';
  const recentText = stats.recent
    .map((h) => `${h.symbol.replace('USDT', '')} ${h.pnl >= 0 ? '+' : ''}${Math.round(h.pnl).toLocaleString('ko-KR')}원`)
    .join(', ');
  return `비용 적용 후 청산 ${stats.count}건(부분 청산 포함) 중 ${stats.wins}승 ${stats.count - stats.wins}패 (승률 ${stats.winRate.toFixed(0)}%), 평균 비용 차감 순손익 ${stats.avgPnl >= 0 ? '+' : ''}${Math.round(stats.avgPnl).toLocaleString('ko-KR')}원. 최근 거래: ${recentText}`;
}

// 원래 프론트엔드가 브라우저 로컬 타임존(한국 사용자 기준 KST) 자정에
// 하루 기준점을 리셋하던 것과 동일하게 맞추기 위해 타임존을 명시한다.
// (Workers 런타임의 기본 "로컬" 타임존은 UTC라서 명시 안 하면 기준이 9시간 밀린다.)
function todayDateStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}

function positionPnl(h, currentPrice) {
  const priceDiff = h.side === 'short' ? h.avgPrice - currentPrice : currentPrice - h.avgPrice;
  return priceDiff * h.qty * KRW_RATE;
}

function fundingCost(h, now = Date.now()) {
  if (!h.costStartedAt) return 0;
  return (h.accruedFundingKrw || 0) + (h.fundingNotionalKrw || 0) * COST_MODEL.fundingRatePer8h *
    Math.max(0, now - h.costStartedAt) / COST_MODEL.fundingPeriodMs;
}

function exitCosts(h, price, now = Date.now()) {
  if (!h.costStartedAt) return { fee: 0, slippage: 0, funding: 0 };
  const notional = h.qty * price * KRW_RATE;
  return { fee: notional * COST_MODEL.feeRate, slippage: notional * COST_MODEL.slippageRate,
    funding: fundingCost(h, now) };
}

function positionValue(h, currentPrice) {
  const costs = exitCosts(h, currentPrice);
  return Math.max(0, h.margin + positionPnl(h, currentPrice) - costs.fee - costs.slippage - costs.funding);
}

function initializeCostTracking(state) {
  const now = Date.now();
  state.performanceTracking ||= {};
  if (state.costEnabledAt) return;
  state.costEnabledAt = now;
  TRADERS.forEach((t) => {
    const p = state.portfolios[t.id];
    const initialValue = portfolioValue(p, state.tickers);
    state.performanceTracking[t.id] = { startedAt: now, initialValue, peakValue: initialValue, maxDrawdownPct: 0 };
    Object.values(p.holdings).filter((h) => h.qty > 0).forEach((h) => {
      // 기존 포지션의 과거 진입 비용은 소급 차감하지 않는다.
      Object.assign(h, { costVersion: 0, costStartedAt: now, accruedFundingKrw: 0,
        fundingNotionalKrw: h.qty * h.avgPrice * KRW_RATE, entryFeeKrw: 0, entrySlippageKrw: 0 });
    });
  });
}

function trackPerformance(state, tickers) {
  TRADERS.forEach((t) => {
    const tracking = state.performanceTracking?.[t.id];
    if (!tracking) return;
    const value = portfolioValue(state.portfolios[t.id], tickers);
    tracking.peakValue = Math.max(tracking.peakValue, value);
    const drawdown = tracking.peakValue > 0 ? (tracking.peakValue - value) / tracking.peakValue * 100 : 0;
    tracking.maxDrawdownPct = Math.max(tracking.maxDrawdownPct, drawdown);
  });
}

function closePosition(state, traderId, symbol, price, fraction, reason, auto) {
  const p = state.portfolios[traderId];
  const h = p.holdings[symbol];
  const now = Date.now();
  const part = { ...h, qty: h.qty * fraction, margin: h.margin * fraction,
    fundingNotionalKrw: (h.fundingNotionalKrw || 0) * fraction,
    accruedFundingKrw: (h.accruedFundingKrw || 0) * fraction };
  const grossPnl = positionPnl(part, price);
  const costs = exitCosts(part, price, now);
  const entryFeeKrw = (h.entryFeeKrw || 0) * fraction;
  const entrySlippageKrw = (h.entrySlippageKrw || 0) * fraction;
  const proceeds = Math.max(0, part.margin + grossPnl - costs.fee - costs.slippage - costs.funding);
  const netPnl = proceeds - part.margin - entryFeeKrw - entrySlippageKrw;
  const totalCosts = entryFeeKrw + entrySlippageKrw + costs.fee + costs.slippage + costs.funding;
  const pnlPct = ((price - h.avgPrice) / h.avgPrice) * 100 * (h.side === 'short' ? -1 : 1);
  p.cash += proceeds;
  p.holdings[symbol] = { ...h, qty: h.qty * (1 - fraction), margin: h.margin * (1 - fraction),
    entryFeeKrw: (h.entryFeeKrw || 0) * (1 - fraction),
    entrySlippageKrw: (h.entrySlippageKrw || 0) * (1 - fraction),
    accruedFundingKrw: (h.accruedFundingKrw || 0) * (1 - fraction),
    fundingNotionalKrw: (h.fundingNotionalKrw || 0) * (1 - fraction) };
  recordClosedTrade(state, traderId, { symbol, side: h.side, pnl: netPnl, grossPnl, pnlPct,
    totalCosts, entryFeeKrw, entrySlippageKrw, exitFeeKrw: costs.fee, exitSlippageKrw: costs.slippage,
    fundingKrw: costs.funding, costVersion: h.costVersion ?? 0, marginKrw: part.margin,
    qty: part.qty, entryPrice: h.avgPrice, exitPrice: price, openedAt: h.openedAt || null,
    heldMs: h.openedAt ? now - h.openedAt : null, entryReason: h.entryReason || null,
    entrySignals: h.entrySignals || null, entryLegs: h.entryLegs || [], exitReason: reason,
    partial: fraction < 1, ts: now });
  state.tradeLog.push({ traderId, action: 'sell', symbol, reason, auto, ts: now,
    netPnl, grossPnl, totalCosts });
}

function portfolioValue(portfolio, tickers) {
  let total = portfolio.cash;
  Object.entries(portfolio.holdings).forEach(([sym, h]) => {
    const t = tickers[sym];
    if (t && h.qty > 0) total += positionValue(h, Number(t.lastPrice));
  });
  return total;
}

// 그날 하루 안에서 목표를 한 번이라도 달성했는지 기록해둔다 (달성 후 포지션
// 정리 과정에서 일시적으로 값이 흔들려도 "그날 달성"이라는 사실 자체는 유지).
function markGoalHitToday(state, tickers) {
  TRADERS.forEach((t) => {
    const base = state.dailyBase[t.id];
    if (base && !base.hitTarget && todayPct(state, t.id, tickers) >= t.dailyTargetPct) {
      base.hitTarget = true;
    }
  });
}

// 목표를 채우면 "그날 매매 종료"라고 프론트에 보여주는데, 실제로는 Claude
// 호출만 멈추고 보유 중이던 포지션은 손절/익절 라인에 닿을 때까지 계속
// 떠 있었다(며칠이고 안 닿으면 계속 방치됨). 목표 달성 시점에 남은 포지션을
// 바로 시장가로 전량 청산해서 "매매 종료"를 실제로 종료시킨다.
function closeOpenPositionsOnGoalHit(state, tickers) {
  TRADERS.forEach((t) => {
    if (!goalReached(state, t.id, tickers)) return;
    const p = state.portfolios[t.id];
    Object.entries(p.holdings).forEach(([symbol, h]) => {
      if (h.qty <= 0) return;
      const tk = tickers[symbol];
      if (!tk) return;
      const price = Number(tk.lastPrice);
      closePosition(state, t.id, symbol, price, 1,
        `오늘 목표(+${t.dailyTargetPct}%) 달성으로 전량 청산 후 매매 종료`, true);
    });
  });
}

async function generateDayComment(env, trader, pctReturn, hit, trades) {
  const tradesText = trades.length
    ? trades
        .map((h) => `${h.symbol.replace('USDT', '')} ${h.pnl >= 0 ? '+' : ''}${Math.round(h.pnl).toLocaleString('ko-KR')}원`)
        .join(', ')
    : '청산된 거래 없음';
  const prompt = `
너는 "${trader.name}"(${trader.badge}) 트레이더의 하루 결산을 짧게 코멘트하는 역할이다.
성격/전략: ${trader.persona}
오늘 목표 수익률: +${trader.dailyTargetPct}%
오늘 실제 수익률: ${pctReturn >= 0 ? '+' : ''}${pctReturn.toFixed(2)}%
목표 달성 여부: ${hit ? '달성' : '미달성'}
오늘 청산된 거래들(최근 순): ${tradesText}

위 내용을 바탕으로 왜 목표를 달성했는지(또는 못 했는지) 1~2문장으로 자연스러운
한국어 코멘트를 써라. "~인 것 같다"처럼 분석하는 말투로, 다른 설명이나 따옴표 없이
코멘트 내용만 출력해라.
`.trim();

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`day comment fetch failed: ${res.status}`);
    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim();
    return text || (hit ? '목표를 달성했다.' : '목표를 달성하지 못했다.');
  } catch (e) {
    return hit
      ? `오늘 ${pctReturn >= 0 ? '+' : ''}${pctReturn.toFixed(2)}%로 목표를 달성한 것으로 보인다.`
      : `오늘 ${pctReturn >= 0 ? '+' : ''}${pctReturn.toFixed(2)}%에 그쳐 목표를 채우지 못한 것으로 보인다.`;
  }
}

async function archiveDay(env, state, trader, base, tickers) {
  const endValue = portfolioValue(state.portfolios[trader.id], tickers);
  const pctReturn = base.value > 0 ? ((endValue - base.value) / base.value) * 100 : 0;
  const hit = !!base.hitTarget || pctReturn >= trader.dailyTargetPct;
  const recentTrades = (state.tradeHistory[trader.id] || []).slice(-8);
  const comment = await generateDayComment(env, trader, pctReturn, hit, recentTrades);
  const hist = state.dailyHistory[trader.id] || (state.dailyHistory[trader.id] = []);
  hist.push({ date: base.date, pctReturn: Number(pctReturn.toFixed(2)), targetPct: trader.dailyTargetPct, hit, comment });
  if (hist.length > 60) hist.splice(0, hist.length - 60);
}

// 한국시간(KST) 자정 기준으로 날짜가 바뀌면 어제 하루치 결과를 dailyHistory에
// 기록(성공/실패 + 이유 코멘트)하고 오늘자 기준점을 새로 잡는다.
async function rolloverDayIfNeeded(env, state, tickers) {
  const today = todayDateStr();
  for (const t of TRADERS) {
    const base = state.dailyBase[t.id];
    if (base && base.date !== today) {
      await archiveDay(env, state, t, base, tickers);
    }
    if (!base || base.date !== today) {
      state.dailyBase[t.id] = { date: today, value: portfolioValue(state.portfolios[t.id], tickers), hitTarget: false };
    }
  }
}

function todayPct(state, traderId, tickers) {
  const base = state.dailyBase[traderId];
  if (!base || base.value <= 0) return 0;
  return ((portfolioValue(state.portfolios[traderId], tickers) - base.value) / base.value) * 100;
}

function goalReached(state, traderId, tickers) {
  const trader = TRADERS.find((t) => t.id === traderId);
  return !!state.dailyBase[traderId]?.hitTarget || todayPct(state, traderId, tickers) >= trader.dailyTargetPct;
}

async function fetchTickers() {
  // 알람 루프와 /decide-now에서만 호출된다 -- GET /state는 저장된 마지막
  // 시세를 읽기만 해서 외부 API를 직접 때리지 않는다.
  const res = await fetch('https://api.mexc.com/api/v3/ticker/24hr', {
    cf: { cacheTtl: 8, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`MEXC ticker fetch failed: ${res.status}`);
  const data = await res.json();
  const bySymbol = {};
  (data || []).forEach((d) => {
    bySymbol[d.symbol] = d;
  });
  const map = {};
  SYMBOLS.forEach((sym) => {
    const d = bySymbol[sym];
    if (!d) return;
    // MEXC의 priceChangePercent는 소수(-0.0152 = -1.52%)라 100을 곱해 맞춘다.
    // quoteVolume은 24시간 거래대금(USDT)이다. 거래량 신호는 별도 캔들 API로 계산한다.
    map[sym] = {
      lastPrice: Number(d.lastPrice),
      priceChangePercent: Number(d.priceChangePercent) * 100,
      quoteVolume: Number(d.quoteVolume || 0),
    };
  });
  return map;
}

// AI 판단과 별도로 매 사이클 손절/익절/수익보호를 검사한다.
// 재진입 대기나 초기 청산 제한은 이 자동 위험 관리에 적용하지 않는다.
//
// BREAKEVEN_*: 한 번이라도 수익이 ACTIVATE_PCT 이상 찍혔다가(peakPnlPct로 기억)
// 다시 LOCK_PCT 수준까지 줄어들면 손절선(-2.5%)까지 가기 전에 선청산한다.
// "이겼다가 역전당해 손실로 끝나는" 거래를 줄여서 승률/기대값을 같이 끌어올리는
// 장치 -- 실제 승률이 몇 %가 될지는 시장에 달려 있어 보장은 못 하지만, 구조적으로
// 유리한 방향이다.
const BREAKEVEN_ACTIVATE_PCT = 1.5;
const BREAKEVEN_LOCK_PCT = 0.3;

// 손절/익절/수익보호 셋 다 안 닿으면 포지션이 무한정 떠있을 수 있다 --
// 방향성 없이 오래 묶여있는 자본은 비효율이니, 일정 시간이 지나도록
// 거의 안 움직였으면(손익이 좁은 범위 안) 정리하고 자본을 회수한다.
// 뚜렷하게 수익/손실 중인 포지션은 이 조건에 안 걸리므로(STALE_PNL_BAND_PCT
// 밖이면 트리거 안 됨) "이기는 포지션 조기 청산 금지" 원칙과 충돌하지 않는다.
const MAX_HOLD_MS = 4 * 60 * 60 * 1000;
const STALE_PNL_BAND_PCT = 0.5;

function checkStopLossAndTakeProfit(state, tickers) {
  const now = Date.now();
  TRADERS.forEach((t) => {
    const p = state.portfolios[t.id];
    Object.entries(p.holdings).forEach(([symbol, h]) => {
      if (h.qty <= 0) return;
      const tk = tickers[symbol];
      if (!tk) return;
      const price = Number(tk.lastPrice);
      const priceChangePct = ((price - h.avgPrice) / h.avgPrice) * 100;
      const pnlPct = h.side === 'short' ? -priceChangePct : priceChangePct;
      h.peakPnlPct = Math.max(h.peakPnlPct || 0, pnlPct);
      const value = positionValue(h, price);
      const sideLabel = h.side === 'short' ? '숏' : '롱';
      const heldMs = now - (h.openedAt || now);
      let triggered = null;
      if (value <= 0) {
        triggered = `강제 청산 (${sideLabel} 레버리지 ${t.leverage}x, 증거금 전액 손실)`;
      } else if (pnlPct <= -t.stopLossPct) {
        triggered = `자동 손절 (${sideLabel}, 손익 ${pnlPct.toFixed(1)}%, 기준 -${t.stopLossPct}%)`;
      } else if (pnlPct >= t.takeProfitPct) {
        triggered = `자동 익절 (${sideLabel}, 손익 +${pnlPct.toFixed(1)}%, 기준 +${t.takeProfitPct}%)`;
      } else if (h.peakPnlPct >= BREAKEVEN_ACTIVATE_PCT && pnlPct <= BREAKEVEN_LOCK_PCT) {
        triggered = `수익 보호 청산 (${sideLabel}, 최고 +${h.peakPnlPct.toFixed(1)}% 찍고 +${pnlPct.toFixed(1)}%로 줄어들어 선청산)`;
      } else if (heldMs >= MAX_HOLD_MS && Math.abs(pnlPct) < STALE_PNL_BAND_PCT) {
        triggered = `장시간 방향성 없어 자동 정리 (${sideLabel}, ${(heldMs / 3600000).toFixed(1)}시간 보유, 손익 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`;
      }
      if (triggered) {
        closePosition(state, t.id, symbol, price, 1, triggered, true);
      }
    });
  });
}

// 여러 종목을 동시에 보유할 수 있게 되면서, 종목별로는 리스크 관리를
// 해도 "전체적으로 얼마나 베팅 중인지"는 아무도 안 보는 문제가 생긴다.
// BTC/ETH/SOL/XRP/DOGE는 급락장에서 같이 움직이는 경향이 커서, 여러
// 종목에 나눠 들어가도 실제로는 분산이 아니라 레버리지가 겹치는
// 효과일 수 있다. 전체 포트폴리오 가치 대비 동시 보유 가능한 총
// 증거금 비율에 상한을 둬서, 새 진입이 그 상한을 넘으면 증거금을
// 줄이거나(여유분만큼) 아예 막는다.
const MAX_TOTAL_EXPOSURE_PCT = 60;
const REENTRY_COOLDOWN_MS = 9 * 60 * 1000;

function validateDecision(decision) {
  if (!['buy', 'short', 'sell', 'hold'].includes(decision.action) ||
      (decision.action !== 'hold' && !SYMBOLS.includes(decision.symbol)) ||
      !Number.isFinite(decision.amountKrw) || decision.amountKrw < 0 ||
      typeof decision.reason !== 'string') throw new Error('잘못된 매매 판단');
}

function confirmedReversal(hist, side) {
  if (!hist || hist.length < 3) return false;
  const [a, b, c] = hist.slice(-3).map((h) => h.price);
  const change = ((c - a) / a) * 100;
  return side === 'short' ? b > a && c > b && change >= 0.1 : b < a && c < b && change <= -0.1;
}

function applyDecision(state, traderId, decision, tickers) {
  validateDecision(decision);
  const p = state.portfolios[traderId];
  const trader = TRADERS.find((x) => x.id === traderId);
  const { action, symbol, amountKrw, reason } = decision;
  if ((action === 'buy' || action === 'short') && symbol && amountKrw > 0) {
    const lastClose = [...(state.tradeHistory[traderId] || [])].reverse().find((entry) => entry.symbol === symbol);
    if ((state.priceHistory[symbol] || []).length < PRICE_HISTORY_LIMIT ||
        (lastClose && Date.now() - lastClose.ts < REENTRY_COOLDOWN_MS)) {
      decision.action = 'hold';
      decision.reason = `${reason} [캔들 데이터 부족 또는 청산 후 9분 재진입 대기]`;
      state.tradeLog.push({ traderId, action: 'hold', symbol, reason: decision.reason, auto: !!decision.auto, ts: Date.now() });
      return;
    }
    const side = action === 'short' ? 'short' : 'long';
    const t = tickers[symbol];
    const prev = p.holdings[symbol];
    const blocked = prev && prev.qty > 0 && prev.side !== side;
    const totalValue = portfolioValue(p, tickers);
    const committedMargin = Object.values(p.holdings).reduce((s, h) => s + (h.qty > 0 ? h.margin : 0), 0);
    const maxAllowedMargin = totalValue * (MAX_TOTAL_EXPOSURE_PCT / 100);
    const room = Math.max(0, maxAllowedMargin - committedMargin);
    const costRateOnMargin = trader.leverage * (COST_MODEL.feeRate + COST_MODEL.slippageRate);
    const cappedAmount = Math.min(amountKrw, room, p.cash / (1 + costRateOnMargin));
    if (t && !blocked && cappedAmount > 0 && p.cash >= cappedAmount) {
      const price = Number(t.lastPrice);
      const margin = cappedAmount;
      const notional = margin * trader.leverage;
      const qty = notional / (price * KRW_RATE);
      const base = prev && prev.qty > 0 ? prev : { qty: 0, avgPrice: price, margin: 0, side, peakPnlPct: 0, openedAt: Date.now() };
      const entryFeeKrw = notional * COST_MODEL.feeRate;
      const entrySlippageKrw = notional * COST_MODEL.slippageRate;
      const now = Date.now();
      const rsi = describeRSI(state, symbol);
      const signals = { trend: describeTrend(state, symbol), rsi: rsi?.value ?? null,
        volume: describeVolume(state, symbol) };
      const leg = { ts: now, price, qty, marginKrw: margin, notionalKrw: notional,
        feeKrw: entryFeeKrw, slippageKrw: entrySlippageKrw, reason, signals };
      const newQty = base.qty + qty;
      const newAvgPrice = (base.qty * base.avgPrice + qty * price) / newQty;
      p.holdings[symbol] = {
        qty: newQty,
        avgPrice: newAvgPrice,
        margin: base.margin + margin,
        side,
        peakPnlPct: base.peakPnlPct || 0,
        openedAt: base.openedAt || now,
        costVersion: base.qty > 0 ? (base.costVersion ?? 0) : COST_MODEL.version,
        costStartedAt: now, accruedFundingKrw: fundingCost(base, now),
        fundingNotionalKrw: (base.fundingNotionalKrw || 0) + notional,
        entryFeeKrw: (base.entryFeeKrw || 0) + entryFeeKrw,
        entrySlippageKrw: (base.entrySlippageKrw || 0) + entrySlippageKrw,
        entryReason: base.entryReason || reason, entrySignals: base.entrySignals || signals,
        entryLegs: [...(base.entryLegs || []), leg].slice(-30),
      };
      p.cash -= margin + entryFeeKrw + entrySlippageKrw;
      decision.marginKrw = margin;
      decision.notionalKrw = notional;
      decision.entryCostsKrw = entryFeeKrw + entrySlippageKrw;
      if (cappedAmount < amountKrw) {
        decision.reason = `${reason} [전체 노출 한도(${MAX_TOTAL_EXPOSURE_PCT}%)로 증거금 ${amountKrw.toLocaleString('ko-KR')}→${Math.round(cappedAmount).toLocaleString('ko-KR')}원 축소]`;
      }
    } else {
      decision.action = 'hold';
      decision.reason = `${reason} [전체 노출 한도·현금·반대 포지션 확인 후 진입 보류]`;
    }
  } else if (action === 'sell' && symbol) {
    const t = tickers[symbol];
    const prev = p.holdings[symbol];
    if (t && prev && prev.qty > 0) {
      const price = Number(t.lastPrice);
      const currentPnlPct = ((price - prev.avgPrice) / prev.avgPrice) * 100 * (prev.side === 'short' ? -1 : 1);
      if (prev.openedAt && Date.now() - prev.openedAt < REENTRY_COOLDOWN_MS &&
          Math.abs(currentPnlPct) < 0.5 && !confirmedReversal(state.priceHistory[symbol], prev.side)) {
        decision.action = 'hold';
        decision.reason = `${reason} [진입 초기 미세 변동: 완료 3분봉 2개 이상의 반대 추세 확인 전 청산 보류]`;
        state.tradeLog.push({ traderId, action: 'hold', symbol, reason: decision.reason, auto: !!decision.auto, ts: Date.now() });
        return;
      }
      const fraction = amountKrw ? Math.min(1, amountKrw / prev.margin) : 1;
      closePosition(state, traderId, symbol, price, fraction, reason, !!decision.auto);
      return;
    }
  }
  state.tradeLog.push({ traderId, action: decision.action, symbol, reason: decision.reason, auto: !!decision.auto, ts: Date.now(),
    marginKrw: decision.marginKrw, notionalKrw: decision.notionalKrw, entryCostsKrw: decision.entryCostsKrw });
}

const DECISION_SCHEMA_PROMPT = `
너는 가상 투자 시뮬레이션의 트레이더다.
모의 비용은 체결금액 기준 진입/청산 각각 수수료 0.05%, 슬리피지 0.02%,
보유비용은 8시간당 0.01%를 시간 비례로 차감한다(실제 거래소 요율이 아닌 가정).
왕복 체결 비용 약 0.14%와 보유비용을 넘길 근거가 없는 미세한 움직임에는 진입하지 마라.
매매 횟수나 하루 목표보다 비용 차감 후 기대 순손익을 우선해라. 아래 성격/전략, 레버리지 배율, 현재 보유 자산,
시장 시세를 보고 롱 진입/숏 진입/청산/관망 중 하나를 판단해라.

이 트레이더는 레버리지를 쓴다 -- amountKrw로 적은 금액은 "증거금"이고, 실제 포지션
크기는 증거금 x 레버리지로 커진다. 손실도 그만큼 증폭되니 증거금 비중을 과도하게
키우지 않도록 주의해라.

상승장만 기다리지 말고, 하락이 예상되면 숏(인버스)도 적극적으로 활용해라.
롱(buy)은 가격 상승에 베팅, 숏(short)은 가격 하락에 베팅이다 (숏은 가격이
떨어질수록 이익, 오를수록 손실 -- 포지션 방향이 반대로 작동함에 유의).
한 종목에 롱/숏을 동시에 가질 수는 없다 -- 이미 반대 방향 포지션이 있으면
먼저 sell로 청산한 뒤에 방향을 바꿔라.

**여러 종목을 동시에 보유해도 된다.** 이미 한두 종목에 포지션이 있어도,
다른 종목에서 괜찮은 기회가 보이면 추가로 진입해서 분산해도 괜찮다. 다만
BTC/ETH/SOL/XRP/DOGE는 급락장에서 서로 같이 움직이는 경향이 커서, 여러
종목에 나눠 들어가도 실제 리스크 분산 효과는 생각보다 작을 수 있다 --
전체 포트폴리오 가치의 ${MAX_TOTAL_EXPOSURE_PCT}%까지만 동시에 증거금으로
묶을 수 있도록 시스템이 자동으로 제한하니(넘으면 증거금이 줄거나 진입이
보류됨), 그 안에서 종목별 비중을 알아서 합리적으로 배분해라.

market 데이터의 각 심볼에는 recentTrend/rsi/volumeSignal이 같이 온다.
recentTrend는 "최근 N개 완료 3분봉 중 하락 5연속, 구간 수익률 -2.3%" 같은 식으로
방향성 확인용이고, rsi는 과매수(70 이상)/과매도(30 이하)/중립을 보여주고,
volumeSignal은 그 가격 움직임에 거래량이 실제로 동반됐는지("거래량 급증"
"거래량 저조")를 보여준다. 셋을 같이 봐라 -- recentTrend가 연속 3~4회 이상
같은 방향이어도 거래량이 저조하면 노이즈일 가능성이 있고, 반대로 거래량
급증을 동반한 추세는 신뢰도가 더 높다. RSI가 과매수인데 추가로 롱 진입하거나
과매도인데 추가로 숏 진입하는 건 피해라(되돌림 리스크). 매번 "아직 명확한
추세가 아니다"라며 관망만 반복하지는 마라 -- 신호들이 같은 방향을 가리키면
행동해도 된다.

청산 후 같은 종목에 9분 동안 재진입하지 않는다. 진입 후 9분 안의 ±0.5% 미만
미세 변동에서는 완료 3분봉 2개 연속 반대 방향, 합계 0.1% 이상 변화가 확인되어야
수동 청산할 수 있다. 손절/익절/수익보호 자동 규칙은 이 제한과 무관하게 계속 적용된다.
거래량 급증이나 RSI 과매도만으로 추세 반전이 확인됐다고 판단하지 마라.

**이미 보유 중인 포지션을 너무 일찍 끊지 마라.** 너는 포지션이 있어도 3분마다
계속 호출된다 -- 보유 중인 포지션이 추세 방향과 같은 방향으로 수익이 나고
있고, 그 종목의 recentTrend streak가 아직 살아있다면(추세가 꺾였다는 신호가
없다면), 몇 천 원 수준의 작은 이익만 보고 서둘러 팔지 마라. 손절(-2.5%)은
자동으로 큰 폭까지 열려 있는데 네가 스스로 익절을 매번 아주 작게 끊어버리면
승률이 괜찮아도 전체 손익은 마이너스가 된다. 이기는 포지션은 추세가 반대로
꺾이는 신호가 나오거나 자동 익절(+5%)/수익보호 규칙에 닿을 때까지 들고 가는
게 기본값이고, 지는 포지션은 짧게 끊는 게 맞는 방향이다.

오늘 목표 수익률은 크지 않다(1% 안팎). 큰 승부를 걸어서 한 번에 채우려 하지
말고, 확률 높은 기회를 노려서 목표를 채우는 데 집중해라. 목표를 채우면
오늘 열려있던 포지션도 전부 정리되고 그날 매매는 자동으로 종료된다.

아래에 네가 최근에 청산했던 거래들의 실제 손익 전적(승률/평균손익)이 요약되어
주어진다. 이건 네 모델 자체가 학습된 게 아니라 매번 참고하라고 주는 경험
피드백이다 -- 특정 심볼/방향/진입 패턴에서 반복적으로 손실이 났다면 그 패턴의
진입 자체를 피하거나 증거금 비중을 줄이고, 잘 통하고 있는 접근(승률 높은
패턴)은 비중을 유지해라. **승률이 낮다는 이유로 이미 추세를 타고 수익 중인
포지션을 조기 청산하는 근거로 쓰지는 마라** -- 그건 새 진입 판단에만 참고하고,
몇 건 안 되는 표본으로 성격 자체를 뒤집진 마라.

반드시 아래 JSON 형식으로만 답해라. 다른 설명 텍스트는 붙이지 마라.
{
  "action": "buy" | "short" | "sell" | "hold",
  "symbol": "BTCUSDT" 같은 심볼 (action이 hold면 null 가능),
  "amountKrw": buy/short면 증거금으로 쓸 원화 금액, sell이면 청산하고 싶은 증거금 규모
               (전량 청산이면 보유 증거금 전체 금액을 적어라, 정수, hold면 0),
  "reason": "판단 근거를 2~3문장 한국어로"
}
`.trim();

async function callClaude(env, persona, leverage, portfolio, market, myTodayPct, performanceSummary) {
  const userContent = `
[트레이더 성격/전략]
${persona}

[레버리지]
${leverage}x

[현재 보유 현금]
${portfolio.cash}원

[현재 보유 자산 (margin=증거금, qty=레버리지 적용된 수량, avgPrice=평균단가, side=long|short)]
${JSON.stringify(portfolio.holdings)}

[현재 시세]
${JSON.stringify(market)}

[오늘 수익률과 목표: 퍼센트 단위, 0.1은 0.1%이며 1%가 아니다]
${JSON.stringify({ todayReturnPct: myTodayPct, targetReturnPct: TRADERS[0].dailyTargetPct,
  targetReached: myTodayPct >= TRADERS[0].dailyTargetPct,
  remainingPercentagePoints: Math.max(0, TRADERS[0].dailyTargetPct - myTodayPct) })}
목표 달성 여부는 targetReached만 사용해라. 손실 만회나 목표를 채우기 위한 이유만으로 진입하지 마라.

[최근 내 거래 성과 피드백]
${performanceSummary}
`.trim();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: DECISION_SCHEMA_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude 응답에서 JSON을 찾지 못함: ' + text);
  return JSON.parse(match[0]);
}

async function runTraderDecision(env, state, tickers, traderId, auto) {
  const trader = TRADERS.find((t) => t.id === traderId);
  // 오늘 목표를 채웠을 때만 Claude 호출을 멈춘다 (그 시점엔
  // closeOpenPositionsOnGoalHit이 남은 포지션도 바로 정리한다). 그 외엔
  // 포지션을 들고 있어도 3분마다 계속 호출해서 다른 종목 기회도 같이
  // 살피고, 여러 종목을 동시에 보유할 수 있다. 손절/익절/수익보호는
  // 여전히 checkStopLossAndTakeProfit이 자동으로 처리한다.
  if (goalReached(state, traderId, tickers)) {
    return { traderId, skipped: true, reason: 'goal_reached' };
  }
  const market = SYMBOLS.map((s) => {
    const t = tickers[s];
    if (!t || (state.priceHistory[s] || []).length < PRICE_HISTORY_LIMIT) return null;
    const rsi = describeRSI(state, s);
    return {
      symbol: s,
      price: Number(t.lastPrice),
      changePercent: Number(t.priceChangePercent),
      recentTrend: describeTrend(state, s),
      rsi: rsi ? `${rsi.value} (${rsi.label})` : '데이터 쌓이는 중',
      volumeSignal: describeVolume(state, s),
    };
  }).filter(Boolean);
  if (!market.length) return { traderId, skipped: true, reason: 'candle_data_unavailable' };
  try {
    const decision = await callClaude(
      env,
      trader.persona,
      trader.leverage,
      state.portfolios[traderId],
      market,
      Number(todayPct(state, traderId, tickers).toFixed(2)),
      buildPerformanceSummary(state, traderId)
    );
    applyDecision(state, traderId, { ...decision, auto }, tickers);
    return { traderId, skipped: false, decision };
  } catch (e) {
    state.tradeLog.push({ traderId, action: 'hold', symbol: null, reason: `오류: ${e.message}`, auto, ts: Date.now() });
    return { traderId, skipped: false, error: e.message };
  }
}

function buildStateView(state, tickers) {
  const traders = TRADERS.map((t) => {
    const p = state.portfolios[t.id];
    const value = portfolioValue(p, tickers);
    const pnl = value - START_BALANCE;
    const pnlPct = (pnl / START_BALANCE) * 100;
    const todayPctVal = todayPct(state, t.id, tickers);
    const holdings = Object.entries(p.holdings)
      .filter(([, h]) => h.qty > 0)
      .map(([symbol, h]) => {
        const tk = tickers[symbol];
        const val = tk ? positionValue(h, Number(tk.lastPrice)) : h.margin;
        const priceChangePct = tk ? ((Number(tk.lastPrice) - h.avgPrice) / h.avgPrice) * 100 : 0;
        const pnlPctForSide = h.side === 'short' ? -priceChangePct : priceChangePct;
        return { symbol, side: h.side, value: val, pnlPct: pnlPctForSide };
      });
    const perf = computePerformanceStats(state, t.id);
    return {
      id: t.id,
      name: t.name,
      badge: t.badge,
      desc: t.desc,
      leverage: t.leverage,
      dailyTargetPct: t.dailyTargetPct,
      value,
      pnl,
      pnlPct,
      todayPct: todayPctVal,
      goalHit: goalReached(state, t.id, tickers),
      holdings,
      closedTrades: perf.count,
      winRate: perf.count ? Math.round(perf.winRate) : null,
      performance: perf,
      costModel: { ...COST_MODEL, enabledAt: state.costEnabledAt },
      closedTradeHistory: (state.tradeHistory[t.id] || []).slice(-50).reverse(),
      dailyHistory: (state.dailyHistory[t.id] || []).slice().reverse(),
    };
  });
  return {
    serverTime: Date.now(),
    lastCycleAt: state.lastCycleAt || null,
    krwRate: KRW_RATE,
    startBalance: START_BALANCE,
    intervalSeconds: INTERVAL_SECONDS,
    traders,
    tradeLog: state.tradeLog.slice(-50).reverse(),
  };
}

export class TraderEngine {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.env = env;
    // DO가 처음 깨어났거나 알람 체인이 끊겼을 때를 대비해, 예약된 알람이
    // 없으면 즉시(지금) 하나 잡아서 루프를 시작시킨다.
    this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.storage.getAlarm();
      if (existing === null) {
        await this.storage.setAlarm(Date.now());
      }
    });
  }

  async loadState() {
    const raw = await this.storage.get('state');
    const base = defaultState();
    if (!raw) return base;
    return {
      portfolios: { ...base.portfolios, ...raw.portfolios },
      dailyBase: { ...base.dailyBase, ...raw.dailyBase },
      tradeLog: Array.isArray(raw.tradeLog) ? raw.tradeLog : [],
      tickers: raw.tickers || {},
      tradeHistory: { ...base.tradeHistory, ...raw.tradeHistory },
      dailyHistory: { ...base.dailyHistory, ...raw.dailyHistory },
      priceHistory: raw.priceHistory || {},
      performanceTracking: raw.performanceTracking || {},
      costEnabledAt: raw.costEnabledAt || null,
      lastCycleAt: raw.lastCycleAt || null,
    };
  }

  async saveState(state) {
    const trimmed = { ...state, tradeLog: state.tradeLog.slice(-200) };
    await this.storage.put('state', trimmed);
  }

  async runCycle(auto) {
    const state = await this.loadState();
    initializeCostTracking(state);
    const tickers = await fetchTickers();
    state.tickers = tickers;
    await updatePriceHistory(state);
    await rolloverDayIfNeeded(this.env, state, tickers);
    markGoalHitToday(state, tickers);
    checkStopLossAndTakeProfit(state, tickers);
    closeOpenPositionsOnGoalHit(state, tickers);
    // 3명을 동시에 판단시킨다 -- 순서대로 돌리면 사이클 하나에 Claude 호출
    // 3번이 직렬로 쌓여서 짧은 주기를 맞추기 어렵다. 트레이더별로 포트폴리오가
    // 분리돼 있어 동시 실행해도 서로의 state를 침범하지 않는다.
    const results = await Promise.all(
      TRADERS.map((t) => runTraderDecision(this.env, state, tickers, t.id, auto))
    );
    trackPerformance(state, tickers);
    state.lastCycleAt = Date.now();
    await this.saveState(state);
    return { state, tickers, results };
  }

  async alarm() {
    try {
      await this.runCycle(true);
    } finally {
      await this.storage.setAlarm(Date.now() + INTERVAL_SECONDS * 1000);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/state' && request.method === 'GET') {
      const state = await this.loadState();
      return json(buildStateView(state, state.tickers));
    }

    if (url.pathname === '/decide-now' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: '잘못된 요청 본문' }, 400);
      }
      const traderId = body.traderId;
      if (!TRADERS.find((t) => t.id === traderId)) {
        return json({ error: 'traderId가 올바르지 않습니다' }, 400);
      }
      const state = await this.loadState();
      initializeCostTracking(state);
      const tickers = await fetchTickers();
      state.tickers = tickers;
      await updatePriceHistory(state);
      await rolloverDayIfNeeded(this.env, state, tickers);
      markGoalHitToday(state, tickers);
      checkStopLossAndTakeProfit(state, tickers);
      closeOpenPositionsOnGoalHit(state, tickers);
      const result = await runTraderDecision(this.env, state, tickers, traderId, false);
      trackPerformance(state, tickers);
      state.lastCycleAt = Date.now();
      await this.saveState(state);
      return json({ result, view: buildStateView(state, tickers) });
    }

    if (url.pathname === '/run-now') {
      // 알람을 기다리지 않고 수동으로 한 사이클을 돌려보기 위한 테스트용 엔드포인트.
      const { state, tickers, results } = await this.runCycle(true);
      return json({ results, view: buildStateView(state, tickers) });
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      // 전원 시드머니/포지션/로그를 초기화한다 (예: 트레이더 성격이나 레버리지
      // 설정을 통째로 바꿨을 때, 옛 설정으로 잡힌 포지션을 들고 가지 않도록).
      await this.saveState(defaultState());
      return json({ ok: true });
    }

    if (url.pathname === '/debug/force-rollover' && request.method === 'POST') {
      // 실제 자정을 기다리지 않고 하루 마감(rollover) 로직을 테스트하기 위한
      // 디버그용 엔드포인트. dailyBase의 날짜만 어제로 되돌려서, 다음 사이클
      // (또는 이 호출 직후의 /run-now)에서 진짜 rollover 경로를 타게 만든다.
      const state = await this.loadState();
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(yesterday);
      TRADERS.forEach((t) => {
        if (state.dailyBase[t.id]) state.dailyBase[t.id].date = yStr;
      });
      await this.saveState(state);
      return json({ ok: true, setTo: yStr });
    }

    return json({ error: 'not found' }, 404);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const id = env.TRADER_ENGINE.idFromName('global');
    const stub = env.TRADER_ENGINE.get(id);
    return stub.fetch(request);
  },
};
