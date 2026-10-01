"""retranscribe ports — what the service needs from the outside, as Protocols."""
from __future__ import annotations

from typing import Callable, Optional, Protocol, runtime_checkable


@runtime_checkable
class SttClient(Protocol):
    """One whole-file pass against the deployment's speech-to-text backend."""

    async def transcribe(self, audio: bytes, *, filename: str, content_type: str,
                         language: Optional[str]) -> list[dict]:
        """``[{start, end, text}]`` — seconds from the first sample. Raises on a refused request;
        returns ``[]`` when the backend heard no speech."""
        ...


@runtime_checkable
class TranscriptRewriter(Protocol):
    """The transcript side: read what a rewrite needs, replace the rows, keep the run's state."""

    async def retranscription_source(self, user_id: int, meeting_id: int) -> Optional[dict]:
        """Owner-scoped. ``{meeting_id, status, start_epoch, recordings, live, state}`` — ``live`` is
        ``[{start, end, speaker, text, language}]``, ``state`` the stored run state or ``None``.
        ``None`` when the caller owns no such meeting."""
        ...

    async def replace_transcript(self, meeting_id: int, rows: list[dict]) -> int:
        """Replace every transcript row of the meeting with ``rows`` in one transaction; the count
        written."""
        ...

    async def stamp_retranscription(self, meeting_id: int, patch: dict) -> dict:
        """Merge ``patch`` into the meeting's stored run state and return the merged state."""
        ...

    async def decide_retranscription(self, meeting_id: int,
                                     decide: Callable[[dict], Optional[dict]]) -> dict:
        """Read the stored run state and write what ``decide(state)`` returns, as ONE atomic step
        (the meeting row is locked across both). ``decide`` returning ``None`` writes nothing. The
        state as it stands afterwards is returned. This is how a run is claimed: two callers that
        arrive together are decided one after the other, and the second sees the first's claim."""
        ...
