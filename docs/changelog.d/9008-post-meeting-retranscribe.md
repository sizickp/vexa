- **The post-meeting report is written from a transcript rebuilt out of the whole recording (#9008).**
  The live transcript is cut from short windows the speech-to-text backend hears one at a time, so
  words go missing and double at the seams. `POST /meetings/{meeting_id}/transcribe` — declared by
  api.v1 and never served until now — sends a completed meeting's recording through the same
  backend in one pass and replaces the live rows, keeping the live transcript's speaker names. The
  stock `post_meeting` flow (now version 5) starts with a `retranscribe` step, so the report and
  the minutes read the rebuilt transcript. A meeting with no recording, no backend, or a recording
  that would lose speech keeps its live transcript and goes straight to the report. See
  [Recordings](/how-to/recordings#re-transcribe-from-the-recording).
