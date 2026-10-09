import type WebSocket from 'ws';
import type { LiveConnection } from './live.ts';
export function validAudio(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 106668 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}
export function muLawRms(data: Buffer) {
  let energy = 0;
  for (const byte of data) {
    const u = 255 - byte;
    const magnitude = (((u & 15) * 8 + 132) << ((u >> 4) & 7)) - 132;
    energy += magnitude * magnitude;
  }
  return Math.sqrt(energy / Math.max(1, data.length));
}
const silence = Buffer.alloc(160, 255);
export class AudioBridge {
  // Gate outbound playback independently; inbound audio must keep draining.
  active = false;
  stopped = false;
  clears = 0;
  inputBytes = 0;
  outputBytes = 0;
  dropped = 0;
  outputUnderruns = 0;
  outputBufferedMs = 0;
  output = Buffer.alloc(0);
  inputQueue = Buffer.alloc(0);
  pending = new Map<number, Buffer>();
  next: number | null = null;
  private firstAt = 0;
  private gapAt = 0;
  private loud = 0;
  private quiet = 0;
  private speaking = false;
  private outputReady = false;
  private outputAt: number | null = null;
  private lastOutputAt = 0;
  private nextOutputAt = 0;
  private marks = new Map<string, number>();
  readonly sentMarks = new Set<string>();
  private timer: NodeJS.Timeout;
  private lastStats = 0;
  socket: WebSocket;
  live: LiveConnection;
  fault: (code: string) => void;
  onClear: () => void;
  stats: () => void;
  constructor(
    socket: WebSocket,
    live: LiveConnection,
    fault: (code: string) => void,
    onClear: () => void,
    stats: () => void,
  ) {
    this.socket = socket;
    this.live = live;
    this.fault = fault;
    this.onClear = onClear;
    this.stats = stats;
    this.timer = setInterval(() => this.tick(), 20);
    this.timer.unref();
  }
  input(chunk: number, audio: string) {
    if (
      this.stopped ||
      !Number.isSafeInteger(chunk) ||
      chunk < 0 ||
      !validAudio(audio) ||
      (this.next !== null && chunk < this.next) ||
      this.pending.has(chunk)
    )
      return;
    const buffer = Buffer.from(audio, 'base64');
    if (
      this.pending.size >= 100 ||
      [...this.pending.values()].reduce((n, b) => n + b.length, buffer.length) +
        this.inputQueue.length >
        80000
    ) {
      this.fail('media_input_overflow');
      return;
    }
    this.firstAt ||= Date.now();
    this.pending.set(chunk, buffer);
  }
  appendOutput(audio: string) {
    if (!this.active || this.stopped || !validAudio(audio)) return false;
    const buffer = Buffer.from(audio, 'base64');
    if (this.output.length + buffer.length > 80000) {
      this.fail('media_output_overflow');
      return false;
    }
    this.output = Buffer.concat([this.output, buffer]);
    this.outputAt ??= Date.now();
    this.lastOutputAt = Date.now();
    return true;
  }
  send(event: unknown) {
    if (this.socket.readyState !== 1) return false;
    if (this.socket.bufferedAmount > 80000) {
      this.fail('media_backpressure');
      return false;
    }
    this.socket.send(JSON.stringify(event));
    return true;
  }
  queueMark(name: string) {
    this.marks.set(name, this.outputBytes + this.output.length);
  }
  cancelMark(name?: string) {
    if (name) {
      this.marks.delete(name);
      this.sentMarks.delete(name);
    }
  }
  clear() {
    this.output = Buffer.alloc(0);
    this.outputReady = false;
    this.outputAt = null;
    this.nextOutputAt = 0;
    this.marks.clear();
    this.sentMarks.clear();
    this.clears++;
    this.onClear();
    this.send({ event: 'clear' });
  }
  get inputSpeaking() {
    return this.speaking;
  }
  tick(now = Date.now()) {
    if (this.stopped || !this.live.sessionId) return;
    if (this.next === null && this.pending.size && now - this.firstAt >= 40)
      this.next = Math.min(...this.pending.keys());
    if (this.next !== null) {
      for (let count = 0; count < 20 && this.pending.has(this.next); count++) {
        const buffer = this.pending.get(this.next)!;
        this.pending.delete(this.next++);
        this.inputQueue = Buffer.concat([this.inputQueue, buffer]);
        this.gapAt = 0;
      }
      if (this.pending.size && !this.pending.has(this.next)) {
        this.gapAt ||= now;
        if (now - this.gapAt >= 100) {
          const first = Math.min(...this.pending.keys());
          this.dropped += first - this.next;
          this.next = first;
          this.gapAt = 0;
        }
      }
    }
    let frame = silence;
    if (this.inputQueue.length) {
      const size = Math.min(160, this.inputQueue.length);
      frame = Buffer.alloc(160, 255);
      this.inputQueue.copy(frame, 0, 0, size);
      this.inputQueue = this.inputQueue.subarray(size);
      this.inputBytes += size;
    }
    this.live.send({ type: 'session.input_audio.append', audio: frame.toString('base64') });
    if (muLawRms(frame) > 1200) {
      this.quiet = 0;
      if (++this.loud >= 3 && !this.speaking) {
        this.speaking = true;
        // A loud line/echo is not a confirmed user turn. The trusted transcript interrupts playback.
      }
    } else {
      this.loud = 0;
      if (++this.quiet >= 8) this.speaking = false;
    }
    if (!this.active) {
      this.updateStats(now);
      return;
    }
    if (
      !this.outputReady &&
      this.output.length &&
      (this.output.length >= 960 || now - this.outputAt! >= 120)
    ) {
      this.outputReady = true;
      this.nextOutputAt = now;
    }
    if (this.outputReady && now >= this.nextOutputAt) {
      // Telnyx queues 60ms RTP payloads. Keep partial frames until more audio arrives.
      const complete = Math.floor(this.output.length / 160) * 160;
      const size = Math.min(
        480,
        complete || (now - this.lastOutputAt >= 120 ? this.output.length : 0),
      );
      if (size) {
        const length = Math.ceil(size / 160) * 160;
        const packet = Buffer.alloc(length, 255);
        this.output.copy(packet, 0, 0, size);
        if (this.send({ event: 'media', media: { payload: packet.toString('base64') } })) {
          this.output = this.output.subarray(size);
          this.outputBytes += size;
          this.nextOutputAt = Math.max(this.nextOutputAt + length / 8, now - 60);
        }
      } else if (!this.output.length) {
        this.outputUnderruns++;
        this.outputReady = false;
        this.outputAt = null;
      }
    }
    this.outputBufferedMs = this.output.length / 8;
    for (const [name, after] of this.marks)
      if (this.outputBytes >= after) {
        this.marks.delete(name);
        this.sentMarks.add(name);
        if (!this.send({ event: 'mark', mark: { name } })) this.sentMarks.delete(name);
      }
    this.updateStats(now);
  }
  private updateStats(now: number) {
    if (now - this.lastStats >= 1000) {
      this.lastStats = now;
      this.stats();
    }
  }
  fail(code: string) {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.fault(code);
  }
  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.clear();
    this.pending.clear();
    this.inputQueue = Buffer.alloc(0);
  }
}
