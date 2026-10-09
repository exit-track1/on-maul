import { $, node, post, message } from '/common.js';
let token = '',
  id = '',
  pc,
  stream,
  heartbeat,
  recorder,
  mixer,
  mixDestination,
  events,
  hasKey = false,
  savingRecording = false;
const callId = new URLSearchParams(location.search).get('callId');
function releaseMedia() {
  if (recorder && recorder.state !== 'inactive') {
    savingRecording = true;
    recorder.stop();
  } else if (mixer) void mixer.close();
  recorder = undefined;
  pc?.close();
  pc = undefined;
  stream?.getTracks().forEach((t) => t.stop());
  stream = undefined;
  mixDestination = undefined;
  mixer = undefined;
  clearInterval(heartbeat);
}
async function stop() {
  if (id)
    try {
      await post('/api/voice/hangup', { id }, token);
    } catch (e) {
      message(e);
    }
  releaseMedia();
  $('accept').disabled = savingRecording || !hasKey;
  $('stop').disabled = true;
}
function render(state) {
  $('resolve-panel').hidden = state.status !== 'unknown';
  $('status').textContent = state.status;
  $('accept').disabled = state.blocked || savingRecording || !hasKey;
  $('transcript').replaceChildren(
    ...state.transcript.map((t) => {
      const row = node('div', undefined, 'turn ' + t.speaker);
      row.append(node('strong', t.speaker === 'user' ? '수신자' : 'AI'), node('p', t.text));
      return row;
    }),
  );
  if (['ended', 'failed'].includes(state.status)) {
    releaseMedia();
    $('accept').disabled = savingRecording || !hasKey;
    $('stop').disabled = true;
  }
}
$('accept').onclick = async () => {
  if (savingRecording) return;
  if (!$('consent').checked) {
    message('음성 테스트 동의가 필요합니다.');
    return;
  }
  $('accept').disabled = true;
  $('record').disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc = new RTCPeerConnection();
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    if ($('record').checked) {
      mixer = new AudioContext();
      mixDestination = mixer.createMediaStreamDestination();
      mixer.createMediaStreamSource(stream).connect(mixDestination);
      recorder = new MediaRecorder(mixDestination.stream);
      const sessionRecorder = recorder,
        sessionMixer = mixer,
        recording = [];
      let recordingId = '';
      recorder.ondataavailable = (e) => {
        if (e.data.size) recording.push(e.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(recording, { type: sessionRecorder.mimeType });
        if (!recordingId) {
          await sessionMixer.close();
          return;
        }
        const base64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.readAsDataURL(blob);
        });
        try {
          await post('/api/recordings', { id: recordingId, data: base64, mime: blob.type }, token);
          message('선택한 녹음을 로컬 데이터 경로에 저장했습니다.');
        } catch (e) {
          message(e);
        } finally {
          savingRecording = false;
          $('accept').disabled = !hasKey;
        }
        await sessionMixer.close();
      };
      recorder.assignCallId = (value) => {
        recordingId = value;
      };
    }
    pc.ontrack = (e) => {
      $('remote-audio').srcObject = e.streams[0];
      if (mixDestination) mixer.createMediaStreamSource(e.streams[0]).connect(mixDestination);
    };
    const channel = pc.createDataChannel('oai-events');
    channel.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === 'session.started' && id)
          void post('/api/voice/ready', { id }, token).catch(message);
      } catch {
        message('음성 이벤트 형식 오류');
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete')
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ICE 연결 준비 시간 초과')), 10000);
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    const answer = await post(
      '/api/voice/session',
      {
        sdp: pc.localDescription.sdp,
        scenario: document.querySelector('[name=scenario]:checked').value,
        consent: true,
        recordingConsent: $('record').checked,
        ...(callId ? { callId } : {}),
      },
      token,
    );
    id = answer.id;
    if (recorder) {
      recorder.assignCallId(id);
      recorder.start(1000);
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    $('stop').disabled = false;
    heartbeat = setInterval(() => post('/api/voice/heartbeat', { id }, token).catch(message), 5000);
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(pc.connectionState)) void stop();
    };
  } catch (e) {
    message(e);
    await stop();
  } finally {
    $('record').disabled = false;
  }
};
$('stop').onclick = stop;
$('resolve').onclick = async () => {
  try {
    render(await post('/api/voice/resolve', { confirmedEnded: $('confirmed').checked }, token));
  } catch (e) {
    message(e);
  }
};
try {
  const boot = await (await fetch('/api/bootstrap')).json();
  token = boot.token;
  hasKey = boot.config.secrets.OPENAI_API_KEY;
  $('voice-config').textContent =
    `음성 모델 ${boot.config.LIVE_MODEL} · 응답 모델 ${boot.config.BACKEND_MODEL} · API 키 ${boot.config.secrets.OPENAI_API_KEY ? '설정됨' : '미설정'}`;
  events = new EventSource('/api/voice/events');
  events.onmessage = (e) => render(JSON.parse(e.data));
  if (callId) {
    const state = await (await fetch('/api/disaster/state')).json(),
      call = state.calls.find(
        (c) => c.id === callId && c.transport === 'browser' && c.state !== 'ended',
      );
    if (!call) throw new Error('유효한 상황실 브라우저 통화 ID가 아닙니다.');
    document.querySelector(`[name=scenario][value=${call.scenario}]`).checked = true;
    document.querySelectorAll('[name=scenario]').forEach((el) => (el.disabled = true));
  }
} catch (e) {
  message(e);
  $('accept').disabled = true;
}
window.addEventListener('beforeunload', () => {
  if (id)
    void fetch('/api/voice/hangup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ON-Token': token },
      body: JSON.stringify({ id }),
      keepalive: true,
    });
  stream?.getTracks().forEach((t) => t.stop());
});
