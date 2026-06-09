// api/brief.js — Vercel Serverless Function
// Approccio efficiente: dati FX gratuiti (ECB/Frankfurter) + Claude Haiku per la sintesi
// Costo stimato: ~$0.001 per chiamata  |  Frankfurter: gratuito, nessuna API key
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = 'claude-haiku-4-5-20251001';

// Ultimo giorno lavorativo (per il confronto tassi evitando weekend)
function lastBusinessDay() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// Variazione percentuale sicura
function pct(a, b) {
  if (!a || !b) return 0;
  return (a - b) / b * 100;
}

// Inversione del tasso (da "X per USD" a "USD per X")
function inv(r) {
  return r ? 1 / r : null;
}

// Fetch tassi da Frankfurter con fallback su errore
async function fetchRates(dateStr) {
  try {
    const url = dateStr === 'latest'
      ? 'https://api.frankfurter.app/latest?from=USD'
      : `https://api.frankfurter.app/${dateStr}?from=USD`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return {};
    const data = await res.json();
    return data.rates || {};
  } catch {
    return {};
  }
}

module.exports = async function handler(req, res) {
  // Header CORS (utile in sviluppo locale)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurata' });

  try {
    const stats = req.body?.stats || {};

    // ── 1. DATI FX GRATUITI (Frankfurter / ECB) ──────────────────────────────
    const [todayRates, ydayRates] = await Promise.all([
      fetchRates('latest'),
      fetchRates(lastBusinessDay())
    ]);

    // ── 2. CALCOLO COPPIE CON VARIAZIONE ─────────────────────────────────────
    const rawPairs = [
      { name: 'EUR/USD', rate: inv(todayRates.EUR), prev: inv(ydayRates.EUR) },
      { name: 'GBP/USD', rate: inv(todayRates.GBP), prev: inv(ydayRates.GBP) },
      { name: 'USD/JPY', rate: todayRates.JPY,       prev: ydayRates.JPY      },
      { name: 'USD/CHF', rate: todayRates.CHF,       prev: ydayRates.CHF      },
      { name: 'AUD/USD', rate: inv(todayRates.AUD),  prev: inv(ydayRates.AUD) },
      { name: 'USD/CAD', rate: todayRates.CAD,       prev: ydayRates.CAD      },
    ];

    const pairs = rawPairs
      .filter(p => p.rate)
      .map(p => {
        const change = pct(p.rate, p.prev);
        const bias = change > 0.08 ? 'RIALZISTA' : change < -0.08 ? 'RIBASSISTA' : 'NEUTRO';
        return { ...p, change, bias };
      });

    const pairsText = pairs.length
      ? pairs.map(p =>
          `${p.name}: ${p.rate.toFixed(4)}  ${p.change >= 0 ? '+' : ''}${p.change.toFixed(3)}%  [${p.bias}]`
        ).join('\n')
      : '(dati FX temporaneamente non disponibili)';

    // ── 3. CONTESTO TRADER PERSONALIZZATO ────────────────────────────────────
    const hasStats = stats.totalTrades > 0;
    const traderCtx = hasStats
      ? `\nDati del trader:\n- Trade totali: ${stats.totalTrades}\n- Win Rate: ${stats.winRate}%\n- PnL netto: $${stats.totalPnL}\n- Profit Factor: ${stats.profitFactor}\n- Max Drawdown: ${stats.maxDD}%\n- Emozione prevalente: ${stats.topEmotion || '—'}\n- Sessione migliore: ${stats.bestSession || '—'}`
      : '';

    const dateLabel = new Date().toLocaleDateString('it-IT', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    }).replace(/^\w/, c => c.toUpperCase());

    // ── 4. PROMPT PER CLAUDE HAIKU ────────────────────────────────────────────
    const prompt = `Sei il briefing AI di Askesis, un trading journal professionale per trader forex. Oggi è ${dateLabel}.

Dati FX live (fonte ECB/Frankfurter — gratuiti):
${pairsText}
${traderCtx}

Genera un briefing giornaliero in HTML puro usando ESATTAMENTE questa struttura e queste classi CSS:

<div class="brief-macro">
<h4>📊 Contesto Macro</h4>
<p>[2-3 frasi concise sul contesto macroeconomico USD basato sui movimenti reali di oggi]</p>
</div>

<div class="brief-forex">
<h4>💱 Forex Snapshot</h4>
[Una riga per ogni coppia con i dati reali — usa questo formato esatto:]
<div class="brief-pair"><span class="pair-name">EUR/USD</span><span class="pair-bias">RIALZISTA</span><span class="pair-level">1.0847 · +0.12%</span></div>
</div>

<div class="brief-focus">
<h4>🎯 Focus del Giorno</h4>
<p>[1-2 frasi operative: quale coppia o setup privilegiare oggi, quale sessione, con quale logica basata sui dati reali]</p>
</div>

<div class="brief-mindset">
<h4>🧠 Mindset${hasStats ? ' & Edge' : ''}</h4>
<p>[${hasStats ? 'Un insight personalizzato sulle statistiche del trader + un consiglio' : 'Un consiglio'} psicologico breve e diretto per il trading di oggi]</p>
</div>

Regole:
- Usa i bias RIALZISTA/RIBASSISTA/NEUTRO coerenti con i dati reali forniti
- Tono professionale, diretto, specifico — mai generico o ovvio
- Solo HTML puro: niente markdown, niente \`\`\`html, niente tag extra fuori dalla struttura
- Includi tutte le coppie disponibili nella sezione Forex Snapshot`;

    // ── 5. CHIAMATA A CLAUDE HAIKU ─────────────────────────────────────────────
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(20000)
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text().catch(() => '');
      throw new Error(`Claude API ${claudeRes.status}: ${errText.slice(0, 200)}`);
    }

    const claudeData = await claudeRes.json();

    // Pulisci eventuali fence markdown rimasti (difesa in profondità)
    const briefHtml = (claudeData.content?.[0]?.text || '')
      .trim()
      .replace(/^```(?:html)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    return res.status(200).json({
      brief: briefHtml || '<p>Brief non disponibile al momento.</p>',
      date:  dateLabel
    });

  } catch (err) {
    console.error('[brief.js]', err.message);
    return res.status(500).json({
      brief: '<p style="color:var(--textMid);font-size:12px">⚠️ Brief temporaneamente non disponibile.</p>',
      date:  ''
    });
  }
};
