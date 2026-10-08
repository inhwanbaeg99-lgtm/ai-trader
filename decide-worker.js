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
너는 가상 투자 시뮬레이션의 트레이더다. 아래 성격/전략, 현재 보유 자산, 시장 시세를 보고
매수/매도/관망 중 하나를 판단해라.

반드시 아래 JSON 형식으로만 답해라. 다른 설명 텍스트는 붙이지 마라.
{
  "action": "buy" | "sell" | "hold",
  "symbol": "BTCUSDT" 같은 심볼 (action이 hold면 null 가능),
  "amountKrw": 매수/매도에 사용할 원화 금액 (정수, hold면 0),
  "reason": "판단 근거를 2~3문장 한국어로"
}
`.trim();

async function callClaude(env, persona, portfolio, market) {
  const userContent = `
[트레이더 성격/전략]
${persona}

[현재 보유 현금]
${portfolio.cash}원

[현재 보유 자산]
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
      model: 'claude-sonnet-4-5',
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

    const { persona, portfolio, market } = body;
    if (!persona || !portfolio || !market) {
      return json({ error: 'persona, portfolio, market 필드가 모두 필요합니다' }, 400);
    }

    try {
      const decision = await callClaude(env, persona, portfolio, market);
      return json(decision);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
