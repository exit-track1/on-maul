# 온 마을 요구사항별 구현·검증 근거

2026-10-09 · Codex · React 19 + Node.js/TypeScript + Telnyx + 실제 LangGraph

사용자가 제공한 통합 요구사항과 합성 데이터 제작 요청, `requirements-analysis.md`, 현재 `fe/`·`shared/`·`server/` 구현과 테스트를 대조했다. 최신 요청의 기술 선택을 적용하되 원문의 기능 목표와 T1–T29/U1–U14는 유지한다. 모의 구현의 증거를 실제 모델·전화망·정부 API·현장 성능의 증거로 바꾸지 않는다.

## 상태와 증거의 읽는 법

- **완료(모의)**: 표에 적은 모의 수용 기준을 현재 구현과 실행된 자동 검증이 입증한다. 별도 실연동 의무는 그 행의 한계에 남긴다.
- **부분**: 동작하는 하위 범위가 있으나 같은 요구의 구현 또는 검증이 남았다.
- **미구현**: 현재 React mock 구현에서 대응 기능을 확인하지 못했다.
- **미검증**: 코드·설정 또는 검증 계획은 있으나 해당 실행·리허설 증거가 없다.

부모 Codex의 최종 실제 출력은 **모의 shared/server 도메인134/134**, **FE21/21** 통과다. `npm test` 전체 **189/189 통과**는 별도 전화 PoC를 포함한 해당 실행 시점의 결과이며 이후 다른 채팅의 변경까지 검증한 증거가 아니다. 명단 규칙 파서16+건강 근거 등급10 집중26/26, Runtime 적용4/4, source contract16/16·monitoring15+HTTP/API10 합동25/25, 도우미10/10도 통과했다. 기본 build(Vite38modules), FE 및 마지막 서버 강화 후 typecheck, mock 범위 Prettier, `git diff --check`, 공식 스킬 정책 활성1/보관4가 통과했다. 기본 번들 JS `index-BbAEbTbN.js`·CSS `index-DUk4wsRt.css`를 독립4181포트 preview에서 검증한 FE21/21(starter18+지도3)에는 소스 실패·미확정 계획·새 지도·도우미·명단 적용·예약·재배정·후속 확인·조원 재호출·4뷰포트가 포함된다. 전체 테스트 수는 원문 요구 수 또는 T/U 전체 통과율이 아니다.

source P2 보완도 검증됐다. source-fail/collect로 미확정 계획의 ETA·근거 조건이 바뀔 때만 최신 재검토로 갱신하고 무관한 수집은 담당자 수동 순서를 유지한다. 확정 전 표시조건 전체를 재검증하며 서버는 이전 계획 checkpoint를 supersede하고 최신 검토 checkpoint를 만든다. 실제 표시계획과 checkpoint를 resume 전후 대조하고 그래프 오류·await 중 source 변화·승인 뒤 자료 오염에서는 확정/큐0을 유지한다. FE는 관측 없는 실패 record에 fixture 시각/요약을 대신 넣지 않고 불명을 표시하며 fallback은 별도 record로 원문 실패를 보존한다. 실패 시45행 도달 불명·공용 채널0/8, fallback ETA 복원 후 담당자 확정 흐름도 FE21/21에서 통과했다.

| 증거 약칭 | 파일·검사 범위 |
| --- | --- |
| DOM | `shared/src/domain.ts`, `shared/test/domain.test.ts`: fixture 관계·집계·90/91일·취약도·ETA·완료 근거·동의·가족·인계·두절·복구 |
| NOTES | `shared/src/household-notes.ts`, `shared/test/household-notes.test.ts`16과 `shared/test/note-grades.test.ts`10의 합동 집중26/26·strict 타입 검사: 산소/거동/불명·supported enum·원문 slice 근거·estimated·부정/질문/과거/충돌/명령을 보수 처리하는 순수 규칙 파서·현재 원문 source/index/offset/정확한 인용으로 건강4종 등급3 검증·이전 overall 추출 등급 무시. `shared/test/notes-runtime.test.ts`4/4와 FE 적용 검증 통과·API 공용 command 제공 |
| SOURCE | `shared/src/sources.ts`, `shared/src/monitoring.ts`, `shared/test/sources.test.ts`16/16, `shared/test/monitoring.test.ts`15/15, `server/test/source-api.test.ts`10/10: 관할/임계·관측/수집 시각·live/replay 시계·원문 fingerprint/격리 cache key·실패/폴백 append·풍속 신선도와 Runtime/계획/배차/종료·HTTP export/저널 재시작/종료 byte-stable 연결. 미확정 계획/표시조건/최신 checkpoint·오류/await 중 변화/승인 뒤 자료 오염의 확정/큐0까지 검증 |
| ASSIST | `shared/src/runtime.ts`의 assistant 규칙, `shared/test/assistant.test.ts`: 구역/미해결/자원/미확정 순위/통신 토글·동적 집계·revision·질문/부정/복합명령 무변경. 별도 집중 실행10/10 통과 |
| CALL | `shared/src/runtime.ts`, `shared/test/calls.test.ts`: 공용 채널·후속 확인·재호출·예약 취소·1차 요약·실제 전사와 종단의 분리 |
| DISP | `shared/src/dispatch.ts`, `shared/src/routing.ts`, `shared/test/dispatch.test.ts`: 합성 도로 연결·통제 우회·3구간 시간·예약·정원·인원·재배정·보류/복구·종료 복원 |
| GRAPH | `server/src/agents.ts`, `server/test/server.test.ts`: 실제 `StateGraph`, `MemorySaver`, `interrupt`, `Command({resume})`; 계획·전사·재배정 그래프 |
| API | `server/src/app.ts`, `server/src/telephony.ts`, `server/test/server.test.ts`: 직렬 상태 변경·demo 외부 호출 0·Telnyx allowlist/동의·서명·중복·불명 |
| FE | `fe/src/App.tsx`, `fe/src/tabs/Panels.tsx`, `fe/src/components/map/{EvacuationMap.tsx,model.ts,map.css}`, `fe/src/styles/global.css`, `fe/tests/starter.spec.ts`, `fe/tests/map.spec.ts`:21/21 통과·6탭·명단·결정·두절·인수인계·뷰포트·키보드 |
| DATA | `fixtures/*.json`, `shared/src/types.ts`, DOM fixture 검사: seed 20261009, 기준일 2026-10-09, Asia/Seoul, 자체 합성 스키마 |

실전화 도구 `src/`·`public/`는 **별도 전화 PoC**다. 그 내부의 8팀·6차량은 React mock의 48가구·4조/12명·10자원과 합쳐진 모델이 아니다. 별도 전화 PoC 테스트는 mock 48가구 전체 연동 또는 실제 휴대폰 수신의 증거가 아니다.

## 평시 P-1–P-12

| ID | 상태 | 현재 근거와 남은 기준 |
| --- | --- | --- |
| P-1 | 완료(모의) | FE `Households/HouseTable`: 48행·10열·등급↓/NESW/id 정렬·7필터. DOM fixture 수와 FE roster 검사. 모든 필터의 변경 후 조합 점검은 U4에 별도 남음. |
| P-2 | 부분 | FE Drawer와 DOM `check date changes only on explicit field confirmation`: 원문/구조화 결과·보호자·담당조·복수 이력·거동/동의 편집·명시적 확인. 모든 지원 필드 편집·담당자/다음 점검·접점 주기·변동 내용 저장은 미완료. |
| P-3 | 미구현 | 새 가구 ID·기본값·좌표 입력·추가 API/UI 없음. 현재 restore의 48가구 계약도 가변 명단으로 확장해야 한다. |
| P-4 | 부분 | NOTES 순수 파서16+등급10 합동26/26·Runtime4/4·FE 적용 검증: 산소→장비/4등급·별도 거동 근거 없으면 unknown/estimated·공란/충돌 보수상향·원문 slice/지원필드 enum·부정/질문/과거/지시문 무추종. 최신 revision의 담당자 적용·원문 근거/unknown/estimated 저장·거동/장비 합집합·계획/취약도 재계산·동의/연락/확인일 유지·활성 임무/frozen 차단을 검증했다. 지원필드 전체 적용·strict 모델 adapter/실제 추론 그래프·교정/실호출은 미완료. |
| P-5 | 부분 | FE `Households`: 90일 내 확인율과 방문 수·출처 5칸. 출처 칸은 현재 `sourceType` 수이며 최신 유효 확인/누락 별도 합계·담당자 출처 포함·접점 주기/다음 점검 기준은 미완료. |
| P-6 | 부분 | `command('check',{id,source,fields})`: 명시적 모의 확인만 날짜 갱신·필드/출처/담당/이력 유지. DOM·FE 명단 검사. `changed` 객체 적용·전체 source/담당자 계약 검증·실제 확인 근거는 남음. 최신 TS 공용 command 경로가 원문 REST 경로를 대신한다. |
| P-7 | 완료(모의) | DOM family temporary exclusion·CALL callback cancel: 입원/시설 입소/전출/복귀·X/V 분리·큐/카운터 재조정·사유 기록. 실제 연락/거동 재확인 절차는 현장 검증 대상. |
| P-8 | 부분 | DATA 4조/12명·가능9/불가3·가용 운전자·담당 참조, FE Resources. 최신 합성 계약에 따라 담당 가구는 조당6으로 줄이지 않고 전체 teamId 참조를 표시. 가용 시간·담당자·집결지의 전체 카드 계약 점검은 남음. |
| P-9 | 완료(모의) | DATA 10자원(수송9/진화전용1)·가상 번호판·운전자 참조, FE 차량 표·현재 임무. 실차 운전자/장비 확보로 해석하지 않는다. |
| P-10 | 부분 | DATA 대피소3·접근성/정원/반려동물 속성, DISP 장비·접근성·정원 예약 검사. 공식 지시 장소 매핑/조건 대조·조건 편집·후보 대안 제안은 남음. |
| P-11 | 완료(모의) | FE 공통 띠·DOM staleReason/집계: 48·방문3·확인 필요4의 합성 기본값, 불명/오래됨 중복 집계 방지. |
| P-12 | 부분 | DATA checkLogs 96개·FE 가구 복수 이력·확인 필드/담당 표시, DOM 명시적 확인 검사. source별 운영 주기·다음 점검·변동 추적의 전체 계약은 미구현. |

## 감시 W-1–W-10

| ID | 상태 | 현재 근거와 남은 기준 |
| --- | --- | --- |
| W-1 | 부분 | Runtime watch→watch·발신0·FE 감시 시작과 지도. 8개 실제/재생 수집기의 시뮬 주기 스케줄러는 없음. |
| W-2 | 부분 | SOURCE·Runtime collectSources: own demo 스키마8·원 관측시각 불변·새 수집 record append·모의 live 실패/별도 replay fallback·error/origin/mode/시각/근거 ID 보존. 실제8종 collector와 공식 응답 봉투/업무코드·실수신은 미완료. |
| W-3 | 완료(모의 규칙) | SOURCE16/16: 명시적 정규화 관할 태그 exact match 후 재난 키워드 또는 풍속≥10/진화율하락≥10%p/수위관심/특보경보 검사. 관할 외는 eligibility0·actualModelCalls0, 탈락 이유 보존. 실제 지역/기관 관할 매핑은 미검증. |
| W-4 | 부분 | SOURCE cache key가 policy/관할/원문/payload fingerprint/source/sample/scenario/dataset/mode/origin을 격리; 충돌 fingerprint도 원문으로 구분. 모델 실행 예정 eligibility와 actualModelCalls0 분리. strict AI-0 adapter·실제 cache 실행·교정/비용/사용량은 없음. |
| W-5 | 부분 | FE 합성 경보 카드·소스 원문 이동. source_record/샘플/시나리오 단위 1회 게시·중복0·근거 ID 연결은 미완료. |
| W-6 | 부분 | FE 발령 시작 결정 카드·알약·dismiss 기록. 실제 필터 판정 trigger와 고정 카드/지도 수신 시각의 결합은 미완료. |
| W-7 | 부분 | FE Sources8·append 원문 record JSON·origin/mode·기준일/dataset·관측/수집 wall/replay·freshness·근거 ID·필터 이유·실패 오류/별도 폴백 표시. SOURCE16+통합15+HTTP/저널10 통과. 관측 없는 실패 record의 fixture 시각/요약 대체 금지·별도 fallback/원문 실패 보존도 FE21/21에서 통과. 공식 기관/엔드포인트·전용 수집/판단 타임라인·모델 근거 카드는 미완료. |
| W-8 | 부분 | FE 사이드바 소스8·유효 replay 상태 점·상단 실제0/합성 유효 수. 발생/기록1줄 접힘·소스별 전체 시각 표시 계약은 미완료. |
| W-9 | 부분 | FE 지도 감시/합성 경보·풍향/풍속 표시. 관할 지시 없음/수신 시각/위험지수/위기경보의 계약 문구와 데이터 연결은 미완료. |
| W-10 | 완료(모의 계약) | SOURCE16/16+통합15/15+HTTP/저널10/10: 기본 주기2배·누락/invalid/미래/stale 불명·live wall/replay scenario 시계 분리·역사/기준일/dataset/scenario 혼합 금지·낡은 풍속 계획 ETA=null/신규투입 차단/현재임무 hold. 실제 관측 단위/허용치/공식 수신은 미검증. |

## 발령 E-1–E-8

| ID | 상태 | 현재 근거와 남은 기준 |
| --- | --- | --- |
| E-1 | 부분 | Runtime plan은 사람 동작으로 event 모드·계획·human 기록 생성, FE 발령 절차. 독립 event ID·startedAt/simAt/source snapshot 구조는 원문 수준 미완료. |
| E-2 | 부분 | DOM 코드 ETA·GRAPH 계획 그래프·SOURCE wind 근거 record와 scenario/dataset/date snapshot 검증·불명시 ETA=null. source 실패/수집의 ETA·근거 조건 변화만 미확정 계획 갱신·무관 수집 수동 순서 유지·최신 검토 checkpoint 보완도 집중25/25에서 통과. strict 추론 adapter·여러 공식 소스 결합/원문/caveats·실모델 실행은 미완료. |
| E-3 | 부분 | DOM orderedHouseholds·D/V/X 분리·등급/ETA 점수·동점 정렬·Runtime reorder 중복/누락/rank 검사. 원문의 자력+자가차량 감점 −8, source 근거·모델 결과 strict 검증·전체 자원/대피소 제안 검증은 남음. |
| E-4 | 완료(모의) | FE 순서 검토 ↑↓·Runtime reorder와 미확정 순위 명령·revision/human 기록·확정 후 변경 차단, DOM confirmation 검사. 도우미 전체 명령은 L-6 별도. |
| E-5 | 부분 | FE D/V/X·공용8 확정 모달·GRAPH 승인 interrupt/resume·DOM 중복/구revision/확정전0. 현재 모드는 전원 합성이며 실제 주민1+조원1의 자동 혼합 발신/휴대폰 수신은 미검증. |
| E-6 | 완료(모의) | Runtime confirm이 주민45·조원12·방문 요청/문자 모의 기록 생성·교대 큐 시작. DOM 공용 fairness와 CALL 호출 상한. 실제 SMS/실전화 실행은 별도 범위. |
| E-7 | 미구현 | 공식 지시 원문/수신 시각/장소를 예측에 우선 연결하고 접근성/통제 대안을 검토하는 흐름 없음. 합성 대피문은 공식 수신이 아니다. |
| E-8 | 부분 | Runtime revision·reconcile·DOM 동의 철회/임시 제외·CALL 늦은 근거·DISP 원자 예약·최신 재배정 승인. 진행 Telnyx 슬롯은 종단 전 유지. 확정 직전 표시조건 전체 재검증·기존 계획 checkpoint supersede·resume 전후 대조 보완도 집중25/25에서 통과. 모든 실제 session/attempt/event revision·연락 변경·새 source 조건 재검증은 미완료. |

## 주민 확인 C-1–C-15

| ID | 상태 | 현재 근거와 남은 기준 |
| --- | --- | --- |
| C-1 | 부분 | DOM/Runtime pump 공용8·대상당1·주민/조원 교대·생성 불명 포함. API 벨30초/응답120초 실제 타이머 코드. 모의1분 진행은 구현됐으나 전 턴 벨0.5분/1–1.5분 계약·배속 독립 실기기 타이머 리허설은 미검증. |
| C-2 | 부분 | 최신 Telnyx 공식 SDK dial/hangup·H012/M01 환경 allowlist·별도 동의·서명 webhook·provider ID 보존·주입 adapter 테스트. mock API의 양방향 음성 agent/전사/tool 브리지와 실제 수신은 미완료. 별도 전화 PoC와의 상태 통합도 미완료. |
| C-3 | 미구현 | 원문의 확정 거절만 대체 경로 허용한다는 요구는 보존. 최신 Telnyx 선택에서 별도 대체 공급자 경로/거절 확정 정책은 없음. 결과 불명 무재발신은 API가 입증한다. |
| C-4 | 부분 | Runtime advance의 결정론적 합성 발화·classification 검증·fixture 전사14케이스 범주. 원문 21 scripts/script_map·44가구의 턴별 offset 재생과 혼합44+실제1 시간 계약은 미완료. |
| C-5 | 완료(모의) | CALL resident retry: 최초+추가8회, 대기0/1/2/3분·문자1기록·상한 뒤 미해결 유지·종단전0·동의/제외/완료 취소. 실제 번호 재발신 시계/전화망 리허설은 미검증. |
| C-6 | 부분 | DOM 현재 도착/장소/되말/응급 우선·무근거 결과 거절, CALL unclear5/moving15·예약 대체/취소, DISP 동반자·정원. 전체 주민7종 live strict 도구/질문/가구/attempt/session 결합·배차 요청 큐·음성 반환은 남음. |
| C-7 | 부분 | FE 이장 요청/수동 결과·Runtime leader-request/result·이동확인≠안전·15분 재확인. 거부2회/불신 신원 재고지·설득1회 음성 정책, 연락불가 자동 방문/재배정 제안의 전체 흐름은 남음. |
| C-8 | 부분 | Runtime emergency·DOM 중복1건/접수≠안전·두절 현지 큐, GRAPH 응급 사람 승인 없이 분기. 현재 `mockRecorded` 합성 접수이며 실패/불명 adapter 시연·incident 재개·동시 구급차 요청 큐는 없음. 직접 검증된 의료 배차는 DISP에 존재. 실제119/SMS 발신0 유지. |
| C-9 | 미구현 | mock API telephony state는 생성/응답/종료 metadata를 제공하지만 React 실제 전사160px·도구인자/재검증·누적 대화/녹음 ID·스크롤 정책 카드 없음. 별도 전화 PoC 화면은 이 요구의 통합 증거가 아니다. |
| C-10 | 미구현 | 실제 음성 세션 정책 append/적용 이벤트·수락과 발화 반영 구분 없음. 공용 배차의 최신 조건 검증은 DISP로 확인. |
| C-11 | 부분 | FE Calls·공통 tally·긴급/이장 큐·전화/방문/제외 표·후속 확인 기한·접수≠안전. 실제 통화 카드·모든 보류/overdue 조합에서 2단 앞5칸 합=N의 독립 검증은 남음. |
| C-12 | 완료(모의) | CALL first pass summary·pendingunknown 검사: 최초 결과45가구를1회 요약, 불명 오류 포함·callback 유지·안전과 구분. 실제 소요는 null/미측정으로 표시. |
| C-13 | 부분 | API 명시적 allowlist 수동 dial 경로 존재. 가구 팝오버/Drawer 지금전화·공용 정책 연결·실수신 검증은 없음. |
| C-14 | 부분 | 합성 안내/분류와 실제 API 상한 코드만 확인. 현재 mock server 음성 지시문/90일 확인 질문·난청2회/설득1회/언어 실패 사람 처리·모델 위임 리허설 없음. 별도 PoC의 준비는 통합 구현 완료가 아니다. |
| C-15 | 부분 | API 직렬화·request/provider ID·signed webhook 중복·DOM/CALL eventId·공용 채널·늦은 비긴급 근거 안전보존. 전체 event/attempt/session/tool_call_id 원자 적용·늦은 live 결과·재접속/재시작 재조정 검증은 미완료. |

## 대기조 S-1–S-8

| ID | 상태 | 현재 근거와 남은 기준 |
| --- | --- | --- |
| S-1 | 부분 | Runtime 주민/조원 동시 큐·12명 문자기록·member-response 분리, DOM/CALL 공용8. 실제M01+모의11 음성/도구/검증된 DTMF와 혼합 실행은 미완료. |
| S-2 | 완료(모의) | CALL member no answer: 최초 후 정확히1분 간격 재호출2회·총3시도·불가·대상활성1. FE 재호출/불가 표시도 최신21/21 실행에서 통과했다. |
| S-3 | 완료(모의) | DISP driver/support 예약: 자격+가능+응답ok·운전자/지원2인·면차량도 확인된 인원 요구·빌린 차량만으로 운전자 인정하지 않음. 실제 가용 인원 확인은 미검증. |
| S-4 | 부분 | FE 담당 목록·현재 임무·주소/연락/장비 Drawer, DISP 단일예약/제외. 전체 담당 자동1건 제안·같은 임무ID 문자/근거시각·실제 SMS 없는 전달 계약은 미완료. |
| S-5 | 완료(모의 정책) | DISP zone12/target20·unknown, SOURCE stale/mixed wind: 구역 또는 대상<15 일반조 금지·자동 모의인계·불명/낡음 신규투입 보류·현재 임무 hold·출발/탑승/복구 재검증.15분은 현장 검증 없는 데모 정책. |
| S-6 | 부분 | DISP validated timeline·단계순서/중복·human 수동/sys 모의·대피소 도착만 rescued·복귀 완료 해제. 실제 조원 보고의 임무/session/인용 근거 수신은 미구현. |
| S-7 | 완료(모의) | CALL 불가조 자동 제안, DISP 인접조 거리→면차량→119지원·승인전 예약0·최신조건/중복/반려, GRAPH 실제 재배정 interrupt/resume·API 승인 검사. 원문의 실제 전달 결과는 미검증. |
| S-8 | 부분 | FE 4조/조원응답·재호출·임무·재배정 승인·10차량·현재/완료 요약·이동 목록. 전체 원문 조가동/출동 숫자·실제 태그/보고 근거의 UI 점검은 남음. |

## 배차·지도 D-1–D-9

| ID | 상태 | 현재 근거와 남은 기준 |
| --- | --- | --- |
| D-1 | 부분 | Runtime 직접 dispatch/reassignment와 DISP 같은 가구 열린 임무1·장비/예약 검증. 별도 needs/priority/event_id 배차 큐·emergency/high/normal+rank/ETA 순서·중복 필요 갱신은 미구현. |
| D-2 | 부분 | DISP 장비·동반자 포함 좌석·접근성·대피소정원·운전자/지원·구역/대상ETA·경로·귀환차량 차단. 자동 구급차 우선 후보/배차 큐·1분 대기 재검증·선호/면차량/인접 전체 우선정책은 미완료. |
| D-3 | 완료(모의) | DISP 합성 연결 도로를 구성하고 통제 구간 제거·교차점 연결·경로없음 금지·pickup/shelter/return waypoints/시각·40km/h·대기3/와상6분. **가구/집결지→가장 가까운 개방도로 접근은 ≤250px 합성 가정**이며 현실 도로/주행 허가 검증이 아니다. FE 위치는 같은 trip 경로/시각을 계산한다. 새 지도에는 local preview가 추가됐지만 서버 권위 연속 시계/30fps는 미검증. |
| D-4 | 완료(모의) | DISP 단계 시간/보고 검사: 출동→도착→탑승→대피소→복귀, 귀환중 가용 아님·복귀 완료 예약 해제·대피소 인원은 계속 점유. 복귀 취소 후 즉시 다음 임무는 구현하지 않았으므로 복귀까지 기다린다. |
| D-5 | 부분 | FE 로컬SVG 48점·6도로/통제·3대피소·면사무소·4집결지·발화/영향영역·풍향·임무 경로/차량 위치·상태단어/형태. 새 지도 컴포넌트의 사람/차량 local preview·지형/연기·레이어·키보드 조작·정지/종료·낡은 풍속 차단은 지도3개와 전체21/21 검증을 통과했다. 서버 시계와의 연속 보간/30fps·전체 상세 수용 기준은 미완료. |
| D-6 | 부분 | FE map/model.ts의 firePerimeter가 DOM eta를 쓰고 비공식 예상영역 면책. 고정 바람 경계도달±20%·바람 변경 재추정·invalid 풍속 렌더링/연속효과 검증은 없음. |
| D-7 | 부분 | FE HUD/범례·상태 숫자·합성풍향·가구 팝오버/Drawer·면책·모의1분 버튼. 새 지도의 레이어/HUD/배속 local preview는 지도3개와 전체21/21 검증을 통과했다. 실제 POST 시뮬 시계·T+/ha/선두속도·조건시각/불명·HUD≤25% 측정은 미완료. |
| D-8 | 부분 | DOM1px=2m·풍향+180·풍상3/횡2·invalid wind=null·구역최소·대칭/풍상 검사, SOURCE wind freshness/context gate. 바람 변경 누적 prog·reestimated·서버/FE 독립 패리티±0.5분 미완료. 공유 TS 함수는 독립 패리티 검증이 아니다. |
| D-9 | 완료(모의) | DISP 동일 trip ID로 가구/차량/운전자/조/지원인원/대피소좌석 예약·중복/인원부족/returning 차단·출발/탑승/도착 재검증·복귀해제. 취소/반려는 예약 전이며 현재 실행 임무의 강제 취소/대체 API는 없음. |

## 상황 로그·도우미 L-1–L-9

| ID | 상태 | 현재 근거와 남은 기준 |
| --- | --- | --- |
| L-1 | 부분 | FE CSS 100dvh·3열/≤1180 2열/≤900 토글·독립스크롤·4뷰포트 capture/넘침 검사. 모든 모드/열 조합의 최소폭/고정 영역은 추가 실사용 점검 대상. |
| L-2 | 부분 | FE 제안/사람/시스템·고정결정·긴급카드. Runtime은 가구별 분류 log를 쌓으므로 원문의 일반 가구별 자동 메시지0/시스템1줄 갱신 전부를 충족하지 않는다. |
| L-3 | 부분 | FE 상단/통화/지도는 동일 tally로 숫자 표시. 별도 T+ 진행1줄 갱신·중복없는 시스템 요약 계약은 남음. |
| L-4 | 부분 | FE 감시·발령·모의진행·자원·통신·종료/export 칩 연결. 가구 추가·미갱신보기·재난문자별 수신 시뮬 등 전 모드 칩 계약은 미완료. |
| L-5 | 완료(모의) | FE 6탭·분리 도우미·공통상황띠 D/V/X·결정알약1·종료스냅샷, FE six tabs count 검사. 2초 인간 판독은 별도 U1. |
| L-6 | 완료(모의 규칙) | ASSIST 집중10/10: 4구역 조치/미완료 방문·D−K/V/X·동적 자원/응답/예약·revision을 지키는 미확정1순위·명시적 통신 두절/복구가 공용 command/human 기록을 사용. 질문/부정/복합·무효 ID/확정 후 변경은 무변경. 선택적 모델 해석과 전체 브라우저5문장 리허설은 미검증. |
| L-7 | 부분 | FE 오류 토스트 있음. 4초 자동해제·최대3큐 계약은 미구현. |
| L-8 | 미구현 | 설정 모달/GET-PATCH settings·채널/재발신/배속/키유무/마스킹수신자/이장자동결과 통합 UI 없음. 환경설정 파일은 모달을 대신하지 않는다. |
| L-9 | 부분 | FE 워드마크/4모드/소스8/시연담당 사이드바. 실제 수신자 마스킹 표시·상세 서브 상태의 혼합모드 UI는 없음. |

## 기록 R-1–R-6

| ID | 상태 | 현재 근거와 남은 기준 |
| --- | --- | --- |
| R-1 | 부분 | Runtime human/assistant/system 모의 기록·API snapshot/events.jsonl·중복검증. 모든 기록 t_sim/t_wall/event_id/evidence_ref/mode의 정식 records.jsonl·전체 실행 ID 연결은 미완료. |
| R-2 | 부분 | DOM handover·CALL 1차요약·FE 기록: 모든 D−K+미완료방문·X별도·전사/예약. 시작/확정/종료/1차 시각 전체표·인계담당/근거/가중치/오류 정식 열은 남음. |
| R-3 | 부분 | API/FE export가 같은 View·DISP frozen exact restore·SOURCE 실패/폴백/원문/시각/근거와 sourceState immutable JSON 복원·HTTP 종료 export byte-stable/저널 재시작10/10. 환경 key/실번호/원 provider payload 없음. 모델 비용/usage·실제 전사/동의 정식 보관은 미완료. |
| R-4 | 부분 | FE 인수인계 전체텍스트·window.print·CSS @page A4 landscape. 실제 인쇄 페이지의 체크열/줄끊김/담당/제외사유 시각검증은 미실시. |
| R-5 | 부분 | mock 전사/attempt/provider ID·telephony recording disabled·FE 녹음없음. 실음성 전사·녹음동의/ID/보관삭제/다운로드권한·종료사유의 정식 계약은 미검증. |
| R-6 | 완료(모의) | Runtime close acknowledged·실제활성/불명종료 차단·새작업금지·미안전/귀환임무 유지·DISP frozen restore 동일 counts/records/reservations/metadata. 실제 불명 통화를 담당자 인계하고 종료하는 운영 경로는 추가 구현/검증 대상. |

## 실패 처리 F-1–F-7

| ID | 상태 | 현재 근거와 남은 기준 |
| --- | --- | --- |
| F-1 | 부분 | DOM 두절 신규보류·활성유지·현지긴급·복구1회·FE 방송/전체인수인계. 모델문안·6문장 계약·조배정표·실전화/기관접수의 재조정·실망 복구 리허설은 남음. |
| F-2 | 완료(모의) | Runtime source-fail·SOURCE append 실패/fallback·실제 성공false·유효 재생7/8·FE 표시. 실패를 별도 유효 replay로 덮지 않음. 실제 API 실패는 미실시. |
| F-3 | 부분 | API maxRetries=0·pendingunknown 요청/provider ID/채널 유지·CALL 전사≠종단·재시작불명복원. 모든 timeout/5xx/종료감시/늦은event·provider 재접속 리허설은 미완료. |
| F-4 | 미구현 | C-3과 같은 확정거절 대체경로 요구. 현재 Telnyx는 결과불명 보류만 구현. |
| F-5 | 부분 | DOM 날짜경계/거동불명4등급·P7 임시제외. NOTES 공란/불명/충돌 규칙은 집중 검증됐다. 실제 음성 90일 확인 질문·전체 지원필드 적용·불명상향 질문은 미완료. |
| F-6 | 완료(모의) | DISP 접근성·장비·정원·driver/crew·통제경로/단절·SOURCE 낡음/불명ETA·현재임무 hold/수동복구. 자동 대안 큐/기관 전달 결과는 D1/D2/C8의 남은 범위. |
| F-7 | 부분 | API demo 키 있어도0·GRAPH rules 태그·FE 브라우저단독0요청·합성119/SMS·hybrid2대상 gate. AI 각 지점 실패/invalid JSON 교정→폴백·4분 연속리허설·실모델/실망 검증 없음. |

## 디자인 UI-1–UI-4 / 비기능 NF-1–NF-12

| ID | 상태 | 현재 근거와 남은 기준 |
| --- | --- | --- |
| UI-1 | 부분 | FE Wanted Sans/시스템 폴백·상태3색·잉크·숫자 tabular. 주요 토큰 대비 검사 근거는 상태문서 참조. 전체 소스/실렌더링 금지기법·실제 폰트 로딩을 재점검해야 한다. |
| UI-2 | 부분 | FE 공통띠/1알약·1366 통화5행 bounding box 검사. 2초 인간인지·긴급/이장 전체조합 폴드/프로젝터 리허설 미실시. |
| UI-3 | 부분 | FE focus-visible·tabs 화살표/Enter/Space·native dialog Escape·polite/assertive·단어+형태. 전체 조합 대비·스크린리더·음성 난청/느린질문 리허설은 남음. |
| UI-4 | 부분 | FE 합성/모의/규칙/비공식면책·자동119 접수≠구조·이장수동. 실API/replay/실음성 경로의 데이터·태그 계약은 미완료. |
| NF-1 | 완료(모의) | 최신 TS 선택: `npm ci` 뒤 `npm run dev` 한 명령으로 FE5173+mock8090; build+start:mock 단일 정적서빙·외부키 없이 동작. 원문 Python 실행명령은 최신 사용자 선택으로 대체. |
| NF-2 | 부분 | `?demo=1` FE local Runtime·자동API/외부요청0 검사. 이미 제공된 정적 번들로 백엔드없이 조작 가능. 원문의 JSONL 시간순 자동재생·배포 번들의 완전한 네트워크차단 시작 검증은 없음. |
| NF-3 | 미검증 | 로컬<300ms·44가구 최초결과12×≤4분·30fps 이상 측정없음. 권위 시계는 명시적1분 버튼이다. 새 지도의80ms local preview는 상태 실행을 진전시키지 않으며30fps/서버 시계 연속 보간 증거가 아니다. JSONL 기록은 API 일부 구현. |
| NF-4 | 부분 | DATA seed/referenceDate·Runtime deterministic mock·서버/FE shared 계산. 새 지도 preview는 브라우저 표시 시각만 바꾼다. 연속 서버 권위 시계·FE 보간·바람 변경 누적·실제/시뮬 시계 전체 검증은 미완료. |
| NF-5 | 부분 | `server/.env.example`: demo/hybrid·Telnyx키/connection/publickey/HTTPS·담당토큰·동의번호2개·journal; unknown mode 거부 검사. 모델/source/속도/재발신/상한/지역/실제상한 설정 계약은 없음. |
| NF-6 | 부분 | API 로컬CORS·64KiB 본문·strict envelope·서명/시각·별도env번호·credential 없는 export·hybrid토큰. 모든 입력 길이/strict 세부 payload·journal/export 전화/전사 마스킹·지시문 최소화·배포 보안 검증은 남음. |
| NF-7 | 부분 | API `snapshot.json`, `webhooks.json`, `events.jsonl`·logger false·0600/0700 생성·source HTTP/저널10/10이 실패/풍속 근거와 예약/위치/종료 export 보존 입증. 정식 records/events 분리·wall/sim/evidence 연계·전체 민감로그 마스킹 검증은 남음. |
| NF-8 | 부분 | 최신 TS의 Node test/Playwright 방식: 실행 시점 전체189/189·모의 domain134/134·최신 private 번들/typecheck·독립 preview E2E21/21·mock Prettier와 diffcheck 통과. 기본 build도 같은 FE hash로 통과했다. source P2/계획 checkpoint 보완의 집중25/25·전체 도메인134/134·FE21/21이 통과했다. 전체 T29/U14 통과 주장은 없음. |
| NF-9 | 부분 | React19·TS/Fastify·Telnyx7.25.0·LangGraph1.4.21·Zod·lockfile·그래프/전화/예약 서비스 분리. AI0/1/4/도우미의 실제 그래프·추론adapter·내구checkpoint·전체 strict schema는 남음. |
| NF-10 | 부분 | FE 1920×1080·1366×768·1280×800·390×844 capture/overflow. 현재 브라우저 Chromium 자동범위이며 행사PC 최신Chrome/프로젝터·전체 탭 장시간 점검은 미검증. |
| NF-11 | 부분 | UI-3과 U14의 키보드 자동범위. 실제 음성/난청·스크린리더·전체대비 미검증. |
| NF-12 | 부분 | README/분석/실행/상태/이문서/Codex기록 존재. 당일개발 증빙·사전준비/외부자원 구분·최종영상·제출·실제 `/review` 실행기록은 미완료. 코드검토 발견을 실제 `/review` 호출로 표시하지 않는다. |

## 기능 검증 T1–T29

원문의 검증 의도 전체를 유지한다. 아래의 “완료(모의)”도 실전화/모델/정부망 성공을 뜻하지 않는다.

| ID | 원문 검증 의도 | 상태 | 실행된 근거 / 남은 검증 |
| --- | --- | --- | --- |
| T1 | 산소 비고→장비·취약도4, 거동추정 분리 | 부분 | NOTES 파서16+등급10 집중26/26·Runtime4/4·FE 적용: 원문 문장 산소→장비/4등급, 별도 보조 근거 없으면 unknown/estimated·근거 slice. 거동/장비 적용 후 확인일/동의 보존과 장비 합집합도 검증했다. 원문의 실모델1회는 미완료. |
| T2 | 공란·불명 보수상향·앞순위 | 부분 | NOTES 집중26/26: 공란/불명/충돌→unknown/estimated/4등급·근거를 만들지 않음. DOM 우선순위 계산은 있음. Runtime 적용4/4·미확정 계획 재계산은 검증됐으나 공란 대상의 해당 앞순위 전체 시나리오 검증은 남음. |
| T3 | 91일 플래그·통화 확인질문 | 부분 | DOM 90-day boundary·FE stale. 음성 지시문 확인질문 없음. |
| T4 | 입원/시설입소/전출/복귀 X/V 분리 | 완료(모의) | DOM family exclusion·CALL consent/exclusion 취소; 실제 복귀 정보재확인 남음. |
| T5 | 관할 외 탈락·모델0 | 완료(모의) | SOURCE16+통합15: exact 관할 필터 탈락·eligibility0·actualModelCalls0·reason 유지. 실제 모델 executor/공식 지역 매핑은 미검증. |
| T6 | 북서발화/서풍/북임도통제 우선·남측권고 | 부분 | DOM ETA/priority·DISP 통제 우회. 원문의 구역우선/남측권고 시나리오 검증 없음. |
| T7 | 구체 학교도착 근거 evacuated | 완료(모의) | DOM plain yes/future/negation 검사 내 실제도착→safe assertion. 최신 fixture enum safe가 원문 evacuated를 표현. |
| T8 | 네/되말/이동 의사 분리 | 완료(모의) | DOM plain yes…·CALL unclear5/moving15: 네=unclear/acked=false·되말 안내/이동=완료아님. |
| T9 | 거부2회→이장큐·기록 | 부분 | DOM refuse·FE 이장요청/결과·Runtime human기록. 설득1회/거부2회 음성 순서검증 없음. |
| T10 | 무응답0/1/2분·문자1·종단전0 | 완료(모의) | CALL resident retry test는0/1/2/3분·추가8회·SMS1·단일목표를 확인. 실제 전화망 재발신 리허설 없음. |
| T11 | 생성timeout→불명·자동재시도0 | 완료(모의) | API injected transport 불명·중복차단·provider ID·demo0, DOM restart·CALL pendingunknown. 실제Telnyx timeout실험 미검증. |
| T12 | 응급·중복·실패→인계1/구급차1·안전아님 | 부분 | DOM emergency override/duplicate receipt·GRAPH auto. 실패adapter/구급차 요청 큐 없음. |
| T13 | 조원재호출2회·불가·재배정 | 완료(모의) | CALL member noanswer/unavailable team·DISP 제안승인·GRAPH 자동불가조 checkpoint. 실제조원호출 없음. |
| T14 | 구역12/대상20·불명 투입금지 | 완료(모의) | DISP zone12/target20·unknownETA, SOURCE stale wind: 일반조 예약0·모의 인계·불명/낡음 신규투입 차단·현재 임무 보류. |
| T15 | 확정403 대체경로·표시 | 미구현 | 최신Telnyx에서 안전한 대체경로정책/전환 UI 없음. |
| T16 | 두절/복구·기존실제세션보존 | 부분 | DOM comms outage/restart·FE 방송/목록. 실망세션종단 재조정 리허설 미실시. |
| T17 | 복수확인이력·명시적갱신·주기 | 부분 | DOM check date changes only…·FE roster. 주기/변동/다음점검 계약 미완료. |
| T18 | 90/91·누락/미래·H=D+V+X | 완료(모의) | DOM fixture/date/family/consent·shared tally·FE six tabs. 독립 다른언어 패리티는 최신TS로대체하되 별도 계산체계 비교는 없음. |
| T19 | confirm 중복/구revision/확정후수정 | 완료(모의) | DOM event confirmation·API full flow stale409·DISP reassign revision/duplicate. |
| T20 | 주민/조원 합산8·목표1·교대·확정전0 | 완료(모의) | DOM fair channels·CALL member single active·API hybrid injected transport. 실제8채널 리허설 없음. |
| T21 | 중복/늦은event/callback/재접속 | 부분 | CALL 도착/동의/제외/응급취소·late safe보존·live transcript 슬롯·API webhook once·DISP 예약중복. 전체live session/attempt/tool 늦은event/재접속은 미검증. |
| T22 | 장비/운전자/정원/경로/복귀차량 | 완료(모의) | DISP 전체 guard·동반자와상·도로단절/교차·shelter정원·driver/crew·returning·road hold/resume·탑승조건변경. prefer 자동순서는 미완료. |
| T23 | 모델 실패/거절/invalidJSON/원문 속 명령 | 부분 | GRAPH strict 결과/유한분기·DOM fabricated evidence reject. NOTES 원문 속 명령/위조·부정 인용은 집중 검증됐다. 실제/가짜모델adapter 교정1회/폴백·source/transcript 전체 정책 공격과 유한 종료 검증은 남음. |
| T24 | demo0·hybrid2·미동의/녹음동의 | 부분 | API demo keys0·unknown/incomplete modes·signed hybrid injected adapter·recording disabled. 동의된 실기기2통화/저장동의 연동 없음. |
| T25 | 관할/최신성/live실패/replay/캐시 | 완료(모의 계약) | SOURCE16+통합15+HTTP/저널10: 관할/시계/미래·낡음·append 실패/폴백·origin/mode/ID·cache key 격리·혼합/낡은 풍속 ETA hold·HTTP409/예약과 위치 유지·export/저널 재시작/종료 byte-stable. 미확정 계획/표시조건/최신 checkpoint·오류/await 중 변화/승인 뒤 자료 오염의 확정/큐0까지 검증. 실제 live 수집·모델 cache executor는 미구현. |
| T26 | 풍하/풍상/횡·단위·변경·패리티 | 부분 | DOM ETA upwind/lateral/invalid. 바람 변경prog·독립패리티±0.5분·화선도달±20% 검증 없음. |
| T27 | 미안전+방문·제외별도·동일snapshot | 완료(모의) | DOM immutable handover·DISP closed snapshot exact restore·FE handover/download. 실제 세션 종료 운영 남음. |
| T28 | 두절중긴급/실제/예약→복구 | 부분 | DOM outage local emergency·CALL 불명slot·DISP 예약보존·FE 전체목록. 실제망재조정·정식출력 리허설없음. |
| T29 | 네/되말/도착/응급/무근거 | 부분 | DOM classification/emergency/fabricated evidence·GRAPH schema/quotes·CALL live transcript≠hangup. 실제 음성 리허설·완성된strict도구인자 검증 없음. |

## 화면 검증 U1–U14

| ID | 원문 검증 의도 | 상태 | 현재 자동범위 / 미실시 범위 |
| --- | --- | --- | --- |
| U1 | 6탭의2초 판독·동일 숫자·알약1 | 부분 | FE six tabs counts·48 markers와 공통 띠/한 결정 구현. 인간2초 판독은 미실시. |
| U2 | 고정 카드·진행1줄·AI-0 중복0 | 부분 | FE 감시/확정/두절 흐름. 개별 자동 분류 log가 존재하며 AI-0 근거별1회/요약 갱신은 미완료. |
| U3 | 1366폴드의 긴급/이장/5행·세부 합계 | 부분 | FE1366 fifth-row bounding box·큐·snapshot counts. pendingunknown/X/hold 전체 조합의 앞5칸 합계·폴드는 미검증. |
| U4 | 7필터·재집계·이력·주기 | 부분 | FE48행/등급/90일 필터/확인 저장·DOM 이력. 7필터의 모든 변경 조합·운영 주기는 미완료. |
| U5 | D/V/X·실제1+1·조원12·공용8·확정전0 | 부분 | FE offline full flow·45/3/0·8/8. 실제1+1 혼합 표시/수신은 없음. |
| U6 | 48지도·HUD≤25%·경로·30fps | 부분 | FE48 markers·합성 경로/차량의 같은 map·면책·viewport capture. 새 지도·낡은 풍속 차단을 포함한 E2E21/21 통과. local preview 추가·HUD 면적 측정/30fps 미검증. |
| U7 | 조 응답/단계/담당·차량·요약 | 부분 | FE 자원 카드·DISP 예약/단계·재배정 UI. 재호출/재배정/예약 포함 E2E21/21 통과·원문의 전체 숫자 세트 점검 남음. |
| U8 | 소스8·JSON·origin·실패 반영 | 부분 | SOURCE16+통합15+HTTP/저널10·FE origin/mode/freshness/record ID·별도 실패/replay JSON. 실패7/8 유지·낡은 풍속 지도 HUD 차단도 최신21/21에서 통과. 관측 없는 실패 record의 fixture 시각/요약 대체 금지·신규 미확정 계획 검증도 FE21/21에서 통과했다. 전용 판단 타임라인 없음. |
| U9 | 도우미5문장·변경 로그 | 부분 | ASSIST 규칙5범주·동적 자원·통신 토글·human 순위/통신 로그 집중10/10 통과. FE의 최신 revision 전달 확인. 전체5문장 브라우저 리허설은 미검증. |
| U10 | 해상도3·2열/1열·독립 스크롤 | 부분 | FE4 viewport overflow/capture·CSS breakpoint. 모든 탭의 독립 스크롤·행사 프로젝터 리허설은 미실시. |
| U11 | D−K+방문·제외·녹음 없음·마스킹 export | 부분 | FE handover/frozen/download·DOM/DISP 불변 snapshot·모의 전사/녹음 없음. 실제 전사/ID/민감 마스킹·인쇄 시각 검증 남음. |
| U12 | 금지 검사·태그·전체 대비 | 부분 | 상태 토큰/폰트·주요 색 대비는 상태 문서의 기록 참조. 전체 화면 대비·금지 항목 전수/실제 폰트 검사는 미완료. |
| U13 | 자동119·실패·접수≠구조·경로 표시 | 부분 | GRAPH 자동 응급·FE 모의 접수·DOM 접수≠안전. 실패 adapter·실API/replay/실모델 실행 경로는 없음. |
| U14 | 느린 음성/되말/난청·키보드/포커스 | 부분 | FE tabs 화살표·모달 Escape·지도 키보드·aria-live. 전체 포커스/스크린리더·실제 음성/난청/언어 실패 리허설 미실시. |

## AI·외부 연동·데이터·제출의 추가 경계

원문의 모델 선택 목표도 유지한다. 감시·방송·미인식 도우미 해석은 `gpt-6-luna`, 명단은 `gpt-6.1-sol`, 예측/순서는 같은 모델의 high 추론·strict 출력, 실제 음성은 `gpt-live-1`과 위임 모델을 요청했다. 이는 제공된 요구의 모델명·API 목표를 보존한 것이며 현재 adapter의 공식 계약 확인·조직 권한·실행 성공을 확인한 결과가 아니다. 주민 도구7종(`record_status`, `request_human`, `request_vehicle`, `add_companion`, `escalate_119`, `send_sms`, `schedule_callback`)과 조원 도구2종(`squad_response`, `squad_report`)은 strict schema·서버 문맥의 가구/session/임무 결합·인용 근거·중복/늦은 결과 재검증을 포함해 구현·리허설해야 한다. 현재 모의 command를 이 실제 도구 브리지의 완료로 처리하지 않는다.

| 원문 흐름 | 상태 | 현재 구현 / 남은 범위 |
| --- | --- | --- |
| AI-0 감시 | 부분 | SOURCE 관할/최신성/임계·격리 cache key·actualModelCalls0 검증. strict 추론→근거 검증 실제 그래프·cache executor·usage 미구현. |
| AI-1 명단 | 부분 | NOTES 지원필드/unknown/estimated·원문 인용 offset·보수 규칙 파서16+현재 건강 근거 등급10의 집중26/26·Runtime4/4·FE 적용을 검증했다. 지원필드 전체 적용은 남음. 원문→추출→근거 검증 실제 그래프/추론 adapter는 미완료. |
| AI-2a/2b 발령 | 부분 | 실제 계획 StateGraph·검토 interrupt/resume·코드 ETA/순서. 추론 adapter·고정 source/evidence·교정/비용 없음. |
| AI-3/AI-3′ 주민·조원 | 부분 | 전사 규칙 StateGraph·응급 조건 분기·공용 mock 큐·Telnyx call-control. 실제 음성/위임 tool·조원 보고/가구 상태 통합 없음. |
| AI-4 방송 | 부분 | 두절 고정 문안. strict 문안 검증/실제 그래프·모델 실패 폴백 없음. |
| 도우미 | 부분 | ASSIST 규칙5범주·명시적 명령/질문 구분·사람 결정 경계 검증. 선택적 모델 해석과 실제 허용명령 검증 그래프는 미완료. |
| 그래프 복구 | 부분 | 실제 MemorySaver와 checkpoint 검증·로컬 상태 snapshot 복원·불명 전화 보류. **MemorySaver는 프로세스 메모리**이며 durable graph checkpoint·운영 재접속/기처리 실행 재조정은 미완료. |
| 사용량/예산 | 미구현 | 외부 모델 호출0 표시. 실제 모델 token/audio·비용≤$5 목표 측정·예산 초과 신규 선택 호출 폴백 없음. |
| 공공소스8종 | 부분 | 산불 현황/문자/위험 지수/특보/바람/예보/수위/대피소의 자체 합성 JSON. SOURCE 모의 관할/freshness/원문/실패 분리는 검증. 공식 봉투/단위/업무코드/권한/지역매핑/8초 timeout·실제 adapter는 미검증. |
| Telnyx 실제수신 | 미검증 | 공식 SDK·공개 HTTPS/서명키/allowlist/동의 gate. 실기기 주민1/조원1·한국 발신·양방향 음성·종료/녹음/보관 리허설 없음. |
| 119·SMS | 부분 | 자동119 합성 접수와 문자 기록. 이번 제출의 실제119/SMS 외부 발신은 범위 밖. 모의 실패/불명/incident/구급차 요청 계약은 남음. |

합성 데이터 요청의 1–10 결과도 다음과 같이 분리한다.

| 자료 번호 | 결과 | 상태·검증 |
| --- | --- | --- |
| 1 | metadata | 완료(합성): synthetic/schemaVersion/seed/referenceDate/timeZone/countingRules 명시·DOM검사. |
| 2 | zones | 완료(합성): W10/N15/E13/S10·팀/대피소참조·로컬경계·합성ETA·DOM관계. |
| 3 | shelters | 완료(합성): 3유형·정원·로컬좌표·참조유효·DOM검사. 실제접근성확인아님. |
| 4 | households | 완료(합성 핵심): 48/45/3·동의없음2/전화없음1중복0·등급4=3/3=12·stale3·DEMO주소/연락·48고유좌표·DOM검사. 화면상의마커거리/겹침전수검증은별도. |
| 5 | teams | 완료(합성):4×3·9가능/3불가·각팀운전가능·담당참조양방향·DOM검사. 실제 수신자플래그없음. |
| 6 | vehicles | 완료(합성):10/수송9/진화1·DEMO번호판·장비/driver참조·중복출동운전자검사. 실장비검증아님. |
| 7 | sources | 완료(합성):8범주·demoRefreshSeconds/demoPayload·자체스키마·실URL/키/실수신기록없음. 원문W-2실형식요구는별도 미완료. |
| 8 | responseCases | 완료(합성):14허구범주·짧은발화·모의outcome/사람검토/synthetic. 실제상담/운영프롬프트아님. |
| 9 | scenarios | 완료(합성):정적5장면·48상태·counts실계산·검토ID일치·JSON내자동시계없음. Runtime의명시적동작은데이터외별도구현. |
| 10 | transcripts/eventLogs | 완료(합성):허구전사10/이벤트5/checkLog96·참조/로그시간/순서·DOM검사. 외부실행성공/실녹음증거아님. |

## 종료하지 않은 목표

현재 완료된 것은 합성 자료와 표에 적은 모의 동작이다. React 19 + Node TypeScript + Telnyx + 실제 LangGraph 전체 제품의 목표를 유지한다. 모델 adapter와 모든 추론 그래프, 공식 source 관할/허용치/지시와 실제 수집 계약, 엄격한 live 도구/전화망 통합, 구급차 요청/우선 배차 큐, 연속 시계/30fps/4분 성능, durable checkpoint와 전체 T/U 검증이 남았다.

동의된 실제 수신자2명, 키/권한·공개 HTTPS·수신 기기·녹음/보관 정책의 실제 리허설, 4분 영상과 휴대폰 수신 장면, 행사 등록/최종 제출도 **미검증 또는 미완료**다. 이 문서 감사에서 실모델·실전화·정부 API를 호출하거나 커밋·푸시하지 않았다. 실제 `/review` 실행을 확인하지 않았으므로 Codex 코드검토 발견 사례만 별도 기록한다.
