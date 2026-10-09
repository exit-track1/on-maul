# 온 마을 전화 PoC 실행 안내

2026-10-09 · Node.js 24 · Telnyx Call Control + OpenAI Live

이 구현은 요청 명세에서 새로 작성했습니다. 이전에 클론한 참조 저장소와 그 저장소에서 가져온 소스·문서·음성 fixture는 삭제했습니다. 기존 작업 공간의 React 상황실, 합성 데이터, mock API는 보존했습니다.

## 실행

프로젝트 루트에서 실행합니다.

```sh
cp .env.example .env
# .env에 본인 계정 값을 입력하거나 시작 후 웹 설정에서 저장
npm ci
npm run check
npm test
npm run format:check
npm start
```

| 주소                           | 기능                                             |
| ------------------------------ | ------------------------------------------------ |
| `http://localhost:8787/telnyx` | 저장한 한국 휴대전화 한 대에 실제 테스트 발신    |
| `http://localhost:8787/voice`  | 실제 WebRTC 마이크·스피커 수신 체험              |
| `http://localhost:8787/`       | 48가구·8개 대기조·6대 차량의 가상 상황실         |
| `127.0.0.1:8788`               | 공개 연결용 콜백 서버. 관리 화면은 제공하지 않음 |

기존 React mock 상황실은 `npm run dev`로 실행합니다. React 주소는 5173, mock API는 8090입니다. 두 구현은 별도 화면과 상태 저장소를 사용합니다. `npm start`의 상황실은 실제 음성 연결을 위한 독립 화면입니다.

## 필요한 계정과 공개 연결

- OpenAI API 키, 사용 가능한 `gpt-live-1`, `gpt-6.1-sol` 모델 접근권한과 결제 설정.
- Telnyx 유효 API 키, 활성 Voice API 앱 ID, 연결된 활성 Outbound Voice Profile, `KR` 목적지 허용, 사용할 수 있는 발신번호, Ed25519 웹훅 공개키.
- 수신에 동의한 한국 `010` 휴대전화 한 대. 발신번호와 수신번호는 달라야 합니다.
- 콜백 포트 8788에 연결되는 공개 HTTPS/WSS 주소. Cloudflare Quick Tunnel, ngrok 또는 인프라에서 준비한 공개 도메인을 사용합니다.

OpenAI 직접 SIP 발신 권한과 SIP 사용자명·비밀번호는 필요하지 않습니다. 모델 접근 조회, 음성 세션 준비, Telnyx 발신 접수, 실제 수신 응답, 미디어 시작은 별개입니다. 설정 조회만으로 통화 성공을 표시하지 않습니다.

Cloudflare 실행파일은 `CLOUDFLARED_PATH`, `.tools/cloudflared`, PATH 순으로 찾습니다. 실행파일을 직접 준비한 뒤 화면의 **공개 연결 시작**을 누릅니다. 자동 다운로드는 하지 않습니다. ngrok 사용 시 다음처럼 콜백 포트만 연결하고 반환된 HTTPS 주소를 `PUBLIC_BASE_URL`에 저장합니다.

```sh
ngrok http 8788
```

8787 관리 포트를 공개 터널에 연결하지 마세요. 새 공개 주소는 다음 발신의 `/webhooks/telnyx`와 통화별 `/media/<token>`에 사용합니다. 발신 전에 공개 콜백 probe를 실행합니다.

## 설정과 사용 흐름

로컬은 `ON_PHONE_ENV=local`로 `.phone/.env`를 읽습니다. 이 복사본에는 인프라 파일의 계정 키·번호를 유지하고 `PUBLIC_BASE_URL`을 비워뒀습니다. **공개 연결 시작**으로 Mac의 콜백 8788에 연결된 임시 URL을 만들어 로컬 설정에 저장합니다. 비어 있지 않은 환경변수 URL은 로컬 저장값보다 우선하므로, 환경 파일에 배포 URL이 남아 있으면 터널 시작을 차단하고 수정 방법을 안내합니다.

배포는 `ON_PHONE_ENV=deployment` 또는 `NODE_ENV=production`에서 `.phone/.env`를 읽지 않습니다. `ON_ENV_FILE`로 지정한 배포 런타임 파일, 지정하지 않았다면 루트 `.env`를 읽습니다. 배포용 예제는 `infrastructure/phone.runtime.env.example`입니다. 배포 도메인의 `/probe/`, `/webhooks/telnyx`, `/media/`는 해당 배포 호스트의 콜백 8788로 연결해야 합니다. 기존 React mock 서버 8090의 URL만으로 전화 브리지 콜백이 제공되지는 않습니다.

```sh
# 로컬
npm start
# 배포 호스트에서 전화 브리지 런타임 파일을 명시
ON_PHONE_ENV=deployment ON_ENV_FILE=/etc/onmaul/phone.runtime.env npm start
```

`ON_ENV_FILE`을 명시하면 해당 파일이 우선합니다. 검사 스크립트도 같은 선택 규칙을 사용합니다. 루트 인프라 `.env`는 보존하며 원본 변경은 로컬 복사본에 자동 동기화하지 않습니다. 두 환경 파일을 섞어 읽지 않습니다. 로컬 터널은 종료·재시작하면 주소가 달라지므로 다음 실행에서 다시 공개 연결을 시작하세요.

우선순위는 비어 있지 않은 환경변수, 로컬 저장 설정, 기본값 순입니다. 프로세스 환경변수가 선택한 환경 파일보다 우선합니다. 환경 파일 변경은 재시작 후 반영합니다. 화면에서 API 키 입력을 비워 저장하면 기존 키를 유지하며, **저장된 비밀값 삭제**로 명시적으로 삭제합니다. 환경변수에서 제공한 키는 화면에서 삭제할 수 없습니다.

기본 모델은 Live `gpt-live-1`, 주민 응답·완료 분류와 브라우저 Responses 위임 `gpt-6.1-sol`, 계획 모델 접근 확인 `gpt-6.1-sol`, 음성 `marin`입니다. 주민 전화는 앱이 client delegation으로 발화 순서를 관리하고, 각 응답의 위치·이동·몸 상태·대피 거부를 `gpt-6.1-sol` Responses의 strict JSON Schema로 분류합니다. 사실별 최신 원문 근거와 0.9 이상의 신뢰도를 확인합니다. 분류 실패는 구조 필요로 추정하지 않습니다. 실제 요청에는 저장된 모델 ID를 사용하고 대체 모델로 우회하지 않습니다. 가상 상황실의 우선순위 제안은 규칙 기반입니다.

1. 설정을 저장하고 모델 접근, 공개 연결, 음성·Telnyx 연결을 확인합니다. 연결 확인은 짧은 Live 세션을 열 수 있어 요금이 발생할 수 있습니다. **공개 콜백만 재검사**는 OpenAI·Telnyx API를 호출하지 않습니다. 화면에서 공개 콜백·음성/Telnyx·저장 여부·동의·활성 통화 중 어떤 조건이 발신을 막는지 표시합니다.
2. 주민 또는 대기조를 선택하고 수신 동의를 체크한 뒤 **실제 테스트 발신**을 직접 누릅니다.
3. OpenAI 준비 확인 후 Telnyx 발신을 한 번 보냅니다. 수신 전에는 20ms PCMU 무음을 공급합니다.
4. 서명된 수신 응답과 검증된 미디어 시작을 모두 확인한 뒤 산불 대피 안내와 지정 대피소 이동 가능 여부로 시작합니다. 테스트 안내·안내 이해 확인은 음성에서 생략하고 수신 동의와 가상 시나리오 설명은 화면에 유지합니다.
5. 첫 질문 “현재 산불로 인하여 대피하셔야 합니다. 온빛 배움학교로 이동 가능하십니까?”의 음성과 전사를 발신 전에 준비하고, 서명된 수신 응답 2초 후 검증된 미디어 연결로 재생합니다. 준비 실패 시 발신하지 않습니다. “여보세요”는 위치 답변으로 받지 않습니다. 필요한 몸 상태 확인을 이어갑니다. 첫 질문의 목적지는 등록 대피소 이름으로 채웁니다. 연결 가구는 배정된 열린 대피소를, 단독 전화는 등록된 열린 학교 대피소를 우선 사용합니다. 몸 상태만 답하면 이동 가능 여부를 다시 확인합니다. 건강·이동 가능은 “지금 즉시 대피해주십시오.”, 이동 수단 없음·신체 사유로 이동 불가는 “구조대를 보내드리겠습니다.”, 집을 떠날 수 없음·대피 거부는 “이장님께서 전화하실 겁니다.”로 마칩니다. 모호함은 담당자 재확인으로 남깁니다. 결과와 근거를 먼저 저장하고 종료 안내의 실제 오디오 뒤 고유 mark를 확인한 후 hangup을 한 번 요청합니다. 현재 대피 완료 자기 신고는 별도 검증을 유지합니다.
6. hangup 요청 성공 후에도 서명된 최종 종료 이벤트를 기다립니다. 결과가 불명확하면 `unknown` 잠금을 유지합니다. Telnyx에서 실제 종료를 확인한 뒤 화면에 종료 확인을 기록합니다.

대피 완료 신고 정정은 기록을 `needs_review`로 보존하고 자동 재생 확인을 취소합니다. 주민 전화는 서명된 수신 응답부터 45초에 미완료 응답을 담당자 재확인 요청으로 저장하고 마무리를 시작합니다. 60초에 종료를 요청하며 실제 통신사 종료는 별도로 확인합니다. 통신사·준비 단계의 안전 제한은 요청 시작부터 기본 240초, 설정 범위 30~600초입니다. 이것은 대화를 4분 동안 진행하라는 설정이 아닙니다. 서버 재시작은 활성 통화를 자동 복구하거나 재발신하지 않습니다.

출력 음성은 120ms 버퍼 후 최대 60ms PCMU 패킷으로 Telnyx 재생 큐에 보냅니다. 20ms 프레임보다 짧은 조각은 모아서 보내며 중간에 무음을 삽입하지 않습니다. 입력은 20ms PCMU를 유지합니다. 회선 잡음·에코의 RMS만으로 출력 큐를 지우지 않고 인증된 사용자 전사를 받아 발화 중단을 처리합니다. Live의 무음 출력은 종료 안내의 mark 대기 시간을 재설정하지 않습니다. 화면에 버퍼·고갈 횟수를 표시합니다.

## 상황실과 브라우저 음성

상황실은 감시, 대응 순서 제안, 담당자 승인, 모의 다중 연락·SMS·재시도, 가구·대기조 상태, 모의 배차 단계, 판단 근거와 감사 기록·인수인계 JSON을 제공합니다. 주민 모의 재시도는 최대 5회, 대기조는 3회입니다. 모의 연락은 실제 발신을 예약하지 않습니다. 119·이장 인계와 배차는 모의 기록입니다.

상황실에서 준비한 `callId`는 서버가 대상·동의·연결 상태를 검증합니다. 실제 주민 전화는 독립 완료 판단을 중복 실행하지 않습니다. LangGraph가 인증된 전사와 근거를 확인하고 등록된 열린 대피소·정원·긴급 상태를 검증해 가구의 `safe`를 저장한 뒤 전화 종료 절차를 시작합니다. `safe`는 현장 확인이 아닌 수신자 자기 신고입니다. 분류가 모호하면 담당자 재확인 대상으로 기록합니다.

구조·즉시 대피 안내·이장 연락·재확인 요청은 최종 통화 종료 후 상황실 `followUps`에 통화 ID별 1회 생성합니다. 연결한 가구는 각각 `help`, `moving`, `refused`, `unknown`으로 기록하고, 단독 전화는 가구를 임의 선택하지 않고 담당자 배정 대기로 남깁니다. 서버 재시작 때 저장된 종료 결과를 재처리해 누락을 복원하며 중복 요청을 만들지 않습니다. 실제 출동은 수행하지 않고 기존 모의 배차 절차로 이어집니다.

브라우저 `/voice`는 WebRTC SDP로 실제 Live 세션을 만들고 서버의 인증된 sideband 전사만 판단에 사용합니다. 브라우저가 임의 POST한 전사는 전송 시험 자료로 반환하며 안전 판단에 쓰지 않습니다. 브라우저 음성에 주민 전화의 자동 hangup을 적용하지 않습니다. 실제 전화와 브라우저 음성은 합쳐 한 건만 허용합니다.

녹음은 수신 화면에서 별도로 선택한 경우에만 마이크·상대 음성을 로컬에 저장합니다. 브라우저를 갑자기 닫으면 녹음 업로드가 완료되지 않을 수 있습니다. 녹음하지 않을 때 전체 전사는 메모리에서만 표시합니다. 완료 원문 근거와 정정 문장은 별도 영구 기록입니다.

## 파일과 API

주요 모듈은 `src/server.ts`(경로·서비스), `src/calls.ts`(통화 상태·완료·종료), `src/media.ts`(PCMU·jitter·큐·clear·mark), `src/live.ts`(Live·응답 재개), `src/resident-classifier.ts`(응답 분류), `src/resident-flow.ts`(질문과 종료 분기), `src/evacuation.ts`(완료 신고 분류), `src/call-outcomes.ts`(완료 저장), `src/disaster.ts`(상황실·LangGraph), `src/voice-demo.ts`(WebRTC sideband)입니다. 설정·환경·프로세스 잠금·HTTP 보호·터널·서명 검증은 각각 별도 모듈로 나눴습니다. 화면은 `public/`, 비용 없는 검사는 `tests/`에 있습니다.

| 경로                                                                         | 동작                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------- |
| GET `/api/bootstrap`, `/api/health`                                          | 비밀값 없는 설정·상태와 로컬 동작 확인      |
| GET `/api/events`, `/api/calls/outcomes`                                     | 전화 SSE·최근 완료 50개                     |
| POST `/api/config`, `/api/models/check`, `/api/connection/check`             | 설정 저장·모델/연결 확인                    |
| POST `/api/tunnel/start`, `/api/tunnel/stop`                                 | 콜백 공개 연결 시작·중단                    |
| POST `/api/callback/check`                                                   | 공개 콜백만 재검사. 음성·발신 API 호출 없음 |
| POST `/api/calls`, `/api/calls/hangup`, `/api/calls/resolve`                 | 동의 발신·종료·불명 상태 수동 확인          |
| POST `/api/voice/session`, `/api/voice/ready`, `/api/voice/heartbeat`        | WebRTC 생성·안내 시작·활성 확인             |
| POST `/api/voice/hangup`, `/api/voice/resolve`, `/api/recordings`            | 브라우저 음성 종료·불명 확인·선택 녹음      |
| GET `/api/voice/events`, `/api/voice/state`                                  | 인증된 브라우저 음성 SSE·상태               |
| GET `/api/disaster/state`, `/api/disaster/export`                            | 가상 상황실 상태·인수인계                   |
| POST `/api/disaster/<command>`, `/api/disaster/call`, `/api/disaster/cancel` | 모의 명령·연결 준비·취소                    |
| 콜백 POST `/webhooks/telnyx`, WSS `/media/<token>`                           | Ed25519 웹훅·통화별 PCMU 미디어             |

로컬 POST에는 bootstrap의 토큰을 `X-ON-Token`으로 전달합니다. Host·Origin·cross-site·CSRF를 검사하며 콜백 서버에서는 관리 API가 404입니다. 웹훅은 원문 서명·타임스탬프 5분·통화 식별값·중복 이벤트를 검증합니다.

데이터 기본 경로는 `.data/`입니다. 별도 `ON_LOCAL_DATA_DIR`은 저장소 밖의 절대 경로를 권장합니다. 디렉터리는 `0700`, 설정·기록·녹음 파일은 `0600`, 임시 파일 후 rename으로 저장합니다. 완료는 `call-outcomes/<uuid>.json`, 설정은 `settings.json`, 불명 상태 복원에는 `active-call.json`·`active-voice.json`, 상황실은 `control-room.json`을 사용합니다. Git에 실제 키·번호·녹음·로컬 기록을 추가하지 마세요.

## 검증 범위

`npm ci`, `npm run check`, `npm test`, `npm run format:check`로 재현합니다. 테스트는 fetch·WebSocket을 주입하며 유료 OpenAI/Telnyx API를 호출하지 않습니다. OpenAI 준비 실패 시 발신 0회, 정상 발신 1회, 무음·미디어 순서, 완료 저장·실제 오디오 큐 이후 mark·hangup, clear/정정/낡은 판단, 종료 불명 잠금·복원, 서명·로컬 HTTP, 설정 우선순위·권한, LangGraph·기존 도메인 회귀를 검사합니다.

실제 API 검사 스크립트는 사용자 요청 시에만 실행합니다. 아래 명령은 **유료 검사 예시**이며 자동 검증에 포함하지 않습니다.

```sh
node scripts/check-voice-api.ts --run
node scripts/check-disaster-api.ts --run
node scripts/check-live-classification.ts --run --audio /absolute/path/sample.pcmu --source synthetic
# 직접 마이크로 녹음한 raw PCMU 파일은 --source microphone_recording 사용
```

API 검사 결과에는 설정 모델, 합성/마이크 녹음 구분, 실제 Telnyx 발신·mark 미검증 여부를 남깁니다. WebSocket 파일 입력 검사는 실시간 마이크·WebRTC 수신 테스트와 다릅니다.

2026-10-09 환경 분리 후 실제 연결 검사에서 Telnyx 활성 앱·연결 프로필·KR 목적지 허용, Live `session.started`, 로컬 임시 URL의 현재 콜백 확인 응답 HTTP 200을 확인했습니다. 공개 URL의 관리·설정 경로가 HTTP 404인 것도 확인했습니다. 에이전트가 실제 전화 발신 버튼을 누르지는 않았습니다. 이후 사용자가 수행한 통화의 로컬 기록에서 수신 응답 후 약 75초에 `Responses handoff incomplete` 오류와 종료를 확인했습니다. 이 기록에 따라 주민 전화는 client delegation과 앱 진행 단계로 변경했고, 출력 버퍼·무음 mark 회귀 테스트를 추가했습니다. 변경 후 휴대전화 음질·실제 대화·통신사 mark는 아직 재검증하지 않았습니다. 실제 전화 검증은 운영자의 동의 발신 버튼으로 수행해야 합니다.

API 계약은 [OpenAI Live WebSocket](https://developers.openai.com/api/docs/guides/voice-websockets?api=live), [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [서버 sideband](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live), [Telnyx media streaming](https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming), [Outbound Voice Profile 조회](https://developers.telnyx.com/api-reference/outbound-voice-profiles/retrieve-an-outbound-voice-profile)를 확인했습니다. Live에는 audio-done 이벤트를 가정하지 않고 Telnyx 큐와 mark를 사용합니다.

### 2026-10-09 통화 분기 검증

실제 OpenAI API를 사용하는 `node scripts/check-resident-classification.ts --run`은 가상 텍스트 6종에서 이동 가능·이동 불가·대피 거부·몸 상태만의 응답·목적지 질문을 분류합니다. `node scripts/check-phone-greeting.ts --run`은 무음 입력만으로 첫 질문 음성 생성과 지시 수락을 확인합니다. `node scripts/check-phone-opening.ts --run`은 실제 Live 음성 생성과 로컬 재생 브리지를 사용해 수신 이벤트 2초 후 첫 음성 패킷을 검증합니다. 세 검사는 OpenAI API 요금이 발생하며 Telnyx 실제 발신을 수행하지 않습니다. 국제전화 안내 종료 시점이나 실제 휴대전화 재생은 별도 검증 대상입니다.

2026-10-09 지연 조정: 주민 응답 분류는 `reasoning.effort=low`를 명시합니다. 입력 전사 대기는 900ms에서 180ms로, 입력 음성 종료 감지는 무음 300ms에서 160ms로 줄였습니다. 모델 응답은 짧은 필드와 공통 원문 인용 하나로 받아 내부의 사실별 근거로 검증합니다. 첫 질문은 위치 대신 산불 대피소 이동 가능 여부입니다.
