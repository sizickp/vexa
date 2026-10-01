"""retranscribe core — PURE. Turn one speech-to-text pass over a finished meeting's whole recording
into transcript rows, named from the live transcript.

The live pipeline transcribes short windows cut at pauses and speaker changes; each window reaches
the STT backend without its neighbours, so words are lost and doubled at the seams. A pass over the
whole recording gives the backend its context back. What it cannot give is WHO spoke — the recording
is one mixed track — so every new segment takes its speaker from the live segments, which carry the
platform's own speaker signal with the same clock.

No I/O here: the service passes in what the STT returned and what the live transcript holds.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

#: A new segment no live segment overlaps takes the nearest live speaker within this many seconds.
NEAREST_S = 3.0
#: …and failing that, inherits the previous new segment's speaker across a gap no longer than this:
#: a stretch the live pipeline dropped is usually the same person still talking.
CONTINUATION_GAP_S = 2.0
#: The rewrite is refused when it holds fewer than this share of the live transcript's words. A
#: recording with holes (a capture that missed tracks) can only LOSE speech; never trade a fuller
#: transcript for a thinner one.
COVERAGE_FLOOR = 0.6
#: Segment times at or above this are epoch seconds; below it they are seconds from meeting start.
_EPOCH_FLOOR = 1_000_000_000.0


def word_count(segments: list[dict]) -> int:
    return sum(len(str(s.get("text") or "").split()) for s in segments)


def time_base(live: list[dict], origin_epoch: float) -> float:
    """What a recording-relative second is added to so it lands on the live transcript's clock:
    the meeting's start as epoch seconds when the live rows are stamped in epoch, else zero (rows
    counted from meeting start). An empty live transcript follows the epoch convention."""
    starts = [float(s["start"]) for s in live if s.get("start") is not None]
    if starts and max(starts) < _EPOCH_FLOOR:
        return 0.0
    return origin_epoch


def attribute_speakers(rows: list[dict], live: list[dict]) -> list[dict]:
    """Name each row: the live speaker whose interval overlaps it most, else the nearest live
    speaker within ``NEAREST_S``, else the previous row's speaker across ``CONTINUATION_GAP_S``.
    A row nobody can be named for keeps ``speaker = None`` — never a guess."""
    named = [s for s in live if str(s.get("speaker") or "").strip()]
    for row in rows:
        best, best_overlap = None, 0.0
        nearest, nearest_gap = None, NEAREST_S + 1.0
        for s in named:
            overlap = min(row["end"], float(s["end"])) - max(row["start"], float(s["start"]))
            if overlap > best_overlap:
                best, best_overlap = s["speaker"], overlap
            gap = max(float(s["start"]) - row["end"], row["start"] - float(s["end"]), 0.0)
            if gap < nearest_gap:
                nearest, nearest_gap = s["speaker"], gap
        row["speaker"] = best if best_overlap > 0 else (nearest if nearest_gap <= NEAREST_S else None)
    for i, row in enumerate(rows):
        if row["speaker"] is None and i > 0 and rows[i - 1]["speaker"] is not None \
                and row["start"] - rows[i - 1]["end"] <= CONTINUATION_GAP_S:
            row["speaker"] = rows[i - 1]["speaker"]
    return rows


def build_rows(stt_segments: list[dict], *, origin_epoch: float, live: list[dict],
               language: Optional[str], run_id: str) -> list[dict]:
    """The STT's segments (seconds from the recording's first sample) as transcript rows on the
    live transcript's clock, named from it. Empty text is dropped; ``segment_id`` is unique per run
    so a re-run replaces rather than collides."""
    base = time_base(live, origin_epoch)
    rows: list[dict] = []
    for i, seg in enumerate(stt_segments):
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        try:
            start = float(seg.get("start") or 0.0)
            end = float(seg.get("end") if seg.get("end") is not None else start)
        except (TypeError, ValueError):
            continue
        if end < start:
            start, end = end, start
        rows.append({"start": round(base + start, 3), "end": round(base + end, 3), "text": text,
                     "speaker": None, "language": language, "session_uid": run_id,
                     "segment_id": f"{run_id}:{i}"})
    return attribute_speakers(rows, live)


def thinner_than_live(rows: list[dict], live: list[dict], floor: float = COVERAGE_FLOOR) -> bool:
    """True when the rewrite would shrink the transcript below ``floor`` of the live word count."""
    live_words = word_count(live)
    return live_words > 0 and word_count(rows) < floor * live_words


GAP_WINDOW_S = 60.0       # the stretch a gap is looked for in
GAP_LIVE_WORDS = 20       # …when the live transcript holds at least this many words there
GAP_FLOOR = 0.25          # …and the rewrite holds less than this share of them


def _words_per_window(segments: list[dict], origin: float, window_s: float) -> dict[int, float]:
    """Each segment's words spread over the windows it spans, in proportion to the overlap."""
    out: dict[int, float] = {}
    for s in segments:
        words = len(str(s.get("text") or "").split())
        if not words:
            continue
        start = float(s.get("start") or 0.0) - origin
        end = max(float(s.get("end") or 0.0) - origin, start)
        if end - start <= 0:
            out[int(start // window_s)] = out.get(int(start // window_s), 0.0) + words
            continue
        for w in range(int(start // window_s), int(end // window_s) + 1):
            overlap = min(end, (w + 1) * window_s) - max(start, w * window_s)
            if overlap > 0:
                out[w] = out.get(w, 0.0) + words * overlap / (end - start)
    return out


def first_gap(rows: list[dict], live: list[dict], *, window_s: float = GAP_WINDOW_S,
              min_live_words: int = GAP_LIVE_WORDS, floor: float = GAP_FLOOR) -> Optional[dict]:
    """The first stretch where the live transcript holds speech and the rewrite almost none — a GAP
    IN THE RECORDING — or ``None``.

    A recording that lost a stretch is silent there, so the pass over it returns nothing for those
    minutes while the live transcript, which heard the meeting directly, has them. The overall word
    count hides that in a long meeting: a quarter of the hour can be missing and the rewrite still
    clears the coverage floor. ``{at_s, live_words, words}`` — seconds from the first live segment."""
    starts = [float(s.get("start") or 0.0) for s in live if str(s.get("text") or "").strip()]
    if not starts:
        return None
    origin = min(starts)
    had = _words_per_window(live, origin, window_s)
    got = _words_per_window(rows, origin, window_s)
    for w in sorted(had):
        if had[w] >= min_live_words and got.get(w, 0.0) < floor * had[w]:
            return {"at_s": int(w * window_s), "live_words": int(round(had[w])),
                    "words": int(round(got.get(w, 0.0)))}
    return None


def dominant_language(live: list[dict], default: Optional[str]) -> Optional[str]:
    """The language most live segments carry — the meeting's own — else the deployment default."""
    counts: dict[str, int] = {}
    for s in live:
        lang = str(s.get("language") or "").strip()
        if lang:
            counts[lang] = counts.get(lang, 0) + 1
    return max(counts, key=counts.get) if counts else (default or None)


# ── the run's lease ──────────────────────────────────────────────────────────
TERMINAL = ("completed", "skipped", "failed")
LEASE_S = 90.0        # a run that has not renewed its lease for this long is lost
HEARTBEAT_S = 20.0    # how often a live run renews it


def claim(state: dict, *, now: float, lease_s: float = LEASE_S, force: bool = False) -> Optional[dict]:
    """The state a NEW run starts from, or ``None`` when no run starts.

    The service runs as several processes and the caller's poll lands on any of them, so "is a run
    in flight" is read from the stored state, never from a process's memory: a ``running`` state
    whose lease is still ahead of ``now`` belongs to a live run somewhere, and nothing starts — not
    even with ``force``. A ``running`` state whose lease has passed is a run lost with its process,
    and is started again. A final state starts again only with ``force``."""
    status = state.get("status")
    if status == "running" and float(state.get("lease_until") or 0) > now:
        return None
    if status in TERMINAL and not force:
        return None
    started = datetime.fromtimestamp(now, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"status": "running", "reason": None, "completed_at": None,
            "started_at": started, "lease_until": now + lease_s}
