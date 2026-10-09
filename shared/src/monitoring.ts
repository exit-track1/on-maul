import type { Fixtures, Scenario } from './types.ts';
import {
  createReplaySourceRecord,
  evaluateSourceFreshness,
  planMonitoring,
  sourceStatusFromRecords,
  validatePredictionSources,
  type MonitoringPolicy,
  type SourceClocks,
  type SourceRecord,
} from './sources.ts';

export interface SourceState {
  records: SourceRecord[];
  policies: Record<string, MonitoringPolicy>;
  wallNow: string;
  actualModelCalls: number;
}
type Context = { data: Fixtures; scenario: Scenario; sourceState: SourceState };
export const DEMO_DATASET = 'onmaul-own-synthetic/20261009';
export const DEMO_JURISDICTION = 'DEMO-ONBIT';

export function createSourceState(
  data: Fixtures,
  scenario: Scenario,
  wallNow: string,
): SourceState {
  const policies = Object.fromEntries(
    data.sources.map((s) => [
      s.id,
      {
        pollSeconds: s.demoRefreshSeconds,
        freshnessMaxAgeSeconds: s.demoRefreshSeconds * 2,
        jurisdiction: { id: DEMO_JURISDICTION, revision: 1, areas: [DEMO_JURISDICTION] },
      },
    ]),
  );
  const state: SourceState = { records: [], policies, wallNow, actualModelCalls: 0 };
  if (scenario.mode !== 'idle')
    state.records = data.sources.map((source, i) =>
      createReplaySourceRecord(source, {
        recordId: `SOURCE-${scenario.id}-${i + 1}`,
        scenarioId: scenario.id,
        datasetId: DEMO_DATASET,
        referenceDate: data.metadata.referenceDate,
        fetchedAtWall: wallNow,
        fetchedAtReplay: scenario.displayTime,
        jurisdictions: [DEMO_JURISDICTION],
      }),
    );
  return state;
}
export function sourceClocks(view: Context): SourceClocks {
  return {
    wallNow: view.sourceState.wallNow,
    replay: {
      now: view.scenario.displayTime,
      scenarioId: view.scenario.id,
      datasetId: DEMO_DATASET,
      referenceDate: view.data.metadata.referenceDate,
    },
  };
}
export function sourceReadings(view: Context) {
  return view.data.sources.map((source) => ({
    source,
    status: sourceStatusFromRecords(
      view.sourceState.records,
      source.id,
      view.sourceState.policies[source.id]!,
      sourceClocks(view),
    ),
  }));
}
export function sourceMonitor(view: Context) {
  const latest = view.data.sources
    .map((s) => view.sourceState.records.findLast((r) => r.sourceId === s.id))
    .filter((r): r is SourceRecord => Boolean(r));
  return planMonitoring(latest, view.sourceState.policies, sourceClocks(view));
}

/** The demo spread formula consumes wind only. Other feeds are never silently mixed into its evidence. */
export function predictionEvidence(view: Context) {
  const wind = view.sourceState.records.findLast((r) => r.sourceId === 'SRC05');
  const result = validatePredictionSources(
    wind ? [wind] : [],
    view.sourceState.policies,
    sourceClocks(view),
    {
      mode: 'replay',
      scenarioId: view.scenario.id,
      datasetId: DEMO_DATASET,
      referenceDate: view.data.metadata.referenceDate,
      requiredSourceIds: ['SRC05'],
    },
  );
  const policy = view.sourceState.policies.SRC05;
  if (
    wind &&
    (!policy || !wind.jurisdictions.some((area) => policy.jurisdiction.areas.includes(area)))
  )
    result.reasons.push('SRC05:outside-jurisdiction');
  result.usable = result.reasons.length === 0;
  result.etaMustRemainUnknown = !result.usable;
  return result;
}

export function validReplayCount(view: Context) {
  return sourceReadings(view).filter(
    ({ status }) => status?.status === 'replay' && status.freshness.usable,
  ).length;
}

export function sourceIsFresh(view: Context, record: SourceRecord) {
  const policy = view.sourceState.policies[record.sourceId];
  return policy ? evaluateSourceFreshness(record, policy, sourceClocks(view)).usable : false;
}
