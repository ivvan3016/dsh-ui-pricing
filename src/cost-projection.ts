/**
 * The `cost` session projection unit: folds provider-reported usage samples
 * into per-model per-multiplier token totals and prices them with the
 * captured pricing settings.
 */

import { z } from 'zod'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  multiplierAt, sampleCost, type PricingSettings,
} from './pricing.ts'
import type { CostState, LastSample, ModelRates, MultiplierTotals, PricedBuckets } from './projection.ts'

const bucketSchema = z.object({
  input: z.number().nonnegative(),
  cacheHit: z.number().nonnegative(),
  output: z.number().nonnegative(),
})

const multiplierTotalsSchema = z.object({
  multiplier: z.number().min(0),
  buckets: bucketSchema,
})

const modelRatesSchema = z.object({
  byMultiplier: z.array(multiplierTotalsSchema),
})

const lastSampleSchema = z.object({
  turn: z.number(),
  step: z.number(),
  model: z.string(),
  multiplier: z.number().min(0),
  buckets: bucketSchema,
})

/** Validates persisted fold state before it seeds a replay. */
const stateSchema = z.object({
  model: z.string(),
  last: lastSampleSchema.nullable(),
  byModel: z.record(modelRatesSchema),
})

const projectionSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().min(1),
}).strict()

/** The usage a chunk or finalized message reports for its step, if any. */
function usageSampleOf(event: SessionEvent): { turn: number; step: number; usage: TokenUsage } | undefined {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
    return { turn: event.data.turn, step: event.data.step, usage: event.data.chunk.usage }
  }
  if (event.type === 'assistant/message' && event.data.usage !== undefined) {
    return { turn: event.data.turn, step: event.data.step, usage: event.data.usage }
  }
  return undefined
}

/**
 * Map the disjoint usage buckets to the priced buckets. DeepSeek bills cache
 * writes at the cache-miss input rate (there is no separate cache-write
 * price), so cache-write tokens ride `input`.
 */
function pricedBucketsOf(usage: TokenUsage): PricedBuckets {
  return {
    input: usage.inputTokens + (usage.cacheWriteTokens ?? 0),
    cacheHit: usage.cacheReadTokens ?? 0,
    output: usage.outputTokens,
  }
}

const bucketsEqual = (left: PricedBuckets, right: PricedBuckets): boolean =>
  left.input === right.input && left.cacheHit === right.cacheHit && left.output === right.output

/** Add (or subtract, with `sign = -1`) one sample's buckets under its multiplier. */
function shiftTotals(rates: ModelRates, multiplier: number, buckets: PricedBuckets, sign: 1 | -1): ModelRates {
  const existing = rates.byMultiplier.find(entry => entry.multiplier === multiplier)
  const next: MultiplierTotals = existing === undefined
    ? { multiplier, buckets: { ...buckets, input: sign * buckets.input, cacheHit: sign * buckets.cacheHit, output: sign * buckets.output } }
    : {
        multiplier,
        buckets: {
          input: existing.buckets.input + sign * buckets.input,
          cacheHit: existing.buckets.cacheHit + sign * buckets.cacheHit,
          output: existing.buckets.output + sign * buckets.output,
        },
      }
  const byMultiplier = existing === undefined
    ? [...rates.byMultiplier, next]
    : rates.byMultiplier.map(entry => (entry.multiplier === multiplier ? next : entry))
  return { byMultiplier }
}

/** The per-model priced totals, adding a fresh entry when the model is new. */
function totalsOf(byModel: Record<string, ModelRates>, model: string): ModelRates {
  return byModel[model] ?? { byMultiplier: [] }
}

/**
 * Price the per-model totals with the captured settings: each multiplier
 * bucket prices at the model list price times that multiplier.
 * @param state - the fold state to price.
 * @param settings - the pricing policy in force.
 * @returns the session's auto-computed cost in currency units.
 */
export function amountOf(state: CostState, settings: PricingSettings): number {
  let amount = 0
  for (const [model, rates] of Object.entries(state.byModel)) {
    for (const entry of rates.byMultiplier) {
      amount += sampleCost(settings, model, entry.buckets, entry.multiplier)
    }
  }
  return amount
}

/**
 * Build the `cost` projection unit for one pricing policy. The fold is pure:
 * `apply` is deterministic given the captured settings. `view` reports the
 * per-session amount unless an `aggregate` is supplied, in which case it
 * reports the aggregate's total instead — the plugin uses that to surface the
 * spend of every session summed together. When the settings section changes,
 * the plugin disposes this definition and registers a fresh one (bumping
 * `stateVersion`), so the fold replays the durable log under the new policy.
 * @param settings - the pricing policy in force for this definition.
 * @param stateVersion - version to invalidate persisted checkpoints from older policies.
 * @param aggregate - optional total for the view; receives the current session's state and returns the displayed amount (default: this session's own amount).
 * @returns the unit definition.
 */
export function costProjectionDefinition(
  settings: PricingSettings,
  stateVersion: number,
  aggregate?: (state: CostState) => number,
): ProjectionDefinition<'cost', CostState> {
  return {
    key: 'cost',
    stateSchema,
    init: (): CostState => ({ model: '', last: null, byModel: {} }),
    apply: (state, event): CostState => {
      if (event.type === 'request/header') {
        const model = event.data.header.config.model
        return model === state.model ? state : { ...state, model }
      }

      const sample = usageSampleOf(event)
      if (sample === undefined) return state

      const buckets = pricedBucketsOf(sample.usage)
      const model = state.model
      const multiplier = multiplierAt(settings, event.time)
      const previous: LastSample | undefined = state.last !== null
        && state.last.turn === sample.turn
        && state.last.step === sample.step
        ? state.last
        : undefined
      if (previous !== undefined && previous.model === model && previous.multiplier === multiplier
        && bucketsEqual(previous.buckets, buckets)) {
        return state
      }

      const next: CostState = {
        ...state,
        last: { turn: sample.turn, step: sample.step, model, multiplier, buckets },
      }
      if (previous !== undefined) {
        const previousTotals = totalsOf(next.byModel, previous.model)
        next.byModel = {
          ...next.byModel,
          [previous.model]: shiftTotals(previousTotals, previous.multiplier, previous.buckets, -1),
        }
      }
      const currentTotals = totalsOf(next.byModel, model)
      next.byModel = {
        ...next.byModel,
        [model]: shiftTotals(currentTotals, multiplier, buckets, 1),
      }
      return next
    },
    wire: {
      viewSchema: projectionSchema,
      view: state => ({
        amount: aggregate === undefined ? amountOf(state, settings) : aggregate(state),
        currency: settings.currency,
      }),
    },
    stateVersion,
  }
}
