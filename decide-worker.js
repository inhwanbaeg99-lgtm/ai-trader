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
// 여러 트레이더로 나눠서 경쟁시키던 컨셉은 걷어내고, 혼자 쓸 용도로
// 투자에 특화된 트레이더 1명만 둔다. 특정 패턴(모멘텀/되돌림/레인지)에
// 갇히지 않고 상황에 맞는 전략을 유연하게 골라 쓰게 한다 -- 예를 들어
// 뚜렷한 하락 추세면 숏으로 추세를 따라가는 것도 포함.
const TRADERS = [
  {
    id: 'A',
    name: 'AI 트레이더',
    badge: '',
    desc: '모멘텀 돌파, 과열/과매도 되돌림, 레인지 매매, 추세추종까지 상황에 맞춰 유연하게 구사하는 숙련된 트레이더.',
    persona: '너는 다양한 전략(모멘텀 돌파, 과열/과매도 되돌림, 레인지 매매, 추세추종)을 상황에 맞게 유연하게 구사하는 숙련된 트레이더다. 시장이 뚜렷한 방향성(추세)을 보이면 그 추세를 거스르지 않고 롱이든 숏이든 따라간다 -- 하락 추세가 명확하면 숏으로 베팅하는 것도 적극적으로 고려해라. 반대로 뚜렷한 방향이 없고 좁은 범위에서만 오간다면 레인지 매매로, 급등락 뒤에는 되돌림을 노리는 식으로 상황에 맞는 접근을 고른다. 큰 승부보다 확률 높은 기회를 자주 포착하는 걸 우선하되, 명확한 추세에서는 작은 이익에 서둘러 만족하기보다 추세가 꺾이는 신호가 나올 때까지 유연하게 들고 가도 된다. 리스크 관리는 항상 최우선이다.',
    stopLossPct: 2.5,
    takeProfitPct: 5,
    leverage: 5,
    dailyTargetPct: 1.5,
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
  return { portfolios, dailyBase, tradeLog: [], tickers: {}, tradeHistory, dailyHistory };
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

오늘 목표 수익률은 크지 않다(1~2% 안팎). 큰 승부를 걸어서 한 번에 채우려 하지
말고, 확률 높은 기회를 노려서 목표를 채우는 데 집중해라. 다만 뚜렷한 추세를 타고
있는 포지션이라면 작은 이익에 서둘러 만족하기보다 추세가 꺾일 때까지 들고 가는
것도 괜찮다 -- 목표를 채우면 그날 매매는 자동으로 종료된다.

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

[오늘 내 수익률]
${myTodayPct >= 0 ? '+' : ''}${myTodayPct}%

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
      goalHit: todayPctVal >= t.dailyTargetPct,
      holdings,
      closedTrades: perf.count,
      winRate: perf.count ? Math.round(perf.winRate) : null,
      dailyHistory: (state.dailyHistory[t.id] || []).slice().reverse(),
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
      dailyHistory: { ...base.dailyHistory, ...raw.dailyHistory },
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
    await rolloverDayIfNeeded(this.env, state, tickers);
    markGoalHitToday(state, tickers);
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
      await rolloverDayIfNeeded(this.env, state, tickers);
      markGoalHitToday(state, tickers);
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
