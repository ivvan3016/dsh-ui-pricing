/**
 * DayTimeline: a draggable 24-hour price-multiplier timeline for one day.
 * The stored model is a list of `TimeSegment`s (each with its own start/end
 * and multiplier), but the visual is a shared axis of ordered boundaries:
 * the sorted segment starts plus 24:00 form the boundary list, and each
 * interval between consecutive boundaries is one segment carrying the
 * multiplier of the segment that starts there.
 *
 * Interactions:
 * - Click the axis to insert a boundary (splitting the segment at the click).
 * - Drag a boundary handle to move it; dragging never inserts.
 * - Click a boundary's × to remove it (merging the two adjacent intervals).
 * - Edit a segment's multiplier directly in its always-visible input.
 * A time ruler above the axis labels every 6 hours so the strip reads at a
 * glance.
 */

import { useRef, useState } from 'react'
import clsx from 'clsx'
import type { TimeSegment } from '../pricing.ts'
import css from './DayTimeline.module.css'

/** Parse `HH:MM` to minutes of day, or NaN. */
function parseClock(clock: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(clock)
  return match === null ? Number.NaN : Number(match[1]) * 60 + Number(match[2])
}

/** Format minutes of day as `HH:MM`. */
function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

/** Snap a pointer x offset within the axis to whole-hour minutes of day. */
function minutesFromEvent(clientX: number, axisRect: DOMRect): number {
  const ratio = (clientX - axisRect.left) / axisRect.width
  return Math.max(0, Math.min(1440, Math.round(ratio * 1440 / 60) * 60))
}

/** The ordered boundaries of the day: sorted segment starts plus 24:00. */
function boundariesOf(segments: TimeSegment[]): number[] {
  const starts = segments
    .map(segment => parseClock(segment.start))
    .filter(minutes => !Number.isNaN(minutes))
    .sort((a, b) => a - b)
  return [...starts, 1440]
}

/** The segment interval that contains `minutes` (by its start boundary). */
function intervalIndex(boundaries: number[], minutes: number): number {
  for (let i = boundaries.length - 2; i >= 0; i -= 1) {
    if (minutes >= boundaries[i]) return i
  }
  return 0
}

/** The multiplier of the interval at `index`, from the segment that starts at that boundary. */
function multiplierAtBoundary(segments: TimeSegment[], index: number): number {
  const startClock = formatClock(boundariesOf(segments)[index] ?? 0)
  const segment = segments.find(candidate => candidate.start === startClock)
  return segment?.multiplier ?? 1
}

/** Rebuild the segment list from ordered boundaries and per-boundary multipliers. */
function segmentsFrom(
  boundaries: number[],
  multipliers: number[],
): TimeSegment[] {
  const segments: TimeSegment[] = []
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i]!
    const end = boundaries[i + 1]!
    segments.push({
      start: formatClock(start),
      end: formatClock(end),
      multiplier: multipliers[i] ?? 1,
    })
  }
  return segments
}

/** One draggable boundary handle (index 0 = day start, fixed; others movable).
 *  Dragging keeps a local preview position and commits once on release, so a
 *  drag does not spam the settings store with intermediate values. */
function Boundary(props: {
  index: number
  minutes: number
  removable: boolean
  disabled: boolean
  label: string
  onMove(index: number, minutes: number): void
  onRemove(index: number): void
}) {
  const { index, minutes, removable, disabled, label, onMove, onRemove } = props
  const [active, setActive] = useState(false)
  const [preview, setPreview] = useState<number | null>(null)
  const previewRef = useRef<number | null>(null)
  const shown = preview ?? minutes

  return (
    <div
      className={clsx(css.handle, active && css.handleActive)}
      style={{ left: `${shown / 1440 * 100}%` }}
      onPointerDown={(event) => {
        if (disabled) return
        event.stopPropagation()
        event.preventDefault()
        setActive(true)
        setPreview(minutes)
        previewRef.current = minutes
        const axis = event.currentTarget.parentElement as HTMLDivElement
        const move = (e: PointerEvent): void => {
          const rect = axis.getBoundingClientRect()
          const next = minutesFromEvent(e.clientX, rect)
          setPreview(next)
          previewRef.current = next
        }
        const up = (e: PointerEvent): void => {
          // Suppress the axis click that would otherwise insert a boundary
          // after a drag: swallow a click at the release point.
          const at = { x: e.clientX, y: e.clientY }
          window.addEventListener('click', (event) => {
            if (Math.abs(event.clientX - at.x) < 2 && Math.abs(event.clientY - at.y) < 2) {
              event.stopPropagation()
            }
          }, { once: true })
          const committed = previewRef.current ?? minutes
          setActive(false)
          setPreview(null)
          previewRef.current = null
          onMove(index, committed)
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
    >
      <span className={css.handleLabel}>{formatClock(shown)}</span>
      {removable && !disabled
        ? (
          <button
            type="button"
            className={css.remove}
            aria-label="remove boundary"
            onClick={(event) => { event.stopPropagation(); onRemove(index) }}
          >
            ×
          </button>
        )
        : null}
    </div>
  )
}

/** One interval between boundaries: an always-editable multiplier input. */
function Interval(props: {
  leftMinutes: number
  rightMinutes: number
  multiplier: number
  disabled: boolean
  onEdit(multiplier: number): void
}) {
  const { leftMinutes, rightMinutes, multiplier, disabled, onEdit } = props
  const [text, setText] = useState(String(multiplier))

  const commit = (): void => {
    const value = Number(text)
    if (Number.isFinite(value) && value >= 0) onEdit(value)
    else setText(String(multiplier))
  }

  const width = Math.max((rightMinutes - leftMinutes) / 1440 * 100, 3)
  return (
    <div
      className={clsx(css.segment, multiplier < 1 && css.segmentDiscount, multiplier > 1 && css.segmentPremium)}
      style={{ left: `${leftMinutes / 1440 * 100}%`, width: `${width}%` }}
      onClick={(event) => { event.stopPropagation() }}
    >
      <input
        className={css.multiplierInput}
        type="number"
        min="0"
        step="0.1"
        value={text}
        disabled={disabled}
        aria-label={`multiplier ${formatClock(leftMinutes)}–${formatClock(rightMinutes)}`}
        onChange={(event) => { setText(event.target.value) }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { commit(); (event.target as HTMLInputElement).blur() }
        }}
      />
    </div>
  )
}

/** The timeline props. */
export interface DayTimelineProps {
  /** The day's segments. */
  segments: TimeSegment[]
  disabled: boolean
  onChange(segments: TimeSegment[]): void
}

/**
 * Render one day's draggable timeline with a time ruler. The axis is a
 * pointer surface: clicks insert a boundary, handle drags move a boundary
 * (never inserting), and the × removes one. The segments are rebuilt from
 * the boundary list on every edit.
 */
export function DayTimeline({ segments, disabled, onChange }: DayTimelineProps) {
  const axisRef = useRef<HTMLDivElement>(null)
  const boundaries = boundariesOf(segments)
  const multipliers = boundaries.slice(0, -1).map((_, index) => multiplierAtBoundary(segments, index))

  const insertBoundary = (clientX: number): void => {
    const axis = axisRef.current
    if (axis === null || disabled) return
    const minutes = minutesFromEvent(clientX, axis.getBoundingClientRect())
    if (minutes === 0 || minutes === 1440 || boundaries.includes(minutes)) return
    const index = intervalIndex(boundaries, minutes)
    const next = [...boundaries, minutes].sort((a, b) => a - b)
    const nextMultipliers = boundaries.slice(0, -1).map((_, i) => multipliers[i] ?? 1)
    nextMultipliers.splice(index + (minutes > boundaries[index] ? 1 : 0), 0, multipliers[index] ?? 1)
    onChange(segmentsFrom(next, nextMultipliers))
  }

  const moveBoundary = (index: number, minutes: number): void => {
    if (index === 0 || minutes === 0) return // the day start is fixed
    // Clamp so boundaries never cross: keep strictly between neighbors.
    const left = boundaries[index - 1] ?? 0
    const right = boundaries[index + 1] ?? 1440
    const clamped = Math.max(left + 60, Math.min(right - 60, minutes))
    const next = [...boundaries]
    next[index] = clamped
    next.sort((a, b) => a - b)
    onChange(segmentsFrom(next, multipliers))
  }

  const removeBoundary = (index: number): void => {
    if (index === 0 || index >= boundaries.length - 1) return
    const next = boundaries.filter((_, i) => i !== index)
    const nextMultipliers = multipliers.filter((_, i) => i !== index)
    onChange(segmentsFrom(next, nextMultipliers))
  }

  const rulerMarks = [0, 360, 720, 1080, 1320, 1440]

  return (
    <div className={css.wrap}>
      <div className={css.ruler} aria-hidden>
        {rulerMarks.map(minutes => (
          <span key={minutes} className={css.rulerMark} style={{ left: `${minutes / 1440 * 100}%` }}>
            {formatClock(minutes)}
          </span>
        ))}
      </div>
      <div
        ref={axisRef}
        className={css.axis}
        data-day-timeline
        onClick={(event) => { insertBoundary(event.clientX) }}
      >
        {boundaries.map((minutes, index) => (
          <Boundary
            key={`b-${index}`}
            index={index}
            minutes={minutes}
            removable={index > 0 && index < boundaries.length - 1}
            disabled={disabled}
            label={formatClock(minutes)}
            onMove={moveBoundary}
            onRemove={removeBoundary}
          />
        ))}
        {boundaries.slice(0, -1).map((left, index) => (
          <Interval
            key={`i-${index}`}
            leftMinutes={left}
            rightMinutes={boundaries[index + 1]!}
            multiplier={multipliers[index] ?? 1}
            disabled={disabled}
            onEdit={(multiplier) => {
              const next = multipliers.map((m, i) => (i === index ? multiplier : m))
              onChange(segmentsFrom(boundaries, next))
            }}
          />
        ))}
      </div>
    </div>
  )
}
