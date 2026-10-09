export const $ = (id) => document.getElementById(id);
export const labels = {
  idle: '대기',
  requesting: '발신 준비·요청',
  created: '발신 접수',
  ringing: '벨소리',
  answered: '수신 응답',
  ending: '종료 확인 대기',
  ended: '종료 확인',
  failed: '실패',
  unknown: '결과 불명 · 잠금',
};
export const time = (value) =>
  value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '미확인';
export function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
export async function post(path, data, token) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ON-Token': token },
    body: JSON.stringify(data),
  });
  const result = await r.json();
  if (!r.ok)
    throw new Error(
      [result.error?.code, result.error?.message, result.error?.action].filter(Boolean).join(' · '),
    );
  return result;
}
export function message(error) {
  $('message').hidden = false;
  $('message').textContent = String(error instanceof Error ? error.message : error);
}
