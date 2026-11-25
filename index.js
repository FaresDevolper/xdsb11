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
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const state = {
  connection: null,
  channelId: null,
  wantedChannelId: null,
  rejoinTimer: null,
  capturing: new Set(),
};

const stats = { clips: 0, transcribed: 0, punished: 0, suspects: 0, dropped: 0, errors: 0 };
const cooldown = new Map();

const getGuild = () => client.guilds.cache.get(CFG.guildId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

function isExempt(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return CFG.exemptRoles.some((id) => member.roles.cache.has(id));
}

function fmtClock(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: SAFE_TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(d);
}

function joinMentions(list) {
  let out = '';
  let n = 0;
  for (const m of list) {
    if ((out + ' ' + m).length > 900) {
      out += ` +${list.length - n}`;
      break;
    }
    out += (out ? ' ' : '') + m;
    n++;
  }
  return out || 'لا أحد';
}

// ============================ الاستماع للصوت ============================
function capture(userId) {
  const conn = state.connection;
  if (!conn || state.capturing.has(userId)) return;

  const guild = getGuild();
  const cached = guild?.members.cache.get(userId);
  if (cached && (cached.user.bot || isExempt(cached))) return;

  state.capturing.add(userId);

  let opusStream;
  try {
    opusStream = conn.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
  } catch (e) {
    state.capturing.delete(userId);
    console.error('[voice] subscribe failed:', e.message);
    return;
  }

  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];
  let bytes = 0;
  let capped = false;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(maxTimer);
    state.capturing.delete(userId);
    try {
      opusStream.destroy();
    } catch {}

    const pcm = Buffer.concat(chunks, bytes);
    onClip(userId, pcm);

    // لو الشخص لسا يتكلم بعد القص، نكمل التقاط
    if (capped && state.connection === conn) setTimeout(() => capture(userId), 120);
  };

  const maxTimer = setTimeout(() => {
    capped = true;
    try {
      opusStream.unpipe(decoder);
    } catch {}
    decoder.end();
  }, MAX_CLIP_MS);

  decoder.on('data', (c) => {
    if (bytes < MAX_PCM_BYTES) {
      chunks.push(c);
      bytes += c.length;
    }
  });
  decoder.on('end', finish);
  decoder.on('close', finish);
  decoder.on('error', (e) => {
    console.warn('[voice] decoder error:', e.message);
    finish();
  });
  opusStream.on('error', (e) => {
    console.warn('[voice] stream error:', e.message);
    try {
      decoder.end();
    } catch {}
  });

  opusStream.pipe(decoder);
}

function onClip(userId, pcm) {
  try {
    if (pcm.length < 48000 * 4 * MIN_CLIP_SEC) return;
    const { wav, rms, seconds } = toWav16kMono(pcm);
    if (seconds < MIN_CLIP_SEC || rms < MIN_RMS) return;

    stats.clips++;
    const guild = getGuild();
    const channelId = guild?.voiceStates.cache.get(userId)?.channelId || state.channelId;
    enqueue({ userId, wav, channelId, at: Date.now(), seconds });
  } catch (e) {
    console.error('[clip] error:', e);
  }
}

// ============================ طابور التحويل لنص ============================
const queue = [];
let active = 0;

function enqueue(job) {
  if (queue.length >= MAX_QUEUE) {
    queue.shift();
    stats.dropped++;
  }
  queue.push(job);
  pump();
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    runJob(job)
      .catch((e) => {
        stats.errors++;
        console.error('[job] error:', e.message);
      })
      .finally(() => {
        active--;
        pump();
      });
  }
}

async function transcribe(wav) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', CFG.sttModel);
    form.append('language', 'ar');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    let res;
    try {
      res = await fetch(CFG.sttUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${CFG.sttKey}` },
        body: form,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || 3, 15);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error('STT rate limited');
}

// جمل يهلوس بها Whisper لما يكون في صمت/موسيقى
const HALLUCINATIONS = [
  'اشتركوا في القناه',
  'اشترك في القناه',
  'لا تنسوا الاشتراك',
  'ترجمه نانسي قنقر',
  'شكرا للمشاهده',
  'شكرا لكم على المشاهده',
  'تمت الترجمه',
  'ترجمه',
  'موسيقي',
].map(normalize);

function isHallucination(nt) {
  return nt.length < 60 && HALLUCINATIONS.some((h) => nt.includes(h));
}

async function runJob(job) {
  const result = await transcribe(job.wav);
  stats.transcribed++;

  const text = String(result.text || '').trim();
  if (!text) return;
  if (isHallucination(normalize(text))) return;

  const segments =
    Array.isArray(result.segments) && result.segments.length
      ? result.segments
      : [{ text, avg_logprob: 0, no_speech_prob: 0, compression_ratio: 1 }];

  let strong = null;
  let weak = null;

  for (const seg of segments) {
    const hits = findBadWords(seg.text || '');
    if (!hits.length) continue;

    const confident =
      (seg.avg_logprob ?? 0) >= CFG.minLogprob &&
      (seg.no_speech_prob ?? 0) <= MAX_NO_SPEECH &&
      (seg.compression_ratio ?? 1) <= MAX_COMPRESSION;

    const hit = { ...hits[0], segment: String(seg.text || '').trim() };
    if (confident) {
      strong = hit;
      break;
    }
    if (!weak) weak = hit;
  }

  if (strong) await punish(job, strong);
  else if (weak) await logSuspect(job, weak);
}

// ============================ العقوبة واللوق ============================
async function sendLog(payload) {
  const ch = await client.channels.fetch(CFG.logChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    console.error('[log] روم اللوق غير صالح');
    return null;
  }
  return ch.send(payload).catch((e) => console.error('[log] send failed:', e.message));
}

function buildFields(guild, member, job, hit) {
  const vc = guild.channels.cache.get(job.channelId);
  const present = vc?.members
    ? vc.members.filter((m) => !m.user.bot && m.id !== member.id).map((m) => `<@${m.id}>`)
    : [];
  const ts = Math.floor(job.at / 1000);
  return [
    { name: '👤 الشخص', value: `<@${member.id}>\n\`${member.user.tag}\``, inline: true },
    { name: '🗣️ الكلمة', value: `\`${clip(hit.said, 100)}\``, inline: true },
    { name: '🔊 الروم', value: vc ? `<#${vc.id}>\n${clip(vc.name, 60)}` : 'غير معروف', inline: true },
    { name: '🕒 الوقت بالضبط', value: `${fmtClock(new Date(job.at))}\n<t:${ts}:F>`, inline: true },
    { name: '📝 الجملة', value: `«${clip(hit.segment || hit.said, 300)}»` },
    { name: `👥 الموجودين بالروم (${present.length})`, value: joinMentions(present) },
  ];
}

async function punish(job, hit) {
  const guild = getGuild();
  if (!guild) return;

  const member = await guild.members.fetch(job.userId).catch(() => null);
  if (!member || member.user.bot) return;
  if (isExempt(member)) return;

  const now = Date.now();
  if ((cooldown.get(member.id) || 0) > now) return;
  if (member.isCommunicationDisabled()) return;

  const fields = buildFields(guild, member, job, hit);

  if (!member.moderatable) {
    await sendLog({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle('⚠️ رصد قذف لكن ما قدرت أعطيه تايم اوت')
          .setDescription('رتبة البوت لازم تكون أعلى من رتبة الشخص، ولازم أملك صلاحية Moderate Members.')
          .addFields(fields)
          .setTimestamp(job.at),
      ],
    });
    cooldown.set(member.id, now + COOLDOWN_MS);
    return;
  }

  try {
    await member.timeout(CFG.timeoutMin * 60_000, clip(`قذف في الروم الصوتي: ${hit.said}`, 500));
  } catch (e) {
    console.error('[punish] timeout failed:', e.message);
    await sendLog({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle('⚠️ فشل تنفيذ التايم اوت')
          .setDescription(clip(e.message, 300))
          .addFields(fields)
          .setTimestamp(job.at),
      ],
    });
    return;
  }

  cooldown.set(member.id, now + COOLDOWN_MS);
  stats.punished++;

  // 1) رسالة في شات الروم الصوتي
  const vc = guild.channels.cache.get(job.channelId);
  if (vc && typeof vc.send === 'function') {
    vc.send({
      content: `<@${member.id}> تم إعطاؤك تايم اوت **${CFG.timeoutMin} دقائق**، السبب: **قذف**.`,
      allowedMentions: { users: [member.id] },
    }).catch(() => {});
  }

  // 2) لوق المشرفين
  const endTs = Math.floor((now + CFG.timeoutMin * 60_000) / 1000);
  const embed = new EmbedBuilder()
    .setColor(0xc0392b)
    .setTitle('🚨 قذف في روم صوتي — تم إعطاء تايم اوت')
    .addFields(
      ...fields.slice(0, 4),
      { name: '⏳ العقوبة', value: `${CFG.timeoutMin} دقائق — تنتهي <t:${endTs}:R>`, inline: true },
      ...fields.slice(4)
    )
    .setFooter({ text: `ID: ${member.id}` })
    .setTimestamp(job.at);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`untimeout:${member.id}`)
      .setLabel('رفع التايم اوت (غلط؟)')
      .setStyle(ButtonStyle.Success)
  );

  await sendLog({
    content: `@here${CFG.pingRoleId ? ` <@&${CFG.pingRoleId}>` : ''}`,
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: ['everyone'], roles: CFG.pingRoleId ? [CFG.pingRoleId] : [] },
  });
}

async function logSuspect(job, hit) {
  const guild = getGuild();
  if (!guild) return;
  const member = await guild.members.fetch(job.userId).catch(() => null);
  if (!member || member.user.bot || isExempt(member)) return;

  stats.suspects++;
  await sendLog({
    embeds: [
      new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle('🟡 اشتباه — لم تُطبَّق عقوبة (الصوت غير واضح)')
        .setDescription('التعرف على الكلام كان ضعيف الثقة، فتركته للمراجعة اليدوية بدل ما أظلم أحد.')
        .addFields(buildFields(guild, member, job, hit))
        .setFooter({ text: `ID: ${member.id}` })
        .setTimestamp(job.at),
    ],
    allowedMentions: { parse: [] },
  });
}

// ============================ الاتصال بالروم الصوتي ============================
function stopWatching(clearWanted = true) {
  if (clearWanted) state.wantedChannelId = null;
  clearTimeout(state.rejoinTimer);
  state.rejoinTimer = null;
  const c = state.connection;
  state.connection = null;
  state.channelId = null;
  state.capturing.clear();
  if (c) {
    try {
      c.destroy();
    } catch {}
  }
}

function scheduleRejoin(delay = 5000) {
  if (!state.wantedChannelId || state.rejoinTimer) return;
  state.rejoinTimer = setTimeout(async () => {
    state.rejoinTimer = null;
    if (!state.wantedChannelId || state.connection) return;
    const ch = getGuild()?.channels.cache.get(state.wantedChannelId);
    if (!ch) return;
    try {
      await joinWatch(ch);
      console.log('[voice] rejoined');
    } catch (e) {
      console.error('[voice] rejoin failed:', e.message);
      scheduleRejoin(15000);
    }
  }, delay);
}

async function joinWatch(channel, { announce = false } = {}) {
  stopWatching(false);
  state.wantedChannelId = channel.id;

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false, // لازم false عشان يقدر يسمع
    selfMute: true,
  });
  state.connection = connection;
  state.channelId = channel.id;

  connection.on('error', (e) => console.error('[voice] connection error:', e.message));

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch {
    if (state.connection === connection) {
      state.connection = null;
      state.channelId = null;
    }
    try {
      connection.destroy();
    } catch {}
    throw new Error('تعذر الاتصال بالروم الصوتي (تأكد من صلاحية Connect و View Channel)');
  }

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      try {
        connection.destroy();
      } catch {}
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    if (state.connection === connection) {
      state.connection = null;
      state.channelId = null;
      state.capturing.clear();
      scheduleRejoin();
    }
  });

  connection.receiver.speaking.on('start', (userId) => capture(userId));

  console.log(`[voice] watching #${channel.name}`);

  if (announce && CFG.announce && typeof channel.send === 'function') {
    channel
      .send('🛡️ هذا الروم تحت **حماية القذف الصوتية**. يتم تحويل الكلام لنص بشكل مؤقت للكشف عن القذف والسب فقط، ولا يتم حفظ أي تسجيل.')
      .catch(() => {});
  }
}

// ============================ الأوامر ============================
const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('يدخل البوت الروم الصوتي ويبدأ حماية القذف')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('الروم الصوتي (اختياري، الافتراضي رومك الحالي)')
        .addChannelTypes(ChannelType.GuildVoice)
    ),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('يخرج البوت من الروم الصوتي ويوقف الحماية')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('حالة البوت وإحصائيات الجلسة')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder()
    .setName('test')
    .setDescription('يجرب نص: هل يعتبره البوت قذف؟ (بدون أي عقوبة)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption((o) => o.setName('text').setDescription('النص المراد فحصه').setRequired(true)),
];

const EPHEMERAL = MessageFlags.Ephemeral;

async function handleCommand(i) {
  if (!i.inGuild() || i.guildId !== CFG.guildId) return;
  if (!i.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    return i.reply({ content: 'هذا الأمر للمشرفين فقط.', flags: EPHEMERAL });
  }

  switch (i.commandName) {
    case 'join': {
      await i.deferReply({ flags: EPHEMERAL });
      const ch = i.options.getChannel('channel') || i.member.voice?.channel;
      if (!ch || ch.type !== ChannelType.GuildVoice) {
        return i.editReply('ادخل روم صوتي أولاً أو حدد الروم في الأمر.');
      }
      const real = i.guild.channels.cache.get(ch.id);
      if (!real?.joinable) return i.editReply('ما أقدر أدخل هذا الروم، تأكد من صلاحيات View Channel و Connect.');
      try {
        await joinWatch(real, { announce: true });
        return i.editReply(`✅ دخلت <#${real.id}> والحماية شغالة.`);
      } catch (e) {
        return i.editReply(`❌ ${e.message}`);
      }
    }
    case 'leave': {
      stopWatching(true);
      return i.reply({ content: '✅ خرجت من الروم وأوقفت الحماية.', flags: EPHEMERAL });
    }
    case 'status': {
      const lines = [
        `الروم: ${state.channelId ? `<#${state.channelId}>` : 'غير متصل'}`,
        `مدة التايم اوت: ${CFG.timeoutMin} دقائق`,
        `مقاطع تم التقاطها: ${stats.clips}`,
        `تم تحويلها لنص: ${stats.transcribed}`,
        `عقوبات: ${stats.punished}`,
        `اشتباهات بدون عقوبة: ${stats.suspects}`,
        `في الطابور: ${queue.length} | مهملة: ${stats.dropped} | أخطاء: ${stats.errors}`,
      ];
      return i.reply({ content: lines.join('\n'), flags: EPHEMERAL });
    }
    case 'test': {
      const text = i.options.getString('text', true);
      const hits = findBadWords(text);
      return i.reply({
        content: hits.length
          ? `🚨 يعتبرها قذف: ${hits.map((h) => `\`${h.said}\``).join('، ')}`
          : '✅ ما فيها شي يعتبره قذف.',
        flags: EPHEMERAL,
      });
    }
  }
}

async function handleUntimeout(i) {
  if (!i.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    return i.reply({ content: 'هذا الزر للمشرفين فقط.', flags: EPHEMERAL });
  }
  const userId = i.customId.split(':')[1];
  const member = await i.guild.members.fetch(userId).catch(() => null);
  if (member && member.isCommunicationDisabled()) {
    await member.timeout(null, clip(`رفع بواسطة ${i.user.tag}`, 100)).catch((e) => console.error('[untimeout]', e.message));
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('done')
      .setLabel(clip(`تم رفع التايم اوت بواسطة ${i.member?.displayName || i.user.username}`, 80))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
  return i.update({ components: [row] });
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) return await handleCommand(i);
    if (i.isButton() && i.customId.startsWith('untimeout:')) return await handleUntimeout(i);
  } catch (e) {
    console.error('[interaction] error:', e);
    if (i.isRepliable() && !i.replied && !i.deferred) {
      i.reply({ content: 'صار خطأ، حاول مرة ثانية.', flags: EPHEMERAL }).catch(() => {});
    }
  }
});

// ============================ التشغيل ============================
client.once(Events.ClientReady, async () => {
  console.log(`[bot] logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: 'حماية القذف الصوتية 🛡️', type: ActivityType.Watching }],
    status: 'online',
  });

  const guild = await client.guilds.fetch(CFG.guildId).catch(() => null);
  if (!guild) {
    console.error('[bot] ما لقيت السيرفر، تأكد من GUILD_ID وإن البوت داخله');
    return;
  }

  await guild.commands
    .set(commands.map((c) => c.toJSON()))
    .then(() => console.log('[bot] commands registered'))
    .catch((e) => console.error('[bot] commands failed:', e.message));

  if (CFG.watchChannelId) {
    const ch = await guild.channels.fetch(CFG.watchChannelId).catch(() => null);
    if (ch && ch.isVoiceBased()) {
      state.wantedChannelId = ch.id;
      try {
        await joinWatch(ch);
      } catch (e) {
        console.error('[voice] auto join failed:', e.message);
        scheduleRejoin(15000);
      }
    } else {
      console.error('[bot] WATCH_CHANNEL_ID غير صالح');
    }
  }
});

client.on('error', (e) => console.error('[client] error:', e));

client.login(CFG.token).catch((e) => {
  console.error('[bot] login failed:', e.message);
  process.exit(1);
});
