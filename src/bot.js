const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
  Events,
} = require('discord.js');
const { DISCORD_BOT_TOKEN, HOME_CHANNEL_ID, SOURCES } = require('./config');
const { saveState } = require('./state');
const { getChatReply, clearHistory } = require('./chat');

const DISCORD_MESSAGE_LIMIT = 2000;

// Splits on the nearest preceding newline so replies don't get cut mid-word;
// falls back to a hard cut only if a single line exceeds the limit.
function chunkMessage(text, limit = DISCORD_MESSAGE_LIMIT) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  chunks.push(remaining);

  return chunks;
}

const MAX_OPTIONS_PER_MENU = 25;

function buildSelectMenu(source, state) {
  const games = Object.entries(state.games)
    .filter(([, game]) => game.source === source.key)
    .slice(0, MAX_OPTIONS_PER_MENU);

  if (games.length === 0) return null;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`watch:${source.key}`)
    .setPlaceholder(`Watch ${source.label} games...`)
    .setMinValues(0)
    .setMaxValues(games.length)
    .addOptions(
      games.map(([key, game]) => ({
        label: game.label,
        description: `${game.tokens} token(s) available`,
        value: key,
      }))
    );

  return new ActionRowBuilder().addComponents(menu);
}

function buildAllRows(state) {
  return SOURCES.map((source) => buildSelectMenu(source, state)).filter(Boolean);
}

// Posts (or edits, if it already exists) one message per source containing
// that source's select menu. Selecting an option is a full replace of the
// user's watch list for that source's games, not an incremental toggle -
// Discord doesn't let a shared component show a different "already selected"
// state per viewer, so "submit = your complete choice" is the only
// unambiguous interpretation for a multi-user dropdown.
async function postOrUpdateWatchMessages(client, state) {
  const channel = await client.channels.fetch(HOME_CHANNEL_ID);

  for (const source of SOURCES) {
    const row = buildSelectMenu(source, state);
    if (!row) continue;

    const content = `**${source.label}** - select the games you want available-alerts for.`;
    const stored = state.messages[source.key];

    if (stored) {
      try {
        const message = await channel.messages.fetch(stored.messageId);
        await message.edit({ content, components: [row] });
        continue;
      } catch {
        // Message was deleted - fall through and post a new one.
      }
    }

    const message = await channel.send({ content, components: [row] });
    state.messages[source.key] = { messageId: message.id };
  }
}

async function announceAvailable(client, becameAvailable, state) {
  if (becameAvailable.length === 0) return;
  const channel = await client.channels.fetch(HOME_CHANNEL_ID);

  for (const { key, label, tokens } of becameAvailable) {
    const watcherIds = state.watchers[key] || [];
    if (watcherIds.length === 0) continue;

    const mentions = watcherIds.map((id) => `<@${id}>`).join(' ');
    await channel.send(`${mentions} "${label}" has ${tokens} token(s) available now!`);
  }
}

// "good boy"/"good bot" when the bot is @mentioned doesn't need the
// privileged Message Content intent - Discord exempts messages that mention
// the app from that requirement, so GuildMessages alone is enough.
const GOOD_BOY_PATTERN = /\bgood\s*(boy|bot)\b/i;

// Per-channel chat controls, in-memory only - resets on restart, same as the
// chat history in src/chat.js. Requiring an @mention for these (unlike
// general chat, which needs none) keeps normal conversation from accidentally
// tripping a control phrase.
const chatSettings = new Map();

function getChatSettings(channelId) {
  if (!chatSettings.has(channelId)) chatSettings.set(channelId, { muted: false, restrictedTo: null });
  return chatSettings.get(channelId);
}

const MUTE_PATTERN = /\b(shut\s*up|be\s*quiet|stop\s*talking|stop\s*replying)\b/i;
const UNMUTE_PATTERN = /\b(unmute|you\s*can\s*talk|start\s*talking|start\s*replying|talk\s*again)\b/i;
const RESTRICT_PATTERN = /\bonly\s*(reply|talk|respond)\s*to\b/i;
const UNRESTRICT_PATTERN = /\b(reply\s*to\s*everyone|talk\s*to\s*everyone|unfocus|stop\s*only\s*replying)\b/i;

// One handler for all message-driven features, so a message that happens to
// match more than one (e.g. mentions the bot AND says "good boy") only gets
// one reply instead of double-replying.
function registerMessageHandler(client) {
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const mentionsBot = message.mentions.has(client.user);

    if (mentionsBot && GOOD_BOY_PATTERN.test(message.content)) {
      await message.reply('woof woof');
      return;
    }

    if (message.channelId !== HOME_CHANNEL_ID) return;

    const settings = getChatSettings(message.channelId);

    if (MUTE_PATTERN.test(message.content)) {
      settings.muted = true;
      await message.reply('Going quiet in here - say the word when you want me back.');
      return;
    }

    if (UNMUTE_PATTERN.test(message.content)) {
      settings.muted = false;
      await message.reply("Back online.");
      return;
    }

    if (RESTRICT_PATTERN.test(message.content)) {
      const target = message.mentions.users.find((user) => user.id !== client.user.id);
      if (!target) {
        await message.reply('Tag the person you want me to reply to, e.g. "only reply to @someone".');
        return;
      }
      settings.restrictedTo = target.id;
      await message.reply(`Got it - only replying to ${target} until told otherwise.`);
      return;
    }

    if (UNRESTRICT_PATTERN.test(message.content)) {
      settings.restrictedTo = null;
      await message.reply('Replying to everyone again.');
      return;
    }

    if (settings.muted) return;
    if (settings.restrictedTo && message.author.id !== settings.restrictedTo) return;

    // Message tags a real person other than the bot - it's directed at them,
    // not at the bot, so stay out of it.
    const mentionsSomeoneElse = message.mentions.users.some((user) => user.id !== client.user.id);
    if (mentionsSomeoneElse) return;

    await message.channel.sendTyping();
    const reply = await getChatReply(message.channelId, message.author.username, message.content);
    if (!reply) return;

    const chunks = chunkMessage(reply);
    await message.reply(chunks[0]);
    for (const chunk of chunks.slice(1)) {
      await message.channel.send(chunk);
    }
  });
}

function registerInteractionHandler(client, state) {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'watch') {
      const rows = buildAllRows(state);
      if (rows.length === 0) {
        await interaction.reply({
          content: 'No games known yet - check back after the next scrape.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content: 'Select the games you want available-alerts for (visible only to you).',
        components: rows,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'forget') {
      clearHistory(interaction.channelId);
      await interaction.reply({
        content: "Forgot the chat history in this channel - starting fresh.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.isStringSelectMenu()) return;
    if (!interaction.customId.startsWith('watch:')) return;

    const sourceKey = interaction.customId.slice('watch:'.length);
    const selected = new Set(interaction.values);
    const userId = interaction.user.id;

    const sourceGameKeys = Object.keys(state.games).filter(
      (key) => state.games[key].source === sourceKey
    );

    const added = [];
    const removed = [];

    for (const key of sourceGameKeys) {
      const watchers = state.watchers[key] || [];
      const wasWatching = watchers.includes(userId);
      const isWatching = selected.has(key);

      if (isWatching && !wasWatching) {
        state.watchers[key] = [...watchers, userId];
        added.push(state.games[key].label);
      } else if (!isWatching && wasWatching) {
        state.watchers[key] = watchers.filter((id) => id !== userId);
        removed.push(state.games[key].label);
      }
    }

    saveState(state);

    const parts = [];
    if (added.length) parts.push(`Now watching: ${added.join(', ')}`);
    if (removed.length) parts.push(`Stopped watching: ${removed.join(', ')}`);

    await interaction.reply({
      content: parts.length ? parts.join('\n') : 'No changes.',
      flags: MessageFlags.Ephemeral,
    });
  });
}

// Guild-scoped (not global) so they're available immediately after startup
// instead of waiting up to an hour for Discord's global command propagation.
async function registerSlashCommands(client) {
  const channel = await client.channels.fetch(HOME_CHANNEL_ID);
  const guildId = channel.guildId;

  await client.application.commands.create(
    { name: 'watch', description: 'Show the game-token watch dropdowns privately, just for you' },
    guildId
  );
  await client.application.commands.create(
    { name: 'forget', description: "Clear this channel's chat history with the bot" },
    guildId
  );
}

async function startBot(state) {
  if (!DISCORD_BOT_TOKEN) {
    throw new Error('Missing DISCORD_BOT_TOKEN.');
  }
  if (!HOME_CHANNEL_ID) {
    throw new Error('Missing HOME_CHANNEL_ID.');
  }

  // MessageContent is privileged - must also be toggled on for this bot in the
  // Discord Developer Portal (Bot tab -> "Message Content Intent"), since the
  // chat feature reads message.content on every message in HOME_CHANNEL_ID,
  // not just ones that @mention the bot (which would be exempt on their own).
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  registerInteractionHandler(client, state);
  registerMessageHandler(client);

  await client.login(DISCORD_BOT_TOKEN);
  await new Promise((resolve) => client.once(Events.ClientReady, resolve));
  console.log(`Bot logged in as ${client.user.tag}`);

  await registerSlashCommands(client);

  return client;
}

module.exports = { startBot, postOrUpdateWatchMessages, announceAvailable };
