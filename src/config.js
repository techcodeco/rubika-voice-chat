'use strict';

const path = require('node:path');
const fs = require('node:fs');

function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

loadDotEnv();

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function loadConfig(env = process.env) {
  return {
    api: {
      // Match jsrubi's API DC strategy: choose messengerg2c1..269 when no
      // explicit URL is pinned. Set RUBIKA_API_URL to override this behavior.
      url: env.RUBIKA_API_URL?.trim() || null,
      randomDc: bool(env.RUBIKA_API_RANDOM_DC, true),
      dcMin: number(env.RUBIKA_API_DC_MIN, 1, 1, 269),
      dcMax: number(env.RUBIKA_API_DC_MAX, 269, 1, 269),
      maxAttempts: number(env.RUBIKA_API_MAX_ATTEMPTS, 3, 1, 8),
      version: String(env.RUBIKA_API_VERSION || '6'),
      auth: env.RUBIKA_AUTH || '',
      privateKeyB64: env.RUBIKA_PRIVATE_KEY_B64 || '',
      clientVersionPrefix: env.RUBIKA_CLIENT_VERSION_PREFIX || 'WB_',
      timeoutMs: number(env.RUBIKA_API_TIMEOUT_MS, 20000, 1000, 120000),
      userAgent: env.RUBIKA_USER_AGENT || 'Mozilla/5.0 (Linux; U; Android 12; en; M2004J19C Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.0.0 Mobile Safari/537.36',
      referer: env.RUBIKA_REFERER || 'https://web.rubika.ir/',
      client: {
        app_name: env.RUBIKA_APP_NAME || 'Main',
        app_version: env.RUBIKA_APP_VERSION || '4.4.34',
        platform: env.RUBIKA_PLATFORM || 'Web',
        package: env.RUBIKA_PACKAGE || 'web.rubika.ir',
        lang_code: env.RUBIKA_LANG_CODE || 'fa',
      },
    },
    selfObjectGuid: env.RUBIKA_SELF_OBJECT_GUID || '',
    session: {
      name: env.RUBIKA_SESSION_NAME || null,
      databasePath: env.RUBIKA_SESSION_DATABASE || './sessions/rubika.sqlite',
      keyFilePath: env.RUBIKA_SESSION_KEY_FILE || null,
      encryptionKey: env.RUBIKA_SESSION_ENCRYPTION_KEY || null,
      interactive: bool(env.RUBIKA_SESSION_INTERACTIVE, true),
      registerDevice: bool(env.RUBIKA_SESSION_REGISTER_DEVICE, true),
      persistAs: env.RUBIKA_SESSION_PERSIST_AS || null,
    },
    voice: {
      autoUnmute: bool(env.VOICE_AUTO_UNMUTE, true),
      iceTimeoutMs: number(env.VOICE_ICE_TIMEOUT_MS, 30000, 5000, 120000),
      sendActivity: bool(env.VOICE_SEND_ACTIVITY, true),
      activityIntervalMs: number(env.VOICE_ACTIVITY_INTERVAL_MS, 2000, 1000, 30000),
      leaveOnExit: bool(env.VOICE_LEAVE_ON_EXIT, true),
    },
    audio: {
      ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
      ffprobePath: env.FFPROBE_PATH || 'ffprobe',
      sampleRate: number(env.AUDIO_SAMPLE_RATE, 48000, 48000, 48000),
      channels: number(env.AUDIO_CHANNELS, 1, 1, 1),
      frameMs: number(env.AUDIO_FRAME_MS, 10, 10, 10),
      recordingDir: path.resolve(env.RECORDING_DIR || './recordings'),
      keepRaw: bool(env.RECORDING_KEEP_RAW, false),
    },
  };
}

module.exports = { loadConfig, bool };
