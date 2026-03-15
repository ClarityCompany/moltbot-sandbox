#!/usr/bin/env node
/**
 * Telegram Notifier
 *
 * Sends a daily summary message with the products that were created today
 * and uploaded to Google Sheets (ready for Make to post to Etsy).
 *
 * Requires:
 *   TELEGRAM_BOT_TOKEN  — your Telegram bot token
 *   TELEGRAM_CHAT_ID    — your personal chat ID (get it from @userinfobot)
 *
 * Usage:
 *   node telegram-notifier.js
 *   node telegram-notifier.js --date=2025-06-01
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR     = process.env.ETSY_DATA_DIR || path.join(__dirname, '..', 'data');
const PRODUCTS_DIR = path.join(DATA_DIR, 'products');
const DESIGNS_DIR  = path.join(DATA_DIR, 'designs');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramMessage(text, parseMode = 'HTML') {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  if (!CHAT_ID)   throw new Error('TELEGRAM_CHAT_ID is not set');

  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id:    CHAT_ID,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram API error (${resp.status}): ${body}`);
  }

  return resp.json();
}

async function runNotifier(date) {
  date = date || new Date().toISOString().slice(0, 10);
  console.log(`[telegram] Sending daily notification for ${date}...`);

  // Load today's products
  let products = [];
  const productsFile = path.join(PRODUCTS_DIR, `${date}.json`);
  if (fs.existsSync(productsFile)) {
    const data = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
    products = data.products || [];
  }

  // Check design results to know which products have mockups ready
  let designResults = [];
  const designsFile = path.join(DESIGNS_DIR, date, 'design-results.json');
  if (fs.existsSync(designsFile)) {
    const data = JSON.parse(fs.readFileSync(designsFile, 'utf8'));
    designResults = data.results || [];
  }

  const lines = [
    `🛍️ <b>Etsy Automation — ${date}</b>`,
    '',
  ];

  if (products.length === 0) {
    lines.push('No products were created today.');
  } else {
    lines.push(`✅ <b>${products.length} product${products.length > 1 ? 's' : ''} ready for Etsy</b>`);
    lines.push('');

    products.forEach((p, i) => {
      const design = designResults.find((d) => d.product_id === p.id && d.status === 'success');
      const mockupCount = design?.mockup_paths?.length || 0;
      const hasDesign   = !!design?.png_path;

      lines.push(`${i + 1}. <b>${p.title || `Product ${p.id}`}</b>`);
      lines.push(`   💲 $${p.price_usd}  |  🏷 ${(p.tags || []).slice(0, 3).join(', ')}`);
      lines.push(`   🎨 Design: ${hasDesign ? '✅' : '❌'}  |  📸 Mockups: ${mockupCount}/4`);
      lines.push('');
    });

    lines.push('📊 Rows written to Google Sheet — Make will create the Etsy listings shortly.');
  }

  const message = lines.join('\n');

  try {
    await sendTelegramMessage(message);
    console.log('[telegram] Message sent ✅');
  } catch (err) {
    console.error('[telegram] Failed to send message:', err.message);
    return { date, errors: [err.message] };
  }

  return { date, errors: [] };
}

if (require.main === module) {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const date    = dateArg ? dateArg.split('=')[1] : undefined;

  runNotifier(date)
    .then((result) => process.exit(result.errors.length > 0 ? 1 : 0))
    .catch((err) => {
      console.error('[telegram] Fatal error:', err.message);
      process.exit(1);
    });
} else {
  module.exports = { runNotifier };
}
