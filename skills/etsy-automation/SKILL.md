---
name: etsy-automation
description: >
  Daily automated Etsy digital product workflow. Researches top-selling digital
  products on Etsy, uses Claude to select 3 copyright-safe opportunities, creates
  original designs via Canva Connect API, posts listings to your Etsy shop, tracks
  shop metrics, and sends daily Telegram summaries.
---

# Etsy Automation Skill

Fully automated daily workflow that creates and publishes original digital products to your Etsy shop.

## What It Does (Daily, 9 AM UTC)

1. **Research** — Scans Etsy for today's top-selling digital products across 8 categories
2. **Analyze** — Claude selects the 3 best copyright-safe product opportunities based on market data + your shop's performance history
3. **Design** — Creates original product files (PDF) and listing mockups (PNG) via Canva Connect API
4. **List** — Posts draft or active listings to your Etsy shop via the Etsy API
5. **Metrics** — Pulls daily sales/views data, generates AI insights for future improvement
6. **Notify** — Sends two Telegram messages: products created (with links) + sales summary

## Required Secrets

Set all of these via `wrangler secret put <NAME>`:

| Secret | How to get it |
|--------|--------------|
| `ETSY_API_KEY` | [Etsy Developer Portal](https://www.etsy.com/developers/) → Create App → Copy API Key |
| `ETSY_API_SECRET` | Same Etsy app page → Copy Shared Secret |
| `ETSY_SHOP_ID` | Your Etsy shop ID (numeric) — find in Etsy Studio → Settings |
| `CANVA_CLIENT_ID` | [Canva Developer Portal](https://www.canva.com/developers/) → Create Integration |
| `CANVA_CLIENT_SECRET` | Same Canva integration page |
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/botfather) on Telegram → /newbot |
| `TELEGRAM_CHAT_ID` | Message [@userinfobot](https://t.me/userinfobot) on Telegram — it replies with your chat ID |

## First-Time Setup

### 1. Deploy the Worker

```bash
# Add all secrets first
npx wrangler secret put ETSY_API_KEY
npx wrangler secret put ETSY_API_SECRET
npx wrangler secret put ETSY_SHOP_ID
npx wrangler secret put CANVA_CLIENT_ID
npx wrangler secret put CANVA_CLIENT_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID

# Deploy
npm run deploy
```

### 2. Authorize Etsy

The Etsy API requires OAuth 2.0 authorization before the automation can post listings.

1. Visit `https://your-worker.workers.dev/etsy/auth` in your browser
2. You'll be redirected to Etsy to grant permissions
3. After approving, you'll be redirected back to the worker
4. A confirmation page will appear — authorization is complete

**Register your redirect URI in the Etsy Developer Portal:**
```
https://your-worker.workers.dev/etsy/callback
```
(Settings → Callback URL in your Etsy app)

### 3. Authorize Canva

Canva requires a separate OAuth flow. The Canva API uses client credentials flow for app-level access or OAuth 2.0 for user-level design creation.

1. In your [Canva integration settings](https://www.canva.com/developers/), set the redirect URI:
   ```
   https://your-worker.workers.dev/canva/callback
   ```
   *(or complete Canva OAuth manually and paste the tokens into the token file)*

2. Alternatively, use the Canva Connect API with service account credentials if your integration supports it.

3. To manually bootstrap tokens, run inside the container:
   ```bash
   node /root/clawd/skills/etsy-automation/scripts/canva-auth-helper.js
   ```

### 4. Check Status

Visit `https://your-worker.workers.dev/etsy/status` to see:
- OAuth token status
- Last workflow run time and result
- Manual trigger button

### 5. Test Run

Trigger the workflow immediately from the status page, or via:
```bash
# Via the Worker API
curl -X POST https://your-worker.workers.dev/etsy/trigger \
  -H "Cookie: CF_Authorization=..."

# Or directly inside the container
node /root/clawd/skills/etsy-automation/scripts/run-daily.js --skip-listing
```

## Configuration

Edit `/root/clawd/etsy-automation/config.json` (auto-created on first run, persisted to R2):

```json
{
  "productsPerDay": 3,
  "autoPublish": false,
  "defaultPrice": 3.99,
  "telegramEnabled": true
}
```

**`autoPublish: false`** (default) creates listings as **drafts** so you can review before publishing. Set to `true` to publish immediately.

## File Structure

All data is stored at `/root/clawd/etsy-automation/` (synced to R2 every 5 minutes):

```
etsy-automation/
├── etsy-tokens.json          # Etsy OAuth tokens (auto-refreshed)
├── canva-tokens.json         # Canva OAuth tokens (auto-refreshed)
├── last-run.json             # Result of most recent workflow run
├── research/
│   └── YYYY-MM-DD.json       # Daily Etsy market research
├── products/
│   └── YYYY-MM-DD.json       # Claude's 3 product selections + specs
├── designs/
│   └── YYYY-MM-DD/
│       └── product-N/
│           ├── spec.json         # Product specification
│           ├── design-meta.json  # Canva design ID + edit URL
│           ├── product.pdf       # The purchasable digital file
│           └── listing-image.png # Etsy listing thumbnail
├── listings/
│   └── YYYY-MM-DD.json       # Etsy listing IDs and URLs created
├── metrics/
│   ├── YYYY-MM-DD.json       # Daily shop performance snapshot
│   ├── insights.json         # Rolling AI-generated insights
└── run-logs/
    └── YYYY-MM-DD.json       # Detailed workflow run logs
```

## Manual Commands

Run individual steps from inside the container:

```bash
# Research only
node /root/clawd/skills/etsy-automation/scripts/etsy-research.js --print

# Analyze (requires today's research file)
node /root/clawd/skills/etsy-automation/scripts/product-analyzer.js

# Design (requires today's products file)
node /root/clawd/skills/etsy-automation/scripts/canva-designer.js

# List on Etsy (requires today's products + designs)
node /root/clawd/skills/etsy-automation/scripts/etsy-lister.js

# Check metrics
node /root/clawd/skills/etsy-automation/scripts/metrics-tracker.js

# Send Telegram notifications
node /root/clawd/skills/etsy-automation/scripts/telegram-notifier.js

# Full workflow
node /root/clawd/skills/etsy-automation/scripts/run-daily.js

# Skip specific steps
node /root/clawd/skills/etsy-automation/scripts/run-daily.js --skip-design --skip-listing
```

## Telegram Message Examples

**Products Created:**
```
📦 Etsy Daily Report — 2025-06-01

✅ 3 new products created!

1. 📝 Minimalist Abstract Line Art Print — Set of 4
   💲 $3.99
   View on Etsy (Draft)

2. 🟢 Daily Budget Tracker Spreadsheet Template
   💲 $4.99
   View on Etsy (Live)

3. 📝 Botanical Leaf SVG Cut File Bundle
   💲 $2.99
   View on Etsy (Draft)
```

**Sales Summary:**
```
📊 Sales Summary — 2025-06-01

💰 Sales today: 7
💵 Revenue:     $27.93

🏆 Top sellers:
  • Minimalist Line Art Print Set — 3 sales ($11.97)
  • Budget Tracker Template — 2 sales ($9.98)

❤️ Most favorited: Abstract Watercolor Wall Art (143 saves)
```

## Etsy API Rate Limits

The skill respects Etsy's rate limits:
- Max 10 requests/second (enforced via 150ms delays in research loop)
- Max 5 images per listing
- Max 13 tags per listing
- Max 10 digital files per listing

## Copyright Policy

Claude is explicitly instructed **never** to select or generate:
- Trademarked characters (Disney, Marvel, etc.)
- Celebrity likenesses
- Licensed logos or brand assets
- Copyrighted song lyrics, books, or film quotes
- Any content that reproduces existing artwork

All products are original designs created from scratch in Canva using geometric shapes, typography, abstract patterns, and original illustrations.
