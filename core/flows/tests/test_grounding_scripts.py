"""The grounding gate reads every script. `_phrases` tokenized with `[a-z0-9']+`, so a transcript in
Cyrillic had no phrases at all and `grounded_in` refused every report of a Russian meeting — including
one that quoted the transcript verbatim (meeting 23, 2026-09-24)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flows_steps import meeting as mt  # noqa: E402

RU_TRANSCRIPT = (
    "Так, реплики есть.\nКусок потерялось. Ладно, давай так. Слышно меня? Где мои реплики?\n"
    "Я говорю в первом окне.\nКлод хорошо починил. Вот сейчас второе окно.\n"
)


def test_a_cyrillic_transcript_has_phrases():
    assert mt._phrases(RU_TRANSCRIPT), "a Russian transcript must yield six-word windows"


def test_a_report_quoting_a_russian_meeting_is_grounded():
    note = ("## Суть\nТест переключения окон.\n## Решения\n- Иван: «Кусок потерялось. Ладно, давай так. "
            "Слышно меня? Где мои реплики?»\n")
    assert mt.grounded_in(note, RU_TRANSCRIPT)


def test_a_fabricated_russian_report_is_still_refused():
    note = "## Суть\nОбсудили бюджет на следующий квартал и договорились о встрече с подрядчиком в четверг.\n"
    assert not mt.grounded_in(note, RU_TRANSCRIPT)


def test_latin_grounding_is_unchanged():
    transcript = "So we agreed to ship the release on Thursday after the migration finishes tonight."
    assert mt.grounded_in("They agreed to ship the release on Thursday after the migration.", transcript)
    assert not mt.grounded_in("Nothing about a release was said here at all.", transcript)


def test_apostrophes_stay_inside_a_word_and_an_empty_transcript_still_passes():
    assert "don't" in " ".join(mt._phrases("we don't ship anything before the migration finishes tonight"))
    assert mt.grounded_in("anything at all", "")
