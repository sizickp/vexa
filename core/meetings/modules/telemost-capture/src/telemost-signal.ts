/**
 * Yandex Telemost media-engine signal tap — who is speaking, from the call's own signalling.
 *
 * Pure browser code (no Node, no Playwright, no cross-file imports — the bot bundles this file
 * standalone). Installed at DOCUMENT START in every frame (the bot's init script, beside the WebRTC
 * audio hook): it wraps `WebSocket` so the call frame's connection to the media engine (goloom) is
 * observed from its first message. Observing only — messages are never altered or delayed.
 *
 * The engine tells every participant, over that socket:
 *   - `upsertDescription` / `updateDescription` → `description[]` of `{ id, meta: { name } }` —
 *     the participant roster, id → display name;
 *   - `removeDescription` → participants that left;
 *   - `slotsConfig` → `slots[]` (and `audioSlots[]`), each naming a participant
 *     (`participantVideoByMid` / `participantAudioByMid` → `participantId`) with a server-side
 *     `vad` flag — true while that participant is speaking.
 * The slot flag is the engine's own voice-activity verdict, so it holds in every layout — a shared
 * screen that shrinks or hides the participant tiles (where the DOM speaking outline lives) changes
 * nothing here. Screen-share and self-view slots carry no speaker and are skipped.
 */

export interface TelemostSignalState {
  /** participantId → display name. */
  names: Map<string, string>;
  /** participantIds whose slot currently carries `vad: true`. */
  speaking: Set<string>;
  /** Engine messages observed, and how many of them were slot configurations. */
  messages: number;
  slotConfigs: number;
}

const STATE_KEY = "__vexaTelemostSignal";

/** The tap's state, or null when no tap is installed in this frame. */
export function telemostSignalState(): TelemostSignalState | null {
  return ((globalThis as any)[STATE_KEY] as TelemostSignalState | undefined) ?? null;
}

/** Descriptions under any of the roster verbs, as `{ id, name }`. */
function descriptionsOf(m: any): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const verb of ["upsertDescription", "updateDescription"]) {
    const list = m?.[verb]?.description;
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      const id = typeof d?.id === "string" ? d.id : "";
      const name = String(d?.meta?.name ?? "").trim();
      if (id && name) out.push({ id, name });
    }
  }
  return out;
}

/** Participant ids a `removeDescription` names, whichever shape it carries them in. */
function removedIds(m: any): string[] {
  const r = m?.removeDescription;
  if (!r) return [];
  const ids: string[] = [];
  for (const key of ["description", "participantIds", "ids"]) {
    const list = r[key];
    if (!Array.isArray(list)) continue;
    for (const x of list) {
      const id = typeof x === "string" ? x : typeof x?.id === "string" ? x.id : "";
      if (id) ids.push(id);
    }
  }
  return ids;
}

/** The participant a slot shows, or "" for a slot with no speaker (screen share, self view). */
function slotParticipant(slot: any): string {
  const ref = slot?.participantVideoByMid ?? slot?.participantAudioByMid ?? slot?.participantByMid;
  return typeof ref?.participantId === "string" ? ref.participantId : "";
}

/** Apply one engine message to the state. Exported for the unit test; the tap calls it. */
export function applyTelemostSignal(state: TelemostSignalState, raw: unknown): void {
  if (typeof raw !== "string") return;
  let m: any;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== "object") return;
  state.messages++;
  for (const d of descriptionsOf(m)) state.names.set(d.id, d.name);
  for (const id of removedIds(m)) { state.names.delete(id); state.speaking.delete(id); }
  const cfg = m.slotsConfig;
  if (cfg && typeof cfg === "object") {
    state.slotConfigs++;
    const speaking = new Set<string>();
    for (const list of [cfg.slots, cfg.audioSlots]) {
      if (!Array.isArray(list)) continue;
      for (const slot of list) {
        const id = slotParticipant(slot);
        if (id && slot?.vad === true) speaking.add(id);
      }
    }
    state.speaking = speaking;
  }
}

/**
 * Wrap `WebSocket` in this frame so the media engine's socket is observed. Idempotent; returns
 * whether it installed. Only sockets whose URL names the engine (`goloom`) are listened to.
 */
export function installTelemostSignalTap(): boolean {
  const w = globalThis as any;
  if (w[STATE_KEY] || typeof w.WebSocket !== "function") return false;
  const state: TelemostSignalState = { names: new Map(), speaking: new Set(), messages: 0, slotConfigs: 0 };
  w[STATE_KEY] = state;
  const Orig = w.WebSocket;
  function Tapped(this: unknown, url: string | URL, protocols?: string | string[]) {
    const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
    try {
      if (/goloom/i.test(String(url))) {
        ws.addEventListener("message", (ev: { data: unknown }) => {
          try { applyTelemostSignal(state, ev.data); } catch { /* never break the call */ }
        });
      }
    } catch { /* never break the call */ }
    return ws;
  }
  Tapped.prototype = Orig.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) (Tapped as any)[k] = Orig[k];
  w.WebSocket = Tapped;
  return true;
}
