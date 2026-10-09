import type { Counts, Group, Household, HouseholdStatus, Point, Scenario } from './types.ts';
export const STATUS_LABELS = {
  before: '발신 전',
  queued: '대기',
  calling: '통화 중',
  guided: '안내 확인',
  moving: '이동 중',
  dispatched: '차량 출동',
  sent119: '인계 진행',
  help: '도움 필요',
  refuse: '거부·이장 검토',
  visiting: '이장 처리',
  noanswer: '무응답',
  unclear: '확인 필요',
  e119: '119 모의 인계',
  safe: '대피 완료',
  rescued: '구조 완료',
  visit: '방문 전용',
  pendingunknown: '발신 확인 필요',
  redial: '재발신',
};
export const GROUP_LABELS: Record<Group, string> = {
  act: '조치 필요',
  prog: '진행',
  safe: '안전',
  visit: '방문',
  before: '발신 전',
  excluded: '임시 제외',
};
const acts = new Set([
  'help',
  'refuse',
  'visiting',
  'noanswer',
  'unclear',
  'e119',
  'sent119',
  'pendingunknown',
  'redial',
]);
const safes = new Set(['safe', 'rescued']);
export function groupOf(h: Household, s: HouseholdStatus): Group {
  if (s.temporaryExclusion) return 'excluded';
  if (!h.callEligible) return 'visit';
  if (s.status === 'before') return 'before';
  if (safes.has(s.status)) return 'safe';
  if (s.recheckOverdue || s.dispatchHold || acts.has(s.status)) return 'act';
  return 'prog';
}
export function tally(households: Household[], statuses: HouseholdStatus[]): Counts {
  const counts: Counts = {
    total: households.length,
    eligible: 0,
    act: 0,
    prog: 0,
    safe: 0,
    visit: 0,
    before: 0,
    temporarilyExcluded: 0,
  };
  const indexed = new Map(statuses.map((s) => [s.householdId, s]));
  for (const h of households) {
    const s = indexed.get(h.id);
    if (!s) throw new Error('Missing household status: ' + h.id);
    const g = groupOf(h, s);
    if (g === 'excluded') counts.temporarilyExcluded++;
    else counts[g]++;
    if (g !== 'excluded' && g !== 'visit') counts.eligible++;
  }
  return counts;
}
export function staleReason(date: string | null, referenceDate: string): string | null {
  if (!date) return '확인일 없음';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '확인일 오류';
  const parsed = Date.parse(date + 'T00:00:00+09:00');
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed + 9 * 3600000).toISOString().slice(0, 10) !== date
  )
    return '확인일 오류';
  const days = (Date.parse(referenceDate + 'T00:00:00+09:00') - parsed) / 86400000;
  return days < 0 ? '미래 확인일 오류' : days > 90 ? '90일 초과·확인 필요' : null;
}
export function vulnerability(
  h: Pick<Household, 'age' | 'mobility' | 'devices' | 'phoneKind' | 'cohabitant'> &
    Partial<Pick<Household, 'originalNote' | 'healthNotes'>> & {
      noteExtraction?: import('./household-notes.ts').StructuredHouseholdNotes;
    },
): number {
  let v = h.age >= 80 ? 2 : 1;
  if (h.mobility === '보조' || h.phoneKind === '없음' || h.devices.includes('휠체어'))
    v = Math.max(v, 3);
  if (h.mobility === '와상' || h.mobility === '불명' || h.devices.includes('산소')) v = 4;
  if (h.cohabitant === '독거' && v === 2) v = 3;
  const healthPatterns = new Map([
      ['dementia', /치매|\bdementia\b/giu],
      ['dialysis', /투석|\bdialysis\b/giu],
      ['insulin', /인슐린|\binsulin\b/giu],
      ['visual_impairment', /시각\s*장애|시력\s*장애/giu],
    ]),
    facts = h.noteExtraction?.evidence?.vulnerability;
  // Stored extraction grades can describe old mobility. Only current, positive health evidence
  // contributes here; the human-edited mobility and equipment above remain authoritative.
  if (
    Array.isArray(facts) &&
    facts.length <= 512 &&
    facts.some((fact) => {
      if (
        !fact ||
        typeof fact.value !== 'string' ||
        !healthPatterns.has(fact.value) ||
        typeof fact.quote !== 'string' ||
        fact.quote.length === 0 ||
        fact.quote.length > 10000 ||
        !Number.isSafeInteger(fact.start) ||
        !Number.isSafeInteger(fact.end) ||
        fact.start < 0 ||
        fact.end <= fact.start ||
        fact.end - fact.start !== fact.quote.length
      )
        return false;
      let source: string | undefined;
      if (fact.source === 'note' && fact.index === null) source = h.originalNote;
      else if (
        fact.source === 'health' &&
        Array.isArray(h.healthNotes) &&
        h.healthNotes.length <= 50 &&
        Number.isSafeInteger(fact.index) &&
        fact.index !== null &&
        fact.index >= 0 &&
        fact.index < h.healthNotes.length
      )
        source = h.healthNotes[fact.index];
      if (
        typeof source !== 'string' ||
        source.length > 10000 ||
        fact.end > source.length ||
        source.slice(fact.start, fact.end) !== fact.quote
      )
        return false;
      const separators = /[,;。\n/.!?？]/gu,
        before = [...source.slice(0, fact.start).matchAll(separators)],
        clauseStart = before.length ? before.at(-1)!.index! + 1 : 0,
        next = source.slice(fact.start).search(separators),
        clauseEnd = next === -1 ? source.length : fact.start + next + 1,
        clause = source.slice(clauseStart, clauseEnd);
      if (
        fact.end > clauseEnd ||
        /[?？]|예정|계획|의심|추정|가능성|불확실|과거|예전|이력|중단|무시(?:하|해)|명령\s*[:：]|지시\s*[:：]|(?:실행|적용|변경|설정|판정|출력|응답|추정)(?:하라|해라|하세요|해\s*줘|하시오)|\b(?:ignore|system|assistant|prompt|execute|eval|no|not|without|denies|denied)\b/iu.test(
          clause,
        )
      )
        return false;
      const pattern = healthPatterns.get(fact.value)!;
      for (const match of fact.quote.matchAll(pattern)) {
        const start = fact.start + match.index! - clauseStart,
          left = clause.slice(0, start),
          right = clause.slice(start + match[0].length);
        if (
          /(?:안|없는|아닌|미사용)\s*$/u.test(left) ||
          /^\s*(?:(?:를|을|은|는|이|가|도)\s*)?(?:(?:필요|사용|보유|투여|복용|치료|진단받|진단을\s*받|진단|증상|여부|받)\s*)?(?:없|없이|아니|아닌|아님|아닙|아냐|미사용|불필요|불명|미확인|확인\s*필요|모름|모르|못|않|안\s*(?:함|사용)|(?:하지|지)\s*(?:않|못)|absent\b|negative\b|unknown\b)/iu.test(
            right,
          )
        )
          continue;
        return true;
      }
      return false;
    })
  )
    v = Math.max(v, 3);
  return v;
}
export function attentionDetail(s: HouseholdStatus): string {
  if (s.status === 'e119' || s.status === 'sent119') return '긴급';
  if (s.status === 'help') return '도움 미배차';
  if (s.status === 'refuse' || s.status === 'visiting') return '이장·연락 대기';
  if (s.status === 'noanswer' || s.status === 'redial') return '무응답·재발신';
  return '확인 필요';
}
export function nextAction(s: HouseholdStatus): string {
  if (s.temporaryExclusion) return '임시 제외 사유 확인';
  if (s.dispatchHold) return `임무 보류·${s.dispatchHold}`;
  if (s.recheckOverdue) return '후속 확인 기한 지남·담당자 확인';
  if (s.callbackAtSim != null && ['moving', 'unclear'].includes(s.status))
    return `T+${s.callbackAtSim}분 ${s.status === 'moving' ? '도착 재확인' : '재통화'}`;
  return {
    before: '확정 후 발신',
    queued: '발신 대기',
    calling: '모의 전사 확인',
    guided: '이동 여부 확인',
    moving: '도착 재확인',
    dispatched: '차량 도착 확인',
    sent119: '구조 진행 확인',
    help: '장비·차량 검토',
    refuse: '이장 연결 요청·수동 연락',
    visiting: '이장 결과 확인',
    noanswer: '재발신 또는 방문 검토',
    unclear: '근거 확인·재통화',
    e119: '모의 인계 기록·구조 확인',
    safe: '모의 도착 근거',
    rescued: '모의 대피소 도착 근거',
    visit: '이장 방문 확인',
    pendingunknown: '기존 세션 종료 확인·자동 재발신 보류',
    redial: '재발신 결과 확인',
  }[s.status];
}
export function handover(households: Household[], scenario: Scenario) {
  const indexed = new Map(scenario.householdStatuses.map((s) => [s.householdId, s]));
  return households
    .filter((h) => {
      const s = indexed.get(h.id)!;
      const g = groupOf(h, s);
      return g !== 'safe' && g !== 'excluded' && !(g === 'visit' && s.visitCompleted);
    })
    .map((h) => ({
      household: h,
      status: indexed.get(h.id)!,
      nextAction: nextAction(indexed.get(h.id)!),
    }));
}
export function eta(
  point: Point,
  ignition: Point,
  windDirection: number,
  windSpeed: number,
  elapsedMinutes = 0,
  progressMeters?: number,
): number | null {
  if (!Number.isFinite(windSpeed) || windSpeed < 0 || !Number.isFinite(windDirection)) return null;
  const theta = ((windDirection + 180) * Math.PI) / 180;
  const ux = Math.sin(theta),
    uy = -Math.cos(theta);
  const dx = (point.x - ignition.x) * 2,
    dy = (point.y - ignition.y) * 2;
  const along = dx * ux + dy * uy,
    lateral = Math.abs(dx * uy - dy * ux);
  const distance = Math.max(0, along) + 3 * Math.max(0, -along) + 2 * lateral;
  const velocity = 25 + 4 * windSpeed;
  return Math.max(0, (distance - (progressMeters ?? velocity * elapsedMinutes)) / velocity);
}
export function orderedHouseholds(
  households: Household[],
  ignition: Point,
  wind: { direction: number; speedMps: number },
) {
  return households
    .map((h) => {
      const t = eta(h.demoPosition, ignition, wind.direction, wind.speedMps);
      return {
        householdId: h.id,
        eta: t,
        vulnerability: vulnerability(h),
        score: vulnerability(h) * 10 + (t === null ? 36 : Math.max(0, 60 - t) * 0.6),
        reason: `취약 ${vulnerability(h)}등급 · ${t === null ? '도달 불명' : `데모 ETA ${Math.round(t)}분`}`,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.eta ?? -1) - (b.eta ?? -1) ||
        b.vulnerability - a.vulnerability ||
        a.householdId.localeCompare(b.householdId),
    )
    .map((x, i) => ({ ...x, rank: i + 1 }));
}
