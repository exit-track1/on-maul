# React 모의 상황실 실행·서버 연결

React 19 화면은 `fe/`, Node.js/TypeScript API는 `server/`, 공용 상태·집계·시계·예약은 `shared/`, 새 합성 JSON은 `fixtures/`에 있다. 기본 실행은 모의 상황실이며 외부 모델·전화·정부 API·실제119/SMS를 호출하지 않는다. 실제 전화·GPT 음성 연결은 아래 별도 설정으로 활성화한다.

루트 `src/`·`public/` 전화 PoC의 검증된 `CallManager`·음성 브리지·전사·GPT 응답 판정을 상황실 Node 서버에서 재사용한다. 별도 PoC의 8팀·6차량 데이터 대신 상황실의 4조/12명·10자원 공용 Runtime에 결과를 반영한다. 기본 demo 모드는 개인 전화 설정이나 활성 통화 기록을 읽지 않는다.

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

서버는 `ON_JOURNAL_DIR`(기본 `.data/mock`)에 상태 snapshot·events.jsonl·중복 webhook ID를 저장한다. 환경 파일은 `ON_ENV_FILE`, 존재하는 `.phone/.env`, `.env` 순서로 선택하며 이미 지정된 shell 환경변수를 우선한다. `server/.env.example`을 참고한다. 활성 상태 재시작은 통신 보류와 기존 실제 요청 불명을 보존한다. 종료 frozen snapshot은 동일 기록/집계/예약/metadata로 복원한다. source HTTP/저널 집중10/10는 실패/폴백 근거·풍속 보류 임무의 예약/위치·종료 export byte-stable과 재시작 동일성을 검증했다. 이 모의 검증에서 실제 API/모델 호출은0이다.

## 실제 전화·전사와 구조 시연 연결

`ON_EXECUTION_MODE=hybrid`, `ON_PHONE_ENABLED=yes`로 기존 PoC 음성 엔진을 활성화한다. OpenAI/Telnyx 설정은 기존 개인 설정을 읽고, 상황실의 활성 통화·전사 이력은 `ON_PHONE_DATA_DIR`(기본 `.data/dashboard-phone`)에 별도로 저장한다. 대상별 번호와 동의는 H012 `REAL_RESIDENT_E164`/`REAL_RESIDENT_CONSENT`, M01 `REAL_SQUAD_E164`/`REAL_SQUAD_CONSENT`다. 실제 번호와 키는 커밋하지 않는다.

```sh
ON_ENV_FILE=.phone/dashboard.env npm run start:server
```

`PUBLIC_BASE_URL`의 `/probe/`, `/webhooks/telnyx`, `/media/`를 **현재 상황실 Node 포트**로 연결해야 한다. 발신 전에 같은 서버의 확인 토큰을 검사하여 기존 PoC나 다른 서버로 연결된 URL의 발신을 차단한다. 로컬·배포 상황실 모두 같은 주소의 `GET /api/phone/bootstrap`에서 기존 서버 환경변수 `ON_OPERATOR_TOKEN`을 자동으로 불러온다. 토큰은 페이지의 클라이언트 메모리에만 유지하며 브라우저 저장소·쿠키·URL·빌드 환경변수에 저장하지 않는다. 연결 설정 응답은 `Cache-Control: no-store`로 반환하며 토큰 입력란은 제공하지 않는다. 활성화된 전화 전사·상태·export 읽기는 자동으로 불러온 토큰으로 담당자 인증을 수행한다.

1. 상단에서 반영환 할아버지 또는 반영환 대원 시나리오를 선택하고 발신 동의를 확인한다. 전화 모드는 실제 전화로 고정되며 준비되지 않으면 발신을 차단한다.
2. **화재 발생·대피 시연 시작 → 확정하고 실제 전화 발신**으로 선택한 대상에게 발신한다. 할아버지 시나리오는 H012에게 전화한다. 대원 시나리오는 박미숙 할머니 H009의 구조 요청이 이미 접수됐다는 가정에서 M01에게 바로 출동 가능 여부를 묻는다. H009에게 전화하지 않는다.
3. 왼쪽 **상황 로그 | 통화 내역**에서 두 대상별 실제 AI/수신자 전사, 판정 근거와 과거 통화를 확인한다. 모의 통화는 이 탭에 표시하지 않으며 실제 통화가 없으면 빈 내역을 표시한다. 오른쪽 지도는 계속 표시한다.
4. 실제 통화 중에도 지도 시계와 합성 화재는 계속 진행한다. 구조 이동은 최종 전화 종료와 검증된 결과를 확인한 뒤 시작한다. 모호함·응급·출동 불가·차량/준비 미확인은 담당자 검토로 남긴다.
5. 지원 필요와 대원 출동 조건이 확인되면 기존 차량·조원·장비·경로 검증 후 지도 이동을 시작한다. 차량 탑승과 동일 임무의 대피소 도착에서 상태가 갱신된다.

| 경로                                           | 기능                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /api/phone/bootstrap`                     | 전화 활성 여부·서버 담당자 토큰 자동 연결 설정, 캐시 금지                        |
| `GET /api/phone/state`                         | 두 대상 설정 준비 여부·마스킹된 전사/통화 이력·분류 근거                         |
| `POST /api/phone/dial`                         | `{targetId,revision,consent:true}`·현재 시연 대상에 수동 재발신·자동 재시도 없음 |
| `POST /api/phone/hangup`                       | `{callId?}`·현재 통화 종료 요청                                                  |
| `POST /api/phone/resolve`                      | `{callId,confirmedEnded:true}`·통신사 종료를 확인한 담당자의 불명 통화 해제      |
| `POST /webhooks/telnyx` / `WSS /media/<token>` | 기존 PoC의 서명 검증·실시간 양방향 음성 브리지                                   |

전화는 실제 수신 결과를 사용하는 경로이고, 화면의 화재·집 좌표·차량 이동·대피소 입소는 합성 시연이다. 실차 GPS나 실제 구조 성공 확인을 뜻하지 않는다. 실제 119/SMS 및 공공 API 연동은 포함하지 않는다. 운용 중인 PoC 서버의 별도 통화를 동시에 시작하지 않는다.

## 메인 시연: 화재 발생부터 대피·인수인계 종료까지

반복 시연 전에 상단 **처음 상태로 → 초기화하기**를 누르면 서버의 시연 시간·산불·구조 상태·상황 로그·화면 통화 내역을 평시 초기 상태로 되돌린다. 초기 상태를 저장하므로 새로고침과 서버 재시작 후에도 이전 테스트 내역이 다시 표시되지 않는다. 환경변수·수신 번호·동의 설정과 원본 음성 감사 기록은 유지한다. 진행 중이거나 종료 미확인인 실제 통화가 있으면 초기화할 수 없다.

화면은 서버 상태를 225ms 간격으로 구독한다. 서버·전화 준비가 없으면 시작을 차단하며 모의 통화로 전환하지 않는다. `?demo=1`은 개발용 정적 점검 화면이며 실제 전화 사이클을 시작할 수 없다.

1. **메인 시연**에서 반영환 할아버지 또는 반영환 대원 시나리오를 선택한다. 지도에 구조 대상 집을 강조한다.
2. 발신 동의 후 **화재 발생·대피 시연 시작**을 누르고 대상·발령 계획을 검토한다. 확정 전 발신은0이다.
3. **확정하고 실제 전화 발신**을 누른다. 할아버지 시나리오는 H012에 전화하며, 대원 시나리오는 H009의 구조 요청을 접수한 상태로 M01에 바로 전화한다. 다른 가구의 모의 전화를 만들지 않는다.
4. 왼쪽 전사와 오른쪽 지도를 함께 확인한다. 실제 통화 중에도 지도 시계와 합성 화재는 계속 진행하며, 배속은 실제 전화의 벨·응답·종료 타이머에 영향을 주지 않는다. 최종 통화 종료와 응답 조건이 확인되면 기존 자원·경로 검증을 거쳐 구조 이동을 시작한다.
5. 차량 탑승 후 주민·대원의 구조 상태를 갱신하고 같은 임무의 대피소 도착에서 완료를 기록한다. 미해결 가구는 인수인계 후 **기록으로 종료**한다.

| 실제 통화 시나리오   | 표시하는 흐름                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 반영환 할아버지 H012 | 실제 전화 → 이동 불가·구조 요청 판정 → 구급차 V01 출동 → 탑승 시 대피 중 → 대피소 S2 도착 후 대피 완료                                                      |
| 반영환 대원 M01      | 박미숙 할머니 H009의 구조 요청 접수 가정 → M01 실제 전화·참여/차량/준비 시간 확인 → V04 출동 → H009 구조·수송 중 → S2 도착 후 주민 대피 완료·대원 구조 완료 |

박미숙 할머니는 구조 대상이며 통화 대상이 아니다. 지원 인원 M02/M03의 가용성은 사전에 확인한 시연 자원으로 기록하며 모의 전화 응답을 만들지 않는다. 화재·집 좌표·차량 이동·대피소 입소는 합성 시연이고, H012 또는 M01의 전화와 전사만 실제 수신 결과를 사용한다. 설명 카드와 모의 통화 내역은 표시하지 않는다.

두 대상·실제 전화 고정 변경은 Node 테스트271/271, 브라우저32/32, 전화 비활성 HTTP 서버에서 모의 전환 차단2/2, 빌드·타입 검사로 검증했다. 전화 엔진·통신사·GPT는 테스트 대역을 사용했으며 실제 수신자 발신은 수행하지 않았다.

매 합성1분의 관측은 `origin: synthetic`으로 기록한다. 데이터 소스 실패와 fallback 연결, 도로·장비·정원·운전자 검증을 유지한다. 재시작 후 자동 진행은 보류하며 담당자의 복구·재생을 기다린다.

## 개발용 규칙 점검 기록

다음 항목은 기존 내부 모의 Runtime의 회귀 점검 기록이다. 실제 전화가 활성화된 운영 API는 모의 전사·조원 응답·콜백·발신 계획 생성을 차단한다. 운영 화면의 메인 시연은 위 실제 전화 두 시나리오만 사용한다.

1. 평시 → 가구 명단: 48행·7필터, 가구 상세의 원문/지원필드·복수 확인 이력·30초 모의 확인. 필드 저장은 확인일을 바꾸지 않는다. 원문 재구조화의 규칙 제안/인용/불명·추정을 검토하고 담당자 적용 버튼을 누르면 거동/장비와 코드 취약도를 갱신한다. 동의·연락·확인일은 유지하며 현재 임무 중에는 차단한다.
2. 감시 시작: 자체 합성 source record8·발신0·actualModelCalls0. 관할/키워드/임계 필터와 replay 시계 기준 최신성을 확인한다. source 카드에서 origin/mode·관측/수집 wall/replay·근거 ID·원문을 읽는다. 실패 시연 뒤 수집은 별도 fallback record를 추가하며 실패를 성공으로 덮지 않는다. 관측 없는 실패 record의 시각/요약은 fixture 값으로 대체하지 않고 불명으로 표시하는 보완이 추가됐으며 FE21/21·source Runtime/API 집중25/25 회귀를 통과했다.
3. 발령 절차 시작 → 순서 검토: 전화45·방문3·임시제외 사유, ↑↓ 또는 미확정1순위 명령 → 담당자 확정. 확정 전 모의/실제 신규 발신0. source 실패/수집으로 ETA·근거 조건이 바뀌면 최신 계획을 다시 검토하고, 무관한 수집은 수동 순서를 유지한다. 확정 직전 표시조건 재검증·서버의 이전 checkpoint supersede/최신 검토 checkpoint 보완은 FE21/21·source Runtime/API25/25에서 계획 실패/replay/확정 흐름과 최신 checkpoint 검증을 통과했다.
4. 통화: 주민/조원 공용8채널·모의1분 진행. “네”는 확인 필요와5분 후속 예약, “지금 이동 중이에요”는15분 도착 재확인, “학교에 도착했어요”는 도착 근거다. 새 도착/응급·동의 철회·임시 제외는 오래된 예약을 취소한다.
5. 조원 통화의 무응답 시연: 최초 후1분 간격 추가2회·불가. 해당 담당 대상의 재배정 후보를 검토한다. 승인 전 임무/예약0, 담당자 승인 또는 반려를 기록한다.
6. 가구 상세에서 가상 동반자·거동을 추가한다. 자원 탭에서 장비/접근성/정원/운전자/지원 인원을 검토한 뒤 배차한다. 조/가구/차량/운전자/지원/대피소좌석은 같은 임무로 예약한다.
7. 지도와 자원 탭에서 같은 임무의 경로·현재 위치·단계를 확인한다. 도로 통제 시 현재 위치/예약을 유지한 채 보류한다. 도로 재개 후 담당자 복구 승인이 필요하다. 풍속 source 실패/낡음/혼합 기준일은 ETA를 불명으로 유지하고 신규 배차를 차단하며 기존 임무도 보류한다.
8. 거부 대상은 이장 연결 요청·수동 연락 결과를 기록한다. “숨쉬기 힘들어요”는 자동119 **모의 접수**이며 구조 완료가 아니다. 현재 별도 구급차 요청 큐와 모의 접수 실패 adapter는 미완료다.
9. 통신 두절 → 고정 방송 문안·전체 미해결/방문 인수인계 → 복구 → 담당자 인수인계 확인 → 기록 종료 snapshot·JSON·인쇄.

위 수동 순서는 보조 기능 점검용이다. 접힌 **정적 장면 점검**의5장면은 상태를 초기화하며 그 지도 미리보기는 운영 상태를 진행시키지 않는다. 메인 시연은 서버 권위 연속 실행으로 검증됐다. 최신 도메인165/165·브라우저 단독22/22·실제 HTTP 서버 결합2/2가 통과했다. 자동12×의 원문44가구/실제1 혼합4분 목표·30fps·지연 목표는 별도 미검증이다. 원본 fixture JSON에는 자동 타이머/상태 머신을 추가하지 않았다.

## 공용 API와 command 입력

모든 command는 `POST /api/command`의 `{action,input}` 형식이다. revision이 필요한 동작에는 바로 전 `GET /api/state` 또는 성공 응답의 최신 revision을 넣는다. 오래된 revision은409를 반환한다. 아래 ID는 응답의 실제 ID를 사용하며 승인 후보를 임의로 만들지 않는다.

| action                             | input                                                                                                   | 효과·검증 경계                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cycle-start`                      | `{revision,demoStory:"grandfather" 또는 "squad",phoneMode:"live",phoneConsent:true}`                    | 새 주연 시연·화재·합성 관측·미확정 계획 생성; live는 대상별 동의·설정 필요, 실제 활성/불명 전화가 있으면 차단                                                                                                                                                                     |
| `sim`                              | `{revision,playing?:true 또는 false,speed?:12 또는 30 또는 60}`                                         | 공용 재생/일시정지/배속; 확정 전·두절·종료 재생 차단. `POST /api/sim`에서도 동일 입력/인증 사용                                                                                                                                                                                   |
| `watch`                            | `{}`                                                                                                    | idle→watch·합성 감시·발신0                                                                                                                                                                                                                                                        |
| `plan`                             | `{}`                                                                                                    | watch→발령 제안·담당자 검토 대기                                                                                                                                                                                                                                                  |
| `reorder`                          | `{revision,ids:[전화 대상 전체 ID]}`                                                                    | 미확정 계획의 중복/누락 없는 순서만 변경                                                                                                                                                                                                                                          |
| `confirm`                          | `{revision}`                                                                                            | 최신 표시조건 재검증 보완 뒤 주민/조원 공용 큐·방문 요청·모의 문자 기록1회 생성; FE21/21·source Runtime/API25/25 통과                                                                                                                                                             |
| `advance`                          | `{}`                                                                                                    | 모의1분·호출결과/예약/임무 타임라인 진행; 두절/종료 상태 차단                                                                                                                                                                                                                     |
| `transcript`                       | `{id:"H001",text:"지금 이동 중이에요",eventId:"고유 합성 이벤트 ID"}`                                   | 발화 근거 재검증·중복1회·moving15/unclear5 모의 예약; 실제 전화 종단으로 취급하지 않음                                                                                                                                                                                            |
| `member-response`                  | `{callId:"응답 calls의 현재 모의 조원 통화 ID",outcome:"available" 또는 "unavailable" 또는 "noanswer"}` | 현재 모의 member 통화만 처리·무응답 추가2회 후 불가·자동 재배정 제안                                                                                                                                                                                                              |
| `schedule-callback`                | `{revision,id:"H001",minutes:5}`                                                                        | moving/unclear 대상의 기존 모의 예약 대체·1–60분; 실제 통화의 자동 후속 발신은 보류                                                                                                                                                                                               |
| `check`                            | `{id:"H009",source:"담당자",fields:["mobility"]}`                                                       | 실제로 확인한 합성 필드/출처/담당자 이력 추가·명시적 모의 확인일 갱신                                                                                                                                                                                                             |
| `notes-restructure`                | `{revision,id:"H001"}`                                                                                  | 원문/건강/현재 거동의 순수 규칙 제안·인용/unknown/estimated 보존·거동/기존+추가 장비 적용·취약도 재계산·확인일 유지·현재 배차 임무 수정 차단. Runtime4/4·FE 적용 검증 통과; 전체 지원필드/실모델 적용은 미완료                                                                    |
| `edit`                             | `{revision,id:"H001",mobility:"보조",consent:true}`                                                     | 거동/동의 편집·확인일 유지·대상/큐 재조정                                                                                                                                                                                                                                         |
| `family`                           | `{id:"H001",status:"입원" 또는 "시설 입소" 또는 "전출" 또는 "복귀"}`                                    | 임시제외/복귀·V와X 분리·오래된 예약 취소                                                                                                                                                                                                                                          |
| `companion`                        | `{revision,id:"H001",label:"가상 동반자",mobility:"자력",devices:[],companionId:"선택 고유 ID"}`        | 모의 동반자/거동/장비 저장·중복ID1회·최대8명; 실행 임무의 정원 변경 차단                                                                                                                                                                                                          |
| `dispatch`                         | `{id:"H001",vehicleId:"V01"}`                                                                           | 최신 장비/driver/crew/정원/대피소/ETA/경로 검증 후 원자 예약                                                                                                                                                                                                                      |
| `reassign-propose`                 | `{revision,id:"H001"}`                                                                                  | 인접조 거리→면차량→119지원 후보 제안; 일반 후보 승인 전 실행0                                                                                                                                                                                                                     |
| `reassign-approve`                 | `{revision,id:"reassignments의 pending 제안 ID",vehicleId:"후보 차량 ID 또는 null"}`                    | 담당자 승인·최신 조건 재검증 후 실행; null은 모의119 지원 요청                                                                                                                                                                                                                    |
| `reassign-reject`                  | `{revision,id:"pending 제안 ID"}`                                                                       | 담당자 반려·실행0·같은 자동 제안이 반려를 덮지 않음                                                                                                                                                                                                                               |
| `road-control`                     | `{revision,id:"data.map.roads의 도로 ID",blocked:true 또는 false}`                                      | 합성 도로 통제/해제·현재 임무 재검증·보류 시 예약 유지                                                                                                                                                                                                                            |
| `trip`                             | `{id:"trips의 현재 임무 ID",stage:"arrive" 또는 "boarded" 또는 "shelter" 또는 "return"}`                | 현재 임무의 다음 단계만 담당자 보고·도로/장비/인원/도착 조건 재검증                                                                                                                                                                                                               |
| `trip-resume`                      | `{revision,id:"heldReason이 있는 현재 임무 ID"}`                                                        | 담당자 복구 승인·경로/ETA/조원/장비 재검증·기존 예약 유지                                                                                                                                                                                                                         |
| `comms`                            | `{down:true 또는 false}`                                                                                | 신규 실행 보류/복구·기존 세션 유지·현지 긴급 보존                                                                                                                                                                                                                                 |
| `source-fail` / `collect`          | `{id:"소스 ID"}` / `{}`                                                                                 | simulated-live-failure record / 별도 own-schema replay append·관측 시각 불변·origin/mode/error/근거 보존; 실패 source는 새 fallback에도 정상으로 덮지 않음. 미확정 계획은 ETA/근거 조건 변화 때만 최신 재검토·무관 수집 수동 순서 유지 보완(FE21/21·source Runtime/API25/25 통과) |
| `leader-request` / `leader-result` | `{id:"H001"}` / `{id:"H001",result:"이동 확인" 또는 "방문 필요" 또는 "연락 불가"}`                      | 사람의 수동 연락 요청/결과·설득/이동 확인≠안전                                                                                                                                                                                                                                    |
| `visit-complete`                   | `{id:"방문 전용 가구 ID"}`                                                                              | 방문 모의 확인·전화 안전 분모와 분리                                                                                                                                                                                                                                              |
| `assistant`                        | `{text:"몇 집 남았나",revision}`                                                                        | 구역/현황/동적 자원·미확정1순위·명시적 통신 두절/복구. 순위 변경은 최신 revision 필요. 질문/부정/복합·무효 명령은 상태 무변경; 확정/이장/재배정은 사람 버튼                                                                                                                       |
| `review-graph`                     | `{id:"waiting인 전사 graphRuns ID"}`                                                                    | 서버 전사 검토 checkpoint 재개·새 도착 근거 없이 안전 처리하지 않음                                                                                                                                                                                                               |
| `close`                            | `{acknowledged:true}`                                                                                   | 전체 미해결 인수인계 확인·새 작업 차단·종료 snapshot; 실제 활성/불명 통화는 종료 차단                                                                                                                                                                                             |
| `scenario`                         | `{id:"idle" 또는 "watch" 또는 "review" 또는 "active" 또는 "late"}`                                      | 정적 합성 장면으로 초기화; 실제 열린 세션이 있으면 차단                                                                                                                                                                                                                           |

| 경로                         | 현재 기능                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/state`             | 공용 `simulation`·`simMinutes`·주연 `demonstration`·데이터·scenario·revision·계획·calls·trips/completedTrips·shelterAdmissions·reassignments·handoffs·firstPass·records·graphRuns·sourceState의 append 근거/policies/actualModelCalls0; 재시작 구분 `x-onmaul-instance` header |
| `GET /api/health`            | 실행 모드·LangGraph·phoneEnabled; demo는 외부 모델 호출0, 음성 활성화 모드는 미계측을 null로 표시                                                                                                                                                                              |
| `GET /api/export.json`       | 현재 또는 종료 View·합성 근거·전사·예약; 환경 key/실번호/원 provider payload 없음                                                                                                                                                                                              |
| `POST /api/telephony/dial`   | `{targetId:"H012" 또는 "M01",targetType:"resident" 또는 "member",consent:true,revision}`·공용8/allowlist/동의/확정 검사. demo는 외부 실행0                                                                                                                                     |
| `GET /api/telephony/state`   | 기존 request/provider ID·생성/응답/종료 상태·음성 엔진 활성화 여부; 전사 이력은 `/api/phone/state`                                                                                                                                                                             |
| `POST /api/telephony/hangup` | `{requestId}`·기존 provider ID에 종료 요청; 요청은 종료 확인이 아님                                                                                                                                                                                                            |
| `POST /api/telnyx/webhook`   | raw body Ed25519·120초 시각 허용·이벤트 중복 방지·서명된 hangup에서만 실제 슬롯 해제                                                                                                                                                                                           |

## 실제 LangGraph와 복구의 범위

`@langchain/langgraph`1.4.21을 실제 사용한다. 서버의 계획 그래프는 snapshot→데모 ETA/순위→ID/rank 검증→담당자 `interrupt`→동일 checkpoint `Command({resume})`→승인 제안이다. source ETA/근거 조건 변화는 기존 계획 checkpoint를 supersede하고 최신 검토 checkpoint를 만드는 보완을 추가했으며 FE21/21·source Runtime/API 집중25/25 회귀를 통과했다. 전사 그래프는 정규화→규칙 분류→strict 스키마/인용 검증→응급 자동 제안 또는 사람 검토→결과다. 재배정은 검증 후보 snapshot→담당자 `interrupt`→승인/반려 `resume`→현재 조건 재검증 결과를 기록한다. 전화/배차는 그래프 밖 공용 Runtime이 한 번만 적용한다.

계획·배차·모의 전사 그래프는 명시적 `rules` 경로다. 활성화된 실전화는 기존 PoC의 GPT 음성·백엔드 판정을 사용하며, 이번 자동 검증은 주입한 전송 경로를 사용해 외부 모델 호출0으로 실행했다. 브라우저 단독은 local rules 모드다. 감시/명단/방송/도우미의 전체 추론그래프는 후속 구현 대상이다. `MemorySaver`는 프로세스 메모리 checkpoint다. 상태 JSON 복원은 durable graph checkpoint를 대신하지 않는다. 미확정 계획은 재시작 때 새 검토 그래프로 만들고 실제 요청은 불명 상태로 보존한다.

합성 도로의 로컬 접근은 개방 도로까지≤250px인 경우만 연결하는 명시적 데모 가정이다. 실제 도로·주행 안전 또는 구조 성공을 입증하지 않는다. 메인 map 위치는 서버의 예약한3구간 경로/시각과 제한된 화면 보간을 사용한다. 실제 HTTP 결합 검증은 차량 좌표 변화와 주민/대원 상태·동일 임무 입소를 확인했다. 30fps 성능 측정과 바람 변경 누적 ETA는 미완료다.

## Telnyx 설정과 실검증 경계

`server/.env.example`을 참고한다. hybrid에는 API key·Call Control Application ID·E.164 발신번호·32byte 공개 Ed25519키·HTTPS webhook URL·32자 이상 담당자 토큰이 필요하다. 기존 `/api/telephony` 경로는 환경변수 `REAL_RESIDENT_E164`/`REAL_SQUAD_E164`와 각각의 동의 플래그 `yes`로 주민H012·조원M01만 허용한다. 음성 엔진이 활성화되면 이 기존 발신 경로를 차단하고, 두 대상 H012/M01만 지원하는 `/api/phone` 경로를 사용한다. HTTP 요청의 `Authorization: Bearer` 토큰은 저장소에 기록하지 않는다.

Telnyx SDK 재시도는0이다. 생성 실패/불명은 요청ID·provider ID·채널을 유지한다. 벨30초/응답후120초 타이머는 시뮬 시계와 분리한다. 실제 전사 결과 또는 hangup 요청만으로 종료됐다고 처리하지 않고 서명된 전화망 종단을 확인한다.

기존 `/api/telephony/*` 경로는 call-control 범위이며, 음성 엔진 활성화 시 발신은 `/api/phone/dial`로 안내한다. 새 전화 경로의 양방향 음성·전사 저장/복원·최종 종료 후 구조 연동은 주입한 모델/전화 전송과 로컬 WebSocket으로 검증했다. 실제 한국 휴대폰 수신과 음질은 실제 수신 리허설에서 확인해야 한다. 음성 녹음 보관, 실제119/SMS adapter는 이번 통합 범위 밖이며 모의119는 합성 접수다.

## 검증

```sh
npm test
npm run build
npm run test:e2e
npm run test:e2e:server -w fe
npm run check:skills
npm audit --omit=dev
```

실제 실행 결과와 미완료 항목은 [implementation-status.md](implementation-status.md), 요구별 근거는 [requirements-verification.md](requirements-verification.md)를 따른다. 명령 존재를 통과 증거로 쓰지 않고 모의 테스트 성공을 실전화/모델/외부API 성공으로 해석하지 않는다.
