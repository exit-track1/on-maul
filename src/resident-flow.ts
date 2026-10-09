import type { ResidentAnswer } from './resident-classifier.ts';

export const residentQuestions = {
  location: '지금 어디십니까?',
  mobility: '현재 산불로 인하여 대피하셔야 합니다.',
  condition: '몸이 불편하신가요?',
};
export const rescueFarewell = '구조대를 보내드리겠습니다.';
export const movingFarewell = '지금 즉시 대피해주십시오.';
export const refusalFarewell = '이장님께서 전화하실 겁니다.';
export const reviewFarewell = '담당자가 다시 확인하도록 하겠습니다.';
export const openingDelayMs = 2000;
export const answerSettleMs = 180;
export const scenarioWrapSeconds = 45;
export const scenarioLimitSeconds = 60;
export type ResidentAssessment = {
  stage: 'location' | 'mobility' | 'condition' | 'done';
  location: string;
  shelterName: string;
  mobility: 'possible' | 'needs_help' | 'unknown';
  condition: 'comfortable' | 'uncomfortable' | 'unknown';
  refusal: 'refused' | 'willing' | 'unknown';
  emergency: boolean;
  answers: { question: string; text: string }[];
  reason: string;
};
export function residentAssessment(shelterName = '온빛 배움학교'): ResidentAssessment {
  return {
    stage: 'mobility',
    location: '위치 미확인',
    shelterName,
    mobility: 'unknown',
    condition: 'unknown',
    refusal: 'unknown',
    emergency: false,
    answers: [],
    reason: '',
  };
}
export function residentQuestion(a: ResidentAssessment) {
  if (a.stage === 'mobility')
    return `${residentQuestions.mobility} ${a.shelterName}로 이동 가능하십니까?`;
  return a.stage === 'condition' ? residentQuestions.condition : residentQuestions.location;
}
export function greetingOnly(text: string) {
  return /^(?:어[,.\s]*)?(?:여보세요|안녕하세요|네[,.\s]*여보세요)[.!?\s]*$/.test(text.trim());
}
// Reply count never advances the stage: location, transport, health and refusal are independent.
export function applyResidentAnswer(
  a: ResidentAssessment,
  text: string,
  answer: ResidentAnswer,
  question = '',
) {
  if (a.stage === 'done' || !text.trim() || greetingOnly(text)) return;
  a.answers.push({ question: question || '질문 발화 전·자발적 응답', text });
  const supported = (key: keyof ResidentAnswer['evidence']) =>
    answer.confidence >= 0.9 &&
    !!answer.evidence[key].trim() &&
    text.includes(answer.evidence[key]);
  if (answer.location && supported('location')) a.location = answer.location;
  if (answer.mobility !== 'unknown' && supported('mobility')) a.mobility = answer.mobility;
  if (answer.condition !== 'unknown' && supported('condition')) a.condition = answer.condition;
  if (answer.refusal !== 'unknown' && supported('refusal')) a.refusal = answer.refusal;
  if (supported('emergency')) a.emergency = answer.emergency;
  if (a.refusal === 'refused' || a.mobility === 'needs_help' || a.emergency) a.stage = 'done';
  else if (a.mobility === 'unknown') a.stage = 'mobility';
  else if (a.condition === 'unknown') a.stage = 'condition';
  else a.stage = 'done';
}
export function finishResident(a: ResidentAssessment, timedOut = false) {
  a.stage = 'done';
  const kind: 'refused' | 'rescue' | 'moving' | 'review' =
    a.refusal === 'refused'
      ? 'refused'
      : a.mobility === 'needs_help' || a.emergency
        ? 'rescue'
        : a.mobility === 'possible' && a.condition === 'comfortable'
          ? 'moving'
          : 'review';
  a.reason =
    kind === 'refused'
      ? '대피 거부·이장 연락 필요'
      : kind === 'rescue'
        ? a.emergency
          ? '긴급 증상 자기 신고·담당자 확인 필요'
          : '이동 수단 없음 또는 신체 사유로 이동 불가'
        : kind === 'moving'
          ? '몸 상태 괜찮음·스스로 이동 가능 자기 신고'
          : timedOut
            ? '45초 내 확인 미완료·담당자 재확인'
            : '이동 가능 여부 또는 몸 상태 미확인·담당자 재확인';
  return {
    kind,
    location: a.location,
    evidence: a.answers.map((v) => v.text).join(' / ') || '응답 미확인',
    closingText: {
      refused: refusalFarewell,
      rescue: rescueFarewell,
      moving: movingFarewell,
      review: reviewFarewell,
    }[kind],
    assessment: structuredClone(a),
  };
}
