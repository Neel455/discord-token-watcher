const fs = require('fs');
const path = require('path');
const { GROQ_API_KEY, GROQ_MODEL } = require('./config');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// How many prior turns (user + assistant messages combined) to keep per
// channel as conversation context. Resets on process restart - no need to
// persist this to disk for a "fun chat" feature.
const HISTORY_LIMIT = 20;

// Edit this file to change the bot's personality - no restart needed, it's
// re-read on every reply.
const PERSONA_PATH = path.join(__dirname, '..', 'personality.txt');
const DEFAULT_PERSONA = 'You are a helpful, friendly Discord bot.';

// Explains the "Name: message" formatting (see userContent below) so the
// model doesn't mimic it back or start speaking as other users - not part of
// the user-editable persona.txt since it's plumbing, not personality.
const FORMAT_NOTE =
  '\n\nUser messages are prefixed with the speaker\'s Discord name, like ' +
  '"SomeUser: message text" - that\'s just so you can tell who\'s talking in ' +
  'a shared channel. Reply as plain text with no name prefix of your own, and ' +
  "don't roleplay or speak as other users.";

function loadSystemPrompt() {
  try {
    const persona = fs.readFileSync(PERSONA_PATH, 'utf8').trim();
    return (persona || DEFAULT_PERSONA) + FORMAT_NOTE;
  } catch {
    return DEFAULT_PERSONA + FORMAT_NOTE;
  }
}

const histories = new Map();

function getHistory(channelId) {
  if (!histories.has(channelId)) histories.set(channelId, []);
  return histories.get(channelId);
}

function pushToHistory(channelId, userContent, assistantContent) {
  const history = getHistory(channelId);
  history.push({ role: 'user', content: userContent });
  history.push({ role: 'assistant', content: assistantContent });
  while (history.length > HISTORY_LIMIT) history.shift();
}

// Returns the reply text, or null if chat isn't configured / the call failed.
async function getChatReply(channelId, authorName, messageText) {
  if (!GROQ_API_KEY) {
    console.error('Missing GROQ_API_KEY - cannot generate a chat reply.');
    return null;
  }

  const userContent = `${authorName}: ${messageText}`;
  const messages = [
    { role: 'system', content: loadSystemPrompt() },
    ...getHistory(channelId),
    { role: 'user', content: userContent },
  ];

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages }),
    });

    if (!response.ok) {
      console.error(`Groq API error: ${response.status} ${await response.text()}`);
      return null;
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return null;

    pushToHistory(channelId, userContent, reply);
    return reply;
  } catch (err) {
    console.error('Failed to get chat reply from Groq:', err.message);
    return null;
  }
}

module.exports = { getChatReply };
