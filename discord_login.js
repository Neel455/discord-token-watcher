/**
 * discord_login.js
 *
 * Logs into Discord using Playwright.
 *
 * Setup:
 *   npm init -y
 *   npm install playwright dotenv
 *   npx playwright install chromium
 *
 * Create a .env file in this same folder with:
 *   DISCORD_EMAIL=you@example.com
 *   DISCORD_PASSWORD=yourpassword
 *
 * Optional, for running headless on a server (see README/deploy notes):
 *   HEADLESS=true
 *
 * Optional, for WhatsApp alerts on token-availability events and login
 * failures, via CallMeBot's free API (callmebot.com/blog/free-api-whatsapp-messages):
 *   WHATSAPP_PHONE=15551234567   # your number, country code, digits only
 *   WHATSAPP_APIKEY=your_key     # sent to you by CallMeBot after opt-in
 *
 * Optional, for the same alerts via a Discord webhook instead (or as well):
 *   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
 *   (create one in any server: Settings -> Integrations -> Webhooks -> New Webhook)
 *
 * Deploying to GitHub Actions (see .github/workflows/watch.yml) — no card,
 * ever, but checks run on a schedule (every 5-10 min) instead of continuously:
 * - Runs as a single check-and-exit pass (GITHUB_ACTIONS env var, set
 *   automatically by Actions, switches this file into that mode). Cross-run
 *   "was this already available" state lives in game_state.json, which the
 *   workflow commits back to the repo after each run — don't delete it.
 * - Add repo Settings -> Secrets and variables -> Actions -> New repository
 *   secret for: DISCORD_EMAIL, DISCORD_PASSWORD, DISCORD_AUTH_STATE (the full
 *   contents of your local discord_auth_state.json — generate it locally
 *   first, headed run, solve 2FA once), and whichever alert vars you're using
 *   (WHATSAPP_PHONE, WHATSAPP_APIKEY, DISCORD_WEBHOOK_URL).
 *
 * Deploying to Render.com's free tier (see Dockerfile) — an alternative if
 * you ever get continuous hosting working without a card:
 * - Render sets PORT and RENDER automatically; this script reacts to both
 *   (keep-alive HTTP server, low-memory Chromium flags) with no config needed.
 * - Set HEADLESS=true, DISCORD_EMAIL/PASSWORD, and whichever alert vars
 *   (WHATSAPP_*, DISCORD_WEBHOOK_URL) you're using as Render "Environment
 *   Variables" in the dashboard — never commit .env.
 * - Upload discord_auth_state.json as a Render "Secret File" (dashboard ->
 *   Environment -> Secret Files) mounted at /app/discord_auth_state.json —
 *   never commit it either, it's a live session token. Generate it locally
 *   first (headed run, solve 2FA once) before uploading.
 * - Use a free external pinger (cron-job.org / UptimeRobot) hitting the
 *   Render URL every ~10 min so the free instance never spins down.
 *
 * Usage:
 *   node discord_login.js
 *
 * Notes:
 * - Credentials are read from a .env file (via dotenv), never hardcoded.
 * - Add ".env" to your .gitignore if this project is ever put in git,
 *   so your password doesn't get committed anywhere.
 * - If your account has 2FA enabled (recommended!), the script will pause
 *   and wait for you to manually enter the code in the opened browser window.
 * - `storageState` is saved after a successful login so you can reuse the
 *   session in future runs without logging in again.
 */

require('dotenv').config();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Render (and similar PaaS free tiers) only keep a "Web Service" alive if it
// binds to $PORT and answers HTTP requests — it has no idea this is really a
// background watcher. This tiny server exists purely to satisfy that check;
// an external uptime pinger hitting it periodically is what stops Render from
// spinning the whole container down after 15 min of no traffic. The actual
// watching logic below runs independently in the same process.
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

// Render sets RENDER, GitHub Actions sets GITHUB_ACTIONS, both automatically
// in their runners. Used to trim Chromium's memory footprint / apply
// container-friendly launch flags — unnecessary (and left off) for a normal
// desktop run.
const IS_RENDER = !!process.env.RENDER;
const IS_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const IS_CONTAINER_ENV = IS_RENDER || IS_GITHUB_ACTIONS;

// GitHub Actions runners are ephemeral — nothing in memory survives between
// scheduled runs. This file is how "was this game already available last
// time we checked" persists across runs; the workflow commits it back to the
// repo after each run. Only used in GitHub Actions mode (see doPostLoginActions).
const GAME_STATE_PATH = path.join(__dirname, 'game_state.json');

const EMAIL = process.env.DISCORD_EMAIL;
const PASSWORD = process.env.DISCORD_PASSWORD;
const STORAGE_STATE_PATH = path.join(__dirname, 'discord_auth_state.json');

// Default stays headed (false) so local runs behave exactly as before, since
// you need to see the window to handle 2FA/CAPTCHA. On a headless server set
// HEADLESS=true in .env — that only works if discord_auth_state.json already
// holds a valid logged-in session, since there's no one there to solve 2FA.
const HEADLESS = process.env.HEADLESS === 'true' || IS_GITHUB_ACTIONS;

const WHATSAPP_PHONE = process.env.WHATSAPP_PHONE;
const WHATSAPP_APIKEY = process.env.WHATSAPP_APIKEY;

// Sends a WhatsApp message via CallMeBot's free API. One-time setup: add
// their number to your contacts, send them the opt-in phrase they publish,
// they reply with your API key. No-op if WHATSAPP_PHONE/WHATSAPP_APIKEY
// aren't set in .env, so this is entirely optional.
async function sendWhatsAppAlert(message) {
  if (!WHATSAPP_PHONE || !WHATSAPP_APIKEY) return;
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(WHATSAPP_PHONE)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(WHATSAPP_APIKEY)}`;
  try {
    await fetch(url);
  } catch (err) {
    console.error('Failed to send WhatsApp alert:', err.message);
  }
}

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Sends a message via a Discord webhook — an official, sanctioned Discord
// feature (unlike the account automation this script otherwise does), so
// it's the more reliable alert channel. Create one under a server's
// Settings -> Integrations -> Webhooks -> New Webhook, copy its URL.
// No-op if DISCORD_WEBHOOK_URL isn't set, so this is entirely optional.
async function sendDiscordAlert(message) {
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

// Fires every configured alert channel. Each one no-ops on its own if not
// configured, so this works fine with zero, one, or both set up.
async function sendAlert(message) {
  await Promise.all([sendWhatsAppAlert(message), sendDiscordAlert(message)]);
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error(
      'Missing credentials. Set DISCORD_EMAIL and DISCORD_PASSWORD environment variables.'
    );
    process.exit(1);
  }

  // If we already have a saved session, reuse it instead of logging in again.
  const hasSavedSession = fs.existsSync(STORAGE_STATE_PATH);

  const browser = await chromium.launch({
    headless: HEADLESS, // headed by default so you can handle 2FA/CAPTCHA if prompted
    args: IS_CONTAINER_ENV
      ? ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu']
      : [],
  });
  const context = await browser.newContext(
    hasSavedSession
      ? { storageState: STORAGE_STATE_PATH, viewport: { width: 1280, height: 800 } }
      : { viewport: { width: 1280, height: 800 } }
  );
  const page = await context.newPage();

  await page.goto('https://discord.com/login');

  // Instead of a fixed short wait, race two possible outcomes:
  //   A) already logged in -> Discord redirects to /channels/...
  //   B) not logged in -> the email/password login form appears
  // Whichever happens first tells us which path to take. This avoids
  // false negatives when Discord is slow to redirect (e.g. system under
  // load from another game/process), which previously caused the script
  // to assume "logged out" and crash looking for a login form that
  // would never appear.
  const REDIRECT_OR_FORM_TIMEOUT = 20000; // 20s, generous for a loaded system

  const outcome = await Promise.race([
    page
      .waitForURL('**/channels/**', { timeout: REDIRECT_OR_FORM_TIMEOUT })
      .then(() => 'already_logged_in')
      .catch(() => null),
    page
      .waitForSelector('input[name="email"]', { timeout: REDIRECT_OR_FORM_TIMEOUT })
      .then(() => 'needs_login')
      .catch(() => null),
  ]);

  if (outcome === 'already_logged_in') {
    console.log('Already logged in via saved session.');
    await doPostLoginActions(page);
    await browser.close();
    return;
  }

  if (outcome !== 'needs_login') {
    // Neither happened within the timeout — something unexpected occurred
    // (slow network, Discord UI change, etc.)
    console.error(
      `Timed out after ${REDIRECT_OR_FORM_TIMEOUT}ms waiting for either a redirect or the login form. Current URL: ${page.url()}`
    );
    await sendAlert(
      'Discord watcher: timed out waiting for login state (no redirect, no login form). The watcher has stopped.'
    );
    await browser.close();
    process.exit(1);
  }

  console.log('Logging in...');

  // Fill in login form
  await page.waitForSelector('input[name="email"]', { timeout: 15000 });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');

  // Give Discord a moment to process, then check what happened
  await page.waitForTimeout(3000);

  const currentUrl = page.url();

  if (currentUrl.includes('/channels/')) {
    console.log('Login successful.');
  } else {
    // Likely hit 2FA, a CAPTCHA, or a "verify it's you" prompt.
    console.log(
      'Additional verification appears to be required (2FA, CAPTCHA, or device confirmation).'
    );
    console.log('Please complete it manually in the opened browser window.');
    console.log('Waiting up to 2 minutes for you to finish...');

    try {
      await page.waitForURL('**/channels/**', { timeout: 120000 });
      console.log('Verification complete, login successful.');
    } catch (err) {
      console.error('Timed out waiting for login to complete.');
      await sendAlert(
        'Discord watcher: login needs manual 2FA/CAPTCHA that nobody completed in time. Re-run locally (headed) to refresh discord_auth_state.json, then redeploy it. The watcher has stopped.'
      );
      await browser.close();
      process.exit(1);
    }
  }

  // Save session for reuse next time
  await context.storageState({ path: STORAGE_STATE_PATH });
  console.log(`Session saved to ${STORAGE_STATE_PATH}`);

  await doPostLoginActions(page);

  await browser.close();
}

/**
 * Runs after a successful login: navigates to a server, then a channel,
 * clicks something, waits, then makes a final click depending on what's
 * showing on screen.
 *
 * Fill in the placeholders marked with TODO.
 */
async function doPostLoginActions(page) {
  // --- 1. Go to the server ---
  // Using the guild's data-list-item-id, found via DevTools element picker.
  // This is tied to the server's actual Discord ID, so it's stable across
  // Discord UI updates (unlike class names, which change often).
  const SERVER_GUILD_ID = '1310909523715690536'; // "The Free Pub"
  await page.click(`[data-list-item-id="guildsnav___${SERVER_GUILD_ID}"]`);
  await page.waitForTimeout(1500); // let the server load

  // --- 2. Go to the channel ---
  // Found via DevTools: the channel link has both a stable data-list-item-id
  // AND an href of the form /channels/{guild_id}/{channel_id}.
  // Direct navigation via URL is the most reliable option — it skips any
  // sidebar-click flakiness entirely.
  const CHANNEL_ID = '1449749992708509706'; // "ubisoft"
  await page.goto(`https://discord.com/channels/${SERVER_GUILD_ID}/${CHANNEL_ID}`);
  await page.waitForTimeout(1500); // let the channel load

  // Alternative (if you ever need to click instead of navigating directly):
  // await page.click(`[data-list-item-id="channels___${CHANNEL_ID}"]`);

  // --- 3. Click "something" and sit there ---
  // This is a dropdown ("Select a Ubisoft game..."). Its DOM id is React's
  // auto-generated (e.g. id="«r6»"), which changes every load — don't use it.
  // Instead, target by accessible role + name, which is stable.
  await page.getByRole('button', { name: 'Select a Ubisoft game...' }).click();

  console.log('Dropdown opened, waiting for options to load...');
  await page.waitForTimeout(2000); // let the option list render

  // --- 4. Check games' token availability, logging + alerting each time a
  //        game's token count goes from 0 -> available (an "event").
  //
  // Add/remove game names here. Matching is done with hasText, so partial
  // names work (e.g. "AC Black Flag" matches "AC Black Flag Resynced").
  const GAMES_TO_WATCH = [
    'AC Black Flag',
    'Anno 117 Pax Romana',
    'Far Cry 6',
    'Monopoly Star Wars',
    'Prince of Persia: The Lost Crown',
    'Star Wars Outlaws',
  ];

  // Games in this list get an emphasized, duplicated WhatsApp alert instead
  // of the normal single-line one, so they stand out in your notifications.
  // Add/remove names here (must match an entry in GAMES_TO_WATCH above).
  const PRIORITY_GAMES = ['AC Black Flag'];

  const TOKEN_THRESHOLD = 0; // only count/log when tokens exceed this
  const LOG_FILE_PATH = path.join(__dirname, 'token_availability_log.txt');

  // Checks one game's current token count against its state, logging +
  // alerting on an unavailable -> available transition. Shared by both the
  // continuous loop (local/Render) and GitHub Actions' single-pass mode.
  async function checkGame(game, state) {
    const optionLocator = page.getByRole('option').filter({ hasText: game });

    const optionText = await optionLocator.innerText().catch(() => null);
    if (optionText === null) {
      // Option not found/visible right now — record it as unknown and skip.
      state.lastTokens = 'not found';
      return;
    }

    const match = optionText.match(/(\d+)\s*tokens?\s*available/i);
    const tokens = match ? parseInt(match[1], 10) : 0;
    state.lastTokens = tokens;

    if (tokens > TOKEN_THRESHOLD && !state.wasAvailable) {
      // Transition: below threshold -> above threshold. Count it and log it.
      state.count += 1;
      state.wasAvailable = true;

      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] "${game}" exceeded ${TOKEN_THRESHOLD} tokens (tokens: ${tokens}). Total times seen: ${state.count}\n`;

      console.log(logLine.trim());
      fs.appendFileSync(LOG_FILE_PATH, logLine);

      if (PRIORITY_GAMES.includes(game)) {
        // Emphasized + sent twice so it's harder to miss among other alerts.
        // Fires regardless of mode — priority games always get this on top
        // of whatever else is going on (e.g. GitHub Actions mode's combined
        // per-check summary below).
        await sendAlert(`❗❗ PRIORITY: "${game}" has ${tokens} token(s) available now! ❗❗`);
        await sendAlert(`❗❗ PRIORITY: "${game}" has ${tokens} token(s) available now! ❗❗`);
      } else if (!IS_GITHUB_ACTIONS) {
        // In GitHub Actions mode, the combined per-check summary (below)
        // already reports every game's count each run, so a one-off
        // transition alert for non-priority games would be redundant there.
        await sendAlert(`"${game}" has ${tokens} token(s) available now.`);
      }
    } else if (tokens <= TOKEN_THRESHOLD && state.wasAvailable) {
      // Dropped back to/below threshold, so the next time it exceeds
      // TOKEN_THRESHOLD counts as a new event rather than the same one.
      state.wasAvailable = false;
    }
  }

  if (IS_GITHUB_ACTIONS) {
    // GitHub Actions runners are ephemeral — there's no long-lived process to
    // poll in a loop. Instead, the external trigger's schedule provides the
    // cadence: one check per run. Cross-run change detection relies on
    // game_state.json (including lastTokens now, since that's exactly what
    // we're diffing against), which the workflow commits back after each run.
    const savedState = fs.existsSync(GAME_STATE_PATH)
      ? JSON.parse(fs.readFileSync(GAME_STATE_PATH, 'utf8'))
      : {};

    const gameState = {};
    const previousTokens = {};
    for (const game of GAMES_TO_WATCH) {
      const saved = savedState[game] || {};
      previousTokens[game] = saved.lastTokens ?? null;
      gameState[game] = {
        count: saved.count || 0,
        wasAvailable: saved.wasAvailable || false,
        lastTokens: null,
      };
    }

    console.log(`Checking ${GAMES_TO_WATCH.length} game(s) once (GitHub Actions mode).`);
    for (const game of GAMES_TO_WATCH) {
      await checkGame(game, gameState[game]);
    }

    const snapshot = GAMES_TO_WATCH.map((game) => `${game}: ${gameState[game].lastTokens}`).join(' | ');
    console.log(`Check complete — ${snapshot}`);

    // Combined token-count summary — only sent when at least one game's
    // count actually differs from last check, so you're not getting an
    // identical message every ~5 min for no reason. Priority games (see
    // PRIORITY_GAMES) still get their own extra, emphasized alert above
    // regardless, when they actually become available.
    const hasChange = GAMES_TO_WATCH.some(
      (game) => gameState[game].lastTokens !== previousTokens[game]
    );

    if (hasChange) {
      const summaryLines = GAMES_TO_WATCH.map((game) => {
        const marker = PRIORITY_GAMES.includes(game) ? '❗ ' : '';
        return `${marker}${game}: ${gameState[game].lastTokens}`;
      });
      await sendAlert(`Token check:\n${summaryLines.join('\n')}`);
    } else {
      console.log('No change since last check — summary alert skipped.');
    }

    const stateToSave = {};
    for (const game of GAMES_TO_WATCH) {
      stateToSave[game] = {
        count: gameState[game].count,
        wasAvailable: gameState[game].wasAvailable,
        lastTokens: gameState[game].lastTokens,
      };
    }
    fs.writeFileSync(GAME_STATE_PATH, JSON.stringify(stateToSave, null, 2));
    return;
  }

  // Continuous mode (local run or Render): poll indefinitely in-process.
  const POLL_INTERVAL_MS = 2000; // how often to check, in ms.
  const HEARTBEAT_EVERY_N_POLLS = 15; // ~every 30s at a 2s poll interval — adjust as needed

  const gameState = {};
  for (const game of GAMES_TO_WATCH) {
    gameState[game] = { count: 0, wasAvailable: false, lastTokens: null };
  }

  console.log(`Watching ${GAMES_TO_WATCH.length} game(s) indefinitely. Logging to ${LOG_FILE_PATH}`);
  console.log('Press Ctrl+C to stop.');

  let pollCount = 0;

  // Runs forever until the process is killed (Ctrl+C) or the page errors out.
  while (true) {
    pollCount += 1;

    for (const game of GAMES_TO_WATCH) {
      await checkGame(game, gameState[game]);
    }

    // Heartbeat: every N polls, print a full snapshot so you can visually
    // confirm the script is alive and actually reading current values,
    // even when nothing has crossed the threshold recently.
    if (pollCount % HEARTBEAT_EVERY_N_POLLS === 0) {
      const timestamp = new Date().toISOString();
      const snapshot = GAMES_TO_WATCH.map(
        (game) => `${game}: ${gameState[game].lastTokens}`
      ).join(' | ');
      console.log(`[${timestamp}] heartbeat (poll #${pollCount}) — ${snapshot}`);
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
