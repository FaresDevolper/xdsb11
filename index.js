'use strict';

/*
 * بوت حماية القذف في الرومات الصوتية
 * يسمع كل شخص لحاله -> يحول الصوت لنص (Whisper) -> يفحص الكلمات القوية -> تايم اوت + لوق للمشرفين
 */

const http = require('http');
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  SlashCommandBuilder,
  ActivityType,
  MessageFlags,
  Events,
} = require('discord.js');
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { findBadWords, normalize } = require('./detector');
const { toWav16kMono } = require('./audio');

// ============================ الإعدادات ============================
const env = process.env;

const CFG = {
  token: env.DISCORD_TOKEN,
  guildId: env.GUILD_ID,
  logChannelId: env.LOG_CHANNEL_ID,
  watchChannelId: env.WATCH_CHANNEL_ID || null,
  sttKey: env.STT_API_KEY,
  sttUrl: env.STT_API_URL || 'https://api.groq.com/openai/v1/audio/transcriptions',
  sttModel: env.STT_MODEL || 'whisper-large-v3',
  timeoutMin: Math.min(Math.max(Number(env.TIMEOUT_MINUTES) || 10, 1), 40320),
  tz: env.TIMEZONE || 'Asia/Riyadh',
  exemptRoles: (env.EXEMPT_ROLE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  pingRoleId: env.LOG_PING_ROLE_ID || null,
  announce: env.ANNOUNCE_NOTICE !== 'false',
  minLogprob: Number(env.MIN_LOGPROB) || -1.0,
  port: Number(env.PORT) || 3000,
};

// ضبط الصوت
const SILENCE_MS = 900; // يعتبر الجملة انتهت بعد هذي الفترة من الصمت
const MAX_CLIP_MS = 12000; // أقصى طول لمقطع واحد قبل ما يتقطع ويكمل
const MIN_CLIP_SEC = 0.6; // أقصر مقطع يستاهل التحويل
const MIN_RMS = 120; // أقل مستوى صوت (تحت هذا = ضجيج/صمت)
const MAX_PCM_BYTES = 48000 * 4 * 14;

// دقة التعرف
const MAX_NO_SPEECH = 0.5;
const MAX_COMPRESSION = 2.4;

// الطابور
const CONCURRENCY = 2;
const MAX_QUEUE = 20;
const COOLDOWN_MS = 60_000;

const SAFE_TZ = (() => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: CFG.tz });
    return CFG.tz;
  } catch {
    return 'Asia/Riyadh';
  }
})();

// ============================ سيرفر صغير لرندر ============================
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Voice Guard Bot is running');
  })
  .listen(CFG.port, () => console.log(`[http] listening on ${CFG.port}`));

const missing = ['token', 'guildId', 'logChannelId', 'sttKey'].filter((k) => !CFG[k]);
if (missing.length) {
  console.error(
    '[config] ناقص: ' +
      missing
        .map((k) => ({ token: 'DISCORD_TOKEN', guildId: 'GUILD_ID', logChannelId: 'LOG_CHANNEL_ID', sttKey: 'STT_API_KEY' }[k]))
        .join(', ')
  );
  process.exit(1);
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

// ============================ العميل ============================
... (636 lines left)


