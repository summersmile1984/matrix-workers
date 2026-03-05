/**
 * LiveKit Voice Agent — Direct DashScope Bridge
 *
 * Architecture:
 *   Browser ←→ LiveKit SFU ←→ This Agent ←→ DashScope (OpenAI Realtime API)
 *
 * Uses @livekit/rtc-node to directly join room and bridge audio.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import {
    Room,
    RoomEvent,
    AudioSource,
    AudioStream,
    AudioFrame,
    LocalAudioTrack,
    TrackPublishOptions,
    TrackSource,
} from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import WebSocket from 'ws';

// ---- Config ----
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'ws://localhost:7880';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
const DASHSCOPE_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-omni-flash-realtime';

const ROOM_NAME = process.argv[2] || 'test-room';
const AGENT_IDENTITY = 'qwen-voice-agent';
const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;

console.log(`🎙️  Qwen Voice Agent`);
console.log(`   Room: ${ROOM_NAME} | LiveKit: ${LIVEKIT_URL}`);

// ---- Generate Token ----
async function generateToken(): Promise<string> {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: AGENT_IDENTITY,
        name: 'Qwen Voice Agent',
    });
    at.addGrant({
        roomJoin: true,
        room: ROOM_NAME,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
    });
    return await at.toJwt();
}

// ---- Audio Frame Queue ----
class AudioFrameQueue {
    private queue: AudioFrame[] = [];
    private processing = false;
    private source: AudioSource;

    constructor(source: AudioSource) {
        this.source = source;
    }

    push(frame: AudioFrame) {
        this.queue.push(frame);
        if (!this.processing) this.drain();
    }

    private async drain() {
        this.processing = true;
        while (this.queue.length > 0) {
            const frame = this.queue.shift()!;
            try {
                await this.source.captureFrame(frame);
            } catch { }
        }
        this.processing = false;
    }
}

// ---- DashScope Session ----
// Connects lazily — only when ensureReady() is called
class DashScopeSession {
    ws: WebSocket | null = null;
    private frameQueue: AudioFrameQueue;
    private room: Room;
    private currentTranscript = '';
    private closed = false;
    private connecting = false;
    private ready = false;

    constructor(room: Room, frameQueue: AudioFrameQueue) {
        this.room = room;
        this.frameQueue = frameQueue;
    }

    // Ensure DashScope is connected and ready. Returns true if ready.
    async ensureReady(): Promise<boolean> {
        if (this.ready && this.ws?.readyState === WebSocket.OPEN) return true;
        if (this.connecting) {
            // Wait for current connection attempt
            await new Promise<void>(resolve => {
                const check = setInterval(() => {
                    if (this.ready || this.closed) { clearInterval(check); resolve(); }
                }, 100);
            });
            return this.ready;
        }
        try {
            await this.connect();
            return true;
        } catch {
            return false;
        }
    }

    private async connect(): Promise<void> {
        this.connecting = true;
        this.ready = false;
        return new Promise((resolve, reject) => {
            console.log('🔗 Connecting to DashScope...');
            this.ws = new WebSocket(DASHSCOPE_WS_URL, {
                headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}` },
            });

            const timeout = setTimeout(() => {
                reject(new Error('DashScope connection timeout'));
                this.ws?.close();
            }, 10000);

            this.ws.on('open', () => {
                console.log('✅ DashScope connected');
                this.ws!.send(JSON.stringify({
                    type: 'session.update',
                    session: {
                        modalities: ['text', 'audio'],
                        voice: 'Cherry',
                        input_audio_format: 'pcm16',
                        output_audio_format: 'pcm16',
                        instructions: `你是一个友好的AI语音助手。你能够理解中文和英文，
并用流利自然的语言与用户对话。你的回答简洁明了。`,
                        turn_detection: {
                            type: 'server_vad',
                            threshold: 0.5,
                            prefix_padding_ms: 300,
                            silence_duration_ms: 500,
                            create_response: true,
                            interrupt_response: true,
                        },
                    },
                }));
            });

            const onSessionUpdated = (data: Buffer) => {
                const event = JSON.parse(data.toString());
                if (event.type === 'session.updated') {
                    clearTimeout(timeout);
                    this.ws!.off('message', onSessionUpdated);
                    this.setupMessageHandler();
                    this.ready = true;
                    this.connecting = false;
                    console.log('✅ DashScope session ready');
                    resolve();
                }
            };
            this.ws.on('message', onSessionUpdated);

            this.ws.on('close', (code) => {
                console.log(`⚠️  DashScope disconnected (code=${code})`);
                this.ready = false;
                this.connecting = false;
            });

            this.ws.on('error', (err) => {
                console.error('❌ DashScope error:', err.message);
                clearTimeout(timeout);
                this.connecting = false;
                reject(err);
            });
        });
    }

    private setupMessageHandler() {
        if (!this.ws) return;
        this.ws.on('message', (data: Buffer) => {
            const event = JSON.parse(data.toString());
            switch (event.type) {
                case 'response.audio.delta': {
                    const pcmBytes = Buffer.from(event.delta, 'base64');
                    const samples = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.length / 2);
                    const frame = new AudioFrame(samples, SAMPLE_RATE, NUM_CHANNELS, samples.length);
                    this.frameQueue.push(frame);
                    break;
                }
                case 'response.audio_transcript.delta':
                    this.currentTranscript += event.delta;
                    break;
                case 'response.audio_transcript.done': {
                    const transcript = event.transcript || this.currentTranscript;
                    if (transcript) {
                        console.log(`🤖 Agent: ${transcript}`);
                        const payload = JSON.stringify({ type: 'transcript', role: 'agent', content: transcript });
                        this.room.localParticipant?.publishData(Buffer.from(payload), { reliable: true });
                    }
                    this.currentTranscript = '';
                    break;
                }
                case 'input_audio_buffer.speech_started':
                    console.log('🎤 User speaking...');
                    break;
                case 'input_audio_buffer.speech_stopped':
                    console.log('🎤 User stopped');
                    break;
                case 'response.done':
                    if (event.response?.usage) {
                        const u = event.response.usage;
                        console.log(`   tokens: ${u.total_tokens} (in:${u.input_tokens} out:${u.output_tokens})`);
                    }
                    break;
                case 'response.text.delta':
                    this.currentTranscript += event.delta;
                    break;
                case 'response.text.done': {
                    const text = event.text || this.currentTranscript;
                    if (text) {
                        console.log(`🤖 Agent (text): ${text}`);
                        const payload = JSON.stringify({ type: 'transcript', role: 'agent', content: text });
                        this.room.localParticipant?.publishData(Buffer.from(payload), { reliable: true });
                    }
                    this.currentTranscript = '';
                    break;
                }
                case 'error':
                    console.error('❌ DashScope error:', JSON.stringify(event.error));
                    break;
                case 'session.updated':
                case 'response.created':
                case 'response.output_item.added':
                case 'response.content_part.added':
                case 'response.content_part.done':
                case 'response.output_item.done':
                case 'conversation.item.created':
                    break; // expected, no logging needed
                default:
                    console.log(`📩 DashScope: ${event.type}`, JSON.stringify(event).substring(0, 200));
            }
        });
    }

    async sendAudio(base64: string) {
        if (this.ws?.readyState === WebSocket.OPEN && this.ready) {
            this.ws.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: base64,
            }));
        }
    }

    async sendText(text: string) {
        if (!(await this.ensureReady())) {
            console.error('❌ Cannot send text — DashScope not ready');
            return;
        }
        console.log(`💬 User text: ${text}`);
        // Use response.create with instructions (same as greeting, which works)
        this.ws!.send(JSON.stringify({
            type: 'response.create',
            response: {
                instructions: `用户说: "${text}"。请用中文回答用户的问题或回应用户的话。`,
            },
        }));
    }

    async requestGreeting() {
        if (!(await this.ensureReady())) {
            console.error('❌ Cannot greet — DashScope not ready');
            return;
        }
        console.log('📢 Sending greeting...');
        this.ws!.send(JSON.stringify({
            type: 'response.create',
            response: {
                instructions: '用中文友好地问候用户，简短一句话，告诉他们你是AI语音助手。',
            },
        }));
    }

    close() {
        this.closed = true;
        this.ws?.close();
    }
}

// ---- Main ----
async function main() {
    // 1. Join LiveKit room
    const token = await generateToken();
    const room = new Room();
    await room.connect(LIVEKIT_URL, token, { autoSubscribe: true } as any);
    console.log(`✅ Joined room: ${ROOM_NAME}`);

    // 2. Publish agent audio track
    const audioSource = new AudioSource(SAMPLE_RATE, NUM_CHANNELS);
    const audioTrack = LocalAudioTrack.createAudioTrack('agent-audio', audioSource);
    const opts = new TrackPublishOptions();
    opts.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant!.publishTrack(audioTrack, opts);
    console.log('🔊 Audio track published');

    const frameQueue = new AudioFrameQueue(audioSource);

    // 3. Create DashScope session (lazy — connects when needed)
    const session = new DashScopeSession(room, frameQueue);

    // 4. Track active audio streams per participant
    const activeStreams = new Map<string, AbortController>();

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        console.log(`📡 TrackSubscribed: ${participant.identity} kind=${track.kind} source=${publication.source}`);
        if (track.kind !== 1) return;

        console.log(`🎤 Processing audio from "${participant.identity}"`);

        const existing = activeStreams.get(participant.identity);
        if (existing) existing.abort();

        const controller = new AbortController();
        activeStreams.set(participant.identity, controller);

        const audioStream = new AudioStream(track, 48000, NUM_CHANNELS);

        (async () => {
            let frameCount = 0;
            for await (const frame of audioStream) {
                if (controller.signal.aborted) break;

                // Downsample 48kHz → 24kHz
                const downsampled = new Int16Array(frame.data.length / 2);
                for (let i = 0; i < downsampled.length; i++) {
                    downsampled[i] = frame.data[i * 2];
                }
                const buf = Buffer.from(downsampled.buffer, downsampled.byteOffset, downsampled.byteLength);
                session.sendAudio(buf.toString('base64'));
                frameCount++;

                if (frameCount === 1) {
                    const rms = Math.sqrt(frame.data.reduce((s, v) => s + v * v, 0) / frame.data.length);
                    console.log(`🎤 First frame: rate=${frame.sampleRate} samples=${frame.data.length} rms=${rms.toFixed(0)}`);
                }
                if (frameCount % 500 === 0) {
                    const rms = Math.sqrt(frame.data.reduce((s, v) => s + v * v, 0) / frame.data.length);
                    console.log(`🎤 ${frameCount} frames (rms=${rms.toFixed(0)})`);
                }
            }
            console.log(`🎤 Stream ended: ${participant.identity} (${frameCount} frames)`);
        })();
    });

    room.on(RoomEvent.TrackUnsubscribed, (_track, _pub, participant) => {
        console.log(`📡 TrackUnsubscribed: ${participant.identity}`);
    });

    // 5. Greet when user joins
    room.on(RoomEvent.ParticipantConnected, async (p) => {
        console.log(`👤 ${p.identity} joined`);
        // Small delay to let track subscription happen, then greet
        setTimeout(() => session.requestGreeting(), 1000);
    });

    room.on(RoomEvent.ParticipantDisconnected, (p) => {
        console.log(`👤 ${p.identity} left`);
        const ctrl = activeStreams.get(p.identity);
        if (ctrl) {
            ctrl.abort();
            activeStreams.delete(p.identity);
        }
    });

    // 6. Handle text messages from browser
    room.on(RoomEvent.DataReceived, (data: Uint8Array, participant: any) => {
        try {
            const msg = JSON.parse(Buffer.from(data).toString());
            if (msg.type === 'chat' && msg.text) {
                session.sendText(msg.text);
            }
        } catch { }
    });

    // 7. Cleanup
    room.on(RoomEvent.Disconnected, () => {
        console.log('Disconnected from LiveKit');
        session.close();
        process.exit(0);
    });

    process.on('SIGINT', () => {
        console.log('\nShutting down...');
        session.close();
        room.disconnect();
        process.exit(0);
    });

    console.log('\n🚀 Ready! Connect via test.html\n');
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
