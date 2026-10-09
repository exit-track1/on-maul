import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigStore, writePrivate } from './config.ts';
import { AppError, completionBlocked } from './domain.ts';
import { classifyEvacuation, type Transcript } from './evacuation.ts';
import type { Report } from './calls.ts';
import type { CallOutcome } from './call-outcomes.ts';
type Household = {
  id: string;
  name: string;
  age: number;
  mobility: string;
  priorityGrade: number;
  callEligible: boolean;
  consentToCall: boolean;
  shelterId: string;
  status: string;
  location: string;
  emergency: boolean;
};
type LinkedCall = {
  id: string;
  targetId: string;
  scenario: 'resident' | 'standby';
  transport: 'telnyx' | 'browser';
  state: 'prepared' | 'bound' | 'ended';
  sessionId: string | null;
  attempts: number;
  nextRetryAt: number | null;
};
type ControlState = {
  phase: string;
  households: Household[];
  teams: { id: string; name: string; available: boolean }[];
  vehicles: { id: string; name: string; capacity: number; teamId: string; available: boolean }[];
  shelters: { id: string; name: string; capacity: number; open: boolean }[];
  sources: unknown[];
  calls: LinkedCall[];
  priority: string[];
  audit: { at: number; action: string; detail: string }[];
  runs: {
    callId: string;
    targetId: string;
    nodes: string[];
    model: string;
    evidence: string;
    result: string;
  }[];
  dispatches: { id: string; targetId: string; vehicleId: string; stage: string }[];
  contacts: {
    targetId: string;
    scenario: 'resident' | 'standby';
    attempts: number;
    nextRetryAt: number | null;
    sms: number;
    status: string;
  }[];
  followUps: {
    callId: string;
    targetId: string | null;
    kind: 'rescue' | 'moving' | 'refused' | 'review';
    location: string;
    evidence: string;
    reason: string;
    emergency: boolean;
    status:
      'needs_assignment' | 'guidance_requested' | 'elder_contact_requested' | 'review_requested';
    createdAt: number;
    playbackConfirmed: boolean;
  }[];
};
const GraphState = Annotation.Root({
  text: Annotation<string>(),
  context: Annotation<Transcript[]>(),
  result: Annotation<Report | null>(),
  nodes: Annotation<string[]>({ default: () => [], reducer: (a, b) => a.concat(b) }),
});
export class DisasterEngine {
  state: ControlState;
  store: ConfigStore;
  path: string;
  fetcher: typeof fetch;
  graph: ReturnType<typeof createGraph>;
  constructor(root: string, directory: string, store: ConfigStore, fetcher: typeof fetch = fetch) {
    this.path = join(directory, 'control-room.json');
    this.store = store;
    this.fetcher = fetcher;
    const read = (name: string) =>
      JSON.parse(readFileSync(join(root, 'fixtures', name + '.json'), 'utf8'));
    this.state = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8'))
      : {
          phase: 'idle',
          households: read('households').map((h: any) => ({
            id: h.id,
            name: h.name,
            age: h.age,
            mobility: h.mobility,
            priorityGrade: h.priorityGrade,
            callEligible: h.callEligible,
            consentToCall: h.consentToCall,
            shelterId: h.shelterId,
            status: 'before',
            location: '미확인',
            emergency: false,
          })),
          teams: Array.from({ length: 8 }, (_, i) => ({
            id: 'T' + (i + 1),
            name: `가상 대기조 ${i + 1}`,
            available: false,
          })),
          vehicles: Array.from({ length: 6 }, (_, i) => ({
            id: 'V' + (i + 1),
            name: `가상 차량 ${i + 1}`,
            capacity: 4,
            teamId: 'T' + (i + 1),
            available: true,
          })),
          shelters: read('shelters').map((s: any) => ({
            id: s.id,
            name: s.name,
            capacity: s.capacity,
            open: true,
          })),
          sources: read('sources'),
          calls: [],
          priority: [],
          audit: [],
          runs: [],
          dispatches: [],
          contacts: [],
          followUps: [],
        };
    this.state.contacts ??= [];
    this.state.followUps ??= [];
    // Prepared sessions from a stopped server cannot be silently rebound.
    for (const call of this.state.calls)
      if (call.state === 'bound') {
        call.state = 'ended';
        this.state.audit.push({
          at: Date.now(),
          action: 'restart_review',
          detail: `${call.id} 이전 음성 연결 종료 여부를 운영자가 확인해야 합니다.`,
        });
      }
    this.graph = createGraph(store, fetcher);
    this.save();
  }
  public() {
    return {
      ...structuredClone(this.state),
      synthetic: true,
      externalActions: '상황실의 다중 연락·SMS·배차·119 인계는 모의 처리',
      counts: {
        total: this.state.households.length,
        safe: this.state.households.filter((h) => h.status === 'safe').length,
        help: this.state.households.filter((h) => h.status === 'help').length,
      },
    };
  }
  save() {
    writePrivate(this.path, this.state);
  }
  audit(action: string, detail: string) {
    this.state.audit.push({ at: Date.now(), action, detail });
    this.state.audit = this.state.audit.slice(-1000);
    this.save();
  }
  command(action: string, input: Record<string, unknown> = {}) {
    if (action === 'watch') {
      this.state.phase = 'watching';
      this.audit(action, '8종 합성 공공 데이터 감시 시작');
    } else if (action === 'propose') {
      if (this.state.phase !== 'watching')
        throw new AppError('watch_required', '먼저 감시를 시작하세요.', 409);
      this.state.priority = this.state.households
        .filter((h) => h.callEligible)
        .sort((a, b) => b.priorityGrade - a.priorityGrade || b.age - a.age)
        .map((h) => h.id);
      this.state.phase = 'proposed';
      this.audit(action, '취약도·연령 기반 대응 순서 제안. 담당자 승인 대기.');
    } else if (action === 'approve') {
      if (this.state.phase !== 'proposed' || input.approved !== true)
        throw new AppError('approval_required', '대응 순서 제안과 담당자 승인이 필요합니다.', 409);
      this.state.phase = 'active';
      for (const h of this.state.households) if (h.callEligible) h.status = 'queued';
      this.state.contacts = [
        ...this.state.priority.map((targetId) => ({ targetId, scenario: 'resident' as const })),
        ...this.state.teams.map((t) => ({ targetId: t.id, scenario: 'standby' as const })),
      ].map((target) => ({
        ...target,
        attempts: 1,
        nextRetryAt: null,
        sms: 1,
        status: '모의 연락·SMS 접수',
      }));
      this.audit(
        action,
        '담당자 발령 승인. 주민·8개 대기조의 모의 다중 연락과 SMS 생성. 실제 발신 없음.',
      );
    } else if (action === 'simulated-response') {
      const h = this.state.households.find((h) => h.id === input.targetId);
      if (!h) throw new AppError('unknown_household', '가구 ID 확인');
      const text = String(input.text ?? '');
      h.status = /도움|못\s*걷/.test(text)
        ? 'help'
        : /도착/.test(text) && !completionBlocked(text)
          ? 'moving'
          : 'unknown';
      this.audit(
        action,
        `${h.id}: 브라우저 입력 전송 시험·모의 자료. 자동 안전 판단에 사용하지 않음. ${text.slice(0, 1000)}`,
      );
    } else if (action === 'retry') {
      const targetId = input.callId ? this.linked(String(input.callId)).targetId : input.targetId;
      const c = this.state.contacts.find((contact) => contact.targetId === targetId);
      if (!c) throw new AppError('unknown_contact', '모의 연락 대상 ID 확인');
      const maximum = c.scenario === 'resident' ? 5 : 3;
      if (c.attempts >= maximum)
        throw new AppError('retry_exhausted', '모의 재시도 한도에 도달했습니다.', 409);
      c.attempts++;
      c.sms++;
      c.nextRetryAt = Date.now() + Math.max(0, c.attempts - 2) * 60000;
      c.status = '모의 재시도 예약';
      this.audit(action, `${c.targetId}: 모의 ${c.attempts}차 연락·SMS, 실제 발신 없음.`);
    } else if (action === 'team-ready') {
      const team = this.state.teams.find((t) => t.id === input.teamId);
      if (!team) throw new AppError('unknown_team', '대기조 ID 확인');
      team.available = input.available === true;
      this.audit(action, `${team.id}: 가상 참여 가능 ${team.available}`);
    } else if (action === 'dispatch') {
      const h = this.state.households.find((h) => h.id === input.targetId),
        v = this.state.vehicles.find((v) => v.id === input.vehicleId),
        team = this.state.teams.find((t) => t.id === v?.teamId);
      if (
        !h ||
        h.status !== 'help' ||
        h.emergency ||
        !v?.available ||
        !team?.available ||
        input.roadBlocked === true
      )
        throw new AppError(
          'dispatch_constraint',
          '도움 가구·차량·대기조·통제 도로 조건을 확인하세요.',
          409,
        );
      this.state.dispatches.push({
        id: randomUUID(),
        targetId: h.id,
        vehicleId: v.id,
        stage: 'assigned',
      });
      v.available = false;
      this.audit(action, `${h.id} 가상 배차. 실제 출동 없음.`);
    } else if (action === 'dispatch-stage') {
      const d = this.state.dispatches.find((d) => d.id === input.id);
      const stages = ['assigned', 'pickup', 'onboard', 'arrived'];
      if (!d || stages.indexOf(String(input.stage)) !== stages.indexOf(d.stage) + 1)
        throw new AppError('invalid_stage', '배차 단계는 순서대로 보고해야 합니다.', 409);
      const h = this.state.households.find((household) => household.id === d.targetId);
      if (input.stage === 'arrived' && h?.status !== 'safe')
        throw new AppError(
          'arrival_evidence_required',
          '차량 단계만으로 안전 처리하지 않습니다. 인증된 도착 신고와 대피소 조건 확인이 필요합니다.',
          409,
        );
      d.stage = String(input.stage);
      if (d.stage === 'arrived') {
        const vehicle = this.state.vehicles.find((v) => v.id === d.vehicleId);
        if (vehicle) vehicle.available = true;
      }
      this.audit(action, `${d.targetId}: 모의 ${d.stage}`);
    } else if (action === 'handoff') {
      this.audit(action, `${String(input.targetId)}: 모의 119·이장 인계 기록. 실제 연락 없음.`);
    } else throw new AppError('unknown_command', '지원하지 않는 상황실 명령입니다.');
    return this.public();
  }
  prepare(input: Record<string, unknown>) {
    if (this.state.phase !== 'active')
      throw new AppError(
        'declaration_required',
        '담당자 발령 승인 후 수신 체험을 준비하세요.',
        409,
      );
    const scenario = input.scenario === 'standby' ? 'standby' : 'resident',
      targetId = String(input.targetId);
    if (scenario === 'resident') {
      const h = this.state.households.find((h) => h.id === targetId);
      if (!h?.callEligible || !h.consentToCall)
        throw new AppError('household_ineligible', '가구 동의·발신 가능 여부를 확인하세요.', 409);
    } else if (!this.state.teams.some((t) => t.id === targetId))
      throw new AppError('unknown_team', '대기조 ID 확인');
    const call: LinkedCall = {
      id: randomUUID(),
      targetId,
      scenario,
      transport: input.transport === 'browser' ? 'browser' : 'telnyx',
      state: 'prepared',
      sessionId: null,
      attempts: 1,
      nextRetryAt: null,
    };
    this.state.calls.push(call);
    this.audit('prepare', `${targetId}: ${call.transport} 수신 체험 준비. 실제 발신 전.`);
    return call;
  }
  linked(id: string, transport?: string) {
    const call = this.state.calls.find((c) => c.id === id);
    if (!call || call.state === 'ended' || (transport && call.transport !== transport))
      throw new AppError(
        'invalid_linked_call',
        '취소·종료되었거나 잘못된 가구 통화 ID입니다.',
        409,
      );
    return call;
  }
  bind(id: string, sessionId: string, transport: string) {
    const call = this.linked(id, transport);
    if (call.state !== 'prepared')
      throw new AppError('already_bound', '이미 연결한 통화입니다.', 409);
    call.state = 'bound';
    call.sessionId = sessionId;
    this.audit('voice_bound', `${call.targetId}: 인증 음성 세션 ${sessionId}`);
  }
  end(id: string) {
    const c = this.state.calls.find((c) => c.id === id);
    if (c) {
      c.state = 'ended';
      this.audit('voice_ended', c.id);
    }
  }
  afterCall(outcome: CallOutcome) {
    const c = outcome.completion;
    if (
      outcome.callStatus !== 'ended' ||
      !outcome.endedAt ||
      c.status !== 'reported' ||
      (c.kind !== 'rescue' && c.kind !== 'moving' && c.kind !== 'refused' && c.kind !== 'review') ||
      this.state.followUps.some((f) => f.callId === outcome.callId)
    )
      return;
    const previous = structuredClone(this.state);
    try {
      const linked = c.scenarioCallId
        ? this.state.calls.find((call) => call.id === c.scenarioCallId)
        : undefined;
      const targetId = linked?.targetId ?? null;
      const household = this.state.households.find((h) => h.id === targetId);
      if (household) {
        household.status = {
          rescue: 'help',
          moving: 'moving',
          refused: 'refused',
          review: 'unknown',
        }[c.kind];
        household.location = c.location;
        household.emergency = c.assessment?.emergency ?? false;
      }
      this.state.followUps.push({
        callId: outcome.callId,
        targetId,
        kind: c.kind,
        location: c.location,
        evidence: c.evidence,
        reason: c.assessment?.reason ?? '통화 결과 확인',
        emergency: c.assessment?.emergency ?? false,
        status: {
          rescue: 'needs_assignment',
          moving: 'guidance_requested',
          refused: 'elder_contact_requested',
          review: 'review_requested',
        }[c.kind] as ControlState['followUps'][number]['status'],
        createdAt: Date.now(),
        playbackConfirmed: c.playbackConfirmed,
      });
      this.audit(
        'call_follow_up',
        `${targetId ?? '단독 수신 체험'}: ${{ rescue: '모의 구조 요청·담당자 배정 대기', moving: '모의 대피 안내 기록', refused: '모의 이장 연락 요청', review: '담당자 재확인 요청' }[c.kind]}. 통화 최종 종료 확인 후 기록.`,
      );
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }
  phoneShelter(targetId?: string) {
    const household = targetId ? this.state.households.find((h) => h.id === targetId) : undefined;
    const available = (s: ControlState['shelters'][number]) =>
      s.open &&
      this.state.households.filter((h) => h.shelterId === s.id && h.status === 'safe').length <
        s.capacity;
    const shelter = household
      ? this.state.shelters.find((s) => s.id === household.shelterId && available(s))
      : (this.state.shelters.find((s) => /학교/.test(s.name) && available(s)) ??
        this.state.shelters.find(available));
    if (!shelter)
      throw new AppError(
        'shelter_unavailable',
        '안내할 열린 대피소가 없습니다. 대피소를 확인하세요.',
        409,
      );
    return shelter.name;
  }
  async classify(
    id: string,
    text: string,
    context: Transcript[],
    valid: () => boolean,
  ): Promise<Report | null> {
    const call = this.linked(id);
    if (call.scenario === 'standby') {
      const team = this.state.teams.find((t) => t.id === call.targetId);
      if (valid() && team && /가능|^네/.test(text) && !/불가능|않|못|어려|없|안\s*돼/.test(text)) {
        team.available = true;
        this.audit('standby_report', `${call.targetId}: 참여 가능 자기 신고`);
      }
      return null;
    }
    const result = await this.graph.invoke({ text, context });
    if (!valid()) return null;
    this.linked(id);
    const h = this.state.households.find((h) => h.id === call.targetId)!;
    const recordRun = (status: string, evidence = text) => {
      this.state.runs.push({
        callId: id,
        targetId: h.id,
        nodes: result.nodes,
        model: this.store.value.BACKEND_MODEL,
        evidence,
        result: status,
      });
      this.state.runs = this.state.runs.slice(-500);
    };
    if (completionBlocked(text) || !result.result) {
      if (/도움.*필요|못\s*걷|숨|가슴/.test(text)) {
        h.status = 'help';
        h.emergency = /숨|가슴/.test(text);
      } else if (h.status === 'safe') {
        h.status = 'unknown';
        this.audit('completion_review', `${h.id}: ${text}`);
      }
      recordRun(h.status === 'help' ? 'help' : 'human_review');
      this.save();
      return null;
    }
    const report = result.result,
      shelter = this.state.shelters.find((s) => s.open && text.includes(s.name));
    const occupied = this.state.households.filter(
      (other) => other.status === 'safe' && other.location === shelter?.name,
    ).length;
    if (!shelter || occupied >= shelter.capacity || h.emergency) {
      recordRun('arrival_review', report.evidence);
      this.audit('arrival_review', `${h.id}: 등록된 열린 대피소·정원·긴급 조건 확인 필요`);
      return null;
    }
    const previous = structuredClone(this.state);
    try {
      h.status = 'safe';
      h.location = shelter.name;
      recordRun('safe', report.evidence);
      this.audit('self_reported_safe', `${h.id}: ${report.evidence}`);
    } catch (error) {
      this.state = previous;
      throw error;
    }
    return {
      location: shelter.name,
      evidence: report.evidence,
      targetId: h.id,
      scenarioCallId: id,
    };
  }
}
function createGraph(store: ConfigStore, fetcher: typeof fetch) {
  return new StateGraph(GraphState)
    .addNode('read_transcript', (s) => ({ text: s.text.trim(), nodes: ['read_transcript'] }))
    .addNode('classify', async (s) => {
      const r = await classifyEvacuation({ ...store.value }, s.text, s.context, fetcher);
      return {
        result: r ? { location: r.location, evidence: r.evidence } : null,
        nodes: ['classify'],
      };
    })
    .addNode('validate_evidence', (s) => ({
      result:
        s.result && s.text.includes(s.result.evidence) && !completionBlocked(s.text)
          ? s.result
          : null,
      nodes: ['validate_evidence'],
    }))
    .addNode('human_decision', () => ({ nodes: ['human_decision'] }))
    .addNode('commit', () => ({ nodes: ['commit'] }))
    .addEdge(START, 'read_transcript')
    .addEdge('read_transcript', 'classify')
    .addEdge('classify', 'validate_evidence')
    .addConditionalEdges('validate_evidence', (s) => (s.result ? 'commit' : 'human_decision'))
    .addEdge('human_decision', 'commit')
    .addEdge('commit', END)
    .compile();
}
