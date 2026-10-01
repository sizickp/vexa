# retranscribe

Rebuild a finished meeting's transcript from its whole recording.

The live pipeline transcribes short windows cut at pauses and speaker changes; each reaches the
speech-to-text backend without its neighbours, so words are lost and doubled at the seams. Once the
meeting is over the recording master goes to the same backend in ONE pass, and the result replaces
the live rows.

## Surface

`POST /meetings/{meeting_id}/transcribe` (api.v1, scope `tx`, owner-scoped):

- the first call on a `completed` meeting starts the run in the background and answers
  `{"status": "running"}`;
- every later call answers the run's current state and starts nothing — the verb is its own poll;
- the run ends in `completed`, `skipped` or `failed`, each with a `reason` and counts
  (`segments`, `words`, `live_words`, `stt_seconds`, `unnamed`);
- `{"force": true}` runs it again.

A meeting that is not `completed` answers `409`; one the caller does not own, `404`.

The state lives in `meeting.data['retranscription']`.

The service runs as several processes and a poll lands on any of them, so a run is claimed in that
stored state under the meeting's row lock (`core.claim`) and holds a lease it renews every 20 s. A
poll that reaches another process reads the claim and starts nothing; a run whose process died
stops renewing, and the first poll after the 90 s lease starts it again.

## What a run does

1. Assembles the recording master (`recordings.finalize_master`) and reads it from storage.
2. Sends it whole to the transcription backend a bot spawn for this person would use
   (`TRANSCRIPTION_SERVICE_URL` / `_TOKEN` / `TRANSCRIPTION_MODEL`, or the Settings-configured one),
   asking for segment timestamps and voice-activity filtering.
3. Puts the segments on the live transcript's clock (the recording starts at `meeting.start_time`)
   and names each from the live segment that overlaps it most — the recording is one mixed track,
   the live transcript carries the platform's speaker signal.
4. Replaces the meeting's `transcriptions` rows in one transaction.

A recording with gaps can only lose speech, so two checks refuse the rewrite (`skipped`) and keep the
live transcript: the rewrite holds fewer than 60% of the live transcript's words overall, or some
minute where the live transcript holds 20 words or more has under a quarter of them in the rewrite.

## Layout

`core.py` (pure: clock, attribution, coverage, the lease) · `service.py` (one run) · `adapters.py` (the HTTP
STT client, resolved like a spawn) · `router.py` (the route) · `ports.py`.

Tests: `tests/test_retranscribe.py`.
