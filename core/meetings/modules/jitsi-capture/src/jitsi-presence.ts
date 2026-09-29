/**
 * Who is in the room — Jitsi's own participant list as the mixed lane's presence oracle.
 *
 * The lane's default presence signal counts remote audio tracks that are `live` and not `muted`
 * (capture-bridge, #1192). On Jitsi that signal cannot tell an empty room from a quiet one: the
 * bridge (JVB) keeps a departed participant's receiver alive — nothing ends or mutes the track when
 * they leave — so a room everyone has left still reads as N present streams. The deaf-capture guard
 * then sees "streams but no audio", suspects its own capture and holds the bot in the empty room
 * for good. The app's redux state knows who is actually here: `features/base/participants.remote`,
 * the Map jitsi's own tile grid renders from (the same store the dominant-speaker hint reads).
 *
 * Sibling Vexa bots are not people either. Several Vexa deployments can send a bot into the same
 * room (a stand and a production cluster wired to the same calls), and two bots that count each
 * other never see the room empty: each waits for the other to leave. A bot therefore announces
 * itself in its Jitsi presence (`jitsi_participant_vexa_bot`, through the app's own
 * `setLocalParticipantProperty`) and the count leaves marked participants out. Bots built before
 * the marker exist only under their names, so a participant named like a Vexa bot — the caller's
 * own name or one of the product defaults — is left out as well.
 */

/** The presence property a Vexa bot sets on itself; jitsi carries it as `jitsi_participant_vexa_bot`. */
export const VEXA_BOT_PRESENCE_PROPERTY = "vexa_bot";

/** Display names Vexa bots go by when nobody named them — the terminal's and the API's defaults.
 *  A participant with one of these names is a sibling bot without the presence marker. */
export const KNOWN_VEXA_BOT_NAMES: readonly string[] = ["Vexa", "Vexa bot"];

/** The participant fields this oracle reads — the app's own shape, read defensively. */
export interface JitsiParticipantLike {
  id?: string;
  name?: string;
  /** Shared video / whiteboard / etc. — a tile, not a person. */
  fakeParticipant?: unknown;
  /** The second tile a screen-sharing participant gets in the multi-stream layout. */
  isVirtualScreenshareParticipant?: boolean;
  /** Recorder/transcriber members the app keeps out of the grid. */
  hidden?: boolean;
}

export interface JitsiPresenceOptions {
  /** The bot's own display name: another participant carrying it is a sibling bot, not a person. */
  selfName?: string;
}

/** lib-jitsi-meet's JitsiParticipant, as far as this oracle reads it. */
interface ConferenceParticipantLike {
  getProperty?: (name: string) => unknown;
}

const normalizeName = (name: unknown): string =>
  typeof name === "string" ? name.trim().replace(/\s+/g, " ").toLowerCase() : "";

/** The JitsiConference behind the app (`APP.conference._room`), or undefined when not reachable. */
function conferenceRoom(): any {
  return (globalThis as any).APP?.conference?._room;
}

function carriesBotMarker(room: any, id: unknown): boolean {
  try {
    if (!room || typeof room.getParticipantById !== "function" || typeof id !== "string") return false;
    const participant: ConferenceParticipantLike | undefined = room.getParticipantById(id);
    const value = participant?.getProperty?.(VEXA_BOT_PRESENCE_PROPERTY);
    return value === "1" || value === 1 || value === true || value === "true";
  } catch {
    return false;
  }
}

/** Announces the local participant as a Vexa bot in its Jitsi presence, so sibling bots leave it
 *  out of their count whatever it is named. `true` once the property is sent; `false` when the
 *  conference API is not reachable (call again later — the property is idempotent). */
export function jitsiMarkSelfAsVexaBot(): boolean {
  try {
    const room = conferenceRoom();
    if (!room || typeof room.setLocalParticipantProperty !== "function") return false;
    room.setLocalParticipantProperty(VEXA_BOT_PRESENCE_PROPERTY, "1");
    return true;
  } catch {
    return false;
  }
}

/** Remote people present right now, or `null` when the app's store is not reachable (a build
 *  that strips the `APP` global) — the caller then keeps its track count. Left out: tiles that are
 *  not people (fake participants, virtual screenshare tiles, hidden members) and sibling Vexa bots
 *  (the presence marker, or a Vexa bot's name for bots that predate it). */
export function jitsiRemoteParticipantCount(options: JitsiPresenceOptions = {}): number | null {
  try {
    const app = (globalThis as any).APP;
    const participants = app?.store?.getState?.()?.["features/base/participants"];
    const remote = participants?.remote;
    if (!remote || typeof remote.forEach !== "function") return null;
    const botNames = new Set(KNOWN_VEXA_BOT_NAMES.map(normalizeName));
    const self = normalizeName(options.selfName);
    if (self) botNames.add(self);
    const room = conferenceRoom();
    let present = 0;
    remote.forEach((p: JitsiParticipantLike | undefined, id: unknown) => {
      if (!p || p.fakeParticipant || p.isVirtualScreenshareParticipant || p.hidden) return;
      if (carriesBotMarker(room, p.id ?? id)) return;
      if (botNames.has(normalizeName(p.name))) return;
      present++;
    });
    return present;
  } catch {
    return null;
  }
}
