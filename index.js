/**
 * index.js
 *
 * A real Discord bot (bot token, in your own server) that shows a dropdown
 * of games per source (Steam/Ubisoft/EA/...) with live token counts.
 * Selecting games in a dropdown sets your watch list for that source; when
 * a watched game's tokens go from 0 -> available, the bot pings you in
 * HOME_CHANNEL_ID.
 *
 * The actual token counts still have to come from account automation
 * (Playwright, src/scraper.js) logged into your Discord account, since
 * you're only a regular member of the server being watched - a real bot
 * can't be invited there. Both pieces run continuously in this one process.
 *
 * Setup:
 *   npm install
 *   npx playwright install chromium
 *
 * .env:
 *   DISCORD_EMAIL=you@example.com       # scraper account login
 *   DISCORD_PASSWORD=yourpassword
 *   DISCORD_BOT_TOKEN=...               # your own bot's token
 *   HOME_CHANNEL_ID=...                 # channel in your own server for the dropdowns/pings
 *   HEADLESS=true                       # required for any headless host (Render, etc.)
 *   GROQ_API_KEY=...                    # free key from console.groq.com - powers general chat
 *
 * Fill in real channel IDs (and verify dropdownName) for each entry in
 * src/config.js's SOURCES array before running.
 *
 * The bot also chats: any message posted in HOME_CHANNEL_ID gets an AI reply
 * (src/chat.js, via Groq's free API), with a short rolling per-channel
 * history for context. Requires the "Message Content Intent" toggled on for
 * this bot in the Discord Developer Portal (Bot tab) - without it,
 * message.content arrives empty and the bot has nothing to reply to.
 *
 * Optional, for a couple of extra non-Discord alert channels on every
 * availability transition (regardless of who's watching what):
 *   WHATSAPP_PHONE=15551234567
 *   WHATSAPP_APIKEY=your_key
 *   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
 *
 * Deploying to Render: this file already binds to $PORT with a no-op HTTP
 * server so Render's health check is satisfied; use an external pinger
 * (cron-job.org / UptimeRobot) hitting that URL every ~10 min to stop the
 * free tier from spinning the container down after 15 min of no traffic.
 * Upload discord_auth_state.json as a Render Secret File (generate it
 * locally first - headed run, solve 2FA once) - never commit it.
 *
 * Note: state.json (games, watchers, message IDs) lives on local disk and
 * is NOT committed anywhere, so it resets on redeploy (though it survives
 * plain restarts). Fine for now; revisit if losing watch lists on redeploy
 * becomes a real problem.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  POLL_INTERVAL_MS,
  WHATSAPP_PHONE,
  WHATSAPP_APIKEY,
  DISCORD_WEBHOOK_URL,
} = require('./src/config');
const { loadState, saveState } = require('./src/state');
const { initScraper, scrapeOnce } = require('./src/scraper');
const { startBot, postOrUpdateWatchMessages, announceAvailable } = require('./src/bot');

// Mirrors every console.log/console.error (from this file and every module
// it requires) to a plain-text file, so log output is readable without
// needing this terminal - useful once this runs somewhere headless (Render).
const LOG_FILE_PATH = path.join(__dirname, 'bot.log');
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function appendToLogFile(level, args) {
  const line = args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' ');
  fs.appendFileSync(LOG_FILE_PATH, `[${new Date().toISOString()}] ${level} ${line}\n`);
}

console.log = (...args) => {
  originalConsoleLog(...args);
  appendToLogFile('INFO', args);
};

console.error = (...args) => {
  originalConsoleError(...args);
  appendToLogFile('ERROR', args);
};

// See discord_login.js's original header for why this exists: Render only
// keeps a free "Web Service" alive if it answers HTTP requests on $PORT.
if (process.env.PORT) {
  http
    .createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('discord watcher is running\n');
    })
    .listen(process.env.PORT, () => {
      console.log(`Keep-alive HTTP server listening on port ${process.env.PORT}`);
    });
}

async function sendWhatsAppAlert(message) {
  if (!WHATSAPP_PHONE || !WHATSAPP_APIKEY) return;
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(WHATSAPP_PHONE)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(WHATSAPP_APIKEY)}`;
  try {
    await fetch(url);
  } catch (err) {
    console.error('Failed to send WhatsApp alert:', err.message);
  }
}

async function sendDiscordWebhookAlert(message) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
  } catch (err) {
    console.error('Failed to send Discord webhook alert:', err.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const state = loadState();

  const client = await startBot(state);
  await postOrUpdateWatchMessages(client, state);
  saveState(state);

  await initScraper();
  console.log(`Scraper ready. Polling every ${POLL_INTERVAL_MS / 1000}s.`);

  while (true) {
    try {
      const becameAvailable = await scrapeOnce(state);
      await postOrUpdateWatchMessages(client, state);
      saveState(state);

      if (becameAvailable.length > 0) {
        await announceAvailable(client, becameAvailable, state);
        await Promise.all(
          becameAvailable.map(({ label, tokens }) =>
            Promise.all([
              sendWhatsAppAlert(`"${label}" has ${tokens} token(s) available now.`),
              sendDiscordWebhookAlert(`"${label}" has ${tokens} token(s) available now.`),
            ])
          )
        );
      }
    } catch (err) {
      console.error('Scrape cycle failed:', err);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
