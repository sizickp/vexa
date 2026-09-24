/**
 * @vexa/telemost-capture — Yandex Telemost's contribution to the mixed lane.
 *
 * Like Jitsi, Telemost delivers one mixed audio stream (captured by
 * @vexa/mixed-capture-core); this module provides the WHO signal:
 *   - createTelemostSpeakers: watches the participant tiles for a speaking
 *     marker → a mixed-capture.v1 `hint` (kind 'dom-active') per speaker.
 */
export {
  createTelemostSpeakers,
  telemostTileSelectors,
  telemostSpeakingSelectors,
  telemostTileNameSelectors,
  telemostSelfTileSelectors,
} from "./telemost-speakers.js";
export type { TelemostSpeakers, TelemostSpeakersOptions } from "./telemost-speakers.js";
