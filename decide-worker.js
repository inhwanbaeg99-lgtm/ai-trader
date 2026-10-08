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
const INTERVAL_SECONDS = 180; // 판단 주기 -- 당분간 비용 아끼면서 전적 데이터부터 쌓는 단계라 3분으로 조정

// 시세 소스 변천사: Binance(fapi/api 전부)·Bybit·CoinGecko는 Cloudflare
// Workers 엣지 IP를 아예 차단(403/451/429)한다. OKX는 처음엔 됐지만 이후
// 우리 쪽 요청에도 계속 429를 줘서(공유 엣지 IP 풀의 다른 트래픽 영향일
// 가능성) 신뢰할 수 없었음. MEXC가 바이낸스와 거의 동일한 API 포맷을
// 쓰면서 Workers에서 막히지 않아 최종적으로 이걸 사용.

// 위험도(공격/안정/역발상)가 아니라 "어떤 신호에 반응하는 매매 스타일인가"로
// 성격을 나눈다. 목표가 하루 +1%로 작아졌으니 셋 다 큰 승부를 걸 필요 없이
// 확률 높은 작은 기회를 자주/빠르게 챙기는 쪽으로 레버리지를 낮추고
// 손절은 노이즈에 덜 털리게 여유를 주되, 익절은 타이트하게 잡아 이익을
// 빨리 확정 짓게 했다 (목표 달성 확률을 올리는 핵심 레버는 "작은 이익을
// 반대로 돌아서기 전에 빨리 잠근다"는 점).
const TRADERS = [
  {
    id: 'A',
    name: 'Trader A',
    badge: '모멘텀추격형',
    desc: '거래량이 실리는 단기 돌파 움직임을 빠르게 쫓아 들어갔다가, 조금이라도 이익이 나면 바로 실현하는 성격.',
    persona: '너는 단기 모멘텀(거래량이 실린 뚜렷한 돌파 움직임)을 빠르게 포착해 진입하는 트레이더다. 큰 승부보다 확률 높은 작은 기회를 자주 잡는 걸 우선한다. 포지션에 조금이라도 이익이 나면 추가 상승을 욕심내지 않고 빠르게 실현해서 확정 짓는다. 모멘텀이 꺾이는 기미가 보이면 미련 두지 않고 바로 정리한다.',
    stopLossPct: 2,
    takeProfitPct: 3,
    leverage: 5,
    dailyTargetPct: 1,
  },
  {
    id: 'B',
    name: 'Trader B',
    badge: '되돌림매매형',
    desc: '단기 급등락 뒤에 오는 되돌림(눌림목/단기 반등)을 짧게 노려 빠르게 치고 빠지는 성격.',
    persona: '너는 단기 과열/과매도 이후의 되돌림(눌림목 매수, 단기 반등 숏)을 짧게 노리는 트레이더다. 큰 추세를 예측하려 하지 않고, 직전 급등락 폭의 일부라도 되돌아올 확률이 높은 구간만 짧게 공략한다. 작은 수익이 나면 욕심부리지 않고 바로 실현한다.',
    stopLossPct: 2,
    takeProfitPct: 3,
    leverage: 4,
    dailyTargetPct: 1,
  },
  {
    id: 'C',
    name: 'Trader C',
    badge: '레인지스캘퍼형',
    desc: '최근 좁은 가격 범위 안에서 오르내리는 흐름을 짧게 왕복 매매하는 성격.',
    persona: '너는 최근 좁은 가격 범위(레인지) 안에서 오가는 흐름을 짧게 왕복 매매하는 트레이더다. 범위 하단 근처에서 롱, 상단 근처에서 숏처럼 짧고 확률 높은 매매를 반복하며, 범위를 크게 벗어나는 변동에는 무리해서 따라가지 않는다. 작은 이익은 바로 실현한다.',
    stopLossPct: 2,
    takeProfitPct: 3,
    leverage: 4,
    dailyTargetPct: 1,
  },
];

function defaultState() {
  const portfolios = {};
  const dailyBase = {};
  const tradeHistory = {};
  TRADERS.forEach((t) => {
    portfolios[t.id] = { cash: START_BALANCE, holdings: {} };
    dailyBase[t.id] = null;
    tradeHistory[t.id] = [];
  });
  return { portfolios, dailyBase, tradeLog: [], tickers: {}, tradeHistory };
}

// 실제 모델 파인튜닝은 아니고, 트레이더별 "청산된 거래의 실현손익" 기록을
// 따로 모아뒀다가 다음 판단 프롬프트에 요약해서 넣어주는 식의 자기반성
// 피드백 루프 -- 최근 전적(승률/평균손익)을 보고 스스로 전략을 미세조정하게 한다.
const TRADE_HISTORY_LIMIT = 30;

function recordClosedTrade(state, traderId, entry) {
  const hist = state.tradeHistory[traderId] || (state.tradeHistory[traderId] = []);
  hist.push(entry);
  if (hist.length > TRADE_HISTORY_LIMIT) hist.splice(0, hist.length - TRADE_HISTORY_LIMIT);
}

function computePerformanceStats(state, traderId) {
  const hist = state.tradeHistory[traderId] || [];
  if (!hist.length) return { count: 0, wins: 0, winRate: 0, avgPnl: 0, recent: [] };
  const wins = hist.filter((h) => h.pnl > 0).length;
  const winRate = (wins / hist.length) * 100;
  const avgPnl = hist.reduce((s, h) => s + h.pnl, 0) / hist.length;
  return { count: hist.length, wins, winRate, avgPnl, recent: hist.slice(-5) };
}

function buildPerformanceSummary(state, traderId) {
  const stats = computePerformanceStats(state, traderId);
  if (!stats.count) return '아직 청산한 거래 기록이 없음 (참고할 과거 전적 없음).';
  const recentText = stats.recent
    .map((h) => `${h.symbol.replace('USDT', '')} ${h.pnl >= 0 ? '+' : ''}${Math.round(h.pnl).toLocaleString('ko-KR')}원`)
    .join(', ');
  return `최근 청산 ${stats.count}건 중 ${stats.wins}승 ${stats.count - stats.wins}패 (승률 ${stats.winRate.toFixed(0)}%), 평균 손익 ${stats.avgPnl >= 0 ? '+' : ''}${Math.round(stats.avgPnl).toLocaleString('ko-KR')}원. 최근 거래: ${recentText}`;
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

function positionValue(h, currentPrice) {
  return Math.max(0, h.margin + positionPnl(h, currentPrice));
}

function portfolioValue(portfolio, tickers) {
  let total = portfolio.cash;
  Object.entries(portfolio.holdings).forEach(([sym, h]) => {
    const t = tickers[sym];
    if (t && h.qty > 0) total += positionValue(h, Number(t.lastPrice));
  });
  return total;
}

function ensureDailyBaseline(state, tickers) {
  const today = todayDateStr();
  TRADERS.forEach((t) => {
    const base = state.dailyBase[t.id];
    if (!base || base.date !== today) {
      state.dailyBase[t.id] = { date: today, value: portfolioValue(state.portfolios[t.id], tickers) };
    }
  });
}

function todayPct(state, traderId, tickers) {
  const base = state.dailyBase[traderId];
  if (!base || base.value <= 0) return 0;
  return ((portfolioValue(state.portfolios[traderId], tickers) - base.value) / base.value) * 100;
}

function goalReached(state, traderId, tickers) {
  const trader = TRADERS.find((t) => t.id === traderId);
  return todayPct(state, traderId, tickers) >= trader.dailyTargetPct;
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
    map[sym] = { lastPrice: Number(d.lastPrice), priceChangePercent: Number(d.priceChangePercent) * 100 };
  });
  return map;
}

// LLM 호출 없이, 매 사이클 가격을 확인해서 보유 포지션의 평균매입가 대비
// 손익률이 손절/익절 라인에 닿으면 즉시 전량 매도한다.
function checkStopLossAndTakeProfit(state, tickers) {
  TRADERS.forEach((t) => {
    const p = state.portfolios[t.id];
    Object.entries(p.holdings).forEach(([symbol, h]) => {
      if (h.qty <= 0) return;
      const tk = tickers[symbol];
      if (!tk) return;
      const price = Number(tk.lastPrice);
      const priceChangePct = ((price - h.avgPrice) / h.avgPrice) * 100;
      const pnlPct = h.side === 'short' ? -priceChangePct : priceChangePct;
      const value = positionValue(h, price);
      const sideLabel = h.side === 'short' ? '숏' : '롱';
      let triggered = null;
      if (value <= 0) {
        triggered = `강제 청산 (${sideLabel} 레버리지 ${t.leverage}x, 증거금 전액 손실)`;
      } else if (pnlPct <= -t.stopLossPct) {
        triggered = `자동 손절 (${sideLabel}, 손익 ${pnlPct.toFixed(1)}%, 기준 -${t.stopLossPct}%)`;
      } else if (pnlPct >= t.takeProfitPct) {
        triggered = `자동 익절 (${sideLabel}, 손익 +${pnlPct.toFixed(1)}%, 기준 +${t.takeProfitPct}%)`;
      }
      if (triggered) {
        const realizedPnl = positionPnl(h, price);
        p.cash += value;
        p.holdings[symbol] = { qty: 0, avgPrice: h.avgPrice, margin: 0, side: h.side };
        state.tradeLog.push({ traderId: t.id, action: 'sell', symbol, reason: triggered, auto: true, ts: Date.now() });
        recordClosedTrade(state, t.id, { symbol, pnl: realizedPnl, pnlPct, ts: Date.now() });
      }
    });
  });
}

function applyDecision(state, traderId, decision, tickers) {
  const p = state.portfolios[traderId];
  const trader = TRADERS.find((x) => x.id === traderId);
  const { action, symbol, amountKrw, reason } = decision;
  if ((action === 'buy' || action === 'short') && symbol && amountKrw > 0) {
    const side = action === 'short' ? 'short' : 'long';
    const t = tickers[symbol];
    const prev = p.holdings[symbol];
    const blocked = prev && prev.qty > 0 && prev.side !== side;
    if (t && !blocked && p.cash >= amountKrw) {
      const price = Number(t.lastPrice);
      const margin = amountKrw;
      const notional = margin * trader.leverage;
      const qty = notional / (price * KRW_RATE);
      const base = prev && prev.qty > 0 ? prev : { qty: 0, avgPrice: price, margin: 0, side };
      const newQty = base.qty + qty;
      const newAvgPrice = (base.qty * base.avgPrice + qty * price) / newQty;
      p.holdings[symbol] = { qty: newQty, avgPrice: newAvgPrice, margin: base.margin + margin, side };
      p.cash -= margin;
    }
  } else if (action === 'sell' && symbol) {
    const t = tickers[symbol];
    const prev = p.holdings[symbol];
    if (t && prev && prev.qty > 0) {
      const price = Number(t.lastPrice);
      const fraction = amountKrw ? Math.min(1, amountKrw / prev.margin) : 1;
      const sellQty = prev.qty * fraction;
      const releasedMargin = prev.margin * fraction;
      const pnl = positionPnl({ ...prev, qty: sellQty }, price);
      const priceChangePct = ((price - prev.avgPrice) / prev.avgPrice) * 100;
      const pnlPct = prev.side === 'short' ? -priceChangePct : priceChangePct;
      p.cash += Math.max(0, releasedMargin + pnl);
      p.holdings[symbol] = { qty: prev.qty - sellQty, avgPrice: prev.avgPrice, margin: prev.margin - releasedMargin, side: prev.side };
      recordClosedTrade(state, traderId, { symbol, pnl, pnlPct, ts: Date.now() });
    }
  }
  state.tradeLog.push({ traderId, action, symbol, reason, auto: !!decision.auto, ts: Date.now() });
}

const DECISION_SCHEMA_PROMPT = `
너는 가상 투자 시뮬레이션의 트레이더다. 아래 성격/전략, 레버리지 배율, 현재 보유 자산,
시장 시세를 보고 롱 진입/숏 진입/청산/관망 중 하나를 판단해라.

이 트레이더는 레버리지를 쓴다 -- amountKrw로 적은 금액은 "증거금"이고, 실제 포지션
크기는 증거금 x 레버리지로 커진다. 손실도 그만큼 증폭되니 증거금 비중을 과도하게
키우지 않도록 주의해라.

상승장만 기다리지 말고, 하락이 예상되면 숏(인버스)도 적극적으로 활용해라.
롱(buy)은 가격 상승에 베팅, 숏(short)은 가격 하락에 베팅이다 (숏은 가격이
떨어질수록 이익, 오를수록 손실 -- 포지션 방향이 반대로 작동함에 유의).
한 종목에 롱/숏을 동시에 가질 수는 없다 -- 이미 반대 방향 포지션이 있으면
먼저 sell로 청산한 뒤에 방향을 바꿔라.

오늘 목표 수익률은 크지 않다(1% 안팎). 큰 승부를 걸어서 한 번에 채우려 하지
말고, 네 스타일에 맞는 확률 높고 작은 기회를 여러 번 노려서 목표를 채우는 데
집중해라. 포지션에 조금이라도 이익이 나면 욕심부리지 말고 빨리 실현해서
확정 짓는 걸 우선해라 -- 목표를 채우면 그날 매매는 자동으로 종료된다.

너는 다른 트레이더들과 같은 날 같은 시장에서 경쟁 중이다. 아래에 오늘 네 수익률과
다른 트레이더들의 오늘 수익률이 주어진다. 뒤처지고 있으면 조급함이나 만회 심리가
생길 수 있고, 앞서고 있으면 수익을 지키고 싶은 심리가 생길 수 있다 -- 단, 이런
경쟁심이 네 원래 성격/전략을 완전히 무너뜨리진 않아야 한다 (예: 레인지 스캘퍼라면
뒤처져도 범위를 크게 벗어난 무리한 베팅은 하지 않는다).

아래에 네가 최근에 청산했던 거래들의 실제 손익 전적(승률/평균손익)이 요약되어
주어진다. 이건 네 모델 자체가 학습된 게 아니라 매번 참고하라고 주는 경험
피드백이다 -- 최근 승률이 낮거나 특정 심볼/패턴에서 반복적으로 손실이 났다면
그 패턴을 경계하고, 반대로 잘 통하고 있는 접근은 유지해라. 단, 몇 건 안 되는
표본으로 성격 자체를 뒤집진 마라.

반드시 아래 JSON 형식으로만 답해라. 다른 설명 텍스트는 붙이지 마라.
{
  "action": "buy" | "short" | "sell" | "hold",
  "symbol": "BTCUSDT" 같은 심볼 (action이 hold면 null 가능),
  "amountKrw": buy/short면 증거금으로 쓸 원화 금액, sell이면 청산하고 싶은 증거금 규모
               (전량 청산이면 보유 증거금 전체 금액을 적어라, 정수, hold면 0),
  "reason": "판단 근거를 2~3문장 한국어로"
}
`.trim();

async function callClaude(env, persona, leverage, portfolio, market, myTodayPct, rivals, performanceSummary) {
  const rivalsText = (rivals || [])
    .map((r) => `- ${r.name}(${r.badge}): 오늘 ${r.todayPct >= 0 ? '+' : ''}${r.todayPct}%`)
    .join('\n');

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

[오늘 내 수익률]
${myTodayPct >= 0 ? '+' : ''}${myTodayPct}%

[다른 트레이더들의 오늘 수익률]
${rivalsText || '(정보 없음)'}

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
  if (goalReached(state, traderId, tickers)) {
    return { traderId, skipped: true, reason: 'goal_reached' };
  }
  const market = SYMBOLS.map((s) => {
    const t = tickers[s];
    return t ? { symbol: s, price: Number(t.lastPrice), changePercent: Number(t.priceChangePercent) } : null;
  }).filter(Boolean);
  const rivals = TRADERS.filter((x) => x.id !== traderId).map((x) => ({
    name: x.name,
    badge: x.badge,
    todayPct: Number(todayPct(state, x.id, tickers).toFixed(2)),
  }));
  try {
    const decision = await callClaude(
      env,
      trader.persona,
      trader.leverage,
      state.portfolios[traderId],
      market,
      Number(todayPct(state, traderId, tickers).toFixed(2)),
      rivals,
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
      goalHit: todayPctVal >= t.dailyTargetPct,
      holdings,
      closedTrades: perf.count,
      winRate: perf.count ? Math.round(perf.winRate) : null,
    };
  });
  return {
    serverTime: Date.now(),
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
    };
  }

  async saveState(state) {
    const trimmed = { ...state, tradeLog: state.tradeLog.slice(-200) };
    await this.storage.put('state', trimmed);
  }

  async runCycle(auto) {
    const state = await this.loadState();
    const tickers = await fetchTickers();
    state.tickers = tickers;
    ensureDailyBaseline(state, tickers);
    checkStopLossAndTakeProfit(state, tickers);
    // 3명을 동시에 판단시킨다 -- 순서대로 돌리면 사이클 하나에 Claude 호출
    // 3번이 직렬로 쌓여서 짧은 주기를 맞추기 어렵다. 트레이더별로 포트폴리오가
    // 분리돼 있어 동시 실행해도 서로의 state를 침범하지 않는다.
    const results = await Promise.all(
      TRADERS.map((t) => runTraderDecision(this.env, state, tickers, t.id, auto))
    );
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
      const tickers = await fetchTickers();
      state.tickers = tickers;
      ensureDailyBaseline(state, tickers);
      checkStopLossAndTakeProfit(state, tickers);
      const result = await runTraderDecision(this.env, state, tickers, traderId, false);
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
