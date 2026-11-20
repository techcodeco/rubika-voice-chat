'use strict';

function unwrapData(response) {
  let value = response;
  for (let i = 0; i < 4; i += 1) {
    if (value && typeof value === 'object' && value.data && typeof value.data === 'object') value = value.data;
    else break;
  }
  return value;
}

function findValue(object, key, seen = new Set()) {
  if (!object || typeof object !== 'object' || seen.has(object)) return undefined;
  seen.add(object);
  if (Object.prototype.hasOwnProperty.call(object, key)) return object[key];
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object') {
      const found = findValue(value, key, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

class VoiceApi {
  constructor(rubikaApi) { this.api = rubikaApi; }

  async getGroupInfo(groupGuid) {
    const response = await this.api.request('getGroupInfo', { group_guid: groupGuid });
    return unwrapData(response);
  }

  async createGroupVoiceChat(chatGuid) {
    const response = await this.api.request('createGroupVoiceChat', { chat_guid: chatGuid });
    const data = unwrapData(response);
    const voiceChat = data?.group_voice_chat_update?.group_voice_chat
      || data?.exist_group_voice_chat
      || findValue(data, 'group_voice_chat');
    const voiceChatId = voiceChat?.voice_chat_id || findValue(data, 'voice_chat_id');
    if (!voiceChatId) {
      const error = new Error('createGroupVoiceChat did not return a voice_chat_id.');
      error.response = response;
      throw error;
    }
    return { ...voiceChat, voice_chat_id: voiceChatId, raw: response };
  }

  async getGroupVoiceChat({ chatGuid, voiceChatId }) {
    if (!chatGuid || !voiceChatId) throw new TypeError('chatGuid and voiceChatId are required internally.');
    const response = await this.api.request('getGroupVoiceChat', {
      chat_guid: chatGuid,
      voice_chat_id: voiceChatId,
    });
    return unwrapData(response);
  }

  async resolveGroupVoiceChat(groupGuid, { createIfMissing = true } = {}) {
    if (typeof groupGuid !== 'string' || !groupGuid.trim()) throw new TypeError('A valid group GUID is required.');
    const info = await this.getGroupInfo(groupGuid);
    const chat = info?.chat || info?.group?.chat || info?.group || info;
    let voiceChatId = chat?.group_voice_chat_id || findValue(info, 'group_voice_chat_id');

    if (!voiceChatId) {
      if (!createIfMissing) {
        const error = new Error('This group does not currently have a Voice Chat.');
        error.code = 'VOICE_CHAT_NOT_FOUND';
        throw error;
      }
      const created = await this.createGroupVoiceChat(groupGuid);
      return { chatGuid: groupGuid, voiceChatId: created.voice_chat_id, voiceChat: created, group: info, created: true };
    }

    try {
      const voiceChat = await this.getGroupVoiceChat({ chatGuid: groupGuid, voiceChatId });
      if (voiceChat?.is_exist === false) throw Object.assign(new Error('Voice Chat does not exist.'), { code: 'VOICE_CHAT_NOT_FOUND' });
      return { chatGuid: groupGuid, voiceChatId, voiceChat: voiceChat?.group_voice_chat || voiceChat, group: info, created: false };
    } catch (error) {
      if (error.code !== 'VOICE_CHAT_NOT_FOUND' && !['VOICE_CHAT_NOT_EXIST', 'VOICECHATNOTEXIST'].includes(String(error.status || '').toUpperCase().replace(/_/g, '')) && !['VOICE_CHAT_NOT_EXIST', 'VOICECHATNOTEXIST'].includes(String(error.statusDet || '').toUpperCase().replace(/_/g, ''))) throw error;
      if (!createIfMissing) throw error;
      const created = await this.createGroupVoiceChat(groupGuid);
      return { chatGuid: groupGuid, voiceChatId: created.voice_chat_id, voiceChat: created, group: info, created: true };
    }
  }

  async joinGroupVoiceChat({ chatGuid, voiceChatId, sdpOffer, selfObjectGuid }) {
    const response = await this.api.request('joinGroupVoiceChat', {
      chat_guid: chatGuid,
      voice_chat_id: voiceChatId,
      sdp_offer_data: sdpOffer,
      self_object_guid: selfObjectGuid,
    });
    const data = unwrapData(response);
    const answer = findValue(data, 'sdp_answer_data');
    if (typeof answer !== 'string' || !answer.startsWith('v=0')) {
      throw new Error('joinGroupVoiceChat returned no valid sdp_answer_data.');
    }
    return { ...data, sdp_answer_data: answer, raw: response };
  }

  async setState({ chatGuid, voiceChatId, action, participantObjectGuid }) {
    return this.api.request('setGroupVoiceChatState', {
      chat_guid: chatGuid,
      voice_chat_id: voiceChatId,
      action,
      participant_object_guid: participantObjectGuid,
    });
  }

  async requestSpeak({ chatGuid, voiceChatId, participantObjectGuid }) {
    return this.setState({ chatGuid, voiceChatId, action: 'RequestSpeak', participantObjectGuid });
  }

  async getParticipants({ chatGuid, voiceChatId, startId }) {
    const input = { chat_guid: chatGuid, voice_chat_id: voiceChatId };
    if (startId) input.start_id = startId;
    const response = await this.api.request('getGroupVoiceChatParticipants', input);
    return unwrapData(response);
  }

  async getUpdates({ chatGuid, voiceChatId, state }) {
    const response = await this.api.request('getGroupVoiceChatUpdates', {
      chat_guid: chatGuid,
      voice_chat_id: voiceChatId,
      state,
    });
    return unwrapData(response);
  }

  async setSettings({ chatGuid, voiceChatId, joinMuted, title, updatedParameters } = {}) {
    const input = { chat_guid: chatGuid, voice_chat_id: voiceChatId };
    const changed = Array.isArray(updatedParameters) ? [...updatedParameters] : [];
    if (joinMuted !== undefined) { input.join_muted = Boolean(joinMuted); if (!changed.includes('join_muted')) changed.push('join_muted'); }
    if (title !== undefined) { input.title = String(title); if (!changed.includes('title')) changed.push('title'); }
    input.updated_parameters = changed;
    return this.api.request('setGroupVoiceChatSetting', input);
  }

  async discard({ chatGuid, voiceChatId }) {
    return this.api.request('discardGroupVoiceChat', { chat_guid: chatGuid, voice_chat_id: voiceChatId });
  }

  async sendActivity({ chatGuid, voiceChatId, activity = 'Speaking' }) {
    return this.api.request('sendGroupVoiceChatActivity', { chat_guid: chatGuid, voice_chat_id: voiceChatId, activity });
  }

  async leave({ chatGuid, voiceChatId }) {
    return this.api.request('leaveGroupVoiceChat', { chat_guid: chatGuid, voice_chat_id: voiceChatId });
  }
}

module.exports = { VoiceApi, unwrapData, findValue };
