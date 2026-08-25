/**
 * CostLine: the composer-dock cost readout. The left side shows the total
 * priced spend across every live session (the `cost` projection, which the
 * host aggregates) plus any manual-spend correction, labeled as an estimate;
 * clicking the amount (when writable) lets the user type the corrected total
 * in place — the difference from the auto amount is stored as the correction
 * delta, so later usage keeps accruing on top of it. The right side shows
 * the current local time and the price multiplier in force; underneath, a
 * 24-hour strip paints each hour in its multiplier band (orange premium,
 * blue discount, neutral list price) with a marker at the current minute.
 * The multiplier math is the vendored `tiers.ts` copy of the
 * `dsh-ui-pricing` vocabulary; the `pricing` settings section arrives in
 * Beijing clocks and is converted into the browser's own timezone so the
 * strip tracks the wall clock. Nothing renders until the pricing section
 * has synced; the spend group appears only once a total is nonzero.
 */

import { memo, useEffect, useRef, useState } from 'react'
import {
  BEIJING_UTC_OFFSET_MINUTES, formatClock, minutesInDay, multiplierAt, settingsInOffset,
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

/** Whether the pricing section is writable, bound from the settings mirror. */
export interface CostCorrectionState {
  /** Whether the Host document accepts a correction write. */
  writable: boolean
}

/** Props of the dock occupant: the projection seat, the pricing hook, the correction seat, and the locale seat. */
export interface CostLineProps {
  /** The framework projection seat (`useProjection('cost')`). */
  useProjection: UseProjection
  /** The injected pricing-section hook (bound from the settings mirror). */
  usePricing: SnapshotSelectorHook<PricingSettings | undefined>
  /** The injected correction seat: whether the section accepts writes. */
  useCorrection: SnapshotSelectorHook<CostCorrectionState>
  /** Write a manual-spend correction delta (`corrected total − auto amount`). */
  correctSpend(delta: number): void
  /** The owning dock's locale seat. */
  t: PropsLocale<'cost'>['t']
}

export const CostLine = memo(function CostLine({ useProjection, usePricing, useCorrection, correctSpend, t }: CostLineProps) {
  const cost = useProjection('cost')
  const settings = usePricing(snapshot => snapshot)
  const correction = useCorrection(snapshot => snapshot)
  const [now, setNow] = useState(() => Date.now())
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  // Enter/Escape close the edit before the input unmounts; the browser can
  // fire blur on removal, so the key path flags that the following blur is
  // the unmount echo and must not commit again.
  const skipNextBlur = useRef(false)

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
  // Shift the whole time policy into the browser's timezone, then read the
  // multiplier through the shifted section so both the clock and the weekday
  // resolve in local time (`multiplierAt` derives both from the same offset).
  const shiftedSettings = settingsInOffset(settings, BEIJING_UTC_OFFSET_MINUTES, localOffset)
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

  const manualSpend = settings.manualSpend ?? 0
  const auto = cost?.amount ?? 0
  // The corrected total is `auto + manualSpend`; clamp at zero so a large
  // downward correction never shows negative spend when the policy changes.
  const totalAmount = Math.max(0, auto + manualSpend)
  const currency = cost?.currency ?? settings.currency
  const hasSpend = totalAmount > 0

  // Finish the edit: `commit` writes the corrected total as the difference
  // from the auto amount, so the display equals the typed value and later
  // usage accrues on top. An empty input cancels.
  const finishEditing = (commit: boolean): void => {
    skipNextBlur.current = true
    if (commit) {
      const value = Number(text)
      if (text !== '' && Number.isFinite(value) && value >= 0) {
        const delta = value - auto
        if (delta !== manualSpend) correctSpend(delta)
      }
    }
    setEditing(false)
    setText('')
  }
  const beginCorrection = (): void => {
    skipNextBlur.current = false
    setText(formatAmount(totalAmount))
    setEditing(true)
  }

  return (
    <div className={css.root} data-cost-line>
      <div className={css.top}>
        {hasSpend && (editing
          ? (
            <input
              className={css.correct}
              type="number"
              min="0"
              step="0.01"
              autoFocus
              value={text}
              aria-label={t('correct.aria')}
              onChange={(event) => { setText(event.target.value) }}
              onBlur={() => {
                if (skipNextBlur.current) { skipNextBlur.current = false; return }
                finishEditing(true)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') finishEditing(true)
                else if (event.key === 'Escape') finishEditing(false)
              }}
            />
          )
          : (
            <span className={css.amount}>
              {correction.writable
                ? (
                  <button
                    type="button"
                    className={css.correctButton}
                    title={t('correct.hint')}
                    onClick={beginCorrection}
                  >
                    {formatCost(totalAmount, currency)}
                  </button>
                )
                : formatCost(totalAmount, currency)}
              <span className={css.estimate} title={t('estimate.title')}>{t('estimate.label')}</span>
            </span>
          ))}
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
