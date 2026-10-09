import { useState } from 'react';
import { Btn, Card, Pill } from '../components';
import {
  attentionDetail,
  groupOf,
  handover,
  nextAction,
  staleReason,
  STATUS_LABELS,
} from '../../../shared/src/domain.ts';
import type { Household } from '../../../shared/src/types.ts';
import type { View } from '../../../shared/src/runtime.ts';
import { dispatchSafety } from '../../../shared/src/dispatch.ts';
import {
  sourceMonitor,
  sourceReadings,
  validReplayCount,
} from '../../../shared/src/monitoring.ts';
export type Run = (
  action: string,
  input?: Record<string, unknown>,
) => Promise<void>;
export type Tab =
  'map' | 'calls' | 'resources' | 'households' | 'sources' | 'records';
export interface PanelProps {
  view: View;
  run: Run;
  open: (id: string) => void;
}
export function StateTag({ view, id }: { view: View; id: string }) {
  const h = view.data.households.find((h) => h.id === id)!,
    s = view.scenario.householdStatuses.find((s) => s.householdId === id)!,
    g = groupOf(h, s);
  return (
    <span className={`state ${g}`}>
      {g === 'excluded' ? s.temporaryExclusion : STATUS_LABELS[s.status]}
    </span>
  );
}
export function Counters({ view }: { view: View }) {
  const c = view.scenario.counts;
  return (
    <div className="counters" data-testid="counters">
      <div className="act">
        <span>조치 필요</span>
        <strong>{c.act}</strong>
      </div>
      <div className="prog">
        <span>진행</span>
        <strong>{c.prog}</strong>
      </div>
      <div className="safe">
        <span>안전</span>
        <strong>
          {c.safe}
          <small>/{c.eligible}</small>
        </strong>
      </div>
    </div>
  );
}
function HouseTable({
  view,
  open,
  rows,
  roster = false,
}: {
  view: View;
  open: (id: string) => void;
  rows: Household[];
  roster?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>성명</th>
            <th>등급</th>
            <th>거동</th>
            {roster && <th>몸상태</th>}
            <th>구역·주소</th>
            <th>연락</th>
            {roster ? (
              <>
                <th>마지막 확인</th>
                <th>점검 플래그</th>
              </>
            ) : (
              <>
                <th>상태</th>
                <th>다음 조치</th>
              </>
            )}
            <th>열기</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => {
            const s = view.scenario.householdStatuses.find(
                (s) => s.householdId === h.id,
              )!,
              stale = staleReason(
                h.lastCheckedAt,
                view.data.metadata.referenceDate,
              );
            return (
              <tr key={h.id} data-household={h.id}>
                <td>{h.id.slice(1)}</td>
                <th scope="row">{h.name}</th>
                <td>
                  <span className={`grade g${h.priorityGrade}`}>
                    {h.priorityGrade}
                  </span>
                </td>
                <td>{h.mobility}</td>
                {roster && (
                  <td>{h.healthNotes.join(' · ') || '특이사항 없음'}</td>
                )}
                <td>
                  {view.data.zones.find((z) => z.id === h.zoneId)?.label}
                  <small className="block">{h.addressLabel}</small>
                </td>
                <td>
                  {h.phoneKind}
                  <small className="block">
                    {h.callEligible ? '모의 연락처' : h.exclusionReason}
                  </small>
                </td>
                {roster ? (
                  <>
                    <td>
                      {h.sourceType}
                      <small className="block">
                        {h.lastCheckedAt ?? '확인일 없음'}
                      </small>
                    </td>
                    <td>
                      {stale && <span className="flag">{stale}</span>}
                      {h.mobility === '불명' && (
                        <span className="flag">이장 확인 필요</span>
                      )}
                      {!stale && h.mobility !== '불명' ? '—' : null}
                    </td>
                  </>
                ) : (
                  <>
                    <td>
                      <StateTag view={view} id={h.id} />
                      {s.acked && (
                        <small className="block">안내 되말 확인</small>
                      )}
                    </td>
                    <td>
                      {nextAction(s)}
                      {groupOf(h, s) === 'visit' && s.visitCompleted && (
                        <small className="block">방문 확인 완료</small>
                      )}
                    </td>
                  </>
                )}
                <td>
                  <button
                    className="text-button"
                    onClick={() => open(h.id)}
                    aria-label={`${h.id} ${h.name} 열기`}
                  >
                    열기
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
export function Households({ view, open }: PanelProps) {
  const [filter, setFilter] = useState('all');
  const hs = view.data.households;
  const filters = [
    ['all', '전체', () => true],
    ['4', '등급 4', (h: Household) => h.priorityGrade === 4],
    ['3', '등급 3', (h: Household) => h.priorityGrade === 3],
    ['consent', '동의 없음', (h: Household) => !h.consentToCall],
    ['phone', '전화 없음', (h: Household) => h.phoneKind === '없음'],
    [
      'stale',
      '90일 초과',
      (h: Household) =>
        staleReason(
          h.lastCheckedAt,
          view.data.metadata.referenceDate,
        )?.startsWith('90일'),
    ],
    ['unknown', '이장 확인 필요', (h: Household) => h.mobility === '불명'],
  ] as const;
  const rows = hs
    .filter(filters.find((f) => f[0] === filter)![2])
    .sort(
      (a, b) =>
        b.priorityGrade - a.priorityGrade ||
        'NESW'.indexOf(a.zoneId) - 'NESW'.indexOf(b.zoneId) ||
        a.id.localeCompare(b.id),
    );
  const valid = hs.filter(
    (h) => !staleReason(h.lastCheckedAt, view.data.metadata.referenceDate),
  ).length;
  return (
    <>
      <div className="panel-title">
        <div>
          <h2>가구 명단</h2>
          <p>기존 접점에 30초 확인을 더합니다.</p>
        </div>
        <Pill tone="soft">합성 48가구</Pill>
      </div>
      <div className="source-bar">
        <strong>
          90일 내 확인 {valid}/{hs.length} ·{' '}
          {((valid / hs.length) * 100).toFixed(1)}%
        </strong>
        <span>방문 확인 대상 {hs.filter((h) => !h.callEligible).length}</span>
      </div>
      <div className="source-breakdown">
        {['생활지원사', '이장', '보건지소', '가족', '통화'].map((source) => (
          <span key={source}>
            {source} <b>{hs.filter((h) => h.sourceType === source).length}</b>
          </span>
        ))}
      </div>
      <div className="filters" aria-label="가구 필터">
        {filters.map(([id, label, test]) => (
          <button
            key={id}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label} {hs.filter(test).length}
          </button>
        ))}
      </div>
      <HouseTable view={view} open={open} rows={rows} roster />
    </>
  );
}
export function Calls({ view, run, open }: PanelProps) {
  const [filter, setFilter] = useState('all');
  const [id, setId] = useState('H012'),
    [text, setText] = useState('숨쉬기 힘들어요');
  const c = view.scenario.counts;
  const acts = view.scenario.householdStatuses.filter(
    (s) =>
      groupOf(
        view.data.households.find((h) => h.id === s.householdId)!,
        s,
      ) === 'act',
  );
  const rows = view.data.households.filter(
    (h) =>
      filter === 'all' ||
      groupOf(
        h,
        view.scenario.householdStatuses.find((s) => s.householdId === h.id)!,
      ) === filter,
  );
  return (
    <div className="call-board">
      <div className="panel-title">
        <div>
          <h2>확인 전화</h2>
          <p>안내 확인과 실제 도착 근거를 구분합니다.</p>
        </div>
        <Pill tone="soft">모의 통화</Pill>
      </div>
      <Counters view={view} />
      <div className="detail-counts">
        {[
          '긴급',
          '도움 미배차',
          '이장·연락 대기',
          '무응답·재발신',
          '확인 필요',
        ].map((x) => (
          <span key={x}>
            {x} <b>{acts.filter((s) => attentionDetail(s) === x).length}</b>
          </span>
        ))}
        <span>
          방문 <b>{c.visit}</b>
        </span>
      </div>
      <div className="compact-queues">
        <section aria-label="119 긴급 큐" aria-live="assertive">
          <strong>119 자동 인계(모의)</strong>
          {view.handoffs.length ? (
            view.handoffs.map((h) => (
              <div key={h.id}>
                <button
                  className="text-button"
                  onClick={() => open(h.householdId)}
                >
                  {h.householdId}
                </button>{' '}
                ·{' '}
                {h.status === 'mockRecorded'
                  ? '모의 접수 기록'
                  : h.status === 'local'
                    ? '현지 보관·수동 연락 필요'
                    : h.status}
                <small className="block">
                  구조 완료 근거 없음 · {h.receiptId ?? '접수 ID 없음'}
                </small>
              </div>
            ))
          ) : (
            <p>긴급 인계 없음</p>
          )}
        </section>
        <section aria-label="이장 큐">
          <strong>이장 연결·결과</strong>
          {acts
            .filter((s) => ['refuse', 'visiting'].includes(s.status))
            .map((s) => (
              <div key={s.householdId}>
                <button
                  className="text-button"
                  onClick={() => open(s.householdId)}
                >
                  {s.householdId}
                </button>{' '}
                · 수동 연락{' '}
                {view.leaderRequested.includes(s.householdId)
                  ? '요청 기록됨'
                  : '결정 대기'}
              </div>
            ))}
        </section>
      </div>
      <div className="toolbar">
        <span>
          공용 채널{' '}
          <b>
            {
              view.calls.filter((c) =>
                ['calling', 'pendingunknown'].includes(c.phase),
              ).length
            }
            /8
          </b>{' '}
          · 주민·조원 교대
        </span>
        <Btn
          size="sm"
          kind="outline"
          disabled={!view.plan?.confirmed || view.networkDown || view.frozen}
          onClick={() => void run('advance')}
        >
          모의 1분 진행
        </Btn>
      </div>
      <div className="filters">
        {[
          ['all', '전체'],
          ['act', '조치 필요'],
          ['prog', '진행'],
          ['safe', '안전'],
          ['visit', '방문'],
          ['excluded', '임시 제외'],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <HouseTable view={view} open={open} rows={rows} />
      <details className="simulation">
        <summary>후속 확인 예약·시도 이력</summary>
        <section aria-label="후속 확인 예약">
          {view.calls
            .filter(
              (c) =>
                c.targetType === 'resident' &&
                c.phase === 'queued' &&
                c.purpose !== 'initial',
            )
            .map((c) => (
              <p key={c.id}>
                {c.targetId} ·{' '}
                {c.purpose === 'arrival_check'
                  ? '이동 후 도착 재확인'
                  : c.purpose === 'clarification'
                    ? '확인 필요 재통화'
                    : `재발신 ${c.retryCount ?? 0}/8`}{' '}
                · T+{c.nextAt ?? view.simMinutes}분 · 시도 {c.attempt}
              </p>
            ))}
          <p>
            기본 예약은 확인 필요 5분·이동 중 15분입니다. 도착·제외·동의 변경은
            이전 예약을 취소합니다. 결과 불명 실제 통화는 자동 재발신하지
            않습니다.
          </p>
        </section>
      </details>
      {view.firstPass && (
        <div className="rule-line" role="status">
          1차 모의 확인 {view.firstPass.targets.length}가구 · 시뮬{' '}
          {view.firstPass.simulatedDurationMinutes}분 · 결과 불명{' '}
          {
            view.firstPass.targets.filter((t) => t.outcome === 'pendingunknown')
              .length
          }{' '}
          · 후속 확인·구조 완료는 별도
        </div>
      )}
      <details className="simulation">
        <summary>모의 전사·분류 시연</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run('transcript', { id, text });
          }}
        >
          <label>
            가구
            <select value={id} onChange={(e) => setId(e.target.value)}>
              {view.data.households
                .filter((h) => h.callEligible)
                .map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.id} {h.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            허구 발화
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={2000}
            />
          </label>
          <button disabled={!view.plan?.confirmed || view.frozen}>
            모의 전사 적용
          </button>
        </form>
      </details>
    </div>
  );
}
export function Resources({ view, run, open }: PanelProps) {
  const [targets, setTargets] = useState<Record<string, string>>({});
  const responses = Object.values(view.memberResponses);
  const pendingReassignments = view.reassignments.filter(
    (p) => p.status === 'pending',
  );
  return (
    <>
      <div className="panel-title">
        <div>
          <h2>자원·5분대기조</h2>
          <p>운전자·인원·장비·접근성·통제 경로를 함께 확인합니다.</p>
        </div>
      </div>
      <div className="rule-line">
        데모 ETA 15분 미만 일반 조 투입 금지 · 불명 시 보류 · 응급은 의료 수송
        검토
      </div>
      <div className="resource-summary">
        응답 가능 {responses.filter((r) => r === 'ok').length} · 불가{' '}
        {responses.filter((r) => r === 'no').length} · 대기{' '}
        {responses.filter((r) => r === 'waiting').length}/12명 · 현재 임무{' '}
        {view.trips.length}건 · 완료 {view.completedTrips.length}건
      </div>
      <div className="team-grid">
        {view.data.teams.map((t) => (
          <Card key={t.id}>
            <h3>{t.name}</h3>
            <p>
              {t.assignedHouseholdIds.length}가구 담당 · {t.vehicleId}
            </p>
            <p>
              데모 구역 잔여 ETA{' '}
              {dispatchSafety(view, t.assignedHouseholdIds[0]).zoneEta?.toFixed(
                1,
              ) ?? '불명'}
              분
            </p>
            <ul className="members">
              {t.members.map((m) => (
                <li key={m.id} data-member={m.id}>
                  <b>{m.name}</b>
                  <span>
                    {m.canDrive ? '운전 가능' : '지원'} · {m.availability}
                  </span>
                  <small>
                    {view.memberResponses[m.id] === 'waiting'
                      ? view.calls.some(
                          (c) =>
                            c.targetId === m.id &&
                            c.phase === 'queued' &&
                            c.purpose === 'redial',
                        )
                        ? `재호출 ${view.calls.findLast((c) => c.targetId === m.id && c.phase === 'queued')?.retryCount ?? 0}/2 대기`
                        : '호출 전/대기'
                      : view.memberResponses[m.id] === 'ok'
                        ? '모의 가능 응답'
                        : '모의 불가 응답'}
                  </small>
                  {view.calls
                    .filter(
                      (c) =>
                        c.targetId === m.id &&
                        c.targetType === 'member' &&
                        c.phase === 'calling' &&
                        c.mode === 'mock',
                    )
                    .map((c) => (
                      <div key={c.id}>
                        <small>
                          최초 포함 시도 {c.attempt} · 재호출{' '}
                          {c.retryCount ?? 0}/2
                        </small>
                        <Btn
                          size="sm"
                          kind="outline"
                          disabled={view.frozen || view.networkDown}
                          onClick={() =>
                            void run('member-response', {
                              callId: c.id,
                              outcome: 'noanswer',
                            })
                          }
                          aria-label={`${m.id} 모의 무응답`}
                        >
                          무응답 시연
                        </Btn>
                      </div>
                    ))}
                </li>
              ))}
            </ul>
            <details>
              <summary>담당 가구 {t.assignedHouseholdIds.length}</summary>
              <div className="house-links">
                {t.assignedHouseholdIds.map((id) => (
                  <button key={id} onClick={() => open(id)}>
                    {id}
                  </button>
                ))}
              </div>
            </details>
            {view.plan?.confirmed && (
              <div className="toolbar">
                <label>
                  재배정 대상
                  <select
                    aria-label={`${t.name} 재배정 대상`}
                    value={targets[t.id] ?? t.assignedHouseholdIds[0]}
                    onChange={(e) =>
                      setTargets({ ...targets, [t.id]: e.target.value })
                    }
                  >
                    {t.assignedHouseholdIds.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
                <Btn
                  kind="outline"
                  size="sm"
                  disabled={view.frozen || view.networkDown}
                  onClick={() =>
                    void run('reassign-propose', {
                      id: targets[t.id] ?? t.assignedHouseholdIds[0],
                      revision: view.revision,
                    })
                  }
                >
                  재배정 후보 검토
                </Btn>
              </div>
            )}
          </Card>
        ))}
      </div>
      <section aria-label="재배정 승인 대기">
        {pendingReassignments.map((p) => (
          <Card key={p.id}>
            <h3>{p.householdId} 재배정 승인 대기</h3>
            <p>
              기존 {p.fromTeamId} · 승인 전 임무 예약/실행 없음 · 승인 시 최신
              조건 재검증
            </p>
            {p.candidates.map((c) => (
              <div className="toolbar" key={c.vehicleId ?? '119'}>
                <span>
                  {c.vehicleId ?? '119 지원'} · {c.reason}
                </span>
                <Btn
                  kind="outline"
                  size="sm"
                  disabled={view.frozen || view.networkDown}
                  onClick={() =>
                    void run('reassign-approve', {
                      id: p.id,
                      vehicleId: c.vehicleId,
                      revision: view.revision,
                    })
                  }
                >
                  {c.vehicleId ?? '119 지원'} 재배정 승인
                </Btn>
              </div>
            ))}
            <Btn
              kind="outline"
              size="sm"
              disabled={view.frozen}
              onClick={() =>
                void run('reassign-reject', {
                  id: p.id,
                  revision: view.revision,
                })
              }
            >
              재배정 반려
            </Btn>
          </Card>
        ))}
      </section>
      <h3>
        차량 자원 10개 <small>번호판 가상</small>
      </h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>차량</th>
              <th>가상 번호</th>
              <th>소속·운전</th>
              <th>정원</th>
              <th>장비</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {view.data.vehicles.map((v) => (
              <tr key={v.id}>
                <th scope="row">
                  {v.name}
                  <small className="block">{v.kind}</small>
                </th>
                <td>{v.plateLabel}</td>
                <td>
                  {v.organizationLabel}
                  <small className="block">{v.driverRef}</small>
                </td>
                <td>{v.capacity}</td>
                <td>{v.equipment.join(' · ') || '없음'}</td>
                <td>
                  {view.trips.find((t) => t.vehicleId === v.id)?.stage ??
                    view.scenario.resourceStatuses.find(
                      (s) => s.vehicleId === v.id,
                    )?.status ??
                    'free'}
                  <small className="block">{v.unavailableReason}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>현재 모의 임무</h3>
      {view.trips.map((t) => (
        <Card key={t.id}>
          <p>
            {t.id} · {t.vehicleId} → {t.householdId} → {t.shelterId}
          </p>
          <p>
            현재 {t.stage} · 경로 {t.routeId} · 운전자 예약 {t.driverRef}
          </p>
          <p>
            {t.passengerCount}명 · 대피소 정원 예약 · 탑승 대기{' '}
            {Math.round(t.boardSim - t.arriveSim)}분 · 복귀 T+
            {t.returnSim.toFixed(1)}
          </p>
          {t.heldReason && <p role="status">임무 보류 · {t.heldReason}</p>}
          {t.heldReason && (
            <Btn
              kind="outline"
              size="sm"
              disabled={view.frozen || view.networkDown}
              onClick={() =>
                void run('trip-resume', { id: t.id, revision: view.revision })
              }
            >
              기존 경로 재검증·복구 승인
            </Btn>
          )}
          <Btn
            kind="outline"
            size="sm"
            disabled={Boolean(t.heldReason) || view.frozen}
            onClick={() =>
              void run('trip', {
                id: t.id,
                stage: {
                  depart: 'arrive',
                  arrive: 'boarded',
                  boarded: 'shelter',
                  shelter: 'return',
                  return: 'return',
                }[t.stage],
              })
            }
          >
            다음 모의 단계 보고
          </Btn>
        </Card>
      ))}
      <details>
        <summary>모의 도로 통제</summary>
        {view.data.map.roads.map((r) => (
          <div className="toolbar" key={r.id}>
            <span>
              {r.label} · {r.blocked ? '통제' : '개방'}
            </span>
            <Btn
              kind="outline"
              size="sm"
              disabled={view.frozen}
              onClick={() =>
                void run('road-control', {
                  id: r.id,
                  blocked: !r.blocked,
                  revision: view.revision,
                })
              }
            >
              {r.label} {r.blocked ? '통제 해제' : '통제 시연'}
            </Btn>
          </div>
        ))}
      </details>
      <h3>대피소 조건</h3>
      <div className="shelter-grid">
        {view.data.shelters.map((s) => (
          <Card key={s.id}>
            <h4>{s.name}</h4>
            <p>
              정원 {s.capacity} · 접근성{' '}
              {s.accessibility === 'confirmed' ? '확인(합성)' : '미확인'}
            </p>
            <p>
              입소{' '}
              {view.shelterAdmissions
                .filter((a) => a.shelterId === s.id)
                .reduce((n, a) => n + a.passengerCount, 0)}
              명 · 도착 전 예약{' '}
              {view.trips
                .filter((t) => t.shelterId === s.id && t.stage !== 'shelter')
                .reduce((n, t) => n + t.passengerCount, 0)}
              명
            </p>
            <p>동물 수용 {s.petsAllowed ? '가능' : '불가'}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
export function Sources({ view, run }: PanelProps) {
  const readings = sourceReadings(view),
    monitor = sourceMonitor(view),
    ok = view.networkDown ? 0 : validReplayCount(view),
    failures = readings.filter(
      ({ status }) => status?.liveAttemptStatus === 'failed',
    ).length;
  return (
    <>
      <div className="panel-title">
        <div>
          <h2>데이터 소스</h2>
          <p>자체 합성 스키마 · 정부 API 실수신 성공 기록 없음</p>
        </div>
        <Btn
          size="sm"
          kind="outline"
          onClick={() => void run('collect')}
          disabled={view.networkDown || view.frozen}
        >
          지금 모의 수집
        </Btn>
      </div>
      <div className="rule-line">
        유효 합성 재생 {ok}/8 · 수신 실패 시연 {failures} · 실제 모델 호출{' '}
        {view.sourceState.actualModelCalls}회
        <small className="block">
          규칙 필터 통과 {monitor.eligibleModelCallCount}건 · 실제 API 수신 없음
          · 기본 최신성 한도는 수집 주기의 2배
        </small>
      </div>
      <div className="source-grid">
        {readings.map(({ source: s, status }) => {
          const evaluation = monitor.evaluations.find(
            (e) => e.recordId === status?.recordId,
          );
          return (
            <section key={s.id} aria-label={`${s.id} ${s.category}`}>
              <Card>
                <div className="between">
                  <h3>{s.category}</h3>
                  <span
                    className={`state ${status?.status === 'replay' && !view.networkDown ? 'safe' : 'act'}`}
                  >
                    {view.networkDown
                      ? '통신 두절'
                      : status?.status === 'replay'
                        ? '합성 재생 · 유효'
                        : status?.status === 'fail'
                          ? '수신 실패 시연'
                          : status?.status === 'stale'
                            ? '관측 낡음'
                            : status?.status === 'unknown'
                              ? '관측 불명'
                              : '대기'}
                  </span>
                </div>
                <p>
                  {s.name} · {s.demoRefreshSeconds}초 주기
                </p>
                <dl>
                  <dt>데이터셋</dt>
                  <dd>{status?.datasetId ?? s.demoPayload.schema}</dd>
                  <dt>관측</dt>
                  <dd>
                    {status
                      ? status.observedAt || '없음 · 관측 불명'
                      : '아직 수집하지 않음'}
                  </dd>
                  <dt>모의 수집</dt>
                  <dd>{status?.fetchedAt.replay ?? '아직 수집하지 않음'}</dd>
                  <dt>수집 벽시계</dt>
                  <dd>{status?.fetchedAt.wall ?? '없음'}</dd>
                  <dt>원본·모드</dt>
                  <dd>
                    {status?.origin ?? 'synthetic'} · {status?.mode ?? 'replay'}
                  </dd>
                  <dt>근거 ID</dt>
                  <dd>{status?.recordId ?? '없음'}</dd>
                  <dt>최신성</dt>
                  <dd>
                    {status?.freshness.reason ??
                      (status?.freshness.usable
                        ? '시나리오 시계 기준 유효'
                        : '불명')}
                  </dd>
                </dl>
                {status?.liveError && (
                  <p className="inline-error">
                    {status.liveError} · 폴백{' '}
                    {status.replayStatus === 'replayed'
                      ? '합성 재생 유효'
                      : '불명/낡음'}
                  </p>
                )}
                <p>{status?.summary || '아직 수집하지 않음'}</p>
                <p>
                  규칙 필터:{' '}
                  {evaluation?.eligibleForModel
                    ? '통과 · 규칙 처리'
                    : evaluation?.reasons.join(' · ') || '수집 대기'}
                </p>
                <details>
                  <summary>합성 원문 JSON · {s.id}</summary>
                  <pre>
                    {JSON.stringify(
                      view.sourceState.records.filter(
                        (r) => r.sourceId === s.id,
                      ),
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <button
                  className="text-button"
                  disabled={view.frozen}
                  onClick={() => void run('source-fail', { id: s.id })}
                >
                  수신 실패 시연
                </button>
              </Card>
            </section>
          );
        })}
      </div>
    </>
  );
}
export function Records({ view, open }: PanelProps) {
  const remaining = handover(view.data.households, view.scenario),
    c = view.scenario.counts;
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(view, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'onmaul-mock-report.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <div className="panel-title">
        <div>
          <h2>기록·인수인계</h2>
          <p>
            {view.frozen ? '종료 스냅샷' : '현재 미해결 목록'} · 기준{' '}
            {view.scenario.displayTime}
          </p>
        </div>
        <div className="toolbar">
          <Btn size="sm" kind="outline" onClick={download}>
            JSON 내보내기
          </Btn>
          <Btn size="sm" kind="outline" onClick={() => window.print()}>
            인수인계 인쇄
          </Btn>
        </div>
      </div>
      <Counters view={view} />
      <div className="rule-line">
        인수인계 {remaining.length}건 = 미안전 전화 {c.eligible - c.safe} +
        미완료 방문 {remaining.filter((x) => !x.household.callEligible).length}{' '}
        · 임시 제외 {c.temporarilyExcluded} 별도
      </div>
      <HouseTable
        view={view}
        open={open}
        rows={remaining.map((x) => x.household)}
      />
      <h3>임시 제외 사유</h3>
      {view.scenario.householdStatuses
        .filter((s) => s.temporaryExclusion)
        .map((s) => (
          <p key={s.householdId}>
            {s.householdId} · {s.temporaryExclusion}
          </p>
        ))}
      <h3>모의 통화 전사 · 녹음 없음</h3>
      {view.firstPass && (
        <p role="status">
          1차 모의 확인 요약 · {view.firstPass.targets.length}가구 ·{' '}
          {view.firstPass.completedAt} · 시뮬{' '}
          {view.firstPass.simulatedDurationMinutes}분 · 실제 소요 미측정 · 후속
          확인/구조 완료와 구분
        </p>
      )}
      {view.calls
        .filter((c) => c.text)
        .map((c) => (
          <p key={c.id}>
            {c.id} · {c.text} · 시도 {c.attempt}
          </p>
        ))}
      <h3>LangGraph 실행 근거</h3>
      {view.graphRuns.length ? (
        view.graphRuns.map((g) => (
          <Card key={g.id + g.nodes.length}>
            <b>
              {g.executionMode} · {g.waiting ? '담당자 검토 대기' : '종료'}
            </b>
            <p>{g.nodes.join(' → ')}</p>
            <small>
              {g.reason} · {g.id}
            </small>
          </Card>
        ))
      ) : (
        <p>
          아직 서버 그래프 실행 기록이 없습니다. 브라우저 단독 모드는 규칙
          mock으로 동작합니다.
        </p>
      )}
      <h3>결정·진행 기록</h3>
      {view.records.map((r) => (
        <div className="record-row" key={r.id}>
          <time>{r.timestamp.slice(11, 16)}</time>
          <span>
            {r.actorType === 'human'
              ? '담당자'
              : r.actorType === 'assistant'
                ? '규칙 제안'
                : '시스템'}
          </span>
          <p>{r.label}</p>
        </div>
      ))}
    </>
  );
}
export { MapPanel } from '../components/map/EvacuationMap';
