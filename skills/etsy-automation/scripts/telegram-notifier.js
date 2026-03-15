#!/usr/bin/env node
/**
 * Telegram Notifier
 *
 * Sends two daily messages via Telegram:
 *
 *   Message 1 — Products Created
 *     • How many products were created today
 *     • Link to each listing (or "draft — review in Etsy Studio")
 *
 *   Message 2 — Sales Summary
 *     • How many products sold today
 *     • Today's revenue
 *     • Top seller (if any)
 *
 * Requires:
 *   TELEGRAM_BOT_TOKEN  — your Telegram bot token
 *   TELEGRAM_CHAT_ID    — your personal chat ID (get it from @userinfobot)
 *
 * Usage:
 *   node telegram-notifier.js --date=2025-06-01   (send summary for a date)
 *   node telegram-notifier.js                     (today)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR     = process.env.ETSY_DATA_DIR || path.join(__dirname, '..', 'data');
const LISTINGS_DIR = path.join(DATA_DIR, 'listings');
const METRICS_DIR  = path.join(DATA_DIR, 'metrics');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ─── Telegram API helper ──────────────────────────────────────────────────────

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
      disable_web_page_preview: false,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram API error (${resp.status}): ${body}`);
  }

  return resp.json();
}

// ─── Build message content ────────────────────────────────────────────────────

function buildProductsMessage(date, listings) {
  const successful = listings.filter((l) => l.status === 'success');
  const failed     = listings.filter((l) => l.status !== 'success');

  if (successful.length === 0) {
    return `📦 <b>Etsy Daily Report — ${date}</b>\n\n` +
           `No new products were created today.\n` +
           (failed.length > 0 ? `❌ ${failed.length} failed — check logs.` : '');
  }

  const lines = [
    `📦 <b>Etsy Daily Report — ${date}</b>`,
    ``,
    `✅ <b>${successful.length} new product${successful.length > 1 ? 's' : ''} created!</b>`,
    ``,
  ];

  successful.forEach((l, i) => {
    const stateIcon = l.state === 'active' ? '🟢' : '📝';
    const stateLabel = l.state === 'active' ? 'Live' : 'Draft';
    lines.push(`${i + 1}. ${stateIcon} <b>${l.title || `Product ${l.product_id}`}</b>`);
    if (l.price_usd) lines.push(`   💲 $${l.price_usd}`);
    if (l.listing_url) {
      lines.push(`   <a href="${l.listing_url}">View on Etsy (${stateLabel})</a>`);
    }
    lines.push('');
  });

  if (failed.length > 0) {
    lines.push(`❌ ${failed.length} product${failed.length > 1 ? 's' : ''} failed — check logs.`);
  }

  return lines.join('\n');
}

function buildSalesMessage(date, metricsSnapshot) {
  if (!metricsSnapshot) {
    return `📊 <b>Sales Summary — ${date}</b>\n\nNo metrics data available.`;
  }

  const { total_sales, revenue_usd, listings } = metricsSnapshot;

  const lines = [
    `📊 <b>Sales Summary — ${date}</b>`,
    ``,
    `💰 Sales today: <b>${total_sales}</b>`,
    `💵 Revenue:     <b>$${revenue_usd}</b>`,
    ``,
  ];

  if (total_sales > 0 && listings) {
    const topSellers = (listings || [])
      .filter((l) => (l.sales_today || 0) > 0)
      .sort((a, b) => (b.sales_today || 0) - (a.sales_today || 0))
      .slice(0, 3);

    if (topSellers.length > 0) {
      lines.push(`🏆 <b>Top sellers:</b>`);
      topSellers.forEach((l) => {
        lines.push(`  • ${l.title.slice(0, 50)} — ${l.sales_today} sale${l.sales_today > 1 ? 's' : ''} ($${l.revenue_today})`);
      });
      lines.push('');
    }
  }

  const allTimeFavorites = (listings || [])
    .sort((a, b) => (b.favorites || 0) - (a.favorites || 0))
    .slice(0, 1);
  if (allTimeFavorites.length > 0 && allTimeFavorites[0].favorites > 0) {
    lines.push(`❤️ Most favorited: <b>${allTimeFavorites[0].title.slice(0, 50)}</b> (${allTimeFavorites[0].favorites} saves)`);
  }

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runNotifier(date) {
  date = date || new Date().toISOString().slice(0, 10);
  console.log(`[telegram] Sending daily notifications for ${date}...`);

  // Load listings data
  let listings = [];
  const listingsFile = path.join(LISTINGS_DIR, `${date}.json`);
  if (fs.existsSync(listingsFile)) {
    const data = JSON.parse(fs.readFileSync(listingsFile, 'utf8'));
    listings = data.listings || [];
  }

  // Load metrics data
  let metricsSnapshot = null;
  const metricsFile = path.join(METRICS_DIR, `${date}.json`);
  if (fs.existsSync(metricsFile)) {
    metricsSnapshot = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
  }

  const errors = [];

  // Send products message
  try {
    const msg = buildProductsMessage(date, listings);
    await sendTelegramMessage(msg);
    console.log('[telegram] Products message sent ✅');
  } catch (err) {
    console.error('[telegram] Failed to send products message:', err.message);
    errors.push(err.message);
  }

  // Small delay between messages
  await new Promise((r) => setTimeout(r, 2000));

  // Send sales message
  try {
    const msg = buildSalesMessage(date, metricsSnapshot);
    await sendTelegramMessage(msg);
    console.log('[telegram] Sales message sent ✅');
  } catch (err) {
    console.error('[telegram] Failed to send sales message:', err.message);
    errors.push(err.message);
  }

  return { date, errors };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const date    = dateArg ? dateArg.split('=')[1] : undefined;

  runNotifier(date)
    .then((result) => {
      if (result.errors.length > 0) {
        console.error('Errors:', result.errors);
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('[telegram] Fatal error:', err.message);
      process.exit(1);
    });
} else {
  module.exports = { runNotifier };
}
