import type { View } from '../../../shared/src/runtime.ts';
import { ShowcaseRuntime } from '../../../shared/src/showcase.ts';

export interface ClientSnapshot {
  view: View;
  connected: boolean;
  offline: boolean;
  error: string | null;
}
/** The only HTTP destinations are this dashboard's own state/command endpoints. */
export class Client {
  readonly local = new ShowcaseRuntime();
  readonly offline = new URLSearchParams(location.search).get('demo') === '1';
  connected = false;
  private current = this.local.view();
  private error: string | null = null;
  private listeners = new Set<(snapshot: ClientSnapshot) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private generation = 0;
  private sequence = 0;
  private appliedSequence = 0;
  private instance: string | null = null;
  private retiredInstances = new Set<string>();
  private inFlight: Promise<View> | null = null;
  private lastTick = 0;
  snapshot(): ClientSnapshot {
    return {
      view: this.current,
      connected: this.connected,
      offline: this.offline,
      error: this.error,
    };
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
      const poll = async () => {
        if (generation !== this.generation) return;
        if (this.offline) this.advanceLocal();
        else {
          try {
            await this.connect();
          } catch {
            /* retry this same origin */
          }
        }
        if (generation === this.generation)
          this.timer = setTimeout(poll, this.offline ? 100 : 250);
      };
      void poll();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        ++this.generation;
        if (this.timer) clearTimeout(this.timer);
        this.abort?.abort();
        this.inFlight = null;
      }
    };
  }
  private advanceLocal() {
    const now = performance.now(),
      elapsed = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    if (this.current.simulation.playing)
      this.current = this.local.tickCycle(
        Math.min(1000, (elapsed * this.current.simulation.speed) / 60000),
      );
    this.publish();
  }
  private accept(
    view: View,
    sequence: number,
    instance: string | null,
    fromPoll: boolean,
  ) {
    if (view.showcase?.version !== 1)
      throw new Error('새 모의 시뮬레이션 서버로 재배포해야 합니다.');
    if (instance && this.retiredInstances.has(instance)) return this.current;
    if (instance && instance !== this.instance) {
      if (!fromPoll || sequence < this.appliedSequence) return this.current;
      if (this.instance) this.retiredInstances.add(this.instance);
      this.instance = instance;
    } else if (
      view.revision < this.current.revision ||
      (view.revision === this.current.revision &&
        sequence < this.appliedSequence)
    )
      return this.current;
    this.current = view;
    this.appliedSequence = sequence;
    this.connected = true;
    this.error = null;
    this.publish();
    return this.current;
  }
  async connect(): Promise<View> {
    if (this.offline) return this.current;
    if (this.inFlight) return this.inFlight;
    const generation = this.generation,
      sequence = ++this.sequence;
    const abort = new AbortController();
    this.abort = abort;
    const timeout = setTimeout(() => abort.abort(), 5000);
    const request = (async () => {
      try {
        const response = await fetch('/api/state', {
          signal: abort.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('서버 연결 실패');
        const view = (await response.json()) as View;
        if (generation !== this.generation) return this.current;
        return this.accept(
          view,
          sequence,
          response.headers.get('x-onmaul-instance'),
          true,
        );
      } catch (error) {
        if (generation === this.generation) {
          this.connected = false;
          this.error =
            error instanceof Error && error.message.includes('재배포')
              ? error.message
              : '서버 연결 끊김 · 마지막 수신 상태';
          this.publish();
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    })();
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = null;
    }
  }
  async command(
    action: string,
    input: Record<string, unknown> = {},
  ): Promise<View> {
    if (this.offline) {
      this.advanceLocal();
      this.current = this.local.command(action, input);
      this.lastTick = performance.now();
      this.publish();
      return this.current;
    }
    if (!this.connected) throw new Error('서버 연결을 확인해 주세요.');
    const sequence = ++this.sequence;
    const response = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, input }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? '재생 변경 실패');
    return this.accept(
      body as View,
      sequence,
      response.headers.get('x-onmaul-instance'),
      false,
    );
  }
}
