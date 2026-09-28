# @vexa/jitsi-capture — Jitsi's contribution to the mixed lane (browser)

_meetings/ · module · Jitsi page → `mixed-capture.v1` hints (the WHO signal) + chat._

Runs **inside the meeting page**. Like Zoom and Teams, Jitsi delivers one mixed audio stream (captured
by [`@vexa/mixed-capture-core`](../mixed-capture-core/)), so this brick provides only the **WHO** signal
and chat — no audio of its own:

- `createJitsiSpeakers` — watches the app's own dominant-speaker state (`APP.store` redux — what
  jitsi's UI renders from; `.dominant-speaker` tile DOM fallback for builds that strip the global) and
  emits speaking start/stop per participant → a `mixed-capture.v1` **hint** (kind `dom-active`). A ~2 s
  heartbeat re-asserts the still-dominant speaker so a consumer that started mid-turn learns who's
  talking without waiting for the next transition. This module OWNS the jitsi selector arrays.
- `createJitsiChat` — reads the conference chat (redux-primary, so the panel need **not** be open; DOM
  fallback otherwise); emits each new message as `{ sender, text }`.
- `sendJitsiChatMessage` — posts into the conference chat via the app's own `sendTextMessage` API.
- `jitsiRemoteParticipantCount` — who is in the room, from the app's participant list
  (`features/base/participants.remote`, minus fake/virtual-screenshare/hidden tiles). The lane's
  presence oracle on jitsi: the bridge keeps a departed participant's receiver live and unmuted, so
  the default track count reads an empty room as N present streams and the bot's deaf-capture
  guard never lets it leave. `null` when the `APP` global is stripped → the bot keeps its track count.

## Surface
`createJitsiSpeakers` · `createJitsiChat` · `sendJitsiChatMessage` · `jitsiRemoteParticipantCount` · the selector arrays
(`jitsiDominantTileSelectors`, `jitsiTileNameSelectors`, `jitsiChatContainerSelectors`,
`jitsiChatMessageSelectors`, `jitsiChatSenderSelectors`, `jitsiChatTextSelectors`) (+ types
`JitsiSpeakers`, `JitsiSpeakersOptions`, `JitsiChat`, `JitsiChatMessage`, `JitsiChatOptions`, `JitsiParticipantLike`).
Front door: [`src/index.ts`](src/index.ts).

## Verify
`pnpm --filter @vexa/jitsi-capture run build` — `tsc` clean. The L2 unit drives both observers and the
presence oracle against a fake `APP.store` (no browser); the DOM fallbacks and live behavior are validated **live** in a real
Jitsi meeting — consistent with how the lane has always been tested. `tsconfig` adds the `DOM` lib.
Covered by `gate:node`, `gate:isolation`, `gate:exports`, `gate:readme`.
