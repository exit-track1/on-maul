export interface Simulation {
  cycleId: string | null;
  phase: 'idle' | 'review' | 'running' | 'awaiting_handover' | 'ended';
  playing: boolean;
  speed: 12 | 30 | 60;
  durationMinutes: number;
  endReason: string | null;
}

export function initialSimulation(): Simulation {
  return {
    cycleId: null,
    phase: 'idle',
    playing: false,
    speed: 30,
    durationMinutes: 40,
    endReason: null,
  };
}

// Integer micro-minutes make pulse grouping deterministic. Carry the unconsumed fraction
// instead of rounding every 100–250 ms pulse independently.
export const CYCLE_UNITS_PER_MINUTE = 1_000_000;
export function cycleTime(minutes: number): number {
  return Math.round(minutes * CYCLE_UNITS_PER_MINUTE) / CYCLE_UNITS_PER_MINUTE;
}
export function cycleBudget(current: number, delta: number, remainder = 0, limit = 40) {
  const requested = delta * CYCLE_UNITS_PER_MINUTE + remainder;
  const units = Math.floor(requested + 1e-9);
  const target = Math.max(
    current,
    Math.min(limit, cycleTime(current + units / CYCLE_UNITS_PER_MINUTE)),
  );
  return { target, remainder: target === limit ? 0 : Math.max(0, requested - units) };
}
