"""retranscribe — the report waits for the transcript rebuilt from the whole recording.

The step asks the meetings domain and waits for its answer; it holds no audio and calls no
speech-to-text backend. Covered here: it waits only while the run is running, every other answer
lets the report proceed with the reason on the receipt, an unanswering door is not waited on
forever, and the flow runs it before the report is written.
"""
from __future__ import annotations

import pytest

import flows_defs.production as production
from flows import Done, Registry, Wait
from test_link_loop import _ctx, _StubDB

REFS = {"uid": "7", "meeting_id": "41", "native": "room@host"}


@pytest.fixture
def step(monkeypatch):
    reg = Registry()
    production.build(reg, _StubDB())
    answers: list = []
    asked: list = []

    def retranscribe(uid, meeting_id):
        asked.append((uid, meeting_id))
        return answers.pop(0) if answers else None

    monkeypatch.setattr(production.mt, "meeting_row", lambda uid, mid, native: {"id": 41})
    monkeypatch.setattr(production.mt, "retranscribe", retranscribe)
    return reg.steps["retranscribe"], answers, asked


def test_it_waits_while_the_run_is_running_and_asks_for_the_meeting_row(step):
    run, answers, asked = step
    answers.append({"status": "running"})
    out = run(_ctx(dict(REFS)))
    assert isinstance(out, Wait) and asked == [("7", 41)]


def test_a_finished_run_is_the_receipt(step):
    run, answers, _ = step
    answers.append({"status": "completed", "reason": None, "segments": 212, "words": 3100,
                    "live_words": 2400, "stt_seconds": 96.0})
    out = run(_ctx(dict(REFS)))
    assert isinstance(out, Done)
    assert out.result == {"status": "completed", "reason": None, "segments": 212,
                          "words": 3100, "live_words": 2400}


@pytest.mark.parametrize("answer", [
    {"status": "skipped", "reason": "the meeting has no audio recording"},
    {"status": "failed", "reason": "RuntimeError: 503 busy"},
    {"status": "refused", "reason": "HTTP 404 — Not Found"},
])
def test_no_answer_but_running_holds_the_report_back(step, answer):
    run, answers, _ = step
    answers.append(answer)
    out = run(_ctx(dict(REFS)))
    assert isinstance(out, Done)
    assert out.result["status"] == answer["status"] and out.result["reason"] == answer["reason"]


def test_a_door_that_does_not_answer_is_waited_on_but_not_forever(step):
    run, answers, _ = step
    scratch: dict = {}
    assert isinstance(run(_ctx(dict(REFS), scratch=scratch)), Wait)       # nobody answered: wait
    scratch["t0"] -= 46 * 60                                              # …for 46 minutes
    out = run(_ctx(dict(REFS), scratch=scratch))
    assert isinstance(out, Done) and out.result["status"] == "abandoned"
    answers.append({"status": "running"})                                 # the same for a run that never ends
    out = run(_ctx(dict(REFS), scratch=scratch))
    assert isinstance(out, Done) and out.result["status"] == "abandoned"


def test_a_meeting_with_no_row_is_not_asked_about(step, monkeypatch):
    run, _, asked = step
    monkeypatch.setattr(production.mt, "meeting_row", lambda uid, mid, native: None)
    out = run(_ctx(dict(REFS)))
    assert isinstance(out, Done) and out.result["status"] == "skipped" and asked == []


def test_the_report_is_written_after_the_transcript_is_rebuilt():
    reg = Registry()
    production.build(reg, _StubDB())
    steps = list(reg.flows[("post_meeting", 6)].steps)
    assert steps.index("retranscribe") < steps.index("process_meeting")
    assert reg.step_needs["retranscribe"] == frozenset({"meetings"})
    assert ("post_meeting", 5) not in reg.flows
