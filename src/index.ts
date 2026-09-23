/**
 * Cost-display pricing plugin, host half: declares the `pricing` plugin
 * entry's live Config (per-model list prices, a default per-day time policy
 * with per-day exceptions, and a manual-spend correction delta) and registers
 * the `cost` session projection unit that prices provider-reported usage with
 * the multiplier in force at each sample's own timestamp and surfaces every
 * live session's spend summed together.
 *
 * @module dsh-ui-pricing
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
// Type-only: the dict type schemastery's `z.dict` infers through, referenced by
// the emitted declaration of `Config` — declaring the package keeps that
// reference portable.
import type {} from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
// Type-only: the `settings/document-updated` event declaration.
import type {} from '@deepseek-ai/dsh-settings/types'
// Type-only: activates the ctx.sessionProjections Context merge.
import type {} from '@deepseek-ai/dsh-session-projection'
import { amountOf, costProjectionDefinition } from './cost-projection.ts'
import {
  DEFAULT_PRICING_SETTINGS, PRICING_SETTINGS_NAMESPACE,
  type DayOverride, type DaySchedule, type ModelPrice, type PricingSettings, type TimeSegment, type Weekday,
} from './pricing.ts'
import type { CostState } from './projection.ts'

export * from './pricing.ts'

const TimeSegmentSchema = z.object({
  start: z.string(),
  end: z.string(),
  multiplier: z.number().min(0),
})

const DayScheduleSchema: z<DaySchedule> = z.object({
  segments: z.array(TimeSegmentSchema),
})

const DayOverrideSchema: z<DayOverride> = z.object({
  segments: z.array(TimeSegmentSchema),
})

const ModelPriceSchema = z.object({
  inputPeak: z.number().min(0),
  cacheHitPeak: z.number().min(0),
  outputPeak: z.number().min(0),
})

/**
 * Live pricing preferences as the Host Config projects them. Every field is a
 * reference, so a price or window edit reaches the running fold and the card
 * without a reload.
 */
export interface Config {
  /** Currency code the prices are denominated in. */
  currency: Volatile<string>
  /** List prices per model id; a model with no entry is unpriced. */
  models: Volatile<Record<string, ModelPrice>>
  /** The default schedule every day uses unless overridden. */
  defaultSchedule: Volatile<DaySchedule>
  /** Per-day overrides; a day present here uses its own segments. */
  overrides: Volatile<Partial<Record<Weekday, DayOverride>>>
  /** Manual-spend correction delta added to the auto-computed total. */
  manualSpend: Volatile<number>
}

/**
 * The plugin entry's live Config — the `pricing` settings section. Volatile
 * fields are also what makes the section servable: the Host describes a
 * settings section only for an entry whose schema publishes at least one live
 * field, and the browser card appears only while the Host serves this
 * namespace.
 */
export const Config = z.object({
  currency: z.string().default(DEFAULT_PRICING_SETTINGS.currency).volatile(),
  models: z.dict(ModelPriceSchema).default(DEFAULT_PRICING_SETTINGS.models).volatile(),
  defaultSchedule: DayScheduleSchema.default(DEFAULT_PRICING_SETTINGS.defaultSchedule).volatile(),
  overrides: z.dict(DayOverrideSchema).default(DEFAULT_PRICING_SETTINGS.overrides).volatile(),
  manualSpend: z.number().default(0).volatile(),
})

/** The read-only snapshot a live Config field resolves to. */
type Snapshot<T> = ReturnType<Volatile<T>['get']>

/** One day's segments as plain, mutable data. */
function scheduleOf(schedule: Snapshot<DaySchedule>): DaySchedule {
  return { segments: schedule.segments.map(segment => ({ ...segment })) }
}

/**
 * The policy snapshot one fold definition prices with. The live Config's
 * snapshot is deeply readonly and shared with the runtime, so the fold
 * captures plain copies: a later settings write cannot mutate the policy a
 * running fold already priced with.
 * @param config - the entry's live pricing preferences.
 * @returns the captured policy.
 */
function policyOf(config: Config): PricingSettings {
  const overrides: Partial<Record<Weekday, DayOverride>> = {}
  const configured = config.overrides.get()
  for (const day of Object.keys(configured) as Weekday[]) {
    const override = configured[day]
    if (override !== undefined) overrides[day] = scheduleOf(override)
  }
  return {
    currency: config.currency.get(),
    models: Object.fromEntries(Object.entries(config.models.get()).map(([id, price]) => [id, { ...price }])),
    defaultSchedule: scheduleOf(config.defaultSchedule.get()),
    overrides,
    manualSpend: config.manualSpend.get(),
  }
}

/**
 * Install the cost projection unit, rebuilt from the current policy whenever
 * the Host publishes a new revision of this entry's section — a changed policy
 * replays the durable log under the new prices and windows, discarding stale
 * persisted checkpoints via the version bump. Compositions without the
 * projection seam install nothing.
 * @param ctx - Host context that may acquire the projection registry.
 * @param config - the entry's live pricing preferences.
 */
export function apply(ctx: Context, config: Config): void {
  // Withhold the Host's auto-generated section page: this package ships its own
  // card on the Plugins page, and the namespace itself is served either way.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })

  ctx.inject(['sessionProjections'], (projCtx) => {
    const sessions = ctx.get('sessions') as SessionStore | undefined
    let version = 0
    let dispose: (() => void) | undefined
    const install = (): void => {
      dispose?.()
      version += 1
      const settings = policyOf(config)
      // The view surfaces every live session's priced spend summed together,
      // so the dock readout tracks the whole deployment, not one session.
      // When no sessions service is composed, degrade to this session's own
      // amount (the projection cannot run without sessions anyway).
      const aggregate = (state: CostState): number => {
        let total = amountOf(state, settings)
        if (sessions === undefined) return total
        for (const session of sessions.list()) {
          const other = projCtx.sessionProjections.stateOf(session, 'cost') as CostState | undefined
          if (other !== undefined && other !== state) total += amountOf(other, settings)
        }
        return total
      }
      dispose = projCtx.sessionProjections.register(
        costProjectionDefinition(settings, version, aggregate),
      )
    }
    install()
    ctx.on('settings/document-updated', (ns: SettingsNamespace) => {
      if ((ns as string) === PRICING_SETTINGS_NAMESPACE) install()
    })
  })
}
