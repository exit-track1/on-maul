import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError, type Runtime, type View } from '../../shared/src/runtime.ts';
import type { PhoneCall, PhoneTargetId, PhoneUpdate } from '../../shared/src/phone.ts';
import type { PhonePort } from './phone.ts';

/** Only the final, validated recipient result can drive the featured business flow. */
export function phoneOutcome(call: PhoneCall) {
  const completion = call.completion;
  const evidence = (completion?.evidence ?? call.error?.message ?? '응답 근거 미확인').slice(
    0,
    1900,
  );
  if (call.scenario === 'standby') {
    const assessment = completion?.standbyAssessment;
    const vehicle = assessment?.vehicleEvidence.trim() ?? '';
    const ready = assessment?.readinessEvidence.trim() ?? '';
    const unavailableVehicle =
      /없|불가|못|안\s*돼|안\s*되|아니|배차|지원|빌려|어려|모르|미확인|수도|아마|불확실|미정|있으면|있다면|있을/.test(
        vehicle,
      );
    const affirmativeVehicle = /^(?:네|예|응)[,.!\s]*$|있|가능|이용\s*할|가지고|보유/.test(vehicle);
    const unavailableReadiness =
      /없|못|불가|어려|안\s*(?:돼|되|할|가|출발|출동|이동)|않|아니|나중|모르|미확인|수도|아마|불확실|미정/.test(
        ready,
      );
    const unavailableParticipation = /못|불가|어려|아니|참여\s*안|수도|아마|불확실|미정/.test(
      assessment?.participationEvidence ?? '',
    );
    const immediate =
      /^(?:지금|바로|즉시)[,.!\s]*$|(?:지금\s*바로|바로|즉시|지금)\s*(?:출발|출동|이동|갈|가겠|가요|가능)|준비\s*(?:됐|되었)/.test(
        ready,
      );
    const minutes = /(\d+)\s*분/.exec(ready);
    return {
      ended: true as const,
      kind: 'standby' as const,
      standbyAvailable:
        completion?.status === 'reported' &&
        assessment?.state === 'ready' &&
        assessment.confidence >= 0.9 &&
        !!assessment.participationEvidence &&
        !unavailableParticipation &&
        affirmativeVehicle &&
        !unavailableVehicle &&
        !unavailableReadiness &&
        (minutes ? Number(minutes[1]) <= 5 : immediate),
      evidence:
        assessment?.state === 'ready' && unavailableVehicle
          ? `${evidence} · 차량 배차 확인 필요·자동 출동 보류`
          : evidence,
    };
  }
  const assessment = completion?.assessment;
  const validated = completion?.status === 'reported' && !!completion.evidence.trim();
  const mobility =
    !validated || !assessment
      ? 'unknown'
      : assessment.emergency
        ? 'unknown'
        : completion.kind === 'refused' && assessment.refusal === 'refused'
          ? 'refusal'
          : completion.kind === 'rescue' && assessment.mobility === 'needs_help'
            ? 'needs_help'
            : completion.kind === 'moving' && assessment.mobility === 'possible'
              ? 'possible'
              : 'unknown';
  return {
    ended: true as const,
    kind: 'resident' as const,
    mobility: mobility as 'unknown' | 'refusal' | 'needs_help' | 'possible',
    emergency: validated && assessment?.emergency === true,
    evidence,
  };
}

export async function registerPhoneIntegration(options: {
  app: FastifyInstance;
  runtime: Runtime;
  phone: PhonePort;
  serialized: <T>(fn: () => Promise<T>) => Promise<T>;
  publish: () => Promise<void>;
  settle: () => Promise<void>;
  synchronize: () => void;
  read: (body: unknown) => unknown;
  operatorToken: string;
}) {
  const { app, runtime, phone, serialized, publish, settle, synchronize, read } = options;
  let launching = false;
  let closed = false;
  const acceptsTarget = (view: View, targetId: PhoneTargetId) =>
    view.demonstration?.phoneMode === 'live' &&
    ((view.demonstration.story === 'grandfather' && targetId === 'H012') ||
      (view.demonstration.story === 'squad' && targetId === 'M01'));

  const assertReady = (targetIds: PhoneTargetId[]) => {
    const state = phone.state();
    if (!state.enabled || !state.ready) throw new DomainError('phone_not_ready', state.notice);
    if (state.busy || launching)
      throw new DomainError('phone_busy', '진행 중이거나 종료 미확인인 실제 통화가 있습니다.');
    for (const id of targetIds) {
      const target = state.targets.find((target) => target.id === id);
      if (!target?.configured || !target.consent)
        throw new DomainError(
          'phone_target',
          `${target?.name ?? id}의 수신 번호와 시연 동의가 필요합니다.`,
        );
    }
  };

  const updateRuntime = (call: PhoneCall) => {
    const view = runtime.view();
    const linked = view.calls.find((item) => item.id === call.requestId && item.mode === 'telnyx');
    if (
      !linked ||
      !acceptsTarget(view, call.targetId) ||
      linked.targetId !== call.targetId ||
      view.frozen
    )
      return;
    if (call.status === 'ended' && !call.blocked && call.endedAt !== null) {
      runtime.applyPhoneOutcome(call.requestId, phoneOutcome(call));
    } else if (call.status === 'failed' && !call.blocked) {
      runtime.rejectPhoneCall(call.requestId, call.error?.message ?? call.notice, false);
    } else {
      runtime.applyPhoneUpdate(call.requestId, {
        phase:
          call.status === 'unknown'
            ? 'pendingunknown'
            : call.answeredAt !== null
              ? 'talking'
              : 'dialing',
        providerId: call.providerId,
      });
    }
  };

  const onUpdate = ({ call }: PhoneUpdate) => {
    if (closed) return;
    void serialized(async () => {
      await settle();
      try {
        updateRuntime(call);
        await publish();
      } finally {
        synchronize();
      }
    }).catch((error) => app.log.error(error, 'Phone result could not be applied'));
  };
  phone.on('update', onUpdate);
  phone.attachUpgrade(app.server);

  const launch = (targetId: PhoneTargetId, revision: number) => {
    assertReady([targetId]);
    const view = runtime.view();
    if (!acceptsTarget(view, targetId))
      throw new DomainError(
        'phone_target',
        '현재 실제 전화 시연에 등록된 대상만 발신할 수 있습니다.',
      );
    const requestId = randomUUID();
    runtime.preparePhoneCall(targetId, requestId, revision);
    const resident = view.data.households.find(
      (household) => household.id === view.demonstration!.residentId,
    );
    const shelter = view.data.shelters.find((shelter) => shelter.id === resident?.shelterId);
    launching = true;
    const rescueLocation = resident
      ? `${view.data.zones.find((zone) => zone.id === resident.zoneId)?.label ?? '서구역'} ${Number(resident.id.slice(1))}번 집`
      : undefined;
    // Preparation includes asynchronous voice/probe work. Keep state reads and stop controls available.
    void phone
      .start(targetId, requestId, shelter?.name, rescueLocation)
      .then(
        (call) => onUpdate({ requestId, call }),
        (error: unknown) => {
          void serialized(async () => {
            const call = phone.state().calls.find((call) => call.requestId === requestId);
            if (call) updateRuntime(call);
            else
              runtime.rejectPhoneCall(
                requestId,
                (error instanceof Error ? error.message : '전화 준비 실패').slice(0, 2000),
                false,
              );
            await publish();
            synchronize();
          }).catch((failure) => app.log.error(failure, 'Phone preparation failed'));
        },
      )
      .finally(() => {
        launching = false;
        if (!closed)
          void serialized(async () => {
            await publish();
            synchronize();
          }).catch((error) => app.log.error(error, 'Phone queue could not be continued'));
      });
    return requestId;
  };

  const observe = () => {
    const view = runtime.view();
    if (
      closed ||
      launching ||
      !view.plan?.confirmed ||
      !view.simulation.playing ||
      view.networkDown ||
      view.frozen
    )
      return;
    const target = runtime.pendingPhoneTargets()[0] as PhoneTargetId | undefined;
    if (!target || phone.state().busy || !phone.state().ready) return;
    launch(target, view.revision);
  };

  const authorize = (authorization?: string) => {
    if (phone.state().enabled && authorization !== `Bearer ${options.operatorToken}`)
      throw new DomainError('operator_token', '담당자 토큰이 필요합니다.', 401);
  };
  app.get('/api/phone/bootstrap', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (
      !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) ||
      req.headers['x-forwarded-host'] ||
      (req.headers.origin && req.headers.origin !== `http://${host}`)
    )
      return reply.code(403).send({ error: '로컬 상황실에서만 연결 설정을 가져올 수 있습니다.' });
    reply.header('Cache-Control', 'no-store');
    return {
      enabled: phone.state().enabled,
      token: phone.state().enabled ? options.operatorToken : '',
    };
  });
  app.get('/api/phone/state', async (req) => {
    authorize(req.headers.authorization);
    return serialized(async () => phone.state());
  });
  app.get(`/probe/${phone.probeToken}`, () => ({ onCallback: phone.probeToken }));
  app.post('/webhooks/telnyx', async (req, reply) => {
    const raw = Buffer.from(typeof req.body === 'string' ? req.body : '');
    if (!phone.verifyWebhook(raw, req.headers))
      return reply.code(401).send({ error: '전화 webhook 서명·시각 검증 실패' });
    const event = z
      .object({
        data: z.object({
          id: z.string(),
          event_type: z.string(),
          payload: z.record(z.string(), z.unknown()),
        }),
      })
      .parse(JSON.parse(raw.toString()));
    phone.webhook(event);
    return { ok: true };
  });
  app.post('/api/phone/dial', async (req) =>
    serialized(async () => {
      authorize(req.headers.authorization);
      await settle();
      try {
        const input = z
          .object({
            targetId: z.enum(['H012', 'M01']),
            revision: z.number().int(),
            consent: z.literal(true),
          })
          .strict()
          .parse(read(req.body));
        const requestId = launch(input.targetId, input.revision);
        await publish();
        return { requestId, view: runtime.view(), phone: phone.state() };
      } finally {
        synchronize();
      }
    }),
  );
  app.post('/api/phone/hangup', async (req) => {
    authorize(req.headers.authorization);
    const input = z.object({ callId: z.string().optional() }).strict().parse(read(req.body));
    await phone.stop(input.callId);
    return { phone: phone.state() };
  });
  app.post('/api/phone/resolve', async (req) => {
    authorize(req.headers.authorization);
    const input = z
      .object({ callId: z.string(), confirmedEnded: z.literal(true) })
      .strict()
      .parse(read(req.body));
    return { phone: phone.resolveUnknown(input.callId, input.confirmedEnded) };
  });

  // A recovered final result is applied only to its original, still-open runtime request.
  for (const call of phone.state().calls) updateRuntime(call);
  app.addHook('onClose', async () => {
    closed = true;
    phone.off('update', onUpdate);
    phone.dispose();
  });
  return { observe, assertReady };
}
