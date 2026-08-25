/**
 * Pricing vocabulary and pure time/multiplier math for the dsh cost display.
 *
 * Client-safe: no imports, so both the host fold and the browser strip can
 * share it without dragging a host-only dependency into a client bundle.
 *
 * The policy is fully user-defined: each day of the week carries its own
 * list of time segments, each segment a price multiplier. A multiplier of
 * 1.0 is the list price ("peak"), 0.5 halves it ("off-peak") — the scheme is
 * just a multiplier per segment, so any tier shape is expressible. No
 * peak/off-peak window is hardcoded; the defaults leave every day at the
 * list price until the user edits the section.
 */

/** One of the seven days of the week, in `Date.prototype.getDay()` order. */
export type Weekday =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'

/** Every weekday key, in day-of-week order (sunday first). */
export const WEEKDAYS: readonly Weekday[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]

/** Map a `Date.prototype.getDay()` value (0 = sunday) to a {@link Weekday}. */
export function weekdayOf(getDay: number): Weekday {
  return WEEKDAYS[getDay] ?? 'sunday'
}

/** One priced time segment of a day: an `HH:MM` window with a price multiplier. */
export interface TimeSegment {
  /** Inclusive segment start (`HH:MM`). */
  start: string
  /** Exclusive segment end (`HH:MM`); an end earlier than the start wraps midnight. */
  end: string
  /** Price multiplier for this window: 1.0 is the list price, 0.5 is half price. */
  multiplier: number
}

/** One day's segments; an empty list prices the whole day at the list price. */
export interface DaySchedule {
  /** Priced segments of the day, in no particular order. */
  segments: TimeSegment[]
}

/** Peak prices for one model, in currency units per one million tokens. */
export interface ModelPrice {
  /** Cache-miss input price (also covers cache writes, which DeepSeek bills at the miss rate). */
  inputPeak: number
  /** Cache-hit input price. */
  cacheHitPeak: number
  /** Output price. */
  outputPeak: number
}

/** A day that overrides the default schedule: `{ segments }` when enabled. */
export interface DayOverride {
  /** The day's own segments, replacing the default schedule for that day. */
  segments: TimeSegment[]
}

/**
 * Durable pricing section: one default time policy plus per-day overrides.
 * Most days share `defaultSchedule`; a day listed in `overrides` uses its own
 * schedule instead. This replaces the earlier per-day + day-links model with
 * the simpler "one global timeline, plus exceptions" shape.
 */
export interface PricingSettings {
  /** Currency code the prices are denominated in (default `CNY`). */
  currency: string
  /** List prices per model id; a model with no entry is unpriced. */
  models: Record<string, ModelPrice>
  /** The default schedule every day uses unless overridden. */
  defaultSchedule: DaySchedule
  /** Per-day overrides; a day present here uses its own segments. */
  overrides: Partial<Record<Weekday, DayOverride>>
  /**
   * Manually-supplied spend added on top of the auto-computed projection.
   * Absent or 0 when the user has not corrected anything; the CostLine shows
   * `auto + manualSpend` and labels the total as an estimate.
   */
  manualSpend?: number
}

/** A fresh day schedule: one all-day segment at the list price. */
export function emptyDaySchedule(): DaySchedule {
  return { segments: [{ start: '00:00', end: '24:00', multiplier: 1 }] }
}

/** The default pricing section: the V4 catalog list prices and a single
 *  all-day segment at the list price — no time policy until the user splits
 *  the day or adds overrides. Prices change; edit the section when they do. */
export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  currency: 'CNY',
  models: {
    'deepseek-v4-flash': { inputPeak: 3.0, cacheHitPeak: 0.1, outputPeak: 9.0 },
    'deepseek-v4-pro': { inputPeak: 9.0, cacheHitPeak: 0.3, outputPeak: 27.0 },
    'deepseek-v4-flash-vision-exp': { inputPeak: 3.0, cacheHitPeak: 0.1, outputPeak: 9.0 },
  },
  defaultSchedule: emptyDaySchedule(),
  overrides: {},
  manualSpend: 0,
}

/** Beijing has no DST; the official peak window is defined in UTC+8. */
export const BEIJING_UTC_OFFSET_MINUTES = 480

/** Settings namespace owning the durable pricing section. */
export const PRICING_SETTINGS_NAMESPACE = 'pricing'

/** The priced token buckets (cache-write rides the cache-miss rate). */
export interface PricedBuckets {
  /** Cache-miss input plus cache-write tokens. */
  input: number
  /** Cache-hit input tokens. */
  cacheHit: number
  /** Output tokens. */
  output: number
}

/**
 * Minutes of day for a timestamp in a fixed-offset timezone.
 * @param epochMs - Unix epoch milliseconds.
 * @param tzOffsetMinutes - fixed timezone offset east of UTC.
 * @returns minutes of day in `[0, 1440)`.
 */
export function minutesInDay(epochMs: number, tzOffsetMinutes: number): number {
  return Math.floor(epochMs / 60_000 + tzOffsetMinutes) % 1440
}

/**
 * Parse `HH:MM` into minutes of day.
 * @param clock - `HH:MM` string.
 * @returns minutes of day, or NaN for a malformed value.
 */
export function parseClock(clock: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(clock)
  if (match === null) return Number.NaN
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Format minutes of day as `HH:MM`.
 * @param minutes - minutes of day in `[0, 1440)`.
 * @returns the `HH:MM` string.
 */
export function formatClock(minutes: number): string {
  const rounded = Math.floor(minutes)
  const hours = Math.floor(rounded / 60)
  const mins = rounded % 60
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

/**
 * The day of week for a timestamp in a fixed-offset timezone.
 * @param epochMs - Unix epoch milliseconds.
 * @param tzOffsetMinutes - fixed timezone offset east of UTC.
 * @returns the {@link Weekday} of the timestamp's local date.
 */
export function weekdayAt(epochMs: number, tzOffsetMinutes: number): Weekday {
  // UTC epoch days: the Unix epoch (1970-01-01) was a Thursday.
  const shiftedMinutes = Math.floor(epochMs / 60_000 + tzOffsetMinutes)
  const utcDay = Math.floor(shiftedMinutes / 1440)
  // 1970-01-01 was Thursday (getDay 4); day 0 -> weekday index 4.
  return weekdayOf((utcDay + 4) % 7)
}

/**
 * Resolve the schedule a day actually uses: its override when present,
 * otherwise the default schedule.
 * @param settings - the pricing section.
 * @param day - the day to resolve.
 * @returns the effective schedule (the day's override or the default).
 */
export function effectiveSchedule(settings: PricingSettings, day: Weekday): DaySchedule {
  const override = settings.overrides[day]
  return override !== undefined ? { segments: override.segments } : settings.defaultSchedule
}

/**
 * Whether a timestamp falls inside a segment. A segment whose `end` is
 * earlier than its `start` wraps midnight.
 * @param segment - the segment to test.
 * @param minutes - minutes of day of the timestamp.
 * @returns true when inside the segment.
 */
export function inSegment(segment: TimeSegment, minutes: number): boolean {
  const start = parseClock(segment.start)
  const end = parseClock(segment.end)
  if (Number.isNaN(start) || Number.isNaN(end)) return false
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

/**
 * The price multiplier in force at a timestamp: the multiplier of the first
 * matching segment of the day's effective schedule, or 1 (list price) when no
 * segment matches or the day has none.
 * @param settings - the pricing section.
 * @param epochMs - Unix epoch milliseconds.
 * @param tzOffsetMinutes - fixed offset of the segments' timezone.
 * @returns the multiplier in force.
 */
export function multiplierAt(
  settings: PricingSettings,
  epochMs: number,
  tzOffsetMinutes: number = BEIJING_UTC_OFFSET_MINUTES,
): number {
  const minutes = minutesInDay(epochMs, tzOffsetMinutes)
  const schedule = effectiveSchedule(settings, weekdayAt(epochMs, tzOffsetMinutes))
  for (const segment of schedule.segments) {
    if (inSegment(segment, minutes)) return segment.multiplier
  }
  return 1
}

/**
 * Convert the time policy from the configured timezone into another fixed
 * offset (the browser's local timezone), preserving the `HH:MM` vocabulary.
 * Each boundary shifts by the same offset, so segments keep their count and
 * may change their midnight-wrap behavior.
 * @param settings - the pricing section to shift.
 * @param sourceOffsetMinutes - the schedules' timezone offset.
 * @param targetOffsetMinutes - the target timezone offset.
 * @returns a settings copy with every schedule expressed in the target timezone.
 */
export function settingsInOffset(
  settings: PricingSettings,
  sourceOffsetMinutes: number,
  targetOffsetMinutes: number,
): PricingSettings {
  const shift = (clock: string): string => {
    const minutes = parseClock(clock)
    if (Number.isNaN(minutes)) return clock
    return formatClock((minutes - sourceOffsetMinutes + targetOffsetMinutes + 1440) % 1440)
  }
  const shiftSchedule = (schedule: DaySchedule): DaySchedule => ({
    segments: schedule.segments.map(segment => ({
      start: shift(segment.start), end: shift(segment.end), multiplier: segment.multiplier,
    })),
  })
  const overrides = {} as Partial<Record<Weekday, DayOverride>>
  for (const day of WEEKDAYS) {
    const override = settings.overrides[day]
    if (override !== undefined) overrides[day] = shiftSchedule(override)
  }
  return {
    ...settings,
    defaultSchedule: shiftSchedule(settings.defaultSchedule),
    overrides,
  }
}

/**
 * The priced bucket rates for one model at one multiplier, or undefined when
 * the model has no price entry.
 * @param settings - the pricing section.
 * @param model - model id.
 * @param multiplier - price multiplier in force (1 = list price).
 * @returns the three per-million-token rates, or undefined when unpriced.
 */
export function priceAt(
  settings: PricingSettings,
  model: string,
  multiplier: number,
): ModelPrice | undefined {
  const list = settings.models[model]
  if (list === undefined) return undefined
  return {
    inputPeak: list.inputPeak * multiplier,
    cacheHitPeak: list.cacheHitPeak * multiplier,
    outputPeak: list.outputPeak * multiplier,
  }
}

/**
 * Cost of one usage sample in currency units, using the multiplier's rates.
 * @param settings - the pricing section.
 * @param model - model id (unknown models price to zero).
 * @param buckets - the sample's priced token buckets.
 * @param multiplier - the sample's price multiplier.
 * @returns the sample cost in currency units.
 */
export function sampleCost(
  settings: PricingSettings,
  model: string,
  buckets: PricedBuckets,
  multiplier: number,
): number {
  const price = priceAt(settings, model, multiplier)
  if (price === undefined) return 0
  const perToken = 1 / 1_000_000
  return (buckets.input * price.inputPeak
    + buckets.cacheHit * price.cacheHitPeak
    + buckets.output * price.outputPeak) * perToken
}
