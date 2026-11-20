'use strict';

const { EventEmitter } = require('node:events');
const os = require('node:os');
const crypto = require('node:crypto');
const { loadConfig } = require('../config');
const { Logger } = require('../utils/logger');
const { RubikaApi, RubikaApiError } = require('../rubika/rubika-api');
const { VoiceApi, findValue } = require('../rubika/voice-api');
const { VoiceSession } = require('../webrtc/voice-session');
const { AudioPlayer } = require('../audio/audio-player');
const { StreamingAudioRecorder } = require('../audio/streaming-audio-recorder');
const { SessionStore } = require('../rubika/session-store');
const { RubikaAuthFlow, normalizePrivateKeyB64 } = require('../rubika/auth-flow');
const DefaultEncryption = require('../rubika/encryption');

class NullLogger {
  debug() {} info() {} warn() {} error() {}
}

function mergeConfig(defaults, provided = {}) {
  return {
    ...defaults,
    ...provided,
    api: { ...defaults.api, ...(provided.api || {}) },
    voice: { ...defaults.voice, ...(provided.voice || {}) },
    audio: { ...defaults.audio, ...(provided.audio || {}) },
    session: { ...defaults.session, ...(provided.session || {}) },
  };
}

function parseConstructor(first, second, third) {
  if (typeof first === 'string' && typeof second === 'string') {
    return { mode: 'direct', auth: first, privateKeyB64: second, options: third || {} };
  }
  if (typeof first === 'string') {
    return { mode: 'session', sessionName: first, options: (second && typeof second === 'object' ? second : third) || {} };
  }
  const options = first || {};
  if (options.auth && (options.privateKeyB64 || options.privateKey)) {
    return { mode: 'direct', auth: options.auth, privateKeyB64: options.privateKeyB64 || options.privateKey, options };
  }
  return { mode: 'session', sessionName: options.sessionName || options.config?.session?.name || null, options };
}

class VoiceClient extends EventEmitter {
  /**
   * new VoiceClient('session-name', options?)
   * new VoiceClient(auth, privateKeyB64OrPem, options?)
   * new VoiceClient({ auth, privateKeyB64, ...options })
   */
  constructor(first = {}, second, third) {
    super();
    const parsed = parseConstructor(first, second, third);
    const options = parsed.options || {};
    const defaults = loadConfig();
    this.config = mergeConfig(defaults, options.config || options);
    this.loggingEnabled = options.logging !== false && options.logs !== false && options.logger !== false;
    this.logger = options.logger && options.logger !== false ? options.logger : (this.loggingEnabled ? new Logger({ level: options.logLevel || process.env.LOG_LEVEL || 'info' }) : new NullLogger());
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.dependencies = { Encryption: options.Encryption, random: options.random, sleep: options.sleep, wrtc: options.wrtc };
    this.sessionName = parsed.mode === 'session' ? (parsed.sessionName || this.config.session.name || null) : (options.sessionName || this.config.session.persistAs || this.config.session.name || null);
    this.sessionMode = Boolean(this.sessionName);
    this.credentials = null;
    this.apiClient = null;
    this.readyPromise = null;
    this.recoveryPromise = null;
    this.voiceUpdatesTimer = null;
    this.voiceUpdatesPromise = null;
    this.sessionStore = null;
    this.sessionRead = false;
    this.closed = false;

    if (parsed.mode === 'direct') {
      this.credentials = {
        auth: parsed.auth,
        authMode: 'direct',
        privateKeyB64: normalizePrivateKeyB64(parsed.privateKeyB64),
        selfObjectGuid: this.config.selfObjectGuid || options.selfObjectGuid || '',
      };
    } else if (this.sessionName) {
      this._openSessionStore();
      // Read exactly once per client instance. The decrypted credentials stay cached in memory.
      this.credentials = this.sessionStore.get(this.sessionName);
      this.sessionRead = true;
    } else if (this.config.api.auth && this.config.api.privateKeyB64) {
      this.credentials = {
        auth: this.config.api.auth,
        authMode: 'direct',
        privateKeyB64: normalizePrivateKeyB64(this.config.api.privateKeyB64),
        selfObjectGuid: this.config.selfObjectGuid || '',
      };
    }

    this._api = { request: (method, input = {}, requestOptions = {}) => this._request(method, input, requestOptions) };
    this._voiceApi = new VoiceApi(this._api);
    this._rooms = new Map();
    this._activeRoomKey = null;
    this._defaultContext = this._createVoiceContext(null, null);
    this._activateRoom(this._defaultContext);
    this.connected = false;
    this.on('error', error => this.logger?.error('Rubika Voice error', { message: error.message }));

    if (this.credentials && !this.sessionMode) this._initializeApi();
    if (this.credentials && this.sessionName && parsed.mode === 'direct') {
      this._openSessionStore();
      this.sessionStore.save(this.sessionName, { ...this.credentials, authMode: 'direct' });
    }
  }

  _openSessionStore() {
    if (this.sessionStore) return;
    this.sessionStore = new SessionStore({
      databasePath: this.config.session.databasePath,
      keyFilePath: this.config.session.keyFilePath,
      encryptionKey: this.config.session.encryptionKey,
      logger: this.logger,
    });
  }

  _publish(event, data = {}) {
    const payload = {
      timestamp: new Date().toISOString(),
      ...data,
    };
    this.emit(event, payload);
    const aliases = {
      'connection:connecting': 'connection-connecting',
      'connection:connected': 'connection-connected',
      'connection:reconnected': 'connection-reconnected',
      'connection:disconnected': 'connection-disconnected',
      'connection:ice-state': 'connection-ice-state',
      'voice-chat:joining': 'voice-chat-joining',
      'voice-chat:joined': 'voice-chat-joined',
      'voice-chat:join-failed': 'voice-chat-join-failed',
      'voice-chat:leaving': 'voice-chat-leaving',
      'voice-chat:left': 'voice-chat-left',
      'track:starting': 'track-starting',
      'track:started': 'track-started',
      'track:changing': 'track-changing',
      'track:changed': 'track-changed',
      'track:interrupted': 'track-interrupted',
      'track:skipped': 'track-skipped',
      'track:finished': 'track-finished',
      'track:stopped': 'track-stopped',
      'track:error': 'track-error',
      'playback:started': 'playback-started',
      'playback:progress': 'playback-progress',
      'playback:finished': 'playback-finished',
      'playback:seeked': 'playback-seeked',
      'playback:speed-changed': 'playback-speed-changed',
      'playback:volume-changed': 'playback-volume-changed',
      'playback:queue-updated': 'playback-queue-updated',
      'playback:queue-empty': 'playback-queue-empty',
      'recording:starting': 'recording-starting',
      'recording:progress': 'recording-progress',
      'recording:file-created': 'recording-file-created',
      'recording:file-ready': 'recording-file-ready',
      'recording:filter-changed': 'recording-filter-changed',
      'recording:stopping': 'recording-stopping',
      'recording:failed': 'recording-failed',
      'recording:error': 'recording-error',
      'recording:no-audio': 'recording-no-audio',
    };
    const alias = aliases[event];
    if (alias) this.emit(alias, payload);
    this.emit('client-event', { event, ...payload });
    return payload;
  }

  _createVoiceContext(groupGuid, voiceChatId) {
    const session = new VoiceSession({
      voiceApi: this._voiceApi,
      logger: this.logger,
      iceTimeoutMs: this.config.voice.iceTimeoutMs,
      autoUnmute: this.config.voice.autoUnmute,
      sendActivity: this.config.voice.sendActivity,
      activityIntervalMs: this.config.voice.activityIntervalMs,
      wrtc: this.dependencies.wrtc,
    });
    const player = new AudioPlayer({
      source: session.audioSource,
      ffmpegPath: this.config.audio.ffmpegPath,
      logger: this.logger,
      frameMs: this.config.audio.frameMs,
    });
    const recorder = new StreamingAudioRecorder({
      session,
      player,
      ffmpegPath: this.config.audio.ffmpegPath,
      recordingDir: this.config.audio.recordingDir,
      keepRaw: this.config.audio.keepRaw,
      logger: this.logger,
      finalizeOnProcessExit: true,
    });
    const context = {
      key: null,
      groupGuid: groupGuid || null,
      voiceChatId: voiceChatId || null,
      state: null,
      session,
      player,
      recorder,
      connected: false,
      updatesTimer: null,
      updatesPromise: null,
      lastUsedAt: Date.now(),
    };
    this._wireRoomEvents(context);
    return context;
  }

  _roomMeta(context, extra = {}) {
    return { groupGuid: context.groupGuid || null, voiceChatId: context.voiceChatId || null, ...extra };
  }

  _activateRoom(context) {
    if (!context) return null;
    context.lastUsedAt = Date.now();
    this._activeRoomKey = context.key;
    this._session = context.session;
    this._player = context.player;
    this._recorder = context.recorder;
    this.currentGroupGuid = context.groupGuid;
    this.currentVoiceChatId = context.voiceChatId;
    this.currentVoiceChatState = context.state;
    this.connected = Boolean(context.connected || context.session.connected || context.session.joined);
    return context;
  }

  _wireRoomEvents(context) {
    const { session, player, recorder } = context;
    const meta = extra => this._roomMeta(context, extra);
    session.on('joined', event => {
      context.connected = true;
      this.emit('joined', { ...event, ...meta() });
      this._publish('voice-chat:joined', { ...event, ...meta() });
      if (this._activeRoomKey === context.key) this.connected = true;
    });
    session.on('left', event => {
      context.connected = false;
      this.emit('left', { ...(event || {}), ...meta() });
      this._publish('voice-chat:left', meta());
      if (this._activeRoomKey === context.key) this.connected = this._anyRoomConnected();
    });
    session.on('connected', () => {
      context.connected = true;
      const recovered = context.connectionWasLost;
      context.connectionWasLost = false;
      if (this._activeRoomKey === context.key) this.connected = true;
      this._publish(recovered ? 'connection:reconnected' : 'connection:connected', meta({ state: 'connected' }));
    });
    session.on('disconnected', state => {
      context.connected = false;
      context.connectionWasLost = true;
      this.emit('connection-lost', { state, ...meta() });
      this._publish('connection:disconnected', meta({ state }));
      if (this._activeRoomKey === context.key) this.connected = this._anyRoomConnected();
    });
    session.on('ice-state', state => {
      this.emit('ice-state', state);
      this._publish('connection:ice-state', meta({ state }));
    });
    session.on('connection-state', state => this._publish('connection:state', meta({ state })));
    session.on('speak-requested', () => this._publish('voice-chat:speak-requested', meta()));
    session.on('muted', muted => this._publish(muted ? 'voice-chat:muted' : 'voice-chat:unmuted', meta({ muted })));
    session.on('remote-audio-frame', event => this.emit('remote-audio-frame', { ...event, ...meta() }));
    session.on('remote-track', event => {
      this.emit('remote-track', { ...event, ...meta() });
      this._publish('remote-track:added', meta({ trackId: event.trackId, track: event.track, participantObjectGuid: event.participantObjectGuid || null, streamIds: event.streamIds || [] }));
    });
    session.on('remote-track-ended', event => {
      this.emit('remote-track-ended', { ...event, ...meta() });
      this._publish('remote-track:removed', meta(event));
    });

    player.on('audio-frame', event => {
      session.noteOutgoingFrame(event.samples).catch(() => {});
      this.emit('outgoing-audio-frame', { ...event, ...meta() });
    });
    player.on('error', error => {
      this.emit('error', error);
      this._publish('playback:error', meta({ error, message: error.message }));
    });
    const playerEvents = {
      'track-starting': 'track:starting', 'track-started': 'track:started', 'track-changing': 'track:changing',
      'track-changed': 'track:changed', 'track-interrupted': 'track:interrupted', 'track-skipped': 'track:skipped',
      'track-finished': 'track:finished', 'track-stopped': 'track:stopped', 'track-error': 'track:error',
      'queue-updated': 'playback:queue-updated', 'queue-cleared': 'playback:queue-cleared',
      'queue-item-removed': 'playback:queue-item-removed', 'queue-empty': 'playback:queue-empty',
      progress: 'playback:progress', 'playback-started': 'playback:started', 'playback-finished': 'playback:finished',
      seeked: 'playback:seeked', 'speed-changed': 'playback:speed-changed', 'volume-changed': 'playback:volume-changed',
      'state-changed': 'playback:state', 'decoder-started': 'playback:decoder-started', 'decoder-restarted': 'playback:decoder-restarted',
    };
    for (const [event, published] of Object.entries(playerEvents)) player.on(event, data => this._publish(published, meta(data || {})));
    player.on('ended', event => this.emit('track-ended', { ...event, ...meta() }));
    player.on('playing', event => this.emit('track-playing', { ...event, ...meta() }));
    player.on('queued', event => { this.emit('track-queued', { ...event, ...meta() }); this._publish('track:queued', meta(event || {})); });
    player.on('paused', event => { this.emit('playback-paused', { ...event, ...meta() }); this._publish('playback:paused', meta(event || {})); });
    player.on('resumed', event => { this.emit('playback-resumed', { ...event, ...meta() }); this._publish('playback:resumed', meta(event || {})); });
    player.on('stopped', event => { this.emit('playback-stopped', { ...event, ...meta() }); this._publish('playback:stopped', meta(event || {})); });

    recorder.on('error', error => {
      this.emit('error', error);
      this._publish('recording:error', meta({ error, message: error.message }));
    });
    const recorderEvents = {
      starting: 'recording:starting', started: 'recording:started', progress: 'recording:progress',
      'file-created': 'recording:file-created', 'file-ready': 'recording:file-ready', 'filter-changed': 'recording:filter-changed',
      stopping: 'recording:stopping', stopped: 'recording:stopped', failed: 'recording:failed',
      'no-audio': 'recording:no-audio',
    };
    for (const [event, published] of Object.entries(recorderEvents)) recorder.on(event, data => {
      if (event === 'started') this.emit('recording-started', { ...data, ...meta() });
      if (event === 'stopped') this.emit('recording-stopped', { ...data, ...meta() });
      this._publish(published, meta(data || {}));
    });
  }

  _anyRoomConnected() {
    const room = this._rooms.values().next().value;
    return Boolean(room && (room.connected || room.session.connected || room.session.joined));
  }

  _roomKey(groupGuid, voiceChatId) { return `${String(groupGuid)}\u0000${String(voiceChatId)}`; }

  _findRoom() {
    if (this._activeRoomKey && this._rooms.has(this._activeRoomKey)) return this._rooms.get(this._activeRoomKey);
    return this._rooms.values().next().value || this._defaultContext || null;
  }

  _requireRoom() {
    const room = this._findRoom();
    if (!room) throw new Error('Join a Voice Chat first.');
    return this._activateRoom(room);
  }

  _syncCredentials() {
    if (!this.credentials) return;
    const Encryption = this.dependencies.Encryption || DefaultEncryption;
    const created = this.credentials.authMode === 'created-session';
    const requestAuth = created ? Encryption.changeAuthType(this.credentials.auth) : this.credentials.auth;
    this.apiConfig = { ...this.config.api, auth: requestAuth, privateKeyB64: this.credentials.privateKeyB64 };
    if (created) this.apiConfig.encryptionAuth = this.credentials.auth;
    else delete this.apiConfig.encryptionAuth;
    this.config.selfObjectGuid = this.credentials.selfObjectGuid || this.config.selfObjectGuid || '';
  }

  _initializeApi() {
    if (this.apiClient) return this.apiClient;
    if (!this.credentials?.auth || !this.credentials?.privateKeyB64) {
      throw new Error('Rubika credentials are not available. Call start() to load or create a named session.');
    }
    this._syncCredentials();
    this.apiClient = new RubikaApi({
      config: this.apiConfig,
      logger: this.logger,
      fetchImpl: this.fetchImpl,
      EncryptionClass: this.dependencies.Encryption,
      ...(this.dependencies.random ? { random: this.dependencies.random } : {}),
      ...(this.dependencies.sleep ? { sleep: this.dependencies.sleep } : {}),
    });
    return this.apiClient;
  }

  _expectedAppVersion() {
    const version = String(this.config.api.client?.app_version || '').trim();
    if (!version) throw new Error('RUBIKA_APP_VERSION is required for registerDevice.');
    const prefix = String(this.config.api.clientVersionPrefix ?? 'WB_');
    return version.startsWith(prefix) ? version : `${prefix}${version}`;
  }

  async _registerDevice(credentials) {
    if (this.config.session.registerDevice === false) throw new Error('registerDevice is mandatory for a newly created session.');
    const appVersion = this._expectedAppVersion();
    const input = {
      token_type: 'Web', token: '', app_version: appVersion,
      lang_code: this.config.api.client?.lang_code || 'fa',
      system_version: `${os.type()} ${os.release()} / Node ${process.version}`,
      device_model: `Node.js ${os.platform()} ${os.arch()}`,
      device_hash: credentials.deviceHash || crypto.randomUUID(),
    };
    const response = await this.apiClient.request('registerDevice', input);
    const status = response?.status ?? response?.data?.status;
    if (!['OK', 'DONE'].includes(String(status || '').toUpperCase())) throw new Error(`registerDevice failed: ${status || 'unknown status'}`);
    const result = response?.data && typeof response.data === 'object' ? { ...response, ...response.data } : response;
    const encryptedAuth = result?.auth_enc || result?.encrypted_auth || result?.auth;
    const updated = { ...credentials, deviceHash: input.device_hash, registeredAppVersion: appVersion };
    if (typeof encryptedAuth === 'string' && encryptedAuth) {
      const Encryption = this.dependencies.Encryption || DefaultEncryption;
      const pem = DefaultEncryption.loadPrivateKeyFromBase64(credentials.privateKeyB64);
      const decrypt = Encryption.decryptOAEPAuth || Encryption.decryptRsaOaep;
      updated.auth = decrypt.call(Encryption, pem, encryptedAuth);
      this.credentials = updated;
      this.apiClient = null;
      this._initializeApi();
    }
    return updated;
  }

  async _ensureReady(options = {}) {
    if (this.closed) throw new Error('VoiceClient is closed.');
    if (this.apiClient && !this.sessionMode) return this.apiClient;
    if (this.apiClient && this.credentials?.authMode !== 'created-session') return this.apiClient;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = (async () => {
      if (this.credentials) {
        // A persisted session has already passed registerDevice during its creation.
        // App-version changes must not trigger another device registration.
        this._initializeApi();
        this.emit('session:loaded', { sessionName: this.sessionName || null });
        return this.apiClient;
      }

      if (!this.sessionName) throw new Error('No credentials found. Use new VoiceClient(sessionName) or new VoiceClient(auth, privateKey).');
      if (this.config.session.interactive === false && !options.prompts) {
        throw new Error(`Session "${this.sessionName}" does not exist and interactive login is disabled.`);
      }
      this.emit('session:missing', { sessionName: this.sessionName });
      const flow = new RubikaAuthFlow({
        apiConfig: this.config.api,
        fetchImpl: this.fetchImpl,
        logger: this.logger,
        Encryption: this.dependencies.Encryption,
        random: this.dependencies.random,
      });
      let credentials = await flow.login({
        phoneNumber: options.phoneNumber,
        code: options.code,
        twoStepPassword: options.twoStepPassword,
        prompts: options.prompts,
        signal: options.signal,
      });
      this.credentials = credentials;
      this.apiClient = null;
      this._initializeApi();
      try {
        credentials = await this._registerDevice(credentials);
        this.credentials = credentials;
        this.sessionStore.save(this.sessionName, credentials);
      } catch (error) {
        this.credentials = null;
        this.apiClient = null;
        throw error;
      }
      this.emit('session:created', { sessionName: this.sessionName, user: credentials.user || null });
      return this.apiClient;
    })();

    try { return await this.readyPromise; }
    catch (error) { this.readyPromise = null; this.emit('session:error', error); throw error; }
  }

  async _recoverInvalidSession(error) {
    if (!this.sessionName || !this.sessionMode) throw error;
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = (async () => {
      this.logger?.warn('Rubika session is no longer registered; deleting it and starting a fresh login.', { status: error.status });
      this.sessionStore?.delete(this.sessionName);
      this.credentials = null;
      this.apiClient = null;
      this.readyPromise = null;
      this.emit('session:invalidated', { sessionName: this.sessionName, status: error.status });
      await this._ensureReady({});
    })();
    try { await this.recoveryPromise; }
    finally { this.recoveryPromise = null; }
  }

  async _request(method, input = {}, options = {}) {
    await this._ensureReady(options);
    try {
      return await this.apiClient.request(method, input, options);
    } catch (error) {
      const status = String(error.status || '').toUpperCase();
      const statusDet = String(error.statusDet || '').toUpperCase();
      if (status === 'TOO_REQUESTS' || statusDet === 'TOO_REQUESTS') {
        this.emit('rate-limit', { method, status: error.status, statusDet: error.statusDet, error });
        throw error;
      }
      if ((status === 'NOT_REGISTERED' || statusDet === 'NOT_REGISTERED') && this.sessionMode && options._sessionRetry !== true) {
        await this._recoverInvalidSession(error);
        return this.apiClient.request(method, input, { ...options, _sessionRetry: true });
      }
      throw error;
    }
  }

  async start(options = {}) {
    this._publish('client:starting', { sessionName: this.sessionName || null });
    await this._ensureReady(options);
    const ready = { sessionName: this.sessionName || null, selfObjectGuid: this.config.selfObjectGuid || '' };
    this.emit('ready', ready);
    this._publish('client:ready', ready);
    return this;
  }

  async _resolveSelfObjectGuid() {
    if (this.credentials?.selfObjectGuid || this.config.selfObjectGuid) {
      return this.credentials?.selfObjectGuid || this.config.selfObjectGuid;
    }
    const userInfo = await this._request('getUserInfo', { user_guid: undefined });
    const guid = userInfo?.data?.user?.user_guid
      || userInfo?.user?.user_guid
      || findValue(userInfo?.data?.user || userInfo?.user || userInfo, 'user_guid');
    if (!guid) throw new Error('getUserInfo did not return data.user.user_guid; provide RUBIKA_SELF_OBJECT_GUID or verify the session.');
    this.config.selfObjectGuid = guid;
    if (this.credentials) this.credentials.selfObjectGuid = guid;
    if (this.sessionName && this.sessionStore && this.credentials) this.sessionStore.save(this.sessionName, this.credentials);
    return guid;
  }

  async joinVoiceChat(groupGuid, options = {}) {
    if (typeof groupGuid !== 'string' || !groupGuid.trim()) throw new TypeError('joinVoiceChat(groupGuid) requires the group GUID.');

    const current = this._rooms.values().next().value;
    if (current?.session.joined) {
      if (current.groupGuid !== groupGuid) {
        throw new Error('This VoiceClient supports one active Voice Chat at a time. Call leaveVoiceChat() before joining another group.');
      }
      this._activateRoom(current);
      return { groupGuid: current.groupGuid, voiceChatId: current.voiceChatId, alreadyJoined: true };
    }
    if (current && current.groupGuid !== groupGuid) {
      throw new Error('A different Voice Chat context is still active. Call leaveVoiceChat() before joining another group.');
    }

    this._publish('voice-chat:joining', { groupGuid });
    try {
      await this.start(options.session || {});
      const selfObjectGuid = await this._resolveSelfObjectGuid();
      const resolved = await this._voiceApi.resolveGroupVoiceChat(groupGuid, { createIfMissing: options.createIfMissing !== false });
      const voiceChatId = String(resolved.voiceChatId);
      const key = this._roomKey(groupGuid, voiceChatId);
      let context = current || this._rooms.get(key);
      if (context?.session.joined) {
        this._activateRoom(context);
        return { groupGuid, voiceChatId, alreadyJoined: true };
      }
      if (context) {
        context.groupGuid = groupGuid;
        context.voiceChatId = voiceChatId;
        context.key = key;
      } else if (this._defaultContext) {
        context = this._defaultContext;
        this._defaultContext = null;
        context.groupGuid = groupGuid;
        context.voiceChatId = voiceChatId;
        context.key = key;
      } else {
        context = this._createVoiceContext(groupGuid, voiceChatId);
        context.key = key;
      }
      this._rooms.clear();
      this._rooms.set(key, context);
      this._activateRoom(context);

      try {
        const initialParticipants = await this._voiceApi.getParticipants({ chatGuid: groupGuid, voiceChatId });
        if (initialParticipants?.state) context.state = initialParticipants.state;
        const participants = initialParticipants?.participants || [];
        this.emit('participants', participants);
        this._publish('voice-chat:participants', this._roomMeta(context, { participants }));
      } catch (error) {
        this.emit('voice-chat-update-error', error);
        this._publish('voice-chat:update-error', this._roomMeta(context, { error, message: error.message, stage: 'initial-participants' }));
      }

      context.session.ensureMediaSource();
      context.player.setSource(context.session.audioSource);
      this._publish('connection:connecting', this._roomMeta(context));
      const result = await context.session.connect({ chatGuid: groupGuid, voiceChatId, selfObjectGuid });
      context.connected = true;
      this._activateRoom(context);
      const joined = { ...result, groupGuid, voiceChatId, created: resolved.created };
      this.emit('voice-chat-ready', joined);
      this._publish('voice-chat:ready', joined);
      if (context.state) this.startVoiceChatUpdates();
      return joined;
    } catch (error) {
      this._publish('voice-chat:join-failed', { groupGuid, error, message: error.message });
      throw error;
    }
  }

  connect(groupGuid, options = {}) { return this.joinVoiceChat(groupGuid, options); }

  async leaveVoiceChat() {
    const context = this._requireRoom();
    return this._disconnectRoom(context, { leave: true });
  }

  mute() { return this._requireRoom().session.mute(); }
  unmute() { return this._requireRoom().session.unmute(); }

  async requestSpeak() {
    const room = this._requireRoom();
    const result = await this._voiceApi.requestSpeak({ chatGuid: room.groupGuid, voiceChatId: room.voiceChatId, participantObjectGuid: this.config.selfObjectGuid });
    this._publish('voice-chat:speak-requested', this._roomMeta(room, { result }));
    return result;
  }

  async getParticipants({ startId } = {}) {
    const room = this._requireRoom();
    const page = await this._voiceApi.getParticipants({ chatGuid: room.groupGuid, voiceChatId: room.voiceChatId, startId });
    if (page?.state) room.state = page.state;
    this._publish('voice-chat:participants-page', this._roomMeta(room, { participants: page?.participants || [], hasContinue: Boolean(page?.has_continue), nextStartId: page?.next_start_id || null }));
    return page;
  }

  async getAllParticipants() {
    const room = this._requireRoom();
    const participants = [];
    const seenCursors = new Set();
    let startId;
    for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
      const page = await this._voiceApi.getParticipants({ chatGuid: room.groupGuid, voiceChatId: room.voiceChatId, startId });
      participants.push(...(page?.participants || []));
      if (page?.state) room.state = page.state;
      const next = page?.next_start_id;
      if (!page?.has_continue || !next || seenCursors.has(next)) break;
      seenCursors.add(next);
      startId = next;
    }
    this._publish('voice-chat:participants', this._roomMeta(room, { participants, count: participants.length }));
    return participants;
  }

  getVoiceChatParticipants(options = {}) {
    return options.all === false ? this.getParticipants({ startId: options.startId }) : this.getAllParticipants();
  }

  startVoiceChatUpdates({ intervalMs = 15000 } = {}) {
    const room = this._requireRoom();
    if (!room.state) throw new Error('Voice Chat state is not available.');
    if (room.updatesTimer) return false;
    const interval = Math.max(5000, Number(intervalMs) || 15000);
    const poll = () => {
      if (room.updatesPromise) return;
      room.updatesPromise = this.getVoiceChatUpdates()
        .catch(error => { this.emit('voice-chat-update-error', error); this._publish('voice-chat:update-error', this._roomMeta(room, { error, message: error.message, stage: 'poll' })); })
        .finally(() => { room.updatesPromise = null; });
    };
    poll();
    room.updatesTimer = setInterval(poll, interval);
    room.updatesTimer.unref?.();
    this.emit('voice-chat-updates-started', this._roomMeta(room, { intervalMs: interval }));
    this._publish('voice-chat:updates-started', this._roomMeta(room, { intervalMs: interval }));
    return true;
  }

  stopVoiceChatUpdates() {
    const room = this._requireRoom();
    if (!room.updatesTimer) return false;
    clearInterval(room.updatesTimer);
    room.updatesTimer = null;
    this.emit('voice-chat-updates-stopped', this._roomMeta(room));
    this._publish('voice-chat:updates-stopped', this._roomMeta(room));
    return true;
  }

  async getVoiceChatUpdates() {
    const room = this._requireRoom();
    if (!room.state) throw new Error('Voice Chat state is not available.');
    const updates = await this._voiceApi.getUpdates({ chatGuid: room.groupGuid, voiceChatId: room.voiceChatId, state: room.state });
    if (updates?.new_state) room.state = updates.new_state;
    if (String(updates?.status || '').toUpperCase() === 'OLDSTATE') {
      const page = await this._voiceApi.getParticipants({ chatGuid: room.groupGuid, voiceChatId: room.voiceChatId });
      if (page?.state) room.state = page.state;
      this.emit('participants-reset', page?.participants || []);
      this._publish('voice-chat:participants-reset', this._roomMeta(room, { participants: page?.participants || [] }));
    }
    if (Array.isArray(updates?.group_voice_chat_participant_updates)) {
      this.emit('participant-updates', updates.group_voice_chat_participant_updates);
      this._publish('voice-chat:participant-updates', this._roomMeta(room, { updates: updates.group_voice_chat_participant_updates }));
    }
    if (updates?.group_voice_chat_update) {
      this.emit('voice-chat-update', updates.group_voice_chat_update);
      this._publish('voice-chat:update', this._roomMeta(room, { update: updates.group_voice_chat_update }));
    }
    this.emit('voice-chat-updates', updates);
    this._publish('voice-chat:updates', this._roomMeta(room, { updates }));
    return updates;
  }

  async muteParticipant(participantObjectGuid) {
    const room = this._requireRoom();
    return this._voiceApi.setState({ chatGuid: room.groupGuid, voiceChatId: room.voiceChatId, action: 'Mute', participantObjectGuid });
  }

  async unmuteParticipant(participantObjectGuid) {
    const room = this._requireRoom();
    return this._voiceApi.setState({ chatGuid: room.groupGuid, voiceChatId: room.voiceChatId, action: 'Unmute', participantObjectGuid });
  }

  async setVoiceChatSettings(settings = {}) {
    const room = this._requireRoom();
    return this._voiceApi.setSettings({ chatGuid: room.groupGuid, voiceChatId: room.voiceChatId, ...settings });
  }

  async discardVoiceChat() {
    const room = this._requireRoom();
    this._publish('voice-chat:discarding', this._roomMeta(room));
    const result = await this._voiceApi.discard({ chatGuid: room.groupGuid, voiceChatId: room.voiceChatId });
    this._publish('voice-chat:discarded', this._roomMeta(room, { result }));
    await this._disconnectRoom(room, { leave: false });
    return result;
  }

  play(file) { return this._requireRoom().player.play(file); }
  enqueue(file) { return this._requireRoom().player.enqueue(file); }
  enqueueMany(files) { return this._requireRoom().player.enqueueMany(files); }
  next() { return this._requireRoom().player.next(); }
  previous() { return this._requireRoom().player.previous(); }
  pause() { return this._requireRoom().player.pause(); }
  resume() { return this._requireRoom().player.resume(); }
  stop() { return this._requireRoom().player.stop(); }
  seek(seconds) { return this._requireRoom().player.seek(seconds); }
  setSpeed(speed) { return this._requireRoom().player.setSpeed(speed); }
  setPlaybackSpeed(speed) { return this.setSpeed(speed); }
  increasePlaybackSpeed(step = 0.1) {
    const player = this._requireRoom().player;
    const amount = Number(step);
    if (!Number.isFinite(amount) || amount <= 0) throw new RangeError('Speed step must be a positive number.');
    return player.setSpeed(Math.min(2, player.speed + amount));
  }
  decreasePlaybackSpeed(step = 0.1) {
    const player = this._requireRoom().player;
    const amount = Number(step);
    if (!Number.isFinite(amount) || amount <= 0) throw new RangeError('Speed step must be a positive number.');
    return player.setSpeed(Math.max(0.5, player.speed - amount));
  }
  resetPlaybackSpeed() { return this.setSpeed(1); }
  setVolume(percent) { return this._requireRoom().player.setVolume(percent); }
  setPlaybackVolume(percent) { return this.setVolume(percent); }
  getPlaybackStatus() { return this._requireRoom().player.getState(); }
  getQueue() { return this._requireRoom().player.getQueue(); }
  clearQueue() { return this._requireRoom().player.clearQueue(); }
  removeFromQueue(index) { return this._requireRoom().player.removeFromQueue(index); }

  startRecording(options = {}) {
    const room = this._requireRoom();
    if (!room.session.joined) throw new Error('Join a Voice Chat before recording.');
    return room.recorder.start(options);
  }

  startAllParticipantsRecording(options = {}) { return this.startRecording(options); }

  setRecordingFilter(filter = {}) {
    return this._requireRoom().recorder.setRecordingFilter(filter);
  }

  stopRecording(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('stopRecording options must be an object.');
    const unsupported = Object.keys(options).filter(key => key !== 'reason');
    if (unsupported.length) throw new TypeError(`Unsupported stopRecording option: ${unsupported.join(', ')}. No group or Voice Chat IDs are required.`);
    return this._requireRoom().recorder.stop(options);
  }

  getRecordingFiles() {
    return this._requireRoom().recorder.files.map(file => ({ ...file }));
  }

  getStatus() {
    const room = this._findRoom();
    if (!room) return {
      authenticated: Boolean(this.apiClient), sessionName: this.sessionName, connected: false,
      groupGuid: null, voiceChatId: null,
    };
    this._activateRoom(room);
    return {
      authenticated: Boolean(this.apiClient), sessionName: this.sessionName,
      connected: Boolean(room.connected || room.session.connected || room.session.joined),
      groupGuid: room.groupGuid, voiceChatId: room.voiceChatId,
      muted: room.session.muted,
      playback: room.player.status, recording: room.recorder.active,
      currentFile: room.player.currentFile, playbackPosition: room.player.currentTime,
      playbackSpeed: room.player.speed, playbackVolume: Math.round(room.player.volume * 100),
      playbackQueue: room.player.getQueue(), playbackBufferedMs: room.player.bufferedMs,
      recordingDetails: room.recorder.active ? room.recorder._progressData() : null,
    };
  }

  async _disconnectRoom(room, { leave = true } = {}) {
    const oldGroupGuid = room.groupGuid;
    const oldVoiceChatId = room.voiceChatId;
    let recordingPath = null;
    let cleanupError = null;
    if (leave) this._publish('voice-chat:leaving', this._roomMeta(room));
    if (room.updatesTimer) { clearInterval(room.updatesTimer); room.updatesTimer = null; }
    try {
      if (room.recorder.active) recordingPath = await room.recorder.stop({ reason: 'voice-chat-leave' });
    } catch (error) { cleanupError = error; }
    try { await room.player.stop(); } catch (error) { cleanupError ||= error; }
    const wasJoined = room.session.joined;
    try {
      if (leave && wasJoined) await room.session.leave();
      else await room.session.close();
    } catch (error) {
      cleanupError ||= error;
      await room.session.close().catch(() => {});
    }
    room.connected = false;
    await room.player.close().catch(error => { cleanupError ||= error; });
    if (!wasJoined && leave) this._publish('voice-chat:left', this._roomMeta(room, { reason: 'connection-already-closed' }));
    if (room.key) this._rooms.delete(room.key);
    if (this._activeRoomKey === room.key) {
      const next = [...this._rooms.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] || null;
      this._activeRoomKey = next?.key || null;
      if (next) this._activateRoom(next);
      else {
        this._session = this._defaultContext?.session || null;
        this._player = this._defaultContext?.player || null;
        this._recorder = this._defaultContext?.recorder || null;
        this.currentGroupGuid = null;
        this.currentVoiceChatId = null;
        this.currentVoiceChatState = null;
        this.connected = false;
      }
    }
    const result = { recordingPath, groupGuid: oldGroupGuid, voiceChatId: oldVoiceChatId, leave };
    if (!leave) this._publish('voice-chat:left', this._roomMeta(room, { reason: 'local-close' }));
    if (this._rooms.size === 0) {
      this.emit('disconnected', result);
      this._publish('client:disconnected', result);
    } else {
      this.emit('voice-chat-disconnected', result);
    }
    if (cleanupError) throw cleanupError;
    return result;
  }

  async disconnect(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('disconnect options must be an object.');
    const unsupported = Object.keys(options).filter(key => key !== 'leave');
    if (unsupported.length) throw new TypeError(`Unsupported disconnect option: ${unsupported.join(', ')}. This client manages one Voice Chat only.`);
    const { leave = true } = options;
    const room = this._findRoom() || this._defaultContext;
    if (!room) return { recordingPath: null, leave };
    return this._disconnectRoom(room, { leave });
  }

  deleteSession(name = this.sessionName) {
    if (!name) throw new Error('Session name is required.');
    this._openSessionStore();
    const removed = this.sessionStore.delete(name);
    if (name === this.sessionName) { this.credentials = null; this.apiClient = null; this.readyPromise = null; }
    return removed;
  }

  async close() {
    if (this.closed) return;
    this._publish('client:closing', { sessionName: this.sessionName || null });
    try { await this.disconnect({ leave: true }); }
    finally {
      if (this._defaultContext) {
        await this._defaultContext.recorder.stop().catch(() => {});
        await this._defaultContext.player.close().catch(() => {});
        await this._defaultContext.session.close().catch(() => {});
      }
      this.sessionStore?.close();
      this.closed = true;
      this.emit('closed');
      this._publish('client:closed', { sessionName: this.sessionName || null });
    }
  }
}

module.exports = { VoiceClient, RubikaApiError };
