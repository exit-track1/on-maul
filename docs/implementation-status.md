# 구현·검증 상태

2026-10-09 · Codex

React 19 + Node.js/TypeScript + Telnyx + 실제 LangGraph를 사용한다. 현재 구현은 합성 상황실의 검증된 모의 동작이며, 실제 휴대폰 수신·모델 추론·정부 API 성공이나 원문 전체 요구 달성을 의미하지 않는다. 원문 100개 요구 ID와 T1–T29/U1–U14의 개별 상태·근거·남은 조건은 [requirements-verification.md](requirements-verification.md)에 기록한다.

## 확인된 범위

| 범위 | 구현·검증 근거 | 판정 |
| --- | --- | --- |
| 합성 48가구/전화45/방문3, 4조/12명, 자원10/수송9, 소스8, 케이스14, 정적 장면5 | `fixtures/metadata.json`, `shared/test/domain.test.ts`의 fixture JSON/bundle·ID/참조·집계·DEMO 식별자 검사 | 합성 계약 통과 |
| 확인일 90/91일·미래/누락/invalid·명시적 확인만 갱신 | 같은 파일의 날짜·check 테스트; `fe/tests/starter.spec.ts` roster | 모의 검증 통과 |
| 공통 집계·D/V/X 분리·동의 철회/가족 응답·안전과 안내 구분 | `shared/src/domain.ts`, `shared/test/domain.test.ts`, `shared/test/calls.test.ts` | 모의 검증 통과 |
| 확정 전 발신0·revision 충돌·중복 확정1회·주민/조원 합산8·목표당1·공정 교대 | `shared/src/runtime.ts`, domain/server 테스트 | 모의 검증 통과 |
| 현재 도착/구체 장소·되말·이동·단순 “네”·응급 우선·무근거 거절 | `shared/src/classification.ts`, domain 테스트·실제 전사 LangGraph 조건 분기 | 규칙 경로 검증 통과 |
| unclear5분/moving15분 후속 확인·예약 대체·공용8채널·기한 지남·새 도착/동의 철회/임시 제외/응급의 예약 취소 | `shared/test/calls.test.ts` moving/unclear/cancel 테스트 | 모의 검증 통과 |
| 주민 무응답 최초+추가8회·간격0/1/2/3분·문자 기록1·상한 후 미해결 | 같은 파일 resident retry 테스트 | 모의 검증 통과 |
| 조원 무응답1분 간격 추가2회·불가 전환·불가조 담당 대상 재배정 제안 | 같은 파일 member no answer/unavailable team 테스트 | 모의 검증 통과 |
| 재배정 후보 인접조 거리→면차량→119지원·승인 전 예약0·반려/최신조건/중복 승인 | `shared/test/dispatch.test.ts`, `server/test/server.test.ts` actual reassignment graph/API 테스트 | 모의 검증 통과 |
| 동반자 거동/장비·본인 포함 정원·운전자/지원 인원·조·가구·차량·대피소좌석 원자 예약 | `shared/src/dispatch.ts`, dispatch 테스트의 companion/shelter/driver/crew 검사 | 모의 검증 통과 |
| 통제 구간 제거·개방 도로 교차점 연결·단절/지나치게 긴 접근 금지·pickup/shelter/return 3구간·40km/h·대기3/와상6분 | `shared/src/routing.ts`, dispatch 테스트 road topology/timeline 검사 | 합성 경로 검증 통과 |
| 도로 통제 중 현재 위치/예약 보존·임무 보류·도로 재개만으로 출발하지 않음·담당자 수동 복구 재검증 | dispatch 테스트 road hold/reopen/changed needs 검사 | 모의 검증 통과 |
| 구역 또는 대상 ETA<15 일반조 투입 금지·불명 보류·응급 모의 인계·접수≠구조 | dispatch 테스트 zone12/target20/unknown·domain handoff 검사 | 데모 정책 검증 통과 |
| 검증된 경로/시각에 맞춘 임무 단계·대피소 도착만 rescued·귀환중 예약·복귀 완료 해제·대피소 인원은 계속 점유 | dispatch 테스트 timeline/shelter capacity/ambulance boarding | 모의 검증 통과 |
| 1차 최초 결과45가구를1회 요약·불명 포함·callback/미해결 유지 | calls 테스트 first pass/pending unknown | 모의 검증 통과·실제 소요 미측정 |
| 실전사는 전화망 종단이 아님·provider ID/슬롯은 signed hangup까지 보존 | calls 테스트 live transcript, server signed webhook 검사 | 주입 adapter/모의 검증 통과 |
| 두절 신규 보류·기존 통화 유지·현지 긴급·모의 복구 중복 방지 | domain outage/restart, calls pendingunknown | 모의 검증 통과 |
| 종료 인수인계 D−K+미완료 방문·X 별도·새 작업 차단·종료 snapshot 재시작 후 동일 counts/records/reservations/metadata | domain immutable handover·dispatch closed snapshot exact restore | 모의 검증 통과 |
| 도우미5범주·동적 자원/예약·revision 순위 변경·명시적 통신 토글·질문/부정/복합명령 차단 | `shared/test/assistant.test.ts`, 담당 Codex 집중10/10 통과 | 모의 규칙/FE 자원·순위 검증 통과·브라우저 전체5문장 리허설 남음 |
| 명단 원문 구조화 순수 규칙 파서·산소/거동/unknown/estimated·지원 enum·slice 근거·부정/질문/과거/충돌/명령 차단 | `shared/src/household-notes.ts`, `shared/test/household-notes.test.ts`16 + `shared/test/note-grades.test.ts`10 합동26/26·strict 타입 검사, `shared/test/notes-runtime.test.ts`4/4·FE 적용 통과 | 규칙 파서/현재 건강 원문 근거 등급·Runtime/UI 적용 모의 검증 통과·지원필드 전체 적용/실제 추론 미완료 |
| source 관할 exact match·키워드/임계·시각/최신성·wall/replay 분리·격리 cache key·실패/fallback append | `shared/src/sources.ts`, `shared/test/sources.test.ts` 집중16/16 통과 | 자체 합성 source 계약 검증·모델/실제 수집0 |
| sourceState→계획/지도/배차·낡은 풍속 ETA=null·현재 임무 보류/예약 유지·종료 JSON 근거 복원 | `shared/src/monitoring.ts`, `shared/test/monitoring.test.ts` 집중9/9 통과 | Runtime 통합 검증 통과·공식 API/모델 executor 없음 |
| HTTP source 실패/폴백·낡음/과거풍속409·예약/위치·export/저널 재시작·종료 byte-stable | `server/test/source-api.test.ts` 집중4/4 통과 | 모의 API/저널 검증·transport/model0 |
| 실제 LangGraph 계획/전사/재배정 StateGraph·checkpoint·interrupt·Command resume | `server/src/agents.ts`, server 테스트 | 라이브러리 실행 검증 통과·추론은 rules |
| Telnyx demo 키 있어도0·unknown mode 거부·환경 allowlist/별도 동의·Ed25519 raw body/변조/120초·중복 webhook·생성 불명 | `server/src/telephony.ts`, server 테스트 | 코드/주입 adapter 검증 통과·실전화 미실시 |

경로의 **가장 가까운 개방 도로까지 ≤250px 접근**은 `accessRule: synthetic-nearest-open-road-250px`로 기록하는 합성 가정이다. 현실의 도로 연결·차량 접근·주행 안전 검증이 아니다. 지도는 trip의 같은 waypoints·시뮬 시각으로 위치를 계산한다. 새 `fe/src/components/map/`에는80ms 간격의 local preview가 추가됐으나 공용 상태 진행은 명시적1분 버튼이다. preview는 실제 임무 상태를 진전시키지 않으며 연속 서버 권위 시계·30fps 이동 보간은 미검증이다. 새 지도의 local preview·조작·풍속 차단·종료 검증은 독립 preview의 전체20/20에 포함됐다.

## 실행된 검증

이 표의 명령 출력은 부모 Codex가 실행하고 전달한 결과다. 이 문서 작업에서는 전체 테스트를 다시 실행하지 않았다.

| 명령/검증 | 실제 확인 결과 | 범위 |
| --- | --- | --- |
| `npm test` | 172/172 통과 | 현재 공용 mock와 별도 root 전화 PoC를 포함한 전체 실행. 두 시스템의 통합 실연동 증거가 아님 |
| `npm run test:domain` |122/122 통과 | 현재 mock/shared/server 집중 범위의 전체 실행. 별도 root 전화 PoC는 이 명령에 포함하지 않음 |
| 명단 파서/건강 근거 등급 집중 테스트 | 파서16+등급10 합동26/26 통과·strict 타입 검사 통과 | 순수 규칙 파서·현재 정확한 건강 원문 인용 subset; 이전 overall 추출 등급 무시. Runtime 적용4/4·FE 재구조화 적용 통과; 지원필드 전체 적용/실모델 남음 |
| source 집중 테스트 | sources16/16·monitoring9/9 통과 | source contract와 실제 Runtime/계획/지도/배차/종료 연결. 전체 최신 합계를 추정하지 않음 |
| source HTTP/저널 집중 테스트 | `node --import tsx --test server/test/source-api.test.ts`4/4 통과 | 실패/fallback·stale/historical wind409·예약/위치·export/재시작·종료 byte-stable·외부 transport/model0. 전체 합계를 추정하지 않음 |
| 도우미 집중 테스트 | `node --import tsx --test shared/test/assistant.test.ts`10/10 통과, Prettier check 통과 | 규칙5범주·무효/질문/부정/복합·순위revision·통신human 기록. 전체 도메인 실행에도 포함 |
| `npm run build` / `npm run typecheck` | 최종 Vite38modules·server 및 FE typecheck 통과 | 새 지도/명단 연결 포함. 기본 산출물 hash가 검증한 private 번들과 같음 |
| 브라우저 E2E | 20/20 통과(starter17+지도3) | 독립 `/tmp/onmaul-fe-review-1791518832834/assets` 번들·4181 preview; 6탭·명단·확정전0·offline0요청·실패7/8·인수인계·키보드·재배정/동반자/후속확인/조원재호출·4뷰포트·명단 적용·새 지도 preview/정지/레이어/zoom/낡은 풍속/종료 |
| Playwright 캡처 | 1920×1080·1366×768·1280×800·390×844와 가로 넘침 검사, 1366 통화5행 경계 검사 근거 있음 | 새 지도 포함20/20 실행의 자동 범위. 프로젝터 실사용·2초 인간 판독·30fps 미검증 |
| 코드 형식/공백 | mock 범위 Prettier·`git diff --check` 통과 | `fe/src`·`fe/tests`·`shared`·`server`·`scripts/dev.mjs`; 실망/현장 검증과 별개 |
| 공식 프로젝트 스킬 정책 | 기존 `python3 scripts/check_skill_policy.py` 활성1·보관4 통과 기록 | 이번 감사는 allowlist를 변경하지 않았고 삭제된 스킬을 읽거나 설치하지 않음 |
| 주요 텍스트 대비 | 기존 흰 배경 토큰 계산: 본문18.88:1·보조7.02:1·조치6.58:1·진행5.58:1·안전6.18:1·플래그5.84:1 | 주요 토큰만; 모든 렌더링 조합/지도/포커스 대비 전수 검증 아님 |
| 운영 의존성 보안 검사 | 기존 `npm audit --omit=dev` 취약점0 기록 | 현재 전체 의존성/배포 보안 완료를 뜻하지 않음 |

브라우저 단독 `?demo=1`은 외부/API 요청 없이 local Runtime을 사용한다. 서버 연결 모드는 실제 `StateGraph`를 실행하지만 외부 모델 호출은0이다. 실전화 도구 `src/`·`public/`의 8팀/6차량 모델은 React mock의 4조/10자원과 분리돼 있다.

## 남은 구현·검증

- Telnyx 실제 음성 agent·전사/strict tool 브리지와 mock 상태 통합, 동의된 한국 휴대폰 주민1/조원1 리허설, 실제 종료/재접속·녹음동의/보관/삭제. 현재 mock API는 call-control 모듈이며 별도 전화 PoC의 테스트를 실수신 증거로 쓰지 않는다.
- OpenAI 추론 adapter와 감시/명단/발령/도우미/방송 그래프, strict schema·원문 근거·최대1회 교정·cache·사용량/예산/실패 폴백. 현재 모델 추론 성공은 없다.
- 공공 source의 공식 지역 매핑/허용치·공식 지시 원문/대피소 매핑·실제8개 adapter·공식 봉투/단위/업무코드·연속 수집 스케줄러 검증. 자체 합성의 관할/최신성/기준일·live 실패/replay 보존과 낡은 풍속 ETA 차단은 구현·검증됐다. 합성 JSON은 실제 정부 API 형식 또는 최신 실관측이 아니다.
- 구급차 요청/우선순위 배차 큐·자동 후보 순서·미충족 자원 대기 재검증·모의119 실패/불명·새 incident 관리. 직접 배차와 재배정 승인, 장비/인원/경로 예약은 이미 구현됐다.
- 명단 원문 구조화 파서는 원문 근거/estimated/unknown을 포함해 집중 검증을 통과했다. Runtime 담당자 적용4/4와 FE 적용을 검증했다. 지원필드 전체 적용·실제 추론 그래프/adapter는 미완료다. 출처별 운영 주기/다음 점검·확인 변동 저장·가구 추가·설정 모달·실제 통화 카드·토스트 큐도 미완료다.
- 도우미 규칙5명령·동적 자원/예약·통신 토글의 집중 검증은 통과했다. 전체 브라우저5문장과 선택적 모델 해석은 남았으며 source 카드의 origin/mode/freshness/record ID·append 원문을 연결했고 별도 판단 타임라인/모델 근거는 남았다.
- 연속 서버 권위 시계·12/30/60×·30fps 차량 이동·<300ms/44가구≤4분 측정·바람 변경 누적 ETA/독립 패리티·예상 경계 도달 오차 검증.
- `MemorySaver`는 프로세스 메모리 checkpoint다. 로컬 상태 snapshot과 종료 보고의 정확한 복원은 검증됐지만 durable graph checkpoint·실제 세션 재조정은 미완료다.
- 모든 T1–T29/U1–U14 완전 검증, 전체 대비/스크린리더/음성 접근성, 인쇄 시각 QA, 4분영상/휴대폰수신장면·행사등록/최종제출. 실제 `/review` 실행기록은 없으며 Codex 코드검토 수정 사례만 기록한다.

요청한 전체 목표를 유지한다. 이 상태는 완료 선언이 아니다. 이 문서 감사 담당은 실모델·실전화·정부 API 실행, 커밋·푸시를 수행하지 않았다.
