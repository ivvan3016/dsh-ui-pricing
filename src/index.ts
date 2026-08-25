/**
 * Cost-display pricing plugin, host half: registers the durable `pricing`
 * settings section (per-model list prices, per-day-of-week time segments with
 * price multipliers, and day links) and the `cost` session projection unit
 * that prices provider-reported usage with the multiplier in force at each
 * sample's own timestamp.
 *
 * @module dsh-ui-pricing
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
// Type-only: activates the ctx.sessionProjections Context merge.
import type {} from '@deepseek-ai/dsh-session-projection'
import { costProjectionDefinition } from './cost-projection.ts'
import {
  DEFAULT_PRICING_SETTINGS, PRICING_SETTINGS_NAMESPACE,
  type DayOverride, type DaySchedule, type PricingSettings, type TimeSegment,
} from './pricing.ts'

export { PRICING_SETTINGS_NAMESPACE } from './pricing.ts'
export * from './pricing.ts'

const NS = settingsNamespace(PRICING_SETTINGS_NAMESPACE)

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

/** Durable pricing section schema; also the wire envelope the browser scope validates against. */
export const PricingSettingsSchema: z<PricingSettings> = z.object({
  currency: z.string().default(DEFAULT_PRICING_SETTINGS.currency),
  models: z.dict(ModelPriceSchema).default(DEFAULT_PRICING_SETTINGS.models),
  defaultSchedule: DayScheduleSchema.default(DEFAULT_PRICING_SETTINGS.defaultSchedule),
  overrides: z.dict(DayOverrideSchema).default(DEFAULT_PRICING_SETTINGS.overrides),
})

/**
 * Install the pricing section and the cost projection unit. The unit is
 * rebuilt from the current section whenever `settings/updated` fires for the
 * pricing namespace — a changed policy replays the durable log under the new
 * prices and windows, discarding stale persisted checkpoints via the version
 * bump. Compositions without the settings or projection seams degrade to the
 * defaults or to no projection, respectively.
 * @param ctx - Host context that may acquire settings and projections.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NS, PricingSettingsSchema)
  })

  ctx.inject(['sessionProjections'], (projCtx) => {
    const settingsService = ctx.get('settings') as { get(ns: SettingsNamespace): unknown } | undefined
    let version = 0
    let dispose: (() => void) | undefined
    const install = (): void => {
      dispose?.()
      version += 1
      const section = settingsService?.get(NS) as PricingSettings | undefined
      dispose = projCtx.sessionProjections.register(
        costProjectionDefinition(section ?? DEFAULT_PRICING_SETTINGS, version),
      )
    }
    install()
    ctx.on('settings/updated', (ns: SettingsNamespace) => {
      if (ns === NS) install()
    })
  })
}
