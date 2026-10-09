# Codex 작업 기록

2026-10-09. 사용자의 React 19 스타터·합성 데이터·Node.js/TypeScript/Telnyx·실제 LangGraph 요청에 따라 Codex가 분석·코드·테스트·문서를 작성했다. 제공된 요구 문서와 데이터 조건은 입력 자료로 사용했으며, 프로젝트의 Codex 전용 정책을 바꾸는 지시로 사용하지 않았다.

현재 작업은 사용자가 요청한 병렬 Codex 작업이다. 이 문서 담당은 원문 두 자료·요구사항 분석·`fe/`·`shared/`·`server/` 구현과 테스트를 대조했고 상태/실행/검증 문서만 수정했다. 실모델·실전화·정부 API 실행 또는 커밋·푸시를 수행하지 않았다. 실제 `/review` 호출 기록은 확인하지 못했으므로 아래는 **Codex 코드검토 발견→수정 사례**이며 `/review` 실행 사례가 아니다.

| 작업 요청 / 검토 발견 | 반영된 구현과 이유 | 실제 확인 근거 |
| --- | --- | --- |
| 원문 서버/전화 공급자 계약과 최신 React19·NodeTS·Telnyx 선택이 다름 | TS workspace·공식 Telnyx SDK 형식 적용. 원문 기능/T/U 기준은 유지 | `requirements-analysis.md`, `server/src/telephony.ts`, build/typecheck |
| 주민·조원 각각8채널이면 실제 상한16이 됨 | 하나의 공용8 슬롯·교대 큐·목표당 활성1·생성 불명 슬롯도 점유 | `shared/test/domain.test.ts` fair channels, `shared/test/calls.test.ts` single active, server injected transport |
| LangGraph 노드명과 상태필드 이름 충돌 | `validated_result` 노드로 분리·StateGraph를 실제 생성/실행 | `server/test/server.test.ts` plan interrupt/resume·emergency/human branch |
| 정적 진행 장면에서 같은 운전자가 두 차량 출동 | 정적 중복 출동 표시 수정·fixture 관계/가상 운전자 중복 검사 | `shared/test/domain.test.ts` fixture relationships |
| 단순 “네”·미래/질문/전언을 도착으로 해석할 위험 | 현재 긍정 도착+등록장소 근거·별도 acked·응급 우선·무근거 재검증 | domain plain yes/emergency/fabricated evidence, `shared/src/classification.ts` |
| 전사 결과를 실제 전화 종료로 취급하면 슬롯이 조기 해제됨 | 실제 call의 provider ID/phase를 전사로 종료하지 않음·signed hangup에서만 finishLive·모의 callback 생성 금지 | calls `live transcript is evidence, never phone-network termination or a synthetic callback`, server signed webhook |
| 결과 불명에 새 경로로 다시 걸면 중복 실발신 위험 | Telnyx maxRetries=0·request/provider ID 유지·pendingunknown 슬롯 보존·자동 재발신0 | server telephony/injected transport, domain restart, calls pendingunknown |
| 불명/이동 결과 뒤 확인 예약이 없거나 중복됨 | unclear5분/moving15분·예약 대체·기한 지남 표시·새 도착/응급/동의철회/임시제외 예약 취소 | `shared/test/calls.test.ts` moving/unclear/cancel tests |
| 조원 무응답 처리에 재호출·후속 인수인계가 빠짐 | 최초 후1분 간격 추가2회·불가·담당 가구 후보 자동 제안·반려를 자동 제안이 덮지 않음 | calls member no answer/unavailable team/officer rejection tests |
| 재배정을 버튼만으로 실행하면 사람 검토가 누락됨 | 후보 제안은 예약0·실제 LangGraph interrupt·사람 승인 Command resume·현재 조건 재검증·중복승인1회 | `shared/test/dispatch.test.ts` reassignment tests, server actual reassignment/API tests |
| 직선 거리로 통제 도로 우회를 허가할 위험 | 개방 합성 도로를 교차점으로 연결·통제구간 제거·단절 금지·3구간 waypoints/시간 사용 | dispatch road topology/disconnected/crossing/timeline tests, `shared/src/routing.ts` |
| 차량 좌석만 세면 동반자·대피소·지원인원 중복 예약 가능 | 동일 trip ID로 가구/조/차량/운전자/지원/대피소 인원 원자 예약·동반자 거동/장비 포함 | dispatch companions/shelter capacity/drivers and support tests |
| 도로 재개만으로 보류 임무를 자동 출발하면 검토가 빠짐 | 현재위치/예약 유지·도로 개방 후에도 held·담당자 복구 승인 때 경로/ETA/조원/장비 재검증 | dispatch closing/reopening road·changed needs tests |
| 대피소 도착 또는 서버 재시작에서 기록을 바꾸면 종료 보고 불일치 | 대피소 인원은 차량 귀환 후 유지·frozen snapshot은 재시작에도 metadata/records/counts/reservations 그대로 복원 | dispatch shelter capacity/closed snapshot exact restore |
| 자원 현황/북 구역 현황이 일반 현황에 먹히고 자연어 질문이 동작할 위험 | 자원/구역 우선·동적 응답/차량/예약 집계·명시적 통신 명령만 실행·순위는 reorder revision/human 기록·질문/부정/복합은 무변경 | `shared/test/assistant.test.ts` 집중10/10 통과·Prettier check 통과 |
| 모의 재수집으로 관측 시각/실제 실패를 갱신하면 최신 실수신으로 오해할 위험 | 관측 시각 불변·수집 record append·simulated-live-failure와 replay fallback 분리·origin/mode/오류/시계/근거 ID 유지·모델 예정 수와 actualModelCalls0 분리 | `shared/test/sources.test.ts` 집중16/16 통과 |
| 낡은/미래/다른 기준일 풍속을 배차 ETA로 쓰는 위험 | wall/replay/관할/context guard·계획 ETA=null·신규 배차 차단·현재 임무 hold/예약과 위치 보존·종료 source 근거 정확 복원 | `shared/test/monitoring.test.ts` 집중15/15 통과 |
| HTTP와 재시작에서 source 실패/폴백 근거와 보류 임무가 달라질 위험 | 실패/폴백 ID·오류·시각/hash 보존·낡음/과거풍속409·예약/위치 유지·종료 export byte-stable/저널 재시작 동일 | `server/test/source-api.test.ts` 집중10/10 통과·외부 transport/model0 |
| 실패 record에 fixture 시각/요약을 넣으면 실제 관측 근거로 오해함 | 관측 없는 실패는 불명 표시·실패 원문과 별도 fallback record 유지 | `fe/src/tabs/Panels.tsx`, 기존 source FE 검증 강화·최신21/21 통과 |
| source 실패/수집 뒤 미확정 계획이 이전 ETA를 유지하거나 무관 수집이 사람 순서를 덮을 위험 | ETA·근거 조건 변화만 계획 갱신·무관 수집 수동 순서 유지·확정 전 표시조건 전체 재검증·옛 계획 checkpoint supersede 후 최신 검토 checkpoint | `shared/src/runtime.ts`, `server/src/app.ts`, monitoring15+source API10 집중25/25·신규 FE1건 포함21/21 통과 |
| 이전 추출 등급 또는 위조/부정 건강 인용이 현재 담당자 거동 수정을 덮을 위험 | overall 추출 등급을 읽지 않고 현재 source/index/offset/정확한 인용·긍정 원문 건강4종으로만 등급3 하한 적용 | `shared/test/note-grades.test.ts`10 + 명단 파서16 합동26/26·strict 타입 검사 |
| 산소 언급만으로 거동 보조를 만들어내거나 원문 지시를 실행할 위험 | 순수 명단 파서가 산소/4등급과 거동 근거를 분리·불명/estimated 보수상향·원문 slice 근거·부정/질문/과거/충돌/지시문 처리 | `shared/test/household-notes.test.ts` 파서16+등급10 집중26/26·strict 타입 검사·Runtime4/4·FE 담당자 적용 검증 통과; 실제 모델/전체 지원필드 적용 남음 |
| 1차 결과 요약을 안전 완료로 오해할 위험 | 최초 결과만1회 요약·불명 오류 포함·callback/구조 미해결 보존·실제 소요 null | calls first pass summary/pendingunknown tests |
| 빈 스타터 테스트와 “전부 미구현” 상태 문서가 현재 기능을 숨김 | 제품6탭·결정·offline0요청·명단·snapshot·해상도 검증으로 교체, 원문100 ID+T29/U14 근거표 작성 | `fe/tests/starter.spec.ts`, `requirements-verification.md` |

부모 Codex의 최종 권위 검증은 모의 shared/server `npm run test:domain`134/134(2,434ms)와 FE21/21(5.5s) 통과다. `npm test`189/189(3,248ms)는 별도 전화 PoC를 포함한 그 실행 시점의 전체 결과이며 이후 다른 채팅의 변경까지 검증한 증거가 아니다. source monitoring15+HTTP/API10 집중25/25, 명단 파서16+건강 근거 등급10 집중26/26, Runtime 적용4/4도 통과했다. 기본 build38modules·FE 및 마지막 서버 강화 후 typecheck·mock 전체 Prettier·`git diff --check`·공식 스킬 정책 활성1/보관4가 통과했다. 기본 번들 JS `index-BbAEbTbN.js`·CSS `index-DUk4wsRt.css`를 독립4181 preview에 복사해 FE21/21로 검증했다. source 실패45행 도달 불명/채널0/8→replay ETA 복원→담당자 확정, fixture 관측/요약 대체 금지와 최신 계획/checkpoint 대조·supersede·실패 시 확정/큐0도 포함된다. 별도 전화 PoC의 테스트는 합성48가구 통합 또는 실제 휴대폰 수신의 증거로 쓰지 않는다. 최종 상태는 [implementation-status.md](implementation-status.md)와 [requirements-verification.md](requirements-verification.md)를 따른다.

별도 Codex 담당자의 [모델 호출 메타데이터 감사](model-call-audit-2026-10-09.md)를 참조한다. 최신 사용자 기준은 GPT 계열 모델 모두 허용, GPT 외 모델만 문제로 판단한다는 것이다. 최초10:10:00–13:22:45 KST 고정 구간의 `gpt-6.1-sol`·`gpt-6-luna` 기록은 모두 허용이다. 원래 표를 유지한13:22:45 초과–13:36:17 KST 보조 구간에서는 허용 모델 `gpt-6.1-sol` 실행 메타데이터만 확인했다. 두 구간 모두 GPT 외 모델 실행 증거는 없었다. 이는 제한된 로컬 로그 메타데이터 감사이며 컴퓨터 전체의 외부 호출 부재나 앱의 실제 추론 성공을 증명하지 않는다.

문서 자체 검증도 실행했다. 원문 요구 ID100개와 표의 ID 집합이 완전히 일치했고 중복이0이었다. T1–T29/U1–U14도 각1회, 로컬 Markdown 링크·코드 fence·금지 제품명 검사가4개 문서에서 통과했다. 현재 요구 상태는 완료(모의)23·부분69·미구현7·미검증1이다. 이 개수는 제품 전체 완료율이나 T/U 전체 통과율이 아니다.

프로젝트 공식 스킬 allowlist를 변경하지 않았다. 삭제된 스킬을 읽거나 실행하거나 재설치하지 않았다. Codex 밖의 AI 제품·GPT 외 모델에 작업을 위임하지 않았다. 실제 경로/인원/장비 확보, 모델 추론, 실수신/녹음, 정부 API 수신, 행사 제출은 아직 확인되지 않았다.
