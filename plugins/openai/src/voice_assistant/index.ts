// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream } from '@livekit/agents';
import { findMicroTrackId } from '@livekit/agents';
import { llm, log } from '@livekit/agents';
import type {
  AudioFrameEvent,
  LocalTrackPublication,
  RemoteAudioTrack,
  RemoteParticipant,
  Room,
} from '@livekit/rtc-node';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  AudioStreamEvent,
  LocalAudioTrack,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import * as proto from './proto.js';

export const defaultInferenceConfig: proto.InferenceConfig = {
  system_message: 'You are a helpful assistant.',
  voice: proto.Voice.ALLOY,
  max_tokens: 2048,
  temperature: 0.8,
  disable_audio: false,
  turn_end_type: proto.TurnEndType.SERVER_DETECTION,
  transcribe_input: true,
  audio_format: proto.AudioFormat.PCM16,
  tools: [],
  tool_choice: proto.ToolChoice.AUTO,
};

type ImplOptions = {
  apiKey: string;
  inferenceConfig: proto.InferenceConfig;
  functions: llm.FunctionContext;
};

export class VoiceAssistant {
  options: ImplOptions;
  room: Room | null = null;
  linkedParticipant: RemoteParticipant | null = null;
  subscribedTrack: RemoteAudioTrack | null = null;
  readMicroTask: { promise: Promise<void>; cancel: () => void } | null = null;

  constructor({
    inferenceConfig = defaultInferenceConfig,
    functions = {},
    apiKey = process.env.OPENAI_API_KEY || '',
  }: {
    inferenceConfig?: proto.InferenceConfig;
    functions?: llm.FunctionContext;
    apiKey?: string;
  }) {
    if (!apiKey) {
      throw new Error('OpenAI API key is required, whether as an argument or as $OPENAI_API_KEY');
    }

    inferenceConfig.tools = tools(functions);
    this.options = {
      apiKey,
      inferenceConfig,
      functions,
    };
  }

  private ws: WebSocket | null = null;
  private connected: boolean = false;
  private thinking: boolean = false;
  private participant: RemoteParticipant | string | null = null;
  private agentPublication: LocalTrackPublication | null = null;
  private localTrackSid: string | null = null;
  private localSource: AudioSource | null = null;
  private pendingMessages: Map<string, string> = new Map();
  private logger = log();

  private speechLeftMs: number | null = null;
  private speechStarted: number = 0;
  private speechTimeout: ReturnType<typeof setTimeout> | undefined = undefined;

  start(room: Room, participant: RemoteParticipant | string | null = null): Promise<void> {
    return new Promise(async (resolve, reject) => {
      if (this.ws !== null) {
        this.logger.warn('VoiceAssistant already started');
        resolve();
        return;
      }

      room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        if (!this.linkedParticipant) {
          return;
        }

        this.linkParticipant(participant.identity);
      });
      room.on(RoomEvent.TrackPublished, () => {
        this.subscribeToMicrophone();
      });
      room.on(RoomEvent.TrackSubscribed, () => {
        this.subscribeToMicrophone();
      });

      this.room = room;
      this.participant = participant;
      this.setState(proto.State.INITIALIZING);

      if (participant) {
        if (typeof participant === 'string') {
          this.linkParticipant(participant);
        } else {
          this.linkParticipant(participant.identity);
        }
      } else {
        // No participant specified, try to find the first participant in the room
        for (const participant of room.remoteParticipants.values()) {
          this.linkParticipant(participant.identity);
          break;
        }
      }

      this.localSource = new AudioSource(proto.SAMPLE_RATE, proto.NUM_CHANNELS);
      const track = LocalAudioTrack.createAudioTrack('assistant_voice', this.localSource);
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      this.agentPublication = (await room.localParticipant?.publishTrack(track, options)) || null;
      if (!this.agentPublication) {
        this.logger.error('Failed to publish track');
        reject(new Error('Failed to publish track'));
        return;
      }

      await this.agentPublication.waitForSubscription();

      this.ws = new WebSocket(proto.API_URL, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
        },
      });

      this.ws.onopen = () => {
        this.connected = true;
        this.sendClientCommand({
          event: proto.ClientEventType.SET_INFERENCE_CONFIG,
          ...this.options.inferenceConfig,
        });
      };

      this.ws.onerror = (error) => {
        reject(error);
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.ws = null;
      };

      this.ws.onmessage = (message) => {
        this.handleServerEvent(JSON.parse(message.data as string));
      };
    });
  }

  private setState(state: proto.State) {
    // don't override thinking until done
    if (this.thinking) return;
    if (this.room?.isConnected) {
      this.room.localParticipant!.setAttributes({
        'voice_assistant.state': state,
      });
    }
  }

  private sendClientCommand(command: proto.ClientEvent): void {
    if (!this.connected || !this.ws) {
      this.logger.error('WebSocket is not connected');
      return;
    }

    if (command.event !== proto.ClientEventType.ADD_USER_AUDIO) {
      this.logger.debug(`-> ${JSON.stringify({ ...command })}`);
    }
    this.ws.send(JSON.stringify(command));
  }

  private handleServerEvent(event: proto.ServerEvent): void {
    const truncatedDataPartial =
      event.event === proto.ServerEventType.ADD_CONTENT
        ? { data: event.data.slice(0, 30) + '…' }
        : {};
    this.logger.debug(`<- ${JSON.stringify({ ...event, ...truncatedDataPartial })}`);
    switch (event.event) {
      case proto.ServerEventType.START_SESSION:
        this.setState(proto.State.LISTENING);
        break;
      case proto.ServerEventType.ADD_ITEM:
        this.handleAddItem(event);
        break;
      case proto.ServerEventType.ADD_CONTENT:
        this.handleAddContent(event);
        break;
      case proto.ServerEventType.ITEM_ADDED:
        this.handleItemAdded(event);
        break;
      case proto.ServerEventType.TURN_FINISHED:
        break;
      case proto.ServerEventType.VAD_SPEECH_STARTED:
        this.handleVadSpeechStarted(event);
        break;
      case proto.ServerEventType.VAD_SPEECH_STOPPED:
        break;
      case proto.ServerEventType.INPUT_TRANSCRIBED:
        this.handleInputTranscribed(event);
        break;
      default:
        this.logger.warn(`Unknown server event: ${JSON.stringify(event)}`);
    }
  }

  private handleAddContent(event: proto.ServerEvent): void {
    if (event.event !== proto.ServerEventType.ADD_CONTENT) return;
    switch (event.type) {
      case 'audio':
        const data = Buffer.from(event.data as string, 'base64');

        const serverFrame = new AudioFrame(
          new Int16Array(data.buffer),
          proto.SAMPLE_RATE,
          proto.NUM_CHANNELS,
          data.length / 2,
        );

        if (this.speechLeftMs) {
          clearTimeout(this.speechTimeout);
          this.speechLeftMs -= Date.now() - this.speechStarted;
          this.speechLeftMs += (serverFrame.data.length / proto.SAMPLE_RATE) * 1000;
        } else {
          this.speechLeftMs = (serverFrame.data.length / proto.SAMPLE_RATE) * 1000;
        }
        this.speechStarted = Date.now();
        this.speechTimeout = setTimeout(() => {
          this.setState(proto.State.LISTENING);
        }, this.speechLeftMs);

        const bstream = new AudioByteStream(
          proto.SAMPLE_RATE,
          proto.NUM_CHANNELS,
          proto.OUTPUT_PCM_FRAME_SIZE,
        );

        for (const frame of bstream.write(serverFrame.data.buffer)) {
          this.localSource?.captureFrame(frame);
        }
        break;
      case 'text':
        const itemId = event.item_id as string;
        if (itemId && this.pendingMessages.has(itemId)) {
          const existingText = this.pendingMessages.get(itemId) || '';
          const newText = existingText + (event.data as string);
          this.pendingMessages.set(itemId, newText);

          const participantIdentity = this.room?.localParticipant?.identity;
          const trackSid = this.getLocalTrackSid();
          if (participantIdentity && trackSid) {
            this.publishTranscription(participantIdentity, trackSid, newText, false, itemId);
          } else {
            this.logger.error('Participant or track not set');
          }
        }
        break;
      default:
        break;
    }
  }

  private handleAddItem(event: proto.ServerEvent): void {
    if (event.event !== proto.ServerEventType.ADD_ITEM) return;
    const itemId = event.id as string;
    if (itemId && event.type === 'message') {
      this.speechLeftMs = 0;
      this.setState(proto.State.SPEAKING);
      this.pendingMessages.set(itemId, '');
    }
    if (event.type === 'tool_call') {
      this.setState(proto.State.THINKING);
      this.thinking = true;
    }
  }

  private handleItemAdded(event: proto.ServerEvent): void {
    if (event.event !== proto.ServerEventType.ITEM_ADDED) return;
    switch (event.type) {
      case 'tool_call': {
        this.options.functions[event.name].execute(event.arguments).then((content) => {
          this.thinking = false;
          this.sendClientCommand({
            event: proto.ClientEventType.ADD_ITEM,
            type: 'tool_response',
            tool_call_id: event.tool_call_id as string,
            content: JSON.stringify(content),
          });
          this.sendClientCommand({
            event: proto.ClientEventType.CLIENT_TURN_FINISHED,
          });
        });
        break;
      }
      case 'message': {
        const itemId = event.id as string;
        if (itemId && this.pendingMessages.has(itemId)) {
          const text = this.pendingMessages.get(itemId) || '';
          this.pendingMessages.delete(itemId);

          const participantIdentity = this.room?.localParticipant?.identity;
          const trackSid = this.getLocalTrackSid();
          if (participantIdentity && trackSid) {
            this.publishTranscription(participantIdentity, trackSid, text, true, itemId);
          } else {
            this.logger.error('Participant or track not set');
          }
        }
        break;
      }
    }
  }

  private handleInputTranscribed(event: proto.ServerEvent): void {
    if (event.event !== proto.ServerEventType.INPUT_TRANSCRIBED) return;
    const itemId = event.item_id as string;
    const transcription = event.transcript as string;
    if (!itemId || !transcription) {
      this.logger.error('Item ID or transcription not set');
      return;
    }
    const participantIdentity = this.linkedParticipant?.identity;
    const trackSid = this.subscribedTrack?.sid;
    if (participantIdentity && trackSid) {
      this.publishTranscription(participantIdentity, trackSid, transcription, true, itemId);
    } else {
      this.logger.error('Participant or track not set');
    }
  }

  private handleVadSpeechStarted(event: proto.ServerEvent): void {
    if (event.event !== proto.ServerEventType.VAD_SPEECH_STARTED) return;
    const itemId = event.item_id as string;
    const participantIdentity = this.linkedParticipant?.identity;
    const trackSid = this.subscribedTrack?.sid;
    if (participantIdentity && trackSid && itemId) {
      this.publishTranscription(participantIdentity, trackSid, '', false, itemId);
    } else {
      this.logger.error('Participant or track or itemId not set');
    }
  }

  private linkParticipant(participantIdentity: string): void {
    if (!this.room) {
      this.logger.error('Room is not set');
      return;
    }

    this.linkedParticipant = this.room.remoteParticipants.get(participantIdentity) || null;
    if (!this.linkedParticipant) {
      this.logger.error(`Participant with identity ${participantIdentity} not found`);
      return;
    }
    this.subscribeToMicrophone();
  }

  private subscribeToMicrophone(): void {
    const readAudioStreamTask = async (audioStream: AudioStream) => {
      const bstream = new AudioByteStream(
        proto.SAMPLE_RATE,
        proto.NUM_CHANNELS,
        proto.INPUT_PCM_FRAME_SIZE,
      );

      audioStream.on(AudioStreamEvent.FrameReceived, (ev: AudioFrameEvent) => {
        const audioData = ev.frame.data;
        for (const frame of bstream.write(audioData.buffer)) {
          this.sendClientCommand({
            event: proto.ClientEventType.ADD_USER_AUDIO,
            data: Buffer.from(frame.data.buffer).toString('base64'),
          });
        }
      });
    };

    if (!this.linkedParticipant) {
      this.logger.error('Participant is not set');
      return;
    }

    for (const publication of this.linkedParticipant.trackPublications.values()) {
      if (publication.source !== TrackSource.SOURCE_MICROPHONE) {
        continue;
      }

      if (!publication.subscribed) {
        publication.setSubscribed(true);
      }

      const track = publication.track;

      if (track && track !== this.subscribedTrack) {
        this.subscribedTrack = track as RemoteAudioTrack;
        if (this.readMicroTask) {
          this.readMicroTask.cancel();
        }

        let cancel: () => void;
        this.readMicroTask = {
          promise: new Promise<void>((resolve, reject) => {
            cancel = () => {
              // Cleanup logic here
              reject(new Error('Task cancelled'));
            };
            readAudioStreamTask(new AudioStream(track, proto.SAMPLE_RATE, proto.NUM_CHANNELS))
              .then(resolve)
              .catch(reject);
          }),
          cancel: () => cancel(),
        };
      }
    }
  }

  private getLocalTrackSid(): string | null {
    if (!this.localTrackSid && this.room && this.room.localParticipant) {
      this.localTrackSid = findMicroTrackId(this.room, this.room.localParticipant?.identity);
    }
    return this.localTrackSid;
  }

  private publishTranscription(
    participantIdentity: string,
    trackSid: string,
    text: string,
    isFinal: boolean,
    id: string,
  ): void {
    if (!this.room?.localParticipant) {
      log().error('Room or local participant not set');
      return;
    }

    this.room.localParticipant.publishTranscription({
      participantIdentity,
      trackSid,
      segments: [
        {
          text,
          final: isFinal,
          id,
          startTime: BigInt(0),
          endTime: BigInt(0),
          language: '',
        },
      ],
    });
  }
}

const tools = (ctx: llm.FunctionContext): proto.Tool[] =>
  Object.entries(ctx).map(([name, func]) => ({
    type: 'function',
    function: {
      name,
      description: func.description,
      parameters: llm.oaiParams(func.parameters),
    },
  }));