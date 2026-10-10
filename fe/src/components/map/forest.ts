import cover from './forest-fuel.json' with { type: 'json' };
import type { Fixtures, Point, Zone } from '../../../../shared/src/types.ts';

const SIZE = cover.cellSize;
const COLS = cover.width / SIZE;
const ROWS = cover.height / SIZE;
const fuel = new Uint8Array(COLS * ROWS);
cover.rows.forEach((runs, y) => {
  for (let i = 0; i < runs.length; i += 2)
    fuel.fill(1, y * COLS + runs[i], y * COLS + runs[i] + runs[i + 1]);
});

export interface ForestSpread {
  fuel: Uint8Array;
  arrival: Float64Array;
  fuelPath: string;
}
export interface ForestFrame {
  areaPath: string;
  boundaryPath: string;
  cells: number[];
  flames: Point[];
}
export interface SmokePuff extends Point {
  rx: number;
  ry: number;
  opacity: number;
}

function point(index: number): Point {
  return {
    x: ((index % COLS) + 0.5) * SIZE,
    y: (Math.floor(index / COLS) + 0.5) * SIZE,
  };
}
function rowPath(inside: (index: number) => boolean): string {
  const paths: string[] = [];
  for (let y = 0; y < ROWS; y++) {
    let start = -1;
    for (let x = 0; x <= COLS; x++) {
      const occupied = x < COLS && inside(y * COLS + x);
      if (occupied && start < 0) start = x;
      else if (!occupied && start >= 0) {
        const width = (x - start) * SIZE;
        paths.push(`M${start * SIZE} ${y * SIZE}h${width}v${SIZE}h-${width}Z`);
        start = -1;
      }
    }
  }
  return paths.join('');
}

/** Illustrative connected-fuel spread, separate from operational dispatch ETA. */
export function forestPropagation(
  map: Fixtures['map'],
  cleared: Point[] = [],
): ForestSpread {
  const wooded = fuel.slice();
  for (const p of cleared) {
    for (
      let y = Math.max(0, Math.floor((p.y - 20) / SIZE));
      y < Math.min(ROWS, Math.ceil((p.y + 20) / SIZE));
      y++
    )
      for (
        let x = Math.max(0, Math.floor((p.x - 20) / SIZE));
        x < Math.min(COLS, Math.ceil((p.x + 20) / SIZE));
        x++
      ) {
        const i = y * COLS + x;
        const center = point(i);
        if (Math.hypot(center.x - p.x, center.y - p.y) < 19) wooded[i] = 0;
      }
  }
  const arrival = new Float64Array(fuel.length).fill(Infinity);
  const fuelPath = rowPath((i) => Boolean(wooded[i]));
  if (
    !Number.isFinite(map.wind.direction) ||
    !Number.isFinite(map.wind.speedMps) ||
    map.wind.speedMps < 0
  )
    return { fuel: wooded, arrival, fuelPath };
  const startX = Math.floor(map.ignition.x / SIZE),
    startY = Math.floor(map.ignition.y / SIZE);
  if (
    startX < 0 ||
    startX >= COLS ||
    startY < 0 ||
    startY >= ROWS ||
    !wooded[startY * COLS + startX]
  )
    return { fuel: wooded, arrival, fuelPath };
  const theta = ((map.wind.direction + 180) * Math.PI) / 180;
  const ux = Math.sin(theta),
    uy = -Math.cos(theta);
  const velocity = 25 + 4 * map.wind.speedMps;
  const neighbors = [-1, 0, 1].flatMap((dy) =>
    [-1, 0, 1]
      .filter((dx) => dx || dy)
      .map((dx) => {
        const along = dx * ux + dy * uy;
        const across = Math.abs(dx * uy - dy * ux);
        return {
          dx,
          dy,
          cost:
            ((Math.max(0, along) + 3 * Math.max(0, -along) + 2 * across) *
              SIZE *
              map.metersPerPixel) /
            velocity,
        };
      }),
  );
  const heap: { index: number; time: number }[] = [];
  const push = (index: number, time: number) => {
    heap.push({ index, time });
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (heap[parent].time <= time) break;
      [heap[child], heap[parent]] = [heap[parent], heap[child]];
      child = parent;
    }
  };
  const pop = () => {
    const first = heap[0],
      last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let parent = 0;
      while (parent * 2 + 1 < heap.length) {
        let child = parent * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].time < heap[child].time)
          child++;
        if (heap[parent].time <= heap[child].time) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        parent = child;
      }
    }
    return first;
  };
  const start = startY * COLS + startX;
  arrival[start] = 0;
  push(start, 0);
  while (heap.length) {
    const here = pop();
    if (here.time > arrival[here.index]) continue;
    const x = here.index % COLS,
      y = Math.floor(here.index / COLS);
    for (const n of neighbors) {
      const nx = x + n.dx,
        ny = y + n.dy;
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
      const next = ny * COLS + nx;
      if (!wooded[next]) continue;
      // Never cut diagonally across a road, a field or a cleared corner.
      if (n.dx && n.dy && (!wooded[y * COLS + nx] || !wooded[ny * COLS + x]))
        continue;
      const time = here.time + n.cost;
      if (time >= arrival[next]) continue;
      arrival[next] = time;
      push(next, time);
    }
  }
  return { fuel: wooded, arrival, fuelPath };
}

export function forestFrame(
  spread: ForestSpread,
  minutes: number,
): ForestFrame {
  const cells: number[] = [],
    boundary: string[] = [],
    candidates: Point[] = [];
  const burning = (i: number) =>
    i >= 0 &&
    i < spread.arrival.length &&
    minutes > 0 &&
    spread.arrival[i] <= minutes;
  for (let i = 0; i < spread.arrival.length; i++) {
    if (!burning(i)) continue;
    cells.push(i);
    const x = i % COLS,
      y = Math.floor(i / COLS);
    if (y === 0 || !burning(i - COLS))
      boundary.push(`M${x * SIZE} ${y * SIZE}h${SIZE}`);
    if (y === ROWS - 1 || !burning(i + COLS))
      boundary.push(`M${x * SIZE} ${(y + 1) * SIZE}h${SIZE}`);
    if (x === 0 || !burning(i - 1))
      boundary.push(`M${x * SIZE} ${y * SIZE}v${SIZE}`);
    if (x === COLS - 1 || !burning(i + 1))
      boundary.push(`M${(x + 1) * SIZE} ${y * SIZE}v${SIZE}`);
    if (
      minutes - spread.arrival[i] < 1.6 &&
      [
        i - COLS,
        i + COLS,
        ...(x > 0 ? [i - 1] : []),
        ...(x < COLS - 1 ? [i + 1] : []),
      ].some(
        (n) =>
          n >= 0 &&
          n < spread.arrival.length &&
          Number.isFinite(spread.arrival[n]) &&
          spread.arrival[n] > minutes,
      )
    )
      candidates.push(point(i));
  }
  const interval = Math.max(1, Math.ceil(candidates.length / 45));
  return {
    areaPath: rowPath(burning),
    boundaryPath: boundary.join(''),
    cells,
    flames: candidates.filter((_, i) => i % interval === 0),
  };
}

/** Smoke is advected downwind from the burning forest and may pass over cleared land. */
export function smokePlume(
  map: Fixtures['map'],
  frame: ForestFrame,
  minutes: number,
): SmokePuff[] {
  if (minutes <= 0 || !frame.cells.length) return [];
  const theta = ((map.wind.direction + 180) * Math.PI) / 180;
  const ux = Math.sin(theta),
    uy = -Math.cos(theta);
  const candidates = frame.cells.filter((_, i) => i % 8 === 0).map(point);
  if (!candidates.length) candidates.push(point(frame.cells[0]));
  const downwind = candidates.reduce((a, b) =>
    a.x * ux + a.y * uy > b.x * ux + b.y * uy ? a : b,
  );
  const villageDistance = (p: Point) =>
    Math.hypot(p.x - map.width / 2, p.y - map.height / 2);
  const villageEdge = candidates.reduce((a, b) =>
    villageDistance(a) < villageDistance(b) ? a : b,
  );
  const southernEdge = candidates.reduce((a, b) => (a.y > b.y ? a : b));
  // Smoke comes from the burning woodland, including the smouldering edge
  // beside the fields. Its movement always follows the supplied wind vector.
  const sources = [downwind, villageEdge, southernEdge];
  const length = Math.min(1200, 260 + map.wind.speedMps * 36 + minutes * 20);
  return sources.flatMap((source, lane) =>
    Array.from({ length: 14 }, (_, i) => {
      const fraction = (i + 1) / 14;
      const distance = fraction * length;
      const drift = Math.sin(i * 1.8 + lane) * (7 + fraction * 25);
      return {
        x: source.x + ux * distance - uy * drift,
        y: source.y + uy * distance + ux * drift,
        rx: 38 + fraction * 90,
        ry: 22 + fraction * 56,
        opacity: (0.82 + lane * 0.025) * (1 - fraction * 0.4),
      };
    }),
  );
}

export function forestZoneLabel(
  zone: Zone,
  frame: ForestFrame,
  smoke: SmokePuff[],
): string {
  const { x1, y1, x2, y2 } = zone.demoBounds;
  if (
    frame.cells.some((i) => {
      const p = point(i);
      return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
    })
  )
    return '숲 화재';
  if (
    smoke.some(
      (p) =>
        p.x + p.rx >= x1 &&
        p.x - p.rx <= x2 &&
        p.y + p.ry >= y1 &&
        p.y - p.ry <= y2,
    )
  )
    return '연기 흐름';
  return '대피 확인';
}
