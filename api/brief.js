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
    const { stats } = req.body;
    if (!stats) {
      return res.status(400).json({ error: 'stats mancanti' });
    }

    const dateStr = new Date().toLocaleDateString('it-IT', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    const fullPrompt = `PRIMA DI RISPONDERE — RICERCA OBBLIGATORIA:
Usa web_search per cercare ADESSO (non dalla memoria):
1. "EUR/USD GBP/USD XAU/USD forex ${dateStr}" — prezzi e analisi live
2. "economic calendar forex news ${dateStr}" — eventi e news del giorno

Usa i risultati trovati come base per tutto il brief.
NON generare dati di mercato dalla memoria — solo da ricerche reali.
Se un dato non lo trovi online, scrivi "dato non disponibile" invece di inventarlo.

Sei un coach di trading professionale. Scrivi un brief mattutino completo per un trader forex retail.

Statistiche personali del trader:
- Trade totali: ${stats.totalTrades}
- Win rate: ${stats.winRate}%
- PnL totale: $${stats.totalPnL}
- Profit Factor: ${stats.profitFactor}
- Max Drawdown: $${stats.maxDD}
- Emozione più frequente: ${stats.topEmotion || 'Non registrata'}
- Sessione migliore: ${stats.bestSession || 'Non rilevata'}

Il brief deve includere esattamente queste sezioni HTML:

<div class="brief-macro">
<h4>Contesto Macro</h4>
[analisi macro basata sui risultati delle ricerche]
</div>

<div class="brief-forex">
<h4>Forex Analysis</h4>
[prezzi e livelli chiave EUR/USD, GBP/USD, XAU/USD dai risultati delle ricerche]
</div>

<div class="brief-focus">
<h4>Focus di Oggi</h4>
[eventi economici del giorno, setup potenziali basati sulla ricerca]
</div>

<div class="brief-mindset">
<h4>Mindset & Coaching</h4>
[consiglio personalizzato basato sulle statistiche del trader sopra indicate]
</div>

Rispondi SOLO con l'HTML delle quattro sezioni, nessun testo aggiuntivo prima o dopo.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
        messages: [{ role: 'user', content: fullPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[brief] Anthropic error', response.status, errText);
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
