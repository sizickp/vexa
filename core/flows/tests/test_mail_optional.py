"""A deployment without mail — or with a mail server that keeps failing — still gets the meeting's
report onto the desks. The mail steps complete without sending (`skipped`) when no transport is
configured, give up on a failing send at the bounded ceiling (`failed`), and never fail the
reaction that `drop_to_attendees` runs after."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from flows import Done, Registry, StepError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import flows_defs.production as production  # noqa: E402
import flows_steps.notify as notify_mod  # noqa: E402
from flows import Reaction, StepCtx  # noqa: E402
from test_link_loop import FakeChannel, FakeScaffolds, _StubDB  # noqa: E402

MAIL_ENV = ("VEXA_MAIL_ADDR", "VEXA_MAIL_APP_PASSWORD", "VEXA_MAIL_SMTP_HOST")
REFS = {"uid": "7", "organizer": "a@bank.test", "title": "T", "meeting_id": 41, "native": "abc",
        "participants": ["b@bank.test"]}


def _ctx(attempt: int = 1) -> StepCtx:
    r = Reaction("rid", "sid", "e", dict(REFS), "f", 1, "step", "running", attempt, 0.0,
                 None, None, None)
    return StepCtx(reaction=r, effect_key="rid:step",
                   prior={"process_meeting": {"report": "the report"}},
                   clock_now=1_700_000_000.0, scratch={})


class _FailingChannel(FakeChannel):
    def send(self, *a, **k):
        raise ConnectionRefusedError("smtp down")


@pytest.fixture
def steps(monkeypatch):
    scaffolds = FakeScaffolds()
    monkeypatch.setattr(production, "mint_scaffold", scaffolds)
    monkeypatch.setattr(production, "setting", lambda uid, key: True)
    monkeypatch.setattr(production.mt, "meeting_row", lambda uid, m, native=None: {"id": 41})
    reg = Registry()
    production.build(reg, _StubDB())
    yield reg.steps, scaffolds
    notify_mod.use(None)


def test_no_transport_is_a_skip_not_a_failure(monkeypatch, steps):
    for k in MAIL_ENV:
        monkeypatch.delenv(k, raising=False)
    notify_mod.use(None)                       # the env-selected SMTP channel, nothing configured
    step, scaffolds = steps
    assert notify_mod.available() is False
    out = step["email_minutes"](_ctx())
    assert isinstance(out, Done) and out.result["skipped"] == "mail is not configured on this deployment"
    assert scaffolds.minted == []                      # no link minted for a mail that will not go


def test_the_attendee_mail_mints_nothing_without_a_transport(monkeypatch, steps):
    for k in MAIL_ENV:
        monkeypatch.delenv(k, raising=False)
    notify_mod.use(None)
    step, _ = steps

    def _forbidden(*a, **k):
        raise AssertionError("a share capability was minted for a mail that cannot be sent")

    monkeypatch.setattr(production.mt, "mint_transcript_share", _forbidden)
    out = step["email_attendees"](_ctx())
    assert isinstance(out, Done)
    assert out.result["drops"] == [] and out.result["skipped"].startswith("mail is not configured")


def test_a_configured_transport_still_sends(steps):
    notify_mod.use(FakeChannel())
    step, _ = steps
    out = step["email_minutes"](_ctx())
    assert isinstance(out, Done) and "message_id" in out.result


def test_a_failing_send_retries_then_gives_up_out_loud(steps):
    notify_mod.use(_FailingChannel())
    step, _ = steps
    with pytest.raises(StepError) as e:
        step["email_minutes"](_ctx(attempt=1))
    assert e.value.retryable
    out = step["email_minutes"](_ctx(attempt=production.ATTENDEE_MAIL_ATTEMPTS))
    assert isinstance(out, Done)
    assert "smtp down" in out.result["failed"][0]
    assert out.result["link"]                      # the drop reuses the organiser's link
