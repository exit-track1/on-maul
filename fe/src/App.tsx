import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Btn, Card, Pill, Ring } from './components';
import { Client } from './mock/client';
import {
  Calls,
  Counters,
  Households,
  MapPanel,
  Records,
  Resources,
  Sources,
  StateTag,
  type Tab,
} from './tabs/Panels';
import { handover, staleReason } from '../../shared/src/domain.ts';
import type { View } from '../../shared/src/runtime.ts';
import { parseHouseholdNotes } from '../../shared/src/household-notes.ts';
import {
  sourceReadings,
  validReplayCount,
} from '../../shared/src/monitoring.ts';
const tabs: { id: Tab; name: string }[] = [
  { id: 'map', name: '지도' },
  { id: 'calls', name: '통화' },
  { id: 'resources', name: '자원·5분대기조' },
  { id: 'households', name: '가구 명단' },
  { id: 'sources', name: '데이터 소스' },
  { id: 'records', name: '기록' },
];
const modes = {
  idle: '평시 관리',
  watch: '감시',
  event: '발생 대응',
  record: '기록',
};
function Dialog({
  title,
  children,
  close,
  drawer = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={drawer ? 'drawer' : 'modal'}
      onCancel={close}
      aria-labelledby="dialog-title"
    >
      <div className="dialog-head">
        <h2 id="dialog-title">{title}</h2>
        <button onClick={close} aria-label="닫기">
          닫기
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Drawer({
  id,
  view,
  run,
  close,
}: {
  id: string;
  view: View;
  run: (
    action: string,
    input?: Record<string, unknown>,
  ) => Promise<View | null>;
  close: () => void;
}) {
  const h = view.data.households.find((h) => h.id === id)!;
  const s = view.scenario.householdStatuses.find((s) => s.householdId === id)!;
  const [mobility, setMobility] = useState(h.mobility),
    [consent, setConsent] = useState(h.consentToCall),
    [source, setSource] = useState('담당자'),
    [fields, setFields] = useState(['mobility']);
  const [vehicle, setVehicle] = useState('V01');
  const [companionLabel, setCompanionLabel] = useState('동반자(가상)');
  const [companionMobility, setCompanionMobility] = useState('자력');
  const noteProposal = parseHouseholdNotes({
    note: h.originalNote,
    health: h.healthNotes,
    mobility: h.mobility,
    age: h.age,
  });
  useEffect(() => {
    setMobility(h.mobility);
    setConsent(h.consentToCall);
  }, [h.mobility, h.consentToCall]);
  return (
    <Dialog drawer title={`${h.id} ${h.name} · 가구 상세`} close={close}>
      <div className="drawer-body">
        <StateTag view={view} id={id} />
        <div className="drawer-summary">
          <strong>
            취약 {h.priorityGrade}등급 · {h.age}세
          </strong>
          <p>{h.addressLabel}</p>
          <p>
            담당 {view.data.teams.find((t) => t.id === h.teamId)?.name} ·{' '}
            {h.shelterId}
          </p>
        </div>
        <h3>비고 원문 · 구조화 결과</h3>
        <div className="note-pair">
          <blockquote>{h.originalNote || '비고 없음'}</blockquote>
          <dl>
            <dt>장비</dt>
            <dd>{h.devices.join(' · ') || '없음'}</dd>
            <dt>동거</dt>
            <dd>{h.cohabitant}</dd>
            <dt>연락</dt>
            <dd>
              {h.phoneKind} · {h.contactRef ?? '없음'}
            </dd>
            <dt>보호자</dt>
            <dd>
              {h.guardian
                ? `${h.guardian.relationship} ${h.guardian.name} · 모의 연락처`
                : '없음'}
            </dd>
          </dl>
        </div>
        <details>
          <summary>비고 규칙 구조화 제안·원문 근거</summary>
          <p>
            규칙 제안 · 취약 {noteProposal.vulnerability}등급 · 장비{' '}
            {noteProposal.devices.join(' · ') || '확인 필요'} ·{' '}
            {noteProposal.estimated
              ? '불명 항목을 포함한 보수적 제안'
              : '명시적 원문 근거'}
          </p>
          <p>
            원문과 현재 거동 기록을 검토한 뒤 적용하세요. 확인일은 직접 확인
            저장에서 갱신합니다.
          </p>
          <ul>
            {[
              ...new Set(
                Object.values(noteProposal.evidence)
                  .flatMap((facts) => facts ?? [])
                  .map((fact) => fact.quote),
              ),
            ].map((quote) => (
              <li key={quote}>“{quote}”</li>
            ))}
          </ul>
          <Btn
            size="sm"
            kind="outline"
            disabled={
              view.frozen || view.trips.some((t) => t.householdId === h.id)
            }
            onClick={() =>
              void run('notes-restructure', { id, revision: view.revision })
            }
          >
            원문 규칙 재구조화 적용
          </Btn>
          {h.noteExtraction && (
            <p role="status">
              규칙 제안 적용됨 · 원문 근거와 불명 항목을 보존했습니다.
            </p>
          )}
        </details>
        <h3>구조화 필드 편집</h3>
        <label>
          거동
          <select
            value={mobility}
            onChange={(e) => setMobility(e.target.value)}
            disabled={view.frozen}
          >
            {['자력', '보조', '와상', '불명'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            disabled={view.frozen}
          />
          합성 데이터의 발신 동의
        </label>
        <p className="muted">
          필드 저장만으로 확인일을 갱신하지 않습니다. 실수신자의 동의를 대신하지
          않습니다.
        </p>
        <Btn
          size="sm"
          kind="outline"
          disabled={view.frozen}
          onClick={() =>
            void run('edit', { id, mobility, consent, revision: view.revision })
          }
        >
          필드 저장
        </Btn>
        <h3>30초 모의 확인</h3>
        <p>
          {h.sourceType} · {h.lastCheckedAt ?? '확인일 없음'}
          <br />
          <span className="flag">
            {staleReason(h.lastCheckedAt, view.data.metadata.referenceDate) ??
              '90일 내 유효'}
          </span>
        </p>
        <label>
          확인 출처
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {['담당자', '생활지원사', '이장', '보건지소', '가족', '통화'].map(
              (x) => (
                <option key={x}>{x}</option>
              ),
            )}
          </select>
        </label>
        <fieldset>
          <legend>직접 확인한 필드</legend>
          {[
            ['mobility', '거동'],
            ['phoneKind', '연락 수단'],
            ['cohabitant', '동거'],
            ['consentToCall', '동의'],
            ['devices', '필요 장비'],
          ].map(([key, label]) => (
            <label className="checkbox" key={key}>
              <input
                type="checkbox"
                checked={fields.includes(key)}
                onChange={(e) =>
                  setFields(
                    e.target.checked
                      ? [...fields, key]
                      : fields.filter((f) => f !== key),
                  )
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
        <Btn
          disabled={view.frozen || fields.length === 0}
          onClick={() => void run('check', { id, source, fields })}
        >
          모의 확인 저장
        </Btn>
        <h3>확인 이력</h3>
        {view.data.checkLogs
          .filter((l) => l.householdId === id)
          .toReversed()
          .map((l) => (
            <div className="history" key={l.id}>
              <b>
                {l.sourceType} · {l.checkedAt.slice(0, 10)}
              </b>
              <p>
                {l.checkedFields.join(' · ')} · {l.operatorLabel}
              </p>
              <small>{l.evidence}</small>
            </div>
          ))}
        <h3>가족 응답·임시 제외</h3>
        <div className="toolbar">
          {['입원', '시설 입소', '전출', '복귀'].map((status) => (
            <Btn
              kind="outline"
              size="sm"
              key={status}
              disabled={view.frozen}
              onClick={() => void run('family', { id, status })}
            >
              {status}
            </Btn>
          ))}
        </div>
        <h3>다음 조치</h3>
        {!h.callEligible ? (
          <Btn
            kind="outline"
            disabled={view.frozen || s.visitCompleted}
            onClick={() => void run('visit-complete', { id })}
          >
            {s.visitCompleted
              ? '방문 모의 확인 완료'
              : '방문 모의 확인 완료 기록'}
          </Btn>
        ) : null}
        {['refuse', 'visiting'].includes(s.status) && (
          <>
            <Btn
              kind="outline"
              disabled={view.frozen}
              onClick={() => void run('leader-request', { id })}
            >
              이장 연결 요청·수동 연락
            </Btn>
            {view.leaderRequested.includes(id) && (
              <div className="toolbar">
                {['이동 확인', '방문 필요', '연락 불가'].map((result) => (
                  <Btn
                    key={result}
                    kind="outline"
                    size="sm"
                    disabled={view.frozen}
                    onClick={() => void run('leader-result', { id, result })}
                  >
                    {result}
                  </Btn>
                ))}
              </div>
            )}
          </>
        )}
        <h3>동반자 · 수송 정원</h3>
        <p>
          본인 포함 {1 + (s.companions?.length ?? 0)}명 · 새 동반자는 가상
          정보로 입력합니다.
        </p>
        {(s.companions ?? []).map((c) => (
          <p key={c.id}>
            {c.label} · {c.mobility}
          </p>
        ))}
        <label>
          동반자 가상 표시
          <input
            value={companionLabel}
            maxLength={40}
            onChange={(e) => setCompanionLabel(e.target.value)}
          />
        </label>
        <label>
          동반자 거동
          <select
            value={companionMobility}
            onChange={(e) => setCompanionMobility(e.target.value)}
          >
            {['자력', '보조', '와상', '불명'].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <Btn
          kind="outline"
          disabled={
            view.frozen ||
            Boolean(s.temporaryExclusion) ||
            ['safe', 'rescued'].includes(s.status) ||
            view.trips.some((t) => t.householdId === id)
          }
          onClick={() =>
            void run('companion', {
              id,
              label: companionLabel,
              mobility: companionMobility,
              revision: view.revision,
            })
          }
        >
          가상 동반자 추가
        </Btn>
        {s.dispatchHold && <p role="status">배차 보류 · {s.dispatchHold}</p>}
        {['help', 'e119', 'visiting', 'visit'].includes(s.status) && (
          <>
            <label>
              모의 수송 자원
              <select
                value={vehicle}
                onChange={(e) => setVehicle(e.target.value)}
              >
                {view.data.vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id} {v.name}
                  </option>
                ))}
              </select>
            </label>
            <Btn
              disabled={
                !view.plan?.confirmed || view.frozen || view.networkDown
              }
              kind="outline"
              onClick={() => void run('dispatch', { id, vehicleId: vehicle })}
            >
              조건 검증 후 모의 배차
            </Btn>
            <p className="muted">
              장비·대피소 접근성·운전자·정원·ETA·예약을 검사합니다.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
export default function App() {
  const [client] = useState(() => new Client()),
    [view, setView] = useState(() => client.local.view()),
    [tab, setTab] = useState<Tab>('map'),
    [modal, setModal] = useState<'confirm' | 'close' | 'assistant' | null>(
      null,
    ),
    [selected, setSelected] = useState<string | null>(null),
    [message, setMessage] = useState(''),
    [chat, setChat] = useState('몇 집 남았나'),
    [mobile, setMobile] = useState<'canvas' | 'log'>('canvas'),
    [pending, setPending] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(location.search).get('demo') === '1') return;
    let active = true;
    void client
      .connect()
      .then((v) => {
        if (active) setView(v);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [client]);
  async function command(
    action: string,
    input: Record<string, unknown> = {},
  ): Promise<View | null> {
    setPending(true);
    try {
      const next = await client.command(action, input);
      setView(next);
      setMessage('');
      return next;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '요청 오류');
      return null;
    } finally {
      setPending(false);
    }
  }
  async function run(action: string, input: Record<string, unknown> = {}) {
    await command(action, input);
  }
  const c = view.scenario.counts,
    notChecked = view.data.households.filter(
      (h) =>
        staleReason(h.lastCheckedAt, view.data.metadata.referenceDate) ||
        h.mobility === '불명',
    ).length;
  const failed = view.handoffs.filter((h) =>
      ['failed', 'pendingunknown'].includes(h.status),
    ).length,
    leaders = view.scenario.householdStatuses.filter(
      (s) => ['refuse', 'visiting'].includes(s.status) && !s.temporaryExclusion,
    ).length;
  const decision = failed
    ? `119 인계 오류 ${failed}건`
    : view.plan && !view.plan.confirmed
      ? '확정 대기'
      : view.scenario.mode === 'watch'
        ? '발령 절차 시작'
        : view.reassignments.some((p) => p.status === 'pending')
          ? `재배정 승인 ${view.reassignments.filter((p) => p.status === 'pending').length}건`
          : leaders
            ? `이장 연결·결과 ${leaders}건`
            : null;
  const props = { view, run, open: setSelected };
  const readings = sourceReadings(view);
  const time = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(view.scenario.displayTime));
  function decisionClick() {
    if (failed) setTab('calls');
    else if (view.plan && !view.plan.confirmed) setModal('confirm');
    else if (view.scenario.mode === 'watch') void run('plan');
    else if (view.reassignments.some((p) => p.status === 'pending'))
      setTab('resources');
    else setTab('calls');
  }
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <Ring size={25} />
          <strong>온 마을</strong>
          <span>한 집도 빠짐없이</span>
        </div>
        <div className="header-controls">
          <label>
            시연 장면
            <select
              aria-label="시연 장면"
              value={view.scenario.id}
              onChange={(e) => void run('scenario', { id: e.target.value })}
              disabled={pending}
            >
              {view.data.scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <Pill tone="soft">
            {client.connected ? '서버 연결' : '브라우저 단독 mock'}
          </Pill>
          <button
            className="text-button"
            onClick={() =>
              void client
                .connect()
                .then((v) => {
                  setView(v);
                  setMessage('서버 연결됨');
                })
                .catch(() => setMessage('mock 서버를 실행하세요: npm run dev'))
            }
          >
            서버 연결
          </button>
          <time>{time} KST</time>
        </div>
      </header>
      <aside className="sidebar">
        <div className="eyebrow">운영 단계</div>
        <ol className="mode-list">
          {Object.entries(modes).map(([id, label], i) => (
            <li
              key={id}
              aria-current={view.scenario.mode === id ? 'step' : undefined}
            >
              <span>0{i + 1}</span>
              <b>{label}</b>
              {view.scenario.mode === id && (
                <small>
                  {id === 'event'
                    ? view.plan?.confirmed
                      ? '모의 발신 진행'
                      : '담당자 확정 대기'
                    : '현재 단계'}
                </small>
              )}
            </li>
          ))}
        </ol>
        <div className="sidebar-sources">
          <h3>합성 소스</h3>
          {view.data.sources.map((s) => (
            <button key={s.id} onClick={() => setTab('sources')}>
              <span
                className={`source-dot ${!view.networkDown && readings.find((x) => x.source.id === s.id)?.status?.status === 'replay' ? 'ok' : ''}`}
              />
              {s.category}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <p>48가구 · 4개 대기조</p>
          <p>
            실제 수신자 없음
            <br />
            전체 합성 데이터
          </p>
          <strong>시연 담당자</strong>
          <small>가상 면사무소 재난 담당</small>
        </div>
      </aside>
      <div className="situation" aria-live="polite">
        <strong>{modes[view.scenario.mode]}</strong>
        {view.scenario.mode === 'idle' ? (
          <span>
            48가구 · 방문 확인 대상 {c.visit} · 확인 필요 {notChecked}
          </span>
        ) : view.scenario.mode === 'watch' ? (
          <span>
            합성 수신 {view.networkDown ? 0 : validReplayCount(view)}
            /8 · 발신 없음
          </span>
        ) : (
          <>
            <span className="act">
              조치 필요 <b>{c.act}</b>
            </span>
            <span className="prog">
              진행 <b>{c.prog}</b>
            </span>
            <span className="safe">
              안전{' '}
              <b>
                {c.safe}/{c.eligible}
              </b>
            </span>
          </>
        )}
        <span className="aux-count">
          방문 {c.visit} · 임시 제외 {c.temporarilyExcluded}
        </span>
        {decision && !view.frozen && (
          <button className="decision-pill" onClick={decisionClick}>
            {decision} →
          </button>
        )}
      </div>
      <section
        className={`log-panel ${mobile !== 'log' ? 'mobile-hidden' : ''}`}
        aria-label="상황 로그"
      >
        <div className="log-heading">
          <h2>상황 로그</h2>
          <Pill size="sm">합성 시연</Pill>
        </div>
        <div className="log-scroll">
          <div className="phase-guide">
            <div className="eyebrow">지금 해야 할 일</div>
            <h3>
              {view.scenario.mode === 'idle'
                ? '명단을 먼저 확인하세요'
                : view.scenario.mode === 'watch'
                  ? '수신 근거를 검토하세요'
                  : view.plan && !view.plan.confirmed
                    ? '순서를 검토하고 확정하세요'
                    : view.frozen
                      ? '미해결 인수인계를 보존합니다'
                      : '조치 필요 가구를 확인하세요'}
            </h3>
            <p>
              {view.plan?.confirmed
                ? '이동 중·차량 출동·119 모의 접수는 안전 완료가 아닙니다.'
                : '담당자 확정 전에는 실제·가상 발신이 없습니다.'}
            </p>
          </div>
          {view.scenario.mode === 'watch' && (
            <Card>
              <span className="eyebrow">규칙 제안 · 합성 경보</span>
              <h3>북서 구역 대피 지시 시연</h3>
              <p>합성 재난문자와 바람 관측을 참고한 모의 경보입니다.</p>
              <div className="toolbar">
                <Btn
                  size="sm"
                  disabled={pending}
                  onClick={() => void run('plan')}
                >
                  발령 절차 시작
                </Btn>
                <Btn
                  kind="outline"
                  size="sm"
                  onClick={() => void run('dismiss')}
                >
                  오탐 기록
                </Btn>
              </div>
              <button className="text-button" onClick={() => setTab('sources')}>
                합성 원문 보기 →
              </button>
            </Card>
          )}
          {view.plan && !view.plan.confirmed && (
            <Card>
              <span className="eyebrow">규칙 제안 · 담당자 결정</span>
              <h3>발령 제안</h3>
              <p>
                전화 {view.plan.order.length} · 방문 {view.plan.visit.length} ·
                임시 제외 {view.plan.excluded.length}
              </p>
              <ol className="priority-preview">
                {view.plan.order.slice(0, 4).map((x) => (
                  <li key={x.householdId}>
                    {x.householdId} · {x.reason}
                  </li>
                ))}
              </ol>
              <p className="muted">
                비공식 데모 ETA · 실제 현장 판단을 대신하지 않습니다.
              </p>
              <Btn onClick={() => setModal('confirm')}>순서 검토·발령 확정</Btn>
            </Card>
          )}
          {view.networkDown && (
            <Card>
              <h3>통신 두절 시연</h3>
              <p>신규 발신·모의 인계 전송 보류. 기존 세션은 유지합니다.</p>
              <p>
                이 안내는 모의 방송 문안입니다. 지정 대피소를 확인해 주세요.
                통제 도로를 피해야 합니다. 이동 지원이 필요한 집을 방문 목록에서
                확인해 주세요. 현장 담당자의 지시를 따릅니다. 긴급 상황은
                담당자가 수동 연락으로 연결합니다.
              </p>
              <Btn kind="outline" size="sm" onClick={() => setTab('records')}>
                전체 방문·지원 목록
              </Btn>
            </Card>
          )}
          {view.records
            .toReversed()
            .slice(0, 15)
            .map((r) => (
              <article
                className={`log-card ${r.actorType === 'human' ? 'human' : ''}`}
                key={r.id}
              >
                <div className="eyebrow">
                  {r.actorType === 'human'
                    ? '담당자 결정'
                    : r.actorType === 'assistant'
                      ? '규칙 제안'
                      : '시스템 진행'}{' '}
                  ·{' '}
                  {new Intl.DateTimeFormat('ko-KR', {
                    timeZone: 'Asia/Seoul',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  }).format(new Date(r.timestamp))}
                </div>
                <p>{r.label}</p>
                {r.householdId && (
                  <button
                    className="text-button"
                    onClick={() => setSelected(r.householdId!)}
                  >
                    {r.householdId} 상세 →
                  </button>
                )}
              </article>
            ))}
        </div>
        <div className="log-summary">
          조치 {c.act} · 진행 {c.prog} · 안전 {c.safe}/{c.eligible} · 방문{' '}
          {c.visit}
        </div>
        <div className="quick-actions">
          {view.scenario.mode === 'idle' && (
            <Btn onClick={() => void run('watch')}>감시 시작</Btn>
          )}
          {view.scenario.mode === 'event' && (
            <>
              <Btn kind="outline" size="sm" onClick={() => setTab('calls')}>
                통화 현황
              </Btn>
              <Btn kind="outline" size="sm" onClick={() => setTab('resources')}>
                자원 현황
              </Btn>
              <Btn
                kind="outline"
                size="sm"
                onClick={() => void run('comms', { down: !view.networkDown })}
              >
                {view.networkDown ? '통신 복구 시연' : '통신 두절 시연'}
              </Btn>
              <Btn kind="outline" size="sm" onClick={() => setModal('close')}>
                기록으로 종료
              </Btn>
            </>
          )}
          <Btn kind="outline" size="sm" onClick={() => setModal('assistant')}>
            상황실 도우미
          </Btn>
        </div>
      </section>
      <main
        className={`canvas-panel ${mobile !== 'canvas' ? 'mobile-hidden' : ''}`}
      >
        <div className="tab-list" role="tablist" aria-label="상황실 탭">
          {tabs.map((t, i) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const next =
                    tabs[(i + (e.key === 'ArrowRight' ? 1 : 5)) % 6].id;
                  setTab(next);
                  document.getElementById(`tab-${next}`)?.focus();
                }
              }}
            >
              {t.name}
            </button>
          ))}
        </div>
        <div
          className="canvas-scroll"
          id={`panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
          tabIndex={0}
        >
          {tab === 'map' ? (
            <MapPanel {...props} />
          ) : tab === 'calls' ? (
            <Calls {...props} />
          ) : tab === 'resources' ? (
            <Resources {...props} />
          ) : tab === 'households' ? (
            <Households {...props} />
          ) : tab === 'sources' ? (
            <Sources {...props} />
          ) : (
            <Records {...props} />
          )}
        </div>
      </main>
      <div className="mobile-switch">
        <button
          aria-pressed={mobile === 'canvas'}
          onClick={() => setMobile('canvas')}
        >
          상황 화면
        </button>
        <button
          aria-pressed={mobile === 'log'}
          onClick={() => setMobile('log')}
        >
          상황 로그·결정
        </button>
      </div>
      {message && (
        <div className="toast" role="alert">
          <p>{message}</p>
          <button onClick={() => setMessage('')}>닫기</button>
        </div>
      )}
      {selected && (
        <Drawer
          key={selected}
          id={selected}
          view={view}
          run={command}
          close={() => setSelected(null)}
        />
      )}{' '}
      {modal === 'confirm' && view.plan && (
        <Dialog title="발령 순서 검토·모의 확정" close={() => setModal(null)}>
          <div className="modal-body">
            <p>
              전화 {view.plan.order.length} · 방문 {view.plan.visit.length} ·
              임시 제외 {view.plan.excluded.length}
            </p>
            <p>
              공용 최대 8채널 · 전체 모의 발신 · 실제 SMS·119 없음
              <br />
              이장 연결·결과와 조 재배정은 담당자 결정입니다.
            </p>
            <div className="plan-list">
              <table>
                <thead>
                  <tr>
                    <th>순위</th>
                    <th>가구</th>
                    <th>제안 근거</th>
                    <th>순서 수정</th>
                  </tr>
                </thead>
                <tbody>
                  {view.plan.order.map((x, i) => (
                    <tr key={x.householdId}>
                      <td>{i + 1}</td>
                      <th scope="row">{x.householdId}</th>
                      <td>{x.reason}</td>
                      <td>
                        {[-1, 1].map((d) => (
                          <button
                            key={d}
                            aria-label={`${x.householdId} ${d < 0 ? '위로' : '아래로'}`}
                            disabled={
                              pending ||
                              i + d < 0 ||
                              i + d >= view.plan!.order.length ||
                              view.plan!.confirmed
                            }
                            onClick={() => {
                              const ids = view.plan!.order.map(
                                (x) => x.householdId,
                              );
                              [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
                              void run('reorder', {
                                ids,
                                revision: view.revision,
                              });
                            }}
                          >
                            {d < 0 ? '↑' : '↓'}
                          </button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              방문: {view.plan.visit.map((x) => x.householdId).join(' · ')}
              <br />
              임시 제외: {view.plan.excluded.join(' · ') || '없음'}
            </p>
            <Btn
              disabled={pending || view.networkDown || view.plan.confirmed}
              onClick={() =>
                void command('confirm', { revision: view.revision }).then(
                  (v) => {
                    if (v) {
                      setModal(null);
                      setTab('calls');
                    }
                  },
                )
              }
            >
              확정하고 모의 발신 시작
            </Btn>
          </div>
        </Dialog>
      )}
      {modal === 'close' && (
        <Dialog title="미해결 인수인계 확인" close={() => setModal(null)}>
          <div className="modal-body">
            <Counters view={view} />
            <p>
              현재 미해결 {handover(view.data.households, view.scenario).length}
              건을 인수인계에 남깁니다. 이동·출동·모의 접수 상태도 포함하며 안전
              상태를 일괄 생성하지 않습니다.
            </p>
            <Btn
              onClick={() =>
                void command('close', { acknowledged: true }).then((v) => {
                  if (v) {
                    setModal(null);
                    setTab('records');
                  }
                })
              }
            >
              인수인계 확인·종료 스냅샷 저장
            </Btn>
          </div>
        </Dialog>
      )}
      {modal === 'assistant' && (
        <Dialog title="상황실 도우미" close={() => setModal(null)}>
          <div className="modal-body">
            <Pill tone="soft">규칙 mock · 모델 호출 없음</Pill>
            <p>구역별 조치·남은 가구·자원·미확정 순서를 조회합니다.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run('assistant', { text: chat, revision: view.revision });
              }}
            >
              <label>
                명령
                <input
                  value={chat}
                  onChange={(e) => setChat(e.target.value)}
                  maxLength={500}
                />
              </label>
              <button type="submit">조회·제안</button>
            </form>
            <p className="assistant-answer" aria-live="polite">
              {view.assistantAnswer || '아직 요청하지 않았습니다.'}
            </p>
            <div className="toolbar">
              {['몇 집 남았나', '북 구역', '자원 현황', '12번 가구 1순위'].map(
                (x) => (
                  <button
                    key={x}
                    onClick={() => {
                      setChat(x);
                      void run('assistant', {
                        text: x,
                        revision: view.revision,
                      });
                    }}
                  >
                    {x}
                  </button>
                ),
              )}
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
