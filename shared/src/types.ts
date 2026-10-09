export type Status =
  | 'before'
  | 'queued'
  | 'calling'
  | 'guided'
  | 'moving'
  | 'dispatched'
  | 'sent119'
  | 'help'
  | 'refuse'
  | 'visiting'
  | 'noanswer'
  | 'unclear'
  | 'e119'
  | 'safe'
  | 'rescued'
  | 'visit'
  | 'pendingunknown'
  | 'redial';
export type Group = 'act' | 'prog' | 'safe' | 'visit' | 'before' | 'excluded';
export type Mode = 'idle' | 'watch' | 'event' | 'record';
export interface Point {
  x: number;
  y: number;
}
export interface Household {
  id: string;
  name: string;
  age: number;
  gender: string;
  priorityGrade: number;
  mobility: string;
  healthNotes: string[];
  zoneId: string;
  addressLabel: string;
  phoneKind: string;
  contactRef: string | null;
  guardian: { relationship: string; name: string; contactRef: string } | null;
  consentToCall: boolean;
  callEligible: boolean;
  exclusionReason: string | null;
  sourceType: string;
  lastCheckedAt: string | null;
  originalNote: string;
  demoPosition: Point;
  teamId: string;
  shelterId: string;
  cohabitant: string;
  devices: string[];
  synthetic: boolean;
}
export interface Member {
  id: string;
  name: string;
  roleLabel: string;
  canDrive: boolean;
  availability: string;
  reason: string | null;
  synthetic: boolean;
}
export interface Team {
  id: string;
  zoneId: string;
  name: string;
  vehicleId: string;
  members: Member[];
  assignedHouseholdIds: string[];
  meetingPoint: Point;
  synthetic: boolean;
}
export interface Vehicle {
  id: string;
  name: string;
  kind: string;
  organizationLabel: string;
  plateLabel: string;
  capacity: number;
  equipment: string[];
  driverRef: string;
  teamId: string | null;
  availableForTransport: boolean;
  unavailableReason: string | null;
  synthetic: boolean;
}
export interface Shelter {
  id: string;
  name: string;
  type: string;
  capacity: number;
  demoLocation: Point;
  accessibility: string;
  petsAllowed: boolean;
  synthetic: boolean;
}
export interface Zone {
  id: string;
  label: string;
  teamId: string;
  shelterId: string;
  householdCount: number;
  predictedArrivalMinutes: number;
  demoBounds: { x1: number; y1: number; x2: number; y2: number };
  synthetic: boolean;
}
export interface Source {
  id: string;
  category: string;
  name: string;
  demoRefreshSeconds: number;
  demoPayload: {
    schema: string;
    summary: string;
    observedAt: string;
    windDirection: number | null;
    windSpeedMps: number | null;
    value: number | null;
  };
  synthetic: boolean;
}
export interface HouseholdStatus {
  householdId: string;
  status: Status;
  lastChangedAt: string;
  note: string;
  attemptCount: number;
  acked: boolean;
  visitCompleted: boolean;
  handoffStatus: string | null;
  temporaryExclusion?: string | null;
  recheckOverdue?: boolean;
  callbackAtSim?: number | null;
  companions?: { id: string; label: string; mobility: string; devices: string[] }[];
  dispatchHold?: string | null;
}
export interface Counts {
  total: number;
  eligible: number;
  act: number;
  prog: number;
  safe: number;
  visit: number;
  before: number;
  temporarilyExcluded: number;
}
export interface Scenario {
  id: string;
  label: string;
  displayTime: string;
  mode: Mode;
  householdStatuses: HouseholdStatus[];
  counts: Counts;
  pendingReviewIds: string[];
  resourceStatuses: { vehicleId: string; status: string; householdId: string | null }[];
  sourceStatuses: {
    sourceId: string;
    status: string;
    mode: string;
    observedAt: string;
    summary: string;
  }[];
  synthetic: boolean;
}
export interface RecordItem {
  id: string;
  scenarioId: string;
  timestamp: string;
  actorType: string;
  label: string;
  householdId?: string;
  teamId?: string;
  vehicleId?: string;
  synthetic: boolean;
}
export interface CheckLog {
  id: string;
  householdId: string;
  sourceType: string;
  checkedAt: string;
  checkedFields: string[];
  changed: Record<string, unknown> | null;
  operatorLabel: string;
  evidence: string;
  synthetic: boolean;
}
export interface Transcript {
  id: string;
  householdId: string;
  scenarioId: string;
  turns: { sequence: number; speaker: string; text: string; offsetSeconds: number }[];
  synthetic: boolean;
}
export interface Fixtures {
  metadata: {
    schemaVersion: string;
    synthetic: boolean;
    seed: number;
    referenceDate: string;
    timeZone: string;
    description: string;
    recordCounts: Record<string, number>;
    countingRules: Record<string, unknown>;
  };
  households: Household[];
  teams: Team[];
  vehicles: Vehicle[];
  zones: Zone[];
  shelters: Shelter[];
  sources: Source[];
  scenarios: Scenario[];
  responseCases: {
    id: string;
    label: string;
    fictionalUtterance: string;
    demoOutcome: string;
    needsHumanReview: boolean;
    synthetic: boolean;
  }[];
  callTranscripts: Transcript[];
  eventLogs: RecordItem[];
  checkLogs: CheckLog[];
  map: {
    width: number;
    height: number;
    metersPerPixel: number;
    ignition: Point;
    office: Point;
    wind: { direction: number; speedMps: number };
    roads: { id: string; label: string; blocked: boolean; points: number[][] }[];
    river: number[][];
    synthetic: boolean;
  };
}
