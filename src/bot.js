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

function registerInteractionHandler(client, state) {
  client.on(Events.InteractionCreate, async (interaction) => {
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

async function startBot(state) {
  if (!DISCORD_BOT_TOKEN) {
    throw new Error('Missing DISCORD_BOT_TOKEN.');
  }
  if (!HOME_CHANNEL_ID) {
    throw new Error('Missing HOME_CHANNEL_ID.');
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  registerInteractionHandler(client, state);

  await client.login(DISCORD_BOT_TOKEN);
  await new Promise((resolve) => client.once(Events.ClientReady, resolve));
  console.log(`Bot logged in as ${client.user.tag}`);

  return client;
}

module.exports = { startBot, postOrUpdateWatchMessages, announceAvailable };
