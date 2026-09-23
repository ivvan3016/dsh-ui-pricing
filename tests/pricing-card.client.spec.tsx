// @vitest-environment jsdom
/**
 * Pricing card: the staged form over the `pricing` entry's live Config —
 * catalogue discovery, model add/remove, price edits, the default timeline,
 * per-day overrides, save/discard, and refused writes — plus the two views the
 * Plugins page asks the row page for (`summary`, `page`), driven through props.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelCatalog, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { WEEKDAYS } from '../src/pricing.ts'
import {
  PricingCardController, type ModelCatalogSource, type PricingCardState,
} from '../src/client/pricing-form.ts'
import { PricingCard, type PricingCardProps } from '../src/client/PricingCard.tsx'
import { zh } from '../src/client/locales.ts'
import {
  DEFAULT_PRICING_SETTINGS, emptyDaySchedule, type PricingSettings,
} from '../src/pricing.ts'

/** Controllable configuration form standing in for `ctx.configForms.get(ns)`. */
class FakeForm implements ConfigForm<PricingSettings> {
  snapshot: ConfigFormSnapshot<PricingSettings>
  readonly writes: Array<{ field: string; value: unknown }> = []
  private readonly listeners = new Set<() => void>()
  /** When set, a write answers this instead of landing. */
  accept = true

  constructor(over: Partial<ConfigFormSnapshot<PricingSettings>> = {}) {
    this.snapshot = {
      status: 'ready', value: undefined, base: undefined, user: undefined,
      revision: 0, writable: true, mode: 'host', ...over,
    }
  }

  getSnapshot(): ConfigFormSnapshot<PricingSettings> { return this.snapshot }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  mutate(): Promise<boolean> { return Promise.resolve(this.accept) }

  set(field: string, value: unknown): Promise<boolean> {
    this.writes.push({ field, value })
    if (!this.accept) return Promise.resolve(false)
    this.snapshot = {
      ...this.snapshot,
      user: { ...(this.snapshot.user as object | undefined ?? {}), [field]: value },
      value: { ...(this.snapshot.value ?? {}), [field]: value } as PricingSettings,
    }
    for (const fn of [...this.listeners]) fn()
    return Promise.resolve(true)
  }

  unset(field: string): Promise<boolean> {
    this.snapshot = { ...this.snapshot, [field]: undefined } as ConfigFormSnapshot<PricingSettings>
    for (const fn of [...this.listeners]) fn()
    return Promise.resolve(true)
  }
}

/** One provider group's catalogue answer. */
function catalog(groups: Array<{ id: string; models: string[] }>): ModelCatalog {
  return {
    default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routableProviders: groups.map(group => group.id),
    groups: groups.map(group => ({
      id: group.id,
      name: group.id,
      models: group.models.map(id => ({ id, name: id })),
    })),
    failures: [],
  }
}

const okCatalog = (groups: Array<{ id: string; models: string[] }>): ModelCatalogSource => ({
  modelCatalog: (): Promise<RemoteResult<ModelCatalog>> => Promise.resolve({ ok: true, value: catalog(groups) }),
})

const failingCatalog: ModelCatalogSource = {
  modelCatalog: (): Promise<RemoteResult<ModelCatalog>> =>
    Promise.reject(new Error('catalogue down')),
}

/** Let the controller's catalogue promise settle. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

afterEach(cleanup)

describe('PricingCardController', () => {
  it('seeds the draft from the accepted section', async () => {
    const form = new FakeForm({ value: { ...DEFAULT_PRICING_SETTINGS, currency: 'USD' } })
    const controller = new PricingCardController(form, okCatalog([{ id: 'p', models: ['m1', 'm2'] }]))
    await settle()
    const state = controller.inject().hooks.pricingCard.getSnapshot()
    expect(state.available).toBe(true)
    expect(state.writable).toBe(true)
    expect(state.dirty).toBe(false)
    expect(state.modelsStatus).toBe('ready')
    expect(state.modelIds).toEqual(['m1', 'm2'])
    expect(state.models).toEqual(DEFAULT_PRICING_SETTINGS.models)
  })

  it('reports an unserved namespace and an unreachable catalogue', async () => {
    const form = new FakeForm({ status: 'loading' })
    const controller = new PricingCardController(form, failingCatalog)
    await settle()
    const state = controller.inject().hooks.pricingCard.getSnapshot()
    expect(state.available).toBe(false)
    expect(state.modelsStatus).toBe('error')
  })

  it('stages model add/remove and price edits, then writes them on save', async () => {
    const form = new FakeForm({ value: DEFAULT_PRICING_SETTINGS })
    const controller = new PricingCardController(form, okCatalog([]))
    const face = controller.inject()
    const store = face.hooks.pricingCard
    face.addModel('deepseek-v4-pro')
    face.editModelPrice('deepseek-v4-pro', 'outputPeak', 42)
    expect(store.getSnapshot().dirty).toBe(true)
    expect(store.getSnapshot().models['deepseek-v4-pro']!.outputPeak).toBe(42)
    face.removeModel('deepseek-v4-flash')
    face.save()
    await vi.waitFor(() => { expect(store.getSnapshot().dirty).toBe(false) })
    expect(form.writes.map(write => write.field)).toEqual(['models', 'defaultSchedule', 'overrides'])
    const models = form.writes[0]!.value as Record<string, unknown>
    expect(Object.keys(models).sort()).toEqual(['deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'])
  })

  it('seeds a per-day override from the default schedule and clears it again', () => {
    const form = new FakeForm({ value: { ...DEFAULT_PRICING_SETTINGS, defaultSchedule: emptyDaySchedule() } })
    const controller = new PricingCardController(form, okCatalog([]))
    const face = controller.inject()
    const store = face.hooks.pricingCard
    expect(store.getSnapshot().overrides.monday).toBeUndefined()
    face.addOverride('monday')
    expect(store.getSnapshot().overrides.monday).toEqual(emptyDaySchedule())
    face.editOverrideSegments('monday', [{ start: '01:00', end: '02:00', multiplier: 0.5 }])
    expect(store.getSnapshot().overrides.monday!.segments).toHaveLength(1)
    face.removeOverride('monday')
    expect(store.getSnapshot().overrides.monday).toBeUndefined()
  })

  it('stages the default timeline and discards every draft', () => {
    const form = new FakeForm({ value: DEFAULT_PRICING_SETTINGS })
    const controller = new PricingCardController(form, okCatalog([]))
    const face = controller.inject()
    const store = face.hooks.pricingCard
    face.editDefaultSegments([{ start: '00:00', end: '12:00', multiplier: 0.5 }])
    expect(store.getSnapshot().defaultSchedule.segments).toHaveLength(1)
    expect(store.getSnapshot().dirty).toBe(true)
    face.discard()
    expect(store.getSnapshot().dirty).toBe(false)
    expect(store.getSnapshot().defaultSchedule).toEqual(DEFAULT_PRICING_SETTINGS.defaultSchedule)
  })

  it('keeps the drafts and reports failure when the Host refuses the write', async () => {
    const form = new FakeForm({ value: DEFAULT_PRICING_SETTINGS })
    form.accept = false
    const controller = new PricingCardController(form, okCatalog([]))
    const face = controller.inject()
    const store = face.hooks.pricingCard
    face.addModel('extra')
    face.save()
    await vi.waitFor(() => { expect(store.getSnapshot().saving).toBe(false) })
    expect(store.getSnapshot().failed).toBe(true)
    expect(store.getSnapshot().dirty).toBe(true)
    expect(store.getSnapshot().models.extra).toBeDefined()
  })

  it('creates the price entry when a bucket is edited on an unpriced model', () => {
    const form = new FakeForm({ value: DEFAULT_PRICING_SETTINGS })
    const controller = new PricingCardController(form, okCatalog([{ id: 'p', models: ['never-priced'] }]))
    const face = controller.inject()
    const store = face.hooks.pricingCard
    face.editModelPrice('never-priced', 'cacheHitPeak', 0.3)
    expect(store.getSnapshot().dirty).toBe(true)
    expect(store.getSnapshot().models['never-priced']).toEqual({ inputPeak: 0, cacheHitPeak: 0.3, outputPeak: 0 })
  })

  it('rebases the draft on a section change while nothing is staged', async () => {
    const form = new FakeForm({ value: DEFAULT_PRICING_SETTINGS })
    const controller = new PricingCardController(form, okCatalog([]))
    const store = controller.inject().hooks.pricingCard
    await form.set('models', { only: { inputPeak: 1, cacheHitPeak: 0, outputPeak: 2 } })
    expect(Object.keys(store.getSnapshot().models)).toEqual(['only'])
  })

  it('re-reads the catalogue on demand', async () => {
    const form = new FakeForm({ value: DEFAULT_PRICING_SETTINGS })
    let groups: Array<{ id: string; models: string[] }> = []
    const controller = new PricingCardController(form, {
      modelCatalog: () => Promise.resolve({ ok: true, value: catalog(groups) }),
    })
    await settle()
    expect(controller.inject().hooks.pricingCard.getSnapshot().modelIds).toEqual([])
    groups = [{ id: 'p', models: ['later'] }]
    controller.refreshCatalog()
    await vi.waitFor(() => { expect(controller.inject().hooks.pricingCard.getSnapshot().modelIds).toEqual(['later']) })
  })
})

function cardState(over: Partial<PricingCardState> = {}): PricingCardState {
  return {
    available: true,
    writable: true,
    dirty: false,
    saving: false,
    failed: false,
    modelsStatus: 'ready',
    modelIds: [],
    models: { m1: { inputPeak: 3, cacheHitPeak: 0.1, outputPeak: 9 } },
    defaultSchedule: emptyDaySchedule(),
    overrides: {},
    ...over,
  }
}

function makeProps(over: Partial<PricingCardState> = {}, view: 'summary' | 'page' = 'page') {
  const state = cardState(over)
  return {
    view,
    t: (key: keyof typeof zh) => zh[key],
    usePricingCard: (selector: (snapshot: PricingCardState) => unknown) => selector(state),
    addModel: vi.fn(),
    removeModel: vi.fn(),
    editModelPrice: vi.fn(),
    editDefaultSegments: vi.fn(),
    addOverride: vi.fn(),
    removeOverride: vi.fn(),
    editOverrideSegments: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  } as unknown as PricingCardProps
}

describe('PricingCard', () => {
  it('answers the summary request with the one-liner and no controls', () => {
    const { container, queryByRole } = render(<PricingCard {...makeProps({}, 'summary')} />)
    expect(container.textContent).toBe(zh['card.description'])
    expect(queryByRole('button')).toBeNull()
  })

  it('renders nothing while the namespace is unserved', () => {
    const { container } = render(<PricingCard {...makeProps({ available: false })} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one row per client model, marking the unpriced ones', () => {
    render(<PricingCard {...makeProps({ modelIds: ['m1', 'm2'] })} />)
    expect(screen.getByText('m1')).toBeTruthy()
    // A model the section does not price yet still gets a row, marked unpriced.
    expect(screen.getByText('m2')).toBeTruthy()
    expect(screen.getByText(zh['model.unpriced'])).toBeTruthy()
    // Only a priced row can be removed.
    expect(screen.getAllByRole('button', { name: zh['model.remove'] })).toHaveLength(1)
  })

  it('stages a price for a client model the section does not price yet', () => {
    const props = makeProps({ modelIds: ['m1'], models: {} })
    render(<PricingCard {...props} />)
    const bucket = screen.getAllByRole('spinbutton')[0] as HTMLInputElement
    expect(bucket.value).toBe('')
    fireEvent.change(bucket, { target: { value: '5' } })
    fireEvent.blur(bucket)
    expect(props.editModelPrice).toHaveBeenCalledWith('m1', 'inputPeak', 5)
  })

  it('keeps a priced model the client list no longer carries', () => {
    render(<PricingCard {...makeProps({ modelIds: ['m1'], models: { retired: { inputPeak: 1, cacheHitPeak: 0, outputPeak: 2 } } })} />)
    expect(screen.getByText('retired')).toBeTruthy()
  })

  it('explains an empty client model list', () => {
    render(<PricingCard {...makeProps({ modelIds: [], models: {} })} />)
    expect(screen.getByText(zh['models.empty'])).toBeTruthy()
  })

  it('renders the model table, the default timeline, and the day toggles', () => {
    render(<PricingCard {...makeProps()} />)
    expect(screen.getByText(zh['section.models'])).toBeTruthy()
    expect(screen.getByText('m1')).toBeTruthy()
    expect(screen.getByText(zh['section.default'])).toBeTruthy()
    expect(screen.getByText(zh['section.overrides'])).toBeTruthy()
    for (const day of WEEKDAYS) expect(screen.getByRole('button', { name: zh[`day.${day}`] })).toBeTruthy()
  })

  it('stages a price edit through the card actions', () => {
    const props = makeProps()
    render(<PricingCard {...props} />)
    const bucket = screen.getAllByRole('spinbutton')[0] as HTMLInputElement
    fireEvent.change(bucket, { target: { value: '7' } })
    fireEvent.blur(bucket)
    expect(props.editModelPrice).toHaveBeenCalledWith('m1', 'inputPeak', 7)
  })

  it('removes a model and toggles a day exception through the card actions', () => {
    const props = makeProps()
    render(<PricingCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['model.remove'] }))
    expect(props.removeModel).toHaveBeenCalledWith('m1')
    fireEvent.click(screen.getByRole('button', { name: zh['day.monday'] }))
    expect(props.addOverride).toHaveBeenCalledWith('monday')
  })

  it('shows the read-only notice and hides the write controls', () => {
    render(<PricingCard {...makeProps({ writable: false })} />)
    expect(screen.getByText(zh['readOnly'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh['model.remove'] })).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>(zh['model.input'])).toBeTruthy()
  })

  it('reports an unavailable catalogue and gates save on a dirty form', () => {
    const errored = makeProps({ modelsStatus: 'error' })
    render(<PricingCard {...errored} />)
    expect(screen.getByText(zh['models.unavailable'])).toBeTruthy()

    cleanup()
    const clean = makeProps()
    render(<PricingCard {...clean} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['save'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['discard'] }).disabled).toBe(true)

    cleanup()
    const dirty = makeProps({ dirty: true })
    render(<PricingCard {...dirty} />)
    fireEvent.click(screen.getByRole('button', { name: zh['save'] }))
    expect(dirty.save).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['discard'] }))
    expect(dirty.discard).toHaveBeenCalled()
  })

  it('renders one override timeline per enabled day and reports a failed save', () => {
    render(<PricingCard {...makeProps({
      failed: true,
      overrides: { monday: emptyDaySchedule() },
    })} />)
    expect(screen.getByText(zh['saveFailed'])).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['override.remove'] })).toBeTruthy()
  })
})
