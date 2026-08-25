// @vitest-environment jsdom
/**
 * CostLine dock occupant: the spend readout, the 24-hour multiplier strip
 * (hour cells + now marker), the current-time/multiplier text, and the
 * minute-boundary re-tick — driven through props. Expectations are computed
 * with the same vendored pure functions the component uses, so the suite
 * stays deterministic under any test-machine timezone. Test instants sit at
 * 12:17 UTC so their local minutes of day stay in `[0, 1440)` for every real
 * world offset (the shared `minutesInDay` underflows for a UTC early-morning
 * instant in the western hemisphere).
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BEIJING_UTC_OFFSET_MINUTES, WEEKDAYS, formatClock, minutesInDay, multiplierAt,
  parseClock, settingsInOffset, weekdayAt,
  type DaySchedule, type PricingSettings, type TimeSegment, type Weekday,
} from '../src/pricing.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { CostLine, formatAmount, formatCost, formatFactor, type CostLineProps } from '../src/client/CostLine.tsx'
import { zh } from '../src/client/locales.ts'

// The framework-injected t seat, stubbed over the zh dictionaries (the default locale).
const t: CostLineProps['t'] = makeTranslate(zh, commonZh)

/** The `cost` projection value the component reads (mirrors the pricing plugin's type). */
interface CostProjection {
  amount: number
  currency: string
}

/** Any fixed instant; every expectation is derived from it through the shared math. */
const NOW_MS = Date.UTC(2026, 7, 18, 12, 17)

/** Settings with no time policy: every day prices at the list price (multiplier 1). */
function makeSettings(defaultSchedule: DaySchedule = { segments: [] }, overrides: Partial<Record<Weekday, DaySchedule>> = {}): PricingSettings {
  return { currency: 'CNY', models: {}, defaultSchedule, overrides }
}

/**
 * A Beijing-clock segment that reads as a full local day (`00:00`–`23:59`,
 * every minute but the last) after `settingsInOffset` shifts it into the
 * given local offset — the whole-day band for a fixed multiplier.
 */
function allDaySegment(multiplier: number, localOffset: number): TimeSegment {
  const toBeijing = (clock: string): string =>
    formatClock((parseClock(clock) + BEIJING_UTC_OFFSET_MINUTES - localOffset + 1440) % 1440)
  return { start: toBeijing('00:00'), end: toBeijing('23:59'), multiplier }
}

/** Settings pricing the whole local day at `multiplier` for one weekday. */
function bandSettings(day: Weekday, multiplier: number): PricingSettings {
  const offset = -new Date(NOW_MS).getTimezoneOffset()
  return makeSettings({ segments: [] }, { [day]: { segments: [allDaySegment(multiplier, offset)] } })
}

/** Expected facts for one instant, computed with the same helpers the component uses. */
function expectedFacts(settings: PricingSettings, nowMs: number): {
  multiplier: number
  minutes: number
  timeLabel: string
  markerPercent: number
} {
  const offset = -new Date(nowMs).getTimezoneOffset()
  const shifted = settingsInOffset(settings, BEIJING_UTC_OFFSET_MINUTES, offset)
  const minutes = minutesInDay(nowMs, offset)
  return {
    multiplier: multiplierAt(shifted, nowMs, offset),
    minutes,
    timeLabel: formatClock(minutes),
    markerPercent: minutes / 1440 * 100,
  }
}

/** Render with the clock frozen at {@link NOW_MS} (the component owns its own `Date.now()`). */
function renderFrozen(over: Parameters<typeof makeProps>[0] = {}): ReturnType<typeof render> {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  return render(<CostLine {...makeProps(over)} />)
}

function makeProps(over: { settings?: PricingSettings | undefined; cost?: CostProjection | undefined } = {}): CostLineProps {
  const { settings, cost } = over
  return {
    useProjection: (key: string) => (key === 'cost' ? cost : undefined),
    usePricing: ((selector: (value: PricingSettings | undefined) => unknown) => selector(settings)) as unknown as CostLineProps['usePricing'],
    t,
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('CostLine', () => {
  it('renders nothing until the pricing section has synced', () => {
    const { container } = renderFrozen({ settings: undefined })
    expect(container.firstChild).toBeNull()
  })

  it('shows the priced spend with its currency glyph and hides it while nothing is priced', () => {
    const settings = makeSettings()
    renderFrozen({ settings, cost: { amount: 3.6, currency: 'CNY' } })
    expect(screen.getByText('¥3.6')).toBeTruthy()
    cleanup()
    renderFrozen({ settings, cost: undefined })
    expect(screen.queryByText(/¥/)).toBeNull()
    cleanup()
    renderFrozen({ settings, cost: { amount: 0, currency: 'CNY' } })
    expect(screen.queryByText(/¥/)).toBeNull()
  })

  it('adds manual spend on top of the auto estimate and labels the total as an estimate', () => {
    const settings = { ...makeSettings(), manualSpend: 2 }
    renderFrozen({ settings, cost: { amount: 1, currency: 'CNY' } })
    expect(screen.getByText('¥3')).toBeTruthy()
    const badge = screen.getByText(zh['estimate.label'])
    expect(badge).toBeTruthy()
    expect(badge.getAttribute('title')).toBe(zh['estimate.title'])
  })

  it('shows manual spend alone while nothing has been priced yet', () => {
    const settings = { ...makeSettings(), manualSpend: 2 }
    renderFrozen({ settings, cost: undefined })
    expect(screen.getByText('¥2')).toBeTruthy()
  })

  it('hides the readout when auto plus manual spend is zero', () => {
    const settings = { ...makeSettings(), manualSpend: 0 }
    renderFrozen({ settings, cost: { amount: 0, currency: 'CNY' } })
    expect(screen.queryByText(/¥/)).toBeNull()
  })

  it('paints 24 hour cells in the expected multiplier bands and positions the now marker', () => {
    const settings = bandSettings(weekdayAt(NOW_MS, -new Date(NOW_MS).getTimezoneOffset()), 0.5)
    const { container } = renderFrozen({ settings })
    const cells = container.querySelectorAll('[data-tier]')
    expect(cells).toHaveLength(24)
    // The full-local-day band paints every cell (including hour 0) as a discount.
    expect(cells[0]!.getAttribute('data-tier')).toBe('discount')
    const facts = expectedFacts(settings, NOW_MS)
    const marker = container.querySelector('[data-now]') as HTMLElement | null
    expect(marker).not.toBeNull()
    expect(marker!.style.left).toBe(`${facts.markerPercent}%`)
  })

  it('paints every cell neutral under the default list-price policy', () => {
    const { container } = renderFrozen({ settings: makeSettings() })
    const cells = container.querySelectorAll('[data-tier]')
    expect(cells).toHaveLength(24)
    for (const cell of cells) expect(cell.getAttribute('data-tier')).toBe('neutral')
  })

  it('shows the current local time, and the list-price multiplier when no band is in force', () => {
    renderFrozen({ settings: makeSettings() })
    const facts = expectedFacts(makeSettings(), NOW_MS)
    expect(facts.multiplier).toBe(1)
    expect(screen.getByText(`${facts.timeLabel} · ×${formatFactor(facts.multiplier)}`)).toBeTruthy()
    expect(screen.getByRole('img').getAttribute('aria-label'))
      .toBe(zh['strip.aria'].replace('{time}', facts.timeLabel))
  })

  it('labels an instant inside a discounted band with the multiplier', () => {
    const settings = bandSettings(weekdayAt(NOW_MS, -new Date(NOW_MS).getTimezoneOffset()), 0.5)
    renderFrozen({ settings })
    const facts = expectedFacts(settings, NOW_MS)
    expect(facts.multiplier).toBe(0.5)
    expect(screen.getByText(`${facts.timeLabel} · ×${formatFactor(facts.multiplier)}`)).toBeTruthy()
  })

  it('labels an instant inside a premium band with the multiplier', () => {
    const settings = bandSettings(weekdayAt(NOW_MS, -new Date(NOW_MS).getTimezoneOffset()), 1.5)
    renderFrozen({ settings })
    const facts = expectedFacts(settings, NOW_MS)
    expect(facts.multiplier).toBe(1.5)
    expect(screen.getByText(`${facts.timeLabel} · ×${formatFactor(facts.multiplier)}`)).toBeTruthy()
  })

  it('re-ticks at the next minute boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const settings = makeSettings()
    const { unmount } = render(<CostLine {...makeProps({ settings })} />)
    const before = expectedFacts(settings, NOW_MS)
    expect(screen.getByText(new RegExp(`^${before.timeLabel} ·`))).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(60_000 - (NOW_MS % 60_000))
    })
    const after = expectedFacts(settings, NOW_MS + (60_000 - (NOW_MS % 60_000)))
    expect(screen.getByText(new RegExp(`^${after.timeLabel} ·`))).toBeTruthy()
    unmount()
  })
})

describe('cost formatting', () => {
  it('formats amounts with up to four decimals and trims trailing zeros', () => {
    expect(formatAmount(3.6)).toBe('3.6')
    expect(formatAmount(0.05)).toBe('0.05')
    expect(formatAmount(12)).toBe('12')
    expect(formatAmount(0.0001234567)).toBe('0.0001')
  })

  it('prefixes a known currency glyph and falls back to the code', () => {
    expect(formatCost(0.05, 'CNY')).toBe('¥0.05')
    expect(formatCost(1.5, 'USD')).toBe('$1.5')
    expect(formatCost(1.5, 'ZZZ')).toBe('ZZZ 1.5')
  })

  it('keeps one decimal on integer multipliers', () => {
    expect(formatFactor(1)).toBe('1.0')
    expect(formatFactor(0.5)).toBe('0.5')
    expect(formatFactor(0.75)).toBe('0.75')
  })
})
