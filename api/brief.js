export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { stats } = req.body || {};

    const today = new Date().toLocaleDateString('it-IT', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const statsText = stats && stats.totalTrades > 0 ? `
Le statistiche del trader:
- Trade totali: ${stats.totalTrades}
- Win Rate: ${stats.winRate}%
- P&L totale: $${stats.totalPnL}
- Profit Factor: ${stats.profitFactor}
- Max Drawdown: ${stats.maxDD}%
${stats.topEmotion ? `- Emozione più frequente: ${stats.topEmotion}` : ''}
${stats.bestSession ? `- Sessione migliore: ${stats.bestSession}` : ''}
` : '';

    const prompt = `Sei un analista di mercato professionale. Oggi è ${today}.

IMPORTANTE: Prima di rispondere, usa il web search per cercare:
1. Le ultime notizie di mercato di oggi (forex, oro, indici)
2. I prezzi attuali di EUR/USD, GBP/USD, USD/JPY, XAU/USD
3. Gli eventi macroeconomici in calendario oggi

${statsText}

Dopo aver cercato le informazioni REALI E AGGIORNATE, scrivi un brief giornaliero in italiano con questa struttura HTML (NON usare markdown, asterischi o trattini):

<section class="brief-macro">
<h4>🌍 Macro &amp; Sentiment</h4>
<p>[2-3 frasi sul sentiment reale di oggi basate su notizie trovate]</p>
</section>

<section class="brief-forex">
<h4>📊 Bias Forex</h4>
<div class="brief-pair"><span class="pair-name">EUR/USD</span><span class="pair-bias">[RIALZISTA/RIBASSISTA/NEUTRO]</span><span class="pair-level">[livello chiave reale]</span></div>
<div class="brief-pair"><span class="pair-name">GBP/USD</span><span class="pair-bias">[bias]</span><span class="pair-level">[livello]</span></div>
<div class="brief-pair"><span class="pair-name">USD/JPY</span><span class="pair-bias">[bias]</span><span class="pair-level">[livello]</span></div>
<div class="brief-pair"><span class="pair-name">XAU/USD</span><span class="pair-bias">[bias]</span><span class="pair-level">[livello]</span></div>
</section>

<section class="brief-focus">
<h4>⚡ Focus del Giorno</h4>
<p>[eventi macro reali di oggi con orari CET]</p>
</section>

<section class="brief-mindset">
<h4>🧠 Mindset</h4>
<p>[consiglio psicologico${stats && stats.totalTrades > 0 ? ' personalizzato basato sulle statistiche del trader' : ''}]</p>
</section>

Usa SOLO HTML come mostrato sopra. Niente asterischi, niente trattini, niente markdown.`;

    // Call Claude with web search tool
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1500,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search'
          }
        ],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.error?.message || 'API error' });
    }

    const data = await response.json();

    // Extract text from content blocks (may include tool_use blocks)
    const brief = data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    return res.status(200).json({
      brief,
      date: today,
      generated: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
