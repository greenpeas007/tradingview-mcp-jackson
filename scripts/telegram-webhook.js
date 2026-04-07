#!/usr/bin/env node
/**
 * TradingView Alert → Telegram Webhook Bridge
 *
 * Receives TradingView webhook alerts and forwards to Telegram.
 *
 * Setup:
 *   1. Run: node scripts/telegram-webhook.js
 *   2. Expose port 3142 via ngrok: ngrok http 3142
 *   3. Copy ngrok URL into TradingView alert webhook field
 *   4. Alert message format (JSON):
 *      {"symbol":"{{ticker}}","action":"{{strategy.order.action}}","price":"{{close}}","time":"{{time}}"}
 *
 * Environment variables (or edit defaults below):
 *   TELEGRAM_BOT_TOKEN - your bot token from @BotFather
 *   TELEGRAM_CHAT_ID   - your chat ID
 */

import http from 'node:http';
import https from 'node:https';

// === CONFIG ===
const PORT = process.env.PORT || 3142;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID environment variables');
  console.error('Example:');
  console.error('  TELEGRAM_BOT_TOKEN=123:ABC TELEGRAM_CHAT_ID=123456 node scripts/telegram-webhook.js');
  process.exit(1);
}

function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
  });

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Telegram API error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function formatAlert(payload) {
  try {
    const data = JSON.parse(payload);
    const emoji = data.action?.toLowerCase().includes('buy') ? '\u{1F7E2}' : '\u{1F534}';
    const action = (data.action || 'ALERT').toUpperCase();
    const symbol = data.symbol || 'UNKNOWN';
    const price = data.price || 'N/A';
    const time = data.time || new Date().toISOString();

    return [
      `${emoji} <b>${action}</b> ${symbol}`,
      `<b>Price:</b> ${price}`,
      `<b>Time:</b> ${time}`,
      data.message ? `<b>Note:</b> ${data.message}` : '',
      `\n<i>Momentum Rider Strategy</i>`,
    ].filter(Boolean).join('\n');
  } catch {
    return `\u{1F514} <b>TradingView Alert</b>\n${payload}`;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', async () => {
      console.log(`[${new Date().toISOString()}] Alert received:`, body);

      try {
        const message = formatAlert(body);
        await sendTelegram(message);
        console.log('  -> Sent to Telegram');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('  -> Telegram error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end('Not found. POST to /webhook');
  }
});

server.listen(PORT, () => {
  console.log(`\nTelegram Webhook Bridge running on http://localhost:${PORT}/webhook`);
  console.log(`Chat ID: ${CHAT_ID}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Install ngrok: https://ngrok.com/download`);
  console.log(`  2. Run: ngrok http ${PORT}`);
  console.log(`  3. Copy the https URL (e.g. https://abc123.ngrok.io)`);
  console.log(`  4. In TradingView alert, set webhook URL to: https://abc123.ngrok.io/webhook`);
  console.log(`  5. Set alert message to:`);
  console.log(`     {"symbol":"{{ticker}}","action":"{{strategy.order.action}}","price":"{{close}}","time":"{{time}}"}`);
  console.log(`\nWaiting for alerts...\n`);
});
