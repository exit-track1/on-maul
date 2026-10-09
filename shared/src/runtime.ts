import { DATA } from './data.ts';
import { classify, type Classification } from './classification.ts';
import { eta, groupOf, handover, orderedHouseholds, tally, vulnerability } from './domain.ts';
import type { Fixtures, HouseholdStatus, Scenario, RecordItem } from './types.ts';
import {
  evaluateDispatch,
  dispatchSafety,
  transportNeeds,
  needsAccessibleShelter,
} from './dispatch.ts';
import { routeIsOpen, type DemoRoute } from './routing.ts';
import {
  createSourceState,
  DEMO_DATASET,
  DEMO_JURISDICTION,
  predictionEvidence,
  sourceReadings,
  type SourceState,
} from './monitoring.ts';
import {
  appendSourceAttempt,
  canonicalJson,
  createReplaySourceRecord,
  createSourceRecord,
} from './sources.ts';
import { parseHouseholdNotes } from './household-notes.ts';
import { cycleBudget, cycleTime, initialSimulation, type Simulation } from './cycle.ts';
import {
  configureDemoStory,
  type Demonstration,
  type DemoStory,
  type DemoPhoneMode,
} from './demo-story.ts';
export type PlanItem = ReturnType<typeof orderedHouseholds>[number];
export interface Plan {
  id: string;
  revision: number;
  snapshotRevision: number;
  order: PlanItem[];
  visit: PlanItem[];
  excluded: string[];
  confirmed: boolean;
  confirmedAt: string | null;
  /** Material wind evidence; collection IDs and fetch times do not change a reviewed proposal. */
  sourceSignature?: string;
}
export function planReviewSignature(plan: Plan): string {
  return canonicalJson({
    id: plan.id,
    revision: plan.revision,
    snapshotRevision: plan.snapshotRevision,
    order: plan.order,
    visit: plan.visit,
    excluded: plan.excluded,
    sourceSignature: plan.sourceSignature ?? null,
  });
}
export interface Call {
  id: string;
  targetId: string;
  targetType: 'resident' | 'member';
  attempt: number;
  phase: 'queued' | 'calling' | 'finished' | 'pendingunknown';
  providerId: string | null;
  nextAt: number | null;
  text: string;
  mode: 'mock' | 'telnyx';
  startedOrder?: number;
  purpose?: 'initial' | 'redial' | 'clarification' | 'arrival_check';
  retryCount?: number;
  startedSim?: number;
  finishedSim?: number;
  outcome?: 'answered' | 'noanswer' | 'unavailable' | 'pendingunknown' | 'excluded' | 'replaced';
  mockOutcome?: 'noanswer';
  /** Applied only after the phone adapter has independently confirmed termination. */
  phoneOutcome?: PhoneRuntimeOutcome;
  phoneNotDialed?: boolean;
  phoneConnected?: boolean;
}
export interface PhoneRuntimeUpdate {
  phase: 'dialing' | 'talking' | 'pendingunknown';
  providerId?: string | null;
}
export interface PhoneRuntimeOutcome {
  ended: true;
  kind: 'resident' | 'standby';
  mobility?: 'needs_help' | 'possible' | 'refusal' | 'unknown';
  standbyAvailable?: boolean;
  emergency?: boolean;
  evidence?: string;
}
export interface FirstPass {
  completedAt: string;
  completedAtSim: number;
  targets: { householdId: string; callId: string; outcome: string }[];
  simulatedDurationMinutes: number;
  liveDurationSeconds: null;
}
export interface Trip {
  id: string;
  householdId: string;
  vehicleId: string;
  driverRef: string;
  teamId: string | null;
  shelterId: string;
  stage: 'depart' | 'arrive' | 'boarded' | 'shelter' | 'return';
  routeId: string;
  passengerCount: number;
  crewMemberIds: string[];
  legs: { pickup: DemoRoute; shelter: DemoRoute; returning: DemoRoute };
  departSim: number;
  arriveSim: number;
  boardSim: number;
  shelterSim: number;
  returnSim: number;
  heldReason: string | null;
  heldAtSim: number | null;
}
export interface Reassignment {
  id: string;
  householdId: string;
  fromTeamId: string;
  snapshotRevision: number;
  status: 'pending' | 'approved' | 'rejected';
  candidates: { vehicleId: string | null; teamId: string | null; reason: string }[];
  selectedVehicleId?: string | null;
}
export interface Handoff {
  id: string;
  householdId: string;
  status: 'local' | 'mockRecorded' | 'failed' | 'pendingunknown';
  receiptId: string | null;
  reason: string;
}
export interface GraphRun {
  id: string;
  nodes: string[];
  executionMode: string;
  householdId?: string;
  waiting: boolean;
  reason: string;
  planId?: string;
  planRevision?: number;
  planSignature?: string;
  supersededBy?: string;
}
export interface View {
  data: Fixtures;
  scenario: Scenario;
  revision: number;
  plan: Plan | null;
  networkDown: boolean;
  calls: Call[];
  trips: Trip[];
  completedTrips: Trip[];
  shelterAdmissions: {
    householdId: string;
    shelterId: string;
    passengerCount: number;
    tripId: string | null;
  }[];
  reassignments: Reassignment[];
  handoffs: Handoff[];
  records: RecordItem[];
  graphRuns: GraphRun[];
  frozen: boolean;
  assistantAnswer: string;
  simMinutes: number;
  memberResponses: Record<string, 'waiting' | 'ok' | 'no'>;
  leaderRequested: string[];
  firstPass: FirstPass | null;
  sourceState: SourceState;
  simulation: Simulation;
  demonstration: Demonstration | null;
}
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
function requireThat(value: unknown, message: string, code = 'guard'): asserts value {
  if (!value) throw new DomainError(code, message);
}
export class Runtime {
  protected state: View;
  private seen = new Set<string>();
  private turn: 'resident' | 'member' = 'resident';
  private startedSequence = 0;
  private cycleRemainder = 0;
  private cycleBaseTime: number | null = null;
  private cycleObservationMinute = 0;
  private cycleLeaderDue = new Map<string, number>();
  constructor(data = DATA) {
    this.state = this.initial(data, 'idle');
  }
  private initial(data: Fixtures, id: string): View {
    const copy = structuredClone(data),
      scenario = structuredClone(copy.scenarios.find((s) => s.id === id) ?? copy.scenarios[0]);
    return {
      data: copy,
      scenario,
      revision: 1,
      plan: null,
      networkDown: false,
      calls: [],
      trips: [],
      completedTrips: [],
      shelterAdmissions: scenario.householdStatuses
        .filter((s) => ['safe', 'rescued'].includes(s.status))
        .map((s) => ({
          householdId: s.householdId,
          shelterId: copy.households.find((h) => h.id === s.householdId)!.shelterId,
          passengerCount: 1,
          tripId: null,
        })),
      reassignments: [],
      handoffs: scenario.householdStatuses
        .filter((s) => s.status === 'e119')
        .map((s) => ({
          id: `seed-${s.householdId}`,
          householdId: s.householdId,
          status: 'mockRecorded',
          receiptId: `DEMO-RECEIPT-${s.householdId}`,
          reason: s.note,
        })),
      records: copy.eventLogs.filter((l) => l.scenarioId === scenario.id),
      graphRuns: [],
      frozen: false,
      assistantAnswer: '',
      simMinutes: ['active', 'late'].includes(scenario.id)
        ? Math.max(
            0,
            (Date.parse(scenario.displayTime) -
              Date.parse(copy.scenarios.find((s) => s.id === 'review')!.displayTime)) /
              60000,
          )
        : 0,
      memberResponses: Object.fromEntries(
        copy.teams.flatMap((t) =>
          t.members.map((m) => [
            m.id,
            ['active', 'late'].includes(scenario.id)
              ? m.availability === '가능'
                ? 'ok'
                : 'no'
              : 'waiting',
          ]),
        ),
      ),
      leaderRequested: [],
      firstPass: null,
      sourceState: createSourceState(copy, scenario, new Date().toISOString()),
      simulation: initialSimulation(),
      demonstration: null,
    };
  }
  view(): View {
    this.state.scenario.counts = tally(
      this.state.data.households,
      this.state.scenario.householdStatuses,
    );
    if (this.state.demonstration)
      this.state.demonstration.phoneClockHeld = this.awaitingPhoneResults();
    return structuredClone(this.state);
  }
  restore(view: View) {
    requireThat(
      view.data.metadata.synthetic === true &&
        view.data.households.length === 48 &&
        view.scenario.householdStatuses.length === 48,
      '복구 스냅샷 형식 오류',
    );
    requireThat(
      view.data.households.every((h) => DATA.households.some((x) => x.id === h.id)),
      '복구 가구 ID 오류',
    );
    const knownTargets = new Set([
      ...DATA.households.map((h) => h.id),
      ...DATA.teams.flatMap((t) => t.members.map((m) => m.id)),
    ]);
    requireThat(
      view.calls.every((c) => knownTargets.has(c.targetId) && typeof c.id === 'string'),
      '복구 통화 ID 오류',
    );
    this.state = structuredClone(view);
    this.state.completedTrips ??= [];
    this.state.reassignments ??= [];
    this.state.shelterAdmissions ??= view.scenario.householdStatuses
      .filter((s) => ['safe', 'rescued'].includes(s.status))
      .map((s) => ({
        householdId: s.householdId,
        shelterId: view.data.households.find((h) => h.id === s.householdId)!.shelterId,
        passengerCount: 1,
        tripId: null,
      }));
    this.state.firstPass ??= null;
    this.state.simulation ??= initialSimulation();
    this.state.demonstration ??= null;
    if (this.state.demonstration) this.state.demonstration.phoneMode ??= 'mock';
    this.cycleRemainder = 0;
    this.cycleObservationMinute = Math.floor(this.state.simMinutes);
    this.cycleBaseTime = this.state.simulation.cycleId
      ? Date.parse(this.state.scenario.displayTime) - this.state.simMinutes * 60000
      : null;
    this.cycleLeaderDue.clear();
    if (this.state.simulation.cycleId)
      for (const status of this.state.scenario.householdStatuses.filter(
        (status) =>
          status.status === 'visiting' &&
          status.note === '합성 cycle 이장 연결 중·1분 뒤 허구 연락 결과·실제 연락 없음',
      )) {
        // Journal order is authoritative when connection and human cancellation share a timestamp.
        const connection = this.state.records.findLast(
          (record) =>
            record.householdId === status.householdId &&
            (record.label.startsWith('합성 cycle 이장 연결 시작') ||
              record.label.startsWith('합성 cycle 이장 허구 연락 완료') ||
              (record.actorType === 'human' && record.label.startsWith('이장 결과·'))),
        );
        if (
          connection?.label.startsWith('합성 cycle 이장 연결 시작') &&
          this.cycleBaseTime !== null
        )
          this.cycleLeaderDue.set(
            status.householdId,
            cycleTime((Date.parse(connection.timestamp) - this.cycleBaseTime) / 60000 + 1),
          );
      }
    this.state.sourceState ??= createSourceState(
      this.state.data,
      this.state.scenario,
      new Date().toISOString(),
    );
    // A closed report is immutable, including across process restart.
    if (this.state.frozen) return;
    this.state.simulation.playing = false;
    for (const t of this.state.trips)
      if (!t.legs) {
        t.heldReason = '이전 스냅샷의 경로 미검증·담당자 확인 필요';
        t.heldAtSim = this.state.simMinutes;
      }
    this.state.networkDown = true;
    for (const c of this.state.calls)
      if (c.mode === 'telnyx' && c.phase !== 'finished') {
        c.phase = 'pendingunknown';
        if (c.targetType === 'resident') {
          const s = this.status(c.targetId);
          if (!['e119', 'safe', 'rescued'].includes(s.status)) {
            s.status = 'pendingunknown';
            s.note = '서버 재시작·기존 요청/세션 확인 필요·자동 재발신 없음';
          }
        }
      }
    for (const g of this.state.graphRuns)
      if (g.waiting) {
        g.waiting = false;
        g.reason += ' · 재시작 전 checkpoint 보관 기록·새 검토 필요';
      }
    this.refreshUnconfirmedPlan();
    this.state.revision++;
    if (!this.state.frozen) this.log('서버 스냅샷 복구·기존 통화 불명 유지·통신 재조정 대기');
  }
  protected log(label: string, actorType = 'system', householdId?: string) {
    this.state.records.push({
      id: `R-${this.state.records.length + 1}-${this.state.revision}`,
      scenarioId: this.state.scenario.id,
      timestamp: this.state.scenario.displayTime,
      actorType,
      label,
      householdId,
      synthetic: true,
    });
  }
  private status(id: string) {
    const s = this.state.scenario.householdStatuses.find((s) => s.householdId === id);
    requireThat(s, '가구가 없습니다.', 'not_found');
    return s;
  }
  private household(id: string) {
    const h = this.state.data.households.find((h) => h.id === id);
    requireThat(h, '가구가 없습니다.', 'not_found');
    return h;
  }
  protected open() {
    requireThat(!this.state.frozen, '종료 스냅샷입니다. 새 시나리오를 선택하세요.', 'frozen');
  }
  protected requireRevision(revision: unknown) {
    requireThat(
      revision === this.state.revision,
      '상태가 변경되었습니다. 최신 화면에서 다시 검토하세요.',
      'stale_revision',
    );
  }
  protected bump() {
    this.state.revision++;
    this.state.scenario.counts = tally(
      this.state.data.households,
      this.state.scenario.householdStatuses,
    );
  }
  addGraph(run: GraphRun) {
    this.open();
    const index = this.state.graphRuns.findIndex((x) => x.id === run.id);
    if (index >= 0) this.state.graphRuns[index] = { ...this.state.graphRuns[index], ...run };
    else this.state.graphRuns.push(run);
  }
  private isLivePhoneTarget(id: string) {
    const demonstration = this.state.demonstration;
    return (
      demonstration?.phoneMode === 'live' &&
      ((demonstration.story === 'grandfather' && id === demonstration.residentId) ||
        (demonstration.story === 'squad' && id === demonstration.memberId))
    );
  }
  private isLiveStoryTarget(id: string) {
    const demonstration = this.state.demonstration;
    return (
      demonstration?.phoneMode === 'live' &&
      (id === demonstration.residentId ||
        (demonstration.story === 'squad' && id === demonstration.memberId))
    );
  }
  private latestPhoneCall(id: string) {
    return this.state.calls.findLast((call) => call.targetId === id && call.mode === 'telnyx');
  }
  private phoneRescueReady(id: string) {
    const call = this.latestPhoneCall(id);
    return (
      call?.phase === 'finished' &&
      call.phoneOutcome?.kind === 'resident' &&
      call.phoneOutcome.mobility === 'needs_help' &&
      call.phoneOutcome.emergency !== true
    );
  }
  private phoneDispatchReady(id: string) {
    const demonstration = this.state.demonstration;
    if (demonstration?.story !== 'squad' || demonstration.residentId !== id)
      return this.phoneRescueReady(id);
    if (!demonstration.residentRequestAssumed) return false;
    const memberCall = demonstration.memberId ? this.latestPhoneCall(demonstration.memberId) : null;
    return (
      memberCall?.phase === 'finished' &&
      memberCall.phoneOutcome?.kind === 'standby' &&
      memberCall.phoneOutcome.standbyAvailable === true
    );
  }
  /** The adapter starts these targets once the officer has confirmed and enabled playback. */
  pendingPhoneTargets(): string[] {
    const demonstration = this.state.demonstration;
    if (demonstration?.phoneMode !== 'live' || !this.state.plan?.confirmed || this.state.frozen)
      return [];
    const targetId =
      demonstration.story === 'squad' ? demonstration.memberId : demonstration.residentId;
    return targetId && !this.latestPhoneCall(targetId) ? [targetId] : [];
  }
  private awaitingPhoneResults() {
    const demonstration = this.state.demonstration;
    if (demonstration?.phoneMode !== 'live' || !this.state.plan?.confirmed) return false;
    // Holding the clock preserves the selected playing/speed values. A human pause is
    // therefore still respected when the adapter eventually delivers the outcome.
    if (this.pendingPhoneTargets().length) return true;
    return this.state.calls.some(
      (call) =>
        call.mode === 'telnyx' &&
        this.isLiveStoryTarget(call.targetId) &&
        (call.phase !== 'finished' || !call.phoneOutcome),
    );
  }
  private unresolvedLiveCalls() {
    return this.state.calls.some(
      (call) =>
        call.mode === 'telnyx' &&
        (call.phase !== 'finished' ||
          (this.isLiveStoryTarget(call.targetId) && !call.phoneOutcome)),
    );
  }
  preparePhoneCall(targetId: string, requestId: string, revision = this.state.revision): View {
    const existing = this.state.calls.find((call) => call.id === requestId);
    if (existing) {
      requireThat(
        existing.mode === 'telnyx' && existing.targetId === targetId,
        '발신 요청 ID가 다른 대상에 사용되었습니다.',
        'request_conflict',
      );
      return this.view();
    }
    requireThat(
      typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 200,
      '발신 요청 ID가 필요합니다.',
      'invalid_request',
    );
    requireThat(
      this.isLivePhoneTarget(targetId),
      '현재 실전화 시연 대상을 선택하세요.',
      'phone_target_guard',
    );
    requireThat(
      !this.state.trips.some((trip) => trip.householdId === targetId),
      '수송 임무가 진행 중인 대상입니다.',
      'phone_target_guard',
    );
    const targetType = this.state.data.households.some((household) => household.id === targetId)
      ? 'resident'
      : 'member';
    requireThat(
      targetType === 'resident' ||
        this.state.data.teams.some((team) => team.members.some((member) => member.id === targetId)),
      '전화 대상이 없습니다.',
      'not_found',
    );
    const attempt =
      this.state.calls.filter((call) => call.targetId === targetId && call.mode === 'telnyx')
        .length + 1;
    this.reserveLive(targetId, targetType, requestId, revision);
    const prepared = this.latestPhoneCall(targetId)!;
    prepared.attempt = attempt;
    prepared.purpose = attempt === 1 ? 'initial' : 'redial';
    if (targetType === 'resident') this.status(targetId).attemptCount = attempt;
    if (this.isLivePhoneTarget(targetId) && this.state.demonstration)
      this.state.demonstration.stage = 'dialing';
    this.log(
      '실전화 요청 준비·종료 확인 전 분류·배차 보류',
      'system',
      targetType === 'resident' ? targetId : undefined,
    );
    return this.view();
  }
  applyPhoneUpdate(requestId: string, update: PhoneRuntimeUpdate): View {
    const call = this.state.calls.find((call) => call.id === requestId && call.mode === 'telnyx');
    requireThat(call, '현재 사이클의 실전화 요청이 없습니다.', 'not_found');
    if (call.phase === 'finished') return this.view();
    this.open();
    requireThat(
      ['dialing', 'talking', 'pendingunknown'].includes(update.phase),
      '전화 상태 입력 오류',
      'invalid_phone_update',
    );
    const before = JSON.stringify(call),
      previousStatus =
        call.targetType === 'resident' ? JSON.stringify(this.status(call.targetId)) : '',
      previousStage = this.state.demonstration?.stage;
    if (update.providerId) call.providerId = update.providerId;
    if (update.phase === 'talking') call.phoneConnected = true;
    call.phase = update.phase === 'pendingunknown' ? 'pendingunknown' : 'calling';
    if (call.targetType === 'resident') {
      const status = this.status(call.targetId);
      status.status = call.phase === 'calling' ? 'calling' : 'pendingunknown';
      status.note =
        update.phase === 'talking'
          ? '실전화 연결·전사 수신 중·종료 확인 후 결과 적용'
          : update.phase === 'pendingunknown'
            ? '실전화 상태 불명·기존 요청 확인·자동 재발신 없음'
            : '실전화 발신 중·응답과 종료 결과 대기';
      if (this.isLivePhoneTarget(call.targetId) && this.state.demonstration)
        this.state.demonstration.stage = update.phase === 'talking' ? 'talking' : 'dialing';
    }
    if (
      call.targetType === 'member' &&
      this.isLivePhoneTarget(call.targetId) &&
      this.state.demonstration
    )
      this.state.demonstration.stage = update.phase === 'talking' ? 'talking' : 'dialing';
    if (
      before !== JSON.stringify(call) ||
      previousStage !== this.state.demonstration?.stage ||
      (call.targetType === 'resident' &&
        previousStatus !== JSON.stringify(this.status(call.targetId)))
    )
      this.bump();
    return this.view();
  }
  applyPhoneOutcome(requestId: string, outcome: PhoneRuntimeOutcome): View {
    const call = this.state.calls.find((call) => call.id === requestId && call.mode === 'telnyx');
    requireThat(call, '현재 사이클의 실전화 요청이 없습니다.', 'not_found');
    if (call.phoneOutcome) return this.view();
    this.open();
    requireThat(
      outcome.ended === true,
      '실전화 종료 확인 후 결과를 적용하세요.',
      'phone_not_ended',
    );
    requireThat(
      outcome.kind === (call.targetType === 'resident' ? 'resident' : 'standby') &&
        (outcome.mobility === undefined ||
          ['needs_help', 'possible', 'refusal', 'unknown'].includes(outcome.mobility)) &&
        (outcome.standbyAvailable === undefined || typeof outcome.standbyAvailable === 'boolean') &&
        (outcome.emergency === undefined || typeof outcome.emergency === 'boolean') &&
        (outcome.evidence === undefined ||
          (typeof outcome.evidence === 'string' && outcome.evidence.length <= 2000)),
      '실전화 결과 입력 오류',
      'invalid_phone_outcome',
    );
    call.phase = 'finished';
    call.finishedSim = this.state.simMinutes;
    call.outcome =
      outcome.kind === 'resident'
        ? outcome.mobility && outcome.mobility !== 'unknown'
          ? 'answered'
          : 'pendingunknown'
        : outcome.standbyAvailable === true
          ? 'answered'
          : outcome.standbyAvailable === false
            ? 'unavailable'
            : 'pendingunknown';
    call.phoneOutcome = structuredClone(outcome);
    if (outcome.evidence) call.text = outcome.evidence;
    if (call.targetType === 'member') {
      this.state.memberResponses[call.targetId] =
        outcome.standbyAvailable === true
          ? 'ok'
          : outcome.standbyAvailable === false
            ? 'no'
            : 'waiting';
      this.log(
        `실전화 대원 종료 확인·${
          outcome.standbyAvailable === true
            ? '출동 가능 근거 확인'
            : '출동 불가·불명 결과 검토·자동 배차 보류'
        }`,
      );
      if (this.isLivePhoneTarget(call.targetId) && this.state.demonstration) {
        this.state.demonstration.stage = 'requested';
        if (this.state.demonstration.residentRequestAssumed) {
          const resident = this.status(this.state.demonstration.residentId);
          resident.dispatchHold =
            outcome.standbyAvailable === true
              ? null
              : '대원 실전화 출동 불가·불명 결과·배차 보류·담당자 검토 필요';
          resident.note =
            outcome.standbyAvailable === true
              ? '시연 가정: 박미숙 할머니 구조 요청 접수·반영환 대원 실전화 출동 가능 확인·수송 조건 검증 대기'
              : '시연 가정: 박미숙 할머니 구조 요청 접수·대원 실전화 출동 불가·불명·구조 상태 미확인';
        }
      }
    } else {
      const status = this.status(call.targetId),
        household = this.household(call.targetId);
      this.cancelQueuedCalls(call.targetId, 'answered');
      status.status =
        outcome.emergency === true
          ? 'e119'
          : outcome.mobility === 'needs_help'
            ? 'help'
            : outcome.mobility === 'possible'
              ? 'guided'
              : outcome.mobility === 'refusal'
                ? 'refuse'
                : 'unclear';
      status.note =
        outcome.emergency === true
          ? '실전화 긴급 호소·담당자 119/의료 대응 검토 필요·구조 완료 미확인'
          : outcome.mobility === 'needs_help'
            ? '실전화 종료·이동 지원 필요 확인·차량/대원/경로 검증 대기'
            : outcome.mobility === 'possible'
              ? '실전화 종료·자가 이동 가능 응답·출발/대피소 도착 미확인'
              : outcome.mobility === 'refusal'
                ? '실전화 종료·대피 거부 응답·담당자 후속 연락 검토'
                : '실전화 종료·분류 근거 부족·담당자 검토 필요';
      // Mobility is a capability report, not proof of understanding the evacuation instructions.
      status.acked = false;
      status.dispatchHold = outcome.emergency === true ? status.note : null;
      status.lastChangedAt = this.state.scenario.displayTime;
      status.callbackAtSim = null;
      status.recheckOverdue = false;
      if (outcome.mobility === 'needs_help') household.mobility = '보조';
      if (outcome.mobility === 'possible') household.mobility = '자력';
      if (this.isLivePhoneTarget(call.targetId) && this.state.demonstration)
        this.state.demonstration.stage =
          outcome.mobility === 'needs_help' && outcome.emergency !== true
            ? 'requested'
            : 'assessed';
      this.log(status.note, 'assistant', call.targetId);
    }
    this.bump();
    this.summarizeFirstPass();
    return this.view();
  }
  /** uncertain=false requires proof that no provider call was created. It never redials. */
  rejectPhoneCall(requestId: string, reason: string, uncertain = false): View {
    const call = this.state.calls.find((call) => call.id === requestId && call.mode === 'telnyx');
    requireThat(call, '현재 사이클의 실전화 요청이 없습니다.', 'not_found');
    if (call.phoneOutcome) return this.view();
    this.open();
    requireThat(
      typeof reason === 'string' && reason.length > 0 && reason.length <= 2000,
      '전화 실패 근거가 필요합니다.',
      'invalid_phone_outcome',
    );
    if (uncertain) {
      this.applyPhoneUpdate(requestId, { phase: 'pendingunknown' });
      this.log(`실전화 발신 여부 불명·기존 요청 확인 필요·${reason}`);
      return this.view();
    }
    requireThat(
      !call.providerId && !call.phoneConnected,
      '전화망 생성·연결 근거가 있는 요청입니다. 실제 종료 확인 또는 결과 불명으로 보존하세요.',
      'phone_not_ended',
    );
    this.applyPhoneOutcome(requestId, {
      ended: true,
      kind: call.targetType === 'resident' ? 'resident' : 'standby',
      ...(call.targetType === 'resident' ? { mobility: 'unknown' as const } : {}),
    });
    call.phoneNotDialed = true;
    call.outcome = 'unavailable';
    if (call.targetType === 'resident') {
      const status = this.status(call.targetId);
      status.note = `실전화 발신 전 실패 확인·담당자 설정 검토·${reason}`;
      status.dispatchHold = status.note;
    }
    this.log(`실전화 발신 전 실패 확인·외부 세션 없음·자동 재발신 없음·${reason}`);
    this.bump();
    return this.view();
  }
  reserveLive(id: string, targetType: 'resident' | 'member', requestId: string, revision: number) {
    this.open();
    this.requireRevision(revision);
    requireThat(
      id !== 'H009',
      '박미숙 할머니의 구조 요청은 시연 가정입니다. 실제 전화 대상이 아닙니다.',
      'phone_target_guard',
    );
    requireThat(
      this.state.demonstration?.phoneMode !== 'live' || this.isLivePhoneTarget(id),
      '현재 시나리오의 실제 전화 대상만 발신할 수 있습니다.',
      'phone_target_guard',
    );
    requireThat(
      this.state.plan?.confirmed && !this.state.networkDown,
      '최신 확정·통신 상태가 필요합니다.',
    );
    requireThat(
      this.state.calls.filter((c) => ['calling', 'pendingunknown'].includes(c.phase)).length < 8 &&
        !this.active(id),
      '공용 채널 또는 대상 세션이 사용 중입니다.',
    );
    if (targetType === 'resident') {
      const h = this.household(id),
        s = this.status(id);
      requireThat(
        h.callEligible && !s.temporaryExclusion && !['safe', 'rescued'].includes(s.status),
        '완료·제외 대상은 발신할 수 없습니다.',
      );
      s.status = 'pendingunknown';
      s.note = '실제 발신 생성 결과 대기·중복 발신 금지';
    }
    this.state.calls.push({
      id: requestId,
      targetId: id,
      targetType,
      attempt: 1,
      phase: 'pendingunknown',
      providerId: null,
      nextAt: null,
      text: '',
      mode: 'telnyx',
      purpose: 'initial',
      retryCount: 0,
      startedSim: this.state.simMinutes,
    });
    this.bump();
  }
  settleLive(requestId: string, providerId: string | null, status: string) {
    const c = this.state.calls.find((c) => c.id === requestId);
    requireThat(c, '기존 발신 요청이 없습니다.');
    if (c.phase === 'finished') return;
    requireThat(
      status !== 'mock' || !this.isLiveStoryTarget(c.targetId),
      '실전화 시연 대상에 모의 어댑터 결과를 적용할 수 없습니다.',
      'phone_result_required',
    );
    c.providerId = providerId;
    c.phase =
      status === 'mock' ? 'finished' : status === 'initiated' ? 'calling' : 'pendingunknown';
    if (status === 'pendingunknown') c.outcome = 'pendingunknown';
    if (status === 'mock') {
      c.outcome = 'answered';
      c.finishedSim = this.state.simMinutes;
    }
    if (c.targetType === 'resident') {
      const s = this.status(c.targetId);
      if (status === 'initiated') s.status = 'calling';
      else if (status === 'mock') {
        s.status = 'unclear';
        s.note = '실제 발신 없는 모의 통화 어댑터 결과';
      }
    }
    this.log(
      status === 'pendingunknown'
        ? '실제 발신 결과 불명·기존 요청 ID 보존·자동 재발신 없음'
        : status === 'mock'
          ? '전화 어댑터 모의 결과·외부 실행 없음'
          : '전화망 발신 생성·사람 응답/안내 확인은 미확인',
    );
    this.bump();
    this.summarizeFirstPass();
  }
  finishLive(requestId: string) {
    const c = this.state.calls.find((c) => c.id === requestId);
    requireThat(c, '기존 발신 요청이 없습니다.');
    if (c.phase === 'finished') return;
    c.phase = 'finished';
    c.outcome ??= c.text ? 'answered' : 'pendingunknown';
    c.finishedSim = this.state.simMinutes;
    if (c.targetType === 'resident') {
      const s = this.status(c.targetId);
      if (['calling', 'pendingunknown'].includes(s.status)) {
        s.status = 'unclear';
        s.note = '전화망 종료 확인·도착 근거 없음';
      }
    }
    this.bump();
    this.summarizeFirstPass();
  }
  planItems() {
    const h = this.state.data.households;
    const s = new Map(this.state.scenario.householdStatuses.map((x) => [x.householdId, x]));
    const wind = predictionEvidence(this.state).usable
      ? this.state.data.map.wind
      : { ...this.state.data.map.wind, speedMps: Number.NaN };
    return {
      order: orderedHouseholds(
        h.filter(
          (x) =>
            x.callEligible &&
            !s.get(x.id)?.temporaryExclusion &&
            (this.state.demonstration?.phoneMode !== 'live' || this.isLivePhoneTarget(x.id)),
        ),
        this.state.data.map.ignition,
        wind,
      ),
      visit: orderedHouseholds(
        h.filter(
          (x) =>
            this.state.demonstration?.phoneMode !== 'live' &&
            !x.callEligible &&
            !s.get(x.id)?.temporaryExclusion,
        ),
        this.state.data.map.ignition,
        wind,
      ),
      excluded: h.filter((x) => s.get(x.id)?.temporaryExclusion).map((x) => x.id),
    };
  }
  private planSourceSignature() {
    const wind = this.state.sourceState.records.findLast((r) => r.sourceId === 'SRC05');
    const evidence = predictionEvidence(this.state),
      policy = this.state.sourceState.policies.SRC05;
    return canonicalJson({
      scenarioId: this.state.scenario.id,
      datasetId: DEMO_DATASET,
      referenceDate: this.state.data.metadata.referenceDate,
      usable: evidence.usable,
      reasons: [...evidence.reasons].sort(),
      policy: policy
        ? {
            pollSeconds: policy.pollSeconds,
            freshnessMaxAgeSeconds: policy.freshnessMaxAgeSeconds ?? null,
            jurisdiction: {
              ...policy.jurisdiction,
              areas: [...policy.jurisdiction.areas],
            },
            disasterKeywords: [...(policy.disasterKeywords ?? [])],
            thresholds: {
              windSpeedMps: policy.thresholds?.windSpeedMps ?? null,
              extinguishmentDropPercentPoints:
                policy.thresholds?.extinguishmentDropPercentPoints ?? null,
            },
          }
        : null,
      record: wind
        ? {
            sourceId: wind.sourceId,
            scenarioId: wind.scenarioId,
            datasetId: wind.datasetId,
            referenceDate: wind.referenceDate,
            mode: wind.mode,
            origin: wind.origin,
            sampleId: wind.sampleId,
            observedAt: wind.observedAt,
            jurisdictions: [...wind.jurisdictions],
            payloadHash: wind.payloadHash,
            payload: wind.payload,
            ok: wind.ok,
            error: wind.error,
          }
        : null,
    });
  }
  private planConditionsMatch(plan: Plan, current = this.planItems()) {
    const matches = (proposed: PlanItem[], expected: PlanItem[]) => {
      const indexed = new Map(expected.map((item) => [item.householdId, item]));
      return (
        proposed.length === expected.length &&
        new Set(proposed.map((item) => item.householdId)).size === proposed.length &&
        proposed.every((item, index) => {
          const latest = indexed.get(item.householdId);
          return (
            latest &&
            item.rank === index + 1 &&
            item.eta === latest.eta &&
            item.score === latest.score &&
            item.vulnerability === latest.vulnerability &&
            item.reason === latest.reason
          );
        })
      );
    };
    return (
      matches(plan.order, current.order) &&
      matches(plan.visit, current.visit) &&
      plan.excluded.length === current.excluded.length &&
      new Set(plan.excluded).size === plan.excluded.length &&
      plan.excluded.every((id) => current.excluded.includes(id))
    );
  }
  private refreshUnconfirmedPlan() {
    const plan = this.state.plan;
    if (!plan || plan.confirmed || this.state.frozen) return;
    const current = this.planItems(),
      sourceSignature = this.planSourceSignature(),
      sameConditions = this.planConditionsMatch(plan, current);
    if (sameConditions && plan.sourceSignature === sourceSignature) return;
    // Keep the officer's ordering when the displayed target conditions still agree.
    if (!sameConditions) Object.assign(plan, current);
    plan.sourceSignature = sourceSignature;
    plan.revision++;
    plan.snapshotRevision = this.state.revision + 1;
    this.log('소스·대상 조건 변경·미확정 계획 갱신·담당자 재검토 필요');
  }
  validatePlanConfirmation(revision: unknown) {
    this.open();
    const plan = this.state.plan;
    requireThat(plan, '발령 제안이 없습니다.');
    if (plan.confirmed) return;
    this.requireRevision(revision);
    requireThat(!this.state.networkDown, '통신 복구 후 확정하세요.');
    requireThat(
      this.planConditionsMatch(plan) && plan.sourceSignature === this.planSourceSignature(),
      '소스·대상 조건이 변경되었습니다. 최신 계획을 갱신하고 다시 검토하세요.',
      'plan_revalidation_required',
    );
  }
  private makePlan() {
    this.state.plan = {
      id: `PLAN-${this.state.revision}`,
      revision: 1,
      snapshotRevision: this.state.revision + 1,
      ...this.planItems(),
      confirmed: false,
      confirmedAt: null,
      sourceSignature: this.planSourceSignature(),
    };
    this.state.scenario.mode = 'event';
    this.log('발령 제안·담당자 확정 대기 (모의)', 'human');
  }
  private active(target: string) {
    return this.state.calls.some(
      (c) => c.targetId === target && ['calling', 'pendingunknown'].includes(c.phase),
    );
  }
  private cancelQueuedCalls(id: string, outcome: Call['outcome'] = 'replaced') {
    for (const c of this.state.calls)
      if (c.targetId === id && c.targetType === 'resident' && c.phase === 'queued') {
        c.phase = 'finished';
        c.outcome = outcome;
        c.finishedSim = this.state.simMinutes;
      }
    this.status(id).callbackAtSim = null;
  }
  private queueFollowup(
    previous: Call | undefined,
    id: string,
    purpose: NonNullable<Call['purpose']>,
    delay: number,
    targetType: Call['targetType'] = 'resident',
    retryCount = 0,
  ) {
    // Follow-up playback belongs to the synthetic clock. Live dial is a separate explicit API.
    if (previous?.mode === 'telnyx' || this.state.demonstration?.phoneMode === 'live') return;
    const attempt =
      Math.max(0, ...this.state.calls.filter((c) => c.targetId === id).map((c) => c.attempt)) + 1;
    this.state.calls.push({
      id: `CALL-${id}-${attempt}`,
      targetId: id,
      targetType,
      attempt,
      phase: 'queued',
      providerId: null,
      nextAt: this.state.simMinutes + delay,
      text: '',
      mode: 'mock',
      purpose,
      retryCount,
    });
    if (targetType === 'resident' && purpose !== 'redial')
      this.status(id).callbackAtSim = this.state.simMinutes + delay;
  }
  private summarizeFirstPass() {
    if (this.state.firstPass || !this.state.plan?.confirmed || !this.state.plan.order.length)
      return;
    const targets: FirstPass['targets'] = [];
    for (const item of this.state.plan.order) {
      const c = this.state.calls.find(
        (c) =>
          c.targetId === item.householdId &&
          c.targetType === 'resident' &&
          (c.purpose === 'initial' || c.attempt === 1),
      );
      if (!c || (!c.outcome && c.phase !== 'finished')) return;
      targets.push({
        householdId: item.householdId,
        callId: c.id,
        outcome: c.outcome ?? 'answered',
      });
    }
    const started = this.state.calls
      .filter((c) => c.targetType === 'resident' && (c.purpose === 'initial' || c.attempt === 1))
      .map((c) => c.startedSim ?? 0);
    this.state.firstPass = {
      completedAt: this.state.scenario.displayTime,
      completedAtSim: this.state.simMinutes,
      targets,
      simulatedDurationMinutes: this.state.simMinutes - Math.min(...started),
      liveDurationSeconds: null,
    };
    this.log(
      this.state.demonstration?.phoneMode === 'live'
        ? `실전화 1차 확인 ${targets.length}가구·분류 근거 부족 ${targets.filter((t) => t.outcome === 'pendingunknown').length}·도착 확인과 구분`
        : `1차 모의 확인 요약 ${targets.length}가구·결과 불명 ${targets.filter((t) => t.outcome === 'pendingunknown').length}·재발신/방문/구조 예약 유지`,
    );
  }
  private finishMember(c: Call, outcome: 'available' | 'unavailable' | 'noanswer') {
    c.phase = 'finished';
    c.finishedSim = this.state.simMinutes;
    c.outcome =
      outcome === 'available' ? 'answered' : outcome === 'noanswer' ? 'noanswer' : 'unavailable';
    if (outcome === 'noanswer' && (c.retryCount ?? 0) < 2) {
      this.state.memberResponses[c.targetId] = 'waiting';
      this.queueFollowup(c, c.targetId, 'redial', 1, 'member', (c.retryCount ?? 0) + 1);
      this.state.calls.at(-1)!.mockOutcome = 'noanswer';
      this.log(`조원 ${c.targetId} 모의 무응답·1분 후 재호출 ${(c.retryCount ?? 0) + 1}/2`);
    } else {
      this.state.memberResponses[c.targetId] = outcome === 'available' ? 'ok' : 'no';
      this.log(
        `조원 ${c.targetId} ${outcome === 'available' ? '모의 가능 응답' : outcome === 'noanswer' ? '재호출 2회 종료·모의 불가' : '모의 불가 응답'}`,
      );
    }
  }
  private proposeUnavailableTeams() {
    if (this.state.demonstration?.phoneMode === 'live') return;
    if (!this.state.plan?.confirmed || this.state.networkDown) return;
    for (const team of this.state.data.teams) {
      const responded = team.members.every((m) => this.state.memberResponses[m.id] !== 'waiting');
      const available = team.members.filter((m) => this.state.memberResponses[m.id] === 'ok');
      if (!responded || (available.length >= 2 && available.some((m) => m.canDrive))) continue;
      for (const id of team.assignedHouseholdIds) {
        const h = this.household(id),
          s = this.status(id);
        if (
          s.temporaryExclusion ||
          this.state.trips.some((t) => t.householdId === id) ||
          this.state.handoffs.some((t) => t.householdId === id) ||
          this.state.reassignments.some((p) => p.householdId === id)
        )
          continue;
        if (['act', 'visit'].includes(groupOf(h, s))) this.proposeReassignment(id);
      }
    }
  }
  protected pump() {
    if (this.state.demonstration?.phoneMode === 'live') return;
    if (this.state.networkDown || !this.state.plan?.confirmed || this.state.frozen) return;
    while (
      this.state.calls.filter((c) => ['calling', 'pendingunknown'].includes(c.phase)).length <
      8 - this.pendingPhoneTargets().length
    ) {
      const queued = this.state.calls.filter(
        (c) =>
          c.phase === 'queued' &&
          !this.isLiveStoryTarget(c.targetId) &&
          !this.active(c.targetId) &&
          (c.nextAt === null || c.nextAt <= this.state.simMinutes),
      );
      const c = queued.find((c) => c.targetType === this.turn) ?? queued[0];
      if (!c) break;
      c.phase = 'calling';
      c.startedOrder = ++this.startedSequence;
      c.startedSim = this.state.simMinutes;
      this.turn = c.targetType === 'resident' ? 'member' : 'resident';
      if (c.targetType === 'resident') {
        const s = this.status(c.targetId);
        if (!['e119', 'safe', 'rescued'].includes(s.status))
          s.status = c.purpose === 'redial' ? 'redial' : 'calling';
        s.attemptCount = c.attempt;
        s.lastChangedAt = this.state.scenario.displayTime;
      }
    }
    if (this.state.simulation.cycleId) this.syncDemonstration();
  }
  private emergency(id: string, reason: string) {
    const s = this.status(id);
    this.cancelQueuedCalls(id, 'answered');
    s.status = 'e119';
    s.note = reason;
    s.acked = false;
    s.recheckOverdue = false;
    let h = this.state.handoffs.find((h) => h.householdId === id);
    if (!h) {
      h = {
        id: `HANDOFF-${this.state.handoffs.length + 1}`,
        householdId: id,
        status: this.state.networkDown ? 'local' : 'mockRecorded',
        receiptId: this.state.networkDown ? null : `DEMO-RECEIPT-${id}`,
        reason,
      };
      this.state.handoffs.push(h);
      this.log(
        this.state.networkDown
          ? '긴급 근거 현지 보관·수동 연락 필요'
          : '119 자동 인계(모의) 접수 기록·구조 완료 아님',
        'system',
        id,
      );
    } else h.reason = reason;
    s.handoffStatus = h.status;
  }
  applyClassification(id: string, result: Classification) {
    this.open();
    requireThat(
      this.state.demonstration?.phoneMode !== 'live',
      '실전화 대상은 종료가 확인된 전화 결과로만 분류할 수 있습니다.',
      'phone_result_required',
    );
    const s = this.status(id),
      h = this.household(id);
    requireThat(h.callEligible && !s.temporaryExclusion, '발신 대상에서 제외된 가구입니다.');
    const validated = classify(
      result.quoted,
      this.state.data.shelters.map((s) => s.name),
    );
    requireThat(
      validated.status === result.status && validated.acked === result.acked,
      '발화와 분류 근거가 일치하지 않습니다.',
      'invalid_evidence',
    );
    if (result.status === 'e119') {
      this.emergency(id, result.reason);
      return;
    }
    if (groupOf(h, s) === 'safe' || s.status === 'e119') return;
    const previous = this.state.calls.findLast(
      (c) => c.targetId === id && ['calling', 'pendingunknown', 'finished'].includes(c.phase),
    );
    this.cancelQueuedCalls(id, 'answered');
    s.status = result.status;
    s.dispatchHold = null;
    if (result.status === 'safe') s.recheckOverdue = false;
    s.acked = result.acked;
    s.note = result.reason;
    s.lastChangedAt = this.state.scenario.displayTime;
    if (result.status === 'moving') s.recheckOverdue = false;
    if (result.status === 'moving' || result.status === 'unclear')
      this.queueFollowup(
        previous,
        id,
        result.status === 'moving' ? 'arrival_check' : 'clarification',
        result.status === 'moving' ? 15 : 5,
      );
    this.log(`${result.reason} (규칙·모의 전사)`, 'assistant', id);
  }
  command(action: string, input: Record<string, unknown> = {}): View {
    if (action === 'cycle-start') {
      this.requireRevision(input.revision);
      requireThat(
        !this.unresolvedLiveCalls(),
        '실제 활성·결과 불명 세션을 먼저 종료·확인하세요.',
        'live_session',
      );
      const revision = this.state.revision;
      const story = input.demoStory ?? 'grandfather';
      const phoneMode = input.phoneMode ?? 'mock';
      requireThat(
        story === 'grandfather' || story === 'squad',
        '시연 이야기는 grandfather 또는 squad입니다.',
        'invalid_story',
      );
      requireThat(
        phoneMode === 'mock' || phoneMode === 'live',
        '전화 모드는 mock 또는 live입니다.',
        'invalid_phone_mode',
      );
      this.state = this.initial(DATA, 'idle');
      this.state.demonstration = configureDemoStory(
        this.state.data,
        story as DemoStory,
        phoneMode as DemoPhoneMode,
      );
      if (phoneMode === 'live') {
        // These supporting crew members are a declared resource assumption. No call,
        // transcript, answer event or provider receipt is created for them.
        this.state.memberResponses[story === 'grandfather' ? 'M02' : 'M03'] = 'ok';
      }
      if (this.state.demonstration.residentRequestAssumed) {
        const assumed = this.status(this.state.demonstration.residentId);
        assumed.status = 'help';
        assumed.acked = false;
        assumed.note =
          '시연 가정: 박미숙 할머니 구조 요청 접수·주민에게 실제 발신 없음·반영환 대원 응답 확인 대기';
      }
      this.state.revision = revision;
      this.state.simulation = {
        ...initialSimulation(),
        cycleId: `CYCLE-${revision + 1}`,
        phase: 'review',
      };
      this.state.scenario.id = `CYCLE-${revision + 1}`;
      this.state.scenario.label = '화재 발생 → 대피 종료 (합성 사이클)';
      this.seen.clear();
      this.startedSequence = 0;
      this.turn = 'resident';
      this.cycleRemainder = 0;
      this.cycleObservationMinute = 0;
      this.cycleLeaderDue.clear();
      this.cycleBaseTime = Date.parse(this.state.scenario.displayTime);
      this.collectSources();
      this.makePlan();
      const hero = this.state.demonstration.residentId;
      this.state.plan!.order = [
        ...this.state.plan!.order.filter((item) => item.householdId === hero),
        ...this.state.plan!.order.filter((item) => item.householdId !== hero),
      ].map((item, index) => ({ ...item, rank: index + 1 }));
      this.log('합성 cycle 화재 발생·48가구 원점·사람의 발령 확정 전 전화 0', 'human');
      this.log(
        `합성 ${story} 이야기·시연 화점 (900,50)·${story === 'grandfather' ? 'H012 합성 픽업 (430,280)·통제 ROAD1 대신 열린 ROAD5 연결' : 'H009 원 좌표·5분 대기조의 안전한 합성 화점 조건'}·원본 fixture 파일 변경 없음`,
      );
      this.log(
        '합성 주연 수송 후보 우선·대기 중 주연 차량/인력은 배경 자동 후보에서 제외·허구 예약 없음',
      );
      if (this.state.demonstration.residentRequestAssumed)
        this.log(
          this.status(this.state.demonstration.residentId).note,
          'system',
          this.state.demonstration.residentId,
        );
      if (this.state.demonstration.transportCrewAssumed)
        this.log(
          `시연 수송 자원 가정: ${story === 'grandfather' ? '구급차 운전 담당 M02' : '대기조 지원 대원 M03'} 가용 확인·통화 응답 생성 없음`,
        );
      this.bump();
      return this.view();
    }
    if (action === 'scenario') {
      const id = String(input.id);
      requireThat(
        DATA.scenarios.some((s) => s.id === id),
        '시나리오가 없습니다.',
      );
      requireThat(!this.unresolvedLiveCalls(), '실제 세션을 먼저 종료·확인하세요.');
      const revision = this.state.revision + 1;
      this.state = this.initial(DATA, id);
      this.state.revision = revision;
      this.seen.clear();
      this.cycleRemainder = 0;
      this.cycleObservationMinute = 0;
      this.cycleLeaderDue.clear();
      this.cycleBaseTime = null;
      if (['active', 'late'].includes(id)) {
        this.makePlan();
        this.state.plan!.confirmed = true;
        this.state.plan!.confirmedAt = this.state.scenario.displayTime;
        this.state.plan!.snapshotRevision = revision;
      }
      if (id === 'review') this.makePlan();
      return this.view();
    }
    this.open();
    if (action === 'sim') {
      this.requireRevision(input.revision);
      const simulation = this.state.simulation;
      requireThat(
        simulation.cycleId && ['review', 'running'].includes(simulation.phase),
        '검토·진행 중인 합성 사이클만 재생 설정을 변경할 수 있습니다.',
        'cycle_guard',
      );
      requireThat(
        input.playing !== undefined || input.speed !== undefined,
        '재생 또는 속도를 선택하세요.',
      );
      requireThat(
        input.playing === undefined || typeof input.playing === 'boolean',
        '재생 입력 오류',
      );
      requireThat(
        input.speed === undefined ||
          ([12, 30, 60].includes(Number(input.speed)) && typeof input.speed === 'number'),
        '속도는 12·30·60배입니다.',
      );
      if (input.playing === true)
        requireThat(
          simulation.phase === 'running' && this.state.plan?.confirmed && !this.state.networkDown,
          '사람의 최신 발령 확정·통신 복구 후 재생하세요.',
          'cycle_guard',
        );
      if (input.speed !== undefined) simulation.speed = input.speed as Simulation['speed'];
      if (input.playing !== undefined) simulation.playing = input.playing as boolean;
      this.log(
        `합성 cycle ${simulation.playing ? '재생' : '일시 정지'}·${simulation.speed}배`,
        'human',
      );
    } else if (action === 'watch') {
      requireThat(this.state.scenario.mode === 'idle', '평시에서 감시를 시작하세요.');
      this.state.scenario.mode = 'watch';
      this.collectSources();
      this.log('합성 소스 감시 시작·발신 없음', 'human');
    } else if (action === 'plan') {
      requireThat(this.state.scenario.mode === 'watch', '감시 단계에서 시작하세요.');
      this.makePlan();
    } else if (action === 'reorder') {
      this.requireRevision(input.revision);
      const p = this.state.plan;
      requireThat(p && !p.confirmed, '미확정 계획만 수정할 수 있습니다.');
      const ids = input.ids;
      requireThat(
        Array.isArray(ids) &&
          ids.length === p.order.length &&
          new Set(ids).size === ids.length &&
          ids.every((id) => p.order.some((x) => x.householdId === id)),
        '중복·누락 없는 대상 순서가 필요합니다.',
      );
      p.order = (ids as string[]).map((id, i) => ({
        ...p.order.find((x) => x.householdId === id)!,
        rank: i + 1,
      }));
      p.revision++;
      p.snapshotRevision = this.state.revision + 1;
      this.log('담당자 순서 수정 (모의)', 'human');
    } else if (action === 'confirm') {
      const p = this.state.plan;
      requireThat(p, '발령 제안이 없습니다.');
      if (p.confirmed) return this.view();
      this.validatePlanConfirmation(input.revision);
      p.confirmed = true;
      p.confirmedAt = this.state.scenario.displayTime;
      p.snapshotRevision = this.state.revision + 1;
      if (this.state.simulation.cycleId && this.state.simulation.phase === 'review') {
        this.state.simulation.phase = 'running';
        this.state.simulation.playing = true;
      }
      for (const x of p.order) {
        if (
          this.isLiveStoryTarget(x.householdId) &&
          this.state.demonstration?.residentRequestAssumed
        )
          continue;
        this.status(x.householdId).status = 'queued';
        if (this.state.demonstration?.phoneMode === 'live') continue;
        this.state.calls.push({
          id: `CALL-${x.householdId}-1`,
          targetId: x.householdId,
          targetType: 'resident',
          attempt: 1,
          phase: 'queued',
          providerId: null,
          nextAt: null,
          text: '',
          mode: 'mock',
          purpose: 'initial',
          retryCount: 0,
        });
      }
      for (const m of this.state.data.teams.flatMap((t) => t.members)) {
        if (this.state.demonstration?.phoneMode === 'live') continue;
        this.state.calls.push({
          id: `CALL-${m.id}-1`,
          targetId: m.id,
          targetType: 'member',
          attempt: 1,
          phase: 'queued',
          providerId: null,
          nextAt:
            this.state.demonstration?.story === 'squad' &&
            m.id === this.state.demonstration.memberId
              ? 5
              : null,
          text: '',
          mode: 'mock',
          purpose: 'initial',
          retryCount: 0,
        });
      }
      if (this.state.demonstration?.phoneMode === 'live')
        this.log(
          `담당자 발령 확정·실전화 대상 ${this.pendingPhoneTargets().join(', ')}·모의 전화 없음`,
          'human',
        );
      else {
        this.log(`담당자 발령 확정 (모의)·주민 ${p.order.length}·조원 12·공용 8채널`, 'human');
        this.log(`방문 ${p.visit.length}가구 이장 방문 요청 기록 (모의)`);
        this.log('조원 12명 호출 문자 기록(모의)·실제 SMS 없음');
      }
      this.pump();
    } else if (action === 'comms') {
      this.state.networkDown = input.down === true;
      if (this.state.networkDown) this.state.simulation.playing = false;
      this.log(
        this.state.networkDown
          ? '통신 두절 시연·신규 실행 보류·기존 세션 유지'
          : '통신 복구 시연·기존 세션/임무 보존 후 미실행 큐 재개',
        'human',
      );
      if (!this.state.networkDown) {
        for (const h of this.state.handoffs)
          if (h.status === 'local') {
            h.status = 'mockRecorded';
            h.receiptId = `DEMO-RECEIPT-${h.householdId}`;
            this.status(h.householdId).handoffStatus = h.status;
          }
        this.pump();
      }
    } else if (action === 'source-fail') {
      const s = this.state.scenario.sourceStatuses.find((s) => s.sourceId === input.id);
      requireThat(s, '소스가 없습니다.');
      const failed = createSourceRecord({
        recordId: `SOURCE-FAIL-${this.state.scenario.id}-${this.state.sourceState.records.length + 1}`,
        sourceId: s.sourceId,
        scenarioId: this.state.scenario.id,
        datasetId: DEMO_DATASET,
        referenceDate: this.state.data.metadata.referenceDate,
        mode: 'live',
        origin: 'simulated-live-failure',
        sampleId: null,
        observedAt: null,
        fetchedAt: { wall: new Date().toISOString(), replay: null },
        jurisdictions: [DEMO_JURISDICTION],
        payload: null,
        ok: false,
        error: '담당자 수신 실패 시연 · 실제 API 호출 없음',
      });
      this.state.sourceState.records = appendSourceAttempt(this.state.sourceState.records, failed);
      s.status = 'fail';
      this.log('수신 실패 시연·실패 상태 보존');
      this.advanceTrips(false);
    } else if (action === 'collect') {
      requireThat(!this.state.networkDown, '통신 두절 중입니다.');
      this.collectSources();
      this.log('합성 소스 모의 수집·기존 실패를 정상으로 덮어쓰지 않음');
    } else if (action === 'dismiss') {
      this.log('담당자 모의 경보 오탐 처리', 'human');
      this.state.scenario.pendingReviewIds = [];
    } else if (action === 'check') {
      const h = this.household(String(input.id));
      const fields = input.fields;
      requireThat(
        Array.isArray(fields) &&
          fields.length > 0 &&
          fields.every((f) =>
            ['mobility', 'phoneKind', 'cohabitant', 'consentToCall', 'devices'].includes(String(f)),
          ),
        '확인한 필드를 선택하세요.',
      );
      h.lastCheckedAt = DATA.metadata.referenceDate;
      h.sourceType = String(input.source ?? '담당자');
      this.state.data.checkLogs.push({
        id: `CHECK-${this.state.data.checkLogs.length + 1}`,
        householdId: h.id,
        sourceType: h.sourceType,
        checkedAt: this.state.scenario.displayTime,
        checkedFields: fields as string[],
        changed: null,
        operatorLabel: '시연 담당자',
        evidence: '명시적 모의 확인',
        synthetic: true,
      });
      this.log('30초 모의 확인 저장·출처별 이력 보존', 'human', h.id);
    } else if (action === 'notes-restructure') {
      this.requireRevision(input.revision);
      const h = this.household(String(input.id));
      requireThat(
        !this.state.trips.some((trip) => trip.householdId === h.id),
        '현재 배차 임무의 지원 조건은 담당자 임무 검토 후 수정하세요.',
      );
      const result = parseHouseholdNotes({
        note: h.originalNote,
        health: h.healthNotes,
        mobility: h.mobility,
        age: h.age,
      });
      h.noteExtraction = result;
      h.mobility = {
        independent: '자력',
        assisted: '보조',
        bedridden: '와상',
        unknown: '불명',
      }[result.mobility];
      h.devices = [...new Set([...h.devices, ...result.devices])];
      h.priorityGrade = vulnerability(h);
      this.reconcile();
      this.log('담당자 원문 규칙 재구조화 적용(모의)·근거/불명 보존·확인일 유지', 'human', h.id);
    } else if (action === 'edit') {
      const h = this.household(String(input.id));
      this.requireRevision(input.revision);
      if (input.mobility !== undefined) {
        requireThat(
          ['자력', '보조', '와상', '불명'].includes(String(input.mobility)),
          '거동 입력 오류',
        );
        h.mobility = String(input.mobility);
      }
      if (input.consent !== undefined) {
        requireThat(typeof input.consent === 'boolean', '동의 입력 오류');
        h.consentToCall = input.consent;
        h.callEligible = h.consentToCall && h.phoneKind !== '없음';
        h.exclusionReason = h.callEligible
          ? null
          : h.phoneKind === '없음'
            ? '전화 없음'
            : '동의 없음';
      }
      h.priorityGrade = vulnerability(h);
      this.reconcile();
      this.log('구조화 필드 수정·확인일 유지', 'human', h.id);
    } else if (action === 'family') {
      const s = this.status(String(input.id));
      requireThat(
        ['입원', '시설 입소', '전출', '복귀'].includes(String(input.status)),
        '가족 응답을 확인하세요.',
      );
      s.temporaryExclusion = input.status === '복귀' ? null : String(input.status);
      if (!s.temporaryExclusion) s.status = this.state.plan?.confirmed ? 'queued' : 'before';
      this.reconcile();
      this.log(`가족 모의 응답·${input.status}`, 'human', s.householdId);
    } else if (action === 'transcript') {
      requireThat(this.state.plan?.confirmed, '확정 전 통화 결과를 적용할 수 없습니다.');
      const id = String(input.id),
        key = String(input.eventId ?? `text-${id}-${input.text}`);
      if (this.seen.has(key)) return this.view();
      const text = String(input.text ?? '');
      requireThat(text.length > 0 && text.length <= 2000, '전사는 1~2000자입니다.');
      this.applyClassification(
        id,
        classify(
          text,
          this.state.data.shelters.map((s) => s.name),
        ),
      );
      this.seen.add(key);
      const c = this.state.calls.find((c) => c.targetId === id && c.phase === 'calling');
      if (c) {
        c.text = text;
        if (c.mode === 'mock') {
          c.phase = 'finished';
          c.finishedSim = this.state.simMinutes;
        }
        c.outcome = 'answered';
        this.pump();
      }
    } else if (action === 'member-response') {
      requireThat(this.state.plan?.confirmed, '확정 후 조원 응답을 시연하세요.');
      const c = this.state.calls.find((c) => c.id === input.callId && c.targetType === 'member');
      requireThat(c?.mode === 'mock' && c.phase === 'calling', '현재 모의 조원 통화가 아닙니다.');
      requireThat(
        ['available', 'unavailable', 'noanswer'].includes(String(input.outcome)),
        '조원 응답 입력 오류',
      );
      this.finishMember(c, input.outcome as 'available' | 'unavailable' | 'noanswer');
      this.proposeUnavailableTeams();
      this.pump();
    } else if (action === 'schedule-callback') {
      this.requireRevision(input.revision);
      const id = String(input.id),
        s = this.status(id),
        h = this.household(id);
      requireThat(
        this.state.plan?.confirmed &&
          h.callEligible &&
          !s.temporaryExclusion &&
          ['moving', 'unclear'].includes(s.status),
        '이동·확인 필요 대상만 후속 확인을 예약할 수 있습니다.',
      );
      const minutes = Number(input.minutes);
      requireThat(
        Number.isFinite(minutes) && minutes >= 1 && minutes <= 60,
        '예약 간격은 1~60분입니다.',
      );
      const previous = this.state.calls.findLast((c) => c.targetId === id);
      requireThat(
        previous?.mode !== 'telnyx',
        '실제 통화 후속 발신은 별도 전화 정책을 확인해야 합니다.',
      );
      this.cancelQueuedCalls(id);
      this.queueFollowup(
        previous,
        id,
        s.status === 'moving' ? 'arrival_check' : 'clarification',
        minutes,
      );
      this.log(`담당자 모의 후속 확인 예약 대체·${minutes}분 후`, 'human', id);
    } else if (action === 'advance') {
      requireThat(this.state.plan?.confirmed, '확정 후 모의 결과를 재생하세요.');
      requireThat(!this.state.networkDown, '통신 두절 중 신규 모의 결과 재생을 보류합니다.');
      if (this.state.simulation.cycleId) return this.tickCycle(1);
      this.state.simMinutes++;
      this.state.scenario.displayTime = new Date(
        Date.parse(this.state.scenario.displayTime) + 60000,
      ).toISOString();
      for (const s of this.state.scenario.householdStatuses)
        if (
          s.callbackAtSim != null &&
          s.callbackAtSim <= this.state.simMinutes &&
          !s.temporaryExclusion &&
          this.household(s.householdId).callEligible &&
          !['safe', 'rescued', 'e119'].includes(s.status)
        )
          s.recheckOverdue = true;
      const current = this.state.calls.filter((c) => c.phase === 'calling' && c.mode === 'mock');
      for (const c of current) {
        c.phase = 'finished';
        c.finishedSim = this.state.simMinutes;
        if (c.targetType === 'member') {
          const m = this.state.data.teams
            .flatMap((t) => t.members)
            .find((m) => m.id === c.targetId)!;
          this.finishMember(
            c,
            c.mockOutcome ?? (m.availability === '가능' ? 'available' : 'unavailable'),
          );
          continue;
        }
        const s = this.status(c.targetId);
        if (!this.household(c.targetId).callEligible || s.temporaryExclusion) {
          c.outcome = 'excluded';
          continue;
        }
        const n = Number(c.targetId.slice(1));
        if (n % 7 === 0) {
          s.status = 'noanswer';
          s.note = '모의 무응답·방문/재발신 검토';
          c.outcome = 'noanswer';
          if (
            !this.state.records.some(
              (r) => r.householdId === c.targetId && r.label.startsWith('문자 발송 기록'),
            )
          )
            this.log('문자 발송 기록(모의)·실제 SMS 없음', 'system', c.targetId);
          const retries = c.retryCount ?? Math.max(0, c.attempt - 1);
          if (retries < 8)
            this.queueFollowup(
              c,
              c.targetId,
              'redial',
              retries === 0 ? 0 : retries === 1 ? 1 : retries === 2 ? 2 : 3,
              'resident',
              retries + 1,
            );
          else {
            s.note = '최초 발신 + 추가 8회 종료·이장 연결/방문 확인 대기';
            this.log('재발신 상한 도달·안전 미확인·이장/방문 제안', 'system', c.targetId);
          }
          continue;
        }
        const text =
          n === 12
            ? '숨쉬기 힘들어요'
            : n % 11 === 0
              ? '집을 지킬 거예요. 안 나가요'
              : n % 9 === 0
                ? '차량으로 데리러 와 주세요'
                : n % 5 === 0
                  ? '네'
                  : n % 3 === 0
                    ? '학교에 도착했어요'
                    : '지금 이동 중이에요';
        c.text = text;
        c.outcome = 'answered';
        this.applyClassification(
          c.targetId,
          classify(
            text,
            this.state.data.shelters.map((s) => s.name),
          ),
        );
      }
      this.advanceTrips();
      this.proposeUnavailableTeams();
      this.summarizeFirstPass();
      this.pump();
      this.log('모의 1분 진행·실제 통화 시계와 분리');
    } else if (action === 'leader-request') {
      const id = String(input.id);
      requireThat(
        ['refuse', 'visiting'].includes(this.status(id).status),
        '이장 검토 대상이 아닙니다.',
      );
      if (!this.state.leaderRequested.includes(id)) this.state.leaderRequested.push(id);
      this.status(id).status = 'visiting';
      this.log('이장 연결 요청 (수동 연락·모의 기록)', 'human', id);
    } else if (action === 'leader-result') {
      const id = String(input.id);
      requireThat(this.state.leaderRequested.includes(id), '먼저 이장 연결 요청을 기록하세요.');
      const s = this.status(id);
      requireThat(
        ['이동 확인', '방문 필요', '연락 불가'].includes(String(input.result)),
        '결과를 선택하세요.',
      );
      this.cycleLeaderDue.delete(id);
      s.status = input.result === '이동 확인' ? 'moving' : 'visiting';
      this.cancelQueuedCalls(id);
      if (s.status === 'moving') this.queueFollowup(undefined, id, 'arrival_check', 15);
      s.note = String(input.result);
      this.log(`이장 결과·${input.result} (모의)`, 'human', id);
    } else if (action === 'visit-complete') {
      const h = this.household(String(input.id));
      requireThat(!h.callEligible, '방문 전용 가구가 아닙니다.');
      this.status(h.id).visitCompleted = true;
      this.log('방문 확인 완료 (모의)·전화 안전 분모에서 제외', 'human', h.id);
    } else if (action === 'dispatch') {
      this.dispatch(String(input.id), String(input.vehicleId));
    } else if (action === 'companion') {
      this.requireRevision(input.revision);
      const s = this.status(String(input.id));
      requireThat(
        !s.temporaryExclusion && !['safe', 'rescued'].includes(s.status),
        '완료·제외 대상입니다.',
      );
      requireThat(
        !this.state.trips.some((t) => t.householdId === s.householdId),
        '현재 임무의 탑승 정원은 변경할 수 없습니다.',
      );
      requireThat(
        typeof input.label === 'string' &&
          input.label.trim().length > 0 &&
          input.label.length <= 40,
        '동반자 가상 표시는 1~40자입니다.',
      );
      requireThat(
        ['자력', '보조', '와상', '불명'].includes(String(input.mobility)),
        '동반자 거동을 선택하세요.',
      );
      const key = String(input.companionId ?? `COMPANION-${this.state.revision}`);
      const devices = input.devices ?? [];
      requireThat(
        Array.isArray(devices) &&
          devices.length <= 4 &&
          devices.every((d) => ['들것', '산소', '휠체어', '의료'].includes(String(d))),
        '동반자 장비 입력 오류',
      );
      s.companions ??= [];
      if (!s.companions.some((c) => c.id === key)) {
        requireThat(s.companions.length < 8, '동반자는 최대 8명입니다.');
        s.companions.push({
          id: key,
          label: input.label.trim(),
          mobility: String(input.mobility),
          devices: devices as string[],
        });
        this.log('가상 동반자·거동 저장·정원 재검토', 'human', s.householdId);
      }
    } else if (action === 'road-control') {
      this.requireRevision(input.revision);
      const road = this.state.data.map.roads.find((r) => r.id === input.id);
      requireThat(road && typeof input.blocked === 'boolean', '도로·통제 입력 오류');
      road.blocked = input.blocked;
      this.log(
        `${road.label} ${road.blocked ? '통제' : '통제 해제'} (모의)·현재 임무 재검증`,
        'human',
      );
      this.advanceTrips(false);
    } else if (action === 'reassign-propose') {
      this.requireRevision(input.revision);
      this.proposeReassignment(String(input.id));
    } else if (action === 'reassign-approve' || action === 'reassign-reject') {
      const p = this.state.reassignments.find((p) => p.id === input.id);
      requireThat(p, '재배정 제안이 없습니다.');
      if (p.status !== 'pending') return this.view();
      this.requireRevision(input.revision);
      if (action === 'reassign-reject') {
        p.status = 'rejected';
        this.log('담당자 재배정 제안 반려', 'human', p.householdId);
      } else {
        const candidate = p.candidates.find((c) => c.vehicleId === input.vehicleId);
        requireThat(candidate, '제안의 유효한 후보를 선택하세요.');
        if (candidate.vehicleId === null) {
          this.emergency(p.householdId, '담당자 승인·일반 자원 후보 없음·119 지원 요청(모의)');
          p.status = 'approved';
        } else
          p.status = this.dispatch(p.householdId, candidate.vehicleId) ? 'approved' : 'rejected';
        p.selectedVehicleId = candidate.vehicleId;
        this.log(
          p.status === 'approved'
            ? '담당자 재배정 승인·현재 조건 재검증 후 실행(모의)'
            : '재배정 조건 악화·일반 임무 실행 없음·긴급 후속 조치',
          'human',
          p.householdId,
        );
      }
    } else if (action === 'trip') {
      this.reportTrip(String(input.id), String(input.stage));
    } else if (action === 'trip-resume') {
      this.requireRevision(input.revision);
      const t = this.state.trips.find((t) => t.id === input.id);
      requireThat(t?.heldReason && t.legs, '검증 가능한 보류 임무가 없습니다.');
      requireThat(!this.state.networkDown, '통신 복구 후 검토하세요.');
      const safety = dispatchSafety(this.state, t.householdId),
        s = this.status(t.householdId),
        h = this.household(t.householdId),
        v = this.state.data.vehicles.find((v) => v.id === t.vehicleId)!;
      requireThat(!s.temporaryExclusion, '임시 제외된 현재 임무입니다.');
      requireThat(safety.targetEta !== null && safety.zoneEta !== null, 'ETA 불명·투입 보류');
      if (v.kind !== 'ambulance' && ['depart', 'arrive'].includes(t.stage) && safety.emergency) {
        this.emergency(h.id, '구역/대상 ETA 15분 미만·보류 임무 일반 조 복구 금지');
        this.bump();
        return this.view();
      }
      requireThat(
        this.remainingRoutes(t).every((r) => routeIsOpen(this.state.data.map, r)),
        '기존 경로가 아직 통제 중입니다.',
      );
      requireThat(
        t.crewMemberIds.every((id) => this.state.memberResponses[id] === 'ok'),
        '조원 응답 조건 미충족',
      );
      requireThat(
        transportNeeds(h, s).every((e) => v.equipment.includes(e)),
        '현재 필요 장비 미충족',
      );
      const shelter = this.state.data.shelters.find((x) => x.id === t.shelterId)!;
      requireThat(
        !needsAccessibleShelter(h, s) || shelter.accessibility === 'confirmed',
        '접근성 확인 대피소가 필요합니다.',
      );
      const delay = this.state.simMinutes - (t.heldAtSim ?? this.state.simMinutes);
      for (const key of ['departSim', 'arriveSim', 'boardSim', 'shelterSim', 'returnSim'] as const)
        t[key] += delay;
      t.heldReason = null;
      t.heldAtSim = null;
      s.dispatchHold = null;
      this.log(
        '담당자 보류 임무 복구 승인·기존 경로/ETA/조원/장비 재검증·기존 예약 유지',
        'human',
        h.id,
      );
    } else if (action === 'close') {
      requireThat(input.acknowledged === true, '미해결 인수인계 확인이 필요합니다.');
      requireThat(!this.unresolvedLiveCalls(), '실제 통화 종료/결과 불명을 먼저 확인하세요.');
      this.log(
        `미해결 ${handover(this.state.data.households, this.state.scenario).length}건 인수인계 확인·종료 스냅샷`,
        'human',
      );
      this.state.frozen = true;
      this.state.scenario.mode = 'record';
      this.state.simulation.phase = 'ended';
      this.state.simulation.playing = false;
      this.state.simulation.endReason ??= '담당자 미해결 인수인계 확인 후 종료';
    } else if (action === 'assistant') {
      this.assistant(String(input.text ?? ''), input.revision);
      return this.view();
    } else throw new DomainError('unknown_command', '지원하지 않는 명령입니다.', 400);
    this.refreshUnconfirmedPlan();
    this.bump();
    this.summarizeFirstPass();
    return this.view();
  }
  /** Delta is synthetic minutes, already scaled by the caller's monotonic clock. No timer or dial. */
  tickCycle(deltaMinutes: number): View {
    requireThat(
      Number.isFinite(deltaMinutes) && deltaMinutes >= 0,
      '경과 시간은 유한한 0 이상 분이어야 합니다.',
      'invalid_sim_time',
    );
    const simulation = this.state.simulation;
    if (
      !simulation.cycleId ||
      simulation.phase !== 'running' ||
      !simulation.playing ||
      !this.state.plan?.confirmed ||
      this.state.networkDown ||
      this.state.frozen ||
      this.awaitingPhoneResults() ||
      deltaMinutes === 0
    )
      return this.view();
    const budget = cycleBudget(this.state.simMinutes, deltaMinutes, this.cycleRemainder);
    this.cycleRemainder = budget.remainder;
    if (budget.target === this.state.simMinutes) return this.view();
    this.cycleBaseTime ??=
      Date.parse(this.state.scenario.displayTime) - this.state.simMinutes * 60000;
    this.cycleEventsAndRevision();
    while (this.state.simMinutes < budget.target && simulation.phase === 'running') {
      const next = Math.min(budget.target, this.nextCycleBoundary());
      this.state.simMinutes = cycleTime(next);
      this.state.scenario.displayTime = new Date(
        this.cycleBaseTime + this.state.simMinutes * 60000,
      ).toISOString();
      this.cycleEventsAndRevision();
    }
    return this.view();
  }
  private nextCycleBoundary() {
    const now = this.state.simMinutes;
    const candidates = [Math.floor(now) + 1, 40];
    for (const call of this.state.calls) {
      if (call.mode !== 'mock' || this.state.demonstration?.phoneMode === 'live') continue;
      if (call.phase === 'calling') candidates.push((call.startedSim ?? now) + 1);
      if (
        call.phase === 'calling' &&
        call.targetId === this.state.demonstration?.residentId &&
        this.state.demonstration.stage === 'dialing'
      )
        candidates.push((call.startedSim ?? now) + 0.25);
      if (call.phase === 'queued' && call.nextAt !== null) candidates.push(call.nextAt);
    }
    candidates.push(...this.cycleLeaderDue.values());
    for (const status of this.state.scenario.householdStatuses.filter(
      (status) => status.status === 'help',
    )) {
      const safety = dispatchSafety(this.state, status.householdId);
      if (safety.targetEta !== null && safety.zoneEta !== null)
        candidates.push(
          cycleTime(now + Math.min(safety.targetEta, safety.zoneEta) - 15) + 0.000001,
        );
    }
    for (const trip of this.state.trips) {
      if (trip.heldReason) continue;
      const next = {
        depart: trip.arriveSim,
        arrive: trip.boardSim,
        boarded: trip.shelterSim,
        shelter: trip.returnSim,
        return: Infinity,
      }[trip.stage];
      // Round upward so the existing exact route-time guard is satisfied at this boundary.
      candidates.push(Math.ceil(next * 1_000_000) / 1_000_000);
      if (['depart', 'arrive'].includes(trip.stage)) {
        const vehicle = this.state.data.vehicles.find((vehicle) => vehicle.id === trip.vehicleId)!;
        const safety = dispatchSafety(this.state, trip.householdId);
        if (vehicle.kind !== 'ambulance' && safety.targetEta !== null && safety.zoneEta !== null)
          candidates.push(
            cycleTime(now + Math.min(safety.targetEta, safety.zoneEta) - 15) + 0.000001,
          );
      }
    }
    return Math.min(...candidates.map(cycleTime).filter((time) => time > now));
  }
  private cycleEventStamp() {
    return JSON.stringify({
      records: this.state.records.length,
      sources: this.state.sourceState.records.length,
      calls: this.state.calls,
      trips: this.state.trips,
      completed: this.state.completedTrips,
      statuses: this.state.scenario.householdStatuses,
      simulation: this.state.simulation,
      firstPass: this.state.firstPass,
      demonstration: this.state.demonstration,
    });
  }
  private cycleEventsAndRevision() {
    const before = this.cycleEventStamp();
    const minute = Math.floor(this.state.simMinutes);
    if (minute > this.cycleObservationMinute) {
      this.collectSources();
      this.cycleObservationMinute = minute;
    }
    for (const status of this.state.scenario.householdStatuses)
      if (
        status.callbackAtSim != null &&
        status.callbackAtSim <= this.state.simMinutes &&
        !status.temporaryExclusion &&
        !['safe', 'rescued', 'e119'].includes(status.status)
      )
        status.recheckOverdue = true;
    for (const call of this.state.calls.filter(
      (call) =>
        this.state.demonstration?.phoneMode !== 'live' &&
        call.mode === 'mock' &&
        call.phase === 'calling' &&
        (call.startedSim ?? this.state.simMinutes) + 1 <= this.state.simMinutes,
    ))
      this.finishCycleCall(call);
    this.advanceTrips();
    this.proposeUnavailableTeams();
    this.cycleLeaderContacts();
    this.dispatchCycleCandidates();
    this.summarizeFirstPass();
    this.pump();
    const runnable =
      this.state.calls.some(
        (call) =>
          this.state.demonstration?.phoneMode !== 'live' &&
          call.mode === 'mock' &&
          ['calling', 'queued'].includes(call.phase),
      ) ||
      this.state.trips.some((trip) => !trip.heldReason) ||
      this.cycleLeaderDue.size > 0;
    if (!this.unresolvedLiveCalls() && (this.state.simMinutes >= 40 || !runnable)) {
      this.state.simulation.phase = 'awaiting_handover';
      this.state.simulation.playing = false;
      this.state.simulation.endReason =
        this.state.simMinutes >= 40
          ? '합성 40분 도달·미해결·방문·보류 임무의 담당자 인수인계 필요'
          : '자동 합성 업무 정리·미해결·방문의 담당자 인수인계 필요';
      this.cycleRemainder = 0;
      this.log(`합성 cycle 정지·${this.state.simulation.endReason}`);
    }
    if (before !== this.cycleEventStamp()) this.bump();
  }
  private finishCycleCall(call: Call) {
    if (this.state.demonstration?.phoneMode === 'live') return;
    call.phase = 'finished';
    call.finishedSim = this.state.simMinutes;
    if (call.targetType === 'member') {
      const member = this.state.data.teams
        .flatMap((team) => team.members)
        .find((member) => member.id === call.targetId)!;
      this.finishMember(
        call,
        call.mockOutcome ?? (member.availability === '가능' ? 'available' : 'unavailable'),
      );
      if (call.targetId === this.state.demonstration?.memberId) {
        call.text = '[합성 cycle 허구 대원 발화] 네, 가능합니다. 구조 요청 확인했습니다.';
        this.demoMessage(
          'member',
          this.state.memberResponses[call.targetId] === 'ok'
            ? '네, 가능합니다. 구조 요청 확인했습니다.'
            : '현재 출동할 수 없습니다. 다른 검토가 필요합니다.',
        );
      }
      return;
    }
    const household = this.household(call.targetId),
      status = this.status(call.targetId);
    if (!household.callEligible || status.temporaryExclusion) {
      call.outcome = 'excluded';
      return;
    }
    const n = Number(call.targetId.slice(1));
    if (call.targetId === this.state.demonstration?.residentId) {
      if (this.state.trips.some((trip) => trip.householdId === household.id)) {
        call.text = '[합성 cycle 허구 발화] 차량 수송 중·대피소 도착은 아직 미확인';
        call.outcome = 'answered';
        return;
      }
      const text = '다리가 아파서 움직일 수 없어요. 차량으로 데리러 와 주세요';
      call.text = `[합성 cycle 허구 발화] ${text}`;
      call.outcome = 'answered';
      this.applyClassification(
        household.id,
        classify(
          call.text,
          this.state.data.shelters.map((shelter) => shelter.name),
        ),
      );
      this.state.demonstration.stage = 'requested';
      this.demoMessage('resident', text);
      this.demoMessage(
        'assistant',
        '구조 요청을 확인했습니다. 장비·대원·차량·경로를 검증하고 연결하겠습니다.',
      );
      return;
    }
    if (n % 7 === 0) {
      call.outcome = 'noanswer';
      call.text = '[합성 cycle 허구 응답] 무응답';
      status.status = 'noanswer';
      status.note = '합성 cycle 무응답·안전 미확인·재발신/이장 방문 검토';
      const retries = call.retryCount ?? 0;
      if (retries < 8)
        this.queueFollowup(
          call,
          call.targetId,
          'redial',
          retries === 0 ? 0 : retries === 1 ? 1 : retries === 2 ? 2 : 3,
          'resident',
          retries + 1,
        );
      else {
        status.note = '합성 cycle 추가 8회 종료·안전 미확인·이장/방문 인수인계';
        this.log('합성 cycle 재발신 상한·담당자 방문/이장 검토 필요', 'system', household.id);
      }
      this.log(`합성 cycle 무응답 ${call.attempt}회 (실제 발신 없음)`, 'system', household.id);
      return;
    }
    const shelter = this.state.data.shelters.find((shelter) => shelter.id === household.shelterId)!;
    const text =
      call.purpose === 'arrival_check'
        ? `${shelter.name}에 도착했어요`
        : call.purpose === 'clarification'
          ? household.mobility === '자력' && household.devices.length === 0
            ? '지금 이동 중이에요'
            : '차량으로 데리러 와 주세요'
          : n === 12
            ? '숨쉬기 힘들어요'
            : n % 11 === 0
              ? '집을 지킬 거예요. 안 나가요'
              : n % 9 === 0 || household.mobility !== '자력' || household.devices.length > 0
                ? '차량으로 데리러 와 주세요'
                : n % 5 === 0
                  ? '네'
                  : '지금 이동 중이에요';
    call.text = `[합성 cycle 허구 발화] ${text}`;
    call.outcome = 'answered';
    this.applyClassification(
      household.id,
      classify(
        call.text,
        this.state.data.shelters.map((shelter) => shelter.name),
      ),
    );
    this.log(
      `합성 cycle ${call.purpose ?? 'initial'} 현재 발화 근거 · ${text}`,
      'system',
      household.id,
    );
  }
  private dispatchCycleCandidates() {
    const targets = this.state.scenario.householdStatuses
      .filter(
        (status) =>
          ['help', 'e119'].includes(status.status) &&
          !status.temporaryExclusion &&
          !this.state.trips.some((trip) => trip.householdId === status.householdId),
      )
      .sort(
        (a, b) =>
          Number(b.householdId === this.state.demonstration?.residentId) -
            Number(a.householdId === this.state.demonstration?.residentId) ||
          Number(b.status === 'e119') - Number(a.status === 'e119') ||
          a.householdId.localeCompare(b.householdId),
      );
    for (const status of targets) {
      const household = this.household(status.householdId),
        safety = dispatchSafety(this.state, household.id);
      const demonstration = this.state.demonstration,
        hero = household.id === demonstration?.residentId;
      if (hero && this.isLiveStoryTarget(household.id) && !this.phoneDispatchReady(household.id))
        continue;
      const heroWaiting =
        demonstration && ['ready', 'dialing', 'talking', 'requested'].includes(demonstration.stage);
      const protectedCrew = new Set(
        heroWaiting
          ? demonstration.story === 'squad'
            ? this.state.data.teams
                .find((team) => team.id === 'TW')!
                .members.map((member) => member.id)
            : [
                this.state.data.vehicles.find((vehicle) => vehicle.id === demonstration.vehicleId)!
                  .driverRef,
              ]
          : [],
      );
      if (
        !safety.emergency &&
        this.state.reassignments.some((proposal) => proposal.householdId === household.id)
      )
        continue;
      if (safety.emergency && status.status !== 'e119')
        this.emergency(
          household.id,
          '합성 cycle 구역/대상 ETA 15분 미만·119 모의 인계·일반 조 대체 금지',
        );
      const candidates = this.state.data.vehicles.filter(
        (vehicle) =>
          vehicle.availableForTransport &&
          (hero
            ? vehicle.id === demonstration!.vehicleId
            : (!heroWaiting || vehicle.id !== demonstration!.vehicleId) &&
              (safety.emergency
                ? vehicle.kind === 'ambulance'
                : vehicle.kind !== 'ambulance' &&
                  (!vehicle.teamId || vehicle.teamId === household.teamId))),
      );
      const checks = candidates.map((vehicle) => ({
        vehicle,
        check: evaluateDispatch(this.state, household.id, vehicle.id),
      }));
      const valid = checks.find(
        ({ check }) =>
          check.ok && (hero || !check.trip.crewMemberIds.some((id) => protectedCrew.has(id))),
      );
      if (valid) {
        this.dispatch(household.id, valid.vehicle.id);
        if (hero) {
          demonstration!.stage = 'responding';
          this.demoMessage(
            'assistant',
            demonstration!.story === 'grandfather'
              ? '검증된 구급차를 보내드리겠습니다. 구조 요청 통화를 종료합니다.'
              : '반영환 대원의 가능 응답과 수송 조건을 확인했습니다. 5분 대기조를 보내드리겠습니다.',
          );
        }
      } else {
        const failure = checks.find(({ check }) => !check.ok)?.check;
        const reason = `합성 cycle 배차 보류 · ${failure && !failure.ok ? failure.reason : '조건을 만족하는 수송 자원 없음'}`;
        if (status.dispatchHold !== reason) {
          status.dispatchHold = reason;
          this.log(reason, 'system', household.id);
        }
      }
    }
  }
  private demoMessage(speaker: 'assistant' | 'resident' | 'member', text: string) {
    const demonstration = this.state.demonstration;
    if (
      !demonstration ||
      demonstration.phoneMode === 'live' ||
      demonstration.messages.some(
        (message) =>
          message.speaker === speaker &&
          message.text === `[합성 시연 텍스트·실모델/음성통화 아님] ${text}`,
      )
    )
      return;
    demonstration.messages.push({
      id: `${this.state.simulation.cycleId}-MESSAGE-${demonstration.messages.length + 1}`,
      speaker,
      text: `[합성 시연 텍스트·실모델/음성통화 아님] ${text}`,
      atSim: this.state.simMinutes,
    });
    this.log(`합성 cycle ${speaker} 발화 · ${text}`, 'system', demonstration.residentId);
  }
  private syncDemonstration() {
    const demonstration = this.state.demonstration;
    if (!demonstration || demonstration.phoneMode === 'live') return;
    const call = this.state.calls.find(
      (call) =>
        call.mode === 'mock' &&
        call.targetId === demonstration.residentId &&
        call.phase === 'calling',
    );
    if (call && demonstration.stage === 'ready') demonstration.stage = 'dialing';
    if (
      call &&
      demonstration.stage === 'dialing' &&
      this.state.simMinutes >= (call.startedSim ?? this.state.simMinutes) + 0.25
    ) {
      demonstration.stage = 'talking';
      this.demoMessage(
        'assistant',
        `${this.household(demonstration.residentId).name}님, 합성 화재 대피 안내입니다. 이동할 수 있으세요?`,
      );
    }
    const memberCall = this.state.calls.find(
      (call) =>
        call.mode === 'mock' &&
        call.targetId === demonstration.memberId &&
        call.phase === 'calling',
    );
    if (demonstration.story === 'squad' && memberCall)
      this.demoMessage(
        'assistant',
        '반영환 대원, 박미숙 할머니 구조 요청입니다. 5분 대기조 출동이 가능하세요?',
      );
  }
  private cycleLeaderContacts() {
    if (this.state.demonstration?.phoneMode === 'live') return;
    for (const status of this.state.scenario.householdStatuses) {
      if (status.temporaryExclusion) continue;
      if (this.isLiveStoryTarget(status.householdId)) continue;
      if (
        this.state.calls.some(
          (call) =>
            call.targetId === status.householdId &&
            call.mode === 'telnyx' &&
            call.phase !== 'finished',
        )
      )
        continue;
      const last = this.state.calls.findLast((call) => call.targetId === status.householdId);
      if (
        status.status === 'refuse' &&
        last?.mode === 'mock' &&
        !this.state.leaderRequested.includes(status.householdId)
      ) {
        this.state.leaderRequested.push(status.householdId);
        this.cycleLeaderDue.set(status.householdId, cycleTime(this.state.simMinutes + 1));
        status.status = 'visiting';
        status.note = '합성 cycle 이장 연결 중·1분 뒤 허구 연락 결과·실제 연락 없음';
        this.log(
          '합성 cycle 이장 연결 시작·1분 뒤 허구 완료 예약·실제 연락 없음',
          'system',
          status.householdId,
        );
      }
      const due = this.cycleLeaderDue.get(status.householdId);
      if (due !== undefined && due <= this.state.simMinutes) {
        this.cycleLeaderDue.delete(status.householdId);
        if (status.temporaryExclusion || ['safe', 'rescued', 'e119'].includes(status.status))
          continue;
        status.status = 'moving';
        status.note = '합성 cycle 이장 허구 연락 완료·지금 이동 중 발화·도착 미확인';
        this.cancelQueuedCalls(status.householdId);
        this.queueFollowup(undefined, status.householdId, 'arrival_check', 15);
        this.log(
          '합성 cycle 이장 허구 연락 완료·이동 발화·15분 뒤 도착 재확인·실제 이장 연락 없음',
          'system',
          status.householdId,
        );
      }
    }
  }
  private reconcile() {
    for (const c of this.state.calls)
      if (
        c.targetType === 'resident' &&
        c.phase === 'queued' &&
        (!this.household(c.targetId).callEligible || this.status(c.targetId).temporaryExclusion)
      ) {
        c.phase = 'finished';
        c.outcome = 'excluded';
        c.finishedSim = this.state.simMinutes;
      }
    for (const s of this.state.scenario.householdStatuses)
      if (!this.household(s.householdId).callEligible || s.temporaryExclusion) {
        s.callbackAtSim = null;
        s.recheckOverdue = false;
      }
    this.refreshUnconfirmedPlan();
    if (this.state.plan?.confirmed) {
      for (const h of this.state.data.households) {
        const s = this.status(h.id);
        if (
          h.callEligible &&
          this.state.demonstration?.phoneMode !== 'live' &&
          !s.temporaryExclusion &&
          s.status === 'queued' &&
          !this.state.calls.some((c) => c.targetId === h.id && c.phase !== 'finished')
        )
          this.state.calls.push({
            id: `CALL-${h.id}-rev${this.state.revision}`,
            targetId: h.id,
            targetType: 'resident',
            attempt: s.attemptCount + 1,
            phase: 'queued',
            nextAt: null,
            text: '',
            providerId: null,
            mode: 'mock',
          });
      }
    }
    this.pump();
  }
  private collectSources() {
    const state = this.state.sourceState;
    state.wallNow = new Date().toISOString();
    for (const source of this.state.data.sources) {
      const failed = state.records.findLast(
        (r) => r.sourceId === source.id && r.mode === 'live' && !r.ok,
      );
      const cycleId = this.state.simulation.cycleId;
      const sample = cycleId
        ? {
            ...source,
            demoPayload: {
              ...source.demoPayload,
              observedAt: this.state.scenario.displayTime,
              summary: `합성 cycle 관측 · ${source.demoPayload.summary}`,
              ...(source.id === 'SRC05'
                ? {
                    windDirection: this.state.data.map.wind.direction,
                    windSpeedMps: this.state.data.map.wind.speedMps,
                  }
                : {}),
            },
          }
        : source;
      const record = createReplaySourceRecord(sample, {
        recordId: `SOURCE-${this.state.scenario.id}-${state.records.length + 1}`,
        scenarioId: this.state.scenario.id,
        datasetId: DEMO_DATASET,
        referenceDate: this.state.data.metadata.referenceDate,
        fetchedAtWall: state.wallNow,
        fetchedAtReplay: this.state.scenario.displayTime,
        jurisdictions: [DEMO_JURISDICTION],
        ...(cycleId
          ? { sampleId: `${cycleId}:합성 cycle 관측:${this.state.simMinutes}:${source.id}` }
          : {}),
        ...(failed ? { fallbackForRecordId: failed.recordId } : {}),
      });
      state.records = appendSourceAttempt(state.records, record);
    }
    for (const { source, status } of sourceReadings(this.state)) {
      const legacy = this.state.scenario.sourceStatuses.find((s) => s.sourceId === source.id)!;
      legacy.status = status?.status === 'replay' ? 'ok' : (status?.status ?? 'unknown');
      legacy.observedAt = status?.observedAt ?? '';
    }
  }
  private dispatch(id: string, vehicleId: string): boolean {
    requireThat(
      !this.isLiveStoryTarget(id) || this.phoneDispatchReady(id),
      '실전화 종료와 이동 지원 요청이 확인된 뒤 배차하세요.',
      'phone_result_required',
    );
    const v = this.state.data.vehicles.find((v) => v.id === vehicleId);
    requireThat(v?.availableForTransport, '수송 불가 자원입니다.');
    const check = evaluateDispatch(this.state, id, vehicleId);
    if (!check.ok) {
      // A validated urgent signal is an accepted, recorded hold, never a partial failed mutation.
      const s = this.status(id),
        safety = dispatchSafety(this.state, id);
      if (
        this.state.plan?.confirmed &&
        !this.state.networkDown &&
        !s.temporaryExclusion &&
        !['safe', 'rescued'].includes(s.status) &&
        safety.emergency &&
        safety.targetEta !== null &&
        safety.zoneEta !== null
      ) {
        this.emergency(id, `응급/구역 또는 대상 ETA 15분 미만·일반 조 투입 금지 · ${check.reason}`);
        s.dispatchHold = check.reason;
        this.log(`배차 보류(모의)·${check.reason}`, 'system', id);
        return false;
      }
      throw new DomainError(check.code, check.reason);
    }
    const urgent = dispatchSafety(this.state, id).emergency;
    if (urgent)
      this.emergency(id, '응급/구역 또는 대상 ETA 15분 미만·119 자동 모의 인계·의료 수송');
    this.cancelQueuedCalls(id, 'answered');
    this.state.trips.push({
      id: `TRIP-${this.state.revision}-${id}`,
      ...check.trip,
      stage: 'depart',
      heldReason: null,
      heldAtSim: null,
    });
    const s = this.status(id);
    s.status = urgent ? 'e119' : 'dispatched';
    s.dispatchHold = null;
    s.recheckOverdue = false;
    const resource = this.state.scenario.resourceStatuses.find((x) => x.vehicleId === vehicleId);
    if (resource) {
      resource.status = 'enroute';
      resource.householdId = id;
    }
    this.log(
      `검증 후 모의 배차·${check.trip.passengerCount}명·가구/조/차량/운전자/대피소 정원 예약`,
      'system',
      id,
    );
    return true;
  }
  private proposeReassignment(id: string) {
    requireThat(
      this.state.plan?.confirmed && !this.state.networkDown,
      '확정·통신 상태를 확인하세요.',
    );
    const h = this.household(id),
      s = this.status(id);
    requireThat(
      !s.temporaryExclusion &&
        !['safe', 'rescued'].includes(s.status) &&
        !this.state.trips.some((t) => t.householdId === id),
      '완료·제외·현재 임무 대상입니다.',
    );
    if (dispatchSafety(this.state, id).emergency) {
      this.emergency(id, '응급/구역 또는 대상 ETA 15분 미만·재배정 승인을 기다리지 않는 모의 인계');
      return;
    }
    if (this.state.reassignments.some((p) => p.householdId === id && p.status === 'pending'))
      return;
    const origin = this.state.data.teams.find((t) => t.id === h.teamId)!.meetingPoint;
    const adjacent = this.state.data.teams
      .filter((t) => t.id !== h.teamId)
      .sort(
        (a, b) =>
          Math.hypot(a.meetingPoint.x - origin.x, a.meetingPoint.y - origin.y) -
            Math.hypot(b.meetingPoint.x - origin.x, b.meetingPoint.y - origin.y) ||
          a.id.localeCompare(b.id),
      );
    const ordered = [
      ...adjacent.flatMap((t) => this.state.data.vehicles.filter((v) => v.teamId === t.id)),
      ...this.state.data.vehicles.filter((v) => !v.teamId && v.kind !== 'ambulance'),
    ];
    const candidates: Reassignment['candidates'] = ordered
      .filter((v) => evaluateDispatch(this.state, id, v.id).ok)
      .map((v) => ({
        vehicleId: v.id,
        teamId: v.teamId ?? h.teamId,
        reason: v.teamId
          ? '인접 조 · 집결지 거리 순 · 현재 조건 검증'
          : '면 차량 · 확인된 운전자/지원 인원 · 현재 조건 검증',
      }));
    candidates.push({
      vehicleId: null,
      teamId: null,
      reason: '119 지원 요청(모의) · 일반 자원 미충족 시 후속 지원',
    });
    this.state.reassignments.push({
      id: `REASSIGN-${this.state.revision}-${id}`,
      householdId: id,
      fromTeamId: h.teamId,
      snapshotRevision: this.state.revision + 1,
      status: 'pending',
      candidates,
    });
    this.log(
      '재배정 후보 제안·인접 조 → 면 차량 → 119 지원·담당자 승인 전 실행 없음',
      'assistant',
      id,
    );
  }
  private remainingRoutes(t: Trip) {
    return t.stage === 'shelter'
      ? [t.legs.returning]
      : t.stage === 'boarded'
        ? [t.legs.shelter, t.legs.returning]
        : Object.values(t.legs);
  }
  private holdTrip(t: Trip, reason: string, emergency = false) {
    t.heldReason = reason;
    t.heldAtSim = this.state.simMinutes;
    this.status(t.householdId).dispatchHold = reason;
    if (emergency) this.emergency(t.householdId, reason);
    this.log(`현재 임무 보류(모의)·${reason}`, 'system', t.householdId);
  }
  private advanceTrips(progress = true) {
    for (const t of [...this.state.trips]) {
      if (t.heldReason || !t.legs) continue;
      const remaining = this.remainingRoutes(t);
      const v = this.state.data.vehicles.find((v) => v.id === t.vehicleId)!;
      const safety = dispatchSafety(this.state, t.householdId);
      const unknown = safety.targetEta === null || safety.zoneEta === null;
      const unsafe =
        ['depart', 'arrive'].includes(t.stage) && v.kind !== 'ambulance' && safety.emergency;
      const excluded = this.status(t.householdId).temporaryExclusion;
      if (
        excluded ||
        unknown ||
        unsafe ||
        remaining.some((r) => !routeIsOpen(this.state.data.map, r))
      ) {
        const reason = excluded
          ? '임시 제외·현재 임무 담당자 확인'
          : unknown
            ? '구역/대상 ETA 불명·현재 임무 보류'
            : unsafe
              ? '구역/대상 ETA 15분 미만·일반 조 임무 보류'
              : '경로 통제 변경·현재 위치 유지·후속 검토';
        this.holdTrip(t, reason, unsafe);
        continue;
      }
      if (!progress) continue;
      while (this.state.trips.includes(t) && !t.heldReason) {
        const next = (
          {
            depart: ['arrive', t.arriveSim],
            arrive: ['boarded', t.boardSim],
            boarded: ['shelter', t.shelterSim],
            shelter: ['return', t.returnSim],
            return: ['', Infinity],
          } as const
        )[t.stage];
        if (this.state.simMinutes < next[1]) break;
        try {
          this.reportTrip(t.id, next[0], 'system');
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          this.holdTrip(t, error.message);
        }
      }
    }
  }
  private reportTrip(id: string, stage: string, actor = 'human') {
    const previous = this.state.completedTrips.find((t) => t.id === id);
    if (previous && stage === 'return') return;
    const t = this.state.trips.find((t) => t.id === id);
    requireThat(t, '현재 임무가 없습니다.');
    if (t.stage === stage) return;
    requireThat(!t.heldReason && t.legs, '보류 임무의 조건·경로를 먼저 확인하세요.');
    const stages = ['depart', 'arrive', 'boarded', 'shelter', 'return'];
    requireThat(
      stages.indexOf(stage) === stages.indexOf(t.stage) + 1,
      '현재 임무의 다음 단계만 보고하세요.',
    );
    const route =
      stage === 'arrive' ? t.legs.pickup : stage === 'return' ? t.legs.returning : t.legs.shelter;
    requireThat(routeIsOpen(this.state.data.map, route), '최신 통제 경로가 유효하지 않습니다.');
    const s = this.status(t.householdId),
      h = this.household(t.householdId);
    requireThat(!s.temporaryExclusion, '임시 제외된 현재 임무·담당자 확인 필요');
    if (stage === 'boarded') {
      const v = this.state.data.vehicles.find((v) => v.id === t.vehicleId)!;
      const safety = dispatchSafety(this.state, t.householdId);
      requireThat(safety.targetEta !== null && safety.zoneEta !== null, 'ETA 불명·탑승 보류');
      if (v.kind !== 'ambulance' && safety.emergency) {
        this.holdTrip(t, '구역/대상 ETA 15분 미만·일반 조 탑승 보류', true);
        return;
      }
      requireThat(
        transportNeeds(h, s).every((device) => v.equipment.includes(device)) &&
          t.crewMemberIds.every((id) => this.state.memberResponses[id] === 'ok'),
        '탑승 직전 장비/조원 조건 변경·보류',
      );
      s.status = s.handoffStatus ? 'e119' : 'moving';
    }
    if (stage === 'shelter') {
      const shelter = this.state.data.shelters.find((x) => x.id === t.shelterId)!;
      requireThat(
        !needsAccessibleShelter(h, s) || shelter.accessibility === 'confirmed',
        '접근성 확인 대피소가 필요합니다.',
      );
      const admitted = this.state.shelterAdmissions
        .filter((a) => a.shelterId === t.shelterId && a.householdId !== h.id)
        .reduce((n, a) => n + a.passengerCount, 0);
      const reserved = this.state.trips
        .filter((x) => x.id !== t.id && x.shelterId === t.shelterId && x.stage !== 'shelter')
        .reduce((n, x) => n + x.passengerCount, 0);
      requireThat(
        admitted + reserved + t.passengerCount <= shelter.capacity,
        '대피소 정원 변경·도착 확인 보류',
      );
      if (!this.state.shelterAdmissions.some((a) => a.householdId === h.id))
        this.state.shelterAdmissions.push({
          householdId: h.id,
          shelterId: t.shelterId,
          passengerCount: t.passengerCount,
          tripId: t.id,
        });
      s.status = 'rescued';
      s.dispatchHold = null;
      s.recheckOverdue = false;
      s.note = '현재 모의 임무·검증된 경로의 대피소 도착 보고 근거';
    }
    if (this.state.demonstration?.residentId === h.id) {
      if (stage === 'arrive') this.state.demonstration.stage = 'boarding';
      if (stage === 'boarded') this.state.demonstration.stage = 'evacuating';
      if (
        stage === 'shelter' &&
        this.state.shelterAdmissions.some(
          (admission) => admission.householdId === h.id && admission.tripId === t.id,
        )
      ) {
        this.state.demonstration.stage = 'completed';
        this.demoMessage(
          'assistant',
          '검증된 합성 임무의 대피소 도착 보고를 확인했습니다. 주민 대피·대원 구조 완료입니다. 차량 복귀는 계속됩니다.',
        );
      }
    }
    t.stage = stage as Trip['stage'];
    const resource = this.state.scenario.resourceStatuses.find((x) => x.vehicleId === t.vehicleId);
    if (resource)
      resource.status =
        stage === 'boarded'
          ? 'transporting'
          : stage === 'shelter'
            ? 'returning'
            : stage === 'return'
              ? 'free'
              : 'enroute';
    if (stage === 'return') {
      this.state.completedTrips.push(structuredClone(t));
      this.state.trips = this.state.trips.filter((x) => x.id !== id);
      if (resource) resource.householdId = null;
    }
    this.log(
      `현재 임무 단계 ${stage} (모의)·${actor === 'system' ? '검증된 경로/시간 재생' : '담당자 보고'}`,
      actor,
      t.householdId,
    );
  }
  private assistant(text: string, revision?: unknown) {
    requireThat(
      text.trim().length > 0 && text.length <= 500,
      '도우미 입력은 1~500자입니다.',
      'invalid_input',
    );
    const request = text.trim().replace(/\s+/gu, ' '),
      guidance =
        '구역별 조치, 몇 집 남았나, 자원 현황, 12번 가구 1순위, 통신 두절 또는 통신 복구를 입력하세요. 발령 확정·이장 연결·재배정은 담당자 결정 버튼을 사용하세요.',
      comms = request.match(/^통신\s*(두절|복구)(?:\s*시연)?[.!]?$/u),
      priority = request.match(
        /^(\d{1,3})번\s*가구(?:를)?\s*1순위(?:로)?(?:\s*(?:해\s*줘|해\s*주세요|변경(?:해\s*줘|해\s*주세요)?|수정(?:해\s*줘|해\s*주세요)?))?[.!]?$/u,
      );
    if (comms) {
      const down = comms[1] === '두절';
      this.command('comms', { down });
      this.state.assistantAnswer = down
        ? '통신 두절 시연을 적용했습니다. 신규 실행을 보류하고 기존 통화·임무를 유지합니다.'
        : '통신 복구 시연을 적용했습니다. 기존 통화·임무를 보존하고 미실행 큐를 재개합니다.';
    } else if (priority) {
      const id = 'H' + String(Number(priority[1])).padStart(3, '0'),
        p = this.state.plan;
      if (!p || p.confirmed || !p.order.some((x) => x.householdId === id)) {
        this.state.assistantAnswer =
          '미확정 계획의 유효한 전화 대상을 입력하세요. 확정 후 순서·배차 변경은 담당자가 후속 제안을 검토해야 합니다.';
        return;
      }
      this.command('reorder', {
        revision,
        ids: [id, ...p.order.filter((x) => x.householdId !== id).map((x) => x.householdId)],
      });
      this.state.assistantAnswer = `${id}를 1순위로 수정했습니다. 발령 확정은 담당자 버튼에서 진행하세요.`;
    } else if (/자원/u.test(request)) {
      const members = this.state.data.teams.flatMap((t) => t.members),
        tripByVehicle = new Map(this.state.trips.map((t) => [t.vehicleId, t])),
        resources = this.state.data.vehicles.map((vehicle) => {
          const trip = tripByVehicle.get(vehicle.id),
            seeded = this.state.scenario.resourceStatuses.find((s) => s.vehicleId === vehicle.id),
            status = trip
              ? trip.stage === 'boarded'
                ? 'transporting'
                : trip.stage === 'shelter'
                  ? 'returning'
                  : trip.stage === 'return'
                    ? 'free'
                    : 'enroute'
              : (seeded?.status ?? 'unavailable');
          return { vehicle, trip, status };
        }),
        // Each vehicle has one reservation even when the scenario also mirrors its live trip.
        reservations = resources.filter((r) => r.trip || r.status !== 'free'),
        occupied = reservations.filter((r) => r.trip || r.status !== 'unavailable'),
        reservedMembers = new Set(
          occupied.flatMap((r) => r.trip?.crewMemberIds ?? [r.vehicle.driverRef]),
        ),
        responseCount = (response: 'waiting' | 'ok' | 'no') =>
          members.filter((m) => (this.state.memberResponses[m.id] ?? 'waiting') === response)
            .length,
        freeMembers = members.filter(
          (m) =>
            m.availability === '가능' &&
            this.state.memberResponses[m.id] === 'ok' &&
            !reservedMembers.has(m.id),
        ).length,
        transport = resources.filter((r) => r.vehicle.availableForTransport),
        phaseCount = (phase: string) => transport.filter((r) => r.status === phase).length,
        unavailable = resources.filter(
          (r) =>
            !r.vehicle.availableForTransport ||
            !['free', 'enroute', 'transporting', 'returning'].includes(r.status),
        ).length;
      this.state.assistantAnswer = `수송 자원 ${transport.length}개·진화 전용 ${resources.filter((r) => r.vehicle.kind === 'pump').length}개. 차량 대기 ${phaseCount('free')}개·출동 ${phaseCount('enroute')}개·수송 중 ${phaseCount('transporting')}개·복귀 중 ${phaseCount('returning')}개·사용 불가 ${unavailable}개. 조원 가능 응답 ${responseCount('ok')}/${members.length}명·응답 대기 ${responseCount('waiting')}명·불가 응답 ${responseCount('no')}명, 미예약 가능 ${freeMembers}명. 현재 예약 ${occupied.length}건. 배차 전 장비·운전자·조원·접근성·ETA 검증이 필요합니다.`;
    } else {
      const zoneMatches = [...request.matchAll(/(북|동|남|서)\s*구역/gu)],
        zoneNames = [...new Set(zoneMatches.map((m) => m[1]))];
      if (zoneNames.length === 1) {
        const name = zoneNames[0],
          zone = { 북: 'N', 동: 'E', 남: 'S', 서: 'W' }[name],
          households = this.state.data.households.filter((h) => h.zoneId === zone),
          actions = households.filter((h) => groupOf(h, this.status(h.id)) === 'act'),
          visits = households.filter((h) => {
            const s = this.status(h.id);
            return groupOf(h, s) === 'visit' && !s.visitCompleted;
          }),
          list = (items: typeof households) =>
            items.map((h) => `${h.id} ${h.name}`).join(', ') || '없음';
        this.state.assistantAnswer = `${name} 구역 조치 필요 ${actions.length}가구: ${list(actions)}. 미완료 방문 ${visits.length}가구: ${list(visits)}.`;
      } else if (zoneNames.length === 0 && /남았|현황/u.test(request)) {
        const c = tally(this.state.data.households, this.state.scenario.householdStatuses),
          visits = this.state.scenario.householdStatuses.filter(
            (s) => groupOf(this.household(s.householdId), s) === 'visit' && !s.visitCompleted,
          ).length;
        this.state.assistantAnswer = `전화 대상 ${c.eligible - c.safe}가구와 미완료 방문 ${visits}가구가 남았습니다. 임시 제외 ${c.temporarilyExcluded}가구는 별도입니다.`;
      } else this.state.assistantAnswer = guidance;
    }
  }
}
