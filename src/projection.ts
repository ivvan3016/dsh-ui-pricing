/**
 * Pure client-safe cost-projection vocabulary: the wire value and the host
 * fold-state types, plus the projection-table merges.
 *
 * @module dsh-ui-pricing/projection
 */

/** The priced token buckets of one usage sample (cache-write rides input). */
export interface PricedBuckets {
  /** Cache-miss input plus cache-write tokens. */
  input: number
  /** Cache-hit input tokens. */
  cacheHit: number
  /** Output tokens. */
  output: number
}

/** One sample's priced totals at one multiplier. */
export interface MultiplierTotals {
  /** The price multiplier these totals were priced at. */
  multiplier: number
  /** The token buckets accumulated at that multiplier. */
  buckets: PricedBuckets
}

/** Per-model fold totals: priced token totals per multiplier (plain JSON). */
export interface ModelRates {
  /** Priced buckets per multiplier, in no particular order. */
  byMultiplier: MultiplierTotals[]
}

/** One usage sample's billing facts, for same-step replacement. */
export interface LastSample {
  turn: number
  step: number
  model: string
  multiplier: number
  buckets: PricedBuckets
}

/** Host fold state: the model in force and the priced totals per model and multiplier. */
export interface CostState {
  /** Model of the latest `request/header` (unpriced `''` before any header). */
  model: string
  /** The newest usage sample, so a later report for the same step replaces it. */
  last: LastSample | null
  /** Priced token totals per model; per multiplier per bucket. */
  byModel: Record<string, ModelRates>
}

/**
 * The displayed spend: the auto-computed cost of every live session summed
 * together, in currency units.
 *
 * The amount is computed by the host fold from provider-reported usage
 * samples, each priced at the multiplier in force at the sample's own
 * timestamp — so requests made during discounted hours are billed at the
 * discount rate even if the display is read at the list price. The host
 * sums each session's fold so the dock readout tracks the whole deployment.
 */
export interface CostProjection {
  /** Cumulative cost across every live session, in currency units (0 before any priced usage). */
  amount: number
  /** Currency code the amount is denominated in. */
  currency: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Every live session's priced spend summed together, multiplier-at-sample-time applied. */
    cost: CostProjection
  }

  interface SessionProjectionStateMap {
    /** Host fold state behind the `cost` projection (plain JSON). */
    cost: CostState
  }
}
