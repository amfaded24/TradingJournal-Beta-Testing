// api/brief.js — Proxy serverless per Anthropic API
// La API key rimane sicura sul server, mai esposta al browser

export default async function handler(req, res) {
  // CORS — permette chiamate dall'app Askesis
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key non configurata sul server' });
  }

  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'prompt mancante' });
    }

    const dateStr = new Date().toLocaleDateString('it-IT', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    const fullPrompt = `PRIMA DI RISPONDERE — RICERCA OBBLIGATORIA:
Usa web_search per cercare ADESSO (non dalla memoria):
1. "forex market analysis ${dateStr}" — contesto macro attuale
2. "EUR/USD GBP/USD XAU/USD price ${dateStr}" — prezzi live
3. "economic calendar events ${dateStr}" — eventi di oggi
4. "Fed BCE BOJ news ${dateStr}" — news banche centrali

Usa i risultati trovati come base per tutto il brief.
NON generare dati di mercato dalla memoria — solo da ricerche reali.
Se un dato non lo trovi online, scrivi "dato non disponibile" invece di inventarlo.

${prompt}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1400,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: fullPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();

    // Estrai solo il testo dai content block (ignora tool_use)
    const briefHtml = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n')
      .replace(/^```html?\n?/i, '')
      .replace(/\n?```$/, '')
      .trim();

    return res.status(200).json({ brief: briefHtml });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
