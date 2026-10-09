import type { Fixtures, Point } from './types.ts';

type MapData = Fixtures['map'];
type Segment = { a: Point; b: Point; roadId: string };
export interface DemoRoute {
  waypoints: Point[];
  roadIds: string[];
  distanceMeters: number;
  accessRule: 'synthetic-nearest-open-road-250px';
}
const EPS = 1e-6;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const minus = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
const pointKey = (p: Point) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
function segments(map: MapData, blocked: boolean): Segment[] {
  return map.roads
    .filter((r) => r.blocked === blocked)
    .flatMap((r) =>
      r.points.slice(1).map((b, i) => ({
        a: { x: r.points[i][0], y: r.points[i][1] },
        b: { x: b[0], y: b[1] },
        roadId: r.id,
      })),
    );
}
function projection(p: Point, a: Point, b: Point): Point {
  const d = minus(b, a),
    length2 = d.x * d.x + d.y * d.y;
  const t =
    length2 < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / length2));
  return { x: a.x + d.x * t, y: a.y + d.y * t };
}
function onSegment(p: Point, a: Point, b: Point) {
  return distance(p, projection(p, a, b)) < EPS;
}
function intersections(a: Point, b: Point, c: Point, d: Point): Point[] {
  const ab = minus(b, a),
    cd = minus(d, c),
    det = cross(ab, cd);
  if (Math.abs(det) < EPS)
    return [a, b, c, d].filter((p) => onSegment(p, a, b) && onSegment(p, c, d));
  const ca = minus(c, a),
    t = cross(ca, cd) / det,
    u = cross(ca, ab) / det;
  return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS
    ? [{ x: a.x + t * ab.x, y: a.y + t * ab.y }]
    : [];
}
function clear(a: Point, b: Point, blocked: Segment[]) {
  return !blocked.some((s) => {
    const hits = intersections(a, b, s.a, s.b);
    // An open-road junction may touch the end of a closed road; crossing its
    // interior or travelling along any closed length remains forbidden.
    return (
      hits.some((p) => distance(p, s.a) > EPS && distance(p, s.b) > EPS) ||
      hits.some((p) => hits.some((q) => distance(p, q) > EPS))
    );
  });
}

/** Synthetic road topology only; local access legs are explicit, bounded demo assumptions. */
export function findDemoRoute(map: MapData, from: Point, to: Point): DemoRoute | null {
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return null;
  const blocked = segments(map, true);
  const roads = segments(map, false).filter(
    (s) => distance(s.a, s.b) > EPS && clear(s.a, s.b, blocked),
  );
  if (!roads.length) return null;
  const access = (p: Point) =>
    roads
      .map((s, i) => ({ i, point: projection(p, s.a, s.b) }))
      .filter((x) => distance(p, x.point) <= 250 && clear(p, x.point, blocked))
      .sort((a, b) => distance(p, a.point) - distance(p, b.point) || a.i - b.i)[0];
  const start = access(from),
    end = access(to);
  if (!start || !end) return null;
  const cuts = roads.map((s) => [s.a, s.b]);
  cuts[start.i].push(start.point);
  cuts[end.i].push(end.point);
  for (let i = 0; i < roads.length; i++)
    for (let j = i + 1; j < roads.length; j++) {
      const ps = intersections(roads[i].a, roads[i].b, roads[j].a, roads[j].b);
      cuts[i].push(...ps);
      cuts[j].push(...ps);
    }
  const points = new Map<string, Point>();
  const edges = new Map<string, { to: string; cost: number; roadId: string }[]>();
  const connect = (a: Point, b: Point, roadId: string) => {
    const ka = pointKey(a),
      kb = pointKey(b);
    points.set(ka, a);
    points.set(kb, b);
    if (!edges.has(ka)) edges.set(ka, []);
    if (!edges.has(kb)) edges.set(kb, []);
    if (ka === kb) return;
    edges.get(ka)!.push({ to: kb, cost: distance(a, b), roadId });
    edges.get(kb)!.push({ to: ka, cost: distance(a, b), roadId });
  };
  roads.forEach((s, i) => {
    const ps = [...new Map(cuts[i].map((p) => [pointKey(p), p])).values()].sort(
      (a, b) => distance(s.a, a) - distance(s.a, b),
    );
    ps.slice(1).forEach((p, j) => connect(ps[j], p, s.roadId));
  });
  connect(from, start.point, '');
  connect(to, end.point, '');
  const begin = pointKey(from),
    finish = pointKey(to),
    costs = new Map([[begin, 0]]);
  const previous = new Map<string, { from: string; roadId: string }>(),
    pending = new Set(edges.keys());
  while (pending.size) {
    const here = [...pending].sort(
      (a, b) => (costs.get(a) ?? Infinity) - (costs.get(b) ?? Infinity) || a.localeCompare(b),
    )[0];
    const cost = costs.get(here);
    if (cost === undefined) break;
    pending.delete(here);
    if (here === finish) break;
    for (const edge of edges.get(here) ?? [])
      if (pending.has(edge.to) && cost + edge.cost < (costs.get(edge.to) ?? Infinity)) {
        costs.set(edge.to, cost + edge.cost);
        previous.set(edge.to, { from: here, roadId: edge.roadId });
      }
  }
  if (!costs.has(finish)) return null;
  const ids: string[] = [],
    keys = [finish];
  while (keys[0] !== begin) {
    const p = previous.get(keys[0]);
    if (!p) return null;
    keys.unshift(p.from);
    if (p.roadId) ids.unshift(p.roadId);
  }
  return {
    waypoints: keys.map((key) => points.get(key)!),
    roadIds: [...new Set(ids)],
    distanceMeters: costs.get(finish)! * map.metersPerPixel,
    accessRule: 'synthetic-nearest-open-road-250px',
  };
}
export function routeIsOpen(map: MapData, route: DemoRoute) {
  const blocked = segments(map, true);
  return (
    route.roadIds.every((id) => map.roads.some((r) => r.id === id && !r.blocked)) &&
    route.waypoints.slice(1).every((p, i) => clear(route.waypoints[i], p, blocked))
  );
}
export function routePosition(route: DemoRoute, fraction: number): Point {
  const lengths = route.waypoints.slice(1).map((p, i) => distance(route.waypoints[i], p));
  let remaining = lengths.reduce((a, b) => a + b, 0) * Math.max(0, Math.min(1, fraction));
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] && lengths[i] > EPS) {
      const a = route.waypoints[i],
        b = route.waypoints[i + 1],
        f = remaining / lengths[i];
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    remaining -= lengths[i];
  }
  return route.waypoints.at(-1)!;
}
