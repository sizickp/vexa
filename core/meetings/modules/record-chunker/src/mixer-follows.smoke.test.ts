/**
 * mixer-follows.smoke — the page mix keeps following media elements after start (no browser).
 *
 * A meeting client re-creates the media element (or swaps its srcObject) whenever a remote track
 * is re-negotiated — unmute after a mute, a rejoin, an ICE restart. A mix built once at start
 * recorded digital silence for everyone whose track was re-created later (Jitsi daily, 2026-09-25:
 * three of five voices missing from the master for 24 of 55 minutes). This test stubs the DOM
 * and Web Audio globals the tap touches and drives the REAL createRecordingTap to prove:
 *   1. the elements present at start are connected once;
 *   2. an element that APPEARS later (DOM mutation) is connected;
 *   3. an element whose srcObject is SWAPPED later (no mutation, the poll) gets its new track
 *      connected — and the tracks already in the mix are never connected twice;
 *   4. stop() disconnects the observer, clears the poll and closes the AudioContext.
 *
 * No assertion lib — same shape as chunker.smoke.test.ts (tsx + exit code).
 */

// ── minimal browser-global stubs (installed before importing the brick) ─────────
(globalThis as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
(globalThis as any).window = { logBot: (_m: string) => {} };

class FakeTrack {
  constructor(readonly id: string) {}
  addEventListener(_e: string, _fn: () => void) {}
}
class FakeMediaStream {
  constructor(private tracks: FakeTrack[]) {}
  getAudioTracks() { return this.tracks; }
}
(globalThis as any).MediaStream = FakeMediaStream;

const connected: string[] = [];          // track ids handed to createMediaStreamSource, in order
let contextClosed = 0;
class FakeAudioContext {
  createMediaStreamDestination() { return { stream: new FakeMediaStream([new FakeTrack('dest')]) }; }
  createMediaStreamSource(s: FakeMediaStream) {
    for (const t of s.getAudioTracks()) connected.push(t.id);
    return { connect() {}, disconnect() {} };
  }
  async close() { contextClosed++; }
}
(globalThis as any).AudioContext = FakeAudioContext;

let observerCb: (() => void) | null = null;
let observerDisconnected = 0;
class FakeMutationObserver {
  constructor(cb: () => void) { observerCb = cb; }
  observe() {}
  disconnect() { observerDisconnected++; observerCb = null; }
}
(globalThis as any).MutationObserver = FakeMutationObserver;

const elements: any[] = [];
(globalThis as any).document = {
  documentElement: {},
  querySelectorAll: (_sel: string) => elements.slice(),
};

class FakeMediaRecorder {
  static isTypeSupported(mime: string) { return mime === 'audio/webm;codecs=opus'; }
  onstart: (() => void) | null = null;
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  constructor(readonly stream: any, opts?: { mimeType?: string }) { this.mimeType = opts?.mimeType ?? ''; }
  start() { this.state = 'recording'; this.onstart?.(); }
  stop() { this.state = 'inactive'; this.onstop?.(); }
}
(globalThis as any).MediaRecorder = FakeMediaRecorder;
(globalThis as any).window.MediaRecorder = FakeMediaRecorder;

import { createRecordingTap } from './index';

const el = (trackId: string, extra: Record<string, unknown> = {}) =>
  ({ paused: false, srcObject: new FakeMediaStream([new FakeTrack(trackId)]), ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const fails: string[] = [];

  // 1) two elements alive at start
  elements.push(el('a1'), el('b1'));
  const tap = createRecordingTap({ timesliceMs: 1000, followIntervalMs: 20, onChunk: async () => true });
  await tap.start();
  if (connected.join(',') !== 'a1,b1') fails.push(`at start connected=${connected} (want a1,b1)`);
  if (!observerCb) fails.push('no MutationObserver installed after start');

  // 2) an element APPEARS (rejoin / new participant) → the observer pass connects it
  elements.push(el('c1'));
  observerCb?.();
  if (connected.join(',') !== 'a1,b1,c1') fails.push(`after DOM add connected=${connected} (want a1,b1,c1)`);

  // 3) a srcObject SWAP under an existing element (unmute re-negotiation) → the poll connects the
  //    new track; nothing already in the mix is connected again
  elements[0].srcObject = new FakeMediaStream([new FakeTrack('a2')]);
  await sleep(60);
  if (connected.join(',') !== 'a1,b1,c1,a2') fails.push(`after swap connected=${connected} (want a1,b1,c1,a2)`);
  // idle polls must stay idempotent
  await sleep(60);
  if (connected.length !== 4) fails.push(`idle polls re-connected: ${connected}`);

  // a captureStream()-only element is keyed by element: connected once, never again per poll
  let captureCalls = 0;
  elements.push({ paused: false, srcObject: null, captureStream: () => { captureCalls++; return new FakeMediaStream([new FakeTrack(`cap${captureCalls}`)]); } });
  await sleep(60);
  const capConnected = connected.filter((id) => id.startsWith('cap'));
  if (capConnected.length !== 1) fails.push(`captureStream element connected ${capConnected.length}× (want 1): ${connected}`);

  // 4) stop() tears the following down
  await tap.stop();
  const before = connected.length;
  elements.push(el('d1'));
  await sleep(60);
  if (connected.length !== before) fails.push('poll still running after stop()');
  if (observerDisconnected !== 1) fails.push(`observer disconnected ${observerDisconnected}× (want 1)`);
  if (contextClosed !== 1) fails.push(`AudioContext closed ${contextClosed}× (want 1)`);

  console.log(`connected in order: ${connected.join(',')}`);
  if (fails.length) { console.log('❌ FAIL — ' + fails.join('; ')); process.exit(1); }
  console.log('✅ PASS — start connects the live elements once; a later element (observer) and a swapped srcObject (poll) join the mix; no track is connected twice; stop() tears the following down');
  process.exit(0);
}

main().catch((e) => { console.log('❌ FAIL — ' + (e?.stack || e)); process.exit(1); });
