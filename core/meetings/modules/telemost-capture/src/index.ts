/**
 * @vexa/telemost-capture — Yandex Telemost's contribution to the mixed lane.
 *
 * Like Jitsi, Telemost delivers one mixed audio stream (captured by
 * @vexa/mixed-capture-core); this module provides the WHO signal:
 *   - installTelemostSignalTap: at document start, observes the call's media-engine
 *     socket — the roster and each participant slot's server-side VAD flag.
 *   - createTelemostSpeakers: who is speaking — the engine's slot VAD when the tap is
 *     live, the participant tiles' speaking marker otherwise → a mixed-capture.v1
 *     `hint` (kind 'dom-active') per speaker.
 */
export {
  createTelemostSpeakers,
  telemostTileSelectors,
  telemostSpeakingSelectors,
  telemostTileNameSelectors,
  telemostSelfTileSelectors,
} from "./telemost-speakers.js";
export type { TelemostSpeakers, TelemostSpeakersOptions } from "./telemost-speakers.js";
export { installTelemostSignalTap, telemostSignalState, applyTelemostSignal } from "./telemost-signal.js";
export type { TelemostSignalState } from "./telemost-signal.js";
