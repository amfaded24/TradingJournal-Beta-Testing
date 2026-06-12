// api/brief.js — Brief AI v3
// Architettura: multi-source fetch → Claude analizza (zero tool use)
// EUR/USD: Frankfurter.app (ECB) + Yahoo Finance per range storico
// XAU/USD, DAX: Yahoo Finance con calcolo % change basato su candele (non meta)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key non configurata' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const stats = (body || {}).stats || {};

    // ── Fetch dati di mercato in parallelo ───────────────────────────
    // EUR/USD: Frankfurter (ECB) come primario, Yahoo come fallback
    const [eurusdR, xauusdR, daxR] = await Promise.allSettled([
      fetchEurUsd(),
      fetchQuote('XAUUSD=X'),
      fetchQuote('^GDAXI'),
    ]);

    const fx = {
      eurusd: eurusdR.status === 'fulfilled' ? eurusdR.value : null,
      xauusd: xauusdR.status === 'fulfilled' ? xauusdR.value : null,
      dax:    daxR.status    === 'fulfilled' ? daxR.value    : null,
    };

    const dateStr = new Date().toLocaleDateString('it-IT', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    const traderLine = stats.totalTrades
      ? `Il trader ha: ${stats.totalTrades} trade totali, WR ${stats.winRate}%, PnL $${stats.totalPnL}, PF ${stats.profitFactor}, MaxDD $${stats.maxDD}, emozione prevalente: ${stats.topEmotion || 'N/A'}, sessione migliore: ${stats.bestSession || 'N/A'}.`
      : 'Nessun dato trader disponibile.';

    const prompt = `Sei un senior analyst forex. Oggi è ${dateStr}.

=== DATI DI MERCATO (fonte: ECB/Yahoo Finance) ===
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

// ── EUR/USD da Frankfurter.app (dati ECB, gratuito, nessuna auth) ─────
// Molto più affidabile di Yahoo Finance per coppie FX
async function fetchEurUsd() {
  // Frankfurter restituisce gli ultimi N giorni di business days
  const url = 'https://api.frankfurter.app/latest?from=EUR&to=USD';
  const histUrl = 'https://api.frankfurter.app/latest?from=EUR&to=USD&amount=1';

  // Fetch latest + serie storica per calcoli range/SMA
  const [latestResp, seriesResp] = await Promise.all([
    fetch(url, { signal: AbortSignal.timeout(7000) }),
    fetch('https://api.frankfurter.app/?from=EUR&to=USD&amount=1', { signal: AbortSignal.timeout(7000) }),
  ]);

  if (!latestResp.ok) throw new Error(`Frankfurter: HTTP ${latestResp.status}`);
  const latest = await latestResp.json();
  const price = latest.rates?.USD;
  if (!price) throw new Error('Frankfurter: nessun dato USD');

  // Serie storica per range e SMA (ultimi ~30 business days)
  let closes = [];
  let sma20 = null;
  let high10d = null;
  let low10d = null;
  let high52w = null;
  let low52w = null;
  let prevClose = null;

  if (seriesResp.ok) {
    try {
      // Fallback: usa Yahoo Finance per i dati storici di EUR/USD
      const yahooData = await fetchQuoteRaw('EURUSD=X');
      if (yahooData) {
        closes   = yahooData.closes;
        sma20    = yahooData.sma20;
        high10d  = yahooData.high10d;
        low10d   = yahooData.low10d;
        high52w  = yahooData.high52w;
        low52w   = yahooData.low52w;
        prevClose = yahooData.prevClose; // close di ieri da candele verificate
      }
    } catch (e) {
      console.warn('[brief] Yahoo fallback per EUR range:', e.message);
    }
  }

  // Se non abbiamo prevClose dai candles Yahoo, usiamo il prezzo Frankfurter di ieri
  if (!prevClose) {
    try {
      const yesterday = getPrevBusinessDay();
      const yResp = await fetch(`https://api.frankfurter.app/${yesterday}?from=EUR&to=USD`, { signal: AbortSignal.timeout(5000) });
      if (yResp.ok) {
        const yData = await yResp.json();
        prevClose = yData.rates?.USD || null;
      }
    } catch (e) { /* ignora */ }
  }

  const chgPct = (price && prevClose) ? ((price - prevClose) / prevClose * 100) : null;

  return { symbol: 'EURUSD=X', price, prev: prevClose, chgPct, high52w, low52w, high10d, low10d, sma20 };
}

// ── Fetch candele Yahoo Finance per dati storici (range, SMA) ────────
// Calcola prevClose dai timestamp reali per evitare sfasamenti FX
async function fetchQuote(symbol) {
  const raw = await fetchQuoteRaw(symbol);
  return {
    symbol,
    price:   raw.price,
    prev:    raw.prevClose,
    chgPct:  raw.chgPct,
    high52w: raw.high52w,
    low52w:  raw.low52w,
    high10d: raw.high10d,
    low10d:  raw.low10d,
    sma20:   raw.sma20,
  };
}

async function fetchQuoteRaw(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Askesis-Brief/2.0)' },
    signal: AbortSignal.timeout(7000),
  });
  if (!resp.ok) throw new Error(`Yahoo ${symbol}: HTTP ${resp.status}`);

  const j   = await resp.json();
  const res = j.chart?.result?.[0];
  if (!res) throw new Error(`No data for ${symbol}`);

  const meta       = res.meta;
  const q          = res.indicators?.quote?.[0] || {};
  const timestamps = res.timestamp || [];
  const rawCloses  = q.close  || [];
  const rawHighs   = q.high   || [];
  const rawLows    = q.low    || [];

  // Trova il close confermato di ieri usando i timestamp delle candele
  // (evita sfasamenti FX dove chartPreviousClose punta a date sbagliate)
  const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD UTC
  let prevClose = null;
  let prevPrevClose = null;
  const confirmedCloses = [];

  for (let i = 0; i < timestamps.length; i++) {
    const d = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
    if (d < todayStr && rawCloses[i] != null) {
      confirmedCloses.push(rawCloses[i]);
    }
  }

  if (confirmedCloses.length >= 2) {
    prevClose     = confirmedCloses[confirmedCloses.length - 1];
    prevPrevClose = confirmedCloses[confirmedCloses.length - 2];
  } else if (confirmedCloses.length === 1) {
    prevClose = confirmedCloses[0];
  }

  const price = meta.regularMarketPrice;

  // % change: prezzo live vs close di ieri (candela confermata)
  const chgPct = (price != null && prevClose != null)
    ? ((price - prevClose) / prevClose * 100)
    : null;

  // Range ultimi 10 giorni di trading (candele confermate)
  const filteredHighs = [];
  const filteredLows  = [];
  const allCloses     = [];

  for (let i = 0; i < timestamps.length; i++) {
    const d = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
    if (d < todayStr) {
      if (rawHighs[i]  != null) filteredHighs.push(rawHighs[i]);
      if (rawLows[i]   != null) filteredLows.push(rawLows[i]);
      if (rawCloses[i] != null) allCloses.push(rawCloses[i]);
    }
  }

  const h10   = filteredHighs.slice(-10);
  const l10   = filteredLows.slice(-10);
  const sma20 = allCloses.length >= 20
    ? allCloses.slice(-20).reduce((a, b) => a + b, 0) / 20
    : null;

  return {
    price,
    prevClose,
    chgPct,
    closes: allCloses,
    sma20,
    high10d:  h10.length ? Math.max(...h10) : null,
    low10d:   l10.length ? Math.min(...l10) : null,
    high52w:  meta.fiftyTwoWeekHigh,
    low52w:   meta.fiftyTwoWeekLow,
  };
}

// ── Utility: giorno lavorativo precedente (skip weekend) ─────────────
function getPrevBusinessDay() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  if (d.getDay() === 0) d.setDate(d.getDate() - 2); // domenica → venerdì
  if (d.getDay() === 6) d.setDate(d.getDate() - 1); // sabato → venerdì
  return d.toISOString().split('T')[0];
}

// ── Costruisce il contesto testuale da passare a Claude ───────────────
function buildContext(fx) {
  const n   = (v, d = 5) => v != null ? Number(v).toFixed(d) : '—';
  const pct = v => v != null ? `${v >= 0 ? '▲' : '▼'}${Math.abs(v).toFixed(2)}%` : '—';

  const lines = [];

  if (fx.eurusd) {
    const e = fx.eurusd;
    lines.push('EUR/USD (fonte: ECB/Frankfurter):');
    lines.push(`  Prezzo: ${n(e.price, 5)} | Chiusura ieri: ${n(e.prev, 5)} | Variazione: ${pct(e.chgPct)}`);
    if (e.high10d != null) lines.push(`  Range 10 giorni: L ${n(e.low10d, 5)} / H ${n(e.high10d, 5)}`);
    if (e.high52w  != null) lines.push(`  Range 52 settimane: L ${n(e.low52w, 5)} / H ${n(e.high52w, 5)}`);
    if (e.sma20   != null) lines.push(`  SMA20 (daily): ${n(e.sma20, 5)}`);
  } else {
    lines.push('EUR/USD: dati non disponibili al momento');
  }

  lines.push('');

  if (fx.xauusd) {
    const g = fx.xauusd;
    lines.push('XAU/USD (spot):');
    lines.push(`  Prezzo: $${n(g.price, 2)} | Chiusura ieri: $${n(g.prev, 2)} | Variazione: ${pct(g.chgPct)}`);
    if (g.high10d != null) lines.push(`  Range 10 giorni: L $${n(g.low10d, 2)} / H $${n(g.high10d, 2)}`);
    if (g.high52w  != null) lines.push(`  Range 52 settimane: L $${n(g.low52w, 0)} / H $${n(g.high52w, 0)}`);
    if (g.sma20   != null) lines.push(`  SMA20 (daily): $${n(g.sma20, 2)}`);
  } else {
    lines.push('XAU/USD: dati non disponibili al momento');
  }

  lines.push('');

  if (fx.dax) {
    const d = fx.dax;
    lines.push('DAX (^GDAXI):');
    lines.push(`  Livello: ${n(d.price, 0)} | Chiusura ieri: ${n(d.prev, 0)} | Variazione: ${pct(d.chgPct)}`);
    if (d.high10d != null) lines.push(`  Range 10 giorni: L ${n(d.low10d, 0)} / H ${n(d.high10d, 0)}`);
    if (d.high52w  != null) lines.push(`  Range 52 settimane: L ${n(d.low52w, 0)} / H ${n(d.high52w, 0)}`);
    if (d.sma20   != null) lines.push(`  SMA20 (daily): ${n(d.sma20, 0)}`);
  } else {
    lines.push('DAX: dati non disponibili al momento');
  }

  return lines.join('\n');
}
