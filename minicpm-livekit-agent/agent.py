"""
LiveKit Voice Agent powered by Qwen-Omni Realtime (DashScope)

Uses LiveKit's OpenAI Realtime plugin with DashScope's OpenAI-compatible
WebSocket endpoint to create a real-time voice AI agent.

Architecture:
  Element X → LiveKit SFU ← This Agent → Qwen-Omni Realtime (DashScope)
     User       Media Relay    Audio Bridge      AI Voice Model

Usage:
  uv run python agent.py dev
"""

import os
import json
import logging
import aiohttp
from dotenv import load_dotenv

from livekit import agents
from livekit.agents import AgentServer, AgentSession, Agent
from livekit.plugins import openai, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

load_dotenv(".env.local")

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("qwen-agent")

# DashScope configuration
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "")
DASHSCOPE_REALTIME_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
QWEN_MODEL = "qwen3-omni-flash-realtime"

# DashScope uses older OpenAI Realtime event names.
# livekit-plugins-openai v1.4 expects the newer names.
DASHSCOPE_EVENT_REMAP = {
    "response.text.delta": "response.output_text.delta",
    "response.text.done": "response.output_text.done",
    "response.audio.delta": "response.output_audio.delta",
    "response.audio.done": "response.output_audio.done",
    "response.audio_transcript.delta": "response.output_audio_transcript.delta",
    "response.audio_transcript.done": "response.output_audio_transcript.done",
    "conversation.item.created": "conversation.item.added",
}


class DashScopeRealtimeModel(openai.realtime.RealtimeModel):
    """RealtimeModel with DashScope event name compatibility.

    DashScope's Realtime API is compatible with OpenAI's but uses some
    older event names (e.g. response.text.delta instead of response.output_text.delta).
    This subclass overrides session creation to patch the WS receive handler
    to remap these event names transparently.
    """

    def session(self, **kwargs):
        """Create a session with DashScope event remapping."""
        sess = super().session(**kwargs)
        _original_run_ws = sess._run_ws

        async def _patched_run_ws(ws_conn):
            """Intercept ws_conn.receive to remap DashScope event names."""
            _original_receive = ws_conn.receive

            async def _remapping_receive():
                msg = await _original_receive()
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                        evt_type = data.get("type", "")
                        if evt_type in DASHSCOPE_EVENT_REMAP:
                            new_type = DASHSCOPE_EVENT_REMAP[evt_type]
                            data["type"] = new_type
                            logger.debug(f"Event remap: {evt_type} -> {new_type}")
                            msg = aiohttp.WSMessage(
                                type=aiohttp.WSMsgType.TEXT,
                                data=json.dumps(data),
                                extra=msg.extra,
                            )
                    except (json.JSONDecodeError, KeyError):
                        pass
                return msg

            ws_conn.receive = _remapping_receive
            return await _original_run_ws(ws_conn)

        sess._run_ws = _patched_run_ws
        logger.info("Created DashScope-compatible RealtimeSession with event remapping")
        return sess


class VoiceAssistant(Agent):
    """AI voice assistant powered by Qwen-Omni."""

    def __init__(self) -> None:
        super().__init__(
            instructions="""你是一个友好的AI语音助手。你能够理解中文和英文，
并用流利自然的语言与用户对话。你的回答简洁明了，不使用复杂的标点或格式。
你乐于助人、好奇心强，有一定的幽默感。""",
        )


server = AgentServer()


@server.rtc_session()
async def qwen_voice_agent(ctx: agents.JobContext):
    """Entry point for the voice agent session."""

    qwen_realtime = DashScopeRealtimeModel(
        model=QWEN_MODEL,
        base_url=DASHSCOPE_REALTIME_URL,
        api_key=DASHSCOPE_API_KEY,
        voice="Cherry",
        modalities=["text", "audio"],
    )

    session = AgentSession(
        llm=qwen_realtime,
        vad=silero.VAD.load(),
        turn_detection=MultilingualModel(),
    )

    await session.start(
        room=ctx.room,
        agent=VoiceAssistant(),
    )

    # Greet the user when they join
    await session.generate_reply(
        instructions="用中文友好地问候用户，告诉他们你是AI语音助手，可以帮助他们。"
    )


def main():
    agents.cli.run_app(server)


if __name__ == "__main__":
    main()
