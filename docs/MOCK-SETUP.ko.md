# React 모의 상황실 실행·서버 연결

React 19 화면은 `fe/`, Node.js/TypeScript API는 `server/`, 공용 상태·집계·시계·예약은 `shared/`, 새 합성 JSON은 `fixtures/`에 있다. 목표는 React + NodeTS + Telnyx + 실제 LangGraph를 연결한 상황실이며, 아래 명령은 현재 검증된 모의 범위를 실행한다. 실모델·정부 API·실제119/SMS 호출은 없다.

루트 `src/`·`public/` 전화 PoC는 별도 구현이다. 그 안의 8팀·6차량과 React의 4조/12명·10자원을 하나의 모델로 합치지 않았다. mock 서버는 전화 PoC 개인 설정 파일을 읽지 않는다.

## 실행

Node.js 24에서 저장소 루트 기준:

```sh
npm ci
npm run dev
```

React 개발 화면은 `http://localhost:5173`, mock 서버는 `http://localhost:8090`이다. Vite가 `/api`를 전달한다. 기본 `ON_EXECUTION_MODE=demo`는 키가 있어도 실발신·외부 모델을 실행하지 않는다.

```sh
npm run build
npm run start:mock
```

빌드한 React를 mock 서버가 `http://localhost:8090`에서 제공한다. `npm start`는 별도 전화 PoC의 `src/server.ts`를 실행하므로 모의 상황실은 `start:mock`을 사용한다.

브라우저 단독 모드는 `http://localhost:5173/?demo=1` 또는 빌드 preview URL의 `?demo=1`이다. 자동 API/외부 요청 없이 번들의 local Runtime을 사용한다. 이미 제공된 정적 번들이 필요하며 직접 `file://`로 여는 방식이나 JSONL 시간순 자동 재생은 아니다. 이 모드에서는 서버의 실제 LangGraph가 실행되지 않는다.

서버는 `ON_JOURNAL_DIR`(기본 `.data/mock`)에 상태 snapshot·events.jsonl·중복 webhook ID를 저장한다. `.env`는 자동 로드하지 않으므로 `server/.env.example`을 참고해 shell 환경변수로 지정한다. 활성 상태 재시작은 통신 보류와 기존 실제 요청 불명을 보존한다. 종료 frozen snapshot은 동일 기록/집계/예약/metadata로 복원한다. source HTTP/저널 집중4/4는 실패/폴백 근거·풍속 보류 임무의 예약/위치·종료 export byte-stable과 재시작 동일성을 검증했다. 실제 API/모델 호출은0이다.

## 모의 시연 순서

1. 평시 → 가구 명단: 48행·7필터, 가구 상세의 원문/지원필드·복수 확인 이력·30초 모의 확인. 필드 저장은 확인일을 바꾸지 않는다. 원문 재구조화의 규칙 제안/인용/불명·추정을 검토하고 담당자 적용 버튼을 누르면 거동/장비와 코드 취약도를 갱신한다. 동의·연락·확인일은 유지하며 현재 임무 중에는 차단한다.
2. 감시 시작: 자체 합성 source record8·발신0·actualModelCalls0. 관할/키워드/임계 필터와 replay 시계 기준 최신성을 확인한다. source 카드에서 origin/mode·관측/수집 wall/replay·근거 ID·원문을 읽는다. 실패 시연 뒤 수집은 별도 fallback record를 추가하며 실패를 성공으로 덮지 않는다.
3. 발령 절차 시작 → 순서 검토: 전화45·방문3·임시제외 사유, ↑↓ 또는 미확정1순위 명령 → 담당자 확정. 확정 전 모의/실제 신규 발신0.
4. 통화: 주민/조원 공용8채널·모의1분 진행. “네”는 확인 필요와5분 후속 예약, “지금 이동 중이에요”는15분 도착 재확인, “학교에 도착했어요”는 도착 근거다. 새 도착/응급·동의 철회·임시 제외는 오래된 예약을 취소한다.
5. 조원 통화의 무응답 시연: 최초 후1분 간격 추가2회·불가. 해당 담당 대상의 재배정 후보를 검토한다. 승인 전 임무/예약0, 담당자 승인 또는 반려를 기록한다.
6. 가구 상세에서 가상 동반자·거동을 추가한다. 자원 탭에서 장비/접근성/정원/운전자/지원 인원을 검토한 뒤 배차한다. 조/가구/차량/운전자/지원/대피소좌석은 같은 임무로 예약한다.
7. 지도와 자원 탭에서 같은 임무의 경로·현재 위치·단계를 확인한다. 도로 통제 시 현재 위치/예약을 유지한 채 보류한다. 도로 재개 후 담당자 복구 승인이 필요하다. 풍속 source 실패/낡음/혼합 기준일은 ETA를 불명으로 유지하고 신규 배차를 차단하며 기존 임무도 보류한다.
8. 거부 대상은 이장 연결 요청·수동 연락 결과를 기록한다. “숨쉬기 힘들어요”는 자동119 **모의 접수**이며 구조 완료가 아니다. 현재 별도 구급차 요청 큐와 모의 접수 실패 adapter는 미완료다.
9. 통신 두절 → 고정 방송 문안·전체 미해결/방문 인수인계 → 복구 → 담당자 인수인계 확인 → 기록 종료 snapshot·JSON·인쇄.

위 순서는 4분 발표를 구성하기 위한 조작 순서이며, 자동12× 재생으로4분 안에 끝난다는 성능 측정 결과가 아니다. 모의1분 버튼이 공용 시계를 진행한다. 새 지도 컴포넌트의 배속 local preview는 화면만 미리 보며 실제 호출/임무 상태를 진전시키지 않는다. 새 지도·명단 적용을 포함한 독립 preview의 FE20개(starter17+지도3)는 통과했다. 서버 권위 연속 실행과4분 성능은 미검증이다. 상단의 정적5장면을 선택하면 mock 상태를 초기화한다. fixture JSON에 자동 타이머/상태 머신은 없다.

## 공용 API와 command 입력

모든 command는 `POST /api/command`의 `{action,input}` 형식이다. revision이 필요한 동작에는 바로 전 `GET /api/state` 또는 성공 응답의 최신 revision을 넣는다. 오래된 revision은409를 반환한다. 아래 ID는 응답의 실제 ID를 사용하며 승인 후보를 임의로 만들지 않는다.

| action | input | 효과·검증 경계 |
| --- | --- | --- |
| `watch` | `{}` | idle→watch·합성 감시·발신0 |
| `plan` | `{}` | watch→발령 제안·담당자 검토 대기 |
| `reorder` | `{revision,ids:[전화 대상 전체 ID]}` | 미확정 계획의 중복/누락 없는 순서만 변경 |
| `confirm` | `{revision}` | 주민/조원 공용 큐·방문 요청·모의 문자 기록1회 생성 |
| `advance` | `{}` | 모의1분·호출결과/예약/임무 타임라인 진행; 두절/종료 상태 차단 |
| `transcript` | `{id:"H001",text:"지금 이동 중이에요",eventId:"고유 합성 이벤트 ID"}` | 발화 근거 재검증·중복1회·moving15/unclear5 모의 예약; 실제 전화 종단으로 취급하지 않음 |
| `member-response` | `{callId:"응답 calls의 현재 모의 조원 통화 ID",outcome:"available" 또는 "unavailable" 또는 "noanswer"}` | 현재 모의 member 통화만 처리·무응답 추가2회 후 불가·자동 재배정 제안 |
| `schedule-callback` | `{revision,id:"H001",minutes:5}` | moving/unclear 대상의 기존 모의 예약 대체·1–60분; 실제 통화의 자동 후속 발신은 보류 |
| `check` | `{id:"H009",source:"담당자",fields:["mobility"]}` | 실제로 확인한 합성 필드/출처/담당자 이력 추가·명시적 모의 확인일 갱신 |
| `notes-restructure` | `{revision,id:"H001"}` | 원문/건강/현재 거동의 순수 규칙 제안·인용/unknown/estimated 보존·거동/기존+추가 장비 적용·취약도 재계산·확인일 유지·현재 배차 임무 수정 차단. Runtime4/4·FE 적용 검증 통과; 전체 지원필드/실모델 적용은 미완료 |
| `edit` | `{revision,id:"H001",mobility:"보조",consent:true}` | 거동/동의 편집·확인일 유지·대상/큐 재조정 |
| `family` | `{id:"H001",status:"입원" 또는 "시설 입소" 또는 "전출" 또는 "복귀"}` | 임시제외/복귀·V와X 분리·오래된 예약 취소 |
| `companion` | `{revision,id:"H001",label:"가상 동반자",mobility:"자력",devices:[],companionId:"선택 고유 ID"}` | 모의 동반자/거동/장비 저장·중복ID1회·최대8명; 실행 임무의 정원 변경 차단 |
| `dispatch` | `{id:"H001",vehicleId:"V01"}` | 최신 장비/driver/crew/정원/대피소/ETA/경로 검증 후 원자 예약 |
| `reassign-propose` | `{revision,id:"H001"}` | 인접조 거리→면차량→119지원 후보 제안; 일반 후보 승인 전 실행0 |
| `reassign-approve` | `{revision,id:"reassignments의 pending 제안 ID",vehicleId:"후보 차량 ID 또는 null"}` | 담당자 승인·최신 조건 재검증 후 실행; null은 모의119 지원 요청 |
| `reassign-reject` | `{revision,id:"pending 제안 ID"}` | 담당자 반려·실행0·같은 자동 제안이 반려를 덮지 않음 |
| `road-control` | `{revision,id:"data.map.roads의 도로 ID",blocked:true 또는 false}` | 합성 도로 통제/해제·현재 임무 재검증·보류 시 예약 유지 |
| `trip` | `{id:"trips의 현재 임무 ID",stage:"arrive" 또는 "boarded" 또는 "shelter" 또는 "return"}` | 현재 임무의 다음 단계만 담당자 보고·도로/장비/인원/도착 조건 재검증 |
| `trip-resume` | `{revision,id:"heldReason이 있는 현재 임무 ID"}` | 담당자 복구 승인·경로/ETA/조원/장비 재검증·기존 예약 유지 |
| `comms` | `{down:true 또는 false}` | 신규 실행 보류/복구·기존 세션 유지·현지 긴급 보존 |
| `source-fail` / `collect` | `{id:"소스 ID"}` / `{}` | simulated-live-failure record / 별도 own-schema replay append·관측 시각 불변·origin/mode/error/근거 보존; 실패 source는 새 fallback에도 정상으로 덮지 않음 |
| `leader-request` / `leader-result` | `{id:"H001"}` / `{id:"H001",result:"이동 확인" 또는 "방문 필요" 또는 "연락 불가"}` | 사람의 수동 연락 요청/결과·설득/이동 확인≠안전 |
| `visit-complete` | `{id:"방문 전용 가구 ID"}` | 방문 모의 확인·전화 안전 분모와 분리 |
| `assistant` | `{text:"몇 집 남았나",revision}` | 구역/현황/동적 자원·미확정1순위·명시적 통신 두절/복구. 순위 변경은 최신 revision 필요. 질문/부정/복합·무효 명령은 상태 무변경; 확정/이장/재배정은 사람 버튼 |
| `review-graph` | `{id:"waiting인 전사 graphRuns ID"}` | 서버 전사 검토 checkpoint 재개·새 도착 근거 없이 안전 처리하지 않음 |
| `close` | `{acknowledged:true}` | 전체 미해결 인수인계 확인·새 작업 차단·종료 snapshot; 실제 활성/불명 통화는 종료 차단 |
| `scenario` | `{id:"idle" 또는 "watch" 또는 "review" 또는 "active" 또는 "late"}` | 정적 합성 장면으로 초기화; 실제 열린 세션이 있으면 차단 |

| 경로 | 현재 기능 |
| --- | --- |
| `GET /api/state` | 데이터·scenario·revision·계획·calls·trips/completedTrips·shelterAdmissions·reassignments·handoffs·firstPass·records·graphRuns·sourceState의 append 근거/policies/actualModelCalls0 |
| `GET /api/health` | 실행 모드·규칙 추론·LangGraph 라이브러리·외부 모델 호출0 |
| `GET /api/export.json` | 현재 또는 종료 View·합성 근거·전사·예약; 환경 key/실번호/원 provider payload 없음 |
| `POST /api/telephony/dial` | `{targetId:"H012" 또는 "M01",targetType:"resident" 또는 "member",consent:true,revision}`·공용8/allowlist/동의/확정 검사. demo는 외부 실행0 |
| `GET /api/telephony/state` | 기존 request/provider ID·생성/응답/종료 상태·recording disabled·mock 음성대화 미구현 표시 |
| `POST /api/telephony/hangup` | `{requestId}`·기존 provider ID에 종료 요청; 요청은 종료 확인이 아님 |
| `POST /api/telnyx/webhook` | raw body Ed25519·120초 시각 허용·이벤트 중복 방지·서명된 hangup에서만 실제 슬롯 해제 |

## 실제 LangGraph와 복구의 범위

`@langchain/langgraph`1.4.21을 실제 사용한다. 서버의 계획 그래프는 snapshot→데모 ETA/순위→ID/rank 검증→담당자 `interrupt`→동일 checkpoint `Command({resume})`→승인 제안이다. 전사 그래프는 정규화→규칙 분류→strict 스키마/인용 검증→응급 자동 제안 또는 사람 검토→결과다. 재배정은 검증 후보 snapshot→담당자 `interrupt`→승인/반려 `resume`→현재 조건 재검증 결과를 기록한다. 전화/배차는 그래프 밖 공용 Runtime이 한 번만 적용한다.

추론은 명시적 `rules` 경로이며 LLM 호출 성공이 없다. 브라우저 단독은 local rules 모드다. source 관할/최신성·필터/원문 cache key·낡은 풍속의 계획/지도/배차 보류는 검증됐으나 감시/명단/방송/도우미의 전체 추론그래프와 모델 adapter는 후속 구현 대상이다. 필터 통과 예정 수와 실제 모델 호출0을 구분한다. `MemorySaver`는 프로세스 메모리 checkpoint다. 상태 JSON 복원은 durable graph checkpoint를 대신하지 않는다. 미확정 계획은 재시작 때 새 검토 그래프로 만들고 실제 요청은 불명 상태로 보존한다.

합성 도로의 로컬 접근은 개방 도로까지≤250px인 경우만 연결하는 명시적 데모 가정이다. 실제 도로·주행 안전 또는 구조 성공을 입증하지 않는다. map 위치 계산은 예약한3구간 경로/시각을 사용한다. 새 local preview의80ms 갱신은 서버 권위 시계의 연속 보간/30fps 검증을 대신하지 않는다. 바람 변경 누적 ETA도 미완료다.

## Telnyx 설정과 실검증 경계

`server/.env.example`을 참고한다. hybrid에는 API key·Call Control Application ID·E.164 발신번호·32byte 공개 Ed25519키·HTTPS webhook URL·32자 이상 담당자 토큰이 필요하다. 수신 번호는 환경변수 `REAL_RESIDENT_E164`/`REAL_SQUAD_E164`와 각각의 동의 플래그 `yes`로만 허용한다. 주민H012·조원M01 이외 실제 수신자는 차단한다. HTTP 변경 요청의 `Authorization: Bearer` 토큰은 저장소에 기록하지 않는다.

Telnyx SDK 재시도는0이다. 생성 실패/불명은 요청ID·provider ID·채널을 유지한다. 벨30초/응답후120초 타이머는 시뮬 시계와 분리한다. 실제 전사 결과 또는 hangup 요청만으로 종료됐다고 처리하지 않고 서명된 전화망 종단을 확인한다.

mock API의 Telnyx 경로는 발신/종료/webhook call-control까지다. 양방향 음성 agent·전사/tool·녹음/보관·한국 휴대폰 수신·통신 복구 리허설은 검증하지 않았다. 실제119/SMS adapter는 이번 제출 범위 밖이며 현재 자동119는 합성 접수다. 모의 실패/결과불명·구급차 요청 큐는 남은 구현으로 기록한다.

## 검증

```sh
npm test
npm run build
npm run test:e2e
npm run check:skills
npm audit --omit=dev
```

실제 실행 결과와 미완료 항목은 [implementation-status.md](implementation-status.md), 요구별 근거는 [requirements-verification.md](requirements-verification.md)를 따른다. 명령 존재를 통과 증거로 쓰지 않고 모의 테스트 성공을 실전화/모델/외부API 성공으로 해석하지 않는다.
