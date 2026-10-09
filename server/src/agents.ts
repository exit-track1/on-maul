import {
  Annotation,
  StateGraph,
  START,
  END,
  MemorySaver,
  Command,
  interrupt,
} from '@langchain/langgraph';
import { z } from 'zod';
import { classify, type Classification } from '../../shared/src/classification.ts';
import type { PlanItem, View, Reassignment } from '../../shared/src/runtime.ts';
const PlanState = Annotation.Root({
  revision: Annotation<number>(),
  order: Annotation<PlanItem[]>(),
  visit: Annotation<PlanItem[]>(),
  approved: Annotation<boolean>(),
  trace: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});
const CallState = Annotation.Root({
  text: Annotation<string>(),
  shelters: Annotation<string[]>(),
  result: Annotation<Classification>(),
  reviewed: Annotation<boolean>(),
  trace: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});
const ReassignState = Annotation.Root({
  proposal: Annotation<Reassignment>(),
  approved: Annotation<boolean>(),
  vehicleId: Annotation<string | null>(),
  trace: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});
const Result = z
  .object({
    status: z.enum(['unclear', 'e119', 'refuse', 'help', 'safe', 'moving', 'guided']),
    acked: z.boolean(),
    location: z.string().nullable(),
    quoted: z.string().max(2000),
    reason: z.string(),
    reviewRequired: z.boolean(),
    executionMode: z.literal('rules'),
  })
  .strict();
export class AgentGraphs {
  readonly reassignment = new StateGraph(ReassignState)
    .addNode('validated_candidate_snapshot', (s) => {
      if (s.proposal.status !== 'pending' || !s.proposal.candidates.length)
        throw new Error('재배정 검토 후보 오류');
      return { trace: ['validated_candidate_snapshot_no_assignment'] };
    })
    .addNode('reassignment_officer_review', (s) => {
      const decision = interrupt(
        {
          kind: 'reassignment_review',
          proposalId: s.proposal.id,
          candidates: s.proposal.candidates,
        },
        {
          responseSchema: z
            .object({ approved: z.boolean(), vehicleId: z.string().nullable() })
            .strict(),
        },
      );
      if (
        decision.approved &&
        !s.proposal.candidates.some((c) => c.vehicleId === decision.vehicleId)
      )
        throw new Error('검토 후보 밖의 재배정');
      return { ...decision, trace: ['reassignment_officer_review'] };
    })
    .addNode('reassignment_decision', (s) => ({
      trace: [
        s.approved
          ? 'approved_reassignment_current_conditions_revalidated_by_runtime'
          : 'reassignment_not_executed',
      ],
    }))
    .addEdge(START, 'validated_candidate_snapshot')
    .addEdge('validated_candidate_snapshot', 'reassignment_officer_review')
    .addEdge('reassignment_officer_review', 'reassignment_decision')
    .addEdge('reassignment_decision', END)
    .compile({ checkpointer: new MemorySaver() });
  readonly plan = new StateGraph(PlanState)
    .addNode('snapshot', (s) => ({ trace: [`snapshot_revision_${s.revision}`] }))
    .addNode('demo_eta_priority', () => ({ trace: ['demo_eta_priority_rules'] }))
    .addNode('validate_targets', (s) => {
      if (
        new Set(s.order.map((x) => x.householdId)).size !== s.order.length ||
        s.order.some((x, i) => x.rank !== i + 1)
      )
        throw new Error('계획 ID/순위 오류');
      return { trace: ['validate_targets'] };
    })
    .addNode('officer_review', (s) => {
      const approved = interrupt(
        {
          kind: 'plan_review',
          revision: s.revision,
          orderCount: s.order.length,
          visitCount: s.visit.length,
        },
        { responseSchema: z.object({ approved: z.boolean() }).strict() },
      );
      return { approved: approved.approved, trace: ['officer_review'] };
    })
    .addNode('approved_proposal', () => ({ trace: ['approved_proposal_no_external_effect'] }))
    .addEdge(START, 'snapshot')
    .addEdge('snapshot', 'demo_eta_priority')
    .addEdge('demo_eta_priority', 'validate_targets')
    .addEdge('validate_targets', 'officer_review')
    .addEdge('officer_review', 'approved_proposal')
    .addEdge('approved_proposal', END)
    .compile({ checkpointer: new MemorySaver() });
  readonly call = new StateGraph(CallState)
    .addNode('normalize_transcript', (s) => ({
      text: s.text.trim().slice(0, 2000),
      trace: ['normalize_transcript'],
    }))
    .addNode('classify_rules', (s) => ({
      result: classify(s.text, s.shelters),
      trace: ['classify_rules_no_model_call'],
    }))
    .addNode('validate_evidence', (s) => {
      const result = Result.parse(s.result);
      if (!result.quoted || !s.text.includes(result.quoted)) throw new Error('발화 인용 불일치');
      return { result, trace: ['validate_evidence'] };
    })
    .addConditionalEdges('validate_evidence', (s) =>
      s.result.status === 'e119'
        ? 'emergency_proposal'
        : s.result.reviewRequired
          ? 'human_review'
          : 'validated_result',
    )
    .addNode('emergency_proposal', () => ({ trace: ['emergency_proposal_auto_mock_handoff'] }))
    .addNode('human_review', (s) => {
      const r = interrupt(
        { kind: 'call_review', quoted: s.result.quoted, reason: s.result.reason },
        { responseSchema: z.object({ reviewed: z.literal(true) }).strict() },
      );
      return { reviewed: r.reviewed, trace: ['human_review'] };
    })
    .addNode('validated_result', () => ({ trace: ['validated_result_no_external_effect'] }))
    .addEdge(START, 'normalize_transcript')
    .addEdge('normalize_transcript', 'classify_rules')
    .addEdge('classify_rules', 'validate_evidence')
    .addEdge('emergency_proposal', 'validated_result')
    .addEdge('human_review', 'validated_result')
    .addEdge('validated_result', END)
    .compile({ checkpointer: new MemorySaver() });
  async propose(id: string, revision: number, items: { order: PlanItem[]; visit: PlanItem[] }) {
    const r = await this.plan.invoke(
      { revision, ...items, approved: false },
      { configurable: { thread_id: id } },
    );
    return {
      id,
      nodes: r.trace,
      waiting: '__interrupt__' in r && Array.isArray(r.__interrupt__) && r.__interrupt__.length > 0,
      executionMode: 'langgraph-rules',
      reason: '담당자 검토 checkpoint·외부 모델 호출 없음',
    };
  }
  async confirm(id: string) {
    const r = await this.plan.invoke(new Command({ resume: { approved: true } }), {
      configurable: { thread_id: id },
    });
    return {
      id,
      nodes: r.trace,
      waiting: false,
      executionMode: 'langgraph-rules',
      reason: '동일 checkpoint에서 담당자 승인으로 재개',
    };
  }
  async classify(id: string, text: string, view: View, householdId: string) {
    const r = await this.call.invoke(
      { text, shelters: view.data.shelters.map((s) => s.name), reviewed: false },
      { configurable: { thread_id: id } },
    );
    return {
      result: r.result,
      run: {
        id,
        nodes: r.trace,
        waiting:
          '__interrupt__' in r && Array.isArray(r.__interrupt__) && r.__interrupt__.length > 0,
        executionMode: 'langgraph-rules',
        householdId,
        reason: r.result.reason,
      },
    };
  }
  async review(id: string) {
    const r = await this.call.invoke(new Command({ resume: { reviewed: true } }), {
      configurable: { thread_id: id },
    });
    return {
      id,
      nodes: r.trace,
      waiting: false,
      executionMode: 'langgraph-rules',
      reason: '검토 기록 완료·안전 판정은 새 도착 근거 필요',
    };
  }
  async proposeReassignment(id: string, proposal: Reassignment) {
    const r = await this.reassignment.invoke(
      { proposal, approved: false, vehicleId: null },
      { configurable: { thread_id: id } },
    );
    return {
      id,
      nodes: r.trace,
      waiting: true,
      executionMode: 'langgraph-rules',
      reason: '재배정 후보 검증·담당자 승인 checkpoint·외부 모델 호출 없음',
    };
  }
  async decideReassignment(id: string, approved: boolean, vehicleId: string | null) {
    const r = await this.reassignment.invoke(new Command({ resume: { approved, vehicleId } }), {
      configurable: { thread_id: id },
    });
    return {
      id,
      nodes: r.trace,
      waiting: false,
      executionMode: 'langgraph-rules',
      reason: approved
        ? '담당자 승인 후 현재 자원/경로 조건 검증·재개'
        : '반려 또는 조건 악화·일반 임무 실행 없음',
    };
  }
}
