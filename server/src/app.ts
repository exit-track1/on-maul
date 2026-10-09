import Fastify from 'fastify';
import cors from '@fastify/cors';
import serve from '@fastify/static';
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Runtime,
  DomainError,
  planReviewSignature,
  type GraphRun,
  type Plan,
} from '../../shared/src/runtime.ts';
import { canonicalJson } from '../../shared/src/sources.ts';
import { AgentGraphs } from './agents.ts';
import {
  Telephony,
  config,
  verifyWebhook,
  type TelnyxPort,
  type TelephonyConfig,
} from './telephony.ts';
const Envelope = z
  .object({ action: z.string().max(40), input: z.record(z.string(), z.unknown()).default({}) })
  .strict();
const Webhook = z.object({
  data: z.object({
    id: z.string().max(200),
    event_type: z.string().max(100),
    payload: z.record(z.string(), z.unknown()),
  }),
});
export async function createApp(
  options: { settings?: TelephonyConfig; port?: TelnyxPort; journal?: string } = {},
) {
  const settings = options.settings ?? config(),
    telephony = options.port ?? new Telephony(settings),
    runtime = new Runtime(),
    agents = new AgentGraphs();
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  let planThread: { id: string; planId: string; planRevision: number; signature: string } | null =
    null;
  let queue = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const work = queue.then(fn);
    queue = work.then(
      () => {},
      () => {},
    );
    return work;
  };
  const retirePlanCheckpoint = (reason: string, supersededBy?: string, resumed?: GraphRun) => {
    if (!planThread) return;
    const old = runtime.view().graphRuns.find((run) => run.id === planThread!.id);
    if (old)
      runtime.addGraph({
        ...old,
        ...(resumed ?? {}),
        waiting: false,
        reason: `superseded · ${reason} · 실행 승인에 사용하지 않음`,
        ...(supersededBy ? { supersededBy } : {}),
      });
    planThread = null;
  };
  const planCheckpointDataMatches = async (plan: Plan, id: string, approved: boolean) => {
    try {
      const checkpoint = await agents.plan.getState({ configurable: { thread_id: id } });
      return (
        (approved ? checkpoint.next.length === 0 : checkpoint.next.includes('officer_review')) &&
        checkpoint.values.revision === plan.snapshotRevision &&
        checkpoint.values.approved === approved &&
        canonicalJson({ order: checkpoint.values.order, visit: checkpoint.values.visit }) ===
          canonicalJson({ order: plan.order, visit: plan.visit })
      );
    } catch {
      return false;
    }
  };
  const planCheckpointMatches = async (plan: Plan): Promise<boolean> => {
    const binding = planThread;
    if (
      !binding ||
      binding.planId !== plan.id ||
      binding.planRevision !== plan.revision ||
      binding.signature !== planReviewSignature(plan)
    )
      return false;
    const run = runtime.view().graphRuns.find((run) => run.id === binding.id);
    if (!run?.waiting || run.planSignature !== binding.signature) return false;
    return planCheckpointDataMatches(plan, binding.id, false);
  };
  const ensurePlanCheckpoint = async () => {
    const view = runtime.view(),
      plan = view.plan;
    if (view.frozen) {
      planThread = null;
      return;
    }
    if (!plan || plan.confirmed) {
      retirePlanCheckpoint('미확정 계획 종료');
      return;
    }
    if (await planCheckpointMatches(plan)) return;
    const id = `PLAN-GRAPH-${plan.id}-${plan.revision}-${randomUUID()}`,
      signature = planReviewSignature(plan),
      run = await agents.propose(id, plan.snapshotRevision, {
        order: plan.order,
        visit: plan.visit,
      });
    retirePlanCheckpoint('계획·소스 근거 변경 또는 checkpoint 불일치·새 검토 필요', id);
    runtime.addGraph({
      ...run,
      planId: plan.id,
      planRevision: plan.revision,
      planSignature: signature,
    });
    planThread = { id, planId: plan.id, planRevision: plan.revision, signature };
  };
  const delivered = new Set<string>();
  if (options.journal && existsSync(`${options.journal}/webhooks.json`)) {
    for (const id of z
      .array(z.string().max(200))
      .max(100000)
      .parse(JSON.parse(readFileSync(`${options.journal}/webhooks.json`, 'utf8'))))
      delivered.add(id);
  }
  const timers = new Map<string, NodeJS.Timeout>();
  if (options.journal && existsSync(`${options.journal}/snapshot.json`)) {
    runtime.restore(JSON.parse(readFileSync(`${options.journal}/snapshot.json`, 'utf8')));
    await ensurePlanCheckpoint();
  }
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );
  const read = (body: unknown) => JSON.parse(typeof body === 'string' ? body : '{}') as unknown;
  await app.register(cors, {
    origin: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:8090',
      'http://127.0.0.1:8090',
    ],
    methods: ['GET', 'POST'],
  });
  app.addHook('preHandler', async (req, reply) => {
    if (
      settings.mode === 'hybrid' &&
      req.method === 'POST' &&
      req.url !== '/api/telnyx/webhook' &&
      req.headers.authorization !== `Bearer ${settings.operatorToken}`
    )
      await reply.code(401).send({ error: '담당자 토큰이 필요합니다.' });
  });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as Error;
    const status =
      e instanceof DomainError
        ? e.status
        : e instanceof z.ZodError || e instanceof SyntaxError
          ? 400
          : 500;
    void reply.code(status).send({
      error: status === 500 ? '요청을 처리하지 못했습니다.' : e.message,
      code: e instanceof DomainError ? e.code : 'invalid_request',
    });
  });
  const journal = () => {
    if (!options.journal) return;
    mkdirSync(options.journal, { recursive: true, mode: 0o700 });
    const view = runtime.view();
    writeFileSync(`${options.journal}/snapshot.tmp`, JSON.stringify(view), { mode: 0o600 });
    renameSync(`${options.journal}/snapshot.tmp`, `${options.journal}/snapshot.json`);
    writeFileSync(`${options.journal}/webhooks.json`, JSON.stringify([...delivered]), {
      mode: 0o600,
    });
    appendFileSync(
      `${options.journal}/events.jsonl`,
      JSON.stringify({
        revision: view.revision,
        at: view.scenario.displayTime,
        counts: view.scenario.counts,
        lastRecord: view.records.at(-1),
      }) + '\n',
      { mode: 0o600 },
    );
  };
  app.get('/api/health', () => ({
    ok: true,
    service: '온 마을 React mock API',
    executionMode: settings.mode,
    agent: '@langchain/langgraph',
    inference: 'rules',
    externalInferenceCalls: 0,
  }));
  app.get('/api/state', () => runtime.view());
  app.get('/api/export.json', async (_req, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="onmaul-mock-report.json"');
    return runtime.view();
  });
  app.post('/api/command', async (req) =>
    serialized(async () => {
      const { action, input } = Envelope.parse(read(req.body));
      if (action === 'plan') {
        const before = runtime.view();
        if (before.scenario.mode !== 'watch')
          throw new DomainError('mode', '감시 단계에서 시작하세요.');
        runtime.command(action, input);
      } else if (action === 'confirm') {
        const before = runtime.view();
        if (before.plan?.confirmed) runtime.command(action, input);
        else {
          runtime.validatePlanConfirmation(input.revision);
          if (!(await planCheckpointMatches(before.plan!))) {
            await ensurePlanCheckpoint();
            journal();
            throw new DomainError(
              'plan_revalidation_required',
              '검토 checkpoint가 변경되었습니다. 최신 계획을 다시 검토하고 확정하세요.',
            );
          }
          const binding = planThread!;
          const validateReviewedPlan = () => {
            runtime.validatePlanConfirmation(input.revision);
            const plan = runtime.view().plan;
            if (!plan || planReviewSignature(plan) !== binding.signature)
              throw new DomainError(
                'plan_revalidation_required',
                '검토 중 계획이 변경되었습니다. 최신 계획을 다시 검토하세요.',
              );
          };
          validateReviewedPlan();
          let run: GraphRun;
          try {
            // The graph has no external effects. Only a successful, current review can queue calls.
            run = await agents.confirm(binding.id);
          } catch {
            retirePlanCheckpoint('checkpoint 재개 실패·담당자 재검토 필요');
            journal();
            throw new DomainError('plan_checkpoint_failed', '계획 검토 재개 실패·다시 검토하세요.');
          }
          try {
            if (
              run.id !== binding.id ||
              run.waiting ||
              !(await planCheckpointDataMatches(before.plan!, binding.id, true))
            )
              throw new DomainError(
                'plan_revalidation_required',
                '승인 checkpoint 근거가 계획과 다릅니다. 최신 계획을 다시 검토하세요.',
              );
            validateReviewedPlan();
            runtime.command(action, input);
          } catch (error) {
            retirePlanCheckpoint(
              '승인 중 조건 변경·확정 실행 없음·담당자 재검토 필요',
              undefined,
              run,
            );
            journal();
            throw error;
          }
          runtime.addGraph({
            ...run,
            planId: binding.planId,
            planRevision: binding.planRevision,
            planSignature: binding.signature,
          });
          planThread = null;
        }
      } else if (action === 'transcript') {
        const before = runtime.view();
        if (!before.plan?.confirmed)
          throw new DomainError('unconfirmed', '발령 확정이 필요합니다.');
        const id = z
            .string()
            .regex(/^H\d{3}$/)
            .parse(input.id),
          text = z.string().min(1).max(2000).parse(input.text),
          runId = String(input.eventId ?? randomUUID());
        if (before.graphRuns.some((x) => x.id === runId)) return before;
        const r = await agents.classify(runId, text, before, id);
        runtime.command(action, { ...input, eventId: runId });
        if (!before.graphRuns.some((x) => x.id === runId)) runtime.addGraph(r.run);
      } else if (action === 'review-graph') {
        const id = z.string().parse(input.id),
          old = runtime.view().graphRuns.find((x) => x.id === id);
        if (!old?.waiting || !old.householdId)
          throw new DomainError('not_waiting', '검토 대기 그래프가 아닙니다.');
        runtime.addGraph(await agents.review(id));
      } else if (action === 'reassign-propose') {
        const before = runtime.view();
        runtime.command(action, input);
        const proposal = runtime
          .view()
          .reassignments.find((p) => p.householdId === input.id && p.status === 'pending');
        if (proposal && !before.reassignments.some((p) => p.id === proposal.id))
          runtime.addGraph(
            await agents.proposeReassignment(`REASSIGN-GRAPH-${proposal.id}`, proposal),
          );
      } else if (action === 'reassign-approve' || action === 'reassign-reject') {
        const before = runtime.view(),
          old = before.reassignments.find((p) => p.id === input.id);
        runtime.command(action, input);
        const proposal = runtime.view().reassignments.find((p) => p.id === input.id);
        const runId = `REASSIGN-GRAPH-${input.id}`;
        if (
          old?.status === 'pending' &&
          proposal &&
          before.graphRuns.some((g) => g.id === runId && g.waiting)
        )
          runtime.addGraph(
            await agents.decideReassignment(
              runId,
              proposal.status === 'approved',
              proposal.selectedVehicleId ?? null,
            ),
          );
      } else runtime.command(action, input);
      await ensurePlanCheckpoint();
      // Automatic member failures publish the same human review checkpoints as manual proposals.
      for (const proposal of runtime.view().reassignments.filter((p) => p.status === 'pending')) {
        const runId = `REASSIGN-GRAPH-${proposal.id}`;
        if (!runtime.view().graphRuns.some((g) => g.id === runId && g.waiting))
          runtime.addGraph(await agents.proposeReassignment(runId, proposal));
      }
      journal();
      return runtime.view();
    }),
  );
  app.post('/api/telephony/dial', async (req) =>
    serialized(async () => {
      const input = z
          .object({
            targetId: z.enum(['H012', 'M01']),
            targetType: z.enum(['resident', 'member']),
            consent: z.boolean(),
            revision: z.number().int(),
          })
          .strict()
          .parse(read(req.body)),
        view = runtime.view();
      if (input.targetId !== (input.targetType === 'resident' ? 'H012' : 'M01') || !input.consent)
        throw new DomainError('consent', '대상 종류와 시연 동의를 확인하세요.');
      if (
        settings.mode === 'hybrid' &&
        !(input.targetType === 'resident'
          ? settings.residentConsent && settings.residentNumber
          : settings.memberConsent && settings.memberNumber)
      )
        throw new DomainError('consent', '별도 동의된 환경변수 수신자가 없습니다.');
      if (
        !view.plan?.confirmed ||
        view.networkDown ||
        view.frozen ||
        input.revision !== view.revision
      )
        throw new DomainError('call_guard', '최신 확정·통신 상태가 필요합니다.');
      if (
        view.calls.filter((c) => ['calling', 'pendingunknown'].includes(c.phase)).length >= 8 ||
        view.calls.some(
          (c) => c.targetId === input.targetId && ['calling', 'pendingunknown'].includes(c.phase),
        )
      )
        throw new DomainError('channel_limit', '공용 채널 또는 대상 세션이 사용 중입니다.');
      const h = view.data.households.find((h) => h.id === input.targetId);
      if (
        input.targetType === 'resident' &&
        (!h?.callEligible ||
          view.scenario.householdStatuses.find((s) => s.householdId === h.id)?.temporaryExclusion)
      )
        throw new DomainError('excluded', '발신 제외 대상입니다.');
      // Reserve before awaiting dial. Serial execution prevents concurrent starts.
      const requestId = randomUUID();
      runtime.reserveLive(input.targetId, input.targetType, requestId, input.revision);
      let result;
      try {
        result = await telephony.dial({ ...input, requestId });
      } catch {
        runtime.settleLive(requestId, null, 'pendingunknown');
        journal();
        throw new DomainError(
          'dial_uncertain',
          '기존 발신 요청 결과가 불명입니다. 중복 발신을 보류하세요.',
          502,
        );
      }
      runtime.settleLive(requestId, result.providerId, result.status);
      journal();
      // Events are associated with the existing request; raw provider payloads are not exported.
      liveCalls.set(requestId, {
        requestId,
        targetId: input.targetId,
        providerId: result.providerId,
        status: result.status,
        startedAt: Date.now(),
        ended: false,
      });
      if (result.mode === 'telnyx') {
        const timer = setTimeout(() => void hangup(requestId), 30000);
        timer.unref();
        timers.set(requestId, timer);
      }
      return { requestId, status: result.status, mode: result.mode, providerId: result.providerId };
    }),
  );
  const liveCalls = new Map<
    string,
    {
      requestId: string;
      targetId: string;
      providerId: string | null;
      status: string;
      startedAt: number;
      ended: boolean;
    }
  >();
  for (const c of runtime.view().calls)
    if (c.mode === 'telnyx')
      liveCalls.set(c.id, {
        requestId: c.id,
        targetId: c.targetId,
        providerId: c.providerId,
        status: c.phase,
        startedAt: Date.now(),
        ended: c.phase === 'finished',
      });
  async function hangup(id: string) {
    const c = liveCalls.get(id);
    if (!c || c.ended || !c.providerId) return;
    try {
      await telephony.hangup(c.providerId, `${id}-hangup`);
      c.status = 'awaiting_hangup';
    } catch {
      c.status = 'pendingunknown';
    }
  }
  app.get('/api/telephony/state', () => ({
    mode: settings.mode,
    calls: [...liveCalls.values()],
    recording: 'disabled',
    liveVoiceConversation: 'not_implemented_in_mock_api',
  }));
  app.post('/api/telephony/hangup', async (req) => {
    const { requestId } = z.object({ requestId: z.string() }).strict().parse(read(req.body));
    await hangup(requestId);
    return { requestId, status: liveCalls.get(requestId)?.status ?? 'missing' };
  });
  app.post('/api/telnyx/webhook', async (req, reply) =>
    serialized(async () => {
      if (settings.mode === 'demo')
        return reply.code(409).send({ error: 'demo 모드에서는 실제 webhook을 적용하지 않습니다.' });
      const raw = String(req.body ?? '');
      if (
        !verifyWebhook(
          raw,
          String(req.headers['telnyx-signature-ed25519'] ?? ''),
          String(req.headers['telnyx-timestamp'] ?? ''),
          settings.publicKey,
        )
      )
        return reply.code(401).send({ error: 'webhook 서명·시각 검증 실패' });
      const { data } = Webhook.parse(JSON.parse(raw));
      if (delivered.has(data.id)) return { ok: true, duplicate: true };
      let c = [...liveCalls.values()].find((c) => c.providerId === data.payload.call_control_id);
      if (!c && typeof data.payload.client_state === 'string') {
        try {
          const context = JSON.parse(
            Buffer.from(data.payload.client_state, 'base64').toString('utf8'),
          );
          const existing = liveCalls.get(context.requestId);
          if (
            existing &&
            !existing.providerId &&
            existing.targetId === context.targetId &&
            typeof data.payload.call_control_id === 'string'
          ) {
            existing.providerId = data.payload.call_control_id;
            c = existing;
          }
        } catch {
          /* invalid context remains unmatched */
        }
      }
      if (!c) return reply.code(409).send({ error: '기존 통화 문맥을 찾지 못했습니다.' });
      if (data.event_type === 'call.answered' && !c.ended) {
        c.status = 'answered';
        clearTimeout(timers.get(c.requestId));
        const timer = setTimeout(() => void hangup(c.requestId), 120000);
        timer.unref();
        timers.set(c.requestId, timer);
      }
      if (data.event_type === 'call.hangup') {
        c.ended = true;
        c.status = 'ended';
        clearTimeout(timers.get(c.requestId));
        runtime.finishLive(c.requestId);
        journal();
      }
      delivered.add(data.id);
      journal();
      return { ok: true };
    }),
  );
  const dist = fileURLToPath(new URL('../../fe/dist/', import.meta.url));
  if (existsSync(dist)) {
    await app.register(serve, { root: dist, prefix: '/' });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: '없는 API입니다.' });
      return reply.sendFile('index.html');
    });
  }
  app.addHook('onClose', () => {
    for (const t of timers.values()) clearTimeout(t);
  });
  return { app, runtime, agents };
}
