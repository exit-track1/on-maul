import type { Source } from './types.ts';

/** This contract describes our own demo records, not a government API format. */
export type SourceMode = 'live' | 'replay';
export type SourceOrigin =
  'synthetic' | 'reconstructed' | 'recorded-live' | 'live-response' | 'simulated-live-failure';
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface DisasterSignals {
  text?: string;
  windSpeedMps?: number | null;
  extinguishmentDropPercentPoints?: number | null;
  waterLevel?: 'normal' | 'attention' | 'warning' | 'danger' | null;
  weatherAlert?: 'watch' | 'warning' | null;
}
export interface SourceRecordInput {
  recordId: string;
  sourceId: string;
  scenarioId: string | null;
  datasetId: string;
  referenceDate: string;
  mode: SourceMode;
  origin: SourceOrigin;
  sampleId: string | null;
  observedAt: string | null;
  fetchedAt: { wall: string | null; replay: string | null };
  jurisdictions: readonly string[];
  payload: JsonValue;
  signals?: DisasterSignals;
  ok: boolean;
  error?: string | null;
  fallbackForRecordId?: string | null;
}
export interface SourceRecord extends Omit<
  SourceRecordInput,
  'signals' | 'error' | 'fallbackForRecordId'
> {
  signals: Readonly<DisasterSignals>;
  error: string | null;
  fallbackForRecordId: string | null;
  payloadHash: string;
}
export interface SourceClocks {
  wallNow: string;
  replay?: { now: string; scenarioId: string; datasetId: string; referenceDate: string };
}
export interface FreshnessPolicy {
  pollSeconds: number;
  freshnessMaxAgeSeconds?: number;
}
export interface MonitoringPolicy extends FreshnessPolicy {
  jurisdiction: { id: string; revision: string | number; areas: readonly string[] };
  disasterKeywords?: readonly string[];
  thresholds?: { windSpeedMps?: number; extinguishmentDropPercentPoints?: number };
}
export interface SourceFreshness {
  state: 'fresh' | 'stale' | 'unknown' | 'failed';
  usable: boolean;
  stale: boolean;
  reason: string | null;
  clockMode: SourceMode;
  evaluatedAt: string | null;
  ageSeconds: number | null;
  maxAgeSeconds: number | null;
}
const DEFAULT_KEYWORDS = ['산불', '대피', '강풍', '건조', '호우', '통제', '진화율'];

/** Sorted JSON keys, preserving array order; reject non-JSON values rather than silently dropping them. */
export function canonicalJson(value: JsonValue): string {
  const parents = new Set<object>();
  function encode(item: JsonValue): string {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item))
        throw new Error('Source payload must contain finite JSON numbers.');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new Error('Source payload must be JSON.');
    if (parents.has(item)) throw new Error('Source payload must not be cyclic.');
    parents.add(item);
    let encoded: string;
    if (Array.isArray(item)) {
      const entries: string[] = [];
      for (let i = 0; i < item.length; i++) {
        if (!(i in item)) throw new Error('Source payload must not contain sparse arrays.');
        entries.push(encode(item[i]!));
      }
      encoded = '[' + entries.join(',') + ']';
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error('Source payload must contain plain JSON objects.');
      encoded =
        '{' +
        Object.keys(item)
          .sort()
          .map((key) => JSON.stringify(key) + ':' + encode(item[key]!))
          .join(',') +
        '}';
    }
    parents.delete(item);
    return encoded;
  }
  return encode(value);
}

/** Non-cryptographic 64-bit fingerprint; collisions are possible. Never use it as an authenticity proof. */
export function demoPayloadFingerprint(canonicalPayload: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(canonicalPayload)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return 'fnv1a64:' + hash.toString(16).padStart(16, '0');
}

function freezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** No clock reads or I/O; callers supply every timestamp. Hash injection can supply a precomputed SHA-256. */
export function createSourceRecord(
  input: SourceRecordInput,
  hashPayload: (canonicalPayload: string) => string = demoPayloadFingerprint,
): SourceRecord {
  for (const value of [input.recordId, input.sourceId, input.datasetId])
    if (typeof value !== 'string' || !value.trim())
      throw new Error('Source record IDs must be explicit.');
  if (
    !['live', 'replay'].includes(input.mode) ||
    ![
      'synthetic',
      'reconstructed',
      'recorded-live',
      'live-response',
      'simulated-live-failure',
    ].includes(input.origin)
  )
    throw new Error('Source mode and origin must be explicit.');
  if (
    typeof input.ok !== 'boolean' ||
    !input.jurisdictions.every((area) => typeof area === 'string')
  )
    throw new Error('Source outcome and jurisdiction tags must be explicit.');
  if (!validReferenceDate(input.referenceDate))
    throw new Error('Source referenceDate must be a valid date.');
  if (input.mode === 'replay' && (!input.scenarioId?.trim() || !input.sampleId?.trim()))
    throw new Error('Replay records require scenario and sample IDs.');
  if (input.mode === 'live' && input.ok && input.origin !== 'live-response')
    throw new Error('Synthetic or reconstructed records cannot claim a successful live response.');
  if (input.mode === 'replay' && ['live-response', 'simulated-live-failure'].includes(input.origin))
    throw new Error('Replay records must retain replay provenance.');
  const canonicalPayload = canonicalJson(input.payload);
  const payloadHash = hashPayload(canonicalPayload);
  if (typeof payloadHash !== 'string' || !payloadHash.trim())
    throw new Error('Payload hash is required.');
  return Object.freeze({
    ...input,
    payload: freezeJson(JSON.parse(canonicalPayload) as JsonValue),
    fetchedAt: Object.freeze({ ...input.fetchedAt }),
    jurisdictions: Object.freeze([...input.jurisdictions]),
    signals: Object.freeze({ ...input.signals }),
    error: input.ok ? (input.error ?? null) : input.error?.trim() || '수집 실패',
    fallbackForRecordId: input.fallbackForRecordId ?? null,
    payloadHash,
  });
}

export function createReplaySourceRecord(
  source: Source,
  context: {
    recordId: string;
    scenarioId: string;
    datasetId: string;
    referenceDate: string;
    fetchedAtWall: string | null;
    fetchedAtReplay: string | null;
    jurisdictions: readonly string[];
    sampleId?: string;
    fallbackForRecordId?: string;
  },
): SourceRecord {
  if (!source.synthetic || source.demoPayload.schema !== 'onmaul-demo/v1')
    throw new Error('This adapter only accepts the own synthetic demo schema.');
  return createSourceRecord({
    recordId: context.recordId,
    sourceId: source.id,
    scenarioId: context.scenarioId,
    datasetId: context.datasetId,
    referenceDate: context.referenceDate,
    mode: 'replay',
    origin: 'synthetic',
    sampleId: context.sampleId ?? source.id + ':demoPayload',
    observedAt: source.demoPayload.observedAt,
    fetchedAt: { wall: context.fetchedAtWall, replay: context.fetchedAtReplay },
    jurisdictions: context.jurisdictions,
    payload: source.demoPayload,
    signals: { text: source.demoPayload.summary, windSpeedMps: source.demoPayload.windSpeedMps },
    ok: true,
    fallbackForRecordId: context.fallbackForRecordId,
  });
}

function validReferenceDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && parseTimestamp(value + 'T00:00:00Z') !== null;
}

/** Require timezone-bearing ISO timestamps and reject calendar rollovers such as February 30. */
function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return null;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    zone,
    sign,
    zoneHour,
    zoneMinute,
  ] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  if (
    year! < 1000 ||
    month! < 1 ||
    month! > 12 ||
    day! < 1 ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59
  )
    return null;
  if (day! > new Date(Date.UTC(year!, month!, 0)).getUTCDate()) return null;
  const offsetHour = Number(zoneHour ?? 0),
    offsetMinute = Number(zoneMinute ?? 0);
  if (
    zone !== 'Z' &&
    (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0))
  )
    return null;
  const parsed = Date.parse(value);
  const offset = (sign === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  const local = new Date(parsed + offset * 60000);
  return Number.isFinite(parsed) && local.getUTCFullYear() === year ? parsed : null;
}

export function evaluateSourceFreshness(
  record: SourceRecord,
  policy: FreshnessPolicy,
  clocks: SourceClocks,
): SourceFreshness {
  const maxAge = policy.freshnessMaxAgeSeconds ?? policy.pollSeconds * 2;
  const evaluatedAt = record.mode === 'live' ? clocks.wallNow : (clocks.replay?.now ?? null);
  const base = {
    clockMode: record.mode,
    evaluatedAt,
    maxAgeSeconds: Number.isFinite(maxAge) ? maxAge : null,
    ageSeconds: null,
  };
  const fail = (reason: string, state: SourceFreshness['state'] = 'unknown'): SourceFreshness => ({
    ...base,
    state,
    usable: false,
    stale: true,
    reason,
  });
  if (!record.ok) return fail('source-failed', 'failed');
  if (record.payload === null) return fail('missing-payload');
  if (
    !Number.isFinite(policy.pollSeconds) ||
    policy.pollSeconds <= 0 ||
    !Number.isFinite(maxAge) ||
    maxAge < 0
  )
    return fail('invalid-freshness-policy');
  if (record.mode === 'live' && record.origin !== 'live-response')
    return fail('origin-mode-mismatch');
  if (record.mode === 'replay') {
    if (!clocks.replay) return fail('missing-replay-clock');
    if (
      record.datasetId !== clocks.replay.datasetId ||
      record.scenarioId !== clocks.replay.scenarioId ||
      record.referenceDate !== clocks.replay.referenceDate
    )
      return fail('replay-clock-context-mismatch');
  }
  const now = parseTimestamp(evaluatedAt);
  if (now === null) return fail('invalid-evaluation-clock');
  if (!record.observedAt) return fail('missing-observed-time');
  const observed = parseTimestamp(record.observedAt);
  if (observed === null) return fail('invalid-observed-time');
  const fetchedAt = record.mode === 'live' ? record.fetchedAt.wall : record.fetchedAt.replay;
  if (!fetchedAt) return fail('missing-fetched-time');
  const fetched = parseTimestamp(fetchedAt);
  if (fetched === null) return fail('invalid-fetched-time');
  if (observed > now) return fail('future-observed-time');
  if (fetched > now) return fail('future-fetched-time');
  if (observed > fetched) return fail('observation-after-fetch');
  const ageSeconds = (now - observed) / 1000;
  if (ageSeconds > maxAge) return { ...fail('stale-observation', 'stale'), ageSeconds };
  return { ...base, state: 'fresh', usable: true, stale: false, reason: null, ageSeconds };
}

function normalized(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
function terms(values: readonly string[]): string[] {
  return [...new Set(values.map(normalized).filter(Boolean))].sort();
}
function signalText(record: SourceRecord): string {
  const summary =
    record.payload !== null && !Array.isArray(record.payload) && typeof record.payload === 'object'
      ? record.payload.summary
      : null;
  return normalized(
    typeof record.signals.text === 'string'
      ? record.signals.text
      : typeof summary === 'string'
        ? summary
        : '',
  );
}

/** The full canonical payload is included so even an injected colliding hash cannot alias different inputs. */
export function sourceModelCacheKey(record: SourceRecord, policy: MonitoringPolicy): string {
  return (
    'onmaul-monitor/v1:' +
    canonicalJson({
      sourceId: record.sourceId,
      payloadHash: record.payloadHash,
      payload: record.payload,
      signals: {
        text: signalText(record),
        windSpeedMps: record.signals.windSpeedMps ?? null,
        extinguishmentDropPercentPoints: record.signals.extinguishmentDropPercentPoints ?? null,
        waterLevel: record.signals.waterLevel ?? null,
        weatherAlert: record.signals.weatherAlert ?? null,
      },
      jurisdictions: terms(record.jurisdictions),
      observedAt: record.observedAt,
      sampleId: record.sampleId,
      scenarioId: record.scenarioId,
      datasetId: record.datasetId,
      referenceDate: record.referenceDate,
      mode: record.mode,
      origin: record.origin,
      jurisdiction: {
        id: policy.jurisdiction.id,
        revision: policy.jurisdiction.revision,
        areas: terms(policy.jurisdiction.areas),
      },
      keywords: terms(policy.disasterKeywords ?? DEFAULT_KEYWORDS),
      thresholds: {
        windSpeedMps: policy.thresholds?.windSpeedMps ?? 10,
        extinguishmentDropPercentPoints: policy.thresholds?.extinguishmentDropPercentPoints ?? 10,
      },
      pollSeconds: policy.pollSeconds,
      freshnessMaxAgeSeconds: policy.freshnessMaxAgeSeconds ?? policy.pollSeconds * 2,
    })
  );
}

export function evaluateMonitoringRecord(
  record: SourceRecord,
  policy: MonitoringPolicy,
  clocks: SourceClocks,
) {
  const freshness = evaluateSourceFreshness(record, policy, clocks);
  const allowedAreas = terms(policy.jurisdiction.areas);
  const jurisdictionMatched =
    allowedAreas.length > 0 &&
    terms(record.jurisdictions).some((area) => allowedAreas.includes(area));
  const windThreshold = policy.thresholds?.windSpeedMps ?? 10;
  const dropThreshold = policy.thresholds?.extinguishmentDropPercentPoints ?? 10;
  const validThresholds = [windThreshold, dropThreshold].every((n) => Number.isFinite(n) && n >= 0);
  const signals = record.signals;
  const validSignals =
    (signals.text === undefined || typeof signals.text === 'string') &&
    [signals.windSpeedMps, signals.extinguishmentDropPercentPoints].every(
      (n) => n == null || (typeof n === 'number' && Number.isFinite(n) && n >= 0),
    ) &&
    (signals.waterLevel == null ||
      ['normal', 'attention', 'warning', 'danger'].includes(signals.waterLevel)) &&
    (signals.weatherAlert == null || ['watch', 'warning'].includes(signals.weatherAlert));
  const text = signalText(record);
  const disasterMatched =
    validThresholds &&
    validSignals &&
    (terms(policy.disasterKeywords ?? DEFAULT_KEYWORDS).some((keyword) => text.includes(keyword)) ||
      (typeof signals.windSpeedMps === 'number' &&
        Number.isFinite(signals.windSpeedMps) &&
        signals.windSpeedMps >= windThreshold) ||
      (typeof signals.extinguishmentDropPercentPoints === 'number' &&
        Number.isFinite(signals.extinguishmentDropPercentPoints) &&
        signals.extinguishmentDropPercentPoints >= dropThreshold) ||
      ['attention', 'warning', 'danger'].includes(signals.waterLevel ?? '') ||
      signals.weatherAlert === 'warning');
  const reasons: string[] = [];
  if (!freshness.usable) reasons.push(freshness.reason!);
  if (!jurisdictionMatched)
    reasons.push(allowedAreas.length ? 'outside-jurisdiction' : 'jurisdiction-not-configured');
  if (!validThresholds) reasons.push('invalid-threshold-policy');
  if (!validSignals) reasons.push('invalid-source-signals');
  if (!disasterMatched) reasons.push('no-disaster-signal');
  const eligibleForModel = reasons.length === 0;
  return {
    recordId: record.recordId,
    eligibleForModel,
    jurisdictionMatched,
    disasterMatched,
    freshness,
    reasons,
    cacheKey: eligibleForModel ? sourceModelCacheKey(record, policy) : null,
  };
}

/** Eligibility is a planned count, never a claim that a model was called. Filter before incrementing a real counter. */
export function planMonitoring(
  records: readonly SourceRecord[],
  policies: Readonly<Record<string, MonitoringPolicy>>,
  clocks: SourceClocks,
) {
  const evaluations = records.map((record) => {
    const policy = policies[record.sourceId];
    return policy
      ? evaluateMonitoringRecord(record, policy, clocks)
      : {
          recordId: record.recordId,
          eligibleForModel: false,
          jurisdictionMatched: false,
          disasterMatched: false,
          freshness: null,
          reasons: ['missing-source-policy'],
          cacheKey: null,
        };
  });
  const eligibleRecords = records.filter((_, index) => evaluations[index]!.eligibleForModel);
  return { evaluations, eligibleRecords, eligibleModelCallCount: eligibleRecords.length };
}

/** Append-only history; a fallback is another record and cannot replace its failed live parent. */
export function appendSourceAttempt(
  records: readonly SourceRecord[],
  record: SourceRecord,
): SourceRecord[] {
  if (records.some((prior) => prior.recordId === record.recordId))
    throw new Error('Duplicate source record ID.');
  if (record.fallbackForRecordId) {
    const failed = records.find((prior) => prior.recordId === record.fallbackForRecordId);
    if (
      record.mode !== 'replay' ||
      !failed ||
      failed.mode !== 'live' ||
      failed.ok ||
      failed.sourceId !== record.sourceId
    )
      throw new Error(
        'Fallback must reference a preserved failed live attempt for the same source.',
      );
  }
  return [...records, record];
}

/** Compatible sourceStatuses base fields plus explicit provenance and independent live/replay outcomes. */
export function sourceStatusFromRecords(
  records: readonly SourceRecord[],
  sourceId: string,
  policy: FreshnessPolicy,
  clocks: SourceClocks,
) {
  const own = records.filter((record) => record.sourceId === sourceId);
  const latest = own.at(-1);
  if (!latest) return null;
  const live = own.filter((record) => record.mode === 'live').at(-1);
  const replay = own.filter((record) => record.mode === 'replay').at(-1);
  const freshness = evaluateSourceFreshness(latest, policy, clocks);
  const liveFreshness = live ? evaluateSourceFreshness(live, policy, clocks) : null;
  const replayFreshness = replay ? evaluateSourceFreshness(replay, policy, clocks) : null;
  const liveAttemptStatus = !live
    ? 'not-attempted'
    : !live.ok
      ? 'failed'
      : liveFreshness!.usable
        ? 'received'
        : 'unusable';
  const replayStatus = !replay ? 'not-replayed' : replayFreshness!.usable ? 'replayed' : 'unusable';
  const status =
    liveAttemptStatus === 'failed'
      ? 'fail'
      : !latest.ok
        ? 'fail'
        : freshness.usable
          ? latest.mode === 'live'
            ? 'ok'
            : 'replay'
          : freshness.state;
  const summary =
    latest.payload !== null && !Array.isArray(latest.payload) && typeof latest.payload === 'object'
      ? latest.payload.summary
      : null;
  return {
    sourceId,
    status,
    mode: latest.mode,
    observedAt: latest.observedAt ?? '',
    summary: typeof summary === 'string' ? summary : (latest.error ?? ''),
    recordId: latest.recordId,
    origin: latest.origin,
    scenarioId: latest.scenarioId,
    datasetId: latest.datasetId,
    referenceDate: latest.referenceDate,
    fetchedAt: latest.fetchedAt,
    payloadHash: latest.payloadHash,
    freshness,
    liveAttemptStatus,
    replayStatus,
    liveRecordId: live?.recordId ?? null,
    replayRecordId: replay?.recordId ?? null,
    liveError: live?.error ?? null,
    failedLiveRecordIds: own
      .filter((record) => record.mode === 'live' && !record.ok)
      .map((record) => record.recordId),
    actualLiveSucceeded: liveAttemptStatus === 'received',
  };
}

/** ETA inputs must share one dataset, mode, scenario and reference day, and all be fresh. */
export function validatePredictionSources(
  records: readonly SourceRecord[],
  policies: Readonly<Record<string, FreshnessPolicy>>,
  clocks: SourceClocks,
  expected: {
    mode: SourceMode;
    scenarioId: string | null;
    datasetId: string;
    referenceDate: string;
    requiredSourceIds?: readonly string[];
  },
) {
  const reasons: string[] = [];
  if (!records.length) reasons.push('missing-source-records');
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.sourceId)) reasons.push(record.recordId + ':duplicate-source');
    seen.add(record.sourceId);
    if (
      record.mode !== expected.mode ||
      record.scenarioId !== expected.scenarioId ||
      record.datasetId !== expected.datasetId ||
      record.referenceDate !== expected.referenceDate
    )
      reasons.push(record.recordId + ':prediction-context-mismatch');
    const policy = policies[record.sourceId];
    if (!policy) reasons.push(record.recordId + ':missing-source-policy');
    else {
      const freshness = evaluateSourceFreshness(record, policy, clocks);
      if (!freshness.usable) reasons.push(record.recordId + ':' + freshness.reason);
    }
  }
  for (const sourceId of expected.requiredSourceIds ?? [])
    if (!seen.has(sourceId)) reasons.push(sourceId + ':missing-required-source');
  return {
    usable: reasons.length === 0,
    etaMustRemainUnknown: reasons.length !== 0,
    reasons,
    evidenceRecordIds: records.map((record) => record.recordId),
  };
}
