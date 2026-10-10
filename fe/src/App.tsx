import { useEffect, useState } from 'react';
import { Client } from './mock/client';
import { CallHistory } from './components/phone/CallHistory';
import { MapPanel } from './components/map/EvacuationMap';
import { STATUS_LABELS } from '../../shared/src/domain.ts';
import { Presentation } from './components/presentation/Presentation';
import './styles/showcase.css';

export default function App() {
  const [showDemo, setShowDemo] = useState(false);
  return showDemo ? (
    <SimulationDashboard />
  ) : (
    <Presentation onFinish={() => setShowDemo(true)} />
  );
}

function SimulationDashboard() {
  const [client] = useState(() => new Client());
  const [snapshot, setSnapshot] = useState(() => client.snapshot());
  const [tab, setTab] = useState<'map' | 'households' | 'cases' | 'logs'>(
    'map',
  );
  const [focusRequest, setFocus] = useState<{
    id: string;
    sequence: number;
    fit?: boolean;
  }>();
  useEffect(() => client.subscribe(setSnapshot), [client]);
  const { view } = snapshot,
    replay = view.showcase!;
  const focus = (id: string) => {
    setTab('map');
    setFocus({ id, sequence: Date.now(), fit: true });
  };
  const statuses = view.scenario.householdStatuses;
  const arrived = statuses.filter(
    (s) => s.status === 'safe' || s.status === 'rescued',
  ).length;
  const moving = replay.actors.filter((a) =>
    ['pickup', 'boarding', 'evacuating', 'returning'].includes(a.phase),
  ).length;
  const requested = replay.actors.filter((a) =>
    ['requested', 'dispatch-call'].includes(a.phase),
  ).length;
  const occupied = replay.actors.filter(
    (a) => a.vehicleId && a.phase !== 'completed',
  ).length;
  return (
    <main className="showcase-shell">
      <header className="showcase-header">
        <div className="showcase-brand">
          <span>온</span>
          <div>
            <h1>온 마을</h1>
            <p>산불 대피 · 전화 에이전트 시뮬레이션</p>
          </div>
        </div>
        <div className="showcase-header-meta">
          <span className="replay-badge">외부 호출 0 · 로컬 모의</span>
          <span>
            {snapshot.offline
              ? '브라우저 재생'
              : snapshot.connected
                ? '시뮬레이션 서버 연결'
                : '서버 연결 중'}
          </span>
        </div>
      </header>
      <section className="showcase-control" aria-label="시뮬레이션 재생 현황">
        <div className="showcase-cycle">
          <span className="replay-kicker">AUTOMATIC REPLAY</span>
          <strong>
            {replay.loop}회차 ·{' '}
            {replay.stage === 'completed'
              ? '전 가구 대피 완료'
              : '산불 발생 → 전 가구 대피'}
          </strong>
        </div>
        <span className="showcase-time" data-testid="simulation-time">
          T+{view.simMinutes.toFixed(1)}분
        </span>
        <span className="replay-badge" data-testid="playback-status">
          {view.simulation.speed}배속 · 자동 반복 재생
        </span>
      </section>
      <section className="showcase-stats" aria-label="대피 진행 현황">
        <div>
          <span>전체 가구</span>
          <strong>
            48<span>가구</span>
          </strong>
        </div>
        <div>
          <span>구조 요청 대기</span>
          <strong>
            {requested}
            <span>가구</span>
          </strong>
        </div>
        <div>
          <span>지도 이동·구조 중</span>
          <strong data-testid="moving-count">
            {moving}
            <span>건</span>
          </strong>
        </div>
        <div className="is-safe">
          <span>대피 완료</span>
          <strong data-testid="safe-count">
            {arrived}
            <span>/48</span>
          </strong>
        </div>
        <div>
          <span>차량 예약·운행</span>
          <strong>
            {occupied}
            <span>
              /
              {view.data.vehicles.filter((v) => v.availableForTransport).length}
            </span>
          </strong>
        </div>
        <button className="showcase-coverage" onClick={() => setTab('cases')}>
          <span>워크플로 사례 재생</span>
          <strong data-testid="case-coverage">
            {replay.seenCases.length}
            <span>/{replay.catalog.length}</span>
          </strong>
        </button>
      </section>
      {snapshot.error && (
        <div className="showcase-error" role="alert">
          {snapshot.error}
        </div>
      )}
      <div className="showcase-workspace">
        <aside className="showcase-calls">
          <CallHistory view={view} role="resident" focus={focus} />
          <CallHistory view={view} role="rescuer" focus={focus} />
        </aside>
        <section className="showcase-dashboard">
          <nav aria-label="대시보드 화면">
            {(
              [
                ['map', '마을 지도'],
                ['households', '전체 가구'],
                ['cases', '워크플로 사례'],
                ['logs', '상황 로그'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                aria-current={tab === id ? 'page' : undefined}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="showcase-dashboard-content">
            {tab === 'map' && (
              <MapPanel
                view={view}
                open={focus}
                focusRequest={focusRequest}
                featuredResidentId="H012"
              />
            )}
            {tab === 'households' && (
              <div className="showcase-roster">
                <h2>48가구 모두 참여하는 대피 시뮬레이션</h2>
                <p>
                  구조 요청·자가 대피·방문 확인을 거쳐 모든 가구가 대피소로
                  이동합니다.
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>가구</th>
                      <th>주민</th>
                      <th>재생 사례</th>
                      <th>현재 상태</th>
                      <th>구조 자원</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.data.households.map((h) => {
                      const actor = replay.actors.find(
                        (a) => a.householdId === h.id,
                      )!;
                      const status = statuses.find(
                        (s) => s.householdId === h.id,
                      )!;
                      return (
                        <tr key={h.id} onClick={() => focus(h.id)}>
                          <td>{h.id}</td>
                          <td>
                            <button onClick={() => focus(h.id)}>
                              {h.name} ↗
                            </button>
                          </td>
                          <td>
                            {
                              replay.catalog.find((c) => c.id === actor.caseId)
                                ?.title
                            }
                          </td>
                          <td>{STATUS_LABELS[status.status]}</td>
                          <td>
                            {actor.vehicleId
                              ? `${actor.vehicleId} · ${actor.rescuerId}`
                              : actor.mode === 'car'
                                ? '자가 차량'
                                : actor.mode === 'walk'
                                  ? '도보'
                                  : '배차 대기'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {tab === 'cases' && (
              <div className="showcase-case-list">
                <h2>
                  모든 워크플로 분기 · {replay.seenCases.length}/
                  {replay.catalog.length}
                </h2>
                <p>
                  사례를 빠짐없이 재생한 뒤 다음 회차에 순서를 섞습니다. 통화
                  내역 선택에서 완료된 대화도 다시 확인할 수 있습니다.
                </p>
                {(['resident', 'rescuer'] as const).map((role) => (
                  <section key={role}>
                    <h3>
                      {role === 'resident'
                        ? '주민 전화 에이전트'
                        : '구조 전화 에이전트'}
                    </h3>
                    <div className="showcase-case-grid">
                      {replay.catalog
                        .filter((c) => c.role === role)
                        .map((c) => (
                          <article
                            key={c.id}
                            className={
                              replay.seenCases.includes(c.id) ? 'case-done' : ''
                            }
                          >
                            <span>
                              {replay.seenCases.includes(c.id)
                                ? '✓ 재생 완료'
                                : '○ 재생 대기'}
                            </span>
                            <h4>{c.title}</h4>
                            <p>{c.outcome}</p>
                          </article>
                        ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
            {tab === 'logs' && (
              <div className="showcase-logs">
                <h2>상황 로그</h2>
                <p>모의 응답 판단과 출동·탑승·수송·복귀를 기록합니다.</p>
                {[...view.records].reverse().map((record) => (
                  <article key={record.id}>
                    <time>
                      {new Date(record.timestamp).toLocaleTimeString('ko-KR', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        timeZone: 'Asia/Seoul',
                      })}
                    </time>
                    <span>{record.label}</span>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
      <footer className="showcase-footer">
        합성 통화·주민·지도 위치를 재생합니다. 각 가구의 대피 완료와 구조 차량
        복귀 후 다음 회차를 시작합니다.
      </footer>
    </main>
  );
}
