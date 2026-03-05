# LiveKit Voice Agent — Qwen-Omni Realtime

LiveKit voice agent powered by **Qwen3-Omni-Flash-Realtime** (DashScope).  
Joins LiveKit rooms and provides real-time AI voice conversation.

## Architecture

```
Element X / Web Client
        │
        ▼
   LiveKit SFU  ◄──────►  This Agent  ──────►  Qwen-Omni Realtime
   (Media Relay)           (Python)             (DashScope WebSocket)
```

## Setup

```bash
# Install uv if not already
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install dependencies
cd minicpm-livekit-agent
uv sync

# Edit .env.local with your credentials
```

## Run

```bash
# Development mode (auto-joins rooms)
uv run python agent.py dev

# Production mode (waits for dispatch)
uv run python agent.py start
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LIVEKIT_URL` | LiveKit server WebSocket URL |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `DASHSCOPE_API_KEY` | Alibaba Cloud DashScope API key (Beijing region) |

## Model

Uses `qwen3-omni-flash-realtime` via DashScope's OpenAI Realtime-compatible WebSocket endpoint.

- Input: PCM16 audio
- Output: PCM16/PCM24 audio + text
- VAD: Server-side voice activity detection
- Languages: Chinese, English, + 8 more
- Voice: Cherry (configurable, 49 voices available)
- Max session: 120 minutes
