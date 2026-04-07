#!/usr/bin/env node
/**
 * TradingView Alert -> Telegram + Hyperliquid Trading Bot
 *
 * Receives TradingView webhook alerts, executes 3x leveraged trades
 * on Hyperliquid, and sends notifications to Telegram.
 *
 * Setup:
 *   1. Copy .env.example to .env and fill in your keys
 *   2. Run: node scripts/hyperliquid-bot.js
 *   3. Expose with ngrok: ngrok http 3142
 *   4. Set TradingView alert webhook to: https://xxx.ngrok.io/webhook
 *
 * TradingView alert message format:
 *   {"symbol":"{{ticker}}","action":"BUY","price":"{{close}}","time":"{{time}}"}
 *
 * SECURITY:
 *   - Use a DEDICATED trading wallet, never your main wallet
 *   - Only deposit what you can afford to lose
 *   - Start on testnet first
 */

try { await import('dotenv/config'); } catch { /* dotenv not needed on Railway */ }
import http from 'node:http';
import https from 'node:https';
import { Hyperliquid } from 'hyperliquid';

// === CONFIG ===
const PORT = parseInt(process.env.PORT || '3142');
const TESTNET = process.env.HL_TESTNET === 'true';
const PRIVATE_KEY = process.env.HL_PRIVATE_KEY || '';
const VAULT_ADDRESS = process.env.HL_PUBLIC_WALLET || ''; // main wallet where funds live
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const DEFAULT_LEVERAGE = parseInt(process.env.LEVERAGE || '3');
const SLIPPAGE = parseFloat(process.env.SLIPPAGE || '0.05'); // 5%
const SL_ATR_MULT = parseFloat(process.env.SL_ATR_MULT || '1.5');
const TP_ATR_MULT = parseFloat(process.env.TP_ATR_MULT || '3.0');
const DRY_RUN = process.env.DRY_RUN !== 'false'; // default: true (paper mode)

// Symbol mapping: TradingView ticker -> Hyperliquid coin
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

// Allowed coins — TOP 3 performers only
const ALLOWED_COINS = new Set(['BTC', 'SOL', 'SUI']);

// === STATE ===
let sdk = null;
let assetMap = new Map(); // coin name -> asset index
const activePositions = new Map(); // coin -> { entry, sl, tp }
const tradeLog = [];

// === TELEGRAM ===
function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return Promise.resolve();
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML' });
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
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
  const sdkOpts = {
    privateKey: PRIVATE_KEY,
    testnet: TESTNET,
  };
  if (VAULT_ADDRESS) {
    sdkOpts.walletAddress = VAULT_ADDRESS; // trade on behalf of main wallet
  }
  sdk = new Hyperliquid(sdkOpts);
  await sdk.connect();
  const apiAddr = sdk.custom.getUserAddress();
  log(`Hyperliquid SDK connected (${TESTNET ? 'TESTNET' : 'MAINNET'})`);
  log(`  API wallet: ${apiAddr}`);
  log(`  Vault/Main wallet: ${VAULT_ADDRESS || apiAddr}`);

  // Build asset index map
  try {
    const meta = await sdk.info.perpetuals.getMeta();
    meta.universe.forEach((asset, idx) => {
      const name = asset.name.replace('-PERP', '');
      assetMap.set(name, idx);
    });
    log(`Loaded ${assetMap.size} assets`);
  } catch (e) {
    log(`Failed to load asset metadata: ${e.message}`);
  }

  // Set leverage for all allowed coins
  // SDK requires '-PERP' suffix for updateLeverage
  for (const coin of ALLOWED_COINS) {
    try {
      await sdk.exchange.updateLeverage(`${coin}-PERP`, 'cross', DEFAULT_LEVERAGE);
      log(`  ${coin}: ${DEFAULT_LEVERAGE}x cross leverage set`);
    } catch (e) {
      log(`  ${coin}: leverage set failed - ${e.message}`);
    }
  }
}

// === POSITION SIZING ===
// Uses 25% of available equity per trade (max 3 concurrent positions = 75% max exposure)
const POSITION_PCT = parseFloat(process.env.POSITION_PCT || '25'); // % of equity per trade

async function calcPositionSize(coin, price) {
  // In dry run mode without SDK, use fixed equity estimate
  if (DRY_RUN && !sdk) {
    const equity = 10000;
    const tradeValue = equity * (POSITION_PCT / 100);
    const size = tradeValue / price;
    return { size: Math.floor(size * 10000) / 10000, equity, tradeValue };
  }

  try {
    // Query main wallet (where funds are), not the API wallet
    const addr = VAULT_ADDRESS || sdk.custom.getUserAddress();
    const balances = await sdk.info.perpetuals.getClearinghouseState(addr);
    const equity = parseFloat(balances.marginSummary.accountValue);
    // Use POSITION_PCT% of equity per trade
    const tradeValue = equity * (POSITION_PCT / 100);
    const size = tradeValue / price;
    log(`  Equity: $${equity.toFixed(2)}, Trade size: $${tradeValue.toFixed(2)} (${POSITION_PCT}%), ${size.toFixed(6)} ${coin} @ $${price}`);
    return { size: Math.floor(size * 10000) / 10000, equity, tradeValue };
  } catch (e) {
    log(`Position sizing error: ${e.message}`);
    return { size: 0, equity: 0, tradeValue: 0 };
  }
}

// === TRADE EXECUTION ===
async function executeBuy(coin, price) {
  if (activePositions.has(coin)) {
    log(`Already in ${coin} position, skipping`);
    return { skipped: true };
  }

  const { size, equity } = await calcPositionSize(coin, parseFloat(price));
  if (size <= 0) {
    log(`Position size is 0 for ${coin}, skipping`);
    return { skipped: true };
  }

  const slPrice = parseFloat(price) * (1 - SL_ATR_MULT * 0.02);
  const tpPrice = parseFloat(price) * (1 + TP_ATR_MULT * 0.02);

  log(`BUY ${coin}: size=${size}, price=${price}, SL=${slPrice.toFixed(2)}, TP=${tpPrice.toFixed(2)}, equity=${equity.toFixed(2)}`);

  if (DRY_RUN) {
    log(`  [DRY RUN] Would buy ${size} ${coin}`);
    activePositions.set(coin, { entry: parseFloat(price), sl: slPrice, tp: tpPrice, size });
    return { dryRun: true, size, sl: slPrice, tp: tpPrice };
  }

  try {
    // SDK signature: marketOpen(coin, isBuy, sz, px?, slippage?)
    const order = await sdk.custom.marketOpen(coin, true, size, undefined, SLIPPAGE);

    activePositions.set(coin, { entry: parseFloat(price), sl: slPrice, tp: tpPrice, size });

    tradeLog.push({
      time: new Date().toISOString(),
      coin, action: 'BUY', size, price: parseFloat(price),
      sl: slPrice, tp: tpPrice, order,
    });

    return { success: true, size, sl: slPrice, tp: tpPrice, order };
  } catch (e) {
    log(`  ORDER FAILED: ${e.message}`);
    return { error: e.message };
  }
}

async function executeSell(coin, price) {
  if (!activePositions.has(coin)) {
    log(`No position in ${coin}, skipping sell`);
    return { skipped: true };
  }

  const pos = activePositions.get(coin);
  log(`SELL ${coin}: price=${price}, entry=${pos.entry}`);

  if (DRY_RUN) {
    const pnl = (parseFloat(price) - pos.entry) * pos.size * DEFAULT_LEVERAGE;
    log(`  [DRY RUN] Would close ${coin}, est. P&L: $${pnl.toFixed(2)}`);
    activePositions.delete(coin);
    return { dryRun: true, pnl };
  }

  try {
    // SDK signature: marketClose(coin)
    const order = await sdk.custom.marketClose(coin);
    const pnl = (parseFloat(price) - pos.entry) * pos.size * DEFAULT_LEVERAGE;
    activePositions.delete(coin);

    tradeLog.push({
      time: new Date().toISOString(),
      coin, action: 'SELL', size: pos.size, price: parseFloat(price),
      pnl, order,
    });

    return { success: true, pnl, order };
  } catch (e) {
    log(`  CLOSE FAILED: ${e.message}`);
    return { error: e.message };
  }
}

// === WEBHOOK HANDLER ===
async function handleWebhook(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: 'Invalid JSON' };
  }

  const rawSymbol = (data.symbol || '').replace('BINANCE:', '').replace('COINBASE:', '').replace('BITSTAMP:', '');
  const coin = SYMBOL_MAP[rawSymbol] || SYMBOL_MAP[rawSymbol.replace('USDT', '').replace('USD', '')];
  const action = (data.action || '').toUpperCase();
  const price = data.price || '0';

  if (!coin) {
    log(`Unknown symbol: ${data.symbol} (${rawSymbol})`);
    return { error: `Unknown symbol: ${data.symbol}` };
  }

  if (!ALLOWED_COINS.has(coin)) {
    log(`${coin} not in allowed list, skipping`);
    return { error: `${coin} not allowed` };
  }

  log(`\nAlert: ${action} ${coin} @ ${price}`);

  let result;
  if (action === 'BUY') {
    result = await executeBuy(coin, price);
  } else if (action === 'SELL' || action === 'CLOSE') {
    result = await executeSell(coin, price);
  } else {
    result = { error: `Unknown action: ${action}` };
  }

  // Send Telegram notification
  const emoji = action === 'BUY' ? '\u{1F7E2}' : '\u{1F534}';
  const mode = DRY_RUN ? ' [PAPER]' : '';
  let msg = `${emoji} <b>${action} ${coin}</b>${mode}\n<b>Price:</b> $${price}`;

  if (result.size) msg += `\n<b>Size:</b> ${result.size} ${coin}`;
  if (result.sl) msg += `\n<b>SL:</b> $${result.sl.toFixed(2)}`;
  if (result.tp) msg += `\n<b>TP:</b> $${result.tp.toFixed(2)}`;
  if (result.pnl !== undefined) msg += `\n<b>P&L:</b> $${result.pnl.toFixed(2)}`;
  if (result.error) msg += `\n<b>Error:</b> ${result.error}`;
  if (result.skipped) msg += `\n<i>Skipped (already positioned)</i>`;

  msg += `\n<b>Leverage:</b> ${DEFAULT_LEVERAGE}x`;
  msg += `\n\n<i>Momentum Rider Bot</i>`;

  await sendTelegram(msg);
  return result;
}

// === HTTP SERVER ===
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
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
  } else if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      mode: DRY_RUN ? 'PAPER' : 'LIVE',
      network: TESTNET ? 'testnet' : 'mainnet',
      leverage: DEFAULT_LEVERAGE,
      positions: Object.fromEntries(activePositions),
      trades: tradeLog.length,
      allowed: [...ALLOWED_COINS],
    }));
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

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
=============================================
`);

  if (!DRY_RUN) {
    await initSDK();
  }

  server.listen(PORT, () => {
    log(`Webhook server running on http://localhost:${PORT}/webhook`);
    log(`Status page: http://localhost:${PORT}/status`);
    log('');
    log('Next steps:');
    log('  1. Run: ngrok http ' + PORT);
    log('  2. Copy https URL to TradingView alert webhook');
    log('  3. Alert message format:');
    log('     {"symbol":"{{ticker}}","action":"{{strategy.order.action}}","price":"{{close}}","time":"{{time}}"}');
    log('');

    if (DRY_RUN) {
      log('Running in PAPER mode. Set DRY_RUN=false in .env for live trading.');
    }

    // Send startup notification
    sendTelegram(
      `\u{1F680} <b>Momentum Rider Bot Started</b>\n` +
      `<b>Mode:</b> ${DRY_RUN ? 'Paper' : 'LIVE'}\n` +
      `<b>Leverage:</b> ${DEFAULT_LEVERAGE}x\n` +
      `<b>Coins:</b> ${[...ALLOWED_COINS].join(', ')}\n` +
      `<i>Waiting for signals...</i>`
    );
  });
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
