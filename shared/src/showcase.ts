import { Runtime, DomainError, type View } from './runtime.ts';
import { DATA } from './data.ts';
import { vulnerability } from './domain.ts';
import { findDemoRoute, routePosition, type DemoRoute } from './routing.ts';
import type { Point, Status } from './types.ts';
import {
  SHOWCASE_CASES,
  shuffled,
  type CallRole,
  type EvacuationMode,
  type ScriptTurn,
  type ShowcaseCase,
} from './showcase-cases.ts';

export interface ReplayCall {
  id: string;
  role: CallRole;
  householdId: string;
  targetId: string;
  targetName: string;
  caseId: string;
  title: string;
  outcome: string;
  phase: 'calling' | 'completed';
  startedAt: number;
  finishedAt?: number;
  turns: (ScriptTurn & { at: number; personName: string })[];
  step: number;
  candidateIds: string[];
}
export interface EvacuationActor {
  householdId: string;
  caseId: string;
  mode: EvacuationMode;
  phase:
    | 'waiting'
    | 'calling'
    | 'requested'
    | 'dispatch-call'
    | 'pickup'
    | 'boarding'
    | 'evacuating'
    | 'arrived'
    | 'returning'
    | 'completed';
  vehicleId?: string;
  rescuerId?: string;
  route?: DemoRoute;
  pickupRoute?: DemoRoute;
  shelterRoute?: DemoRoute;
  returnRoute?: DemoRoute;
  startedAt?: number;
  endsAt?: number;
  moved: boolean;
}
export interface ShowcaseState {
  version: 1;
  loop: number;
  seed: number;
  stage: 'running' | 'completed';
  completedAt: number | null;
  calls: ReplayCall[];
  actors: EvacuationActor[];
  seenCases: string[];
  displayedCases: string[];
  catalog: Pick<ShowcaseCase, 'id' | 'role' | 'title' | 'outcome'>[];
  activeResidentCallId: string | null;
  activeRescuerCallId: string | null;
  selectedResidentCallId: string | null;
  selectedRescuerCallId: string | null;
  autoRepeat: boolean;
}
export interface ShowcaseMotion {
  id: string;
  householdId: string;
  kind: 'person' | 'vehicle';
  label: string;
  position: Point;
  route: DemoRoute;
  fraction: number;
  ambulance?: boolean;
  tripId?: string;
  stage: string;
}
const TURN_MINUTES = 0.55;
const RESIDENT_CASES = SHOWCASE_CASES.filter((c) => c.role === 'resident');
const RESCUER_CASES = SHOWCASE_CASES.filter((c) => c.role === 'rescuer');
const CASES = new Map(SHOWCASE_CASES.map((c) => [c.id, c]));
const MAX_STEP = 0.05;

/** A self-contained simulation. All judgments are scripted, reproducible local rules. */
export class ShowcaseRuntime extends Runtime {
  private residentQueue: string[] = [];
  private rescueDeck: string[] = [];
  private rescueIndex = 0;
  private loop = 1;
  private seed: number;
  private repeatAt: number | null = null;
  private serial = 0;
  constructor(seed = Date.now() >>> 0) {
    super(DATA);
    this.seed = seed >>> 0;
    this.initialize(true);
  }
  private get replay(): ShowcaseState {
    return this.state.showcase!;
  }
  private time() {
    return new Date(
      Date.parse('2026-10-09T11:08:00+09:00') + this.state.simMinutes * 60000,
    ).toISOString();
  }
  private actor(id: string) {
    return this.replay.actors.find((a) => a.householdId === id)!;
  }
  private home(id: string) {
    return this.state.data.households.find((h) => h.id === id)!;
  }
  private replayLog(label: string, householdId?: string) {
    this.state.records.push({
      id: `replay-${this.loop}-${++this.serial}`,
      scenarioId: this.state.scenario.id,
      timestamp: this.time(),
      actorType: 'mock',
      label,
      householdId,
      synthetic: true,
    });
    this.state.records = this.state.records.slice(-180);
  }
  private setActorStatus(id: string, status: Status, note: string) {
    const item = this.state.scenario.householdStatuses.find((h) => h.householdId === id)!;
    Object.assign(item, {
      status,
      note,
      lastChangedAt: this.time(),
      acked: !['queued', 'calling', 'help', 'noanswer', 'refuse'].includes(status),
      visitCompleted: status === 'rescued' || status === 'safe',
      temporaryExclusion: null,
      dispatchHold: null,
    });
  }
  private initialize(playing: boolean) {
    const revision = this.state.revision + 1;
    const speed = this.state.simulation.speed;
    const repeat = this.state.showcase?.autoRepeat ?? true;
    this.state = new Runtime(DATA).view();
    const scenario = structuredClone(this.state.data.scenarios.find((s) => s.id === 'review')!);
    scenario.id = `showcase-${this.loop}-${this.seed}`;
    scenario.label = '전체 마을 자동 반복 시뮬레이션';
    this.state.scenario = scenario;
    // The original four northern homes are cut off by ROAD1. Add an explicit
    // synthetic access road around its eastern end, never cross the closed road.
    this.state.data.map.roads.push({
      id: 'DEMO-NORTH-BYPASS',
      label: '북구역 모의 우회도로',
      blocked: false,
      points: [
        [430, 100],
        [900, 100],
        [1050, 240],
        [1030, 360],
      ],
    });
    this.state.revision = revision;
    this.state.records = [];
    this.state.simMinutes = 0;
    this.repeatAt = null;
    this.serial = 0;
    this.state.simulation = {
      ...this.state.simulation,
      cycleId: scenario.id,
      phase: 'running',
      playing,
      speed,
      durationMinutes: 0,
    };
    this.home('H012').name = '반영환 할아버지';
    this.home('H009').name = '박미숙 할머니';
    this.state.data.teams.flatMap((t) => t.members).find((m) => m.id === 'M01')!.name =
      '반영환 대원';
    // Every fixture participates in this synthetic exhibition, including visit-only households.
    for (const h of this.state.data.households) {
      h.callEligible = true;
      h.exclusionReason = null;
    }
    const deck = shuffled(
      RESIDENT_CASES.map((c) => c.id),
      this.seed + this.loop,
    );
    const others = shuffled(
      this.state.data.households.filter((h) => !['H012', 'H009'].includes(h.id)),
      this.seed + this.loop * 13,
    ).sort((a, b) => vulnerability(b) - vulnerability(a));
    const order = [this.home('H012'), this.home('H009'), ...others];
    this.state.showcase = {
      version: 1,
      loop: this.loop,
      seed: this.seed,
      stage: 'running',
      completedAt: null,
      calls: [],
      actors: order.map((h, i) => ({
        householdId: h.id,
        caseId: i === 0 ? 'immobile' : i === 1 ? 'need-car' : deck[(i - 2) % deck.length],
        mode:
          i === 0 ? 'ambulance' : i === 1 ? 'team' : CASES.get(deck[(i - 2) % deck.length])!.mode,
        phase: i === 1 ? 'requested' : 'waiting',
        moved: false,
      })),
      seenCases: [],
      displayedCases: [],
      catalog: SHOWCASE_CASES.map(({ id, role, title, outcome }) => ({ id, role, title, outcome })),
      activeResidentCallId: null,
      activeRescuerCallId: null,
      selectedResidentCallId: null,
      selectedRescuerCallId: null,
      autoRepeat: repeat,
    };
    this.residentQueue = order.filter((h) => h.id !== 'H009').map((h) => h.id);
    this.rescueDeck = [
      'ready',
      ...shuffled(
        RESCUER_CASES.filter((c) => c.id !== 'ready').map((c) => c.id),
        this.seed + this.loop * 29,
      ),
    ];
    this.rescueIndex = 0;
    for (const h of order)
      this.setActorStatus(
        h.id,
        h.id === 'H009' ? 'help' : 'queued',
        h.id === 'H009'
          ? '모의 가정: 구조 요청 접수 · 대원 통화 대기'
          : '대피 우선순위에 따른 모의 전화 대기',
      );
    this.replayLog(`산불 발생 · ${this.loop}회차 · 48가구 대피 시작`);
    this.replayLog('박미숙 할머니 구조 요청 접수 · 반영환 대원에게 출동 확인', 'H009');
    if (playing) this.startCalls();
  }
  private replaceText(text: string, id: string) {
    const h = this.home(id);
    const shelter = this.state.data.shelters.find((s) => s.id === h.shelterId)!;
    return text
      .replaceAll('{name}', h.name)
      .replaceAll('{address}', h.addressLabel)
      .replaceAll('{shelter}', shelter.name);
  }
  private makeCall(
    role: CallRole,
    actor: EvacuationActor,
    script: ShowcaseCase,
    memberId?: string,
  ): ReplayCall {
    const member = this.state.data.teams.flatMap((t) => t.members).find((m) => m.id === memberId);
    const call: ReplayCall = {
      id: `call-${this.loop}-${++this.serial}`,
      role,
      householdId: actor.householdId,
      targetId: member?.id ?? actor.householdId,
      targetName: member?.name ?? this.home(actor.householdId).name,
      caseId: script.id,
      title: script.title,
      outcome: script.outcome,
      phase: 'calling',
      startedAt: this.state.simMinutes,
      turns: [],
      step: 0,
      candidateIds: member ? [member.id] : [],
    };
    this.replay.calls.push(call);
    this.replay.calls = this.replay.calls.slice(-100);
    if (role === 'resident') {
      this.replay.activeResidentCallId = call.id;
      if (script.id === 'arrival') {
        this.beginSelfEvacuation(actor);
        const elapsed = (actor.endsAt! - actor.startedAt!) * 0.65;
        actor.startedAt! -= elapsed;
        actor.endsAt! -= elapsed;
      } else {
        actor.phase = 'calling';
        this.setActorStatus(actor.householdId, 'calling', script.title);
      }
    } else {
      this.replay.activeRescuerCallId = call.id;
      actor.phase = 'dispatch-call';
    }
    this.replayLog(
      `${role === 'resident' ? '주민' : '구조대원'} 모의 통화 · ${call.targetName} · ${script.title}`,
      actor.householdId,
    );
    this.emitTurn(call);
    return call;
  }
  private freeMember(excluded: string[] = []) {
    const occupied = new Set(
      this.replay.actors
        .filter((a) => a.rescuerId && a.phase !== 'completed')
        .map((a) => a.rescuerId),
    );
    return this.state.data.teams
      .flatMap((t) => t.members)
      .find((m) => m.canDrive && !occupied.has(m.id) && !excluded.includes(m.id));
  }
  private freeVehicle(mode: EvacuationMode) {
    const occupied = new Set(
      this.replay.actors
        .filter((a) => a.vehicleId && a.phase !== 'completed')
        .map((a) => a.vehicleId),
    );
    return this.state.data.vehicles.find(
      (v) =>
        v.availableForTransport &&
        !occupied.has(v.id) &&
        (mode === 'ambulance' ? v.kind === 'ambulance' : v.kind !== 'ambulance'),
    );
  }
  private startCalls() {
    if (!this.replay.activeResidentCallId && this.residentQueue.length) {
      const actor = this.actor(this.residentQueue.shift()!);
      this.makeCall('resident', actor, CASES.get(actor.caseId)!);
    }
    if (this.replay.activeRescuerCallId) return;
    const script = CASES.get(this.rescueDeck[this.rescueIndex % this.rescueDeck.length])!;
    for (const actor of this.replay.actors.filter((a) => a.phase === 'requested')) {
      const effectiveMode =
        actor.mode === 'ambulance' || script.mode === 'ambulance' ? 'ambulance' : actor.mode;
      const vehicle = this.freeVehicle(effectiveMode);
      const member =
        actor.householdId === 'H009' && this.rescueIndex === 0
          ? this.state.data.teams.flatMap((t) => t.members).find((m) => m.id === 'M01')
          : this.freeMember();
      if (!vehicle || !member) continue;
      if (script.turns.some((turn) => turn.node === '후보 탐색 ↻') && !this.freeMember([member.id]))
        continue;
      actor.mode = effectiveMode;
      actor.vehicleId = vehicle.id;
      actor.rescuerId = member.id;
      if (
        actor.mode === 'ambulance' ||
        this.home(actor.householdId).devices.includes('휠체어') ||
        script.id === 'shelter'
      )
        this.home(actor.householdId).shelterId = 'S2';
      this.rescueIndex++;
      this.makeCall('rescuer', actor, script, member.id);
      break;
    }
  }
  private emitTurn(call: ReplayCall) {
    const script = CASES.get(call.caseId)!;
    const item = script.turns[call.step++];
    if (!item) return;
    const actor = this.actor(call.householdId);
    // A rejection actually releases the original candidate and assigns a different member.
    if (call.role === 'rescuer' && item.node === '후보 탐색 ↻') {
      actor.rescuerId = undefined;
      const next = this.freeMember(call.candidateIds);
      if (!next) throw new Error('모의 재배정 후보가 없습니다.');
      call.candidateIds.push(next.id);
      actor.rescuerId = next.id;
      call.targetId = next.id;
      call.targetName = next.name;
    }
    call.turns.push({
      ...item,
      text: this.replaceText(item.text, call.householdId),
      at: this.state.simMinutes,
      personName: call.targetName,
    });
    if (call.role === 'resident') {
      if (item.node === '이장 연결')
        this.setActorStatus(call.householdId, 'refuse', '이장 설득 연결 중');
      if (item.node === '무응답')
        this.setActorStatus(call.householdId, 'noanswer', '모의 무응답 · 재발신 대기');
      if (item.node === '응급 판단')
        this.setActorStatus(call.householdId, 'e119', '모의 응급 지원 요청');
      if (item.node.includes('재질문'))
        this.setActorStatus(call.householdId, 'unclear', '응답 재확인 중');
    }
    this.replayLog(
      `${item.node} · ${this.replaceText(item.text, call.householdId)}`,
      call.householdId,
    );
  }
  private finishCall(call: ReplayCall) {
    call.phase = 'completed';
    call.finishedAt = this.state.simMinutes;
    if (!this.replay.seenCases.includes(call.caseId)) this.replay.seenCases.push(call.caseId);
    const actor = this.actor(call.householdId);
    if (call.role === 'resident') {
      this.replay.activeResidentCallId = null;
      if (call.caseId === 'arrival') {
        if (actor.phase === 'arrived') this.completeEvacuation(actor);
      } else if (actor.mode === 'walk' || actor.mode === 'car') this.beginSelfEvacuation(actor);
      else {
        actor.phase = 'requested';
        this.setActorStatus(actor.householdId, 'help', '모의 구조·수송 요청 · 출동 확인 대기');
      }
    } else {
      this.replay.activeRescuerCallId = null;
      this.beginPickup(actor);
    }
    this.replayLog(`통화 종료 · ${call.outcome}`, actor.householdId);
  }
  private route(from: Point, to: Point) {
    const route = findDemoRoute(this.state.data.map, from, to);
    if (!route) throw new Error('열린 도로에서 모의 이동 경로를 찾을 수 없습니다.');
    return route;
  }
  private beginSelfEvacuation(actor: EvacuationActor) {
    const h = this.home(actor.householdId);
    const shelter = this.state.data.shelters.find((s) => s.id === h.shelterId)!;
    actor.route = this.route(h.demoPosition, shelter.demoLocation);
    actor.phase = 'evacuating';
    actor.startedAt = this.state.simMinutes;
    actor.endsAt =
      this.state.simMinutes +
      Math.max(2.5, actor.route.distanceMeters / (actor.mode === 'car' ? 420 : 160));
    actor.moved = true;
    this.setActorStatus(
      h.id,
      'moving',
      actor.mode === 'car' ? '모의 자가 차량 대피 중' : '모의 도보 대피 중',
    );
  }
  private beginPickup(actor: EvacuationActor) {
    const h = this.home(actor.householdId);
    const origin = this.state.data.map.office;
    const shelter = this.state.data.shelters.find((s) => s.id === h.shelterId)!;
    actor.pickupRoute = this.route(origin, h.demoPosition);
    actor.shelterRoute = this.route(h.demoPosition, shelter.demoLocation);
    actor.returnRoute = this.route(shelter.demoLocation, origin);
    actor.route = actor.pickupRoute;
    actor.phase = 'pickup';
    actor.startedAt = this.state.simMinutes;
    actor.endsAt = this.state.simMinutes + Math.max(1.2, actor.route.distanceMeters / 500);
    this.setActorStatus(
      h.id,
      'dispatched',
      `모의 ${actor.mode === 'ambulance' ? '구급차' : '대기조'} 출동 · ${actor.vehicleId}`,
    );
    this.replayLog(`${actor.vehicleId} 출동 → ${h.name} 집`, h.id);
  }
  private advanceActors() {
    for (const actor of this.replay.actors) {
      if (actor.endsAt === undefined || this.state.simMinutes + 1e-8 < actor.endsAt) continue;
      const h = this.home(actor.householdId);
      if (actor.phase === 'pickup') {
        actor.phase = 'boarding';
        actor.startedAt = this.state.simMinutes;
        actor.endsAt = this.state.simMinutes + 0.8;
        this.replayLog(`${h.name} 집 도착 · 탑승 지원 중`, h.id);
      } else if (actor.phase === 'boarding') {
        actor.phase = 'evacuating';
        actor.route = actor.shelterRoute;
        actor.startedAt = this.state.simMinutes;
        actor.endsAt = this.state.simMinutes + Math.max(2, actor.route!.distanceMeters / 450);
        actor.moved = true;
        this.setActorStatus(
          h.id,
          'moving',
          `모의 구조 탑승 완료 · ${actor.vehicleId} 대피소 수송 중`,
        );
        this.replayLog(
          `탑승 완료 → ${this.state.data.shelters.find((s) => s.id === h.shelterId)!.name} 이동`,
          h.id,
        );
      } else if (actor.phase === 'evacuating') {
        if (
          this.replay.calls.some(
            (call) =>
              call.householdId === h.id && call.role === 'resident' && call.phase === 'calling',
          )
        ) {
          actor.phase = 'arrived';
          actor.endsAt = undefined;
          this.setActorStatus(h.id, 'guided', '모의 대피소 도착 · 입소 확인 통화 중');
        } else this.completeEvacuation(actor);
      } else if (actor.phase === 'returning') {
        actor.phase = 'completed';
        actor.endsAt = undefined;
        this.replayLog(
          `${actor.vehicleId} · ${actor.rescuerId} 구조 완료·복귀 · 다음 임무 대기`,
          h.id,
        );
      }
    }
  }
  private completeEvacuation(actor: EvacuationActor) {
    const h = this.home(actor.householdId);
    this.setActorStatus(h.id, actor.vehicleId ? 'rescued' : 'safe', '모의 대피소 도착 · 대피 완료');
    this.state.shelterAdmissions.push({
      householdId: h.id,
      shelterId: h.shelterId,
      passengerCount: 1,
      tripId: actor.vehicleId ? `mock-${this.loop}-${h.id}` : null,
    });
    this.replayLog(`${h.name} 대피 완료`, h.id);
    if (actor.vehicleId) {
      actor.phase = 'returning';
      actor.route = actor.returnRoute;
      actor.startedAt = this.state.simMinutes;
      actor.endsAt = this.state.simMinutes + Math.max(1, actor.route!.distanceMeters / 500);
    } else {
      actor.phase = 'completed';
      actor.endsAt = undefined;
    }
  }
  override tickCycle(deltaMinutes: number): View {
    if (!Number.isFinite(deltaMinutes) || deltaMinutes < 0 || deltaMinutes > 1000)
      throw new DomainError('invalid_delta', '유효한 재생 시간을 입력해 주세요.', 400);
    if (!this.state.simulation.playing || deltaMinutes === 0) return this.view();
    let remaining = deltaMinutes;
    while (remaining > 1e-8) {
      const delta = Math.min(MAX_STEP, remaining);
      remaining -= delta;
      this.state.simMinutes = Math.round((this.state.simMinutes + delta) * 1e8) / 1e8;
      for (const call of this.replay.calls.filter((c) => c.phase === 'calling')) {
        const nextAt = call.startedAt + call.step * TURN_MINUTES;
        if (this.state.simMinutes + 1e-8 < nextAt) continue;
        if (call.step < CASES.get(call.caseId)!.turns.length) this.emitTurn(call);
        else this.finishCall(call);
      }
      this.advanceActors();
      this.startCalls();
      if (
        this.replay.stage === 'running' &&
        this.replay.actors.every((a) => a.phase === 'completed')
      ) {
        if (this.replay.seenCases.length !== SHOWCASE_CASES.length)
          throw new Error('사례 누락 없이 반복해야 합니다.');
        this.replay.stage = 'completed';
        this.replay.completedAt = this.state.simMinutes;
        this.repeatAt = this.state.simMinutes + 6;
        this.state.simulation.durationMinutes = this.state.simMinutes;
        if (!this.replay.autoRepeat) this.state.simulation.playing = false;
        this.replayLog(`48가구 대피 완료 · ${SHOWCASE_CASES.length}개 사례 완료 · 다음 회차 준비`);
      }
      if (
        this.repeatAt !== null &&
        this.state.simMinutes >= this.repeatAt &&
        this.replay.autoRepeat
      ) {
        this.loop++;
        this.initialize(true);
      }
      if (!this.state.simulation.playing) break;
    }
    this.state.revision++;
    return this.view();
  }
  override command(action: string, input: Record<string, unknown> = {}): View {
    if (action === 'sim' || action === 'showcase-play') {
      if (input.speed !== undefined) {
        if (![12, 30, 60].includes(Number(input.speed)))
          throw new DomainError('invalid_speed', '재생 속도는 12, 30, 60 중에서 선택하세요.', 400);
        this.state.simulation.speed = Number(input.speed) as 12 | 30 | 60;
      }
      if (typeof input.playing === 'boolean') this.state.simulation.playing = input.playing;
      if (typeof input.autoRepeat === 'boolean') this.replay.autoRepeat = input.autoRepeat;
      if (this.state.simulation.playing) this.startCalls();
    } else if (action === 'demo-reset' || action === 'showcase-restart') {
      this.loop = 1;
      this.seed = (this.seed + 1) >>> 0;
      this.initialize(action === 'showcase-restart');
    } else if (action === 'showcase-focus') {
      const call = this.replay.calls.find((c) => c.id === input.callId);
      if (input.role !== 'resident' && input.role !== 'rescuer')
        throw new DomainError('invalid_role', '통화 역할을 확인하세요.', 400);
      if (input.callId !== null && (!call || call.role !== input.role))
        throw new DomainError('invalid_call', '통화 내역을 찾을 수 없습니다.', 400);
      if (input.role === 'resident')
        this.replay.selectedResidentCallId = input.callId as string | null;
      else this.replay.selectedRescuerCallId = input.callId as string | null;
    } else if (action === 'showcase-seen') {
      const call = this.replay.calls.find((c) => c.id === input.callId);
      if (!call) throw new DomainError('invalid_call', '통화 내역을 찾을 수 없습니다.', 400);
      if (!this.replay.displayedCases.includes(call.caseId))
        this.replay.displayedCases.push(call.caseId);
    } else throw new DomainError('simulation_only', '이 화면은 로컬 모의 재생만 제공합니다.', 400);
    this.state.revision++;
    return this.view();
  }
  override view(): View {
    this.state.scenario.displayTime = this.time();
    this.state.scenario.resourceStatuses = this.state.data.vehicles.map((v) => {
      const actor = this.replay.actors.find((a) => a.vehicleId === v.id && a.phase !== 'completed');
      return {
        vehicleId: v.id,
        status: !actor
          ? 'available'
          : actor.phase === 'returning'
            ? 'returning'
            : actor.phase === 'evacuating'
              ? 'transporting'
              : actor.phase === 'pickup' || actor.phase === 'boarding'
                ? 'enroute'
                : 'reserved',
        householdId: actor?.householdId ?? null,
      };
    });
    return super.view();
  }
}

/** Shared by server and UI: interpolation may never advance a pickup/boarding state. */
export function showcaseMotions(view: View, preview = 0): ShowcaseMotion[] {
  if (!view.showcase) return [];
  const time =
    view.simMinutes + (view.simulation.playing ? Math.max(0, Math.min(preview, 0.25)) : 0);
  return view.showcase.actors.flatMap((actor) => {
    if (!actor.route || !['pickup', 'boarding', 'evacuating', 'returning'].includes(actor.phase))
      return [];
    const duration = Math.max(0.001, (actor.endsAt ?? time) - (actor.startedAt ?? time));
    const fraction =
      actor.phase === 'boarding'
        ? 1
        : Math.max(0, Math.min(1, (time - (actor.startedAt ?? time)) / duration));
    return [
      {
        id:
          actor.vehicleId ??
          (actor.mode === 'car' ? `자가-${actor.householdId}` : actor.householdId),
        householdId: actor.householdId,
        kind: actor.vehicleId || actor.mode === 'car' ? ('vehicle' as const) : ('person' as const),
        label: `${actor.householdId} · ${actor.phase === 'returning' ? '구조 완료·복귀' : actor.phase === 'pickup' ? '구조 출동' : actor.phase === 'boarding' ? '탑승 지원' : '대피 이동'}`,
        route: actor.route,
        fraction,
        position: routePosition(actor.route, fraction),
        ambulance: actor.mode === 'ambulance',
        tripId: actor.vehicleId ? `mock-${view.showcase!.loop}-${actor.householdId}` : undefined,
        stage: actor.phase,
      },
    ];
  });
}
