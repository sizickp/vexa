"""retranscribe — a finished meeting's transcript rebuilt from its whole recording.

Offline: the dict-backed transcript store + recording repo + storage, a scripted STT. Covers the pure
core (clock, speaker attribution, the coverage floor), one service run in each of its exits, and the
route's one-verb contract (start → poll → final state, idempotent, owner-scoped).
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import httpx
import pytest
from fastapi import FastAPI

from meeting_api.collector.fakes import InMemoryTranscriptStore
from meeting_api.recordings.fakes import InMemoryRecordingRepo, InMemoryStorage
from meeting_api.retranscribe import build_router, core, service

USER, OTHER, MID, REC = 7, 8, 41, 5001
START = "2026-06-20T09:00:00Z"
ORIGIN = datetime(2026, 6, 20, 9, 0, 0, tzinfo=timezone.utc).timestamp()
PREFIX = f"recordings/{USER}/{REC}/sess/audio"


def _live(start: float, end: float, speaker: str, text: str, sid: str) -> dict:
    return {"segment_id": sid, "start": ORIGIN + start, "end": ORIGIN + end, "speaker": speaker,
            "text": text, "language": "ru", "completed": True}


LIVE = [
    _live(1.0, 4.0, "Анна", "ну давайте начнём с бэкапов", "l1"),
    _live(4.5, 9.0, "Борис", "бэкапы за ночь прошли без ошибок", "l2"),
    _live(20.0, 24.0, "Анна", "тогда переходим к мониторингу", "l3"),
]
STT = [
    {"start": 0.8, "end": 4.2, "text": "Ну, давайте начнём с бэкапов."},
    {"start": 4.4, "end": 9.3, "text": "Бэкапы за ночь прошли без ошибок, проверил утром."},
    {"start": 9.6, "end": 12.0, "text": "И восстановление тоже проверил."},      # live dropped this stretch
    {"start": 19.8, "end": 24.5, "text": "Тогда переходим к мониторингу."},
    {"start": 60.0, "end": 62.0, "text": "Кто-то издалека."},                       # nobody near
]


class FakeStt:
    def __init__(self, segments=None, error: Exception | None = None, hold: asyncio.Event | None = None):
        self.segments, self.error, self.calls = segments if segments is not None else STT, error, []
        self.hold = hold                                 # set → the pass stays in flight until released

    async def transcribe(self, audio, *, filename, content_type, language):
        self.calls.append({"bytes": len(audio), "filename": filename,
                           "content_type": content_type, "language": language})
        if self.hold is not None:
            await self.hold.wait()
        if self.error:
            raise self.error
        return self.segments


async def _rig(*, live=LIVE, status="completed", with_recording=True):
    recording = {"id": REC, "meeting_id": MID, "status": "completed", "media_files": [
        {"id": 9001, "type": "audio", "format": "webm", "storage_path": f"{PREFIX}/000000.webm"}]}
    store = InMemoryTranscriptStore()
    store.seed_meeting(user_id=USER, platform="jitsi", native_meeting_id="room@host", status=status,
                       meeting_id=MID, start_time=START,
                       data={"recordings": [recording]} if with_recording else {},
                       segments=[dict(s) for s in live])
    repo = InMemoryRecordingRepo()
    repo.seed(meeting_id=MID, user_id=USER, session_uid="sess", status=status)
    storage = InMemoryStorage()
    if with_recording:
        await repo.put_recordings(MID, [recording])
        await storage.upload(f"{PREFIX}/000000.webm", b"\x1a\x45\xdf\xa3" + b"A" * 60, content_type="audio/webm")
        await storage.upload(f"{PREFIX}/000001.webm", b"B" * 64, content_type="audio/webm")
    return store, repo, storage


def _texts(store) -> list[str]:
    segs = sorted(store._meetings[MID]["segments"].values(), key=lambda s: s["start"])
    return [s["text"] for s in segs]


# ── core ─────────────────────────────────────────────────────────────────────

def test_rows_land_on_the_live_clock_and_take_the_live_speakers():
    rows = core.build_rows(STT, origin_epoch=ORIGIN, live=LIVE, language="ru", run_id="offline-x")
    assert [r["speaker"] for r in rows] == ["Анна", "Борис", "Борис", "Анна", None]
    assert rows[0]["start"] == pytest.approx(ORIGIN + 0.8) and rows[0]["end"] == pytest.approx(ORIGIN + 4.2)
    assert [r["segment_id"] for r in rows] == [f"offline-x:{i}" for i in range(5)]
    assert all(r["session_uid"] == "offline-x" and r["language"] == "ru" for r in rows)


def test_a_stretch_the_live_pipeline_dropped_continues_the_previous_speaker():
    # 9.6–12.0 overlaps no live segment and is 0.6 s after Борис's — nearest names it; a stretch
    # further than NEAREST_S from every live segment inherits across a short gap instead
    stt = [{"start": 4.4, "end": 9.3, "text": "первое"}, {"start": 13.0, "end": 15.0, "text": "второе"},
           {"start": 15.5, "end": 16.5, "text": "третье"}]
    rows = core.build_rows(stt, origin_epoch=ORIGIN, live=LIVE[:2], language=None, run_id="r")
    assert [r["speaker"] for r in rows] == ["Борис", None, None]          # 13.0 is 4 s from Борис: nobody
    stt[1]["start"] = 10.5                                                   # now 1.5 s away: nearest
    rows = core.build_rows(stt, origin_epoch=ORIGIN, live=LIVE[:2], language=None, run_id="r")
    assert [r["speaker"] for r in rows] == ["Борис", "Борис", "Борис"]    # and the third inherits


def test_live_rows_counted_from_meeting_start_keep_that_clock():
    relative = [{"start": 1.0, "end": 4.0, "speaker": "Анна", "text": "раз"}]
    rows = core.build_rows([{"start": 1.2, "end": 3.9, "text": "раз"}], origin_epoch=ORIGIN,
                           live=relative, language=None, run_id="r")
    assert rows[0]["start"] == pytest.approx(1.2) and rows[0]["speaker"] == "Анна"


def test_empty_text_and_reversed_times_do_not_make_rows():
    rows = core.build_rows([{"start": 0, "end": 1, "text": "  "}, {"start": 5, "end": 3, "text": "ок"}],
                           origin_epoch=0.0, live=[], language=None, run_id="r")
    assert len(rows) == 1 and rows[0]["start"] <= rows[0]["end"]


def test_the_coverage_floor_refuses_a_thinner_transcript():
    live = [{"text": "one two three four five six seven eight nine ten"}]
    assert core.thinner_than_live([{"text": "one two three four five"}], live) is True       # 50%
    assert core.thinner_than_live([{"text": "one two three four five six"}], live) is False  # 60%
    assert core.thinner_than_live([{"text": "anything"}], []) is False                       # nothing to lose


def _minute(i: int, text: str) -> dict:
    return {"start": ORIGIN + i * 60 + 5, "end": ORIGIN + i * 60 + 50, "text": text}


def test_a_silent_stretch_of_the_recording_is_a_gap_whatever_the_total_says():
    talk = " ".join(["слово"] * 30)
    live = [_minute(i, talk) for i in range(10)]                             # ten full minutes
    whole = [_minute(i, talk) for i in range(10)]
    assert core.first_gap(whole, live) is None
    holed = [_minute(i, talk) for i in range(10) if i not in (6, 7)]         # two minutes lost: 80% overall
    assert not core.thinner_than_live(holed, live)                           # …clears the coverage floor
    assert core.first_gap(holed, live) == {"at_s": 360, "live_words": 30, "words": 0}
    # one long rebuilt segment across a window border covers both windows
    spanning = [{"start": ORIGIN + 5, "end": ORIGIN + 110, "text": " ".join(["слово"] * 60)}]
    assert core.first_gap(spanning, live[:2]) is None
    # a quiet minute in the live transcript is not evidence of anything
    assert core.first_gap([], [_minute(0, "да нет")]) is None


def test_the_meeting_language_is_the_one_its_live_segments_carry():
    assert core.dominant_language([{"language": "ru"}, {"language": "ru"}, {"language": "en"}], "de") == "ru"
    assert core.dominant_language([{"language": None}], "de") == "de"
    assert core.dominant_language([], None) is None


def test_a_run_is_claimed_in_the_stored_state_not_in_a_process():
    fresh = core.claim({}, now=1000.0, lease_s=90)
    assert fresh["status"] == "running" and fresh["lease_until"] == 1090.0
    assert fresh["started_at"] == "1970-01-01T00:16:40Z"
    assert core.claim(fresh, now=1050.0) is None                           # a live run holds it
    assert core.claim(fresh, now=1050.0, force=True) is None               # …even against force
    assert core.claim(fresh, now=1091.0)["lease_until"] == 1091.0 + core.LEASE_S   # lost with its process
    done = {"status": "completed", "segments": 5, "lease_until": None}
    assert core.claim(done, now=2000.0) is None                            # a final state stays
    again = core.claim(done, now=2000.0, force=True)
    assert again["status"] == "running" and "segments" not in again        # a new run, not the old counts


# ── service: one run, every exit a state ─────────────────────────────────────

async def test_a_run_replaces_the_transcript_and_records_what_it_did():
    store, repo, storage = await _rig()
    stt = FakeStt()
    state = await service.run(store, repo, storage, stt, user_id=USER, meeting_id=MID, default_language="en")
    assert state["status"] == "completed" and state["segments"] == 5 and state["unnamed"] == 1
    assert state["live_segments"] == 3 and state["words"] > state["live_words"]
    assert _texts(store)[0] == "Ну, давайте начнём с бэкапов."
    assert "И восстановление тоже проверил." in _texts(store)               # the dropped stretch is back
    assert stt.calls == [{"bytes": 128, "filename": f"meeting-{MID}.webm",   # the WHOLE master, once
                          "content_type": "audio/webm", "language": "ru"}]   # the meeting's own language
    assert store._meetings[MID]["data"]["retranscription"]["status"] == "completed"


async def test_a_recording_with_gaps_never_replaces_a_fuller_live_transcript():
    store, repo, storage = await _rig()
    state = await service.run(store, repo, storage, FakeStt([{"start": 1, "end": 2, "text": "ну давайте"}]),
                              user_id=USER, meeting_id=MID)
    assert state["status"] == "skipped" and "fewer words" in state["reason"]
    assert _texts(store) == [s["text"] for s in LIVE]                        # live rows untouched


async def test_a_recording_with_a_lost_stretch_keeps_the_live_transcript():
    talk = " ".join(["слово"] * 30)
    live = [{**_minute(i, talk), "speaker": "Анна", "language": "ru", "completed": True,
             "segment_id": f"l{i}"} for i in range(10)]
    stt = [{"start": i * 60 + 5, "end": i * 60 + 50, "text": talk} for i in range(10) if i not in (6, 7)]
    store, repo, storage = await _rig(live=live)
    state = await service.run(store, repo, storage, FakeStt(stt), user_id=USER, meeting_id=MID)
    assert state["status"] == "skipped" and "gap at 6:00" in state["reason"]
    assert len(_texts(store)) == 10                                          # live rows untouched


async def test_no_recording_no_backend_and_no_speech_are_skips_not_failures():
    store, repo, storage = await _rig(with_recording=False)
    assert (await service.run(store, repo, storage, FakeStt(), user_id=USER, meeting_id=MID))["reason"] \
        == "the meeting has no audio recording"
    store, repo, storage = await _rig()
    assert (await service.run(store, repo, storage, None, user_id=USER, meeting_id=MID))["reason"] \
        == "no transcription backend is configured"
    state = await service.run(store, repo, storage, FakeStt([]), user_id=USER, meeting_id=MID)
    assert state["status"] == "skipped" and state["reason"] == "the recording holds no speech"
    assert _texts(store) == [s["text"] for s in LIVE]


async def test_a_backend_that_refuses_is_a_failed_state_and_the_live_transcript_stays():
    store, repo, storage = await _rig()
    state = await service.run(store, repo, storage, FakeStt(error=RuntimeError("503 busy")),
                              user_id=USER, meeting_id=MID)
    assert state["status"] == "failed" and "503 busy" in state["reason"]
    assert _texts(store) == [s["text"] for s in LIVE]


# ── the route: one verb, its own poll ────────────────────────────────────────

async def _client(store, repo, storage, stt, **router_kw):
    """One PROCESS of the service: its own app and router over the shared store."""
    async def stt_for(_user_id):
        return stt

    app = FastAPI()
    app.include_router(build_router(store, repo, storage, stt_for=stt_for, language=lambda: "ru",
                                    **router_kw))
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _until_done(client, headers) -> dict:
    for _ in range(50):
        body = (await client.post(f"/meetings/{MID}/transcribe", headers=headers)).json()
        if body["status"] != "running":
            return body
        await asyncio.sleep(0.01)
    raise AssertionError("the run never finished")


async def test_the_first_call_starts_the_run_and_later_calls_only_report_it():
    store, repo, storage = await _rig()
    stt = FakeStt()
    headers = {"x-user-id": str(USER)}
    async with await _client(store, repo, storage, stt) as client:
        first = await client.post(f"/meetings/{MID}/transcribe", headers=headers)
        assert first.status_code == 200 and first.json()["status"] == "running"
        done = await _until_done(client, headers)
        assert done["status"] == "completed" and done["meeting_id"] == MID and done["segments"] == 5
        again = (await client.post(f"/meetings/{MID}/transcribe", headers=headers)).json()
        assert again["status"] == "completed" and len(stt.calls) == 1          # no second pass
        forced = await client.post(f"/meetings/{MID}/transcribe", headers=headers, json={"force": True})
        assert forced.json()["status"] == "running"
        assert (await _until_done(client, headers))["status"] == "completed" and len(stt.calls) == 2


async def test_the_route_is_owner_scoped_and_runs_only_on_a_completed_meeting():
    store, repo, storage = await _rig(status="active")
    async with await _client(store, repo, storage, FakeStt()) as client:
        assert (await client.post(f"/meetings/{MID}/transcribe")).status_code == 401
        assert (await client.post(f"/meetings/{MID}/transcribe", headers={"x-user-id": str(OTHER)})).status_code == 404
        refused = await client.post(f"/meetings/{MID}/transcribe", headers={"x-user-id": str(USER)})
        assert refused.status_code == 409 and "completed meeting" in refused.json()["detail"]
        bad = await client.post(f"/meetings/{MID}/transcribe", headers={"x-user-id": str(USER)}, content=b"{nope")
        assert bad.status_code == 422


async def test_a_poll_that_lands_on_another_process_starts_no_second_run():
    store, repo, storage = await _rig()
    release = asyncio.Event()
    stt_a, stt_b = FakeStt(hold=release), FakeStt()
    headers = {"x-user-id": str(USER)}
    async with await _client(store, repo, storage, stt_a) as a, \
            await _client(store, repo, storage, stt_b) as b:
        assert (await a.post(f"/meetings/{MID}/transcribe", headers=headers)).json()["status"] == "running"
        await asyncio.sleep(0.01)                                           # A's pass is now in flight
        for _ in range(3):
            body = (await b.post(f"/meetings/{MID}/transcribe", headers=headers)).json()
            assert body["status"] == "running" and "lease_until" not in body
        forced = await b.post(f"/meetings/{MID}/transcribe", headers=headers, json={"force": True})
        assert forced.json()["status"] == "running"
        release.set()
        done = await _until_done(b, headers)                                # B reports A's result
        assert done["status"] == "completed" and done["segments"] == 5
    assert len(stt_a.calls) == 1 and stt_b.calls == []


async def test_a_run_lost_with_its_process_is_started_again_after_its_lease():
    store, repo, storage = await _rig()
    now = [5000.0]
    await store.stamp_retranscription(MID, {"status": "running", "started_at": "x",
                                            "lease_until": now[0] + 30})   # claimed by a process that died
    stt = FakeStt()
    headers = {"x-user-id": str(USER)}
    async with await _client(store, repo, storage, stt, clock=lambda: now[0]) as client:
        assert (await client.post(f"/meetings/{MID}/transcribe", headers=headers)).json()["status"] == "running"
        await asyncio.sleep(0.02)
        assert stt.calls == []                                              # inside the lease: nothing starts
        now[0] += 31
        assert (await client.post(f"/meetings/{MID}/transcribe", headers=headers)).json()["status"] == "running"
        assert (await _until_done(client, headers))["status"] == "completed" and len(stt.calls) == 1
    assert store._meetings[MID]["data"]["retranscription"]["lease_until"] is None


async def test_a_long_run_renews_its_lease():
    store, repo, storage = await _rig()
    now = [5000.0]
    release = asyncio.Event()
    stt = FakeStt(hold=release)
    headers = {"x-user-id": str(USER)}
    async with await _client(store, repo, storage, stt, clock=lambda: now[0], lease_s=90,
                             heartbeat_s=0.01) as client:
        await client.post(f"/meetings/{MID}/transcribe", headers=headers)
        now[0] += 80                                                        # most of the lease has passed
        await asyncio.sleep(0.05)                                           # …and the run renewed it
        assert store._meetings[MID]["data"]["retranscription"]["lease_until"] == now[0] + 90
        now[0] += 80                                                        # past the FIRST lease
        await client.post(f"/meetings/{MID}/transcribe", headers=headers)
        await asyncio.sleep(0.02)
        assert len(stt.calls) == 1                                          # still the one run
        release.set()
        assert (await _until_done(client, headers))["status"] == "completed"
