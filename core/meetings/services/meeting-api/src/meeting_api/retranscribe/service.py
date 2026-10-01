"""retranscribe service — one run: recording master → STT → named rows → replace the transcript.

Every exit is a STATE the caller can read — ``completed`` / ``skipped`` / ``failed`` with a reason —
never an exception: the post-meeting flow asks for this before it writes the report, and a rewrite
that cannot happen must leave the live transcript in place and let the report proceed on it.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Optional

from ..obs import log_event
from ..recordings import RecordingRepo, Storage, finalize_master
from . import core
from .ports import SttClient, TranscriptRewriter

_CONTENT_TYPES = {"webm": "audio/webm", "wav": "audio/wav"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _audio_recording(recordings: list[dict]) -> "tuple[Optional[dict], Optional[dict]]":
    """The first recording that carries an audio media file, and that media file."""
    for rec in recordings or []:
        for mf in rec.get("media_files", []) or []:
            if mf.get("type") == "audio":
                return rec, mf
    return None, None


async def run(
    store: TranscriptRewriter,
    recording_repo: RecordingRepo,
    storage: Storage,
    stt: Optional[SttClient],
    *,
    user_id: int,
    meeting_id: int,
    default_language: Optional[str] = None,
) -> dict:
    """Run one re-transcription and return (and store) its final state."""

    async def finish(status: str, **fields) -> dict:
        state = await store.stamp_retranscription(
            meeting_id, {"status": status, "completed_at": _now_iso(), "lease_until": None, **fields})
        log_event("meeting_retranscribed", audience="operator", span="meetings.retranscribe",
                  user_id=user_id, meeting_id=str(meeting_id),
                  level="info" if status != "failed" else "error",
                  fields={k: v for k, v in state.items() if k not in ("started_at", "lease_until")})
        return state

    try:
        src = await store.retranscription_source(user_id, meeting_id)
        if src is None:
            return {"status": "failed", "reason": "meeting not found"}
        if stt is None:
            return await finish("skipped", reason="no transcription backend is configured")
        rec, mf = _audio_recording(src.get("recordings") or [])
        if rec is None:
            return await finish("skipped", reason="the meeting has no audio recording")
        master_key = await finalize_master(recording_repo, storage, meeting_id=meeting_id,
                                           recording_id=rec["id"], media_type="audio")
        if master_key is None:
            return await finish("skipped", reason="the recording has no audio to assemble")
        audio = await storage.get(master_key)
        if not audio:
            return await finish("skipped", reason="the recording is empty")

        live = src.get("live") or []
        language = core.dominant_language(live, default_language)
        media_format = str(mf.get("format") or master_key.rsplit(".", 1)[-1] or "webm")
        started = time.monotonic()
        segments = await stt.transcribe(
            audio, filename=f"meeting-{meeting_id}.{media_format}",
            content_type=_CONTENT_TYPES.get(media_format, "application/octet-stream"),
            language=language)
        stt_seconds = round(time.monotonic() - started, 1)

        run_id = "offline-" + _now_iso()
        rows = core.build_rows(segments, origin_epoch=float(src["start_epoch"]), live=live,
                               language=language, run_id=run_id)
        counts = {"live_segments": len(live), "live_words": core.word_count(live),
                  "words": core.word_count(rows), "stt_seconds": stt_seconds,
                  "audio_bytes": len(audio)}
        if not rows:
            return await finish("skipped", reason="the recording holds no speech", **counts)
        if core.thinner_than_live(rows, live):
            return await finish(
                "skipped", reason="the recording yields fewer words than the live transcript "
                                  "(a recording with gaps) — the live transcript is kept", **counts)
        written = await store.replace_transcript(meeting_id, rows)
        return await finish("completed", reason=None, segments=written, run_id=run_id,
                            unnamed=sum(1 for r in rows if not r["speaker"]), **counts)
    except Exception as exc:  # noqa: BLE001 — a run never raises: its failure is a state
        try:
            return await finish("failed", reason=f"{type(exc).__name__}: {exc}"[:300])
        except Exception:  # noqa: BLE001 — the store itself is down; say so to the caller
            return {"status": "failed", "reason": f"{type(exc).__name__}: {exc}"[:300]}
