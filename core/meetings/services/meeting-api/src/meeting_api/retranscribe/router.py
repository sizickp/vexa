"""retranscribe router — ``POST /meetings/{meeting_id}/transcribe`` (api.v1).

ONE verb, asked as often as the caller likes: the first call on a finished meeting starts the run in
the background and answers ``running``; every later call answers the run's current state and starts
nothing, until the run ends in ``completed`` / ``skipped`` / ``failed``. ``{"force": true}`` runs it
again. That makes the verb its own poll — the post-meeting flow calls it once per tick and writes
the report only after it stops answering ``running``.

The service runs as several processes and a poll lands on any of them, so a run is CLAIMED in the
stored state (``core.claim`` under the meeting's row lock) and kept alive by a lease the running
process renews. A poll that reaches another process reads the claim and starts nothing; a run whose
process died stops renewing, and the next poll after the lease starts it again.
"""
from __future__ import annotations

import asyncio
import time
from typing import Awaitable, Callable, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from ..recordings import RecordingRepo, Storage
from . import core, service
from .adapters import default_language, resolve_stt
from .ports import SttClient, TranscriptRewriter


def _public(meeting_id: int, state: dict) -> dict:
    """The run's state as the caller reads it — the lease is the service's own bookkeeping."""
    return {"meeting_id": meeting_id, **{k: v for k, v in state.items() if k != "lease_until"}}


def _resolve_user_id(x_user_id: Optional[str]) -> int:
    """The gateway injects ``x-user-id`` after it resolves the api key. Missing → 401 fail-closed."""
    if not x_user_id:
        raise HTTPException(status_code=401, detail="Missing user identity")
    try:
        return int(x_user_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid user identity")


def build_router(
    store: TranscriptRewriter,
    recording_repo: RecordingRepo,
    storage: Storage,
    *,
    stt_for: Callable[[int], Awaitable[Optional[SttClient]]] = resolve_stt,
    language: Callable[[], Optional[str]] = default_language,
    clock: Callable[[], float] = time.time,
    lease_s: float = core.LEASE_S,
    heartbeat_s: float = core.HEARTBEAT_S,
) -> APIRouter:
    """The re-transcription route over the injected ports. ``stt_for(user_id)`` resolves the backend
    per run, so a Settings change applies to the next meeting without a restart."""
    router = APIRouter()
    runs: set[asyncio.Task] = set()      # held so a running task is not garbage-collected

    async def _renew(meeting_id: int) -> None:
        while True:
            await asyncio.sleep(heartbeat_s)
            await store.decide_retranscription(
                meeting_id,
                lambda state: ({**state, "lease_until": clock() + lease_s}
                               if state.get("status") == "running" else None))

    async def _run(user_id: int, meeting_id: int) -> None:
        renewing = asyncio.create_task(_renew(meeting_id), name=f"retranscribe-lease-{meeting_id}")
        try:
            await service.run(store, recording_repo, storage, await stt_for(user_id),
                              user_id=user_id, meeting_id=meeting_id, default_language=language())
        finally:
            renewing.cancel()

    @router.post("/meetings/{meeting_id}/transcribe")
    async def transcribe_meeting(
        meeting_id: int,
        request: Request,
        x_user_id: Optional[str] = Header(default=None),
    ):
        user_id = _resolve_user_id(x_user_id)
        force = False
        if await request.body():
            try:
                payload = await request.json()
            except Exception:
                raise HTTPException(status_code=422, detail="invalid JSON body")
            force = isinstance(payload, dict) and payload.get("force") is True

        src = await store.retranscription_source(user_id, meeting_id)
        if src is None:
            raise HTTPException(status_code=404, detail="Meeting not found")
        if src.get("status") != "completed":
            raise HTTPException(
                status_code=409,
                detail=f"the meeting is {src.get('status')!r}; re-transcription runs on a completed meeting")

        claimed = False

        def decide(state: dict) -> Optional[dict]:
            nonlocal claimed
            started = core.claim(state, now=clock(), lease_s=lease_s, force=force)
            claimed = started is not None
            return started

        state = await store.decide_retranscription(meeting_id, decide)
        if claimed:
            task = asyncio.create_task(_run(user_id, meeting_id), name=f"retranscribe-{meeting_id}")
            runs.add(task)
            task.add_done_callback(runs.discard)
        return JSONResponse(content=_public(meeting_id, state))

    return router
