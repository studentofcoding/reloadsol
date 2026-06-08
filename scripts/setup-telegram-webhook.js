#!/usr/bin/env node
/**
 * Register Telegram webhook for DLMM bot management.
 * Usage: node scripts/setup-telegram-webhook.js <webhookUrl>
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
 */
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const webhookUrl = process.argv[2] || process.env.DLMM_TELEGRAM_WEBHOOK_URL;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || 'reloadsol-dlmm-secret';

if (!token || !webhookUrl) {
  console.error('Set TELEGRAM_BOT_TOKEN and pass webhook URL');
  process.exit(1);
}

async function main() {
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
    }),
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
