import type { Status } from './types.ts';
export interface Classification {
  status: Status;
  acked: boolean;
  location: string | null;
  quoted: string;
  reason: string;
  reviewRequired: boolean;
  executionMode: 'rules';
}
/** Conservative demo rules. No model inference or external operation is implied. */
export function classify(text: string, shelterNames: string[]): Classification {
  const quoted = text.trim();
  const base: Classification = {
    status: 'unclear',
    acked: false,
    location: null,
    quoted,
    reason: '확인 근거 부족·담당자 검토',
    reviewRequired: true,
    executionMode: 'rules',
  };
  const emergency =
    /(숨(?:이|쉬기)?\s*(?:차요|차서|차고|힘들|어려)|호흡.{0,8}(?:곤란|어려)|의식이?\s*없)/.test(
      quoted,
    );
  if (emergency)
    return {
      ...base,
      status: 'e119',
      reason: '긴급 호소 근거·119 자동 인계(모의)',
      reviewRequired: false,
    };
  if (/안\s*(?:가|나가)|거부|집을?\s*지키|싫어요/.test(quoted))
    return { ...base, status: 'refuse', reason: '거부 근거·이장 수동 연락 검토' };
  if (/못\s*걷|차량|데리러|도움|휠체어|들것/.test(quoted))
    return {
      ...base,
      status: 'help',
      reason: '이동 지원 필요·자원 조건 검토',
      reviewRequired: false,
    };
  const location =
    shelterNames.find((name) => quoted.includes(name)) ??
    (quoted.includes('학교') ? shelterNames.find((x) => x.includes('학교')) : undefined);
  if (
    location &&
    /(도착했|도착해\s*있|와\s*있|왔어요)/.test(quoted) &&
    !/(아직|못|안\s*도착|아니|않|질문|도착했나요|도착했는지|도착했다고)/.test(quoted)
  )
    return {
      ...base,
      status: 'safe',
      location,
      reason: '등록 대피소·현재 도착 발화 근거',
      reviewRequired: false,
    };
  if (/이동\s*중|출발했|지금\s*나가|가고\s*있/.test(quoted))
    return {
      ...base,
      status: 'moving',
      reason: '이동 행동 확인·도착 재확인 필요',
      reviewRequired: false,
    };
  if (/대피소.{0,25}(갈게|가겠습니다|이동하겠)/.test(quoted))
    return {
      ...base,
      status: 'guided',
      acked: true,
      reason: '안내 내용 되말·도착 근거는 없음',
      reviewRequired: false,
    };
  return base;
}
