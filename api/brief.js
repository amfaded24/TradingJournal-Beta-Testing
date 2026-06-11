// api/brief.js — Proxy serverless per Anthropic API
// Cache server-side: 1 chiamata al giorno massimo per risparmiare crediti

const cache = {};  // { date: string, brief: string }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key non configurata' });

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const forceRefresh = req.body?.forceRefresh === true;

  // Cache server-side: restituisce il brief già generato oggi senza chiamare Anthropic
  if (!forceRefresh && cache.date === today && cache.brief) {
    return res.status(200).json({ brief: cache.brief, cached: true });
  }

  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt mancante' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1400,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
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

    // Salva in cache server per oggi
    cache.date = today;
    cache.brief = briefHtml;

    return res.status(200).json({ brief: briefHtml });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
