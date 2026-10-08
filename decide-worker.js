// AI 가상 트레이더용 Cloudflare Worker --
// 프론트엔드에서 persona/portfolio/market 데이터를 받아 Claude API에 판단을
// 요청하고, { action, symbol, amountKrw, reason } 형태로 돌려준다.
// 시크릿 키는 절대 프론트엔드에 노출하지 않기 위해 이 Worker를 거친다.
// 배포 후 `wrangler secret put ANTHROPIC_API_KEY`로 키를 등록해야 동작한다.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
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

반드시 아래 JSON 형식으로만 답해라. 다른 설명 텍스트는 붙이지 마라.
{
  "action": "buy" | "short" | "sell" | "hold",
  "symbol": "BTCUSDT" 같은 심볼 (action이 hold면 null 가능),
  "amountKrw": buy/short면 증거금으로 쓸 원화 금액, sell이면 청산하고 싶은 증거금 규모
               (전량 청산이면 보유 증거금 전체 금액을 적어라, 정수, hold면 0),
  "reason": "판단 근거를 2~3문장 한국어로"
}
`.trim();

async function callClaude(env, persona, leverage, portfolio, market) {
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
  // 모델이 코드블록으로 감싸는 경우 대비해 JSON 부분만 추출
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude 응답에서 JSON을 찾지 못함: ' + text);
  return JSON.parse(match[0]);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST만 지원합니다' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: '잘못된 요청 본문' }, 400);
    }

    const { persona, leverage, portfolio, market } = body;
    if (!persona || !portfolio || !market) {
      return json({ error: 'persona, portfolio, market 필드가 모두 필요합니다' }, 400);
    }

    try {
      const decision = await callClaude(env, persona, leverage || 1, portfolio, market);
      return json(decision);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
