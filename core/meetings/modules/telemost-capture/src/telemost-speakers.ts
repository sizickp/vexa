/**
 * Yandex Telemost speaking-participant attribution — THE shared implementation.
 *
 * Pure browser code (no Node, no Playwright; its one import is this package's
 * signal tap — the bot bundles the package into its page bundle). Consumed by the bot (bundled into
 * browser-utils.global.js; the capture bridge instantiates it post-admission).
 *
 * Signal, layered engine-first:
 *  1. The media engine's own slot VAD (`telemost-signal.ts`: `slotsConfig` over the call's
 *     signalling socket, names from its roster) — holds in every layout, a shared screen
 *     included. Used as soon as the tap has seen one slot configuration.
 *  2. DOM fallback for a frame without the tap: the participant tiles — the speaking tile's
 *     root gains a `rootStroke_*` class
 * (CSS-module hashed, so matched by prefix) and its `…TextName…` span names the
 * speaker; the bot's own tile is marked `selfView…`. The featured speaker can be
 * drawn twice, so names are de-duplicated. Several people can speak at once, so
 * the watcher tracks a SET of speakers and emits start/stop per participant.
 *
 * Speaking start/stop events feed the ChunkedTranscriber's name binder as
 * 'dom-active' hints (same protocol as the Jitsi/Zoom watchers) — INCLUDING the
 * ~2s heartbeat the binder's turn model requires: an open hint turn decays after
 * a short grace, so a speaker who KEEPS talking must be re-asserted.
 */

import { telemostSignalState } from "./telemost-signal.js";

export interface TelemostSpeakersOptions {
  /** Bot display name — the bot's own tile is never reported. */
  selfName?: string;
  /** Speaking state change: isEnd=false → started speaking, isEnd=true → stopped.
   *  tMs = wall-clock at emit. */
  onSpeaking: (name: string, id: string, isEnd: boolean, tMs: number) => void;
  log?: (msg: string) => void;
  /** Poll interval (ms). Default 300 — speaking markers toggle at syllable scale. */
  pollMs?: number;
  /** Re-assert interval for a STILL-speaking participant (ms). Default 2000 — the
   *  binder's heartbeat contract (must beat its open-turn grace). */
  heartbeatMs?: number;
  /** A speaker whose marker drops is held this long before `stop` (ms). Default 800 —
   *  the marker flickers between words; a stop per pause would shred one turn. */
  releaseMs?: number;
}

export interface TelemostSpeakers {
  destroy(): void;
  getState(): { mode: "signal" | "dom" | null; speaking: string[]; changes: number };
}

// A participant tile (grid / filmstrip / speaker view).
export const telemostTileSelectors: string[] = [
  '[class*="rootStroke_"]',
  '[data-testid*="participant" i]',
  '[class*="participant" i]',
  '[class*="ParticipantTile" i]',
  '[class*="tile" i]',
];

// A speaking marker on (or inside) a tile.
export const telemostSpeakingSelectors: string[] = [
  '[class*="rootStroke_"]',
  '[data-speaking="true"]',
  '[class*="speaking" i]',
  '[class*="talking" i]',
  '[class*="activeSpeaker" i]',
  '[class*="active-speaker" i]',
  '[aria-label*="говорит" i]',
  '[aria-label*="speaking" i]',
];

// The display-name node inside a tile.
export const telemostTileNameSelectors: string[] = [
  'span[class*="TextName"]',
  '[data-testid*="name" i]',
  '[class*="displayName" i]',
  '[class*="display-name" i]',
  '[class*="participantName" i]',
  '[class*="name" i]',
];

// The bot's own (self-view) tile — never reported.
export const telemostSelfTileSelectors: string[] = [
  '[class*="selfView"]',
];

const TILE_SELECTOR = telemostTileSelectors.join(", ");
const SELF_SELECTOR = telemostSelfTileSelectors.join(", ");

function nameIn(node: Element): string | null {
  for (const sel of telemostTileNameSelectors) {
    const text = node.querySelector(sel)?.textContent?.trim();
    if (text) return text;
  }
  return null;
}

/** The display name for a speaking marker: looked up inside the marked element first (the
 *  marker sits on the tile root), then in its nearest tile — never in a wider container, whose
 *  first name node would belong to somebody else. */
function nameOfTile(el: Element): string | null {
  const own = nameIn(el);
  if (own) return own;
  const tile = el.parentElement?.closest(TILE_SELECTOR);
  const fromTile = tile ? nameIn(tile) : null;
  if (fromTile) return fromTile;
  const label = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
  return label || null;
}

/** True when `el` is (inside) the bot's own self-view tile. */
function isSelfTile(el: Element): boolean {
  try { return !!el.closest(SELF_SELECTOR); } catch { return false; }
}

/** Everyone speaking right now, and which source said so.
 *
 *  The engine signal is trusted once it has PROVEN itself — named at least one speaker through the
 *  roster. Until then, and on any tick where it reports a speaker the roster cannot name, the tiles
 *  answer: a half-read signal must never silence the source that works. Once proven, a signal that
 *  reports nobody speaking is silence (the tiles' outline is not a speaker in every layout). */
function speakingNow(proven: { value: boolean }): { names: Set<string>; mode: "signal" | "dom" } {
  const sig = telemostSignalState();
  if (sig && sig.slotConfigs > 0) {
    const names = new Set<string>();
    let unnamed = 0;
    for (const id of sig.speaking) {
      const name = sig.names.get(id);
      if (name) names.add(name); else unnamed++;
    }
    if (names.size > 0) proven.value = true;
    if (proven.value && unnamed === 0) return { names, mode: "signal" };
  }
  return { names: speakingFromDom(), mode: "dom" };
}

/** Everyone whose tile currently carries a speaking marker. */
function speakingFromDom(): Set<string> {
  const names = new Set<string>();
  try {
    for (const sel of telemostSpeakingSelectors) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        if (isSelfTile(el)) continue;
        const name = nameOfTile(el);
        if (name) names.add(name);
      }
    }
  } catch { /* a transient DOM state is not a failure — the next poll re-reads */ }
  return names;
}

export function createTelemostSpeakers(opts: TelemostSpeakersOptions): TelemostSpeakers {
  const log = opts.log || (() => {});
  const self = (opts.selfName || "").trim().toLowerCase();
  const heartbeatMs = opts.heartbeatMs ?? 2000;
  const releaseMs = opts.releaseMs ?? 800;

  // name → { lastSeen, lastAssert }
  const active = new Map<string, { lastSeen: number; lastAssert: number }>();
  let changes = 0;
  let mode: "signal" | "dom" | null = null;
  const proven = { value: false };
  let lastReport = 0;
  const REPORT_MS = 30_000;

  const emit = (name: string, isEnd: boolean) => {
    try { opts.onSpeaking(name, `dom:${name}`, isEnd, Date.now()); } catch { /* never break capture */ }
  };

  const tick = () => {
    const now = Date.now();
    const read = speakingNow(proven);
    // A periodic account of the engine signal — the one line that tells, from a bot log alone, why
    // a meeting was or was not named.
    if (now - lastReport >= REPORT_MS) {
      lastReport = now;
      const sig = telemostSignalState();
      log(sig
        ? `signal: messages=${sig.messages} slotConfigs=${sig.slotConfigs} vadSlots=${sig.vadSlots} roster=${sig.names.size} unnamed=${sig.unnamed.size} proven=${proven.value} mode=${read.mode}`
        : `signal: no tap in this frame · mode=${read.mode}`);
    }
    if (read.mode !== mode) { mode = read.mode; log(`speaker source → ${mode}`); }
    const seen = read.names;
    // The bot's own speech (TTS) must not name segments after the bot.
    if (self) for (const n of Array.from(seen)) if (n.toLowerCase() === self) seen.delete(n);

    for (const name of seen) {
      const cur = active.get(name);
      if (!cur) {
        active.set(name, { lastSeen: now, lastAssert: now });
        emit(name, false);
        changes++;
        log(`speaking → ${name}`);
      } else {
        cur.lastSeen = now;
        // HEARTBEAT: re-assert a still-speaking participant so the binder's turn stays open.
        if (now - cur.lastAssert >= heartbeatMs) {
          emit(name, false);
          cur.lastAssert = now;
        }
      }
    }
    for (const [name, cur] of Array.from(active)) {
      if (!seen.has(name) && now - cur.lastSeen >= releaseMs) {
        active.delete(name);
        emit(name, true);
        changes++;
      }
    }
  };

  const poll = setInterval(tick, opts.pollMs ?? 300);
  tick();

  return {
    destroy() {
      clearInterval(poll);
      for (const name of active.keys()) emit(name, true);
      active.clear();
    },
    getState() {
      return { mode, speaking: Array.from(active.keys()), changes };
    },
  };
}
