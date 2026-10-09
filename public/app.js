import { $, labels, time, node, post, message } from '/common.js';
const names = {
  OPENAI_API_KEY: 'OpenAI API 키',
  TELNYX_API_KEY: 'Telnyx API 키',
  TELNYX_APPLICATION_ID: 'Voice API 앱 ID',
  TELNYX_PUBLIC_KEY: 'Telnyx 공개키',
  PUBLIC_BASE_URL: '공개 연결 URL',
  CALLER_NUMBER: '발신번호',
  TEST_PHONE: '테스트 수신번호',
  LIVE_MODEL: '음성 모델',
  BACKEND_MODEL: '응답 분류 모델',
  PLANNING_MODEL: '상황실 계획 모델',
  VOICE: '음성',
  MAX_CALL_SECONDS: '통신사 안전 종료 제한 (초)',
};
const secrets = ['OPENAI_API_KEY', 'TELNYX_API_KEY'];
for (const [key, label] of Object.entries(names)) {
  const wrapper = node('label', label, 'field');
  const input = document.createElement('input');
  input.name = key;
  input.id = key;
  input.type = secrets.includes(key) ? 'password' : key === 'MAX_CALL_SECONDS' ? 'number' : 'text';
  if (key === 'MAX_CALL_SECONDS') {
    input.min = 30;
    input.max = 600;
  }
  input.autocomplete = 'off';
  wrapper.append(input);
  $('fields').append(wrapper);
}
let token = '',
  config,
  call,
  voice,
  dirty = false,
  working = false,
  connected = false,
  servicesReady = false,
  callbackReady = false,
  connectionChecks = [],
  runtimeEnvironment = 'local',
  dialing = false;
const linkedId = new URLSearchParams(location.search).get('callId');
function lock() {
  const busy = call?.blocked || voice?.blocked || dialing;
  for (const input of $('settings').elements) input.disabled = busy || working;
  for (const id of ['models', 'connection', 'callback-check', 'tunnel-start', 'tunnel-stop'])
    $(id).disabled = busy || working || dirty;
  $('dial').disabled = busy || working || dirty || !connected || !$('consent').checked;
  $('tunnel-start').disabled ||=
    runtimeEnvironment === 'deployment' || config?.environmentFields.includes('PUBLIC_BASE_URL');
  $('dial-reason').textContent = busy
    ? '진행 중이거나 종료 미확인인 통화가 있어 발신을 잠갔습니다.'
    : working
      ? '설정·연결을 확인 중입니다.'
      : dirty
        ? '변경한 설정을 먼저 저장하세요.'
        : !callbackReady
          ? '발신 잠금: 현재 서버의 공개 콜백 확인이 필요합니다. 공개 연결 후 공개 콜백만 재검사를 누르세요.'
          : !servicesReady
            ? '발신 잠금: 음성·Telnyx 연결 확인을 완료하세요.'
            : !$('consent').checked
              ? '발신하려면 수신 동의를 체크하세요.'
              : '발신 준비 완료. 버튼을 누르면 저장된 번호로 실제 전화가 걸립니다.';
  $('hangup').disabled = !busy;
  $('resolve').disabled = call?.status !== 'unknown' || !$('confirmed').checked;
  document
    .querySelectorAll('[name=scenario]')
    .forEach((i) => (i.disabled = busy || working || !!linkedId));
}
function settings(value) {
  config = value;
  for (const key of Object.keys(names)) {
    $(key).value = secrets.includes(key) ? '' : value[key];
    if (secrets.includes(key))
      $(key).placeholder = value.secrets[key] ? '저장됨 · 비워두면 유지' : '미설정';
  }
  dirty = false;
  connected = false;
  servicesReady = false;
  callbackReady = false;
  connectionChecks = [];
  $('env-fields').textContent = config.environmentFields.length
    ? '환경변수 우선 적용: ' +
      config.environmentFields.join(', ') +
      '. 환경 파일 변경은 서버 재시작 후 적용됩니다.'
    : '';
  lock();
}
function render(value) {
  call = value;
  $('status').textContent = labels[value.status] ?? value.status;
  $('target').textContent = value.phone || config?.TEST_PHONE || '설정된 수신번호 없음';
  $('notice').textContent = value.notice || '';
  $('ids').textContent =
    `로컬 통화 ${value.id || '—'} · Live ${value.sessionId || '—'} · Telnyx ${value.callControlId || '—'}`;
  $('audio-stats').textContent =
    `수신 ${(value.audioInputLastAt ? value.audioInputReceivedSeconds : value.audioInSeconds).toFixed(1)}초 · AI 전송 ${value.audioInSeconds.toFixed(1)}초 · 송신 ${value.audioOutSeconds.toFixed(1)}초 · 재생 중단 ${value.audioClears}회 · 재생 버퍼 ${Math.round(value.audioBufferedMs ?? 0)}ms · 버퍼 고갈 ${value.audioUnderruns ?? 0}회`;
  $('input-stats').textContent =
    !value.audioInputLastAt && value.audioInSeconds > 0
      ? '입력 신호 진단은 다음 통화부터 기록합니다.'
      : `입력 신호 ${(value.audioInputSignalSeconds ?? 0).toFixed(1)}초 · 입력 대기 ${Math.round(value.audioInputBufferedMs ?? 0)}ms · 누락된 패킷 번호 ${value.audioInputDropped ?? 0}개`;
  $('scenario-state').textContent = value.assessment
    ? `위치 ${value.assessment.location} · 대피소 ${value.assessment.shelterName ?? '미확인'} · 이동 ${{ possible: '가능', needs_help: '도움 필요', unknown: '미확인' }[value.assessment.mobility]} · 몸 상태 ${{ comfortable: '괜찮음', uncomfortable: '불편함', unknown: '미확인' }[value.assessment.condition]}${value.assessment.refusal === 'refused' ? ' · 대피 거부' : ''}${value.assessment.reason ? ' · ' + value.assessment.reason : ''}`
    : '주민 통화는 위치 → 이동 가능 여부 → 몸 상태를 확인하고 60초 안에 마칩니다.';
  for (const [id, done] of Object.entries({
    'm-created': !!value.callControlId,
    'm-ringing': value.events.some((e) => e.type === 'ringing'),
    'm-answered': value.answerObserved,
    'm-ended': !!value.endedAt,
  }))
    $(id).classList.toggle('done', done);
  $('error').hidden = !value.error;
  $('error').textContent = value.error
    ? `${value.error.code}: ${value.error.message}\n${value.error.action}`
    : '';
  $('resolve-panel').hidden = value.status !== 'unknown';
  $('transcript').replaceChildren();
  if (!value.transcript.length)
    $('transcript').append(node('p', '실제 음성 대화의 전사를 기다립니다.', 'muted'));
  for (const turn of value.transcript) {
    const row = node('div', undefined, 'turn ' + turn.speaker);
    row.append(node('strong', turn.speaker === 'user' ? '수신자' : 'AI'), node('p', turn.text));
    $('transcript').append(row);
  }
  $('events').replaceChildren(
    ...value.events
      .slice()
      .reverse()
      .map((e) => node('li', `${time(e.at)} · ${e.type} · ${e.message}`)),
  );
  lock();
  if (value.completion) void outcomes();
}
async function outcomes() {
  const data = await (await fetch('/api/calls/outcomes')).json();
  $('outcomes').replaceChildren();
  if (!data.outcomes.length) $('outcomes').append(node('p', '아직 통화 결과가 없습니다.', 'muted'));
  for (const record of data.outcomes) {
    const c = record.completion,
      row = node('article', undefined, 'record');
    row.append(
      node('strong', c.location),
      node(
        'p',
        `${c.status === 'needs_review' ? '정정 · 재확인 필요' : ({ rescue: '구조 확인 요청', moving: '즉시 대피 안내', refused: '대피 거부 · 이장 연락 요청', review: '담당자 재확인 요청', standby: '대기조 확인 종료' }[c.kind] ?? '대피 완료 자기 신고')} · ${time(c.recordedAt)}`,
        'small',
      ),
      node('blockquote', c.evidence),
      node(
        'p',
        `${labels[record.callStatus] ?? record.callStatus} · 안내 재생 ${c.playbackConfirmed ? '확인' : '미확인'} · 종료 ${time(record.endedAt)}`,
        'small',
      ),
    );
    if (c.correction) row.append(node('p', '정정 발화: ' + c.correction));
    if (c.assessment) row.append(node('p', c.assessment.reason, 'small'));
    if (['rescue', 'moving', 'refused', 'review'].includes(c.kind))
      row.append(
        node(
          'p',
          record.callStatus === 'ended'
            ? '상황실 후속 요청 대상 · 실제 출동은 모의 처리'
            : '최종 종료 확인 후 상황실 후속 요청',
          'small',
        ),
      );
    $('outcomes').append(row);
  }
}
async function run(fn) {
  working = true;
  lock();
  try {
    await fn();
  } catch (e) {
    message(e);
  } finally {
    working = false;
    lock();
  }
}
$('settings').addEventListener('input', () => {
  dirty = true;
  connected = false;
  servicesReady = false;
  callbackReady = false;
  lock();
});
$('settings').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = Object.fromEntries(new FormData($('settings')));
  input.MAX_CALL_SECONDS = Number(input.MAX_CALL_SECONDS);
  void run(async () => {
    settings((await post('/api/config', input, token)).config);
    message('설정을 저장했습니다.');
  });
});
$('clear-secrets').onclick = () =>
  run(async () => {
    settings((await post('/api/config', { clearSecrets: true }, token)).config);
    message('로컬 저장 API 키를 삭제했습니다. 환경변수의 키는 해당 환경에서 직접 삭제하세요.');
  });
function checks(result) {
  $('checks').replaceChildren(
    ...result.checks.map((c) =>
      node('p', `${c.ok ? '확인' : '미확인'} · ${c.name}: ${c.message}`, 'small'),
    ),
  );
  message(result.note);
}
$('models').onclick = () => run(async () => checks(await post('/api/models/check', {}, token)));
$('connection').onclick = () =>
  run(async () => {
    const result = await post('/api/connection/check', {}, token);
    checks(result);
    connectionChecks = result.checks;
    const serviceChecks = connectionChecks.filter((c) => c.name !== '공개 콜백');
    servicesReady = serviceChecks.length > 0 && serviceChecks.every((c) => c.ok);
    callbackReady = connectionChecks.some((c) => c.name === '공개 콜백' && c.ok);
    connected = servicesReady && callbackReady;
  });
$('callback-check').onclick = () =>
  run(async () => {
    callbackReady = false;
    connected = false;
    connectionChecks = connectionChecks.filter((c) => c.name !== '공개 콜백');
    try {
      const result = await post('/api/callback/check', {}, token);
      callbackReady = result.check.ok;
      connectionChecks.push(result.check);
      checks({ checks: connectionChecks, note: result.note });
      connected = servicesReady && callbackReady;
    } catch (error) {
      connectionChecks.push({ name: '공개 콜백', ok: false, message: error.message });
      checks({ checks: connectionChecks, note: '공개 콜백 미확인으로 발신 잠금을 유지합니다.' });
      throw error;
    }
  });
$('tunnel-start').onclick = () =>
  run(async () => {
    const result = await post('/api/tunnel/start', {}, token);
    settings(result.config);
    $('tunnel-state').textContent = result.tunnel.url;
  });
$('tunnel-stop').onclick = () =>
  run(async () => {
    await post('/api/tunnel/stop', {}, token);
    connected = false;
    callbackReady = false;
    $('tunnel-state').textContent = '공개 연결 중단';
  });
$('consent').onchange = lock;
$('confirmed').onchange = lock;
$('dial').onclick = () =>
  run(async () => {
    dialing = true;
    lock();
    try {
      const scenario = document.querySelector('[name=scenario]:checked').value;
      render(
        (
          await post(
            '/api/calls',
            { scenario, consent: $('consent').checked, ...(linkedId ? { callId: linkedId } : {}) },
            token,
          )
        ).call,
      );
      $('consent').checked = false;
    } finally {
      dialing = false;
    }
  });
$('hangup').onclick = () =>
  run(async () => render((await post('/api/calls/hangup', {}, token)).call));
$('resolve').onclick = () =>
  run(async () =>
    render(
      (await post('/api/calls/resolve', { confirmedEnded: $('confirmed').checked }, token)).call,
    ),
  );
try {
  const boot = await (await fetch('/api/bootstrap')).json();
  token = boot.token;
  voice = boot.voice;
  runtimeEnvironment = boot.runtime.environment;
  $('runtime-environment').textContent =
    runtimeEnvironment === 'local'
      ? '로컬 환경 · Mac의 8788 콜백에 연결된 로컬 테스트 URL을 사용합니다.'
      : '배포 환경 · 배포 도메인의 콜백 URL을 사용합니다.';
  settings(boot.config);
  render(boot.call);
  $('tunnel-state').textContent = boot.tunnel.url || '공개 연결 미실행';
  if (linkedId) {
    const state = await (await fetch('/api/disaster/state')).json(),
      linked = state.calls.find(
        (c) => c.id === linkedId && c.state !== 'ended' && c.transport === 'telnyx',
      );
    if (!linked) throw new Error('연결할 가구 통화가 취소되었거나 존재하지 않습니다.');
    document.querySelector(`[name=scenario][value=${linked.scenario}]`).checked = true;
    $('linked').textContent =
      '가상 대상 ' + linked.targetId + ' · 실제 전화는 저장된 TEST_PHONE 한 대로 발신합니다.';
  }
  const events = new EventSource('/api/events');
  events.onmessage = (e) => render(JSON.parse(e.data));
  events.onerror = () => message('상태 연결이 끊겼습니다. 실제 통화 상태를 확인하세요.');
  const voiceEvents = new EventSource('/api/voice/events');
  voiceEvents.onmessage = (e) => {
    voice = JSON.parse(e.data);
    lock();
  };
  await outcomes();
  lock();
} catch (e) {
  message(e);
  $('dial').disabled = true;
}
