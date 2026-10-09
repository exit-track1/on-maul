import { vulnerability } from './domain.ts';

export type NoteMobility = 'independent' | 'assisted' | 'bedridden' | 'unknown';
export type NoteDevice = '산소' | '휠체어' | '들것' | '의료';
export type NoteCognition = 'dementia' | 'impaired' | 'clear' | 'unknown';
export type NoteCohabitant = 'alone' | 'with_family' | 'with_caregiver_daytime' | 'unknown';
export type NoteVehicle = 'owned' | 'none' | 'unknown';
export type NoteContact = 'mobile' | 'landline' | 'mobile_guardian' | 'none' | 'unknown';
export type NotePets = 'present' | 'none' | 'unknown';
export type NoteLanguage = '한국어' | '영어' | '중국어' | '베트남어' | '수어' | 'unknown';
export type NoteGrade = 1 | 2 | 3 | 4;
export type NoteField =
  'mobility' | 'devices' | 'cognition' | 'cohabitant' | 'vehicle' | 'contact' | 'pets' | 'language';

export interface HouseholdNoteInput {
  note?: string | null;
  health?: string | readonly string[] | null;
  mobility?: string | null;
  /** Existing factual age, never inferred from a command in the note. */
  age?: number | null;
}

export interface NoteEvidence {
  source: 'note' | 'health' | 'mobility';
  /** Index in a health array; null for scalar source text. */
  index: number | null;
  quote: string;
  start: number;
  end: number;
  value: string;
}

export interface StructuredHouseholdNotes {
  mobility: NoteMobility;
  devices: NoteDevice[];
  cognition: NoteCognition;
  cohabitant: NoteCohabitant;
  vehicle: NoteVehicle;
  contact: NoteContact;
  pets: NotePets;
  language: NoteLanguage;
  vulnerability: NoteGrade;
  /** True when any supported field or the age context remains unknown. */
  estimated: boolean;
  evidence: Partial<Record<NoteField | 'vulnerability', NoteEvidence[]>>;
  unknown_fields: (NoteField | 'age')[];
  executionMode: 'rules';
}

type Source = Pick<NoteEvidence, 'source' | 'index'> & { text: string };
type Rule<T extends string> = readonly [T, RegExp];

const mobilityRules: readonly Rule<NoteMobility>[] = [
  [
    'independent',
    /자력|독립\s*(?:보행|거동)|혼자\s*(?:걷|걸)|스스로\s*(?:걷|걸|이동)|\bindependent\b/iu,
  ],
  [
    'assisted',
    /보행\s*보조|보조\s*보행|이동\s*보조|거동\s*보조|걷(?:기|는데)\s*(?:도움|보조)|^보조$|\bassisted\b/iu,
  ],
  ['bedridden', /와상|누워서\s*생활|침상\s*생활|\bbedridden\b/iu],
  [
    'unknown',
    /거동\s*(?:불명|미확인|확인\s*필요)|보행\s*(?:불명|미확인)|^불명$|^unknown$|\bmobility\s*[:=]\s*unknown\b/iu,
  ],
];
const deviceRules: readonly Rule<NoteDevice>[] = [
  [
    '산소',
    /산소\s*(?:발생기|장비|통|마스크|호흡기)|산소(?:를|가)?\s*(?:씀|쓰(?:고|는|며)|사용|필요|흡입|치료|공급)|^산소$|\boxygen\b/iu,
  ],
  ['휠체어', /휠체어|\bwheelchair\b/iu],
  ['들것', /들것|\bstretcher\b/iu],
  ['의료', /의료\s*장비|\bmedical\s+equipment\b/iu],
];
const cognitionRules: readonly Rule<NoteCognition>[] = [
  ['dementia', /치매|\bdementia\b/iu],
  ['impaired', /인지\s*저하/iu],
  ['clear', /인지\s*(?:정상|양호)|인식\s*정상/iu],
];
const cohabitantRules: readonly Rule<NoteCohabitant>[] = [
  ['alone', /독거|혼자\s*(?:살|거주|지내)|\balone\b/iu],
  [
    'with_family',
    /가족(?:과|이)?\s*(?:동거|함께|같이|거주)|(?:배우자|아들|딸)(?:과|와)\s*(?:동거|함께|같이)|\bwith_family\b/iu,
  ],
  [
    'with_caregiver_daytime',
    /주간\s*(?:돌봄|간병인\s*상주)|낮(?:에|시간)?\s*(?:요양보호사|간병인)(?:가|와|과)?\s*(?:상주|함께|동거)|\bwith_caregiver_daytime\b/iu,
  ],
];
const vehicleRules: readonly Rule<NoteVehicle>[] = [
  ['owned', /차량\s*보유|자가용\s*(?:보유|있)|자차\s*(?:보유|있)|차가\s*있/iu],
  ['none', /차량\s*없(?:음|다)?|자가용\s*없(?:음|다)?|자차\s*없(?:음|다)?/iu],
];
const contactRules: readonly Rule<NoteContact>[] = [
  [
    'mobile_guardian',
    /휴대(?:전화)?\s*[（(]\s*(?:아들|딸|보호자|가족)\s*[）)]|(?:아들|딸|보호자|가족)(?:의)?\s*(?:휴대전화|휴대폰|핸드폰)/iu,
  ],
  ['mobile', /휴대전화|휴대폰|핸드폰|휴대/iu],
  ['landline', /유선\s*(?:전화)?|집\s*전화/iu],
  ['none', /전화\s*없(?:음|다)?|연락처\s*없(?:음|다)?/iu],
];
const petRules: readonly Rule<NotePets>[] = [
  [
    'present',
    /반려동물\s*(?:있|키|동반|보유)|(?:개|고양이|강아지)(?:를|가)?\s*(?:키우|있|동반|\d+\s*마리)/iu,
  ],
  ['none', /(?:반려동물|애완동물)\s*없(?:음|다)?/iu],
];
const languageRules: readonly Rule<NoteLanguage>[] = [
  ['한국어', /한국어/iu],
  ['영어', /영어/iu],
  ['중국어', /중국어/iu],
  ['베트남어', /베트남어/iu],
  ['수어', /수어/iu],
];
const healthRules = [
  ['dementia', /치매|\bdementia\b/iu],
  ['dialysis', /투석|\bdialysis\b/iu],
  ['insulin', /인슐린|\binsulin\b/iu],
  ['visual_impairment', /시각\s*장애|시력\s*장애/iu],
] as const;

// These strings are records to inspect. They are never commands or executable code.
const instruction =
  /무시(?:하|해|하고)|명령\s*[:：]|지시\s*[:：]|(?:실행|적용|변경|설정|판정|출력|응답|추정)(?:하라|해라|하세요|해\s*줘|하시오)|\b(?:ignore|system|assistant|prompt|execute|eval)\b/iu;
const uncertain = /[?？]|예정|계획|의심|추정|가능성|불확실|과거|예전|이력|중단/iu;

function sourceTexts(input: HouseholdNoteInput): Source[] {
  const entries: Source[] = [];
  const add = (source: Source['source'], text: unknown, index: number | null = null) => {
    if (text === null || text === undefined) return;
    if (typeof text !== 'string' || text.length > 10000)
      throw new TypeError('비고 원문은 10000자 이하의 문자열이어야 합니다.');
    entries.push({ source, text, index });
  };
  add('note', input.note);
  if (Array.isArray(input.health)) {
    if (input.health.length > 50) throw new TypeError('건강 원문은 최대 50개입니다.');
    input.health.forEach((text, index) => add('health', text, index));
  } else add('health', input.health);
  add('mobility', input.mobility);
  if (
    input.age !== undefined &&
    input.age !== null &&
    (!Number.isInteger(input.age) || input.age < 0 || input.age > 130)
  )
    throw new TypeError('기존 연령은 0~130의 정수여야 합니다.');
  return entries;
}

function observations<T extends string>(
  sources: Source[],
  rules: readonly Rule<T>[],
): NoteEvidence[] {
  const found: NoteEvidence[] = [];
  for (const source of sources) {
    // Preserve original offsets while keeping negation local to a comma-separated fact.
    for (const chunk of source.text.matchAll(/[^,;。\n/.!?？]+[.!?？]?/gu)) {
      const text = chunk[0].trim();
      if (instruction.test(text)) continue;
      for (const [value, pattern] of rules) {
        if (value !== 'unknown' && uncertain.test(text)) continue;
        for (const match of text.matchAll(new RegExp(pattern.source, 'giu'))) {
          const before = text.slice(0, match.index);
          const after = text.slice(match.index + match[0].length);
          if (
            /(?:안|없는|아닌|미사용)\s*$|\b(?:no|not|without|denies|denied)(?:\s+(?:require|use|have|need|receive|signs|of|on)){0,3}\s*$/iu.test(
              before,
            ) ||
            /^\s*(?:(?:장비|발생기|보조)?(?:를|을|은|는|이|가|도)?\s*)?(?:(?:필요|사용|보유|투여|복용|치료|진단받|진단을\s*받|진단|증상|여부|받|쓰|써)\s*)?(?:없|없이|아니|아닌|아님|아닙|아냐|미사용|불필요|불명|미확인|확인\s*필요|모름|모르|못|않|안\s*(?:함|씀|쓰|쓴|써|사용)|(?:하지|지)\s*(?:않|못)|absent\b|negative\b|unknown\b|not\b)/iu.test(
              after,
            )
          )
            continue;
          const left = chunk[0].length - chunk[0].trimStart().length;
          const quote = text;
          const start = chunk.index! + left;
          found.push({
            source: source.source,
            index: source.index,
            quote,
            start,
            end: start + quote.length,
            value,
          });
          break;
        }
      }
    }
  }
  return found;
}

/** Pure rule fallback for P-4. Missing or conflicting facts never become confirmations. */
export function parseHouseholdNotes(input: HouseholdNoteInput): StructuredHouseholdNotes {
  const sources = sourceTexts(input);
  const evidence: StructuredHouseholdNotes['evidence'] = {};
  const unknown_fields: StructuredHouseholdNotes['unknown_fields'] = [];
  const scalar = <T extends string>(field: NoteField, rules: readonly Rule<T>[]): T | 'unknown' => {
    let facts = observations(sources, rules);
    // A guardian's mobile number is not a second, resident-owned mobile contact.
    if (field === 'contact')
      facts = facts.filter(
        (fact) =>
          fact.value !== 'mobile' ||
          !facts.some(
            (other) =>
              other.value === 'mobile_guardian' &&
              other.source === fact.source &&
              other.index === fact.index &&
              other.start === fact.start,
          ),
      );
    if (facts.length) evidence[field] = facts;
    const values = new Set(facts.map((fact) => fact.value));
    if (values.size !== 1 || values.has('unknown')) {
      unknown_fields.push(field);
      return 'unknown';
    }
    return facts[0].value as T;
  };
  const mobility = scalar('mobility', mobilityRules);
  const devicesEvidence = observations(sources, deviceRules);
  const noDevices = observations(sources, [
    ['none', /(?:보조\s*|의료\s*)?장비\s*(?:없음|없다|불필요)/iu],
  ]);
  const devices = [...new Set(devicesEvidence.map((fact) => fact.value as NoteDevice))];
  if (devicesEvidence.length || noDevices.length)
    evidence.devices = [...devicesEvidence, ...noDevices];
  if ((!devices.length && !noDevices.length) || (devices.length && noDevices.length))
    unknown_fields.push('devices');
  const cognition = scalar('cognition', cognitionRules);
  const cohabitant = scalar('cohabitant', cohabitantRules);
  const vehicle = scalar('vehicle', vehicleRules);
  const contact = scalar('contact', contactRules);
  const pets = scalar('pets', petRules);
  const language = scalar('language', languageRules);
  const healthEvidence = observations(sources, healthRules);
  const gradeEvidence = [
    ...(evidence.mobility ?? []).filter((fact) => fact.value !== 'independent'),
    ...devicesEvidence,
    ...(evidence.contact ?? []).filter((fact) => fact.value === 'none'),
    ...(evidence.cohabitant ?? []).filter((fact) => fact.value === 'alone'),
    ...healthEvidence,
  ];
  if (gradeEvidence.length) evidence.vulnerability = gradeEvidence;
  if (input.age === undefined || input.age === null) unknown_fields.push('age');
  const base = vulnerability({
    age: input.age ?? 0,
    mobility: { independent: '자력', assisted: '보조', bedridden: '와상', unknown: '불명' }[
      mobility
    ],
    devices,
    phoneKind: contact === 'none' ? '없음' : '불명',
    cohabitant: cohabitant === 'alone' ? '독거' : '불명',
  });
  return {
    mobility,
    devices,
    cognition,
    cohabitant,
    vehicle,
    contact,
    pets,
    language,
    vulnerability: Math.max(base, healthEvidence.length ? 3 : 1) as NoteGrade,
    estimated: unknown_fields.length > 0,
    evidence,
    unknown_fields,
    executionMode: 'rules',
  };
}
