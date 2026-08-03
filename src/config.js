const path = require('path');

// "The Free Pub" - the server being scraped for token availability. You're a
// regular member there (no Manage Server), so this can only ever be read via
// account automation (Playwright), never a real bot invited into that server.
const SOURCE_SERVER_GUILD_ID = '1310909523715690536';

// One entry per channel/dropdown to scrape. Fill in the real channelId
// (Discord Developer Mode -> right-click channel -> Copy Channel ID) and
// double check dropdownName against that channel's actual button text - it's
// a guess based on the Ubisoft one this project started with.
const SOURCES = [
  { key: 'ubisoft', label: 'Ubisoft', channelId: '1449749992708509706', dropdownName: 'Select a Ubisoft game...' },
  { key: 'steam', label: 'Steam', channelId: 'TODO_STEAM_CHANNEL_ID', dropdownName: 'Select a Steam game...' },
  { key: 'ea', label: 'EA', channelId: '1478352818040737902', dropdownName: 'Select an EA game...' },
];

// Your own server: the real bot lives here and posts the watch dropdowns +
// availability pings into this channel.
const HOME_CHANNEL_ID = process.env.HOME_CHANNEL_ID;

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

// Scraper account credentials (unchanged from the original watcher).
const EMAIL = process.env.DISCORD_EMAIL;
const PASSWORD = process.env.DISCORD_PASSWORD;

const STORAGE_STATE_PATH = path.join(__dirname, '..', 'discord_auth_state.json');
const STATE_PATH = path.join(__dirname, '..', 'state.json');

const IS_RENDER = !!process.env.RENDER;
const HEADLESS = process.env.HEADLESS === 'true';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3 * 60 * 1000;

// Optional extra global alert channels, unrelated to per-user watch pings -
// fire on every availability transition regardless of who's watching.
const WHATSAPP_PHONE = process.env.WHATSAPP_PHONE;
const WHATSAPP_APIKEY = process.env.WHATSAPP_APIKEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Groq (free tier, no card required) powers general chat in HOME_CHANNEL_ID.
// Get a key at console.groq.com. llama-3.1-8b-instant is Groq's cheapest/
// fastest model with a much higher free daily token quota than the 70B
// models - plenty for casual chat, and far less likely to hit the daily cap.
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

module.exports = {
  SOURCE_SERVER_GUILD_ID,
  SOURCES,
  HOME_CHANNEL_ID,
  DISCORD_BOT_TOKEN,
  EMAIL,
  PASSWORD,
  STORAGE_STATE_PATH,
  STATE_PATH,
  IS_RENDER,
  HEADLESS,
  POLL_INTERVAL_MS,
  WHATSAPP_PHONE,
  WHATSAPP_APIKEY,
  DISCORD_WEBHOOK_URL,
  GROQ_API_KEY,
  GROQ_MODEL,
};
