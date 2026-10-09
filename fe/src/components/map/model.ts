import { eta } from '../../../../shared/src/domain.ts';
import {
  findDemoRoute,
  routePosition,
  type DemoRoute,
} from '../../../../shared/src/routing.ts';
import { tripPosition } from '../../../../shared/src/dispatch.ts';
import type { View } from '../../../../shared/src/runtime.ts';
import type { Fixtures, Point } from '../../../../shared/src/types.ts';

export const MAP_COLORS = {
  act: '#e36c45',
  prog: '#73b8ec',
  safe: '#74c69d',
  visit: '#edc66b',
  before: '#b8c2b2',
  excluded: '#8f9997',
};
export const pathPoints = (points: Point[]) =>
  points.map((p) => `${p.x},${p.y}`).join(' ');

// Keep the perimeter tied to the shared directional ETA model. The texture
// belongs to the fire overlay, not to the geometry used to calculate arrival.
export function firePerimeter(map: Fixtures['map'], minutes: number): Point[] {
  return Array.from({ length: 120 }, (_, i) => {
    const angle = (i * Math.PI) / 60;
    const unit = {
      x: map.ignition.x + Math.cos(angle),
      y: map.ignition.y + Math.sin(angle),
    };
    const arrival = eta(
      unit,
      map.ignition,
      map.wind.direction,
      map.wind.speedMps,
    );
    const radius = arrival && minutes > 0 ? minutes / arrival : 0;
    return {
      x: map.ignition.x + Math.cos(angle) * radius,
      y: map.ignition.y + Math.sin(angle) * radius,
    };
  });
}

export interface MapMotion {
  id: string;
  kind: 'person' | 'vehicle';
  label: string;
  householdId: string;
  position: Point;
  route: DemoRoute;
  fraction: number;
  ambulance?: boolean;
  held?: boolean;
  tripId?: string;
  stage?: string;
  passengers?: number;
  members?: string[];
}

/** Group nearby residents at a wide view, and reveal individuals when zoomed. */
export function clusterMotions(
  motions: MapMotion[],
  radius: number,
): MapMotion[] {
  const clusters: MapMotion[] = [];
  for (const motion of motions) {
    const nearby =
      motion.kind === 'person' &&
      clusters.find(
        (other) =>
          other.kind === 'person' &&
          Math.hypot(
            other.position.x - motion.position.x,
            other.position.y - motion.position.y,
          ) < radius,
      );
    if (!nearby) {
      clusters.push({ ...motion, members: [motion.id] });
      continue;
    }
    const n = nearby.members!.length;
    nearby.position = {
      x: (nearby.position.x * n + motion.position.x) / (n + 1),
      y: (nearby.position.y * n + motion.position.y) / (n + 1),
    };
    nearby.members!.push(motion.id);
    nearby.label = `${nearby.members!.join(' · ')} · 대피 이동`;
  }
  return clusters;
}

export function routeHeading(route: DemoRoute, position: Point): number {
  let nearest = Infinity,
    heading = 0;
  for (let i = 1; i < route.waypoints.length; i++) {
    const a = route.waypoints[i - 1],
      b = route.waypoints[i];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    if (!length) continue;
    const f = Math.max(
      0,
      Math.min(1, ((position.x - a.x) * dx + (position.y - a.y) * dy) / length),
    );
    const distance = Math.hypot(
      position.x - a.x - f * dx,
      position.y - a.y - f * dy,
    );
    if (distance < nearest) {
      nearest = distance;
      heading = (Math.atan2(dy, dx) * 180) / Math.PI;
    }
  }
  return heading;
}

export function motionLabelOffsets(motions: MapMotion[]): Point[] {
  const placed: { x: number; y: number }[] = [];
  return motions.map((motion) => {
    const preferred = motion.kind === 'person' ? -38 : -32;
    const choices = [preferred, preferred - 27, preferred - 54, 38].map(
      (y) => ({ x: 0, y }),
    );
    const offset =
      choices.find(
        (candidate) =>
          !placed.some(
            (other) =>
              Math.abs(other.x - motion.position.x - candidate.x) < 74 &&
              Math.abs(other.y - motion.position.y - candidate.y) < 25,
          ),
      ) ?? choices[2];
    placed.push({
      x: motion.position.x + offset.x,
      y: motion.position.y + offset.y,
    });
    return offset;
  });
}

export function mapMotions(view: View, previewMinutes: number): MapMotion[] {
  const result: MapMotion[] = [];
  const { map, households, shelters, vehicles, teams } = view.data;
  const cycle = Boolean(view.simulation.cycleId);
  const onboard = new Set(view.trips.map((t) => t.householdId));
  for (const [i, status] of view.scenario.householdStatuses.entries()) {
    if (
      status.status !== 'moving' ||
      status.temporaryExclusion ||
      onboard.has(status.householdId)
    )
      continue;
    const household = households.find((h) => h.id === status.householdId)!;
    const shelter = shelters.find((s) => s.id === household.shelterId)!;
    const route = findDemoRoute(
      map,
      household.demoPosition,
      shelter.demoLocation,
    );
    if (!route) continue;
    // There is no GPS feed: these are explicitly labelled route illustrations.
    const elapsed = Math.max(
      0,
      (Date.parse(view.scenario.displayTime) -
        Date.parse(status.lastChangedAt)) /
        60000,
    );
    const fraction = Math.min(
      0.97,
      cycle
        ? ((Number.isFinite(elapsed) ? elapsed : 0) + previewMinutes) /
            Math.max(1, route.distanceMeters / 70)
        : 0.07 +
            (i % 5) * 0.08 +
            previewMinutes / Math.max(1, route.distanceMeters / 70),
    );
    result.push({
      id: household.id,
      kind: 'person',
      label: `${household.id} · 대피 이동`,
      householdId: household.id,
      route,
      fraction,
      position: routePosition(route, fraction),
      passengers: 1 + (status.companions?.length ?? 0),
    });
  }
  for (const trip of view.trips) {
    const route =
      trip.stage === 'depart' || trip.stage === 'arrive'
        ? trip.legs.pickup
        : trip.stage === 'boarded'
          ? trip.legs.shelter
          : trip.legs.returning;
    const position = tripPosition(trip, view.simMinutes + previewMinutes);
    if (!position) continue;
    result.push({
      id: trip.vehicleId,
      kind: 'vehicle',
      label: `${trip.vehicleId} → ${trip.householdId}`,
      householdId: trip.householdId,
      route,
      fraction: 0,
      position,
      tripId: trip.id,
      stage: trip.stage,
      held: Boolean(trip.heldReason),
      ambulance:
        vehicles.find((v) => v.id === trip.vehicleId)?.kind === 'ambulance',
      passengers: trip.passengerCount,
    });
  }
  for (const status of view.scenario.resourceStatuses) {
    if (
      cycle ||
      !['enroute', 'transporting', 'returning'].includes(status.status) ||
      !status.householdId ||
      view.trips.some((t) => t.vehicleId === status.vehicleId)
    )
      continue;
    const vehicle = vehicles.find((v) => v.id === status.vehicleId)!;
    const household = households.find((h) => h.id === status.householdId);
    if (!household) continue;
    const origin =
      teams.find((t) => t.id === vehicle.teamId)?.meetingPoint ?? map.office;
    const shelter = shelters.find(
      (s) => s.id === household.shelterId,
    )!.demoLocation;
    const from =
      status.status === 'enroute'
        ? origin
        : status.status === 'transporting'
          ? household.demoPosition
          : shelter;
    const to =
      status.status === 'enroute'
        ? household.demoPosition
        : status.status === 'transporting'
          ? shelter
          : origin;
    const route = findDemoRoute(map, from, to);
    if (!route) continue;
    const fraction = Math.min(
      0.97,
      0.24 + previewMinutes / Math.max(1, route.distanceMeters / 500),
    );
    result.push({
      id: vehicle.id,
      kind: 'vehicle',
      label: `${vehicle.id} · ${status.status === 'enroute' ? '출동' : status.status === 'transporting' ? '수송' : '복귀'}`,
      householdId: household.id,
      route,
      fraction,
      position: routePosition(route, fraction),
      ambulance: vehicle.kind === 'ambulance',
    });
  }
  return result;
}
