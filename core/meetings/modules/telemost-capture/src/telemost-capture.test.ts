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

  delete (globalThis as any).document;
  if (failed) { console.log(`\n❌ telemost-capture: ${failed} check(s) FAILED`); process.exit(1); }
  console.log("\n✅ telemost-capture: all green");
}

main().catch((e) => { console.error(e); process.exit(1); });
