import { $, node, time, post, message } from '/common.js';
let token = '';
const statuses = {
  before: '발신 전',
  queued: '모의 연락 대기',
  moving: '도착 확인 필요',
  help: '도움 필요',
  safe: '대피 완료 자기 신고',
  unknown: '재확인 필요',
};
async function refresh() {
  const s = await (await fetch('/api/disaster/state')).json();
  $('metrics').replaceChildren(
    ...[
      ['가구', s.counts.total],
      ['안전 자기 신고', s.counts.safe],
      ['도움 필요', s.counts.help],
    ].map(([label, value]) => {
      const box = node('div', label);
      box.append(node('strong', String(value)));
      return box;
    }),
  );
  $('phase').textContent = '진행 단계: ' + s.phase;
  $('follow-ups').replaceChildren(
    ...(s.followUps ?? [])
      .slice()
      .reverse()
      .map((f) => {
        const row = node('article', undefined, 'record');
        row.append(
          node(
            'strong',
            `${{ rescue: '구조 확인 요청', moving: '즉시 대피 안내', refused: '이장 연락 요청', review: '담당자 재확인 요청' }[f.kind]} · ${f.targetId ?? '단독 수신 체험'}`,
          ),
          node('p', `${f.location} · ${f.reason}`),
          node('blockquote', f.evidence),
          node(
            'p',
            `${{ needs_assignment: '담당자 배정 대기', guidance_requested: '대피 안내 기록', elder_contact_requested: '이장 연락 대기', review_requested: '담당자 재확인 대기' }[f.status]} · 종료 안내 재생 ${f.playbackConfirmed ? '확인' : '미확인'} · ${time(f.createdAt)}`,
            'small',
          ),
        );
        return row;
      }),
  );
  if (!s.followUps?.length)
    $('follow-ups').append(node('p', '아직 종료된 통화의 후속 요청이 없습니다.', 'muted'));
  $('contacts').replaceChildren(
    ...s.contacts.map((c) => {
      const row = node(
        'p',
        `${c.targetId} · 연락 ${c.attempts}회 · 모의 SMS ${c.sms}회 · ${c.status}${c.nextRetryAt ? ' · 예약 ' + time(c.nextRetryAt) : ''} `,
      );
      const retry = node('button', '모의 재시도', 'secondary');
      retry.disabled = c.attempts >= (c.scenario === 'resident' ? 5 : 3);
      retry.onclick = () => command('retry', { targetId: c.targetId });
      row.append(retry);
      return row;
    }),
  );
  $('sources').textContent = JSON.stringify(s.sources, null, 2);
  $('households').replaceChildren();
  for (const h of s.households) {
    const row = document.createElement('tr');
    for (const value of [
      `${h.id} · ${h.name}`,
      `${h.priorityGrade}등급`,
      statuses[h.status] ?? h.status,
      h.location,
    ])
      row.append(node('td', value));
    const td = document.createElement('td');
    for (const transport of ['telnyx', 'browser']) {
      const button = node('button', transport === 'telnyx' ? '휴대전화' : '브라우저', 'secondary');
      button.disabled = !h.callEligible || s.phase !== 'active';
      button.onclick = () => prepare(h.id, 'resident', transport);
      td.append(button);
    }
    row.append(td);
    $('households').append(row);
  }
  $('teams').replaceChildren();
  for (const t of s.teams) {
    const row = node('p', `${t.name} · ${t.available ? '참여 가능' : '미확인'} `);
    const button = node('button', '가상 참여 가능', 'secondary');
    button.onclick = () => command('team-ready', { teamId: t.id, available: true });
    const voice = node('button', '대기조 수신', 'secondary');
    voice.onclick = () => prepare(t.id, 'standby', 'telnyx');
    row.append(button, voice);
    $('teams').append(row);
  }
  $('dispatch-target').replaceChildren(
    ...s.households
      .filter((h) => h.status === 'help')
      .map((h) => {
        const o = node('option', h.name);
        o.value = h.id;
        return o;
      }),
  );
  $('vehicle').replaceChildren(
    ...s.vehicles.map((v) => {
      const o = node('option', v.name + (v.available ? '' : ' · 사용 중'));
      o.value = v.id;
      return o;
    }),
  );
  $('dispatches').replaceChildren(
    ...s.dispatches.map((d) => {
      const row = node('p', `${d.targetId} · ${d.vehicleId} · ${d.stage} `);
      const stages = ['assigned', 'pickup', 'onboard', 'arrived'],
        next = stages[stages.indexOf(d.stage) + 1];
      if (next) {
        const button = node('button', `모의 ${next} 보고`, 'secondary');
        button.onclick = () => command('dispatch-stage', { id: d.id, stage: next });
        row.append(button);
      }
      return row;
    }),
  );
  $('audit').replaceChildren(
    ...s.audit
      .slice(-60)
      .reverse()
      .map((a) => node('li', `${time(a.at)} · ${a.action} · ${a.detail}`)),
  );
  $('runs').replaceChildren(
    ...s.runs
      .slice(-10)
      .reverse()
      .map((r) =>
        node(
          'p',
          `${r.targetId} · ${r.model} · ${r.result} · ${r.nodes.join(' → ')} · ${r.evidence}`,
          'small',
        ),
      ),
  );
}
async function command(action, data = {}) {
  try {
    await post('/api/disaster/' + action, data, token);
    await refresh();
  } catch (e) {
    message(e);
  }
}
async function prepare(targetId, scenario, transport) {
  try {
    const call = await post('/api/disaster/call', { targetId, scenario, transport }, token);
    location.href =
      (transport === 'telnyx' ? '/telnyx' : '/voice') + '?callId=' + encodeURIComponent(call.id);
  } catch (e) {
    message(e);
  }
}
document
  .querySelectorAll('[data-command]')
  .forEach(
    (button) =>
      (button.onclick = () =>
        command(
          button.dataset.command,
          button.dataset.command === 'approve' ? { approved: true } : {},
        )),
  );
$('dispatch').onsubmit = (e) => {
  e.preventDefault();
  void command('dispatch', {
    targetId: $('dispatch-target').value,
    vehicleId: $('vehicle').value,
    roadBlocked: $('road-blocked').checked,
  });
};
try {
  token = (await (await fetch('/api/bootstrap')).json()).token;
  await refresh();
  setInterval(() => refresh().catch(message), 3000);
} catch (e) {
  message(e);
}
