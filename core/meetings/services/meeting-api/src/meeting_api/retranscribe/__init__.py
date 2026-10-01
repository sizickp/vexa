"""retranscribe — rebuild a finished meeting's transcript from its whole recording.

``POST /meetings/{meeting_id}/transcribe`` (api.v1): the recording master goes to the deployment's
speech-to-text backend in one pass, the result is named from the live transcript's speakers and
replaces the live rows. A rewrite that would lose words (a recording with gaps) is refused and the
live transcript stays.

  * ``build_router(store, recording_repo, storage)`` — the route.
  * ``service.run(...)`` — one run, every exit a readable state.
  * ``core`` — the pure part: clock alignment, speaker attribution, the coverage floor, the
    run's lease.
"""
from . import core, service
from .adapters import HttpSttClient, default_language, resolve_stt
from .ports import SttClient, TranscriptRewriter
from .core import TERMINAL
from .router import build_router

__all__ = [
    "HttpSttClient", "SttClient", "TERMINAL", "TranscriptRewriter",
    "build_router", "core", "default_language", "resolve_stt", "service",
]
