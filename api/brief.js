export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://askesis.trading');
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

    const statsText = stats ? `
Statistiche trader:
- Trade totali: ${stats.totalTrades || 0}
- Win Rate: ${stats.winRate || 0}%
- P&L totale: $${stats.totalPnL || 0}
- Profit Factor: ${stats.profitFactor || 0}
- Max Drawdown: ${stats.maxDD || 0}%
- Emozione più frequente: ${stats.topEmotion || 'N/A'}
- Sessione migliore: ${stats.bestSession || 'N/A'}
` : '';

    const prompt = `Sei un analista di mercato e coach di trading professionale. Oggi è ${today}.

${statsText}

Genera un brief giornaliero di trading in italiano, strutturato così:

**🌍 MACRO & SENTIMENT**
(2-3 frasi sul sentiment generale dei mercati oggi — risk-on o risk-off, cosa guida i mercati)

**📊 BIAS FOREX**
(Bias direzionale breve per: EUR/USD, GBP/USD, USD/JPY, XAU/USD — es. "EUR/USD: bias rialzista sopra 1.0850")

**⚡ FOCUS DEL GIORNO**
(1-2 eventi o livelli chiave da monitorare oggi)

**🧠 MINDSET**
(Una frase motivazionale o consiglio psicologico per il trader, personalizzato se hai le statistiche)

Sii conciso, diretto e professionale. Niente fronzoli.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.error?.message || 'API error' });
    }

    const data = await response.json();
    const brief = data.content[0]?.text || '';

    return res.status(200).json({
      brief,
      date: today,
      generated: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
