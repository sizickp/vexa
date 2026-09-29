/**
 * @vexa/jitsi-capture — Jitsi Meet's contribution to the mixed lane.
 *
 * Like Zoom/Teams, Jitsi delivers one mixed audio stream (captured by
 * @vexa/mixed-capture-core); this module provides the WHO + chat signals:
 *   - createJitsiSpeakers: watches the app's dominant-speaker state (redux
 *     primary, DOM fallback) → a mixed-capture.v1 `hint` (kind 'dom-active').
 *   - createJitsiChat: reads conference chat (redux primary — the panel need
 *     not be open; DOM fallback) + sendJitsiChatMessage over the app's own API.
 *   - jitsiRemoteParticipantCount: who is in the room, from the app's participant
 *     list — the lane's presence oracle on jitsi (the tracks lie there); sibling
 *     Vexa bots (jitsiMarkSelfAsVexaBot's presence marker, or a Vexa bot's name)
 *     are not people and are left out.
 */
export {
  createJitsiSpeakers,
  jitsiDominantTileSelectors,
  jitsiTileNameSelectors,
} from "./jitsi-speakers.js";
export type { JitsiSpeakers, JitsiSpeakersOptions } from "./jitsi-speakers.js";
export {
  createJitsiChat,
  sendJitsiChatMessage,
  jitsiChatContainerSelectors,
  jitsiChatMessageSelectors,
  jitsiChatSenderSelectors,
  jitsiChatTextSelectors,
} from "./jitsi-chat.js";
export type { JitsiChat, JitsiChatMessage, JitsiChatOptions } from "./jitsi-chat.js";
export {
  jitsiRemoteParticipantCount,
  jitsiMarkSelfAsVexaBot,
  VEXA_BOT_PRESENCE_PROPERTY,
  KNOWN_VEXA_BOT_NAMES,
} from "./jitsi-presence.js";
export type { JitsiParticipantLike, JitsiPresenceOptions } from "./jitsi-presence.js";
