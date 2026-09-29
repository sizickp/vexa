/**
 * jitsi-capture L2 — the PURE state logic, no browser. Drives the real
 * createJitsiSpeakers / createJitsiChat against a FAKE `APP.store` (the redux
 * primary source), and pins the send path + the exported selector arrays (the
 * DOM-fallback surface). The DOM observers themselves are fallback-only and
 * live-validated. Run: npm test  or  npx tsx src/jitsi-capture.test.ts
 */
import {
  createJitsiSpeakers,
  createJitsiChat,
  sendJitsiChatMessage,
  jitsiDominantTileSelectors,
  jitsiTileNameSelectors,
  jitsiChatContainerSelectors,
  jitsiChatMessageSelectors,
  jitsiChatSenderSelectors,
  jitsiChatTextSelectors,
  jitsiRemoteParticipantCount,
  jitsiMarkSelfAsVexaBot,
} from "./index.js";

let failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond ? "" : "  — " + detail}`);
  if (!cond) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Fake APP.store — the shape createJitsiSpeakers/Chat defensively read ──────
type Participant = { id: string; name: string };
const fakeState: any = {
  "features/base/participants": {
    local: { id: "self1", name: "Vexa" } as Participant,
    remote: new Map<string, Participant>([
      ["p1", { id: "p1", name: "Alice" }],
      ["p2", { id: "p2", name: "Bob" }],
    ]),
    dominantSpeaker: undefined as string | undefined,
  },
  "features/chat": { messages: [] as any[] },
};
(globalThis as any).APP = {
  store: { getState: () => fakeState },
  conference: { _room: { sendTextMessage: (t: string) => sent.push(t) } },
};
const sent: string[] = [];

async function main() {
  // ── speakers: dominant transitions → debut/end hint pairs ────────────────────
  const events: Array<{ name: string; isEnd: boolean }> = [];
  const speakers = createJitsiSpeakers({
    selfName: "Vexa",
    pollMs: 10,
    heartbeatMs: 30,
    onSpeaking: (name, _id, isEnd) => events.push({ name, isEnd }),
  });

  fakeState["features/base/participants"].dominantSpeaker = "p1";
  await sleep(40);
  check("speaker start emitted for Alice", events.some((e) => e.name === "Alice" && !e.isEnd), JSON.stringify(events));

  // A STILL-dominant speaker keeps being re-asserted (the binder's heartbeat contract):
  // an open hint turn decays after a grace, so an unchanged speaker must re-emit.
  const assertsBefore = events.filter((e) => e.name === "Alice" && !e.isEnd).length;
  await sleep(100);
  const assertsAfter = events.filter((e) => e.name === "Alice" && !e.isEnd).length;
  check("still-dominant speaker heartbeats", assertsAfter > assertsBefore, `${assertsBefore} → ${assertsAfter}`);

  fakeState["features/base/participants"].dominantSpeaker = "p2";
  await sleep(40);
  check("Alice ended when Bob took over", events.some((e) => e.name === "Alice" && e.isEnd), JSON.stringify(events));
  check("Bob start emitted", events.some((e) => e.name === "Bob" && !e.isEnd), JSON.stringify(events));

  // The bot's own dominant-speaker state is never reported (and ends the previous).
  events.length = 0;
  fakeState["features/base/participants"].dominantSpeaker = "self1";
  await sleep(40);
  check("self (bot) never reported as a speaker", !events.some((e) => e.name === "Vexa"), JSON.stringify(events));
  check("previous speaker ended on self takeover", events.some((e) => e.name === "Bob" && e.isEnd), JSON.stringify(events));

  check("speakers mode = redux", speakers.getState().mode === "redux", speakers.getState().mode ?? "null");
  speakers.destroy();

  // ── chat: history primes silently; new messages emit once ────────────────────
  fakeState["features/chat"].messages = [
    { id: "m1", displayName: "Alice", message: "hello from before the bot joined", messageType: "remote", timestamp: 1 },
  ];
  const got: Array<{ sender: string; text: string }> = [];
  const chat = createJitsiChat({ pollMs: 10, onMessage: (m) => got.push(m) });
  await sleep(40);
  check("pre-join history is primed, not emitted", got.length === 0, JSON.stringify(got));

  fakeState["features/chat"].messages = [
    ...fakeState["features/chat"].messages,
    { id: "m2", displayName: "Bob", message: "agenda is in the doc", messageType: "remote", timestamp: 2 },
    { id: "m3", displayName: "", message: "anonymous ping", messageType: "remote", timestamp: 3 },
    { id: "m4", displayName: "Eve", message: "boom", messageType: "error", timestamp: 4 },
    { id: "m5", displayName: "Vexa", message: "sent by the bot itself", messageType: "local", timestamp: 5 },
  ];
  await sleep(40);
  check("new message emitted", got.some((m) => m.sender === "Bob" && m.text === "agenda is in the doc"), JSON.stringify(got));
  check("missing displayName → Unknown", got.some((m) => m.sender === "Unknown" && m.text === "anonymous ping"), JSON.stringify(got));
  check("error-type messages filtered", !got.some((m) => m.text === "boom"), JSON.stringify(got));
  check("the bot's own (local) messages never echo back", !got.some((m) => m.text === "sent by the bot itself"), JSON.stringify(got));

  const before = got.length;
  await sleep(30);
  check("no duplicate emissions on re-poll", got.length === before, `${got.length} vs ${before}`);

  // ── store replacement (reconnect / p2p↔JVB move / history cap): the array shrinks to a
  // retained tail — already-delivered messages must NOT re-emit, and new ones still do. ──
  fakeState["features/chat"].messages = [
    { id: "m2", displayName: "Bob", message: "agenda is in the doc", messageType: "remote", timestamp: 2 },
    { id: "m5", displayName: "Vexa", message: "sent by the bot itself", messageType: "local", timestamp: 5 },
  ];
  await sleep(30);
  check("store replacement re-emits nothing", got.length === before, `${got.length} vs ${before}`);
  fakeState["features/chat"].messages = [
    ...fakeState["features/chat"].messages,
    { id: "m6", displayName: "Carol", message: "fresh after the resync", messageType: "remote", timestamp: 6 },
  ];
  await sleep(30);
  check(
    "post-resync message emits once",
    got.filter((m) => m.text === "fresh after the resync").length === 1,
    JSON.stringify(got),
  );

  check("chat mode = redux", chat.getState().mode === "redux", chat.getState().mode ?? "null");
  chat.destroy();

  // ── send path ────────────────────────────────────────────────────────────────
  check("sendJitsiChatMessage uses the conference API", sendJitsiChatMessage("hi room") === true && sent[0] === "hi room", JSON.stringify(sent));
  delete (globalThis as any).APP.conference;
  check("send returns false when the API is absent", sendJitsiChatMessage("nope") === false);

  // ── DOM-fallback selector surface is exported + non-empty ────────────────────
  for (const [name, arr] of Object.entries({
    jitsiDominantTileSelectors, jitsiTileNameSelectors,
    jitsiChatContainerSelectors, jitsiChatMessageSelectors,
    jitsiChatSenderSelectors, jitsiChatTextSelectors,
  })) {
    check(`${name} exported non-empty`, Array.isArray(arr) && arr.length > 0);
  }

  // ── presence: the app's participant list is the oracle (its tracks outlive the people) ──
  {
    const store: any = (globalThis as any).APP.store;
    const participants = () => store.getState()["features/base/participants"];
    participants().remote = new Map<string, any>([
      ["p1", { id: "p1", name: "Alice" }],
      ["p2", { id: "p2", name: "Bob" }],
    ]);
    check("presence counts the remote participants", jitsiRemoteParticipantCount() === 2, String(jitsiRemoteParticipantCount()));
    participants().remote.set("sv", { id: "sv", name: "YouTube", fakeParticipant: "SharedVideo" });
    participants().remote.set("p1-ss", { id: "p1-ss", name: "Alice's screen", isVirtualScreenshareParticipant: true });
    participants().remote.set("rec", { id: "rec", name: "recorder", hidden: true });
    check("tiles that are not people (fake / virtual screenshare / hidden) do not count", jitsiRemoteParticipantCount() === 2, String(jitsiRemoteParticipantCount()));
    // sibling Vexa bots are not people: by name for bots that predate the marker, by the marker otherwise
    participants().remote.set("b-default", { id: "b-default", name: "Vexa" });
    participants().remote.set("b-self", { id: "b-self", name: " vexa  BOT " });
    check(
      "participants named like a Vexa bot (a product default, the caller's own name; case/space-insensitive) do not count",
      jitsiRemoteParticipantCount({ selfName: "Vexa bot" }) === 2,
      String(jitsiRemoteParticipantCount({ selfName: "Vexa bot" })),
    );
    participants().remote.set("b-custom", { id: "b-custom", name: "Scribe" });
    check("a bot under a custom name counts until it is the caller's own", jitsiRemoteParticipantCount({ selfName: "Scribe" }) === 2 && jitsiRemoteParticipantCount() === 3, String(jitsiRemoteParticipantCount()));
    participants().remote.delete("b-custom");
    const marked: Array<[string, unknown]> = [];
    (globalThis as any).APP.conference = {
      _room: {
        setLocalParticipantProperty: (n: string, v: unknown) => marked.push([n, v]),
        getParticipantById: (id: string) => ({ getProperty: (n: string) => (id === "zed" && n === "vexa_bot" ? "1" : undefined) }),
      },
    };
    participants().remote.set("zed", { id: "zed", name: "Zed" });
    check("a participant carrying the vexa_bot presence marker does not count, whatever its name", jitsiRemoteParticipantCount({ selfName: "Vexa bot" }) === 2, String(jitsiRemoteParticipantCount({ selfName: "Vexa bot" })));
    check(
      "jitsiMarkSelfAsVexaBot announces the bot through the conference API",
      jitsiMarkSelfAsVexaBot() === true && marked.length === 1 && marked[0][0] === "vexa_bot" && marked[0][1] === "1",
      JSON.stringify(marked),
    );
    participants().remote = new Map<string, any>([
      ["b-default", { id: "b-default", name: "Vexa" }],
      ["zed", { id: "zed", name: "Zed" }],
    ]);
    check("a room holding only Vexa bots is 0 — bots do not hold each other", jitsiRemoteParticipantCount({ selfName: "Vexa bot" }) === 0, String(jitsiRemoteParticipantCount({ selfName: "Vexa bot" })));
    delete (globalThis as any).APP.conference;
    check("marking without the conference API returns false, never throws", jitsiMarkSelfAsVexaBot() === false);
    participants().remote = new Map();
    check("an empty room is 0 — not null, not the stale track count", jitsiRemoteParticipantCount() === 0, String(jitsiRemoteParticipantCount()));
    const saved = (globalThis as any).APP;
    (globalThis as any).APP = undefined;
    check("no APP global → null (the caller keeps its track count)", jitsiRemoteParticipantCount() === null, String(jitsiRemoteParticipantCount()));
    (globalThis as any).APP = { store: { getState: () => ({ "features/base/participants": { remote: {} } }) } };
    check("a store whose remote is not a Map → null, never a guess", jitsiRemoteParticipantCount() === null, String(jitsiRemoteParticipantCount()));
    (globalThis as any).APP = saved;
  }

  if (failed) { console.error(`\n❌ jitsi-capture (L2): ${failed} check(s) FAILED.`); process.exit(1); }
  console.log("\n✅ jitsi-capture (L2): speakers + chat + presence drive the fake APP.store correctly; send path + selector surface pinned.");
}

void main();
