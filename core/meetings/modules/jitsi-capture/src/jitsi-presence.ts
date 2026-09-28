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
 */

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

/** Remote participants present right now, or `null` when the app's store is not reachable (a build
 *  that strips the `APP` global) — the caller then keeps its track count. Tiles that are not people
 *  are left out: fake participants, virtual screenshare tiles, hidden members. */
export function jitsiRemoteParticipantCount(): number | null {
  try {
    const app = (globalThis as any).APP;
    const participants = app?.store?.getState?.()?.["features/base/participants"];
    const remote = participants?.remote;
    if (!remote || typeof remote.forEach !== "function") return null;
    let present = 0;
    remote.forEach((p: JitsiParticipantLike | undefined) => {
      if (!p || p.fakeParticipant || p.isVirtualScreenshareParticipant || p.hidden) return;
      present++;
    });
    return present;
  } catch {
    return null;
  }
}
