const fs = require('fs');
const { chromium } = require('playwright');
const {
  SOURCE_SERVER_GUILD_ID,
  SOURCES,
  EMAIL,
  PASSWORD,
  STORAGE_STATE_PATH,
  IS_RENDER,
  HEADLESS,
} = require('./config');
const { gameKey } = require('./state');

let page;

// Assumes option text like "Far Cry 6 - 3 tokens available". If a source's
// dropdown formats things differently this'll just fall back to the full
// text as the label with 0 tokens - check the logs if a source looks stuck.
const TOKEN_PATTERN = /^(.*?)\s*[-–—]?\s*(\d+)\s*tokens?\s*available/i;

async function initScraper() {
  if (!EMAIL || !PASSWORD) {
    throw new Error('Missing DISCORD_EMAIL / DISCORD_PASSWORD for the scraper account.');
  }

  const hasSavedSession = fs.existsSync(STORAGE_STATE_PATH);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: IS_RENDER ? ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'] : [],
  });
  const context = await browser.newContext(
    hasSavedSession
      ? { storageState: STORAGE_STATE_PATH, viewport: { width: 1280, height: 800 } }
      : { viewport: { width: 1280, height: 800 } }
  );
  page = await context.newPage();

  await page.goto('https://discord.com/login');

  const REDIRECT_OR_FORM_TIMEOUT = 20000;
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

  if (outcome === 'needs_login') {
    console.log('Logging in...');
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3000);

    if (!page.url().includes('/channels/')) {
      console.log('Additional verification required (2FA/CAPTCHA). Waiting up to 2 minutes...');
      await page.waitForURL('**/channels/**', { timeout: 120000 });
    }

    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(`Session saved to ${STORAGE_STATE_PATH}`);
  } else if (outcome === 'already_logged_in') {
    console.log('Already logged in via saved session.');
  } else {
    throw new Error(
      `Timed out waiting for either a redirect or the login form. Current URL: ${page.url()}`
    );
  }
}

// Scrapes every configured source once, updating state.games in place and
// returning the games that just transitioned unavailable -> available.
async function scrapeOnce(state) {
  const becameAvailable = [];

  for (const source of SOURCES) {
    if (source.channelId.startsWith('TODO_')) {
      console.log(`Skipping source "${source.label}" - channelId not configured yet.`);
      continue;
    }

    try {
      await page.goto(`https://discord.com/channels/${SOURCE_SERVER_GUILD_ID}/${source.channelId}`);
      await page.waitForTimeout(1500);

      await page.getByRole('button', { name: source.dropdownName }).click();
      await page.waitForTimeout(2000);

      const options = await page.getByRole('option').all();
      if (options.length === 0) {
        console.log(`No options found for source "${source.label}" this cycle - leaving its state untouched.`);
        continue;
      }
      if (options.length > 25) {
        console.log(
          `Source "${source.label}" has ${options.length} games - Discord select menus cap at 25, the rest will be dropped from the dropdown.`
        );
      }

      for (const option of options) {
        const text = await option.innerText();
        const match = text.match(TOKEN_PATTERN);
        const label = (match ? match[1] : text).trim();
        const tokens = match ? parseInt(match[2], 10) : 0;

        const key = gameKey(source.key, label);
        const game = state.games[key] || {
          label,
          source: source.key,
          tokens: 0,
          wasAvailable: false,
          count: 0,
        };

        if (tokens > 0 && !game.wasAvailable) {
          game.count += 1;
          game.wasAvailable = true;
          becameAvailable.push({ key, label, source: source.key, tokens });
        } else if (tokens === 0 && game.wasAvailable) {
          game.wasAvailable = false;
        }
        game.tokens = tokens;
        state.games[key] = game;
      }
    } catch (err) {
      console.error(`Error scraping source "${source.label}":`, err.message);
    }
  }

  return becameAvailable;
}

module.exports = { initScraper, scrapeOnce };
