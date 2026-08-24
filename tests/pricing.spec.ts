import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRICING_SETTINGS, WEEKDAYS,
  effectiveSchedule, formatClock, inSegment, minutesInDay, multiplierAt, parseClock,
  priceAt, sampleCost, schedulesInOffset, weekdayAt,
  type DayLinks, type DaySchedule, type PricingSettings, type TimeSegment, type Weekday,
} from '../src/pricing.ts'

/** A timestamp at the given UTC clock on 2026-08-18 (a Tuesday). */
function at(utcHour: number, utcMinute = 0): number {
  return Date.UTC(2026, 7, 18, utcHour, utcMinute)
}

/** Settings with one segment on the given day at the given multiplier. */
function daySegment(day: Weekday, segment: TimeSegment): PricingSettings {
  return {
    ...DEFAULT_PRICING_SETTINGS,
    days: { ...DEFAULT_PRICING_SETTINGS.days, [day]: { segments: [segment] } },
  }
}

describe('weekdayAt', () => {
  it('returns the weekday of the local date, rolling across midnight', () => {
    // 2026-08-18 is a Tuesday; Beijing (UTC+8) rolls to the next day before UTC does.
    expect(weekdayAt(at(0), 480)).toBe('tuesday') // 08:00 Beijing
    expect(weekdayAt(at(16), 480)).toBe('wednesday') // 00:00 Beijing, next day
    expect(weekdayAt(Date.UTC(2026, 7, 17, 16), 480)).toBe('tuesday') // 00:00 Beijing
    expect(weekdayAt(at(0), 0)).toBe('tuesday') // UTC midnight
  })

  it('maps the seven days of a week in order', () => {
    // 2026-08-16 is a Sunday, so the following seven days run sunday..saturday.
    for (let i = 0; i < WEEKDAYS.length; i += 1) {
      expect(weekdayAt(Date.UTC(2026, 7, 16 + i, 4), 480)).toBe(WEEKDAYS[i])
    }
  })

  it('anchors the Unix epoch at a Thursday', () => {
    expect(weekdayAt(0, 0)).toBe('thursday')
  })
})

describe('multiplierAt', () => {
  it('returns the segment multiplier inside the segment and 1 outside', () => {
    const settings = daySegment('tuesday', { start: '09:00', end: '12:00', multiplier: 0.5 })
    expect(multiplierAt(settings, at(1))).toBe(0.5) // 09:00 Beijing, inclusive start
    expect(multiplierAt(settings, at(3, 59))).toBe(0.5) // 11:59 Beijing
    expect(multiplierAt(settings, at(0))).toBe(1) // 08:00 Beijing
    expect(multiplierAt(settings, at(4))).toBe(1) // 12:00 Beijing, exclusive end
  })

  it('covers the wrapped hours of a midnight-wrapping segment', () => {
    const settings = daySegment('tuesday', { start: '22:00', end: '02:00', multiplier: 0.5 })
    expect(multiplierAt(settings, at(14))).toBe(0.5) // 22:00 Beijing Tuesday
    expect(multiplierAt(settings, at(15))).toBe(0.5) // 23:00 Beijing Tuesday
    expect(multiplierAt(settings, Date.UTC(2026, 7, 17, 17))).toBe(0.5) // 01:00 Beijing Tuesday
    expect(multiplierAt(settings, at(12, 59))).toBe(1) // 20:59 Beijing Tuesday
    expect(multiplierAt(settings, Date.UTC(2026, 7, 18, 17))).toBe(1) // 01:00 Beijing Wednesday
  })

  it('prices an empty day at the list price all day', () => {
    expect(multiplierAt(DEFAULT_PRICING_SETTINGS, at(2))).toBe(1)
    expect(multiplierAt(DEFAULT_PRICING_SETTINGS, at(14))).toBe(1)
  })

  it('applies a day segment only on its own day', () => {
    const monday = daySegment('monday', { start: '09:00', end: '12:00', multiplier: 0.5 })
    expect(multiplierAt(monday, Date.UTC(2026, 7, 17, 2))).toBe(0.5) // Monday 10:00 Beijing
    expect(multiplierAt(monday, at(2))).toBe(1) // Tuesday 10:00: monday's segment inert
    const tuesday = daySegment('tuesday', { start: '09:00', end: '12:00', multiplier: 0.5 })
    expect(multiplierAt(tuesday, Date.UTC(2026, 7, 17, 2))).toBe(1) // Monday 10:00: tuesday's segment inert
    expect(multiplierAt(tuesday, at(2))).toBe(0.5)
  })

  it('skips malformed segment clocks and falls back to the list price', () => {
    const settings = daySegment('tuesday', { start: 'oops', end: '12:00', multiplier: 0.5 })
    expect(multiplierAt(settings, at(2))).toBe(1)
  })
})

describe('effectiveSchedule and dayLinks', () => {
  const friday = { segments: [{ start: '09:00', end: '12:00', multiplier: 0.5 }] }
  const monday = { segments: [{ start: '14:00', end: '18:00', multiplier: 2 }] }
  const wednesday = { segments: [{ start: '22:00', end: '02:00', multiplier: 1.5 }] }

  function linked(days: Partial<Record<Weekday, DaySchedule>>, dayLinks: DayLinks): PricingSettings {
    return {
      ...DEFAULT_PRICING_SETTINGS,
      days: { ...DEFAULT_PRICING_SETTINGS.days, ...days },
      dayLinks,
    }
  }

  it("returns the day's own schedule when it follows nothing", () => {
    const settings = linked({ friday }, {})
    expect(effectiveSchedule(settings, 'friday')).toEqual(friday)
  })

  it("returns the followed day's schedule", () => {
    const settings = linked({ friday }, { saturday: 'friday' })
    expect(effectiveSchedule(settings, 'saturday')).toEqual(friday)
  })

  it('follows link chains to the end', () => {
    const settings = linked({ friday }, { saturday: 'friday', sunday: 'saturday' })
    expect(effectiveSchedule(settings, 'sunday')).toEqual(friday)
  })

  it('terminates on link cycles and returns the last non-repeated day', () => {
    const settings = linked({ monday, tuesday: { segments: [] }, wednesday }, {
      monday: 'tuesday', tuesday: 'wednesday', wednesday: 'monday',
    })
    expect(effectiveSchedule(settings, 'monday')).toEqual(wednesday)
    expect(effectiveSchedule(settings, 'tuesday')).toEqual(monday)
  })

  it('handles a self-link without looping', () => {
    const settings = linked({ monday }, { monday: 'monday' })
    expect(effectiveSchedule(settings, 'monday')).toEqual(monday)
  })
})

describe('clock helpers', () => {
  it('parses and formats HH:MM', () => {
    expect(parseClock('09:30')).toBe(570)
    expect(parseClock('00:00')).toBe(0)
    expect(parseClock('23:59')).toBe(1439)
    expect(parseClock('9:30')).toBeNaN()
    expect(formatClock(570)).toBe('09:30')
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(1439)).toBe('23:59')
  })

  it('computes minutes of day from a timestamp', () => {
    expect(minutesInDay(at(0), 480)).toBe(480) // 08:00 Beijing
    expect(minutesInDay(at(16, 30), 480)).toBe(30) // 16:30 UTC wraps to 00:30 Beijing
  })

  it('tests membership with an inclusive start and exclusive end', () => {
    const morning = { start: '09:00', end: '12:00', multiplier: 0.5 }
    expect(inSegment(morning, 540)).toBe(true)
    expect(inSegment(morning, 719)).toBe(true)
    expect(inSegment(morning, 720)).toBe(false) // exclusive end
    expect(inSegment(morning, 539)).toBe(false)
  })

  it('wraps midnight for segments whose end precedes their start', () => {
    const night = { start: '22:00', end: '02:00', multiplier: 0.5 }
    expect(inSegment(night, 60)).toBe(true) // 01:00
    expect(inSegment(night, 1320)).toBe(true) // 22:00
    expect(inSegment(night, 120)).toBe(false) // 02:00 exclusive end
    expect(inSegment(night, 1319)).toBe(false) // 21:59
  })

  it('rejects malformed clocks', () => {
    expect(inSegment({ start: 'oops', end: '12:00', multiplier: 0.5 }, 600)).toBe(false)
  })
})

describe('schedulesInOffset', () => {
  const days = {
    ...DEFAULT_PRICING_SETTINGS.days,
    tuesday: { segments: [{ start: '09:00', end: '12:00', multiplier: 0.5 }] },
  }

  it('keeps schedules identical in the source timezone', () => {
    expect(schedulesInOffset(days, 480, 480)).toEqual(days)
  })

  it('shifts segment boundaries by the offset difference and preserves multipliers', () => {
    // Beijing 09:00 = UTC 01:00; Beijing 12:00 = UTC 04:00.
    expect(schedulesInOffset(days, 480, 0).tuesday.segments)
      .toEqual([{ start: '01:00', end: '04:00', multiplier: 0.5 }])
    // Beijing 09:00 = UTC-5 20:00 (previous day).
    expect(schedulesInOffset(days, 480, -300).tuesday.segments)
      .toEqual([{ start: '20:00', end: '23:00', multiplier: 0.5 }])
  })

  it('covers every weekday and defaults missing days to empty', () => {
    const shifted = schedulesInOffset(
      { tuesday: days.tuesday } as Record<Weekday, DaySchedule>, 480, 0,
    )
    for (const day of WEEKDAYS) expect(shifted[day]).toBeDefined()
    expect(shifted.monday.segments).toEqual([])
    expect(shifted.tuesday.segments).toEqual([{ start: '01:00', end: '04:00', multiplier: 0.5 }])
  })

  it('leaves malformed clocks untouched', () => {
    const malformed = {
      ...DEFAULT_PRICING_SETTINGS.days,
      tuesday: { segments: [{ start: 'oops', end: '12:00', multiplier: 0.5 }] },
    }
    expect(schedulesInOffset(malformed, 480, 0).tuesday.segments)
      .toEqual([{ start: 'oops', end: '04:00', multiplier: 0.5 }])
  })
})

describe('priceAt and sampleCost', () => {
  it('prices a model at the requested multiplier', () => {
    expect(priceAt(DEFAULT_PRICING_SETTINGS, 'deepseek-v4-flash', 1))
      .toEqual({ inputPeak: 3, cacheHitPeak: 0.1, outputPeak: 9 })
    expect(priceAt(DEFAULT_PRICING_SETTINGS, 'deepseek-v4-flash', 0.5))
      .toEqual({ inputPeak: 1.5, cacheHitPeak: 0.05, outputPeak: 4.5 })
    expect(priceAt(DEFAULT_PRICING_SETTINGS, 'deepseek-v4-pro', 2))
      .toEqual({ inputPeak: 18, cacheHitPeak: 0.6, outputPeak: 54 })
  })

  it('returns undefined for an unknown model and 0 for its cost', () => {
    expect(priceAt(DEFAULT_PRICING_SETTINGS, 'no-such-model', 1)).toBeUndefined()
    expect(sampleCost(DEFAULT_PRICING_SETTINGS, 'no-such-model', {
      input: 1_000_000, cacheHit: 0, output: 0,
    }, 1)).toBe(0)
  })

  it('sums the priced buckets per million tokens', () => {
    // 1M miss input + 1M cache-hit + 1M output at flash list price = 3 + 0.1 + 9.
    const cost = sampleCost(DEFAULT_PRICING_SETTINGS, 'deepseek-v4-flash', {
      input: 1_000_000, cacheHit: 1_000_000, output: 1_000_000,
    }, 1)
    expect(cost).toBeCloseTo(12.1, 10)
    expect(sampleCost(DEFAULT_PRICING_SETTINGS, 'deepseek-v4-flash', {
      input: 500_000, cacheHit: 0, output: 0,
    }, 1)).toBeCloseTo(1.5, 10)
  })

  it('scales every bucket by the multiplier', () => {
    const buckets = { input: 1_000_000, cacheHit: 1_000_000, output: 1_000_000 }
    const full = sampleCost(DEFAULT_PRICING_SETTINGS, 'deepseek-v4-flash', buckets, 1)
    expect(sampleCost(DEFAULT_PRICING_SETTINGS, 'deepseek-v4-flash', buckets, 0.5))
      .toBeCloseTo(full * 0.5, 10)
    expect(sampleCost(DEFAULT_PRICING_SETTINGS, 'deepseek-v4-flash', buckets, 2))
      .toBeCloseTo(full * 2, 10)
  })
})
