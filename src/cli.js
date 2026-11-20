'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const { VoiceClient } = require('./core/voice-client');
const { loadConfig } = require('./config');
const { Logger } = require('./utils/logger');

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { result._.push(token); continue; }
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) result[key] = inlineValue;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) result[key] = argv[++i];
    else result[key] = true;
  }
  return result;
}

function help() {
  process.stdout.write(`
Rubika Voice — Voice Chat only

Usage:
  node src/cli.js doctor
  node src/cli.js play --group-guid GROUP_GUID --file ./song.mp3
  node src/cli.js play --group-guid GROUP_GUID --file ./song.mp3 --record --recording-output ./recordings/call.ogg --consent-confirmed

Authentication:
  Set RUBIKA_SESSION_NAME for automatic session creation/reuse, or configure RUBIKA_AUTH and RUBIKA_PRIVATE_KEY_B64.

Options:
  --group-guid          Rubika group GUID (voice_chat_id is resolved automatically)
  --file                Audio file (MP3/WAV/OGG/FFmpeg-supported format)
  --record              Start recording after joining
  --recording-output    .ogg or .mp3 output path
  --record-format       ogg or mp3
  --consent-confirmed   Explicit confirmation that participants agreed to recording
  --no-auto-unmute      Do not unmute automatically after joining

Commands after joining:
  pause | resume | stop | next | previous | seek SECONDS
  speed 0.5..2 | volume 0..200 | mute | unmute
  record-start [FILE.ogg|FILE.mp3] | record-stop | status | quit
`);
}

function checkBinary(binary) {
  const result = spawnSync(binary, ['-version'], { encoding: 'utf8' });
  return result.status === 0 ? (result.stdout || '').split('\n')[0] : null;
}

async function doctor() {
  const config = loadConfig();
  const ffmpeg = checkBinary(config.audio.ffmpegPath);
  const ffprobe = checkBinary(config.audio.ffprobePath);
  let wrtc = 'not loaded';
  try {
    const loaded = require('@roamhq/wrtc');
    wrtc = loaded.nonstandard?.RTCAudioSource && loaded.nonstandard?.RTCAudioSink ? 'available' : 'missing audio source/sink API';
  } catch (error) { wrtc = `failed: ${error.message}`; }
  const report = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    ffmpeg: ffmpeg || 'NOT FOUND',
    ffprobe: ffprobe || 'NOT FOUND (optional)',
    wrtc,
    sessionNameConfigured: Boolean(config.session.name),
    directAuthConfigured: Boolean(config.api.auth && config.api.privateKeyB64),
    selfObjectGuidConfigured: Boolean(config.selfObjectGuid),
  };
  for (const [key, value] of Object.entries(report)) process.stdout.write(`${key.padEnd(25)} ${value}\n`);
  if (!ffmpeg || wrtc !== 'available') process.exitCode = 1;
}

function requireArg(value, name) {
  if (!value || value === true) throw new Error(`Missing required option --${name}.`);
  return String(value);
}

async function runInteractive(client, options, logger) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  logger.info('Connected. Type `help` to see commands; `quit` to leave.');
  rl.setPrompt('voice> '); rl.prompt();
  rl.on('line', async line => {
    const [command, ...parts] = line.trim().split(/\s+/);
    try {
      switch ((command || '').toLowerCase()) {
        case '': break;
        case 'help': help(); break;
        case 'pause': client.pause(); break;
        case 'resume': client.resume(); break;
        case 'stop': await client.stop(); break;
        case 'next': await client.next(); break;
        case 'previous': await client.previous(); break;
        case 'seek': await client.seek(Number(parts[0])); break;
        case 'speed': await client.setSpeed(Number(parts[0])); break;
        case 'volume': client.setVolume(Number(parts[0])); break;
        case 'mute': await client.mute(); break;
        case 'unmute': await client.unmute(); break;
        case 'record-start': {
          if (!options.consentConfirmed) throw new Error('Start CLI with --consent-confirmed after confirming participant consent.');
          await client.startRecording({ output: parts[0] || options.recordingOutput, format: options.recordFormat, consentConfirmed: true });
          break;
        }
        case 'record-stop': logger.info('Recording saved', { output: await client.stopRecording() }); break;
        case 'status': logger.info('Current status', client.getStatus()); break;
        case 'quit':
        case 'exit': rl.close(); return;
        default: logger.warn('Unknown command. Type help.');
      }
    } catch (error) { logger.error(error.message); }
    rl.prompt();
  });
  await new Promise(resolve => rl.once('close', resolve));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  if (command === 'help' || args.help) return help();
  if (command === 'doctor') return doctor();
  if (command !== 'play') throw new Error(`Unknown command: ${command}`);

  const config = loadConfig();
  if (args.noAutoUnmute) config.voice.autoUnmute = false;
  const logger = new Logger({ level: process.env.LOG_LEVEL || 'info' });
  const groupGuid = requireArg(args.groupGuid, 'group-guid');
  const file = args.file ? path.resolve(requireArg(args.file, 'file')) : null;
  if (!file || !fs.existsSync(file)) throw new Error('--file must point to an existing audio file.');
  const consentConfirmed = args.consentConfirmed === true || String(args.consentConfirmed).toLowerCase() === 'true';
  if (args.record && !consentConfirmed) throw new Error('Recording was requested but --consent-confirmed was not supplied.');

  const client = new VoiceClient({ config, logger });
  client.on('error', error => logger.error('Voice engine error', { message: error.message }));
  client.on('ice-state', state => logger.info('ICE', { state }));
  client.on('joined', () => logger.info('Voice chat joined', { groupGuid }));
  client.on('connection-lost', state => logger.warn('WebRTC connection changed', { state }));
  client.on('track-ended', event => logger.info('Track ended', event));

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await client.close(); } catch (error) { logger.error('Disconnect error', { message: error.message }); }
  };
  process.once('SIGINT', async () => { await shutdown(); process.exit(130); });
  process.once('SIGTERM', async () => { await shutdown(); process.exit(143); });

  try {
    await client.start();
    await client.joinVoiceChat(groupGuid);
    if (args.record) await client.startRecording({ output: args.recordingOutput, format: args.recordFormat, source: 'all', consentConfirmed: true });
    await client.play(file);
    await runInteractive(client, { ...args, consentConfirmed }, logger);
  } finally { await shutdown(); }
}

main().catch(error => { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; });
