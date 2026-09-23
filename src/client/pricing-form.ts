/**
 * The pricing card's staged form over the `pricing` entry's live Config:
 * model list prices, the default per-day time policy (one global timeline),
 * and per-day overrides. The model list is seeded from the Host's session
 * model catalogue so the card covers whatever models the deployment actually
 * serves, while prices stay editable per model. The form mirrors the shared
 * configuration forms: staged edits, override markers by user-layer presence,
 * and one revision-fenced save.
 */

import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalog, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import {
  DEFAULT_PRICING_SETTINGS, emptyDaySchedule, WEEKDAYS,
  type DaySchedule, type ModelPrice, type PricingSettings, type TimeSegment, type Weekday,
} from '../pricing.ts'

/** The wire face the card reads the deployment's model catalogue through. */
export interface ModelCatalogSource {
  /** @returns the provider-grouped model catalogue, or the remote failure. */
  modelCatalog(): Promise<RemoteResult<ModelCatalog>>
}

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
  /** Model ids discovered from the Host catalogue, in provider order. */
  modelIds: string[]
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
 * Bridges the `pricing` form onto the card's staged form and the Host model
 * catalogue onto the model rows. The store is created once so the renderer's
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
   * @param form - the Host entry's shared configuration form.
   * @param catalog - the wire face used to discover the model list.
   */
  constructor(
    private readonly form: ConfigForm<PricingSettings>,
    private readonly catalog: ModelCatalogSource,
  ) {
    this.draft = this.seed()
    this.store = createSnapshotStore(this.projection())
    this.listeners.add(() => { this.store.set(this.projection()) })
    form.subscribe(() => { this.rebase(); this.publish() })
    this.refreshCatalog()
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

  /** Re-read the Host model catalogue: adapters and stored routes can change. */
  refreshCatalog(): void {
    void this.discoverModels()
  }

  /** Seed the draft from the form's current section or the defaults. */
  private seed(): Draft {
    const value = this.form.getSnapshot().value ?? DEFAULT_PRICING_SETTINGS
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

  /** Query the Host for the models its routable providers serve. */
  private async discoverModels(): Promise<void> {
    try {
      const response = await this.catalog.modelCatalog()
      if (!response.ok) throw new Error(response.error.message)
      const ids: string[] = []
      for (const group of response.value.groups) {
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
    // The card lists every model the Host serves, so a bucket edit may be the
    // first statement about a model the section does not price yet.
    const current = this.draft.models[model] ?? { inputPeak: 0, cacheHitPeak: 0, outputPeak: 0 }
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
    // The Host fences each write on the revision it published: `false` means it
    // refused (or skipped) the write, and a transport failure rejects. Either
    // way the draft stays so the user can correct it.
    let landed = true
    try {
      landed = (await this.form.set('models', this.draft.models)) && landed
      landed = (await this.form.set('defaultSchedule', this.draft.defaultSchedule)) && landed
      landed = (await this.form.set('overrides', this.draft.overrides)) && landed
    } catch {
      landed = false
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
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
    const snapshot: ConfigFormSnapshot<PricingSettings> = this.form.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.staged.size > 0,
      saving: this.saving,
      failed: this.failed,
      modelsStatus: this.modelsStatus,
      modelIds: this.modelIds,
      models: this.draft.models,
      defaultSchedule: this.draft.defaultSchedule,
      overrides: this.draft.overrides,
    }
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
