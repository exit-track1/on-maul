import { useEffect, useState } from 'react';
import type { View } from '../../../../shared/src/runtime.ts';
import type {
  PhoneCall,
  PhoneState,
  PhoneStatus,
  PhoneTargetId,
} from '../../../../shared/src/phone.ts';

const people: { id: PhoneTargetId; name: string; detail: string }[] = [
  { id: 'H012', name: '반영환 할아버지', detail: '구급차 지원' },
  { id: 'M01', name: '반영환 대원', detail: '출동 가능 여부' },
];

const phoneStatusLabels: Record<PhoneStatus, string> = {
  requesting: '발신 요청 중',
  created: '전화 연결 준비',
  ringing: '벨 울리는 중',
  answered: '통화 중',
  ending: '통화 종료 확인 중',
  ended: '통화 종료',
  failed: '발신 실패',
  unknown: '종료 확인 필요',
};

function callAssessmentLabel(call?: PhoneCall) {
  const completion = call?.completion;
  if (!completion) return '답변 확인 대기';
  if (completion.status === 'needs_review') return '담당자 확인 필요';
  if (completion.standbyAssessment?.state === 'unavailable')
    return '출동 불가 응답';
  if (completion.standbyAssessment) return '대원 출동 조건 응답';
  if (completion.assessment?.emergency) return '긴급 지원 확인 필요';
  if (
    completion.assessment?.mobility === 'needs_help' ||
    completion.kind === 'rescue'
  )
    return '구조 지원 필요';
  if (
    completion.assessment?.refusal === 'refused' ||
    completion.kind === 'refused'
  )
    return '대피 거부 · 담당자 확인';
  if (
    completion.assessment?.mobility === 'possible' ||
    completion.kind === 'moving'
  )
    return '자가 이동 가능 응답';
  if (completion.kind === 'evacuation') return '대피 완료 자가 신고';
  return '응답 기록 · 담당자 확인';
}

function callTime(value: number | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

interface Props {
  view: View;
  phone: PhoneState | null;
  error: string | null;
  offline: boolean;
  connected: boolean;
  pending: boolean;
  activeTargetId: PhoneTargetId;
  run: (
    action: 'dial' | 'hangup' | 'resolve',
    input: Record<string, unknown>,
  ) => Promise<void>;
  focus: (id: string) => void;
}

export function CallHistory({
  view,
  phone,
  error,
  offline,
  connected,
  pending,
  activeTargetId,
  run,
  focus,
}: Props) {
  const [targetId, setTargetId] = useState<PhoneTargetId>(activeTargetId);
  const [callId, setCallId] = useState('');
  const [consent, setConsent] = useState(false);
  const [confirmedEnded, setConfirmedEnded] = useState(false);
  useEffect(() => {
    setTargetId(activeTargetId);
  }, [activeTargetId]);
  useEffect(() => {
    setConsent(false);
    setConfirmedEnded(false);
    setCallId('');
  }, [targetId]);
  const person = people.find((entry) => entry.id === targetId)!;
  const target = phone?.targets.find((entry) => entry.id === targetId);
  const calls =
    phone?.calls
      .filter((call) => call.targetId === targetId)
      .toSorted(
        (left, right) => (right.requestedAt ?? 0) - (left.requestedAt ?? 0),
      ) ?? [];
  const call = calls.find((entry) => entry.id === callId) ?? calls[0];
  const demonstration = view.demonstration;
  const currentCall = Boolean(
    call &&
    demonstration?.phoneMode === 'live' &&
    (targetId === demonstration.residentId ||
      (targetId === 'M01' && demonstration.story === 'squad')) &&
    view.calls.some(
      (entry) => entry.mode === 'telnyx' && entry.id === call.requestId,
    ),
  );
  const businessStatus =
    currentCall && demonstration
      ? (
          {
            responding: targetId === 'M01' ? '출동 중' : '구조 차량 출동 중',
            boarding: targetId === 'H012' ? '탑승 확인' : '구조 중',
            evacuating: targetId === 'H012' ? '대피 중' : '구조 중',
            completed: targetId === 'M01' ? '구조 완료' : '대피 완료',
          } as Partial<Record<typeof demonstration.stage, string>>
        )[demonstration.stage]
      : undefined;
  const canDial = Boolean(
    !offline &&
    connected &&
    phone?.enabled &&
    phone.ready &&
    !phone.busy &&
    target?.configured &&
    target.consent &&
    consent &&
    !pending &&
    demonstration?.phoneMode === 'live' &&
    targetId === (demonstration.story === 'grandfather' ? 'H012' : 'M01') &&
    view.plan?.confirmed &&
    !view.frozen &&
    !view.networkDown,
  );
  const activeCall = call && !['ended', 'failed'].includes(call.status);
  return (
    <div className="call-history" data-testid="call-history">
      <div className="call-people" aria-label="통화 대상">
        {people.map((entry) => (
          <button
            key={entry.id}
            aria-pressed={targetId === entry.id}
            onClick={() => setTargetId(entry.id)}
          >
            <strong>{entry.name}</strong>
            <small>
              {entry.id} · {entry.detail}
            </small>
          </button>
        ))}
      </div>
      <div className="call-transcript-heading">
        <h3>{person.name}</h3>
        <span className="call-source-tag live">실제 전화 전사</span>
        {targetId !== 'M01' && (
          <button className="text-button" onClick={() => focus(targetId)}>
            지도에서 위치 보기 ↗
          </button>
        )}
      </div>
      <p className="phone-connection-notice" role="status">
        {offline
          ? '브라우저 단독 시연입니다. 실제 전화 기록은 서버 연결에서 확인합니다.'
          : (error ??
            phone?.notice ??
            '전화 연결 설정에서 운영자 토큰을 입력하면 실제 통화 내역을 불러옵니다.')}
      </p>
      {calls.length > 1 && (
        <label className="call-record-select">
          통화 기록
          <select
            aria-label="통화 기록"
            value={call?.id ?? ''}
            onChange={(event) => {
              setCallId(event.target.value);
              setConfirmedEnded(false);
            }}
          >
            {calls.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {callTime(entry.requestedAt)} ·{' '}
                {phoneStatusLabels[entry.status]}
              </option>
            ))}
          </select>
        </label>
      )}
      {call ? (
        <article
          className="actual-call-record"
          data-testid="actual-call-record"
          data-status={call.status}
        >
          <div className="call-outcome">
            <strong>{phoneStatusLabels[call.status]}</strong>
            <span>{callAssessmentLabel(call)}</span>
            {businessStatus && (
              <span
                className="call-business-status"
                data-testid="call-business-status"
                aria-label="현재 구조 진행 상태"
              >
                {businessStatus}
              </span>
            )}
          </div>
          <dl className="call-timestamps">
            <dt>발신</dt>
            <dd>{callTime(call.requestedAt)}</dd>
            <dt>응답</dt>
            <dd>{callTime(call.answeredAt)}</dd>
            <dt>종료</dt>
            <dd>{callTime(call.endedAt)}</dd>
          </dl>
          {call.notice && <p className="muted">{call.notice}</p>}
          {call.error && (
            <p className="call-error" role="status">
              {call.error.message} · {call.error.action}
            </p>
          )}
          {call.completion && (
            <div className="call-evidence">
              <span className="eyebrow">수신자 답변 기반 분류</span>
              <p>
                {call.completion.evidence ||
                  call.completion.assessment?.reason ||
                  '분류 근거 확인 필요'}
              </p>
              {call.completion.location && (
                <p>신고 위치 · {call.completion.location}</p>
              )}
              {call.completion.standbyAssessment && (
                <dl>
                  <dt>참여</dt>
                  <dd>
                    {call.completion.standbyAssessment.participationEvidence ||
                      '불명'}
                  </dd>
                  <dt>차량</dt>
                  <dd>
                    {call.completion.standbyAssessment.vehicleEvidence ||
                      '불명'}
                  </dd>
                  <dt>준비</dt>
                  <dd>
                    {call.completion.standbyAssessment.readinessEvidence ||
                      '불명'}
                  </dd>
                </dl>
              )}
            </div>
          )}
          <h4>실시간 전사</h4>
          <p className="transcript-context">
            “알겠어요”는 안내 확인입니다. 완료 기록은 수신자의 자가 신고이며
            현장 검증 결과가 아닙니다.
          </p>
          {call.transcript.length ? (
            <ol
              className="phone-transcript"
              aria-label={`${person.name} 실제 통화 전사`}
            >
              {call.transcript.map((entry, index) => (
                <li key={`${call.id}-${index}`} className={entry.speaker}>
                  <span>
                    {entry.speaker === 'assistant' ? 'AI' : person.name}
                  </span>
                  <p>{entry.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="call-empty">아직 수신된 전사가 없습니다.</p>
          )}
        </article>
      ) : (
        <div className="call-empty">
          <strong>실제 통화 내역이 없습니다</strong>
          <p>
            이 대상의 전화가 연결되면 AI와 수신자의 대화가 여기에 표시됩니다.
          </p>
        </div>
      )}
      <div className="phone-call-controls">
        <p className="muted">
          {target?.phoneMasked
            ? `등록 번호 ${target.phoneMasked}`
            : '서버에 수신 번호를 등록해야 합니다.'}
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            disabled={pending || offline}
          />
          {person.name} 수신자의 발신 동의를 확인했습니다
        </label>
        <button
          className="phone-dial-button"
          disabled={!canDial}
          onClick={() => void run('dial', { targetId, consent: true })}
        >
          {calls.length ? '실제 전화 다시 걸기' : '실제 전화 걸기'}
        </button>
        {activeCall && (
          <button
            disabled={pending || !connected}
            onClick={() => void run('hangup', { callId: call.id })}
          >
            통화 종료 요청
          </button>
        )}
        {!canDial && !offline && (
          <small>
            실제 전화 모드의 발령 확정, 수신 번호·동의, 전화 서버 연결을
            확인하세요.
          </small>
        )}
        {call?.blocked && (
          <div className="phone-resolve">
            <p>
              전화 종료 여부가 불명확해 다음 발신과 지도 진행을 보류했습니다.
            </p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={confirmedEnded}
                onChange={(event) => setConfirmedEnded(event.target.checked)}
                disabled={pending}
              />
              운영자가 실제 전화 종료를 확인했습니다
            </label>
            <button
              disabled={!confirmedEnded || pending || !connected}
              onClick={() =>
                void run('resolve', {
                  callId: call.id,
                  confirmedEnded: true,
                })
              }
            >
              종료 확인·진행 재개
            </button>
          </div>
        )}
      </div>
      <p className="call-map-note">
        오른쪽 지도에서 구조 이동을 확인하세요. 차량·대원의 이동 경로는 시연이며
        실제 GPS 위치가 아닙니다.
      </p>
    </div>
  );
}
