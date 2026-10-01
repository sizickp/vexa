"""retranscribe adapters — the STT client over HTTP, resolved the way a bot spawn resolves it."""
from __future__ import annotations

import os
from typing import Optional

from ..bot_spawn.service import _fetch_bot_context, _transcription_from_context

#: A whole meeting in one request: the backend works for minutes, not seconds.
STT_TIMEOUT_S = 3600.0


class HttpSttClient:
    """``POST {url}/v1/audio/transcriptions`` with the whole recording — the same OpenAI-compatible
    contract the bot's live windows use (docs: how-to/custom-stt), asking for segment timestamps and
    voice-activity filtering. A backend that ignores the extra form fields still answers."""

    def __init__(self, url: str, token: Optional[str], model: Optional[str]):
        base = url.rstrip("/")
        self._url = base if base.endswith("/v1/audio/transcriptions") else base + "/v1/audio/transcriptions"
        self._token = token
        self._model = model or "whisper-1"

    async def transcribe(self, audio: bytes, *, filename: str, content_type: str,
                         language: Optional[str]) -> list[dict]:
        import httpx

        data = {"model": self._model, "response_format": "verbose_json",
                "timestamp_granularities[]": "segment", "vad_filter": "true", "temperature": "0"}
        if language:
            data["language"] = language
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        async with httpx.AsyncClient(timeout=STT_TIMEOUT_S) as client:
            response = await client.post(self._url, headers=headers, data=data,
                                         files={"file": (filename, audio, content_type)})
        response.raise_for_status()
        body = response.json()
        segments = body.get("segments") if isinstance(body, dict) else None
        if not isinstance(segments, list):
            # Text without timestamps cannot be laid over the live transcript's speakers.
            raise ValueError("the transcription backend returned no segment timestamps")
        return [{"start": s.get("start"), "end": s.get("end"), "text": s.get("text")}
                for s in segments if isinstance(s, dict)]


async def resolve_stt(user_id: int) -> Optional[HttpSttClient]:
    """The backend a spawn for this person would transcribe with: a Settings-configured one (user
    preference over platform setting, via identity's bot-context) replaces the process env's, token
    and model included; ``None`` when neither names a URL."""
    url = os.getenv("TRANSCRIPTION_SERVICE_URL") or None
    token = os.getenv("TRANSCRIPTION_SERVICE_TOKEN") or None
    model = os.getenv("TRANSCRIPTION_MODEL") or None
    configured = _transcription_from_context(await _fetch_bot_context(user_id))
    if configured.get("url"):
        url, token, model = configured["url"], configured.get("token") or None, configured.get("model") or None
    return HttpSttClient(url, token, model) if url else None


def default_language() -> Optional[str]:
    return (os.getenv("TRANSCRIPTION_LANGUAGE") or "").strip() or None
