/**
 * The pricing card's staged form over the `pricing` settings namespace:
 * model list prices, per-day time segments with multipliers, and day links.
 * The model list is seeded from the wire `llm.providers()` discovery so the
 * card covers whatever models the deployment actually has, while prices stay
 * editable per model. Booleans have no invalid draft, so the model mirrors
 * the plugin-configuration CardForm: staged edits, override markers by
 * user-layer presence, reset-as-clear, and one revision-fenced save.
 */

import type {
  SettingsScope, SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import {
  DEFAULT_PRICING_SETTINGS, WEEKDAYS,
  type DayLinks, type DaySchedule, type ModelPrice, type PricingSettings, type TimeSegment, type Weekday,
} from '../pricing.ts'

/** The card's editable surface. */
export interface PricingCardState {
  /** False while the namespace is not served to this client; the card renders nothing. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits that a save would write. */
  dirty: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean
  /** Model discovery status: 'loading' | 'ready' | 'error'. */
  modelsStatus: 'loading' | 'ready' | 'error'
  /** Model ids discovered from the wire, in provider order. */
  modelIds: string[]
  /** Currency code. */
  currency: string
  /** Per-model list prices keyed by model id. */
  models: Record<string, ModelPrice>
  /** Per-day schedules. */
  days: Record<Weekday, DaySchedule>
  /** Day links. */
  dayLinks: DayLinks
}

/** The write actions the card's slot entry injects. */
export interface PricingCardActions {
  /** Set the currency code. */
  editCurrency(currency: string): void
  /** Add one model row at the list price. */
  addModel(id: string): void
  /** Remove one model row. */
  removeModel(id: string): void
  /** Set one price bucket of one model. */
  editModelPrice(model: string, bucket: 'inputPeak' | 'cacheHitPeak' | 'outputPeak', value: number): void
  /** Set the segments of one day. */
  editDaySegments(day: Weekday, segments: TimeSegment[]): void
  /** Add one segment to a day (a fresh multiplier 1.0 slice). */
  addSegment(day: Weekday): void
  /** Remove one segment of a day. */
  removeSegment(day: Weekday, index: number): void
  /** Move one segment boundary to a new clock time (drag). */
  moveSegmentBoundary(day: Weekday, index: number, clock: string): void
  /** Set one segment's multiplier. */
  editSegmentMultiplier(day: Weekday, index: number, multiplier: number): void
  /** Make `day` follow `followed` (shares its schedule). */
  linkDay(day: Weekday, followed: Weekday): void
  /** Make `day` independent again (copies the followed schedule). */
  unlinkDay(day: Weekday): void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  save(): void
  /** Drop every staged edit. */
  discard(): void
}

/** The registration-side face the card's slot entry injects. */
export interface PricingCardFace extends PricingCardActions {
  hooks: {
    /** Card snapshot bound by the renderer as usePricingCard. */
    pricingCard: SnapshotStore<PricingCardState>
  }
}

/** One staged settings section. */
interface Draft {
  currency: string
  models: Record<string, ModelPrice>
  days: Record<Weekday, DaySchedule>
  dayLinks: DayLinks
}

/** Day-link copy helper: the effective schedule of a day after links. */
export function effectiveDaySchedule(dayLinks: DayLinks, days: Record<Weekday, DaySchedule>, day: Weekday): DaySchedule {
  const seen = new Set<Weekday>([day])
  let current: Weekday = day
  let followed = dayLinks[current]
  while (followed !== undefined && !seen.has(followed)) {
    seen.add(followed)
    current = followed
    followed = dayLinks[current]
  }
  return days[current] ?? { segments: [] }
}

/** A fresh day schedule: one all-day segment at the list price. */
export function emptyDaySchedule(): DaySchedule {
  return { segments: [{ start: '00:00', end: '24:00', multiplier: 1 }] }
}

/**
 * Bridges the `pricing` scope onto the card's staged form and the wire model
 * discovery onto the model rows. The store is created once so the renderer's
 * hook binding keeps one stable source across re-registrations.
 */
export class PricingCardController {
  private readonly staged = new Map<string, unknown>()
  private draft: Draft
  private readonly listeners = new Set<() => void>()
  private readonly store: SnapshotStore<PricingCardState>
  private saving = false
  private failed = false
  private modelIds: string[] = []
  private modelsStatus: 'loading' | 'ready' | 'error' = 'loading'

  /**
   * @param scope - the bound settings scope for the `pricing` namespace.
   * @param api - the wire face used to discover the model list.
   */
  constructor(
    private readonly scope: SettingsScope<PricingSettings>,
    private readonly api: Pick<IApiClient, 'llm'>,
  ) {
    this.draft = this.seed()
    this.store = createSnapshotStore(this.projection())
    this.listeners.add(() => { this.store.set(this.projection()) })
    scope.subscribe(() => { this.rebase(); this.publish() })
    void this.discoverModels()
  }

  /** Build the face the card's slot registration injects. */
  inject(): PricingCardFace {
    return {
      hooks: { pricingCard: this.store },
      editCurrency: (currency) => { this.edit({ currency }) },
      addModel: (id) => { this.addModel(id) },
      removeModel: (id) => { this.removeModel(id) },
      editModelPrice: (model, bucket, value) => { this.editModelPrice(model, bucket, value) },
      editDaySegments: (day, segments) => { this.edit({ days: { ...this.draft.days, [day]: { segments } } }) },
      addSegment: (day) => { this.addSegment(day) },
      removeSegment: (day, index) => { this.removeSegment(day, index) },
      moveSegmentBoundary: (day, index, clock) => { this.moveSegmentBoundary(day, index, clock) },
      editSegmentMultiplier: (day, index, multiplier) => { this.editSegmentMultiplier(day, index, multiplier) },
      linkDay: (day, followed) => { this.linkDay(day, followed) },
      unlinkDay: (day) => { this.unlinkDay(day) },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  /** Seed the draft from the scope's current section or the defaults. */
  private seed(): Draft {
    const snapshot = this.scope.getSnapshot()
    const value = snapshot.value ?? DEFAULT_PRICING_SETTINGS
    return {
      currency: value.currency,
      models: { ...(value.models ?? {}) },
      days: Object.fromEntries(WEEKDAYS.map(day => [day, value.days?.[day] ?? emptyDaySchedule()])) as Record<Weekday, DaySchedule>,
      dayLinks: { ...(value.dayLinks ?? {}) },
    }
  }

  /** Rebase the draft onto the accepted document when no staged edit conflicts. */
  private rebase(): void {
    if (this.staged.size > 0) return
    this.draft = this.seed()
  }

  /** Query the wire for the configured providers' models. */
  private async discoverModels(): Promise<void> {
    try {
      const response = await this.api.llm.models({})
      if (!response.result.ok) throw new Error(response.result.error.message)
      const ids: string[] = []
      for (const group of response.result.value.groups) {
        for (const model of group.models) {
          if (model.id !== '' && !ids.includes(model.id)) ids.push(model.id)
        }
      }
      this.modelIds = ids
      this.modelsStatus = 'ready'
    } catch {
      this.modelsStatus = 'error'
    }
    this.publish()
  }

  private edit(patch: Partial<Draft>): void {
    this.draft = { ...this.draft, ...patch }
    this.staged.set('draft', true)
    this.failed = false
    this.publish()
  }

  private addModel(id: string): void {
    if (id === '' || this.draft.models[id] !== undefined) return
    this.edit({ models: { ...this.draft.models, [id]: { inputPeak: 0, cacheHitPeak: 0, outputPeak: 0 } } })
  }

  private removeModel(id: string): void {
    const models = { ...this.draft.models }
    delete models[id]
    this.edit({ models })
  }

  private editModelPrice(model: string, bucket: 'inputPeak' | 'cacheHitPeak' | 'outputPeak', value: number): void {
    const current = this.draft.models[model]
    if (current === undefined) return
    this.edit({ models: { ...this.draft.models, [model]: { ...current, [bucket]: value } } })
  }

  private addSegment(day: Weekday): void {
    const schedule = effectiveDaySchedule(this.draft.dayLinks, this.draft.days, day)
    // Split the last segment at its midpoint, or append an all-day segment.
    const segments = schedule.segments.length > 0
      ? [...schedule.segments, { start: '00:00', end: '24:00', multiplier: 1 }]
      : [emptyDaySchedule().segments[0]!]
    this.setDaySegments(day, segments)
  }

  private removeSegment(day: Weekday, index: number): void {
    const schedule = effectiveDaySchedule(this.draft.dayLinks, this.draft.days, day)
    const segments = schedule.segments.filter((_, i) => i !== index)
    this.setDaySegments(day, segments)
  }

  private moveSegmentBoundary(day: Weekday, index: number, clock: string): void {
    const schedule = effectiveDaySchedule(this.draft.dayLinks, this.draft.days, day)
    const segments = schedule.segments.map((segment, i) => (i === index ? { ...segment, end: clock } : segment))
    this.setDaySegments(day, segments)
  }

  private editSegmentMultiplier(day: Weekday, index: number, multiplier: number): void {
    const schedule = effectiveDaySchedule(this.draft.dayLinks, this.draft.days, day)
    const segments = schedule.segments.map((segment, i) => (i === index ? { ...segment, multiplier } : segment))
    this.setDaySegments(day, segments)
  }

  /** Write the day's segments into every day linked to it. */
  private setDaySegments(day: Weekday, segments: TimeSegment[]): void {
    const days = { ...this.draft.days }
    for (const candidate of WEEKDAYS) {
      if (this.follows(candidate, day, this.draft.dayLinks)) days[candidate] = { segments }
    }
    this.edit({ days })
  }

  private follows(day: Weekday, target: Weekday, links: DayLinks): boolean {
    const seen = new Set<Weekday>([day])
    let current: Weekday = day
    let followed = links[current]
    while (followed !== undefined && !seen.has(followed)) {
      seen.add(followed)
      if (followed === target) return true
      current = followed
      followed = links[current]
    }
    return false
  }

  private linkDay(day: Weekday, followed: Weekday): void {
    if (day === followed) return
    // Copy the followed schedule so the day starts identical, then link.
    const schedule = effectiveDaySchedule(this.draft.dayLinks, this.draft.days, followed)
    const days = { ...this.draft.days, [day]: { segments: schedule.segments.map(s => ({ ...s })) } }
    const dayLinks = { ...this.draft.dayLinks, [day]: followed }
    this.edit({ days, dayLinks })
  }

  private unlinkDay(day: Weekday): void {
    const dayLinks = { ...this.draft.dayLinks }
    delete dayLinks[day]
    this.edit({ dayLinks })
  }

  private async save(): Promise<void> {
    if (this.staged.size === 0 || this.saving) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      await this.scope.set('currency', this.draft.currency)
      await this.scope.set('models', this.draft.models)
      await this.scope.set('days', this.draft.days)
      await this.scope.set('dayLinks', this.draft.dayLinks)
      this.staged.clear()
    } catch {
      this.failed = true
    }
    this.saving = false
    this.publish()
  }

  private discard(): void {
    if (this.staged.size === 0 && !this.failed) return
    this.staged.clear()
    this.draft = this.seed()
    this.failed = false
    this.publish()
  }

  private projection(): PricingCardState {
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.staged.size > 0,
      saving: this.saving,
      failed: this.failed,
      modelsStatus: this.modelsStatus,
      modelIds: this.modelIds,
      currency: this.draft.currency,
      models: this.draft.models,
      days: this.draft.days,
      dayLinks: this.draft.dayLinks,
    }
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
