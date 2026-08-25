/**
 * The pricing card's staged form over the `pricing` settings namespace:
 * model list prices, the default per-day time policy (one global timeline),
 * and per-day overrides. The model list is seeded from the wire `llm.models()`
 * catalog so the card covers whatever models the deployment actually has,
 * while prices stay editable per model. The form mirrors the
 * plugin-configuration CardForm: staged edits, override markers by user-layer
 * presence, reset-as-clear, and one revision-fenced save.
 */

import type {
  SettingsScope, SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import {
  DEFAULT_PRICING_SETTINGS, emptyDaySchedule, WEEKDAYS,
  type DaySchedule, type ModelPrice, type PricingSettings, type TimeSegment, type Weekday,
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
  /** The default schedule every day uses unless overridden. */
  defaultSchedule: DaySchedule
  /** Days with their own schedule (exceptions to the default). */
  overrides: Partial<Record<Weekday, DaySchedule>>
}

/** The write actions the card's slot entry injects. */
export interface PricingCardActions {
  /** Add one model row at the list price. */
  addModel(id: string): void
  /** Remove one model row. */
  removeModel(id: string): void
  /** Set one price bucket of one model. */
  editModelPrice(model: string, bucket: 'inputPeak' | 'cacheHitPeak' | 'outputPeak', value: number): void
  /** Set the default schedule's segments. */
  editDefaultSegments(segments: TimeSegment[]): void
  /** Add a per-day override for `day`, seeded from the default schedule. */
  addOverride(day: Weekday): void
  /** Remove the per-day override for `day`, reverting it to the default. */
  removeOverride(day: Weekday): void
  /** Set one override day's segments. */
  editOverrideSegments(day: Weekday, segments: TimeSegment[]): void
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
  models: Record<string, ModelPrice>
  defaultSchedule: DaySchedule
  overrides: Partial<Record<Weekday, DaySchedule>>
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
      addModel: (id) => { this.addModel(id) },
      removeModel: (id) => { this.removeModel(id) },
      editModelPrice: (model, bucket, value) => { this.editModelPrice(model, bucket, value) },
      editDefaultSegments: (segments) => { this.edit({ defaultSchedule: { segments } }) },
      addOverride: (day) => { this.addOverride(day) },
      removeOverride: (day) => { this.removeOverride(day) },
      editOverrideSegments: (day, segments) => { this.editOverrideSegments(day, segments) },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  /** Seed the draft from the scope's current section or the defaults. */
  private seed(): Draft {
    const snapshot = this.scope.getSnapshot()
    const value = snapshot.value ?? DEFAULT_PRICING_SETTINGS
    return {
      models: { ...(value.models ?? {}) },
      defaultSchedule: value.defaultSchedule ?? emptyDaySchedule(),
      overrides: { ...(value.overrides ?? {}) },
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

  private addOverride(day: Weekday): void {
    if (this.draft.overrides[day] !== undefined) return
    const overrides = {
      ...this.draft.overrides,
      [day]: { segments: this.draft.defaultSchedule.segments.map(s => ({ ...s })) },
    }
    this.edit({ overrides })
  }

  private removeOverride(day: Weekday): void {
    const overrides = { ...this.draft.overrides }
    delete overrides[day]
    this.edit({ overrides })
  }

  private editOverrideSegments(day: Weekday, segments: TimeSegment[]): void {
    if (this.draft.overrides[day] === undefined) return
    const overrides = { ...this.draft.overrides, [day]: { segments } }
    this.edit({ overrides })
  }

  private async save(): Promise<void> {
    if (this.staged.size === 0 || this.saving) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      await this.scope.set('models', this.draft.models)
      await this.scope.set('defaultSchedule', this.draft.defaultSchedule)
      await this.scope.set('overrides', this.draft.overrides)
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
      currency: snapshot.value?.currency ?? DEFAULT_PRICING_SETTINGS.currency,
      models: this.draft.models,
      defaultSchedule: this.draft.defaultSchedule,
      overrides: this.draft.overrides,
    }
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
