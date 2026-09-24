# behavior/prompts

Agent-turn kickoffs the flows engine formats and dispatches. A private tree at
`VEXA_BEHAVIOR_DIR/prompts/` resolves before these.

- [`process-meeting.md`](process-meeting.md) — the post-meeting report turn (`post_meeting` →
  `process_meeting`). Placeholders: `{mid}`, `{native}`, `{date}`; the turn fetches the transcript
  itself with a `tx`-only key from the person's `_system/vexa-api-key`.
