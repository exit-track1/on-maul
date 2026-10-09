import { Runtime, type View } from '../../../shared/src/runtime.ts';

export interface ClientSnapshot {
  view: View;
  connected: boolean;
  offline: boolean;
  error: string | null;
}

class CommandError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** One authority per page: HTTP by default, explicitly local with ?demo=1. */
export class Client {
  readonly local = new Runtime();
  readonly offline = new URLSearchParams(location.search).get('demo') === '1';
  connected = false;
  token = '';
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
  private lastLocalTick = 0;

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
    this.listeners.forEach((listener) => listener(snapshot));
  }

  subscribe(listener: (snapshot: ClientSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot());
    if (this.listeners.size === 1) {
      const generation = ++this.generation;
      this.lastLocalTick = performance.now();
      const poll = async () => {
        if (generation !== this.generation) return;
        if (this.offline) {
          this.advanceLocal();
        } else {
          try {
            await this.connect();
          } catch {
            // Connection state is published by connect. The same server is retried.
          }
        }
        if (generation === this.generation)
          this.timer = setTimeout(poll, this.offline ? 100 : 225);
      };
      void poll();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        ++this.generation;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.abort?.abort();
        this.abort = null;
        this.inFlight = null;
      }
    };
  }

  private advanceLocal() {
    const now = performance.now();
    const elapsed = Math.max(0, now - this.lastLocalTick);
    this.lastLocalTick = now;
    const simulation = this.current.simulation;
    if (simulation.playing && simulation.phase === 'running') {
      this.current = this.local.tickCycle((elapsed / 60000) * simulation.speed);
      this.publish();
    }
  }

  private accept(
    view: View,
    sequence: number,
    instance: string | null,
    fromPoll: boolean,
  ) {
    if (!view.data?.metadata?.synthetic || !view.simulation)
      throw new Error('mock API 형식이 다릅니다.');
    if (instance && this.retiredInstances.has(instance)) return this.current;
    const newInstance = instance && instance !== this.instance;
    if (newInstance) {
      // A process restart may legitimately reset revision. Only a fresh state
      // read establishes that epoch; late responses cannot revive an old one.
      if (!fromPoll || sequence < this.appliedSequence) return this.current;
      if (this.instance) this.retiredInstances.add(this.instance);
      this.instance = instance;
    } else if (
      view.revision < this.current.revision ||
      (view.revision === this.current.revision &&
        sequence < this.appliedSequence)
    ) {
      return this.current;
    }
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
    const generation = this.generation;
    const sequence = ++this.sequence;
    const abort = new AbortController();
    this.abort = abort;
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
        if (generation === this.generation && !abort.signal.aborted) {
          this.connected = false;
          this.error = '서버 연결 끊김 · 마지막 수신 상태를 표시합니다.';
          this.publish();
        }
        throw error;
      }
    })();
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = null;
      if (this.abort === abort) this.abort = null;
    }
  }

  private async send(
    action: string,
    input: Record<string, unknown>,
  ): Promise<View> {
    if (this.offline) {
      this.current = this.local.command(action, input);
      this.lastLocalTick = performance.now();
      this.publish();
      return this.current;
    }
    if (!this.connected)
      throw new Error(
        '서버 연결을 확인하세요. 연결 복구 후 작업할 수 있습니다.',
      );
    const sequence = ++this.sequence;
    let response: Response;
    try {
      response = await fetch('/api/command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ action, input }),
      });
    } catch (error) {
      this.connected = false;
      this.error = '서버 연결 끊김 · 마지막 수신 상태를 표시합니다.';
      this.publish();
      throw error;
    }
    const body = await response.json();
    if (!response.ok)
      throw new CommandError(body.error ?? '요청 오류', body.code);
    return this.accept(
      body as View,
      sequence,
      response.headers.get('x-onmaul-instance'),
      false,
    );
  }

  async command(
    action: string,
    input: Record<string, unknown> = {},
  ): Promise<View> {
    try {
      return await this.send(action, input);
    } catch (error) {
      // Clock boundaries can stale playback controls. Reviewed human approvals
      // are never automatically repeated.
      if (
        action !== 'sim' ||
        !(error instanceof CommandError) ||
        error.code !== 'stale_revision'
      )
        throw error;
      await this.connect();
      return this.send(action, { ...input, revision: this.current.revision });
    }
  }
}
