import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Volatile } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, type Config } from '../src/index.ts'
import { costProjectionDefinition } from '../src/cost-projection.ts'
import type { CostProjection } from '../src/projection.ts'
import { DEFAULT_PRICING_SETTINGS, PRICING_SETTINGS_NAMESPACE, type PricingSettings } from '../src/pricing.ts'

/** Tuesday 09:00–12:00 Beijing at the given multiplier; 2026-08-18 is a Tuesday. */
function tuesdayPolicy(multiplier: number): PricingSettings {
  return {
    ...DEFAULT_PRICING_SETTINGS,
    overrides: {
      tuesday: { segments: [{ start: '09:00', end: '12:00', multiplier }] },
    },
  }
}

/** Beijing 10:00 (inside Tuesday's 09:00–12:00 segment) on 2026-08-18. */
const IN_SEGMENT_MS = Date.UTC(2026, 7, 18, 2)
/** Beijing 08:00 (outside the segment) on 2026-08-18. */
const OUT_SEGMENT_MS = Date.UTC(2026, 7, 18, 0)

function headerEvent(model: string, seq: number): SessionEvent<'request/header'> {
  return {
    type: 'request/header', seq, time: seq,
    data: { header: { config: { provider: 'deepseek-official', model } }, reason: 'initial' },
  }
}

function usageEvent(
  seq: number,
  time: number,
  turn: number,
  step: number,
  usage: TokenUsage,
): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message', seq, time,
    data: {
      turn, step,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
      stream: [],
      usage,
    },
  }
}

const FLASH_USAGE: TokenUsage = {
  inputTokens: 1_000_000,
  cacheReadTokens: 500_000,
  cacheWriteTokens: 200_000,
  outputTokens: 100_000,
}

function fold(settings: PricingSettings = DEFAULT_PRICING_SETTINGS, version = 1) {
  const definition = costProjectionDefinition(settings, version)
  return {
    definition,
    state: definition.init(),
    apply(event: SessionEvent): void {
      this.state = definition.apply(this.state, event)
    },
    view(): CostProjection {
      return definition.wire!.view(this.state)
    },
  }
}

describe('cost projection fold', () => {
  it('prices a usage sample at the multiplier in force at the sample timestamp', () => {
    const f = fold(tuesdayPolicy(0.5))
    f.apply(headerEvent('deepseek-v4-flash', 1))
    f.apply(usageEvent(2, IN_SEGMENT_MS, 1, 1, FLASH_USAGE))
    // input 1M + cacheWrite 0.2M at 3.0, cacheHit 0.5M at 0.1, output 0.1M at 9.0, all × 0.5.
    expect(f.view().amount).toBeCloseTo((3.6 + 0.05 + 0.9) * 0.5, 10)
    expect(f.view().currency).toBe('CNY')
  })

  it('prices at the list rate outside the priced segment', () => {
    const inside = fold(tuesdayPolicy(0.5))
    inside.apply(headerEvent('deepseek-v4-flash', 1))
    inside.apply(usageEvent(2, IN_SEGMENT_MS, 1, 1, FLASH_USAGE))
    const outside = fold(tuesdayPolicy(0.5))
    outside.apply(headerEvent('deepseek-v4-flash', 1))
    outside.apply(usageEvent(2, OUT_SEGMENT_MS, 1, 1, FLASH_USAGE))
    expect(outside.view().amount).toBeCloseTo(inside.view().amount * 2, 10)
  })

  it('applies the multiplier to input, cache-hit, and output buckets alike', () => {
    const halfOf = (usage: TokenUsage): number => {
      const f = fold(tuesdayPolicy(0.5))
      f.apply(headerEvent('deepseek-v4-flash', 1))
      f.apply(usageEvent(2, IN_SEGMENT_MS, 1, 1, usage))
      return f.view().amount
    }
    expect(halfOf({ inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(1.5, 10) // 3.0 × 0.5
    expect(halfOf({ inputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.05, 10) // 0.1 × 0.5
    expect(halfOf({ inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(4.5, 10) // 9.0 × 0.5
  })

  it('replaces a failed attempt sample when the step settles with its own usage', () => {
    const f = fold(tuesdayPolicy(0.5))
    f.apply(headerEvent('deepseek-v4-flash', 1))
    const attempt: SessionEvent<'assistant/attempt'> = {
      type: 'assistant/attempt', seq: 2, time: IN_SEGMENT_MS,
      data: {
        turn: 1, step: 1,
        stream: [{ type: 'chunk', time: IN_SEGMENT_MS, chunk: { type: 'usage', usage: FLASH_USAGE } }],
      },
    }
    f.apply(attempt)
    const first = f.view().amount
    expect(first).toBeCloseTo((3.6 + 0.05 + 0.9) * 0.5, 10)
    const finalUsage: TokenUsage = { ...FLASH_USAGE, outputTokens: 200_000 }
    f.apply(usageEvent(3, IN_SEGMENT_MS, 1, 1, finalUsage))
    const second = f.view().amount
    // The settlement replaces the attempt's contribution for that step, not adds to it.
    expect(second).toBeCloseTo(first + 0.45, 10) // extra 0.1M output × 9.0 × 0.5
  })

  it('prices each model under its own entry and follows model switches', () => {
    const f = fold(tuesdayPolicy(0.5))
    f.apply(headerEvent('deepseek-v4-flash', 1))
    f.apply(usageEvent(2, OUT_SEGMENT_MS, 1, 1, { inputTokens: 1_000_000, outputTokens: 0 }))
    f.apply(headerEvent('deepseek-v4-pro', 3))
    f.apply(usageEvent(4, OUT_SEGMENT_MS, 2, 1, { inputTokens: 1_000_000, outputTokens: 0 }))
    // flash input 3.0 + pro input 9.0 at the list rate (outside the segment).
    expect(f.view().amount).toBeCloseTo(12, 10)
  })

  it('keeps the current model when a header repeats it', () => {
    const f = fold()
    f.apply(headerEvent('deepseek-v4-flash', 1))
    const before = f.state
    f.apply(headerEvent('deepseek-v4-flash', 2))
    expect(f.state).toBe(before)
  })

  it('ignores a repeated identical sample for the same step', () => {
    const f = fold(tuesdayPolicy(0.5))
    f.apply(headerEvent('deepseek-v4-flash', 1))
    f.apply(usageEvent(2, IN_SEGMENT_MS, 1, 1, FLASH_USAGE))
    const first = f.view().amount
    f.apply(usageEvent(3, IN_SEGMENT_MS, 1, 1, FLASH_USAGE))
    expect(f.view().amount).toBeCloseTo(first, 10)
  })

  it('prices nothing for an unknown model', () => {
    const f = fold(tuesdayPolicy(0.5))
    f.apply(headerEvent('no-such-model', 1))
    f.apply(usageEvent(2, IN_SEGMENT_MS, 1, 1, FLASH_USAGE))
    expect(f.view().amount).toBe(0)
  })

  it('reprices the whole history when a different policy is captured', () => {
    const cheap = fold(tuesdayPolicy(0.5))
    cheap.apply(headerEvent('deepseek-v4-flash', 1))
    cheap.apply(usageEvent(2, IN_SEGMENT_MS, 1, 1, FLASH_USAGE))
    const expensive = fold(tuesdayPolicy(1))
    expensive.apply(headerEvent('deepseek-v4-flash', 1))
    expensive.apply(usageEvent(2, IN_SEGMENT_MS, 1, 1, FLASH_USAGE))
    expect(expensive.view().amount).toBeCloseTo(cheap.view().amount * 2, 10)
  })
})

/** A structurally valid live Config over one mutable policy, as the Host projects it. */
function liveConfig(initial: PricingSettings = DEFAULT_PRICING_SETTINGS): {
  config: Config
  set(next: PricingSettings): void
} {
  let value = initial
  const ref = <T,>(read: () => T): Volatile<T> => ({ get: read })
  return {
    config: {
      currency: ref(() => value.currency),
      models: ref(() => value.models),
      defaultSchedule: ref(() => value.defaultSchedule),
      overrides: ref(() => value.overrides),
      manualSpend: ref(() => value.manualSpend ?? 0),
    },
    set: (next) => { value = next },
  }
}

/** Publish one new revision of the pricing section, as the Host settings service does. */
function publish(ctx: Context): void {
  ctx.emit('settings/document-updated', PRICING_SETTINGS_NAMESPACE as never, 1)
}

async function harness(initial: PricingSettings = DEFAULT_PRICING_SETTINGS): Promise<{
  ctx: Context
  session: Session
  live: ReturnType<typeof liveConfig>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore).await()
  await ctx.plugin(SessionProjectionRegistry).await()
  const live = liveConfig(initial)
  await ctx.plugin({ apply: (pluginCtx: Context) => { apply(pluginCtx, live.config) } }).await()
  return { ctx, session: ctx.sessions.create(), live }
}

function appendStep(session: Session, turn: number, step: number, model: string, usage: TokenUsage): void {
  session.append('request/header', {
    header: { config: { provider: 'deepseek-official', model } },
    reason: 'initial',
  })
  session.append('step/start', { turn, step })
  session.append('assistant/message', {
    turn, step,
    message: createMessage({
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider: 'deepseek-official', model },
    }),
    // The settlement carries its own compact stream; provider accounting rides
    // `usage` and needs no source-event references.
    stream: [],
    usage,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
}

const projectedCost = (ctx: Context, session: Session): CostProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.cost
  if (value === undefined) throw new Error('cost projection is not registered')
  return value
}

afterEach(() => {
  vi.useRealTimers()
})

describe('pricing plugin', () => {
  it('registers the cost projection with the official defaults', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(IN_SEGMENT_MS)
    const { ctx, session } = await harness()
    appendStep(session, 1, 1, 'deepseek-v4-flash', {
      inputTokens: 1_000_000, outputTokens: 0,
    })
    // Defaults define one all-day list-price segment, so every sample prices at the list rate.
    expect(projectedCost(ctx, session).amount).toBeCloseTo(3.0, 10)
    expect(projectedCost(ctx, session).currency).toBe('CNY')
  })

  it('sums every live session into the displayed total', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(IN_SEGMENT_MS)
    const { ctx, session } = await harness()
    const other = ctx.sessions.create()
    appendStep(session, 1, 1, 'deepseek-v4-flash', {
      inputTokens: 1_000_000, outputTokens: 0,
    })
    appendStep(other, 1, 1, 'deepseek-v4-flash', {
      inputTokens: 1_000_000, outputTokens: 0,
    })
    // 3.0 per session at the list rate, summed → 6.0 on either session's view.
    expect(projectedCost(ctx, session).amount).toBeCloseTo(6.0, 10)
    expect(projectedCost(ctx, other).amount).toBeCloseTo(6.0, 10)
  })

  it('reprices the log when the published section changes (re-registration refold)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(IN_SEGMENT_MS)
    const { ctx, session, live } = await harness()
    appendStep(session, 1, 1, 'deepseek-v4-flash', {
      inputTokens: 1_000_000, outputTokens: 0,
    })
    expect(projectedCost(ctx, session).amount).toBeCloseTo(3.0, 10)

    live.set(tuesdayPolicy(0.5))
    publish(ctx)
    // The sample sits inside the new 09:00–12:00 window (10:00 Beijing).
    expect(projectedCost(ctx, session).amount).toBeCloseTo(1.5, 10)

    live.set(tuesdayPolicy(1))
    publish(ctx)
    expect(projectedCost(ctx, session).amount).toBeCloseTo(3.0, 10)
  })

  it('re-reads prices from the same section revision', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(IN_SEGMENT_MS)
    const { ctx, session, live } = await harness()
    appendStep(session, 1, 1, 'deepseek-v4-flash', {
      inputTokens: 1_000_000, outputTokens: 0,
    })
    live.set({
      ...DEFAULT_PRICING_SETTINGS,
      models: { 'deepseek-v4-flash': { inputPeak: 6, cacheHitPeak: 0.2, outputPeak: 18 } },
    })
    publish(ctx)
    expect(projectedCost(ctx, session).amount).toBeCloseTo(6.0, 10)
  })

  it('ignores revisions of other entries', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(IN_SEGMENT_MS)
    const { ctx } = await harness()
    const register = vi.spyOn(ctx.sessionProjections, 'register')
    ctx.emit('settings/document-updated', 'other' as never, 1)
    // A different entry's revision must not re-register the cost unit.
    expect(register).not.toHaveBeenCalled()
    publish(ctx)
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('installs nothing without a projection registry', async () => {
    const ctx = new Context()
    await ctx.plugin({ apply: (pluginCtx: Context) => { apply(pluginCtx, liveConfig().config) } }).await()
    expect(ctx.get('sessionProjections')).toBeUndefined()
  })
})
