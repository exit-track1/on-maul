import { useEffect, useRef, useState } from 'react';
import type { View } from '../../../../shared/src/runtime.ts';
import type { CallRole } from '../../../../shared/src/showcase-cases.ts';

export function CallHistory({
  view,
  role,
  focus,
}: {
  view: View;
  role: CallRole;
  focus: (id: string) => void;
}) {
  const replay = view.showcase!;
  const [selected, setSelected] = useState('auto');
  const transcript = useRef<HTMLDivElement>(null);
  const calls = replay.calls.filter((c) => c.role === role);
  const activeId =
    role === 'resident'
      ? replay.activeResidentCallId
      : replay.activeRescuerCallId;
  const active = calls.find((c) => c.id === activeId) ?? calls.at(-1);
  const call = calls.find((c) => c.id === selected) ?? active;
  const household = view.data.households.find(
    (h) => h.id === call?.householdId,
  );
  useEffect(() => {
    setSelected('auto');
  }, [replay.loop, replay.seed]);
  useEffect(() => {
    if (transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [call?.id, call?.turns.length]);
  return (
    <section
      className={`replay-phone replay-phone-${role}`}
      data-testid={`${role}-phone`}
      aria-label={
        role === 'resident' ? '주민 전화 에이전트' : '구조 전화 에이전트'
      }
    >
      <div className="replay-phone-head">
        <div>
          <span className="replay-kicker">
            {role === 'resident' ? 'EVACUATION AGENT' : 'DISPATCH AGENT'}
          </span>
          <h2>
            {role === 'resident' ? '주민 전화 에이전트' : '구조 전화 에이전트'}
          </h2>
        </div>
        <span
          className={`replay-badge ${call?.phase === 'calling' ? 'is-active' : ''}`}
        >
          {call?.phase === 'calling' ? '모의 통화 중' : '모의 통화'}
        </span>
      </div>
      <div className="replay-phone-target">
        <div>
          <strong>{call?.targetName ?? '출동 확인 대기'}</strong>
          <span>
            {role === 'rescuer'
              ? `구조 대상: ${household?.name ?? '요청 대기'}`
              : `${household?.id ?? ''} · ${household?.addressLabel ?? ''}`}
          </span>
        </div>
        {household && (
          <button
            className="replay-focus"
            onClick={() => focus(household.id)}
            aria-label={`${household.name} 지도에서 보기`}
          >
            집 위치 ↗
          </button>
        )}
      </div>
      <select
        aria-label={`${role === 'resident' ? '주민' : '구조대원'} 통화 내역 선택`}
        value={calls.some((c) => c.id === selected) ? selected : 'auto'}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="auto">
          자동 따라가기 · {call?.title ?? '통화 대기'}
        </option>
        {[...calls].reverse().map((c) => (
          <option key={c.id} value={c.id}>
            {c.targetName} · {c.title} {c.phase === 'completed' ? '✓' : ''}
          </option>
        ))}
      </select>
      <div className="replay-node" data-testid={`${role}-node`}>
        <span>현재 단계</span>
        <strong>{call?.turns.at(-1)?.node ?? '구조 요청 대기'}</strong>
        {call?.turns.at(-1)?.node.includes('↻') && (
          <span className="replay-loop">↻ 질문·판단 반복</span>
        )}
      </div>
      <div
        className="replay-transcript"
        ref={transcript}
        aria-live="polite"
        aria-relevant="additions"
        data-testid={`${role}-transcript`}
      >
        {!call && (
          <p className="replay-empty">
            주민의 구조 요청이 접수되면 대원에게 출동 가능 여부를 확인합니다.
          </p>
        )}
        {call?.turns.map((turn, i) => (
          <article
            key={`${call.id}-${i}`}
            className={`replay-turn ${turn.speaker}`}
          >
            <div>
              <span>
                {turn.speaker === 'agent'
                  ? 'AI 에이전트 · 모의'
                  : turn.speaker === 'system'
                    ? '시스템 · 모의'
                    : turn.personName}
              </span>
              <time>T+{turn.at.toFixed(1)}분</time>
            </div>
            <p>{turn.text}</p>
          </article>
        ))}
      </div>
      <div className="replay-phone-result">
        {call?.phase === 'completed'
          ? `✓ ${call.outcome}`
          : '응답 판단 → 필요 시 재질문 → 시스템에 결과 전달'}
      </div>
    </section>
  );
}
