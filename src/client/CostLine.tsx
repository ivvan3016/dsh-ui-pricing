/**
 * CostLine: the composer-dock cost readout. The left side shows the session's
 * priced spend (the `cost` projection); the right side shows the current
 * local time and the price multiplier in force; underneath, a 24-hour strip
 * paints each hour in its multiplier band (orange premium, blue discount,
 * neutral list price) with a marker at the current minute. The multiplier
 * math is the vendored `tiers.ts` copy of the `dsh-ui-pricing` vocabulary;
 * the `pricing` settings section arrives in Beijing clocks and is converted
 * into the browser's own timezone so the strip tracks the wall clock.
 * Nothing renders until the pricing section has synced; the spend group
 * appears only once a sample has been priced.
 */

import { memo, useEffect, useState } from 'react'
import {
  BEIJING_UTC_OFFSET_MINUTES, formatClock, minutesInDay, multiplierAt, schedulesInOffset,
  type PricingSettings,
} from '../pricing.ts'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import css from './CostLine.module.css'

/** Currency codes with a natural glyph; anything else prefixes the code. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥',
}

/**
 * Format a currency amount with up to four decimals, trailing zeros trimmed.
 * @param amount - currency units.
 * @returns the display string (`3.6`, `0.05`, `12`).
 */
export function formatAmount(amount: number): string {
  return amount.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * Format a cost as `¥0.05`; an unknown currency shows its code as a prefix.
 * @param amount - currency units.
 * @param currency - currency code from the projection.
 * @returns the display string.
 */
export function formatCost(amount: number, currency: string): string {
  return `${CURRENCY_SYMBOLS[currency] ?? `${currency} `}${formatAmount(amount)}`
}

/**
 * Format a multiplier: `1` → `1.0`, `0.5` → `0.5`.
 * @param factor - the price multiplier.
 * @returns the display string.
 */
export function formatFactor(factor: number): string {
  const text = String(factor)
  return text.includes('.') ? text : `${text}.0`
}

/** The three multiplier bands a strip cell can paint. */
type StripBand = 'discount' | 'premium' | 'neutral'

/**
 * Classify a price multiplier into its strip band: below list price is a
 * discount, above is a premium, exactly list price is neutral.
 * @param multiplier - the price multiplier in force.
 * @returns the band.
 */
function bandOf(multiplier: number): StripBand {
  return multiplier < 1 ? 'discount' : multiplier > 1 ? 'premium' : 'neutral'
}

/** Props of the dock occupant: the projection seat, the pricing hook, and the locale seat. */
export interface CostLineProps {
  /** The framework projection seat (`useProjection('cost')`). */
  useProjection: UseProjection
  /** The injected pricing-section hook (bound from the settings mirror). */
  usePricing: SnapshotSelectorHook<PricingSettings | undefined>
  /** The owning dock's locale seat. */
  t: PropsLocale<'cost'>['t']
}

export const CostLine = memo(function CostLine({ useProjection, usePricing, t }: CostLineProps) {
  const cost = useProjection('cost')
  const settings = usePricing(snapshot => snapshot)
  const [now, setNow] = useState(() => Date.now())

  // Re-read the clock at each minute boundary; the strip marker and the
  // multiplier text move with it. Delayed to the next boundary, never a bare
  // interval, so a settled row re-renders at most once per minute.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      timer = setTimeout(() => {
        setNow(Date.now())
        schedule()
      }, 60_000 - (Date.now() % 60_000))
    }
    schedule()
    // The effect body always assigns `timer` before the cleanup can run, so
    // the guard exists only for the type system's sake.
    return () => {
      /* v8 ignore next -- unreachable: schedule() always assigns timer */
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  if (settings === undefined) return null

  const localOffset = -new Date(now).getTimezoneOffset()
  // Shift every day's schedule into the browser's timezone, then read the
  // multiplier through the shifted section so both the clock and the weekday
  // resolve in local time (`multiplierAt` derives both from the same offset).
  const shiftedSettings = {
    ...settings,
    days: schedulesInOffset(settings.days, BEIJING_UTC_OFFSET_MINUTES, localOffset),
  }
  const multiplier = multiplierAt(shiftedSettings, now, localOffset)
  const minutes = minutesInDay(now, localOffset)
  const timeLabel = formatClock(minutes)
  const markerPercent = minutes / 1440 * 100

  // One cell per local hour, classified by the multiplier at the hour's
  // start; the shipped whole-hour window therefore paints exactly, and a
  // custom mid-hour boundary snaps to the cell that contains it.
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const dayStartMs = dayStart.getTime()
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    band: bandOf(multiplierAt(shiftedSettings, dayStartMs + hour * 3_600_000, localOffset)),
  }))

  return (
    <div className={css.root} data-cost-line>
      <div className={css.top}>
        {cost !== undefined && cost.amount > 0 && (
          <span className={css.amount}>{formatCost(cost.amount, cost.currency)}</span>
        )}
        <span className={css.tier}>{t('tier.now', {
          time: timeLabel, tier: `×${formatFactor(multiplier)}`, multiplier: formatFactor(multiplier),
        })}</span>
      </div>
      <div
        className={css.strip}
        role="img"
        aria-label={t('strip.aria', { time: timeLabel })}
      >
        {hours.map(({ hour, band }) => (
          <span
            key={hour}
            data-tier={band}
            className={band === 'premium' ? css.cellPeak : band === 'discount' ? css.cellOffPeak : css.cellNeutral}
          />
        ))}
        <span data-now className={css.now} style={{ left: `${markerPercent}%` }} aria-hidden />
      </div>
    </div>
  )
})
