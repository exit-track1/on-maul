import type { View } from '../../../shared/src/runtime.ts';
import { ShowcaseRuntime } from '../../../shared/src/showcase.ts';

export interface ClientSnapshot {
  view: View;
  sessionId: string;
}

/** A fresh anonymous playback session is created when the dashboard mounts. */
export class Client {
  readonly sessionId = crypto.randomUUID();
  private readonly local = new ShowcaseRuntime(
    crypto.getRandomValues(new Uint32Array(1))[0],
  );
  private current = this.local.view();
  private listeners = new Set<(snapshot: ClientSnapshot) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private lastTick = 0;

  snapshot(): ClientSnapshot {
    return { view: this.current, sessionId: this.sessionId };
  }

  private publish() {
    const snapshot = this.snapshot();
    this.listeners.forEach((fn) => fn(snapshot));
  }

  subscribe(listener: (snapshot: ClientSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot());
    if (this.listeners.size === 1) {
      const generation = ++this.generation;
      this.lastTick = performance.now();
      const tick = () => {
        if (generation !== this.generation) return;
        const now = performance.now();
        const elapsed = Math.max(0, now - this.lastTick);
        this.lastTick = now;
        this.current = this.local.tickCycle(
          Math.min(1000, (elapsed * this.current.simulation.speed) / 60000),
        );
        this.publish();
        if (generation === this.generation) this.timer = setTimeout(tick, 100);
      };
      this.timer = setTimeout(tick, 100);
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        ++this.generation;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }
}
