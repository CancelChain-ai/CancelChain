import { z } from 'zod'
import { addressSchema, signatureSchema, timestampSchema } from './primitives.js'

/**
 * A recorded run of the demo scenario on devnet (`T058`): what the API answered
 * at each stage of it, and the transactions that made those stages.
 *
 * The show falls back to it when devnet is unstable. It is a recording of
 * `/v1` responses, not a model of the screens, so the app replays it through
 * the same client and the same schemas it reads the live API with — a stage
 * cannot show something the API would not have answered.
 */

export const DEMO_SNAPSHOT_VERSION = 1

/** One recorded answer: the status as well as the body — a `404` is an answer too. */
export const recordedResponseSchema = z.object({
  status: z.number().int().min(200).max(599),
  body: z.unknown(),
})
export type RecordedResponse = z.infer<typeof recordedResponseSchema>

/** A path the app requests, query included, exactly as the API client builds it. */
export const recordedPathSchema = z.string().regex(/^\/v1\//, 'expected a /v1/ path')

export const snapshotStageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z-]*$/),
  title: z.string().min(1),
  /** What happened on chain before this stage was recorded, for the person presenting. */
  summary: z.string().min(1),
  recordedAt: timestampSchema,
  responses: z.record(recordedPathSchema, recordedResponseSchema),
})
export type SnapshotStage = z.infer<typeof snapshotStageSchema>

export const SNAPSHOT_STEP_OUTCOMES = ['confirmed', 'refused'] as const

export const snapshotStepSchema = z.object({
  /** The stage this transaction leads up to. */
  stage: z.string().min(1),
  label: z.string().min(1),
  /** Who signed it: the scenario never lets one side sign for the other. */
  signer: z.enum(['owner', 'merchant']),
  signature: signatureSchema,
  outcome: z.enum(SNAPSHOT_STEP_OUTCOMES),
  /** Why the network refused it, as `merchant-sim` reads the error; `null` when confirmed. */
  refusal: z.string().min(1).nullable(),
})
export type SnapshotStep = z.infer<typeof snapshotStepSchema>

export const demoSnapshotSchema = z
  .object({
    version: z.literal(DEMO_SNAPSHOT_VERSION),
    /** Never mainnet: the scenario runs on the merchant-sim's devnet key. */
    cluster: z.literal('devnet'),
    recordedAt: timestampSchema,
    /** The API the responses came from. */
    apiUrl: z.url(),
    owner: addressSchema,
    merchant: addressSchema,
    mint: addressSchema,
    steps: z.array(snapshotStepSchema).min(1),
    stages: z.array(snapshotStageSchema).min(1),
  })
  .superRefine((snapshot, ctx) => {
    const ids = snapshot.stages.map((stage) => stage.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['stages'], message: 'stage ids repeat' })
    }
    snapshot.steps.forEach((step, index) => {
      if (!ids.includes(step.stage)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'stage'],
          message: `no stage ${step.stage}`,
        })
      }
      if ((step.outcome === 'refused') !== (step.refusal !== null)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'refusal'],
          message: 'a refusal is named exactly when the outcome is refused',
        })
      }
    })
  })
export type DemoSnapshot = z.infer<typeof demoSnapshotSchema>
