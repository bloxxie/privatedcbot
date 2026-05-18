require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const {
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionsBitField,
  SlashCommandBuilder,
} = require('discord.js');

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API || process.env.API;
const DATA_FILE = path.join(__dirname, 'word-data.json');
const PROMPT_FILE = path.join(__dirname, 'prompt.txt');
const TRACKED_WORDS = ['nigga', 'nigger'];
const WORD_LABELS = {
  nigga: 'Soft N',
  nigger: 'Hard R',
};
const SAVE_THROTTLE_MS = 750;
const DAY_MS = 24 * 60 * 60 * 1000;
const PREFIX = 'n';
const AI_CHAT_CHANNEL_ID = '1279882002333569206';
const DAILY_STREAK_REMINDER_CHANNEL_ID = '1262414415790080131';
const DAILY_STREAK_REMINDER_HOUR_GMT7 = 23;
const DAILY_STREAK_REMINDER_MINUTE_GMT7 = 0;
const AI_SYSTEM_PROMPT = loadSystemPrompt();
const AI_MODEL = process.env.OPENROUTER_MODEL || 'z-ai/glm-4.5-air:free';
const AI_MAX_TOKENS = 1000;
const AI_SUMMARY_MAX_TOKENS = 300;
const AI_RECENT_MEMORY_LIMIT = 10;
const AI_SUMMARY_MEMORY_LIMIT = 10;
const AI_EMPTY_RESPONSE_RETRIES = 1;
const AI_REASONING = {
  effort: 'none',
  exclude: true,
};
const DISCORD_MESSAGE_LIMIT = 2000;
const FACEBOOK_FIX_HOST = process.env.FACEBOOK_FIX_HOST || 'fixacebook.com';
const FACEBOOK_EMBED_CHECK_DELAY_MS = 12_000;
const SCRAM_ALLOWED_USER_IDS = (process.env.SCRAM_ALLOWED_USER_IDS || '')
  .split(',')
  .map((userId) => userId.trim())
  .filter(Boolean);
const SCRAM_WRONG_GUESSES_PER_HINT = 3;
const SCRAM_MIN_WORD_LENGTH = 2;
const SCRAM_MAX_WORD_LENGTH = 30;
const SCRAM_MIN_DIFFICULTY = 1;
const SCRAM_MAX_DIFFICULTY = 10;
const SCRAM_GRID_COLUMNS = 10;
const SCRAM_MIN_GRID_LETTERS = 10;
const SCRAM_DEFAULT_LETTERBANK_SIZE = 20;
const SCRAM_MAX_LETTERBANK_SIZE = 100;
const SCRAM_COMMAND_ACK_DELETE_MS = 2_000;
const WORD_COLLAGE_THREAD_ID = '1501594716943159308';
const WORD_COLLAGE_SESSION_MS = 5 * 60 * 1000;
const WORD_COLLAGE_IMAGE_COUNT = 4;
const WORD_COLLAGE_SIZE = 1080;
const WORD_COLLAGE_BACKGROUNDS = [
  '#78db57',
  '#4fd1c5',
  '#f59e0b',
  '#f472b6',
  '#60a5fa',
  '#a3e635',
];
const WORD_COLLAGE_GRADIENTS = [
  ['#78db57', '#4fd1c5'],
  ['#f97316', '#facc15'],
  ['#60a5fa', '#f472b6'],
  ['#a3e635', '#22c55e'],
  ['#f43f5e', '#fb7185'],
];
const WORD_COLLAGE_TILE_SIZE = 492;
const WORD_COLLAGE_TILE_RADIUS = 38;
const WORD_COLLAGE_TILE_BORDER = 7;
const WORD_COLLAGE_TILE_SHADOW_OFFSET = 9;
const WORD_COLLAGE_TILE_POSITIONS = [
  { left: 31, top: 31 },
  { left: 556, top: 31 },
  { left: 31, top: 556 },
  { left: 556, top: 556 },
];
const SIX_SEVEN_RESPONSE = 'DID SOMEONE SAY 67??!?!?';
const SIX_SEVEN_PATTERNS = [
  /\b67\b/i,
  /\b6\s*(?:[*x×]|times|by|and)?\s*7\b/i,
  /\bsix\s*(?:[*x×]|times|by|and)?\s*seven\b/i,
  /\bsixty[-\s]?seven\b/i,
  /\broku[-\s]?nana\b/i,
];
const runtimeStats = {
  liveMessagesSeen: 0,
  liveMessagesWithContent: 0,
  liveScoringMessages: 0,
  lastLiveMessageAt: null,
  lastLiveContentAt: null,
  lastLiveScoreAt: null,
  lastLiveScore: null,
};

if (!TOKEN) {
  console.error('Missing TOKEN in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const commands = [
  new SlashCommandBuilder()
    .setName('nranked')
    .setDescription('Show the top 5 leaderboard for both tracked words.'),
  new SlashCommandBuilder()
    .setName('nuser')
    .setDescription('Show word stats and ranks for a user.')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to check. Defaults to yourself.')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('nsync')
    .setDescription('Scan message history for tracked words.'),
  new SlashCommandBuilder()
    .setName('nping')
    .setDescription('Check if the bot is online.'),
  new SlashCommandBuilder()
    .setName('ndebug')
    .setDescription('Show live counting diagnostics.'),
  new SlashCommandBuilder()
    .setName('nwhitelist')
    .setDescription('Add, remove, list, or clear channels used by sync.')
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('What to do. No action adds the current channel.')
        .setRequired(false)
        .addChoices(
          { name: 'add', value: 'add' },
          { name: 'remove', value: 'remove' },
          { name: 'list', value: 'list' },
          { name: 'clear', value: 'clear' },
        ),
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Target channel. Defaults to the current channel.')
        .setRequired(false)
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
          ChannelType.AnnouncementThread,
        ),
    ),
  new SlashCommandBuilder()
    .setName('nsettings')
    .setDescription('Show word counter settings for this server.'),
  new SlashCommandBuilder()
    .setName('nscram')
    .setDescription('Queue an image word scramble game.')
    .addStringOption((option) =>
      option
        .setName('word')
        .setDescription('The word people need to guess.')
        .setRequired(true),
    )
    .addAttachmentOption((option) =>
      option
        .setName('image')
        .setDescription('Edited puzzle image.')
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('difficulty')
        .setDescription('Difficulty rating from 1 to 10.')
        .setMinValue(SCRAM_MIN_DIFFICULTY)
        .setMaxValue(SCRAM_MAX_DIFFICULTY)
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('letterbank')
        .setDescription('Total letters to show in the letter bank. Defaults to 20.')
        .setMinValue(SCRAM_MIN_GRID_LETTERS)
        .setMaxValue(SCRAM_MAX_LETTERBANK_SIZE)
        .setRequired(false),
    ),
].map((command) => command.toJSON());

const globalCommands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if the bot is online.'),
].map((command) => command.toJSON());

let data = loadData();
let saveTimer = null;
const activeSyncs = new Set();
const wordCollageSessions = new Map();
const scramGames = new Map();
const scramQueues = new Map();
const scramActiveThreadsByChannel = new Map();

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerGlobalCommands();
  await registerGuildCommands();
  startDailyStreakReminder();
});

client.on('guildCreate', async (guild) => {
  await registerCommandsForGuild(guild);
});

client.on('messageCreate', async (message) => {
  if (!message.guildId || message.author?.bot) return;

  runtimeStats.liveMessagesSeen += 1;
  runtimeStats.lastLiveMessageAt = new Date().toISOString();
  if (message.content) {
    runtimeStats.liveMessagesWithContent += 1;
    runtimeStats.lastLiveContentAt = runtimeStats.lastLiveMessageAt;
  }

  const counted = recordMessage(message);
  if (counted) {
    await maybeSendStreakUpdate(message);
  }

  if (await handleWordCollageImageMessage(message)) {
    return;
  }

  if (await handleScramGuess(message)) {
    return;
  }

  await maybeSendSixSevenCallout(message);

  const handledPrefixCommand = await handlePrefixCommand(message);
  if (!handledPrefixCommand) {
    const fixedFacebookEmbed = await handleFacebookEmbedFix(message);
    if (fixedFacebookEmbed) return;

    await handleAiChat(message);
  }
});

client.on('messageDelete', async (message) => {
  if (!message.guildId) return;
  removeMessageRecord(message.guildId, message.id);
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
  if (!message?.guildId || message.author?.bot) return;

  const removed = removeMessageRecord(message.guildId, message.id, false);
  const added = recordMessage(message);

  if (removed && !added) {
    queueSave();
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'ping') {
      await interaction.reply('Pong.');
      return;
    }

    if (!interaction.guildId) {
      await interaction.reply({ content: 'That command only works in a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === 'nranked') {
      await handleRanked(interaction);
      return;
    }

    if (interaction.commandName === 'nuser') {
      await handleUser(interaction);
      return;
    }

    if (interaction.commandName === 'nsync') {
      await handleSync(interaction);
      return;
    }

    if (interaction.commandName === 'nping') {
      await interaction.reply('Pong.');
      return;
    }

    if (interaction.commandName === 'ndebug') {
      await interaction.reply(buildDebugText(interaction.guildId));
      return;
    }

    if (interaction.commandName === 'nwhitelist') {
      await handleWhitelist(interaction);
      return;
    }

    if (interaction.commandName === 'nsettings') {
      await handleSettings(interaction);
      return;
    }

    if (interaction.commandName === 'nscram') {
      await handleScramStart(interaction);
    }
  } catch (error) {
    console.error(error);
    const content = 'Something went wrong while running that command.';

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { guilds: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { guilds: {} };
  } catch (error) {
    console.error('Could not read word-data.json. Starting with empty data.', error);
    return { guilds: {} };
  }
}

function loadSystemPrompt() {
  if (!fs.existsSync(PROMPT_FILE)) {
    console.warn('prompt.txt not found. AI chat will use an empty system prompt.');
    return '';
  }

  try {
    return fs.readFileSync(PROMPT_FILE, 'utf8').trim();
  } catch (error) {
    console.error('Could not read prompt.txt. AI chat will use an empty system prompt.', error);
    return '';
  }
}

function queueSave() {
  if (saveTimer) return;

  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveData();
  }, SAVE_THROTTLE_MS);
}

function saveData() {
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

function ensureGuild(guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      whitelist: [],
      counts: {
        nigga: {},
        nigger: {},
      },
      messages: {},
      streaks: {},
      dailyStreakReminder: {
        lastDate: null,
      },
      aiMemory: {
        users: {},
      },
      sync: {
        channels: {},
      },
    };
  }

  const guildData = data.guilds[guildId];
  guildData.whitelist ??= [];
  guildData.counts ??= {};
  guildData.counts.nigga ??= {};
  guildData.counts.nigger ??= {};
  guildData.messages ??= {};
  guildData.streaks ??= {};
  guildData.dailyStreakReminder ??= {};
  guildData.dailyStreakReminder.lastDate ??= null;
  guildData.aiMemory ??= {};
  guildData.aiMemory.users ??= {};
  guildData.sync ??= {};
  guildData.sync.channels ??= {};
  return guildData;
}

function countTrackedWords(content) {
  const result = {};

  for (const word of TRACKED_WORDS) {
    const pattern = new RegExp(`\\b${word}\\b`, 'gi');
    const matches = content.match(pattern);
    if (matches?.length) {
      result[word] = matches.length;
    }
  }

  return result;
}

function sumCounts(counts) {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

function addCount(guildData, userId, word, amount) {
  guildData.counts[word][userId] = Math.max(0, (guildData.counts[word][userId] || 0) + amount);

  if (guildData.counts[word][userId] === 0) {
    delete guildData.counts[word][userId];
  }
}

function recordMessage(message, options = {}) {
  const { save = true, source = 'live' } = options;
  const guildData = ensureGuild(message.guildId);

  if (guildData.messages[message.id]) {
    return false;
  }

  const counts = countTrackedWords(message.content || '');
  if (sumCounts(counts) === 0) {
    return false;
  }

  for (const [word, amount] of Object.entries(counts)) {
    addCount(guildData, message.author.id, word, amount);
  }

  guildData.messages[message.id] = {
    authorId: message.author.id,
    channelId: message.channelId,
    counts,
  };

  if (save) queueSave();
  if (source === 'live') {
    runtimeStats.liveScoringMessages += 1;
    runtimeStats.lastLiveScoreAt = new Date().toISOString();
    runtimeStats.lastLiveScore = {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      counts,
    };
    console.log(`Live count: user=${message.author.id} channel=${message.channelId} counts=${JSON.stringify(counts)}`);
  }
  return true;
}

function shouldTrackChannel(guildId, channelId) {
  const guildData = ensureGuild(guildId);
  return guildData.whitelist.length === 0 || guildData.whitelist.includes(channelId);
}

function ensureChannelSyncState(guildData, channelId) {
  guildData.sync ??= {};
  guildData.sync.channels ??= {};
  guildData.sync.channels[channelId] ??= {};
  return guildData.sync.channels[channelId];
}

function compareSnowflakes(a, b) {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function getNewestMessageId(messages, currentNewestId = null) {
  let newestId = currentNewestId;

  for (const message of messages.values()) {
    if (!newestId || compareSnowflakes(message.id, newestId) > 0) {
      newestId = message.id;
    }
  }

  return newestId;
}

function sortOldestFirst(messages) {
  return [...messages.values()].sort((a, b) => compareSnowflakes(a.id, b.id));
}

function getGmt7DateKey(date = new Date()) {
  return new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getUserStreak(guildId, userId) {
  const guildData = ensureGuild(guildId);
  guildData.streaks[userId] ??= {
    current: 0,
    best: 0,
    lastDate: null,
  };
  return guildData.streaks[userId];
}

function updateDailyStreak(guildId, userId) {
  const streak = getUserStreak(guildId, userId);
  const today = getGmt7DateKey();
  const yesterday = getGmt7DateKey(new Date(Date.now() - DAY_MS));

  if (streak.lastDate === today) {
    return null;
  }

  streak.current = streak.lastDate === yesterday ? streak.current + 1 : 1;
  streak.best = Math.max(streak.best || 0, streak.current);
  streak.lastDate = today;
  queueSave();
  return streak.current;
}

async function maybeSendStreakUpdate(message) {
  const streak = updateDailyStreak(message.guildId, message.author.id);
  if (!streak) return;

  await message.reply({
    content: `your daily streak: ${streak.toLocaleString()}`,
    allowedMentions: { repliedUser: true },
  }).catch((error) => {
    console.error('Could not send streak update:', error.message);
  });
}

async function maybeSendSixSevenCallout(message) {
  if (!isSixSevenMessage(message.content || '')) return;

  await message.channel.send(SIX_SEVEN_RESPONSE).catch((error) => {
    console.error('Could not send 67 callout:', error.message);
  });
}

function isSixSevenMessage(content) {
  return SIX_SEVEN_PATTERNS.some((pattern) => pattern.test(content));
}

async function handleScramStart(interaction) {
  if (!isScramAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: SCRAM_ALLOWED_USER_IDS.length
        ? 'You are not allowed to start scramble games.'
        : 'SCRAM_ALLOWED_USER_IDS is not configured.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isScramParentChannel(interaction.channel)) {
    await interaction.reply({
      content: 'This command only works in a text or announcement channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const missingPermissions = await getMissingScramPermissions(interaction);
  if (missingPermissions.length) {
    await interaction.reply({
      content: `I cannot start scramble games here. Missing permission(s): ${missingPermissions.join(', ')}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const rawWord = interaction.options.getString('word', true);
  const answer = normalizeScramAnswer(rawWord);
  if (answer.length < SCRAM_MIN_WORD_LENGTH || answer.length > SCRAM_MAX_WORD_LENGTH) {
    await interaction.reply({
      content: `Use a word from ${SCRAM_MIN_WORD_LENGTH}-${SCRAM_MAX_WORD_LENGTH} letters/numbers.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const imageUrl = getScramImageUrl(interaction);
  if (!imageUrl) {
    await interaction.reply({
      content: 'Attach one normal image file.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const letterBankSize = interaction.options.getInteger('letterbank') || SCRAM_DEFAULT_LETTERBANK_SIZE;
  const difficulty = interaction.options.getInteger('difficulty', true);
  const puzzle = {
    parentChannelId: interaction.channelId,
    answer,
    displayWord: answer.toUpperCase(),
    imageUrl,
    difficulty,
    letterBankSize,
  };
  const queue = getScramQueue(interaction.channelId);
  const wasIdle = !scramActiveThreadsByChannel.has(interaction.channelId) && queue.length === 0;

  queue.push(puzzle);

  await interaction.reply({
    content: wasIdle
      ? 'Starting scramble puzzle.'
      : `Queued scramble puzzle. Queue size: ${queue.length}.`,
    flags: MessageFlags.Ephemeral,
  });

  if (wasIdle) {
    await startNextScramPuzzle(interaction.channel);
  }

  scheduleInteractionReplyDelete(interaction);
}

async function startNextScramPuzzle(channel) {
  if (!channel || scramActiveThreadsByChannel.has(channel.id)) return;

  const queue = getScramQueue(channel.id);
  const puzzle = queue.shift();
  if (!puzzle) return;

  const game = {
    ...puzzle,
    revealedIndexes: new Set([0]),
    nextHintFromEnd: true,
    wrongGuesses: 0,
    gridLetters: buildScramGridLetters(puzzle.answer, puzzle.letterBankSize),
    message: null,
    puzzleMessage: null,
    thread: null,
  };

  const gameMessage = await channel.send({
    content: `Difficulty ${game.difficulty}/10`,
    embeds: [buildScramImageEmbed(game.imageUrl)],
    allowedMentions: { parse: [] },
  }).catch((error) => {
    console.error('Could not start scramble puzzle:', error.message);
    return null;
  });

  if (!gameMessage) return;

  const thread = await createScramThread(channel, gameMessage);

  if (!thread) {
    await gameMessage.edit({
      content: `Difficulty ${game.difficulty}/10\nCould not create the guess thread. Check bot thread permissions.`,
      embeds: [buildScramImageEmbed(game.imageUrl)],
    }).catch(() => {});
    return;
  }

  game.message = gameMessage;
  game.thread = thread;
  scramGames.set(thread.id, game);
  scramActiveThreadsByChannel.set(channel.id, thread.id);

  game.puzzleMessage = await thread.send({
    content: buildScramMessage(game),
    allowedMentions: { parse: [] },
  }).catch((error) => {
    console.error('Could not send scramble puzzle text:', error.message);
    return null;
  });
}

async function handleScramGuess(message) {
  const game = scramGames.get(message.channelId);
  if (!game) return false;

  const guess = getScramGuess(message.content);
  if (guess === null) return false;

  if (!guess) {
    await message.reply('Send one word with no spaces to guess.').catch(() => {});
    return true;
  }

  if (guess !== game.answer) {
    game.wrongGuesses += 1;
    await message.react('❌').catch((error) => {
      console.error('Could not react to wrong scramble guess:', error.message);
    });

    if (game.wrongGuesses % SCRAM_WRONG_GUESSES_PER_HINT === 0) {
      await revealNextScramHint(message.channel);
    } else {
      await game.puzzleMessage?.edit({
        content: buildScramMessage(game),
      }).catch((error) => {
        console.error('Could not edit scramble message:', error.message);
      });
    }

    return true;
  }

  clearScramGame(message.channelId);
  await message.channel.send({
    content: `Congrats <@${message.author.id}>! The word was **${game.displayWord}**.`,
    allowedMentions: { users: [message.author.id] },
  }).catch((error) => {
    console.error('Could not send scramble winner message:', error.message);
  });
  await game.puzzleMessage?.edit({
    content: `${buildScramMessage({ ...game, revealedIndexes: getAllScramIndexes(game.answer) })}\n\nSolved by <@${message.author.id}>.`,
  }).catch(() => {});
  await startNextScramPuzzle(getScramParentChannel(game));
  return true;
}

async function revealNextScramHint(channel) {
  const channelId = channel.id;
  const game = scramGames.get(channelId);
  if (!game) return;

  const nextHintIndex = getNextScramHintIndex(game);
  if (nextHintIndex !== null) {
    game.revealedIndexes.add(nextHintIndex);
  }

  if (game.revealedIndexes.size >= game.answer.length) {
    clearScramGame(channelId);
    await game.puzzleMessage?.edit({
      content: `${buildScramMessage(game)}\n\nOut of hints. The word was **${game.displayWord}**.`,
    }).catch(() => {});
    await startNextScramPuzzle(getScramParentChannel(game));
    return;
  }

  await game.puzzleMessage?.edit({
    content: buildScramMessage(game),
  }).catch((error) => {
    console.error('Could not edit scramble message:', error.message);
  });

  await channel.send({
    content: buildScramHintUpdateMessage(game),
    allowedMentions: { parse: [] },
  }).catch((error) => {
    console.error('Could not send scramble hint update:', error.message);
  });
}

function clearScramGame(channelId) {
  const game = scramGames.get(channelId);
  if (game?.parentChannelId) {
    scramActiveThreadsByChannel.delete(game.parentChannelId);
  }

  scramGames.delete(channelId);
}

function buildScramMessage(game) {
  const lines = [
    buildScramHintLine(game.displayWord, game.revealedIndexes),
    '',
    buildScramGrid(buildScramGridDisplayLetters(game)),
  ].join('\n');

  return `\`\`\`\n${lines}\n\`\`\``;
}

function buildScramHintUpdateMessage(game) {
  const lines = [
    buildScramHintLine(game.displayWord, game.revealedIndexes),
    '',
    buildScramGrid(buildScramGridDisplayLetters(game)),
  ].join('\n');

  return `\`\`\`\n${lines}\n\`\`\``;
}

function buildScramGridDisplayLetters(game) {
  const revealedLetters = new Set(
    [...game.revealedIndexes].map((index) => game.displayWord[index]),
  );

  return game.gridLetters.map((letter) =>
    revealedLetters.has(letter) ? '_' : letter,
  );
}

function buildScramHintLine(displayWord, revealedIndexes) {
  return displayWord
    .split('')
    .map((letter, index) => (revealedIndexes.has(index) ? letter : '_'))
    .join(' ');
}

function buildScramGrid(letters) {
  const rows = [];
  for (let index = 0; index < letters.length; index += SCRAM_GRID_COLUMNS) {
    rows.push(letters.slice(index, index + SCRAM_GRID_COLUMNS).join(' '));
  }

  return rows.join('\n');
}

function buildScramGridLetters(answer, letterBankSize = SCRAM_DEFAULT_LETTERBANK_SIZE) {
  const letters = answer.toUpperCase().split('');
  const requestedSize = Math.max(SCRAM_MIN_GRID_LETTERS, letterBankSize, letters.length);
  const gridSize = Math.ceil(requestedSize / SCRAM_GRID_COLUMNS) * SCRAM_GRID_COLUMNS;

  while (letters.length < gridSize) {
    letters.push(getRandomUppercaseLetter());
  }

  return shuffleArray(letters);
}

function getNextScramHintIndex(game) {
  const findIndex = game.nextHintFromEnd ? findLastHiddenScramIndex : findFirstHiddenScramIndex;
  const fallbackFindIndex = game.nextHintFromEnd ? findFirstHiddenScramIndex : findLastHiddenScramIndex;
  const index = findIndex(game);

  game.nextHintFromEnd = !game.nextHintFromEnd;
  return index ?? fallbackFindIndex(game);
}

function findFirstHiddenScramIndex(game) {
  for (let index = 0; index < game.answer.length; index += 1) {
    if (!game.revealedIndexes.has(index)) return index;
  }

  return null;
}

function findLastHiddenScramIndex(game) {
  for (let index = game.answer.length - 1; index >= 0; index -= 1) {
    if (!game.revealedIndexes.has(index)) return index;
  }

  return null;
}

function getAllScramIndexes(answer) {
  return new Set(answer.split('').map((_, index) => index));
}

function getScramQueue(channelId) {
  if (!scramQueues.has(channelId)) {
    scramQueues.set(channelId, []);
  }

  return scramQueues.get(channelId);
}

function getScramImageUrl(interaction) {
  const attachment = interaction.options.getAttachment('image', true);
  return isSupportedImageAttachment(attachment) ? attachment.url : null;
}

function buildScramImageEmbed(imageUrl) {
  return new EmbedBuilder()
    .setColor(0x3b82f6)
    .setImage(imageUrl);
}

async function createScramThread(channel, message) {
  const options = {
    name: 'Word scramble guesses',
    autoArchiveDuration: 60,
    reason: 'Word scramble guesses',
  };

  const thread = await message.startThread(options).catch((error) => {
    console.error('Could not create scramble thread from message:', error.message);
    return null;
  });
  if (thread) return thread;

  if (typeof channel.threads?.create !== 'function') return null;

  return channel.threads.create({
    ...options,
    startMessage: message.id,
  }).catch((error) => {
    console.error('Could not create scramble thread from channel:', error.message);
    return null;
  });
}

function getScramParentChannel(game) {
  return game.thread?.parent || game.message?.channel || null;
}

function scheduleInteractionReplyDelete(interaction) {
  setTimeout(() => {
    interaction.deleteReply().catch(() => {});
  }, SCRAM_COMMAND_ACK_DELETE_MS);
}

function getScramGuess(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  return normalizeScramAnswer(trimmed);
}

function getRandomUppercaseLetter() {
  return String.fromCharCode(65 + Math.floor(Math.random() * 26));
}

function shuffleArray(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

function normalizeScramAnswer(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isScramAllowedUser(userId) {
  return SCRAM_ALLOWED_USER_IDS.includes(userId);
}

async function getMissingScramPermissions(interaction) {
  const botMember = interaction.guild.members.me
    || await interaction.guild.members.fetchMe().catch(() => null);
  if (!botMember) return ['Read bot member permissions'];

  const permissions = interaction.channel.permissionsFor(botMember);
  if (!permissions) return ['View Channel'];

  return [
    [PermissionsBitField.Flags.ViewChannel, 'View Channel'],
    [PermissionsBitField.Flags.SendMessages, 'Send Messages'],
    [PermissionsBitField.Flags.EmbedLinks, 'Embed Links'],
    [PermissionsBitField.Flags.CreatePublicThreads, 'Create Public Threads'],
    [PermissionsBitField.Flags.SendMessagesInThreads, 'Send Messages in Threads'],
  ]
    .filter(([flag]) => !permissions.has(flag))
    .map(([, label]) => label);
}

function isScramParentChannel(channel) {
  return [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
  ].includes(channel?.type);
}

async function handleWordCollageStart(message) {
  if (message.channelId !== WORD_COLLAGE_THREAD_ID) {
    await message.reply(`This only works in <#${WORD_COLLAGE_THREAD_ID}>.`).catch(() => {});
    return;
  }

  const sessionKey = getWordCollageSessionKey(message);
  clearWordCollageSession(sessionKey);

  const session = {
    userId: message.author.id,
    channelId: message.channelId,
    imageUrls: [],
    timeout: setTimeout(() => {
      wordCollageSessions.delete(sessionKey);
    }, WORD_COLLAGE_SESSION_MS),
  };

  wordCollageSessions.set(sessionKey, session);

  await message.reply('Send 4 images.').catch((error) => {
    console.error('Could not start word collage session:', error.message);
  });
}

async function handleWordCollageImageMessage(message) {
  if (message.channelId !== WORD_COLLAGE_THREAD_ID) return false;

  const sessionKey = getWordCollageSessionKey(message);
  const session = wordCollageSessions.get(sessionKey);
  if (!session) return false;

  const imageUrls = getImageAttachmentUrls(message);
  if (!imageUrls.length) return false;

  session.imageUrls.push(...imageUrls);
  session.imageUrls = session.imageUrls.slice(0, WORD_COLLAGE_IMAGE_COUNT);

  if (session.imageUrls.length < WORD_COLLAGE_IMAGE_COUNT) {
    await message.reply(`Got ${session.imageUrls.length}/4 image(s).`).catch(() => {});
    return true;
  }

  clearWordCollageSession(sessionKey);

  await message.channel.sendTyping().catch(() => {});

  try {
    const collage = await buildWordCollage(session.imageUrls);
    await message.reply({
      files: [
        new AttachmentBuilder(collage, {
          name: 'nword-collage.png',
        }),
      ],
    });
  } catch (error) {
    console.error('Could not build word collage:', error.message);
    await message.reply('Could not make the image. Try sending 4 normal PNG/JPG/WebP images.').catch(() => {});
  }

  return true;
}

function getWordCollageSessionKey(message) {
  return `${message.channelId}:${message.author.id}`;
}

function clearWordCollageSession(sessionKey) {
  const session = wordCollageSessions.get(sessionKey);
  if (session?.timeout) clearTimeout(session.timeout);
  wordCollageSessions.delete(sessionKey);
}

function getImageAttachmentUrls(message) {
  return [...message.attachments.values()]
    .filter((attachment) => isSupportedImageAttachment(attachment))
    .map((attachment) => attachment.url);
}

function isSupportedImageAttachment(attachment) {
  return attachment.contentType?.startsWith('image/')
    || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(attachment.url);
}

async function buildWordCollage(imageUrls) {
  const composites = [];

  for (const [index, imageUrl] of imageUrls.entries()) {
    const position = WORD_COLLAGE_TILE_POSITIONS[index];
    const tile = await buildWordCollageTile(imageUrl);
    const shadow = await buildRoundedRectSvg(
      WORD_COLLAGE_TILE_SIZE,
      WORD_COLLAGE_TILE_SIZE,
      WORD_COLLAGE_TILE_RADIUS,
      '#000000',
    );

    composites.push({
      input: shadow,
      left: position.left + WORD_COLLAGE_TILE_SHADOW_OFFSET,
      top: position.top + WORD_COLLAGE_TILE_SHADOW_OFFSET,
    });
    composites.push({
      input: tile,
      left: position.left,
      top: position.top,
    });
  }

  const background = buildRandomWordCollageBackground();

  return sharp(background)
    .composite(composites)
    .png()
    .toBuffer();
}

function buildRandomWordCollageBackground() {
  if (Math.random() < 0.45) {
    const gradient = WORD_COLLAGE_GRADIENTS[Math.floor(Math.random() * WORD_COLLAGE_GRADIENTS.length)];
    return buildLinearGradientSvg(WORD_COLLAGE_SIZE, WORD_COLLAGE_SIZE, gradient[0], gradient[1]);
  }

  return {
    create: {
      width: WORD_COLLAGE_SIZE,
      height: WORD_COLLAGE_SIZE,
      channels: 4,
      background: WORD_COLLAGE_BACKGROUNDS[Math.floor(Math.random() * WORD_COLLAGE_BACKGROUNDS.length)],
    },
  };
}

async function buildWordCollageTile(imageUrl) {
  const image = await fetchImageBuffer(imageUrl);
  const innerSize = WORD_COLLAGE_TILE_SIZE - WORD_COLLAGE_TILE_BORDER * 2;
  const innerRadius = WORD_COLLAGE_TILE_RADIUS - WORD_COLLAGE_TILE_BORDER;
  const imageMask = await buildRoundedRectSvg(innerSize, innerSize, innerRadius, '#ffffff');
  const tileMask = await buildRoundedRectSvg(
    WORD_COLLAGE_TILE_SIZE,
    WORD_COLLAGE_TILE_SIZE,
    WORD_COLLAGE_TILE_RADIUS,
    '#ffffff',
  );
  const imageLayer = await sharp(image)
    .rotate()
    .resize(innerSize, innerSize, { fit: 'cover' })
    .composite([{ input: imageMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: WORD_COLLAGE_TILE_SIZE,
      height: WORD_COLLAGE_TILE_SIZE,
      channels: 4,
      background: '#000000',
    },
  })
    .composite([
      {
        input: imageLayer,
        left: WORD_COLLAGE_TILE_BORDER,
        top: WORD_COLLAGE_TILE_BORDER,
      },
      {
        input: tileMask,
        blend: 'dest-in',
      },
    ])
    .png()
    .toBuffer();
}

async function fetchImageBuffer(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Image download failed: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function buildRoundedRectSvg(width, height, radius, fill) {
  return Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="${fill}"/></svg>`,
  );
}

function buildLinearGradientSvg(width, height, startColor, endColor) {
  const horizontal = Math.random() < 0.5;
  const endX = horizontal ? '100%' : '0%';
  const endY = horizontal ? '0%' : '100%';

  return Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0%" y1="0%" x2="${endX}" y2="${endY}"><stop offset="0%" stop-color="${startColor}"/><stop offset="100%" stop-color="${endColor}"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#g)"/></svg>`,
  );
}

function startDailyStreakReminder() {
  const delay = getNextDailyStreakReminderDelay();
  setTimeout(() => {
    maybeSendDailyStreakReminder().catch((error) => {
      console.error('Daily streak reminder failed:', error.message);
    }).finally(() => {
      startDailyStreakReminder();
    });
  }, delay);
}

function getNextDailyStreakReminderDelay(date = new Date()) {
  const gmt7OffsetMs = 7 * 60 * 60 * 1000;
  const gmt7Now = new Date(date.getTime() + gmt7OffsetMs);
  const nextReminderGmt7 = new Date(gmt7Now);

  nextReminderGmt7.setUTCHours(
    DAILY_STREAK_REMINDER_HOUR_GMT7,
    DAILY_STREAK_REMINDER_MINUTE_GMT7,
    0,
    0,
  );

  if (nextReminderGmt7.getTime() <= gmt7Now.getTime()) {
    nextReminderGmt7.setUTCDate(nextReminderGmt7.getUTCDate() + 1);
  }

  const nextReminderUtcMs = nextReminderGmt7.getTime() - gmt7OffsetMs;
  return nextReminderUtcMs - date.getTime();
}

async function maybeSendDailyStreakReminder(date = new Date()) {
  const channel = await client.channels.fetch(DAILY_STREAK_REMINDER_CHANNEL_ID).catch((error) => {
    console.error('Could not fetch daily streak reminder channel:', error.message);
    return null;
  });
  if (!channel?.guildId || typeof channel.send !== 'function') return;

  const guildData = ensureGuild(channel.guildId);
  const today = getGmt7DateKey(date);
  if (guildData.dailyStreakReminder.lastDate === today) return;

  const yesterday = getGmt7DateKey(new Date(date.getTime() - DAY_MS));
  const dueUserIds = Object.entries(guildData.streaks)
    .filter(([, streak]) => (streak.current || 0) > 0 && streak.lastDate === yesterday)
    .map(([userId]) => userId);

  guildData.dailyStreakReminder.lastDate = today;
  queueSave();

  if (!dueUserIds.length) return;

  for (const userIds of chunkUserIdsForMentions(dueUserIds)) {
    const mentions = userIds.map((userId) => `<@${userId}>`).join(' ');
    await channel.send({
      content: `${mentions}\nyour daily streak is about to be reset. Say a word to keep your daily streaks from resetting to 0.`,
      allowedMentions: { users: userIds },
    }).catch((error) => {
      console.error('Could not send daily streak reminder:', error.message);
    });
  }
}

function chunkUserIdsForMentions(userIds) {
  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;

  for (const userId of userIds) {
    const mentionLength = `<@${userId}> `.length;
    if (currentChunk.length >= 90 || currentLength + mentionLength > 1750) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentLength = 0;
    }

    currentChunk.push(userId);
    currentLength += mentionLength;
  }

  if (currentChunk.length) chunks.push(currentChunk);
  return chunks;
}

async function handleFacebookEmbedFix(message) {
  const fixedLinks = getFixedFacebookLinks(message.content);
  if (!fixedLinks.length) return false;

  await message.suppressEmbeds(true).catch((error) => {
    console.error('Could not suppress Facebook embed:', error.message);
  });

  const replyMessage = await message.reply({
    content: fixedLinks.map(({ label, url }) => `[${label}](${url})`).join('\n'),
    allowedMentions: { repliedUser: false, parse: [] },
  }).catch((error) => {
    console.error('Could not send fixed Facebook embed:', error.message);
    return null;
  });

  if (replyMessage) {
    scheduleFacebookEmbedCheck(replyMessage);
  }

  return true;
}

function scheduleFacebookEmbedCheck(message) {
  setTimeout(async () => {
    const fetchedMessage = await message.fetch().catch(() => null);
    if (!fetchedMessage || fetchedMessage.embeds.length > 0) return;

    await fetchedMessage.edit('Failed to load Facebook video embed.').catch((error) => {
      console.error('Could not edit failed Facebook embed message:', error.message);
    });
  }, FACEBOOK_EMBED_CHECK_DELAY_MS);
}

function getFixedFacebookLinks(content) {
  const urls = content.match(/https?:\/\/[^\s<>()]+/gi) || [];
  const fixedLinks = [];
  const seen = new Set();

  for (const rawUrl of urls) {
    const fixedLink = fixFacebookUrl(rawUrl);
    if (!fixedLink || seen.has(fixedLink.url)) continue;

    seen.add(fixedLink.url);
    fixedLinks.push(fixedLink);
  }

  return fixedLinks;
}

function fixFacebookUrl(rawUrl) {
  const normalizedUrl = rawUrl.replace(/[.,!?;:)\]}]+$/g, '');

  try {
    const url = new URL(normalizedUrl);
    const hostname = url.hostname.toLowerCase();
    const isFacebookHost = hostname === 'facebook.com' || hostname.endsWith('.facebook.com');
    if (!isFacebookHost || !isSupportedFacebookEmbedPath(url)) return null;

    const label = getFacebookFixLabel(url);
    url.hostname = FACEBOOK_FIX_HOST;
    return {
      label,
      url: url.toString(),
    };
  } catch {
    return null;
  }
}

function getFacebookFixLabel(url) {
  const path = url.pathname.toLowerCase();
  if (/^\/reels?\//.test(path) || /^\/share\/r\//.test(path)) return 'Reel';
  if (/^\/share\/v\//.test(path)) return 'Video';
  return 'Facebook';
}

function isSupportedFacebookEmbedPath(url) {
  const path = url.pathname.toLowerCase();
  return [
    /^\/reel\/[^/]+\/?$/,
    /^\/reels\/[^/]+\/?$/,
    /^\/share\/r\/[^/]+\/?$/,
    /^\/share\/v\/[^/]+\/?$/,
  ].some((pattern) => pattern.test(path));
}

async function handlePrefixCommand(message) {
  const parsed = parsePrefixCommand(message.content);
  if (!parsed) return false;

  const { command, args } = parsed;

  if (command === 'ping') {
    await message.reply('Pong.').catch(() => {});
    return true;
  }

  if (command === 'ranked') {
    await message.reply({ embeds: [buildLeaderboardEmbed(message.guildId, message.author.id)] }).catch(() => {});
    return true;
  }

  if (command === 'user') {
    const targetUser = await getPrefixTargetUser(message, args);
    await message.reply({ embeds: [buildUserEmbed(message.guildId, targetUser)] }).catch(() => {});
    return true;
  }

  if (command === 'sync') {
    await startSync({
      guild: message.guild,
      channel: message.channel,
      user: message.author,
      initialReply: (content) => message.reply(content),
      editInitialReply: (content) => message.reply(content),
    });
    return true;
  }

  if (command === 'settings') {
    await message.reply(buildSettingsText(message.guildId)).catch(() => {});
    return true;
  }

  if (command === 'debug') {
    await message.reply(buildDebugText(message.guildId)).catch(() => {});
    return true;
  }

  if (command === 'word') {
    await handleWordCollageStart(message);
    return true;
  }

  if (command === 'whitelist') {
    await handlePrefixWhitelist(message, args);
    return true;
  }

  return false;
}

function parsePrefixCommand(content) {
  const trimmed = content.trim();
  if (!trimmed.toLowerCase().startsWith(PREFIX)) return null;

  const withoutPrefix = trimmed.slice(PREFIX.length).trimStart();
  if (!withoutPrefix) return null;

  const [command, ...args] = withoutPrefix.split(/\s+/);
  return {
    command: command.toLowerCase(),
    args,
  };
}

async function getPrefixTargetUser(message, args) {
  const mentionedUser = message.mentions.users.first();
  if (mentionedUser) return mentionedUser;

  const possibleId = args[0]?.replace(/[<@!>]/g, '');
  if (/^\d{17,20}$/.test(possibleId || '')) {
    const fetchedUser = await client.users.fetch(possibleId).catch(() => null);
    if (fetchedUser) return fetchedUser;
  }

  return message.author;
}

async function handlePrefixWhitelist(message, args) {
  const guildData = ensureGuild(message.guildId);
  const action = args[0]?.toLowerCase() || 'add';
  const selectedChannel = message.mentions.channels.first() || message.channel;

  if (action === 'list') {
    const content = guildData.whitelist.length
      ? `Whitelisted channels (${guildData.whitelist.length}): ${guildData.whitelist.map((id) => `<#${id}>`).join(', ')}`
      : 'No whitelisted channels. Sync will scan every readable text channel.';
    await message.reply(content).catch(() => {});
    return;
  }

  if (action === 'clear') {
    guildData.whitelist = [];
    queueSave();
    await message.reply('Whitelist cleared. Sync will scan every readable text channel.').catch(() => {});
    return;
  }

  if (!selectedChannel || typeof selectedChannel.messages?.fetch !== 'function') {
    await message.reply('That channel cannot be used for message history sync.').catch(() => {});
    return;
  }

  if (action === 'remove') {
    guildData.whitelist = guildData.whitelist.filter((channelId) => channelId !== selectedChannel.id);
    queueSave();
    await message.reply(`Removed <#${selectedChannel.id}> from the whitelist.`).catch(() => {});
    return;
  }

  if (!guildData.whitelist.includes(selectedChannel.id)) {
    guildData.whitelist.push(selectedChannel.id);
    queueSave();
  }

  await message.reply(`Added <#${selectedChannel.id}> to the whitelist.`).catch(() => {});
}

async function handleAiChat(message) {
  if (message.channelId !== AI_CHAT_CHANNEL_ID) return;
  if (!message.content?.trim()) return;

  const repliedMessage = await getRepliedBotMessage(message);
  const shouldRespond = messageMentionsBot(message) || Boolean(repliedMessage);
  if (!shouldRespond) return;

  if (!OPENROUTER_API_KEY) {
    await message.reply({
      content: 'AI chat is not configured.',
      allowedMentions: { repliedUser: false, parse: [] },
    }).catch(() => {});
    return;
  }

  await message.channel.sendTyping().catch(() => {});

  try {
    const responseText = await createAiChatCompletion(message, repliedMessage);

    await message.reply({
      content: fitDiscordMessage(responseText),
      allowedMentions: { repliedUser: false, parse: [] },
    });

    await rememberAiExchange(message, responseText).catch((error) => {
      console.error('Could not save AI memory:', error.message);
    });
  } catch (error) {
    console.error('AI chat failed:', error.message);
    await message.reply({
      content: 'AI chat failed. Check the bot logs for details.',
      allowedMentions: { repliedUser: false, parse: [] },
    }).catch(() => {});
  }
}

function messageMentionsBot(message) {
  return Boolean(client.user?.id && message.mentions.users.has(client.user.id));
}

async function getRepliedBotMessage(message) {
  if (!message.reference?.messageId) return null;

  const repliedMessage = await message.fetchReference().catch(() => null);
  return repliedMessage?.author?.id === client.user?.id ? repliedMessage : null;
}

function getAiUserContent(message) {
  const botMentionPattern = client.user?.id ? new RegExp(`<@!?${client.user.id}>`, 'g') : null;
  const content = botMentionPattern
    ? message.content.replace(botMentionPattern, '').trim()
    : message.content.trim();

  return content || message.content.trim();
}

async function createAiChatCompletion(message, repliedMessage = null) {
  const userMemory = getAiUserMemory(message.guildId, message.author.id);
  const messages = [];
  if (AI_SYSTEM_PROMPT) {
    messages.push({ role: 'system', content: AI_SYSTEM_PROMPT });
  }

  if (userMemory.summaries.length) {
    messages.push({
      role: 'system',
      content: [
        `Persistent memory for Discord user ${message.author.username} (${message.author.id}):`,
        ...userMemory.summaries.map((summary, index) => `${index + 1}. ${summary.content}`),
      ].join('\n'),
    });
  }

  for (const memoryMessage of userMemory.recent) {
    messages.push({
      role: memoryMessage.role,
      content: memoryMessage.content,
    });
  }

  if (repliedMessage?.content?.trim()) {
    messages.push({
      role: 'assistant',
      content: repliedMessage.content.trim(),
    });
  }

  messages.push({
    role: 'user',
    content: [
      `Discord user: ${message.author.username} (${message.author.id})`,
      `Message: ${getAiUserContent(message)}`,
    ].join('\n'),
  });

  return callOpenRouterChat(messages, {
    maxTokens: AI_MAX_TOKENS,
    temperature: 0.8,
  });
}

async function callOpenRouterChat(messages, options = {}) {
  const {
    maxTokens = AI_MAX_TOKENS,
    temperature = 0.8,
    emptyResponseRetries = AI_EMPTY_RESPONSE_RETRIES,
  } = options;

  for (let attempt = 0; attempt <= emptyResponseRetries; attempt += 1) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://discord.com',
        'X-Title': 'wordcounter-discord-bot',
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
        reasoning: AI_REASONING,
      }),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = body?.error?.message || body?.message || response.statusText;
      throw new Error(`OpenRouter ${response.status}: ${detail}`);
    }

    const content = extractOpenRouterContent(body);
    if (content) return content;

    const choice = body?.choices?.[0] || {};
    console.error('OpenRouter returned empty content:', {
      attempt: attempt + 1,
      model: body?.model || AI_MODEL,
      finishReason: choice.finish_reason,
      nativeFinishReason: choice.native_finish_reason,
      choiceKeys: Object.keys(choice),
      messageKeys: Object.keys(choice.message || {}),
    });
  }

  throw new Error('OpenRouter returned an empty response.');
}

function extractOpenRouterContent(body) {
  for (const choice of body?.choices || []) {
    const content = choice.message?.content ?? choice.text;
    const text = normalizeOpenRouterContent(content);
    if (text) return text;
  }

  return '';
}

function normalizeOpenRouterContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      return '';
    })
    .join('')
    .trim();
}

function getAiUserMemory(guildId, userId) {
  const guildData = ensureGuild(guildId);
  guildData.aiMemory.users[userId] ??= {
    summaries: [],
    recent: [],
  };

  const userMemory = guildData.aiMemory.users[userId];
  userMemory.summaries ??= [];
  userMemory.recent ??= [];
  userMemory.summaries = userMemory.summaries.slice(-AI_SUMMARY_MEMORY_LIMIT);
  return userMemory;
}

async function rememberAiExchange(message, responseText) {
  const userMemory = getAiUserMemory(message.guildId, message.author.id);
  const now = new Date().toISOString();

  userMemory.recent.push(
    {
      role: 'user',
      content: [
        `Discord user: ${message.author.username} (${message.author.id})`,
        `Message: ${getAiUserContent(message)}`,
      ].join('\n'),
      createdAt: now,
    },
    {
      role: 'assistant',
      content: responseText,
      createdAt: now,
    },
  );

  queueSave();

  while (userMemory.recent.length >= AI_RECENT_MEMORY_LIMIT) {
    const chunk = userMemory.recent.slice(0, AI_RECENT_MEMORY_LIMIT);
    const summary = await summarizeAiMemoryChunk(message, chunk).catch((error) => {
      console.error('AI memory summary failed:', error.message);
      return null;
    });

    if (!summary) return;

    userMemory.recent = userMemory.recent.slice(AI_RECENT_MEMORY_LIMIT);
    userMemory.summaries.push({
      content: summary,
      createdAt: new Date().toISOString(),
    });
    userMemory.summaries = userMemory.summaries.slice(-AI_SUMMARY_MEMORY_LIMIT);
    queueSave();
  }
}

async function summarizeAiMemoryChunk(message, chunk) {
  const transcript = chunk
    .map((entry, index) => `${index + 1}. ${entry.role}: ${entry.content}`)
    .join('\n\n');

  return callOpenRouterChat([
    {
      role: 'system',
      content: [
        'Summarize this Discord AI chat memory chunk for future conversations.',
        'Preserve stable user facts, preferences, names, goals, decisions, and unresolved context.',
        'Do not invent facts. Keep it concise.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Discord user: ${message.author.username} (${message.author.id})`,
        'Conversation chunk:',
        transcript,
      ].join('\n'),
    },
  ], {
    maxTokens: AI_SUMMARY_MAX_TOKENS,
    temperature: 0.2,
  });
}

function fitDiscordMessage(content) {
  if (content.length <= DISCORD_MESSAGE_LIMIT) return content;
  return `${content.slice(0, DISCORD_MESSAGE_LIMIT - 3).trimEnd()}...`;
}

function removeMessageRecord(guildId, messageId, save = true) {
  const guildData = ensureGuild(guildId);
  const record = guildData.messages[messageId];
  if (!record) return false;

  for (const [word, amount] of Object.entries(record.counts)) {
    addCount(guildData, record.authorId, word, -amount);
  }

  delete guildData.messages[messageId];
  if (save) queueSave();
  return true;
}

function getSortedEntries(guildId, word) {
  const guildData = ensureGuild(guildId);

  return Object.entries(guildData.counts[word] || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
}

function getUserRank(guildId, word, userId) {
  const entries = getSortedEntries(guildId, word);
  const index = entries.findIndex(([entryUserId]) => entryUserId === userId);
  return index === -1 ? null : index + 1;
}

function getUserCount(guildId, word, userId) {
  const guildData = ensureGuild(guildId);
  return guildData.counts[word]?.[userId] || 0;
}

function getServerTotal(guildId, word) {
  return getSortedEntries(guildId, word).reduce((total, [, count]) => total + count, 0);
}

function getGapToNext(guildId, word, userId) {
  const entries = getSortedEntries(guildId, word);
  const index = entries.findIndex(([entryUserId]) => entryUserId === userId);
  if (index <= 0) return null;

  return entries[index - 1][1] - entries[index][1] + 1;
}

function formatRank(rank) {
  return rank ? `#${rank}` : 'Unranked';
}

function formatCount(count, word) {
  return `${count.toLocaleString()} ${formatWord(word)}`;
}

function formatWord(word) {
  return WORD_LABELS[word] || word;
}

async function registerGuildCommands() {
  const results = await Promise.allSettled(
    client.guilds.cache.map((guild) => registerCommandsForGuild(guild)),
  );

  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length) {
    console.error(`Failed to register commands in ${failed.length} guild(s).`);
  }
}

async function registerGlobalCommands() {
  await client.application.commands.set(globalCommands);
  console.log('Registered global slash commands.');
}

async function registerCommandsForGuild(guild) {
  await guild.commands.set(commands);
  console.log(`Registered slash commands in ${guild.name}`);
}

async function handleRanked(interaction) {
  await interaction.reply({ embeds: [buildLeaderboardEmbed(interaction.guildId, interaction.user.id)] });
}

function buildLeaderboardEmbed(guildId, viewerId = null) {
  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle('Word leaderboards')
    .setTimestamp();

  for (const word of TRACKED_WORDS) {
    const entries = getSortedEntries(guildId, word).slice(0, 5);
    const total = getServerTotal(guildId, word);
    const topCount = entries[0]?.[1] || 0;
    const description = entries.length
      ? entries
          .map(([userId, count], index) => `#${index + 1} <@${userId}> - ${count.toLocaleString()}`)
          .join('\n')
      : `No one has scored "${formatWord(word)}" yet.`;

    embed.addFields(
      { name: `${formatWord(word)} top 5`, value: description, inline: false },
      { name: `${formatWord(word)} server total`, value: total.toLocaleString(), inline: true },
      { name: `${formatWord(word)} top score`, value: topCount.toLocaleString(), inline: true },
    );

    if (viewerId) {
      const viewerCount = getUserCount(guildId, word, viewerId);
      const viewerRank = getUserRank(guildId, word, viewerId);

      embed.addFields({
        name: `${formatWord(word)} your score`,
        value: `${viewerCount.toLocaleString()} (${formatRank(viewerRank)})`,
        inline: true,
      });
    }
  }

  return embed;
}

async function handleUser(interaction) {
  const targetUser = interaction.options.getUser('user') || interaction.user;
  await interaction.reply({ embeds: [buildUserEmbed(interaction.guildId, targetUser)] });
}

function buildUserEmbed(guildId, targetUser) {
  const userId = targetUser.id;
  const hiCount = getUserCount(guildId, 'nigga', userId);
  const helloCount = getUserCount(guildId, 'nigger', userId);
  const hiRank = getUserRank(guildId, 'nigga', userId);
  const helloRank = getUserRank(guildId, 'nigger', userId);
  const hiGap = getGapToNext(guildId, 'nigga', userId);
  const helloGap = getGapToNext(guildId, 'nigger', userId);
  const streak = getUserStreak(guildId, userId);
  const favoriteWord = hiCount === helloCount ? 'Tie' : hiCount > helloCount ? 'Soft N' : 'Hard R';

  return new EmbedBuilder()
    .setColor(0x10b981)
    .setTitle(`Word stats for ${targetUser.username}`)
    .setDescription(`<@${userId}>`)
    .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
    .addFields(
      {
        name: 'Soft N',
        value: [
          `Count: ${formatCount(hiCount, 'nigga')}`,
          `Rank: ${formatRank(hiRank)}`,
          `Next rank: ${hiGap ? `${hiGap.toLocaleString()} more` : 'Top rank or unranked'}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Hard R',
        value: [
          `Count: ${formatCount(helloCount, 'nigger')}`,
          `Rank: ${formatRank(helloRank)}`,
          `Next rank: ${helloGap ? `${helloGap.toLocaleString()} more` : 'Top rank or unranked'}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Personal total',
        value: (hiCount + helloCount).toLocaleString(),
        inline: true,
      },
      {
        name: 'Current daily streak',
        value: `${(streak.current || 0).toLocaleString()} day(s)`,
        inline: true,
      },
      {
        name: 'Best daily streak',
        value: `${(streak.best || 0).toLocaleString()} day(s)`,
        inline: true,
      },
      {
        name: 'Last daily streak day',
        value: streak.lastDate || 'None',
        inline: true,
      },
      {
        name: 'Favorite word',
        value: favoriteWord,
        inline: true,
      },
    )
    .setTimestamp();
}

async function handleSync(interaction) {
  await startSync({
    guild: interaction.guild,
    channel: interaction.channel,
    user: interaction.user,
    initialReply: (content) => interaction.reply(content),
    editInitialReply: (content) => interaction.editReply(content),
  });
}

async function startSync({ guild, channel, user, initialReply, editInitialReply }) {
  if (activeSyncs.has(guild.id)) {
    await initialReply('A sync is already running for this server.');
    return;
  }

  activeSyncs.add(guild.id);
  const status = {
    totalChannels: 0,
    scannedChannels: 0,
    failedChannels: 0,
    scannedMessages: 0,
    addedMessages: 0,
    fullScanChannels: 0,
    incrementalChannels: 0,
    startedAt: Date.now(),
  };

  try {
    await initialReply('Starting word sync. A progress message will update every 10 seconds.');
    const progressMessage = await channel
      ?.send(formatSyncProgress(status))
      .catch((error) => {
        console.error('Could not send sync progress message:', error.message);
        return null;
      });

    const progressTimer = setInterval(() => {
      updateSyncProgress(progressMessage, editInitialReply, status);
    }, 10_000);

    try {
      await syncGuild(guild, status);
    } finally {
      clearInterval(progressTimer);
      saveData();
    }

    await updateSyncProgress(progressMessage, editInitialReply, status);
    await channel?.send({
      content: `<@${user.id}> Sync finished. Scanned ${status.scannedMessages.toLocaleString()} messages across ${status.scannedChannels.toLocaleString()} channel(s). Added ${status.addedMessages.toLocaleString()} scoring message(s).`,
      allowedMentions: { users: [user.id] },
    }).catch((error) => {
      console.error('Could not send sync finished message:', error.message);
    });
  } finally {
    activeSyncs.delete(guild.id);
  }
}

async function updateSyncProgress(progressMessage, editInitialReply, status) {
  const content = formatSyncProgress(status);

  if (progressMessage) {
    await progressMessage.edit(content).catch((error) => {
      console.error('Could not edit sync progress message:', error.message);
    });
    return;
  }

  await editInitialReply(content).catch((error) => {
    console.error('Could not edit sync interaction reply:', error.message);
  });
}

function formatSyncProgress(status) {
  const elapsedSeconds = Math.max(1, Math.floor((Date.now() - status.startedAt) / 1000));

  return [
    'Word sync in progress.',
    `Channels: ${status.scannedChannels.toLocaleString()} / ${status.totalChannels.toLocaleString()}`,
    `Messages scanned: ${status.scannedMessages.toLocaleString()}`,
    `Scoring messages added: ${status.addedMessages.toLocaleString()}`,
    `Full scan channels: ${status.fullScanChannels.toLocaleString()}`,
    `Incremental channels: ${status.incrementalChannels.toLocaleString()}`,
    `Failed channels: ${status.failedChannels.toLocaleString()}`,
    `Elapsed: ${elapsedSeconds.toLocaleString()} seconds`,
  ].join('\n');
}

async function syncGuild(guild, status) {
  await guild.channels.fetch();
  await guild.members.fetchMe().catch(() => null);
  const channels = getSyncChannels(guild);
  status.totalChannels = channels.length;

  for (const channel of channels) {
    await syncChannel(channel, status);
    status.scannedChannels += 1;
    saveData();
  }
}

function getSyncChannels(guild) {
  const guildData = ensureGuild(guild.id);
  const botMember = guild.members.me;
  if (!botMember) return [];

  const sourceChannels = guildData.whitelist.length
    ? guildData.whitelist.map((channelId) => guild.channels.cache.get(channelId)).filter(Boolean)
    : [...guild.channels.cache.values()];

  return sourceChannels.filter((channel) => {
    if (!channel || typeof channel.messages?.fetch !== 'function') return false;

    const permissions = channel.permissionsFor(botMember);
    return permissions?.has([
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ReadMessageHistory,
    ]);
  });
}

async function syncChannel(channel, status) {
  const guildData = ensureGuild(channel.guildId);
  const channelState = ensureChannelSyncState(guildData, channel.id);

  if (channelState.lastMessageId) {
    await syncChannelIncremental(channel, channelState, status);
  } else {
    await syncChannelFull(channel, channelState, status);
  }
}

async function syncChannelFull(channel, channelState, status) {
  let before;
  let newestSeenId = null;

  try {
    status.fullScanChannels += 1;

    while (true) {
      const options = { limit: 100 };
      if (before) options.before = before;

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) break;
      newestSeenId = getNewestMessageId(messages, newestSeenId);

      for (const message of messages.values()) {
        status.scannedMessages += 1;
        if (!message.author?.bot && recordMessage(message, { save: false, source: 'sync' })) {
          status.addedMessages += 1;
        }
      }

      before = messages.last()?.id;
      if (messages.size < 100 || !before) break;
    }

    if (newestSeenId) {
      channelState.lastMessageId = newestSeenId;
    }
  } catch (error) {
    status.failedChannels += 1;
    console.error(`Failed to sync #${channel.name || channel.id}:`, error.message);
  }
}

async function syncChannelIncremental(channel, channelState, status) {
  let after = channelState.lastMessageId;
  let newestSeenId = channelState.lastMessageId;

  try {
    status.incrementalChannels += 1;

    while (true) {
      const messages = await channel.messages.fetch({ limit: 100, after });
      if (messages.size === 0) break;

      const orderedMessages = sortOldestFirst(messages);

      for (const message of orderedMessages) {
        status.scannedMessages += 1;
        if (!message.author?.bot && recordMessage(message, { save: false, source: 'sync' })) {
          status.addedMessages += 1;
        }
      }

      newestSeenId = orderedMessages[orderedMessages.length - 1].id;
      after = newestSeenId;
      if (messages.size < 100) break;
    }

    channelState.lastMessageId = newestSeenId;
  } catch (error) {
    status.failedChannels += 1;
    console.error(`Failed to sync #${channel.name || channel.id}:`, error.message);
  }
}

async function handleWhitelist(interaction) {
  const guildData = ensureGuild(interaction.guildId);
  const action = interaction.options.getString('action') || 'add';
  const selectedChannel = interaction.options.getChannel('channel') || interaction.channel;

  if (action === 'list') {
    const content = guildData.whitelist.length
      ? `Whitelisted channels (${guildData.whitelist.length}): ${guildData.whitelist.map((id) => `<#${id}>`).join(', ')}`
      : 'No whitelisted channels. Sync will scan every readable text channel.';
    await interaction.reply(content);
    return;
  }

  if (action === 'clear') {
    guildData.whitelist = [];
    queueSave();
    await interaction.reply('Whitelist cleared. Sync will scan every readable text channel.');
    return;
  }

  if (!selectedChannel || typeof selectedChannel.messages?.fetch !== 'function') {
    await interaction.reply('That channel cannot be used for message history sync.');
    return;
  }

  if (action === 'remove') {
    guildData.whitelist = guildData.whitelist.filter((channelId) => channelId !== selectedChannel.id);
    queueSave();
    await interaction.reply(`Removed <#${selectedChannel.id}> from the whitelist.`);
    return;
  }

  if (!guildData.whitelist.includes(selectedChannel.id)) {
    guildData.whitelist.push(selectedChannel.id);
    queueSave();
  }

  await interaction.reply(`Added <#${selectedChannel.id}> to the whitelist.`);
}

async function handleSettings(interaction) {
  await interaction.reply(buildSettingsText(interaction.guildId));
}

function buildSettingsText(guildId) {
  const guildData = ensureGuild(guildId);
  const hiTotal = getServerTotal(guildId, 'nigga');
  const helloTotal = getServerTotal(guildId, 'nigger');
  const trackedMessages = Object.keys(guildData.messages).length;
  const whitelistText = guildData.whitelist.length
    ? guildData.whitelist.map((id) => `<#${id}>`).join('\n')
    : 'None. Sync scans every readable text channel.';

  return [
    `Whitelisted channels: ${guildData.whitelist.length}`,
    `Tracked scoring messages: ${trackedMessages.toLocaleString()}`,
    `Total Soft N count: ${hiTotal.toLocaleString()}`,
    `Total Hard R count: ${helloTotal.toLocaleString()}`,
    'Whitelist:',
    whitelistText,
  ].join('\n');
}

function buildDebugText(guildId) {
  const guildData = ensureGuild(guildId);
  const totals = TRACKED_WORDS
    .map((word) => `${formatWord(word)}: ${getServerTotal(guildId, word).toLocaleString()}`)
    .join('\n');
  const lastScore = runtimeStats.lastLiveScore
    ? JSON.stringify(runtimeStats.lastLiveScore.counts)
    : 'None';

  return [
    'Debug:',
    `Live messages seen: ${runtimeStats.liveMessagesSeen.toLocaleString()}`,
    `Live messages with content: ${runtimeStats.liveMessagesWithContent.toLocaleString()}`,
    `Live scoring messages: ${runtimeStats.liveScoringMessages.toLocaleString()}`,
    `Tracked scoring messages: ${Object.keys(guildData.messages).length.toLocaleString()}`,
    `Last live message: ${runtimeStats.lastLiveMessageAt || 'None'}`,
    `Last live content: ${runtimeStats.lastLiveContentAt || 'None'}`,
    `Last live score: ${runtimeStats.lastLiveScoreAt || 'None'}`,
    `Last live score counts: ${lastScore}`,
    'Totals:',
    totals,
  ].join('\n');
}

client.login(TOKEN);
