// api/brief.js — Brief AI v2
// Architettura: fetch dati live da API gratuite → Claude analizza (zero tool use)
// Costo stimato: ~$0.003/chiamata | Affidabilità: non dipende da web_search

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key non configurata' });

  try {
    // ── Parse body ────────────────────────────────────────────────
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const stats = (body || {}).stats || {};

    // ── Fetch dati di mercato in parallelo (Yahoo Finance, gratuito) ──
    const [eurusdR, xauusdR, daxR] = await Promise.allSettled([
      fetchQuote('EURUSD=X'),  // EUR/USD spot
      fetchQuote('GC=F'),       // Gold futures (proxy XAU/USD)
      fetchQuote('^GDAXI'),     // DAX
    ]);

    const fx = {
      eurusd: eurusdR.status === 'fulfilled' ? eurusdR.value : null,
      xauusd: xauusdR.status === 'fulfilled' ? xauusdR.value : null,
      dax:    daxR.status    === 'fulfilled' ? daxR.value    : null,
    };

    // ── Data odierna ──────────────────────────────────────────────
    const dateStr = new Date().toLocaleDateString('it-IT', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    // ── Profilo trader ────────────────────────────────────────────
    const traderLine = stats.totalTrades
      ? `Il trader ha: ${stats.totalTrades} trade totali, WR ${stats.winRate}%, PnL $${stats.totalPnL}, PF ${stats.profitFactor}, MaxDD $${stats.maxDD}, emozione prevalente: ${stats.topEmotion || 'N/A'}, sessione migliore: ${stats.bestSession || 'N/A'}.`
      : 'Nessun dato trader disponibile.';

    // ── Costruzione prompt con dati reali ─────────────────────────
    const prompt = `Sei un senior analyst forex. Oggi è ${dateStr}.

=== DATI DI MERCATO LIVE (fonte: Yahoo Finance) ===
${buildContext(fx)}

=== PROFILO TRADER ===
${traderLine}

Genera un brief operativo professionale in italiano.
Usa ESCLUSIVAMENTE i dati di mercato forniti sopra per i livelli di prezzo — non inventarne altri.
Se un dato è "—", non citare quel livello specifico.

Rispondi ESCLUSIVAMENTE con questo HTML (zero markdown, zero testo fuori dai tag):

<div class="brief-macro"><h4>Contesto Macro</h4><p>Politiche monetarie BCE/Fed/BoE/BoJ: stato attuale e posizionamento. Risk-on o risk-off. Sentiment dominante.</p></div>
<div class="brief-forex"><h4>EUR/USD · XAU/USD · DAX</h4><p>Per ciascun asset: direzionalità di giornata, livelli chiave da attenzionare con prezzi precisi, struttura tecnica rispetto ai range forniti.</p></div>
<div class="brief-focus"><h4>Focus di Oggi</h4><p>Cosa monitorare oggi. Sessioni più rilevanti. Setup da cercare. Rischi principali di giornata.</p></div>
<div class="brief-mindset"><h4>Mindset & Edge</h4><p>Una frase di mindset concreta e operativa legata al contesto attuale. Un tip pratico per il trader.</p></div>`;

    // ── Chiamata Claude — NESSUN TOOL, nessuna web_search ─────────
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('[brief] Anthropic error', r.status, errText);
      return res.status(r.status).json({ error: errText });
    }

    const data = await r.json();
    const briefHtml = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n')
      .replace(/^```html?\n?/i, '')
      .replace(/\n?```$/, '')
      .trim();

    return res.status(200).json({ brief: briefHtml, date: dateStr });

  } catch (err) {
    console.error('[brief] catch error', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── Fetch quote da Yahoo Finance con storico 1 mese ───────────────
async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Askesis-Brief/2.0)' },
    signal: AbortSignal.timeout(7000),
  });
  if (!resp.ok) throw new Error(`Yahoo ${symbol}: HTTP ${resp.status}`);

  const j   = await resp.json();
  const res = j.chart?.result?.[0];
  if (!res) throw new Error(`No data for ${symbol}`);

  const meta   = res.meta;
  const q      = res.indicators?.quote?.[0] || {};
  const closes = (q.close || []).filter(v => v != null);
  const highs  = (q.high  || []).filter(v => v != null);
  const lows   = (q.low   || []).filter(v => v != null);

  const price  = meta.regularMarketPrice;
  const prev   = meta.chartPreviousClose || meta.previousClose;
  const chgPct = price && prev ? ((price - prev) / prev * 100) : null;

  // Range degli ultimi 10 giorni di trading
  const h10 = highs.slice(-10);
  const l10 = lows.slice(-10);

  // SMA20 se abbiamo abbastanza dati
  const sma20 = closes.length >= 20
    ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20
    : null;

  return {
    symbol,
    price,
    prev,
    chgPct,
    high52w:  meta.fiftyTwoWeekHigh,
    low52w:   meta.fiftyTwoWeekLow,
    high10d:  h10.length ? Math.max(...h10) : null,
    low10d:   l10.length ? Math.min(...l10) : null,
    sma20,
  };
}

// ── Costruisce il contesto testuale da passare a Claude ───────────
function buildContext(fx) {
  const n  = (v, d = 5) => v != null ? Number(v).toFixed(d) : '—';
  const pct = v => v != null ? `${v >= 0 ? '▲' : '▼'}${Math.abs(v).toFixed(3)}%` : '—';

  const lines = [];

  // EUR/USD
  if (fx.eurusd) {
    const e = fx.eurusd;
    lines.push('EUR/USD:');
    lines.push(`  Prezzo: ${n(e.price, 5)} | Chiusura ieri: ${n(e.prev, 5)} | Variazione: ${pct(e.chgPct)}`);
    lines.push(`  Range 10 giorni: L ${n(e.low10d, 5)} / H ${n(e.high10d, 5)}`);
    lines.push(`  Range 52 settimane: L ${n(e.low52w, 5)} / H ${n(e.high52w, 5)}`);
    if (e.sma20) lines.push(`  SMA20 (daily): ${n(e.sma20, 5)}`);
  } else {
    lines.push('EUR/USD: dati non disponibili al momento');
  }

  lines.push('');

  // XAU/USD
  if (fx.xauusd) {
    const g = fx.xauusd;
    lines.push('XAU/USD (Gold futures GC=F):');
    lines.push(`  Prezzo: $${n(g.price, 2)} | Chiusura ieri: $${n(g.prev, 2)} | Variazione: ${pct(g.chgPct)}`);
    lines.push(`  Range 10 giorni: L $${n(g.low10d, 2)} / H $${n(g.high10d, 2)}`);
    lines.push(`  Range 52 settimane: L $${n(g.low52w, 0)} / H $${n(g.high52w, 0)}`);
    if (g.sma20) lines.push(`  SMA20 (daily): $${n(g.sma20, 2)}`);
  } else {
    lines.push('XAU/USD: dati non disponibili al momento');
  }

  lines.push('');

  // DAX
  if (fx.dax) {
    const d = fx.dax;
    lines.push('DAX (^GDAXI):');
    lines.push(`  Livello: ${n(d.price, 0)} | Chiusura ieri: ${n(d.prev, 0)} | Variazione: ${pct(d.chgPct)}`);
    lines.push(`  Range 10 giorni: L ${n(d.low10d, 0)} / H ${n(d.high10d, 0)}`);
    lines.push(`  Range 52 settimane: L ${n(d.low52w, 0)} / H ${n(d.high52w, 0)}`);
    if (d.sma20) lines.push(`  SMA20 (daily): ${n(d.sma20, 0)}`);
  } else {
    lines.push('DAX: dati non disponibili al momento');
  }

  return lines.join('\n');
}
