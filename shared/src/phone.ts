export type PhoneTargetId = 'H012' | 'M01';
export type PhoneScenario = 'resident' | 'standby';
export type PhoneStatus =
  'requesting' | 'created' | 'ringing' | 'answered' | 'ending' | 'ended' | 'failed' | 'unknown';

export interface PhoneTarget {
  id: PhoneTargetId;
  name: string;
  scenario: PhoneScenario;
  configured: boolean;
  phoneMasked: string;
  consent: boolean;
}

export interface PhoneCompletion {
  status: 'reported' | 'needs_review';
  location: string;
  evidence: string;
  recordedAt: number;
  playbackConfirmed: boolean;
  correction?: string;
  kind?: 'evacuation' | 'rescue' | 'moving' | 'refused' | 'review' | 'standby';
  closingText?: string;
  assessment?: {
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
  standbyAssessment?: {
    state: 'pending' | 'ready' | 'unavailable';
    participationEvidence: string;
    vehicleEvidence: string;
    readinessEvidence: string;
    evidence: string;
    confidence: number;
  };
}

export interface PhoneCall {
  id: string;
  requestId: string;
  targetId: PhoneTargetId;
  targetName: string;
  scenario: PhoneScenario;
  providerId: string | null;
  status: PhoneStatus;
  blocked: boolean;
  requestedAt: number | null;
  answeredAt: number | null;
  endedAt: number | null;
  transcript: { speaker: 'assistant' | 'user'; text: string }[];
  completion?: PhoneCompletion;
  error?: { code: string; message: string; action: string };
  notice: string;
}

export interface PhoneState {
  enabled: boolean;
  ready: boolean;
  busy: boolean;
  notice: string;
  targets: PhoneTarget[];
  calls: PhoneCall[];
}

export interface PhoneUpdate {
  requestId: string;
  call: PhoneCall;
}
