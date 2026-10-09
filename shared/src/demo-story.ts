import type { Fixtures } from './types.ts';

export type DemoStory = 'grandfather' | 'squad';
export type DemoPhoneMode = 'mock' | 'live';
export interface Demonstration {
  story: DemoStory;
  /** Old snapshots without this field retain deterministic mock playback. */
  phoneMode?: DemoPhoneMode;
  /** Legacy snapshot field; live calls no longer hold the simulation clock. */
  phoneClockHeld?: boolean;
  /** Squad calls only the responder; the resident's request is an explicit demo assumption. */
  residentRequestAssumed?: boolean;
  /** Supporting transport crew availability is scenario setup, never a fabricated phone response. */
  transportCrewAssumed?: boolean;
  residentId: 'H012' | 'H009';
  memberId: string | null;
  vehicleId: 'V01' | 'V04';
  stage:
    | 'ready'
    | 'dialing'
    | 'talking'
    | 'assessed'
    | 'requested'
    | 'responding'
    | 'boarding'
    | 'evacuating'
    | 'completed';
  messages: {
    id: string;
    speaker: 'assistant' | 'resident' | 'member';
    text: string;
    atSim: number;
  }[];
  synthetic: true;
}

/** Deterministic overlay on the caller's private fixture clone; no I/O, timer, or state transition. */
export function configureDemoStory(
  data: Fixtures,
  story: DemoStory,
  phoneMode: DemoPhoneMode = 'mock',
): Demonstration {
  if (
    !data.metadata.synthetic ||
    !['grandfather', 'squad'].includes(story) ||
    !['mock', 'live'].includes(phoneMode)
  )
    throw new TypeError('합성 시연 데이터와 지원하는 이야기가 필요합니다.');
  const residentId = story === 'grandfather' ? 'H012' : 'H009',
    vehicleId = story === 'grandfather' ? 'V01' : 'V04',
    memberId = story === 'grandfather' ? 'M02' : 'M01',
    resident = data.households.find((household) => household.id === residentId),
    vehicle = data.vehicles.find((vehicle) => vehicle.id === vehicleId),
    team = data.teams.find((team) => team.id === 'TW'),
    member = team?.members.find((member) => member.id === memberId),
    support = team?.members.find((member) => member.id === 'M03'),
    shelter = data.shelters.find((shelter) => shelter.id === 'S2');
  if (
    !resident?.synthetic ||
    !vehicle?.synthetic ||
    !team?.synthetic ||
    !member?.synthetic ||
    !support?.synthetic ||
    !shelter?.synthetic ||
    shelter.accessibility !== 'confirmed'
  )
    throw new TypeError('시연 가구·자원·조원·접근성 확인 대피소가 필요합니다.');

  resident.name = story === 'grandfather' ? '반영환 할아버지' : '박미숙 할머니';
  resident.mobility = '보조';
  resident.devices = [];
  resident.priorityGrade = 4;
  resident.shelterId = shelter.id;
  resident.originalNote = '합성 시연 메모: 다리 통증으로 자력 대피 불가·이동 보조 필요';
  resident.healthNotes = ['합성 시연: 다리 통증·이동 보조 필요'];
  delete resident.noteExtraction;
  if (story === 'grandfather') {
    // The original north-side fixture lies beyond a closed road. This expressly
    // fictional pickup point connects to open ROAD5 without changing road controls.
    resident.demoPosition = { x: 430, y: 280 };
    vehicle.name = '구급차';
    member.roleLabel = '구급차 운전 담당';
  } else {
    resident.teamId = team.id;
    member.name = '반영환 대원';
    member.roleLabel = '5분 대기조 운전 담당';
    team.name = '서구역 5분 대기조';
    vehicle.name = '5분 대기조 차량';
    vehicle.organizationLabel = team.name;
    // The squad still needs two independently confirmed members. Runtime owns
    // their response timing; this overlay does not fabricate an available response.
    support.availability = '가능';
    support.reason = null;
  }
  member.canDrive = true;
  member.availability = '가능';
  member.reason = null;
  vehicle.driverRef = member.id;
  vehicle.availableForTransport = true;
  vehicle.unavailableReason = null;
  // Fictional scene inside the existing map. With the supplied 280°/9 m/s demo
  // wind, the western squad's initial minimum ETA exceeds 70 minutes.
  data.map.ignition = { x: 900, y: 50 };

  return {
    story,
    phoneMode,
    residentRequestAssumed: story === 'squad' && phoneMode === 'live',
    transportCrewAssumed: phoneMode === 'live',
    residentId,
    memberId,
    vehicleId,
    stage: story === 'squad' && phoneMode === 'live' ? 'requested' : 'ready',
    messages: [],
    synthetic: true,
  };
}
