// api/brief.js — Proxy serverless per Anthropic API

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key non configurata sul server' });

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const { stats } = body;
    if (!stats) return res.status(400).json({ error: 'stats mancanti' });

    const dateStr = new Date().toLocaleDateString('it-IT', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    const fullPrompt = `Usa web_search per cercare "forex market EUR/USD GBP/USD XAU/USD ${dateStr}" e usa i risultati per il brief. Non inventare prezzi.

Trader stats: ${stats.totalTrades} trade, WR ${stats.winRate}%, PnL $${stats.totalPnL}, PF ${stats.profitFactor}, MaxDD $${stats.maxDD}, emozione: ${stats.topEmotion || 'N/A'}, sessione migliore: ${stats.bestSession || 'N/A'}.

Rispondi SOLO con questo HTML:
<div class="brief-macro"><h4>Contesto Macro</h4><p>...</p></div>
<div class="brief-forex"><h4>Forex Analysis</h4><p>...</p></div>
<div class="brief-focus"><h4>Focus di Oggi</h4><p>...</p></div>
<div class="brief-mindset"><h4>Mindset & Coaching</h4><p>...</p></div>`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 1 }],
        messages: [{ role: 'user', content: fullPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[brief] Anthropic error', response.status, errText);
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();

    const briefHtml = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n')
      .replace(/^```html?\n?/i, '')
      .replace(/\n?```$/, '')
      .trim();

    return res.status(200).json({ brief: briefHtml });

  } catch (err) {
    console.error('[brief] catch error', err.message);
    return res.status(500).json({ error: err.message });
  }
}
