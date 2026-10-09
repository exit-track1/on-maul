import type { Point } from './types.ts';
import type { Trip, View } from './runtime.ts';
import { eta } from './domain.ts';
import { findDemoRoute, routePosition } from './routing.ts';
import { predictionEvidence } from './monitoring.ts';
import type { Household, HouseholdStatus } from './types.ts';
export function transportNeeds(h: Household, s: HouseholdStatus) {
  return [
    ...new Set([
      ...h.devices,
      ...(h.mobility === '와상' ? ['들것'] : []),
      ...(s.companions ?? []).flatMap((c) => [
        ...c.devices,
        ...(c.mobility === '와상' ? ['들것'] : []),
      ]),
    ]),
  ];
}
export function needsAccessibleShelter(h: Household, s: HouseholdStatus) {
  return h.mobility !== '자력' || (s.companions ?? []).some((c) => c.mobility !== '자력');
}

export function dispatchSafety(view: View, householdId: string) {
  const h = view.data.households.find((h) => h.id === householdId);
  if (!h) return { targetEta: null, zoneEta: null, emergency: false };
  if (!predictionEvidence(view).usable)
    return {
      targetEta: null,
      zoneEta: null,
      emergency:
        view.scenario.householdStatuses.find((s) => s.householdId === householdId)?.status ===
        'e119',
    };
  const currentEta = (point: Point) =>
    eta(
      point,
      view.data.map.ignition,
      view.data.map.wind.direction,
      view.data.map.wind.speedMps,
      view.simMinutes,
    );
  const estimates = view.data.households
    .filter(
      (x) =>
        x.zoneId === h.zoneId &&
        !view.scenario.householdStatuses.find((s) => s.householdId === x.id)?.temporaryExclusion,
    )
    .map((x) => currentEta(x.demoPosition));
  const targetEta = currentEta(h.demoPosition),
    zoneEta =
      estimates.length && estimates.every((x) => x !== null)
        ? Math.min(...(estimates as number[]))
        : null;
  return {
    targetEta,
    zoneEta,
    emergency:
      view.scenario.householdStatuses.find((s) => s.householdId === householdId)?.status ===
        'e119' ||
      (targetEta !== null && targetEta < 15) ||
      (zoneEta !== null && zoneEta < 15),
  };
}
type PreparedTrip = Omit<Trip, 'id' | 'stage' | 'heldReason' | 'heldAtSim'>;
type Check = { ok: true; trip: PreparedTrip } | { ok: false; code: string; reason: string };
export function evaluateDispatch(view: View, householdId: string, vehicleId: string): Check {
  const fail = (reason: string, code = 'dispatch_guard'): Check => ({ ok: false, code, reason });
  const h = view.data.households.find((h) => h.id === householdId),
    s = view.scenario.householdStatuses.find((s) => s.householdId === householdId),
    v = view.data.vehicles.find((v) => v.id === vehicleId);
  if (!h || !s || !v) return fail('유효한 가구·차량을 선택하세요.');
  if (!v.availableForTransport) return fail('수송 불가 자원입니다.');
  if (!view.plan?.confirmed || view.networkDown || view.frozen)
    return fail('확정·통신 상태를 확인하세요.');
  if (s.temporaryExclusion || ['safe', 'rescued'].includes(s.status))
    return fail('완료·제외 대상은 배차할 수 없습니다.');
  const safety = dispatchSafety(view, householdId);
  if (safety.targetEta === null || safety.zoneEta === null)
    return fail('구역/대상 ETA 불명·투입 보류', 'unknown_eta');
  if (safety.emergency && v.kind !== 'ambulance')
    return fail('구역/대상 ETA 15분 미만 또는 응급·일반 조 투입 금지', 'unsafe_eta');
  const teamId = v.kind === 'ambulance' ? null : (v.teamId ?? h.teamId);
  if (
    view.trips.some(
      (t) =>
        t.householdId === h.id ||
        t.vehicleId === v.id ||
        t.driverRef === v.driverRef ||
        (teamId && t.teamId === teamId),
    )
  )
    return fail('가구·차량·운전자·조 예약 중복입니다.');
  const seeded = view.scenario.resourceStatuses.find((x) => x.vehicleId === v.id);
  if (seeded && seeded.status !== 'free') return fail('현재 출동/복귀 중 차량입니다.');
  const seedBusy = view.scenario.resourceStatuses.filter((x) =>
    ['enroute', 'transporting', 'returning', 'busy'].includes(x.status),
  );
  if (
    seedBusy.some(
      (x) =>
        x.vehicleId !== v.id &&
        view.data.vehicles.find((other) => other.id === x.vehicleId)?.driverRef === v.driverRef,
    )
  )
    return fail('다른 출동 차량이 같은 운전자를 사용 중입니다.');
  const members = view.data.teams.flatMap((t) => t.members),
    driver = members.find((m) => m.id === v.driverRef);
  const reserved = new Set([
    ...view.trips.flatMap((t) => t.crewMemberIds ?? [t.driverRef]),
    ...seedBusy
      .filter((x) => !view.trips.some((t) => t.vehicleId === x.vehicleId))
      .map((x) => view.data.vehicles.find((v) => v.id === x.vehicleId)!.driverRef),
  ]);
  if (
    !driver?.canDrive ||
    driver.availability !== '가능' ||
    view.memberResponses[driver.id] !== 'ok' ||
    reserved.has(driver.id)
  )
    return fail('가능 응답 운전자가 없습니다.');
  const crewMemberIds = [driver.id];
  if (teamId) {
    const team = view.data.teams.find((t) => t.id === teamId);
    const support = team?.members.find(
      (m) =>
        m.id !== driver.id &&
        m.availability === '가능' &&
        view.memberResponses[m.id] === 'ok' &&
        !reserved.has(m.id),
    );
    if (!support) return fail('일반 조는 확인된 운전자와 지원 인원 최소 2명이 필요합니다.');
    crewMemberIds.push(support.id);
  }
  const companions = s.companions ?? [],
    passengerCount = 1 + companions.length;
  const needs = transportNeeds(h, s);
  if (needs.some((e) => !v.equipment.includes(e)))
    return fail('가구·동반자 필요 장비가 부족합니다.');
  const shelter = view.data.shelters.find((x) => x.id === h.shelterId);
  if (!shelter) return fail('등록된 대피소가 없습니다.');
  if (needsAccessibleShelter(h, s) && shelter.accessibility !== 'confirmed')
    return fail('접근성 확인 대피소가 필요합니다.');
  const admitted = view.shelterAdmissions
    .filter((a) => a.shelterId === shelter.id)
    .reduce((n, a) => n + a.passengerCount, 0);
  const reservedPeople = view.trips
    .filter((t) => t.shelterId === shelter.id && t.stage !== 'shelter')
    .reduce((n, t) => n + t.passengerCount, 0);
  if (v.capacity < passengerCount || admitted + reservedPeople + passengerCount > shelter.capacity)
    return fail('동반자 포함 차량/대피소 정원이 부족합니다.');
  const origin = v.teamId
    ? view.data.teams.find((t) => t.id === v.teamId)!.meetingPoint
    : view.data.map.office;
  const pickup = findDemoRoute(view.data.map, origin, h.demoPosition),
    destination = findDemoRoute(view.data.map, h.demoPosition, shelter.demoLocation),
    returning = findDemoRoute(view.data.map, shelter.demoLocation, origin);
  if (!pickup || !destination || !returning)
    return fail('통제 도로를 제외한 연결 경로가 없습니다.', 'no_route');
  const travelMinutes = (meters: number) => meters / (40000 / 60);
  const departSim = view.simMinutes,
    arriveSim = departSim + travelMinutes(pickup.distanceMeters),
    boardSim =
      arriveSim + (h.mobility === '와상' || companions.some((c) => c.mobility === '와상') ? 6 : 3),
    shelterSim = boardSim + travelMinutes(destination.distanceMeters),
    returnSim = shelterSim + travelMinutes(returning.distanceMeters);
  return {
    ok: true,
    trip: {
      householdId: h.id,
      vehicleId: v.id,
      driverRef: v.driverRef,
      teamId,
      shelterId: shelter.id,
      routeId: [...new Set([...pickup.roadIds, ...destination.roadIds, ...returning.roadIds])].join(
        ' → ',
      ),
      passengerCount,
      crewMemberIds,
      legs: { pickup, shelter: destination, returning },
      departSim,
      arriveSim,
      boardSim,
      shelterSim,
      returnSim,
    },
  };
}
export function tripPosition(trip: Trip, simMinutes: number): Point | null {
  if (!trip.legs) return null;
  const t = trip.heldAtSim ?? simMinutes;
  if (trip.stage === 'depart')
    return routePosition(
      trip.legs.pickup,
      (t - trip.departSim) / Math.max(1e-6, trip.arriveSim - trip.departSim),
    );
  if (trip.stage === 'arrive') return trip.legs.pickup.waypoints.at(-1)!;
  if (trip.stage === 'boarded')
    return routePosition(
      trip.legs.shelter,
      (t - trip.boardSim) / Math.max(1e-6, trip.shelterSim - trip.boardSim),
    );
  return routePosition(
    trip.legs.returning,
    (t - trip.shelterSim) / Math.max(1e-6, trip.returnSim - trip.shelterSim),
  );
}
