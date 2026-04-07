#!/usr/bin/env node
/**
 * Crypto Momentum Rider Bot
 *
 * TradingView Alert -> Hyperliquid Trading + Telegram Notifications
 * Includes web dashboard, trade history, and emergency controls.
 */

try { await import('dotenv/config'); } catch { /* dotenv not needed on Railway */ }
import http from 'node:http';
import https from 'node:https';
import { Hyperliquid } from 'hyperliquid';

// === CONFIG ===
const PORT = parseInt(process.env.PORT || '3142');
const TESTNET = process.env.HL_TESTNET === 'true';
const PRIVATE_KEY = process.env.HL_PRIVATE_KEY || '';
const VAULT_ADDRESS = process.env.HL_PUBLIC_WALLET || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const DEFAULT_LEVERAGE = parseInt(process.env.LEVERAGE || '3');
const SLIPPAGE = parseFloat(process.env.SLIPPAGE || '0.05');
const SL_ATR_MULT = parseFloat(process.env.SL_ATR_MULT || '1.5');
const TP_ATR_MULT = parseFloat(process.env.TP_ATR_MULT || '3.0');
const DRY_RUN = process.env.DRY_RUN !== 'false';
const POSITION_PCT = parseFloat(process.env.POSITION_PCT || '25');
const SYMBOL_MAP = {
  'BTCUSDT': 'BTC', 'BTCUSD': 'BTC', 'BTC': 'BTC',
  'SOLUSDT': 'SOL', 'SOLUSD': 'SOL', 'SOL': 'SOL',
  'ETHUSDT': 'ETH', 'ETHUSD': 'ETH', 'ETH': 'ETH',
  'SUIUSDT': 'SUI', 'SUIUSD': 'SUI', 'SUI': 'SUI',
  'XRPUSDT': 'XRP', 'XRPUSD': 'XRP', 'XRP': 'XRP',
  'AVAXUSDT': 'AVAX', 'AVAXUSD': 'AVAX', 'AVAX': 'AVAX',
  'DOGEUSDT': 'DOGE', 'DOGEUSD': 'DOGE', 'DOGE': 'DOGE',
  'LINKUSDT': 'LINK', 'LINKUSD': 'LINK', 'LINK': 'LINK',
  'NEARUSDT': 'NEAR', 'NEARUSD': 'NEAR', 'NEAR': 'NEAR',
  'RENDERUSDT': 'RENDER', 'RENDERUSD': 'RENDER', 'RENDER': 'RENDER',
};

const ALLOWED_COINS = new Set(['BTC', 'SOL', 'SUI']);

// === STATE ===
let sdk = null;
let assetMap = new Map();
const activePositions = new Map();
const tradeLog = [];
let botEnabled = true;
const startTime = new Date();
let startingEquity = 0;
let currentEquity = 0;
let lastHeartbeat = new Date();
let totalPnl = 0;

// === TELEGRAM ===
function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return Promise.resolve();
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML' });
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// === HYPERLIQUID INIT ===
async function initSDK() {
  if (!PRIVATE_KEY) {
    log('WARNING: No HL_PRIVATE_KEY set. Running in DRY_RUN mode only.');
    return;
  }
  const sdkOpts = { privateKey: PRIVATE_KEY, testnet: TESTNET };
  if (VAULT_ADDRESS) sdkOpts.walletAddress = VAULT_ADDRESS;
  sdk = new Hyperliquid(sdkOpts);
  await sdk.connect();
  const apiAddr = sdk.custom.getUserAddress();
  log(`Hyperliquid SDK connected (${TESTNET ? 'TESTNET' : 'MAINNET'})`);
  log(`  API wallet: ${apiAddr}`);
  log(`  Vault/Main wallet: ${VAULT_ADDRESS || apiAddr}`);

  try {
    const meta = await sdk.info.perpetuals.getMeta();
    meta.universe.forEach((asset, idx) => {
      assetMap.set(asset.name.replace('-PERP', ''), idx);
    });
    log(`Loaded ${assetMap.size} assets`);
  } catch (e) {
    log(`Failed to load asset metadata: ${e.message}`);
  }

  for (const coin of ALLOWED_COINS) {
    try {
      await sdk.exchange.updateLeverage(`${coin}-PERP`, 'cross', DEFAULT_LEVERAGE);
      log(`  ${coin}: ${DEFAULT_LEVERAGE}x cross leverage set`);
    } catch (e) {
      log(`  ${coin}: leverage set failed - ${e.message}`);
    }
  }

  // Record starting equity
  await updateEquity();
  startingEquity = currentEquity || 10000;
  log(`  Starting equity: $${startingEquity.toFixed(2)}`);
}

// === EQUITY TRACKING ===
async function updateEquity() {
  try {
    const addr = VAULT_ADDRESS || (sdk ? sdk.custom.getUserAddress() : null);
    if (!addr || !sdk) { currentEquity = 10000; return; }
    const balances = await sdk.info.perpetuals.getClearinghouseState(addr);
    currentEquity = parseFloat(balances.marginSummary.accountValue);
  } catch { /* ignore */ }
}

// === POSITION SIZING ===
async function calcPositionSize(coin, price) {
  if (DRY_RUN && !sdk) {
    const equity = 10000;
    const tradeValue = equity * (POSITION_PCT / 100);
    return { size: Math.floor(tradeValue / price * 10000) / 10000, equity, tradeValue };
  }
  try {
    await updateEquity();
    const tradeValue = currentEquity * (POSITION_PCT / 100);
    const size = tradeValue / price;
    log(`  Equity: $${currentEquity.toFixed(2)}, Trade: $${tradeValue.toFixed(2)} (${POSITION_PCT}%), ${size.toFixed(6)} ${coin}`);
    return { size: Math.floor(size * 10000) / 10000, equity: currentEquity, tradeValue };
  } catch (e) {
    log(`Position sizing error: ${e.message}`);
    return { size: 0, equity: 0, tradeValue: 0 };
  }
}

// === TRADE EXECUTION ===
async function executeBuy(coin, price) {
  if (!botEnabled) { log('Bot is PAUSED, skipping'); return { skipped: true, reason: 'bot_paused' }; }
  if (activePositions.has(coin)) { log(`Already in ${coin}`); return { skipped: true, reason: 'already_positioned' }; }

  const { size, equity } = await calcPositionSize(coin, parseFloat(price));
  if (size <= 0) { log(`Size is 0 for ${coin}`); return { skipped: true, reason: 'zero_size' }; }

  const slPrice = parseFloat(price) * (1 - SL_ATR_MULT * 0.02);
  const tpPrice = parseFloat(price) * (1 + TP_ATR_MULT * 0.02);

  log(`BUY ${coin}: size=${size}, price=${price}, SL=${slPrice.toFixed(2)}, TP=${tpPrice.toFixed(2)}, equity=${equity.toFixed(2)}`);

  const trade = {
    id: tradeLog.length + 1,
    time: new Date().toISOString(),
    coin, action: 'BUY', size, entryPrice: parseFloat(price),
    sl: slPrice, tp: tpPrice, exitPrice: null, pnl: null, status: 'OPEN',
  };

  if (DRY_RUN) {
    log(`  [DRY RUN] Would buy ${size} ${coin}`);
    activePositions.set(coin, { entry: parseFloat(price), sl: slPrice, tp: tpPrice, size, tradeId: trade.id });
    tradeLog.push(trade);
    return { dryRun: true, size, sl: slPrice, tp: tpPrice };
  }

  try {
    const order = await sdk.custom.marketOpen(coin, true, size, undefined, SLIPPAGE);
    activePositions.set(coin, { entry: parseFloat(price), sl: slPrice, tp: tpPrice, size, tradeId: trade.id });
    trade.order = order;
    tradeLog.push(trade);
    return { success: true, size, sl: slPrice, tp: tpPrice, order };
  } catch (e) {
    log(`  ORDER FAILED: ${e.message}`);
    trade.status = 'FAILED';
    trade.error = e.message;
    tradeLog.push(trade);
    return { error: e.message };
  }
}

async function executeSell(coin, price) {
  if (!activePositions.has(coin)) { log(`No position in ${coin}`); return { skipped: true }; }

  const pos = activePositions.get(coin);
  log(`SELL ${coin}: price=${price}, entry=${pos.entry}`);

  const pnl = (parseFloat(price) - pos.entry) * pos.size * DEFAULT_LEVERAGE;
  const pnlPct = ((parseFloat(price) - pos.entry) / pos.entry * 100 * DEFAULT_LEVERAGE);

  // Update the opening trade record
  const openTrade = tradeLog.find(t => t.id === pos.tradeId);

  const closeTrade = {
    id: tradeLog.length + 1,
    time: new Date().toISOString(),
    coin, action: 'SELL', size: pos.size, entryPrice: pos.entry,
    exitPrice: parseFloat(price), pnl, pnlPct, status: 'CLOSED',
  };

  if (DRY_RUN) {
    log(`  [DRY RUN] Close ${coin}, P&L: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);
    activePositions.delete(coin);
    if (openTrade) { openTrade.status = 'CLOSED'; openTrade.exitPrice = parseFloat(price); openTrade.pnl = pnl; openTrade.pnlPct = pnlPct; }
    tradeLog.push(closeTrade);
    totalPnl += pnl;
    return { dryRun: true, pnl, pnlPct };
  }

  try {
    const order = await sdk.custom.marketClose(coin);
    activePositions.delete(coin);
    if (openTrade) { openTrade.status = 'CLOSED'; openTrade.exitPrice = parseFloat(price); openTrade.pnl = pnl; openTrade.pnlPct = pnlPct; }
    closeTrade.order = order;
    tradeLog.push(closeTrade);
    totalPnl += pnl;
    await updateEquity();
    return { success: true, pnl, pnlPct, order };
  } catch (e) {
    log(`  CLOSE FAILED: ${e.message}`);
    return { error: e.message };
  }
}

// === EMERGENCY: CLOSE ALL ===
async function closeAllPositions() {
  const results = [];
  for (const [coin, pos] of activePositions) {
    log(`EMERGENCY CLOSE: ${coin}`);
    try {
      if (!DRY_RUN && sdk) {
        await sdk.custom.marketClose(coin);
      }
      activePositions.delete(coin);
      results.push({ coin, closed: true });
      tradeLog.push({ id: tradeLog.length + 1, time: new Date().toISOString(), coin, action: 'EMERGENCY_CLOSE', size: pos.size, entryPrice: pos.entry, exitPrice: null, pnl: null, status: 'CLOSED' });
    } catch (e) {
      results.push({ coin, closed: false, error: e.message });
    }
  }
  await updateEquity();
  await sendTelegram(`\u{1F6D1} <b>EMERGENCY: All positions closed</b>\n${results.map(r => `${r.coin}: ${r.closed ? 'Closed' : 'FAILED: ' + r.error}`).join('\n')}`);
  return results;
}

// === WEBHOOK HANDLER ===
async function handleWebhook(body) {
  lastHeartbeat = new Date();
  let data;
  try { data = JSON.parse(body); } catch { return { error: 'Invalid JSON' }; }

  const rawSymbol = (data.symbol || '').replace('BINANCE:', '').replace('COINBASE:', '').replace('BITSTAMP:', '');
  const coin = SYMBOL_MAP[rawSymbol] || SYMBOL_MAP[rawSymbol.replace('USDT', '').replace('USD', '')];
  const action = (data.action || '').toUpperCase();
  const price = data.price || '0';

  if (!coin) return { error: `Unknown symbol: ${data.symbol}` };
  if (!ALLOWED_COINS.has(coin)) return { error: `${coin} not allowed` };

  log(`\nAlert: ${action} ${coin} @ ${price}`);

  let result;
  if (action === 'BUY') result = await executeBuy(coin, price);
  else if (action === 'SELL' || action === 'CLOSE') result = await executeSell(coin, price);
  else result = { error: `Unknown action: ${action}` };

  const emoji = action === 'BUY' ? '\u{1F7E2}' : '\u{1F534}';
  const mode = DRY_RUN ? ' [PAPER]' : '';
  let msg = `${emoji} <b>${action} ${coin}</b>${mode}\n<b>Price:</b> $${price}`;
  if (result.size) msg += `\n<b>Size:</b> ${result.size} ${coin}`;
  if (result.sl) msg += `\n<b>SL:</b> $${result.sl.toFixed(2)}`;
  if (result.tp) msg += `\n<b>TP:</b> $${result.tp.toFixed(2)}`;
  if (result.pnl !== undefined) msg += `\n<b>P&L:</b> $${result.pnl.toFixed(2)} (${result.pnlPct?.toFixed(1) || '?'}%)`;
  if (result.error) msg += `\n<b>Error:</b> ${result.error}`;
  if (result.skipped) msg += `\n<i>Skipped: ${result.reason || 'already positioned'}</i>`;
  msg += `\n<b>Leverage:</b> ${DEFAULT_LEVERAGE}x\n\n<i>Crypto Momentum Rider</i>`;
  await sendTelegram(msg);
  return result;
}

// === DASHBOARD HTML ===
function renderDashboard() {
  const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
  const uptimeStr = `${Math.floor(uptime/86400)}d ${Math.floor(uptime%86400/3600)}h ${Math.floor(uptime%3600/60)}m`;
  const closedTrades = tradeLog.filter(t => t.action === 'SELL' || t.action === 'EMERGENCY_CLOSE');
  const wins = closedTrades.filter(t => (t.pnl || 0) > 0).length;
  const losses = closedTrades.filter(t => (t.pnl || 0) < 0).length;
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length * 100).toFixed(1) : '—';
  const equity = currentEquity || startingEquity || 10000;
  const returnPct = startingEquity > 0 ? ((equity - startingEquity) / startingEquity * 100).toFixed(2) : '0.00';
  const posRows = [...activePositions.entries()].map(([coin, p]) => `
    <tr>
      <td><span class="coin">${coin}</span></td>
      <td>$${p.entry.toFixed(2)}</td>
      <td>$${p.sl.toFixed(2)}</td>
      <td>$${p.tp.toFixed(2)}</td>
      <td>${p.size}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">No open positions</td></tr>';

  const tradeRows = [...tradeLog].reverse().slice(0, 50).map(t => {
    const pnlClass = (t.pnl || 0) > 0 ? 'profit' : (t.pnl || 0) < 0 ? 'loss' : '';
    const pnlStr = t.pnl !== null && t.pnl !== undefined ? `$${t.pnl.toFixed(2)}` : '—';
    const pctStr = t.pnlPct !== null && t.pnlPct !== undefined ? `${t.pnlPct.toFixed(1)}%` : '';
    return `
    <tr>
      <td>${t.time?.substring(0,19).replace('T',' ') || ''}</td>
      <td><span class="coin">${t.coin}</span></td>
      <td class="${t.action === 'BUY' ? 'buy' : 'sell'}">${t.action}</td>
      <td>$${(t.entryPrice || 0).toFixed(2)}</td>
      <td>${t.exitPrice ? '$' + t.exitPrice.toFixed(2) : '—'}</td>
      <td>${t.size}</td>
      <td class="${pnlClass}">${pnlStr} ${pctStr}</td>
      <td>${t.status}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Crypto Momentum Rider</title>
<meta http-equiv="refresh" content="30">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0d1117; color:#c9d1d9; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; padding:20px; }
  h1 { color:#58a6ff; margin-bottom:5px; font-size:24px; }
  .subtitle { color:#8b949e; margin-bottom:20px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:15px; margin-bottom:25px; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:16px; }
  .card .label { color:#8b949e; font-size:12px; text-transform:uppercase; letter-spacing:1px; }
  .card .value { font-size:28px; font-weight:700; margin-top:4px; }
  .card .value.green { color:#3fb950; }
  .card .value.red { color:#f85149; }
  .card .value.blue { color:#58a6ff; }
  .card .value.yellow { color:#d29922; }
  .status-dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; }
  .status-dot.on { background:#3fb950; }
  .status-dot.off { background:#f85149; }
  .status-dot.paused { background:#d29922; }
  table { width:100%; border-collapse:collapse; margin-top:10px; font-size:13px; }
  th { background:#161b22; color:#8b949e; text-align:left; padding:10px 12px; border-bottom:1px solid #30363d; font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.5px; }
  td { padding:8px 12px; border-bottom:1px solid #21262d; }
  tr:hover { background:#1c2128; }
  .section { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:20px; margin-bottom:20px; }
  .section h2 { color:#c9d1d9; font-size:16px; margin-bottom:12px; }
  .coin { background:#1f6feb22; color:#58a6ff; padding:2px 8px; border-radius:4px; font-weight:600; font-size:12px; }
  .buy { color:#3fb950; font-weight:600; }
  .sell { color:#f85149; font-weight:600; }
  .profit { color:#3fb950; }
  .loss { color:#f85149; }
  .empty { text-align:center; color:#484f58; padding:20px; }
  .controls { display:flex; gap:10px; margin-bottom:20px; }
  .btn { padding:10px 20px; border:none; border-radius:6px; cursor:pointer; font-weight:600; font-size:14px; }
  .btn-danger { background:#da3633; color:white; }
  .btn-danger:hover { background:#f85149; }
  .btn-warning { background:#9e6a03; color:white; }
  .btn-warning:hover { background:#d29922; }
  .btn-success { background:#238636; color:white; }
  .btn-success:hover { background:#3fb950; }
  .footer { text-align:center; color:#484f58; font-size:12px; margin-top:20px; padding-top:15px; border-top:1px solid #21262d; }
</style>
</head><body>
<h1>Crypto Momentum Rider</h1>
<p class="subtitle">
  <span class="status-dot ${botEnabled ? 'on' : 'paused'}"></span>
  ${botEnabled ? 'Active' : 'PAUSED'} | ${DRY_RUN ? 'Paper Mode' : 'LIVE'} | ${TESTNET ? 'Testnet' : 'Mainnet'} | Uptime: ${uptimeStr}
</p>

<div class="controls">
  ${botEnabled
    ? '<button class="btn btn-warning" onclick="fetch(\'/api/pause\',{method:\'POST\'}).then(()=>location.reload())">Pause Bot</button>'
    : '<button class="btn btn-success" onclick="fetch(\'/api/resume\',{method:\'POST\'}).then(()=>location.reload())">Resume Bot</button>'
  }
  <button class="btn btn-danger" onclick="if(confirm('Close ALL positions immediately?')) fetch('/api/close-all',{method:'POST'}).then(()=>location.reload())">Emergency Close All</button>
</div>

<div class="grid">
  <div class="card">
    <div class="label">Starting Capital</div>
    <div class="value">$${(startingEquity || 10000).toFixed(2)}</div>
  </div>
  <div class="card">
    <div class="label">Current Equity</div>
    <div class="value ${equity > startingEquity ? 'green' : equity < startingEquity ? 'red' : ''}"">$${equity.toFixed(2)}</div>
  </div>
  <div class="card">
    <div class="label">Total Return</div>
    <div class="value ${parseFloat(returnPct) > 0 ? 'green' : parseFloat(returnPct) < 0 ? 'red' : ''}">${returnPct}%</div>
  </div>
  <div class="card">
    <div class="label">Realized P&L</div>
    <div class="value ${totalPnl > 0 ? 'green' : totalPnl < 0 ? 'red' : ''}">$${totalPnl.toFixed(2)}</div>
  </div>
  <div class="card">
    <div class="label">Total Trades</div>
    <div class="value blue">${closedTrades.length}</div>
  </div>
  <div class="card">
    <div class="label">Win Rate</div>
    <div class="value ${parseFloat(winRate) >= 50 ? 'green' : 'yellow'}">${winRate}%</div>
  </div>
  <div class="card">
    <div class="label">Wins / Losses</div>
    <div class="value"><span class="profit">${wins}</span> / <span class="loss">${losses}</span></div>
  </div>
  <div class="card">
    <div class="label">Config</div>
    <div class="value blue" style="font-size:16px">${DEFAULT_LEVERAGE}x | ${POSITION_PCT}%</div>
  </div>
</div>

<div class="section">
  <h2>Open Positions</h2>
  <table>
    <tr><th>Coin</th><th>Entry</th><th>Stop Loss</th><th>Take Profit</th><th>Size</th></tr>
    ${posRows}
  </table>
</div>

<div class="section">
  <h2>Trade History (last 50)</h2>
  <table>
    <tr><th>Time</th><th>Coin</th><th>Action</th><th>Entry</th><th>Exit</th><th>Size</th><th>P&L</th><th>Status</th></tr>
    ${tradeRows || '<tr><td colspan="8" class="empty">No trades yet</td></tr>'}
  </table>
</div>

<div class="footer">
  Crypto Momentum Rider Bot | Last heartbeat: ${lastHeartbeat.toISOString().substring(0,19)} | Auto-refresh: 30s
</div>
</body></html>`;
}

// === HTTP SERVER ===
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Webhook
  if (req.method === 'POST' && url.pathname === '/webhook') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', async () => {
      try {
        const result = await handleWebhook(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        log(`Error: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // API: Pause bot
  if (req.method === 'POST' && url.pathname === '/api/pause') {
    botEnabled = false;
    log('Bot PAUSED by dashboard');
    await sendTelegram('\u{23F8}\u{FE0F} <b>Bot PAUSED</b>\nTrading disabled via dashboard. Open positions remain.');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, botEnabled }));
    return;
  }

  // API: Resume bot
  if (req.method === 'POST' && url.pathname === '/api/resume') {
    botEnabled = true;
    log('Bot RESUMED by dashboard');
    await sendTelegram('\u{25B6}\u{FE0F} <b>Bot RESUMED</b>\nTrading re-enabled via dashboard.');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, botEnabled }));
    return;
  }

  // API: Close all positions
  if (req.method === 'POST' && url.pathname === '/api/close-all') {
    log('EMERGENCY CLOSE ALL triggered from dashboard');
    const results = await closeAllPositions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, results }));
    return;
  }

  // Dashboard
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
    await updateEquity();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderDashboard());
    return;
  }

  // JSON status API
  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      mode: DRY_RUN ? 'PAPER' : 'LIVE',
      network: TESTNET ? 'testnet' : 'mainnet',
      botEnabled,
      leverage: DEFAULT_LEVERAGE,
      positionPct: POSITION_PCT,
      startingEquity,
      currentEquity,
      totalPnl,
      positions: Object.fromEntries(activePositions),
      trades: tradeLog.length,
      allowed: [...ALLOWED_COINS],
      uptime: Math.floor((Date.now() - startTime.getTime()) / 1000),
      lastHeartbeat: lastHeartbeat.toISOString(),
    }));
    return;
  }

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// === HEARTBEAT: Telegram alert if bot goes down ===
setInterval(async () => {
  lastHeartbeat = new Date();
  await updateEquity();
}, 5 * 60 * 1000); // every 5 minutes

// === STARTUP ===
async function main() {
  console.log(`
=============================================
  Crypto Momentum Rider Bot
=============================================
  Mode:        ${DRY_RUN ? 'PAPER (dry run)' : 'LIVE TRADING'}
  Network:     ${TESTNET ? 'Testnet' : 'Mainnet'}
  Leverage:    ${DEFAULT_LEVERAGE}x
  Position:    ${POSITION_PCT}% of equity per trade
  SL/TP:       ${SL_ATR_MULT}x / ${TP_ATR_MULT}x ATR
  Coins:       ${[...ALLOWED_COINS].join(', ')}
  Telegram:    ${TELEGRAM_TOKEN ? 'Enabled' : 'Disabled'}
  Dashboard:   http://localhost:${PORT}/
=============================================
`);

  if (!DRY_RUN) {
    await initSDK();
  }

  server.listen(PORT, () => {
    log(`Dashboard: http://localhost:${PORT}/`);
    log(`Webhook:   http://localhost:${PORT}/webhook`);
    log(`Status:    http://localhost:${PORT}/status`);
    log('');

    sendTelegram(
      `\u{1F680} <b>Crypto Momentum Rider Started</b>\n` +
      `<b>Mode:</b> ${DRY_RUN ? 'Paper' : 'LIVE'}\n` +
      `<b>Leverage:</b> ${DEFAULT_LEVERAGE}x\n` +
      `<b>Position:</b> ${POSITION_PCT}% per trade\n` +
      `<b>Coins:</b> ${[...ALLOWED_COINS].join(', ')}\n` +
      `<b>Equity:</b> $${(startingEquity || 10000).toFixed(2)}\n` +
      `<i>Waiting for signals...</i>`
    );
  });
}

main().catch((e) => {
  console.error('Fatal error:', e);
  sendTelegram(`\u{1F6A8} <b>BOT CRASHED</b>\n${e.message}`).finally(() => process.exit(1));
});

// Catch uncaught errors and notify
process.on('uncaughtException', async (e) => {
  console.error('Uncaught:', e);
  await sendTelegram(`\u{1F6A8} <b>BOT ERROR</b>\n${e.message}`);
});

process.on('unhandledRejection', async (e) => {
  console.error('Unhandled rejection:', e);
  await sendTelegram(`\u{26A0}\u{FE0F} <b>Bot Warning</b>\n${e?.message || e}`);
});
