export const residentQuestions = {
  location: '지금 어디십니까?',
  mobility: '현재 산불로 인하여 피신하셔야 합니다. 이동 가능하세요?',
  condition: '몸이 불편하신가요?',
};
export const rescueFarewell = '구조대를 보내드리겠습니다.';
export const movingFarewell =
  '이동 가능 여부를 확인했습니다. 담당자에게 대피 안내를 요청하겠습니다.';
export const scenarioWrapSeconds = 45;
export const scenarioLimitSeconds = 60;
export type ResidentAssessment = {
  stage: 'location' | 'mobility' | 'condition' | 'done';
  location: string;
  mobility: 'possible' | 'needs_help' | 'unknown';
  condition: 'comfortable' | 'uncomfortable' | 'unknown';
  emergency: boolean;
  answers: { question: string; text: string }[];
  reason: string;
};
export function residentAssessment(): ResidentAssessment {
  return {
    stage: 'location',
    location: '위치 미확인',
    mobility: 'unknown',
    condition: 'unknown',
    emergency: false,
    answers: [],
    reason: '',
  };
}
export function advanceResident(assessment: ResidentAssessment, raw: string) {
  const text = raw.trim();
  if (!text || assessment.stage === 'done') return;
  const stage = assessment.stage;
  assessment.answers.push({ question: residentQuestions[stage], text });
  if (stage === 'location') {
    if (/집|자택/.test(text) && !/가야|갈\s*예정|가고|가는|어디|집.*(?:아니|않)/.test(text))
      assessment.location = '집';
    else if (
      !/^(네|예|응|어|몰라|모르|어디|뭐|잠깐)/.test(text) ||
      /(?:학교|회관|대피소|병원|회사|길|공원)/.test(text)
    )
      assessment.location = text.slice(0, 200);
    assessment.stage = 'mobility';
  } else if (stage === 'mobility') {
    // Questions and vague replies never count as a promise to evacuate independently.
    if (
      /못|불가능|불편|도움|차.*없|안\s*(?:돼|움직|걸|가)|어렵|힘들|(?:이동|가능|걷|가).*(?:않|없)/.test(
        text,
      )
    )
      assessment.mobility = 'needs_help';
    else if (
      !/[?？]|어디|어떻게|어디로|모르|글쎄/.test(text) &&
      (/이동.*가능|혼자.*(?:갈|가|이동)|갈\s*수|걸어.*(?:갈|가)|가능/.test(text) ||
        /^(네|예|응)[.!\s]*$/.test(text))
    )
      assessment.mobility = 'possible';
    assessment.stage = 'condition';
  } else {
    if (/괜찮.*않|안\s*괜찮/.test(text)) assessment.condition = 'uncomfortable';
    else if (/괜찮|불편.*(?:없|않)|안\s*불편|안\s*아파|아프지\s*않|건강|정상/.test(text))
      assessment.condition = 'comfortable';
    else if (/불편|아파|통증|못|숨|가슴/.test(text) || /^(네|예|응)[.!\s]*$/.test(text))
      assessment.condition = 'uncomfortable';
    assessment.emergency = /숨.*(?:힘|차|못)|가슴.*(?:아파|통증)/.test(text);
    assessment.stage = 'done';
  }
}
export function finishResident(assessment: ResidentAssessment, timedOut = false) {
  assessment.stage = 'done';
  const needsRescue =
    timedOut ||
    assessment.emergency ||
    assessment.mobility !== 'possible' ||
    assessment.condition !== 'comfortable';
  assessment.reason = timedOut
    ? '45초 내 확인 미완료'
    : assessment.emergency
      ? '긴급 증상 자기 신고·담당자 확인 필요'
      : assessment.mobility === 'needs_help'
        ? '이동 지원 필요'
        : assessment.mobility === 'unknown'
          ? '이동 가능 여부 미확인'
          : assessment.condition !== 'comfortable'
            ? '몸 상태 확인·지원 필요'
            : '이동 가능 자기 신고';
  return {
    kind: needsRescue ? ('rescue' as const) : ('moving' as const),
    location: assessment.location,
    evidence: assessment.answers.map((a) => a.text).join(' / ') || '응답 미확인',
    closingText: needsRescue ? rescueFarewell : movingFarewell,
    assessment: structuredClone(assessment),
  };
}
