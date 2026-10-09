import { performance } from 'node:perf_hooks';

export interface SimulationTimer {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}
export interface SimulationClockOptions {
  /** Monotonic milliseconds. This clock never drives real telephone timeouts. */
  now?: () => number;
  timer?: SimulationTimer;
}
interface CycleClockState {
  simulation: {
    cycleId: string | null;
    phase: 'idle' | 'review' | 'running' | 'awaiting_handover' | 'ended';
    playing: boolean;
    speed: 12 | 30 | 60;
  };
  networkDown: boolean;
  frozen: boolean;
}
interface ClockSample {
  cycleId: string | null;
  active: boolean;
  speed: 12 | 30 | 60;
}
const nodeTimer: SimulationTimer = {
  setInterval(callback, milliseconds) {
    const handle = setInterval(callback, milliseconds);
    handle.unref();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** All settlement and state changes share the application's mutation queue. */
export class SimulationClock {
  private readonly now: () => number;
  private readonly timer: SimulationTimer;
  private lastAt: number;
  private sample: ClockSample;
  private handle: unknown;
  private closed = false;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly read: () => CycleClockState,
    private readonly tick: (deltaMinutes: number) => Promise<void>,
    private readonly serialized: <T>(work: () => Promise<T>) => Promise<T>,
    options: SimulationClockOptions = {},
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.timer = options.timer ?? nodeTimer;
    this.lastAt = this.time();
    this.sample = this.capture();
    this.handle = this.timer.setInterval(() => {
      void this.pulse().catch((error) => {
        this.close();
        this.onError(error);
      });
    }, 250);
  }

  private time() {
    const value = this.now();
    if (!Number.isFinite(value))
      throw new Error('Simulation clock must return finite milliseconds.');
    return value;
  }

  private capture(): ClockSample {
    const state = this.read();
    return {
      cycleId: state.simulation.cycleId,
      active:
        state.simulation.phase === 'running' &&
        state.simulation.playing &&
        !state.networkDown &&
        !state.frozen,
      speed: state.simulation.speed,
    };
  }

  /** Called inside the shared queue, before a command can change speed or pause state. */
  async settle() {
    if (this.closed) return;
    const at = Math.max(this.lastAt, this.time()),
      elapsed = at - this.lastAt,
      current = this.capture(),
      previous = this.sample;
    this.lastAt = at;
    this.sample = current;
    if (elapsed > 0 && previous.active && current.active && previous.cycleId === current.cycleId) {
      await this.tick((elapsed * previous.speed) / 60000);
      this.sample = this.capture();
    }
  }

  /** Called after every command, including rejection, so stopped time cannot accumulate. */
  synchronize() {
    if (this.closed) return;
    const next = this.capture();
    if (
      next.cycleId !== this.sample.cycleId ||
      next.active !== this.sample.active ||
      next.speed !== this.sample.speed
    )
      this.lastAt = Math.max(this.lastAt, this.time());
    this.sample = next;
  }

  pulse(): Promise<void> {
    if (this.closed) return Promise.resolve();
    // Coalesce timer callbacks waiting behind an asynchronous command. Settlement reads
    // the execution time once, so delayed callbacks neither lose nor duplicate elapsed time.
    if (this.pending) return this.pending;
    this.pending = this.serialized(async () => {
      await this.settle();
    }).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.timer.clearInterval(this.handle);
  }
}
