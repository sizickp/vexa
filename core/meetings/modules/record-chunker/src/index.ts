/**
 * @vexa/record-chunker — the shared browser MediaRecorder driver.
 *
 * Runs in browser context. Wraps a MediaRecorder over a combined audio
 * MediaStream, encodes each timeslice to base64, and hands it to an injected
 * `onChunk` callback (the recording.v1 chunk shape). On stop it emits one final
 * chunk with `isFinal: true`. NO master assembly here — the master is built
 * server-side (meeting-api `recording_finalizer.py`) from the chunk_seq sequence.
 *
 * Both lane recording taps use this once: `@vexa/gmeet-capture` (gmeet) and
 * `@vexa/mixed-capture-core` (mixed/teams). The combine-the-audio step differs
 * per lane (gmeet builds a combined stream from its media elements; mixed
 * already has one mixed stream) — that lives in each lane; the MediaRecorder
 * loop is identical and lives here.
 *
 * No fallbacks: if `onChunk` throws or returns false we splice the chunk anyway
 * and log (the server-side reconciler re-fetches via the chunk_seq contract);
 * if no supported mimeType exists we log and refuse to start.
 */

/** One recording chunk, ready for upload. Mirrors the recording.v1 wire shape. */
export interface RecordingChunk {
  base64: string;
  chunkSeq: number;
  isFinal: boolean;
  mimeType: string;
}

/** A lane recording tap — what `createGmeetRecordingTap` / `createMixedRecordingTap` return. */
export interface RecordingTap {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Options a host passes to a lane recording tap. */
export interface RecordingTapOptions {
  /** MediaRecorder timeslice in ms (default 15000 — matches the WAV chunk size). */
  timesliceMs?: number;
  /** Receives each chunk. Return false / throw → the chunk is spliced anyway (reconciler re-fetches). */
  onChunk: (chunk: RecordingChunk) => Promise<boolean> | boolean;
  /** Fired ONCE on MediaRecorder.onstart — t=0 of the master (segment↔audio alignment). */
  onStarted?: () => void;
}

export interface MediaRecorderChunkerOptions extends RecordingTapOptions {
  /** Combined audio stream to record (lane-built). */
  stream: MediaStream;
}

const BUFFER_CAP = 10;

/** The 4-byte EBML magic every valid webm/Matroska stream starts with (`1a 45 df a3`). */
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

/** True when `bytes` begins with the EBML header (i.e. it is a self-describing webm init segment,
 *  not a cluster-only continuation chunk). */
function isWebmHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && EBML_MAGIC.every((b, i) => bytes[i] === b);
}

const blog = (msg: string) => { try { (window as any).logBot?.(msg); } catch { /* */ } };

/**
 * Drives a MediaRecorder over `stream`, emitting base64 chunks via `onChunk`.
 * Lifecycle: start() → chunks per timeslice → stop() resolves AFTER the final
 * chunk callback completes.
 */
export class MediaRecorderChunker implements RecordingTap {
  private opts: MediaRecorderChunkerOptions;
  private recorder: MediaRecorder | null = null;
  private chunkSeq = 0;
  private pending: Blob[] = [];
  private resolveFinalChunk: (() => void) | null = null;
  private mimeType = "audio/webm";
  /**
   * The webm EBML init segment retained from the FIRST self-describing blob (chunk 0:
   * `1a 45 df a3` EBML + Segment + Tracks + first Cluster). Held so it can be re-attached to a
   * later surviving chunk when chunk 0's own delivery fails over the page→Node base64 bridge;
   * without it the assembler would build a headerless (mid-Matroska `43 b6 75 …`) master from the
   * cluster-only survivors, which no player accepts. */
  private initSegment: Uint8Array | null = null;
  /** False until a chunk carrying the EBML header has been ACK'd by `onChunk` (returned truthy). */
  private initSegmentDelivered = false;

  constructor(opts: MediaRecorderChunkerOptions) {
    this.opts = opts;
  }

  /** The underlying MediaRecorder (null until start()). */
  getMediaRecorder(): MediaRecorder | null {
    return this.recorder;
  }

  async start(): Promise<void> {
    if (this.recorder) {
      blog("[record-chunker] start() called twice — ignoring");
      return;
    }

    // Pick the best supported mimeType. No fallback beyond the candidate list.
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
    let chosen = "";
    for (const mime of candidates) {
      try {
        if ((window as any).MediaRecorder?.isTypeSupported?.(mime)) { chosen = mime; break; }
      } catch { /* */ }
    }

    let recorder: MediaRecorder;
    try {
      recorder = chosen
        ? new MediaRecorder(this.opts.stream, { mimeType: chosen })
        : new MediaRecorder(this.opts.stream);
    } catch (err: any) {
      blog(`[record-chunker] Failed to construct MediaRecorder: ${err?.message || err}`);
      return;
    }

    this.recorder = recorder;
    this.mimeType = recorder.mimeType || chosen || "audio/webm";

    // t=0 of the master — listeners align segment timestamps to audio origin.
    recorder.onstart = () => { try { this.opts.onStarted?.(); } catch { /* */ } };

    recorder.ondataavailable = async (event: BlobEvent) => {
      if (!(event.data && event.data.size > 0)) {
        blog("[record-chunker] dataavailable fired with empty data (skipping)");
        return;
      }

      // Defensive buffer + cap — successful callbacks splice; the cap should
      // never trip in normal operation (the reconciler re-fetches if it does).
      this.pending.push(event.data);
      if (this.pending.length > BUFFER_CAP) {
        const dropped = this.pending.shift();
        blog(`[record-chunker] WARN buffer exceeded cap ${BUFFER_CAP}, dropped oldest (${dropped?.size ?? 0} bytes); reconciler will re-fetch`);
      }

      const seq = this.chunkSeq;
      this.chunkSeq = seq + 1;

      try {
        const arrBuffer = await event.data.arrayBuffer();
        let bytes = new Uint8Array(arrBuffer);

        // Retain the EBML init segment from the FIRST self-describing blob. webm/Matroska always
        // starts with `1a 45 df a3`; MediaRecorder puts EBML + Segment + Tracks in chunk 0.
        if (!this.initSegment && isWebmHeader(bytes)) this.initSegment = bytes;

        // If the init segment has NOT yet been delivered (chunk 0's own send failed over the
        // bridge) and THIS chunk is cluster-only, PREPEND the retained header so the master is
        // never assembled headerless. The byte-concat codec keeps this valid: a chunk that is
        // [EBML init][cluster] is exactly what a self-describing chunk 0 looks like.
        if (this.initSegment && !this.initSegmentDelivered && !isWebmHeader(bytes)) {
          const merged = new Uint8Array(this.initSegment.length + bytes.length);
          merged.set(this.initSegment, 0);
          merged.set(bytes, this.initSegment.length);
          bytes = merged;
          blog(`[record-chunker] chunk ${seq} re-attached EBML init segment (${this.initSegment.length}B) — chunk 0 delivery was lost`);
        }

        const carriesHeader = isWebmHeader(bytes);
        // OPTIMISTICALLY mark the init segment delivered the moment a header-bearing chunk is
        // DISPATCHED (not after its await resolves), so a chunk emitted while chunk 0 is still
        // in flight does not redundantly re-attach the header. On a confirmed failure below we
        // clear the flag again so the NEXT surviving chunk carries the retained init segment.
        if (carriesHeader) this.initSegmentDelivered = true;

        let binary = "";
        const encodeChunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += encodeChunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + encodeChunkSize));
        }
        const base64 = btoa(binary);
        blog(`[record-chunker] chunk ${seq} (${bytes.length} bytes)`);
        try {
          const ok = await this.opts.onChunk({ base64, chunkSeq: seq, isFinal: false, mimeType: this.mimeType });
          // A header-bearing chunk that the sink REJECTED is not delivered — clear the flag so the
          // retained init segment is re-attached to the next surviving (cluster-only) chunk.
          if (!ok && carriesHeader) this.initSegmentDelivered = false;
          if (!ok) blog(`[record-chunker] chunk ${seq} callback returned false — sink rejected; reconciler will re-fetch`);
        } catch (cbErr: any) {
          if (carriesHeader) this.initSegmentDelivered = false;
          blog(`[record-chunker] chunk ${seq} callback threw: ${cbErr?.message || cbErr}; reconciler will re-fetch`);
        } finally {
          const idx = this.pending.indexOf(event.data);
          if (idx >= 0) this.pending.splice(idx, 1);
        }
      } catch (err: any) {
        const idx = this.pending.indexOf(event.data);
        if (idx >= 0) this.pending.splice(idx, 1);
        blog(`[record-chunker] chunk ${seq} encode FAILED: ${err?.message || err}; spliced`);
      }
    };

    recorder.onstop = async () => {
      // Final chunk (empty body OK — server treats isFinal=true as the COMPLETED signal).
      try {
        const finalSeq = this.chunkSeq;
        this.chunkSeq = finalSeq + 1;
        await this.opts.onChunk({ base64: "", chunkSeq: finalSeq, isFinal: true, mimeType: this.mimeType });
        blog(`[record-chunker] final chunk emitted (seq=${finalSeq})`);
      } catch (err: any) {
        blog(`[record-chunker] final chunk callback failed: ${err?.message || err}`);
      } finally {
        if (this.resolveFinalChunk) { this.resolveFinalChunk(); this.resolveFinalChunk = null; }
      }
    };

    recorder.start(this.opts.timesliceMs ?? 15000);
    blog(`[record-chunker] MediaRecorder started (${this.mimeType}, timeslice=${this.opts.timesliceMs ?? 15000}ms)`);
  }

  async stop(): Promise<void> {
    if (!this.recorder) { blog("[record-chunker] stop() before start() — ignoring"); return; }
    if (this.recorder.state === "inactive") { blog("[record-chunker] recorder already inactive"); return; }

    const finalChunkPromise = new Promise<void>((resolve) => {
      this.resolveFinalChunk = resolve;
      setTimeout(() => {
        if (this.resolveFinalChunk) {
          blog("[record-chunker] final chunk timeout — resolving");
          this.resolveFinalChunk(); this.resolveFinalChunk = null;
        }
      }, 10000);
    });

    try { this.recorder.stop(); }
    catch (err: any) { blog(`[record-chunker] recorder.stop() threw: ${err?.message || err}`); }

    await finalChunkPromise;
  }
}

// ───────────────────────────────────────────────────────────────────────
// createRecordingTap — the full browser recording tap (generic, all platforms)
// ───────────────────────────────────────────────────────────────────────

/**
 * Find active media elements that expose audio. Two-pass (strict → relaxed):
 * tiles can be paused or expose audio via captureStream() rather than a direct
 * srcObject, so the relaxed pass mirrors MediaElementMixer's fallbacks. This
 * is platform-agnostic — a recording grabs every audio element on the page.
 */
async function findMediaElements(retries = 5, delay = 2000): Promise<HTMLMediaElement[]> {
  for (let i = 0; i < retries; i++) {
    const all = Array.from(document.querySelectorAll("audio, video"));
    let els = all.filter((el: any) =>
      !el.paused && el.srcObject instanceof MediaStream && el.srcObject.getAudioTracks().length > 0
    ) as HTMLMediaElement[];
    if (els.length > 0) { blog(`[record-chunker] ${els.length} media elements (strict)`); return els; }

    els = all.filter((el: any) => {
      try {
        if (el.srcObject instanceof MediaStream && el.srcObject.getAudioTracks().length > 0) return true;
        if (typeof el.captureStream === "function" && el.captureStream()?.getAudioTracks?.().length > 0) return true;
        if (typeof el.mozCaptureStream === "function" && el.mozCaptureStream()?.getAudioTracks?.().length > 0) return true;
      } catch { /* not probeable; skip */ }
      return false;
    }) as HTMLMediaElement[];
    if (els.length > 0) { blog(`[record-chunker] ${els.length} media elements (relaxed)`); return els; }

    await new Promise((r) => setTimeout(r, delay));
  }
  return [];
}

/** How often the mix re-reads the page's media elements. A swapped `srcObject` fires no DOM
 *  mutation, so the observer alone would miss a track that was re-created under an existing
 *  element (Jitsi after unmute / reconnect); the poll catches it within one interval. */
const FOLLOW_INTERVAL_MS = 2000;

/** True when `s` is a MediaStream carrying at least one audio track. */
function hasAudio(s: any): s is MediaStream {
  try { return s instanceof MediaStream && s.getAudioTracks().length > 0; } catch { return false; }
}

/**
 * The page mix: every audio-bearing media element rendered into ONE MediaStream through an
 * AudioContext destination, and — the part that makes a recording complete — kept FOLLOWING the
 * page after start. Meeting clients create a media element per remote track and re-create it
 * whenever the track is re-negotiated (mute→unmute, a participant rejoining, an ICE restart);
 * a mix built once at start would hold only the tracks alive at that moment and record digital
 * silence for everyone who arrived later. So the mix is a registry keyed by track id: `follow()`
 * connects every track it has not seen, and stays idempotent for the ones it has.
 *
 * Elements without a `srcObject` (audio via `captureStream()`) are keyed by element, because every
 * `captureStream()` call mints fresh track ids — keying those by track would reconnect them forever.
 */
export class MediaElementMixer {
  private ctx: AudioContext;
  private dest: MediaStreamAudioDestinationNode;
  /** The mixed stream to record; its track never changes, so a MediaRecorder over it keeps
   *  running while sources come and go underneath. */
  readonly stream: MediaStream;
  private connectedTracks = new Set<string>();
  private capturedElements = new WeakSet<object>();
  private sources = 0;
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.ctx = new AudioContext();
    this.dest = this.ctx.createMediaStreamDestination();
    this.stream = this.dest.stream;
  }

  /** Number of sources connected so far (diagnostics). */
  get sourceCount(): number { return this.sources; }

  /** Connect every audio-bearing media element on the page that is not in the mix yet.
   *  Returns how many sources were added by this pass. */
  follow(): number {
    let added = 0;
    const all = Array.from(document.querySelectorAll("audio, video"));
    for (const el of all) {
      try { added += this.consider(el as any); }
      catch (e: any) { blog(`[record-chunker] could not connect a media element: ${e?.message || e}`); }
    }
    if (added > 0) blog(`[record-chunker] +${added} media source(s) → ${this.sources} in the mix`);
    return added;
  }

  private consider(el: any): number {
    const so = el.srcObject;
    if (hasAudio(so)) {
      const fresh = so.getAudioTracks().filter((t) => !this.connectedTracks.has(t.id));
      if (fresh.length === 0) return 0;
      // Only the unseen tracks: a swapped srcObject may share nothing with the stream it replaced.
      const src = this.ctx.createMediaStreamSource(new MediaStream(fresh));
      src.connect(this.dest);
      for (const t of fresh) {
        this.connectedTracks.add(t.id);
        // An ended track feeds silence forever; drop its node so the graph does not grow unbounded.
        try { t.addEventListener("ended", () => { try { src.disconnect(); } catch { /* */ } }); } catch { /* */ }
      }
      this.sources++;
      return 1;
    }
    if (this.capturedElements.has(el)) return 0;
    let cs: any = null;
    try { cs = el.captureStream?.() ?? el.mozCaptureStream?.() ?? null; } catch { cs = null; }
    if (!hasAudio(cs)) return 0;
    this.ctx.createMediaStreamSource(cs).connect(this.dest);
    this.capturedElements.add(el);
    this.sources++;
    return 1;
  }

  /** Start following the page: a DOM observer for elements that appear, and a poll for
   *  `srcObject` swaps under existing ones. */
  start(intervalMs = FOLLOW_INTERVAL_MS): void {
    if (this.timer) return;
    try {
      this.observer = new MutationObserver(() => { this.follow(); });
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e: any) {
      blog(`[record-chunker] MutationObserver unavailable (${e?.message || e}) — polling only`);
    }
    this.timer = setInterval(() => { this.follow(); }, intervalMs);
  }

  /** Stop following and release the audio graph. */
  stop(): void {
    try { this.observer?.disconnect(); } catch { /* */ }
    this.observer = null;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { void this.ctx.close(); } catch { /* */ }
  }
}

/** Options for createRecordingTap — combine all audio elements then optionally override. */
export interface CreateRecordingTapOptions extends RecordingTapOptions {
  /** Provide a ready stream to record (e.g. the mixed-lane tab stream); else all audio elements are combined. */
  stream?: MediaStream;
  /** How often the element mix re-reads the page (ms). Default 2000. */
  followIntervalMs?: number;
}

/**
 * The browser recording tap, used by BOTH lanes (gmeet, teams) and both hosts
 * (bot, extension): find every audio element → combine → `MediaRecorderChunker`
 * → recording.v1 chunks via `onChunk`. Recording is platform-agnostic — it
 * records the whole meeting mix — so this is ONE generic tap, not per-lane.
 * (Zoom records via node PulseAudio in @vexa/recording, no browser tap.)
 *
 * Pass `opts.stream` to record a ready stream directly (skips the element
 * combine); otherwise it combines the page's audio elements and keeps the
 * mix following the page for the whole recording (see MediaElementMixer).
 */
export function createRecordingTap(opts: CreateRecordingTapOptions): RecordingTap {
  let chunker: MediaRecorderChunker | null = null;
  let mixer: MediaElementMixer | null = null;
  return {
    async start(): Promise<void> {
      let stream = opts.stream;
      if (!stream) {
        const els = await findMediaElements();
        if (els.length === 0) { blog("[record-chunker] no media elements — cannot record"); return; }
        mixer = new MediaElementMixer();
        const connected = mixer.follow();
        if (connected === 0) throw new Error("[record-chunker] could not connect any audio streams");
        blog(`[record-chunker] combined ${connected} streams`);
        mixer.start(opts.followIntervalMs);
        stream = mixer.stream;
      }
      chunker = new MediaRecorderChunker({
        stream,
        timesliceMs: opts.timesliceMs ?? 15000,
        onChunk: opts.onChunk,
        onStarted: opts.onStarted,
      });
      await chunker.start();
    },
    async stop(): Promise<void> {
      await chunker?.stop();
      chunker = null;
      mixer?.stop();
      mixer = null;
    },
  };
}
