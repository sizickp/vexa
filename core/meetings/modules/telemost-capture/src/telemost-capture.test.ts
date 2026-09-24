/**
 * telemost-capture L2 — the PURE watcher logic, no browser. Drives the real
 * createTelemostSpeakers against a FAKE document whose participant tiles carry
 * (or drop) a speaking marker, and pins the exported selector arrays (the DOM
 * surface, live-validated in a real Telemost call).
 * Run: npm test  or  npx tsx src/telemost-capture.test.ts
 */
import {
  createTelemostSpeakers,
  telemostTileSelectors,
  telemostSpeakingSelectors,
  telemostTileNameSelectors,
  installTelemostSignalTap,
  applyTelemostSignal,
  telemostSignalState,
  emptyTelemostSignalState,
} from "./index.js";

let failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond ? "" : "  — " + detail}`);
  if (!cond) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Fake DOM: tiles with a name node; a speaking tile answers the first speaking selector ──
const SPEAKING_SEL = telemostSpeakingSelectors[0];
const NAME_SEL = telemostTileNameSelectors[0];
type Tile = { name: string; speaking: boolean; self?: boolean };
const tiles: Tile[] = [
  { name: "Alice", speaking: false },
  { name: "Bob", speaking: false },
  { name: "Vexa", speaking: false },
  { name: "Мой экран", speaking: false, self: true },
];
function tileEl(t: Tile): any {
  const nameNode = { textContent: t.name };
  const el: any = {
    parentElement: null,
    // Only the self-view marker is answered by closest(): the speaking marker sits on the tile root.
    closest: (sel: string) => (sel.includes("selfView") ? (t.self ? el : null) : el),
    querySelector: (sel: string) => (sel === NAME_SEL ? nameNode : null),
    getAttribute: () => null,
  };
  return el;
}
(globalThis as any).document = {
  querySelectorAll: (sel: string) => (sel === SPEAKING_SEL ? tiles.filter((t) => t.speaking).map(tileEl) : []),
};

type Ev = { name: string; isEnd: boolean };
const events: Ev[] = [];
const count = (name: string, isEnd: boolean) => events.filter((e) => e.name === name && e.isEnd === isEnd).length;

async function main() {
  console.log("createTelemostSpeakers");
  const w = createTelemostSpeakers({
    selfName: "Vexa",
    onSpeaking: (name, _id, isEnd) => events.push({ name, isEnd }),
    pollMs: 20, heartbeatMs: 100, releaseMs: 60,
  });

  tiles[0].speaking = true;
  await sleep(50);
  check("start emitted when a tile gains the speaking marker", count("Alice", false) === 1, JSON.stringify(events));

  await sleep(150);
  check("heartbeat re-asserts a still-speaking participant", count("Alice", false) >= 2, JSON.stringify(events));

  tiles[0].speaking = false;
  await sleep(30);
  tiles[0].speaking = true;
  await sleep(30);
  check("a marker flicker shorter than releaseMs is not a stop", count("Alice", true) === 0, JSON.stringify(events));

  tiles[1].speaking = true;
  await sleep(50);
  check("two people can speak at once", w.getState().speaking.length === 2, JSON.stringify(w.getState()));

  tiles[2].speaking = true;
  await sleep(50);
  check("the bot's own tile is never reported", count("Vexa", false) === 0, JSON.stringify(events));

  tiles[3].speaking = true;
  await sleep(50);
  check("the self-view tile is skipped whatever it is named", count("Мой экран", false) === 0, JSON.stringify(events));

  tiles[0].speaking = false;
  await sleep(120);
  check("stop emitted once the marker stays off past releaseMs", count("Alice", true) === 1, JSON.stringify(events));

  w.destroy();
  check("destroy closes every open speaker", count("Bob", true) === 1, JSON.stringify(events));

  console.log("selector arrays");
  check("tile / speaking / name selector arrays are non-empty",
    telemostTileSelectors.length > 0 && telemostSpeakingSelectors.length > 0 && telemostTileNameSelectors.length > 0);

  // ── the engine signal: roster + slot VAD over the media-engine socket (shapes as observed live) ──
  console.log("telemost signal (slotsConfig VAD)");
  const SERGEY = "76796d36-0a51-4927-a0d5-c527134a5960";
  const IGOR = "79b062e3-f697-449d-aee7-e5062dd00000";
  const roster = JSON.stringify({ uid: "u1", updateDescription: { description: [
    { id: SERGEY, meta: { name: "Сергей", role: "SPEAKER" }, sendAudio: true },
    { id: IGOR, meta: { name: "Игорь Охрименко", role: "SPEAKER" }, sendAudio: true },
  ] } });
  const slots = (speaking: string[]) => JSON.stringify({ uid: "u2", slotsConfig: { key: 1, audioSlots: [], slots: [
    { participantScreenSharingByMid: { participantId: SERGEY, mid: "video_AC" }, vad: speaking.includes(SERGEY), pinned: true, label: "screen_video_track" },
    { selfView: {}, vad: true, pinned: false, label: "" },
    { participantVideoByMid: { participantId: SERGEY, mid: "video_AA" }, vad: speaking.includes(SERGEY), label: "FHD Camera" },
    { participantVideoByMid: { participantId: IGOR, mid: "video_AB" }, vad: speaking.includes(IGOR), label: "" },
  ] } });
  const st = emptyTelemostSignalState();
  applyTelemostSignal(st, roster);
  applyTelemostSignal(st, slots([IGOR]));
  check("roster names come from the description", st.names.get(IGOR) === "Игорь Охрименко");
  check("a speaking participant's slot VAD is read; screen-share and self-view slots are not speakers",
    st.speaking.size === 1 && st.speaking.has(IGOR), JSON.stringify([...st.speaking]));
  applyTelemostSignal(st, JSON.stringify({ removeDescription: { description: [{ id: IGOR }] } }));
  check("a removed participant drops out of the roster and the speakers", !st.names.has(IGOR) && !st.speaking.has(IGOR));
  applyTelemostSignal(st, "not json");
  check("a non-JSON frame is ignored", st.messages === 3);

  const hello = emptyTelemostSignalState();
  applyTelemostSignal(hello, JSON.stringify({ serverHello: { conference: { participants: [
    { id: IGOR, meta: { name: "Игорь Охрименко" } } ] } } }));
  applyTelemostSignal(hello, JSON.stringify({ slotsConfig: { slots: [
    { participantAudioOnlyByMid: { participantId: IGOR, mid: "audio_1" }, vad: true } ] } }));
  check("a roster nested in any message is found by its shape", hello.names.get(IGOR) === "Игорь Охрименко");
  check("a slot names its participant under any …ByMid key", hello.speaking.has(IGOR) && hello.unnamed.size === 0);

  // A signal that reports a speaker the roster cannot name must not silence the tiles (two windows of
  // one account, a roster not seen yet): the tiles answer until the signal has named somebody.
  (globalThis as any).__vexaTelemostSignal = emptyTelemostSignalState();
  applyTelemostSignal((globalThis as any).__vexaTelemostSignal, JSON.stringify({ slotsConfig: { slots: [
    { participantVideoByMid: { participantId: "no-roster-id", mid: "v" }, vad: true } ] } }));
  tiles[0].speaking = true;
  const ev3: Ev[] = [];
  const w3 = createTelemostSpeakers({ selfName: "Vexa", onSpeaking: (name, _id, isEnd) => ev3.push({ name, isEnd }), pollMs: 20 });
  await sleep(50);
  check("an unproven signal (speaker without a roster name) leaves the tiles in charge",
    w3.getState().mode === "dom" && ev3.some((e) => e.name === "Alice" && !e.isEnd), JSON.stringify({ state: w3.getState(), ev3 }));
  w3.destroy();
  tiles[0].speaking = false;
  delete (globalThis as any).__vexaTelemostSignal;

  // The tap wraps WebSocket and listens to the engine socket only.
  class FakeWS {
    static OPEN = 1;
    listeners: ((ev: { data: unknown }) => void)[] = [];
    constructor(public url: string) {}
    addEventListener(_t: string, fn: (ev: { data: unknown }) => void) { this.listeners.push(fn); }
    emit(data: string) { for (const fn of this.listeners) fn({ data }); }
  }
  (globalThis as any).WebSocket = FakeWS;
  check("the tap installs once", installTelemostSignalTap() === true && installTelemostSignalTap() === false);
  const other = new (globalThis as any).WebSocket("wss://push.yandex.ru/v2/subscribe/websocket");
  const engine = new (globalThis as any).WebSocket("wss://goloom.strm.yandex.net/join");
  check("the wrapped socket is still a socket of the original class", engine instanceof FakeWS && (globalThis as any).WebSocket.OPEN === 1);
  other.emit(roster);
  check("a non-engine socket is not read", telemostSignalState()!.messages === 0);
  engine.emit(roster);
  engine.emit(slots([SERGEY]));

  // Screen shared: the tiles carry no speaking marker, the engine still says who speaks.
  for (const t of tiles) t.speaking = false;
  const ev2: Ev[] = [];
  const w2 = createTelemostSpeakers({ selfName: "Vexa", onSpeaking: (name, _id, isEnd) => ev2.push({ name, isEnd }), pollMs: 20, heartbeatMs: 1000, releaseMs: 60 });
  await sleep(50);
  check("with the tap live the watcher names the engine's speaker, not the (empty) tiles",
    w2.getState().mode === "signal" && ev2.some((e) => e.name === "Сергей" && !e.isEnd), JSON.stringify({ state: w2.getState(), ev2 }));
  engine.emit(slots([IGOR]));
  await sleep(120);
  check("a speaker change in the engine is a stop for one and a start for the other",
    ev2.some((e) => e.name === "Сергей" && e.isEnd) && ev2.some((e) => e.name === "Игорь Охрименко" && !e.isEnd), JSON.stringify(ev2));
  w2.destroy();
  delete (globalThis as any).__vexaTelemostSignal;
  delete (globalThis as any).WebSocket;

  delete (globalThis as any).document;
  if (failed) { console.log(`\n❌ telemost-capture: ${failed} check(s) FAILED`); process.exit(1); }
  console.log("\n✅ telemost-capture: all green");
}

main().catch((e) => { console.error(e); process.exit(1); });
