# @vexa/telemost-capture — Telemost's contribution to the mixed lane (browser)

_meetings/ · module · Telemost page → `mixed-capture.v1` hints (the WHO signal)._

Runs **inside the meeting page**. Like Jitsi, Telemost delivers one mixed audio stream (captured by
[`@vexa/mixed-capture-core`](../mixed-capture-core/)), so this brick provides only the **WHO** signal
— no audio of its own:

- `installTelemostSignalTap` — installed at document start (the bot's init script, beside the WebRTC
  audio hook): observes the call frame's media-engine socket (goloom) — the roster (`id → name`) and each
  participant slot's server-side `vad` flag from `slotsConfig`. The engine re-sends slots on layout
  changes: with a screen shared that is per speaker change, in the plain grid it can be minutes apart.
- `createTelemostSpeakers` — who is speaking: the participant tiles' speaking outline always; with a
  screen shared (the presenter's tile gets no outline) the engine's slot VAD is added. Emits speaking
  start/stop per participant → a `mixed-capture.v1`
  **hint** (kind `dom-active`). Several people can speak at once, so it tracks a set of speakers; a short
  release window rides out flicker, and a ~2 s heartbeat re-asserts a still-speaking participant. This
  module OWNS the Telemost tile selector arrays.

## Surface
`installTelemostSignalTap` · `telemostSignalState` · `applyTelemostSignal` · `createTelemostSpeakers` · the selector arrays (`telemostTileSelectors`, `telemostSpeakingSelectors`,
`telemostTileNameSelectors`) (+ types `TelemostSpeakers`, `TelemostSpeakersOptions`).
Front door: [`src/index.ts`](src/index.ts).

## Verify
`pnpm --filter @vexa/telemost-capture run build` — `tsc` clean. The L2 unit drives the watcher against a
fake document (no browser); the selectors themselves are validated **live** in a real Telemost call.
`tsconfig` adds the `DOM` lib. Covered by `gate:node`, `gate:isolation`, `gate:exports`, `gate:readme`.
