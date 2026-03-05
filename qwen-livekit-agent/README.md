# LiveKit Voice Agent — TypeScript + Qwen3-Omni (DashScope)

LiveKit voice agent powered by **Qwen3-Omni-Flash-Realtime** (DashScope) written in TypeScript.
Joins LiveKit rooms and provides real-time AI voice conversation.

## Architecture

```
Element X / Web Client
        │
        ▼
   LiveKit SFU  ◄──────►  This Agent (TypeScript)  ──────►  Qwen-Omni Realtime
   (Media Relay)           @livekit/agents-plugin-openai      (DashScope WebSocket)
```

Uses the `@livekit/agents-plugin-openai` Beta `RealtimeModel` which is directly compatible
with DashScope's OpenAI Realtime-compatible WebSocket API — no bridge or adapter needed.

## Setup

```bash
cd qwen-livekit-agent
npm install
```

## Run

```bash
# Development mode (auto-joins rooms)
npm run dev

# Production mode (waits for dispatch)
npm run start
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LIVEKIT_URL` | LiveKit server WebSocket URL |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `DASHSCOPE_API_KEY` | Alibaba Cloud DashScope API key |

## Test Page

Open `test.html` in a browser to test the voice agent. It connects via LiveKit.

## Model

Uses `qwen3-omni-flash-realtime` via DashScope's OpenAI Realtime-compatible endpoint.

- Input: PCM16 audio
- Output: PCM16 audio + text
- VAD: Server-side voice activity detection
- Languages: Chinese, English, + 8 more
- Voice: Cherry (configurable, 49 voices available)
- Max session: 120 minutes
