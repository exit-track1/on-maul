import { z } from 'zod';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivate } from './config.ts';
export const outcomeSchema = z.object({
  callId: z.uuid(),
  sessionId: z.string().nullable(),
  phone: z.string(),
  scenario: z.enum(['resident', 'standby']),
  completion: z.object({
    status: z.enum(['reported', 'needs_review']),
    location: z.string(),
    evidence: z.string().min(1),
    recordedAt: z.number(),
    playbackConfirmed: z.boolean(),
    correction: z.string().optional(),
    targetId: z.string().optional(),
    scenarioCallId: z.string().optional(),
    kind: z.enum(['evacuation', 'rescue', 'moving', 'refused', 'review', 'standby']).optional(),
    closingText: z.string().optional(),
    standbyAssessment: z
      .object({
        state: z.enum(['pending', 'ready', 'unavailable']),
        participationEvidence: z.string(),
        vehicleEvidence: z.string(),
        readinessEvidence: z.string(),
        evidence: z.string(),
        confidence: z.number().min(0).max(1),
      })
      .optional(),
    assessment: z
      .object({
        stage: z.enum(['location', 'mobility', 'condition', 'done']),
        location: z.string(),
        shelterName: z.string().default('온빛 배움학교'),
        mobility: z.enum(['possible', 'needs_help', 'unknown']),
        condition: z.enum(['comfortable', 'uncomfortable', 'unknown']),
        refusal: z.enum(['refused', 'willing', 'unknown']).default('unknown'),
        emergency: z.boolean(),
        answers: z.array(z.object({ question: z.string(), text: z.string() })),
        reason: z.string(),
      })
      .optional(),
  }),
  callStatus: z.string(),
  endedAt: z.number().nullable(),
});
export type CallOutcome = z.infer<typeof outcomeSchema>;
export type Completion = CallOutcome['completion'];
export class CallOutcomeStore {
  directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  save(outcome: CallOutcome) {
    const valid = outcomeSchema.parse(outcome);
    writePrivate(join(this.directory, valid.callId + '.json'), valid);
  }
  list() {
    if (!existsSync(this.directory)) return [];
    const outcomes: CallOutcome[] = [];
    for (const name of readdirSync(this.directory).filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))) {
      try {
        outcomes.push(
          outcomeSchema.parse(JSON.parse(readFileSync(join(this.directory, name), 'utf8'))),
        );
      } catch {
        /* preserve unreadable files for operator review */
      }
    }
    return outcomes.sort((a, b) => b.completion.recordedAt - a.completion.recordedAt).slice(0, 50);
  }
}
