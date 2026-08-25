/**
 * Pricing plugin, browser half: registers the Plugins-settings card that
 * edits the `pricing` section — per-model list prices, a default per-day
 * time policy with per-day exceptions — and the composer-dock CostLine that
 * shows every session's priced spend summed together (with an in-place
 * correction entry) plus the live multiplier strip. The model rows are
 * seeded from the wire `llm.models()` catalog so the card covers the
 * deployment's actual models. The package issues no RPC beyond that read
 * and renders nothing outside the card and the dock row.
 */
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the ctx.settingsScope Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings.plugin.item SlotMap merge declared by the Plugins
// configuration section (the card registers into that keyed slot).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: the ui-conversation SlotMap merge (the composer.dock entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PRICING_SETTINGS_NAMESPACE, type PricingSettings } from '../pricing.ts'
import { PricingCardController } from './pricing-form.ts'
import { PricingCard } from './PricingCard.tsx'
import { CostLine, type CostCorrectionState } from './CostLine.tsx'
import { en, NS, zh, type PricingKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Pricing settings copy. */
    'pricing': PricingKey
  }
}

/** Required services: the settings scope, locale, slots, and connection. */
export const inject = ['slots', 'locale', 'settingsScope', 'connection']

/**
 * Client plugin body: register the dictionaries, bind the settings scope,
 * wire the card controller to the connection's model discovery, and register
 * the Plugins card and the composer-dock CostLine that read the section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-pricing: dictionaries')
  const scope = ctx.settingsScope.bind<PricingSettings>({ namespace: PRICING_SETTINGS_NAMESPACE })
  const connection = ctx.get('connection') as ConnectionHandle
  const card = new PricingCardController(scope, connection.api)

  // Identity-stable bare source over the mirrored section (the renderer binds
  // usePricing once per source; undefined until the Host syncs the namespace).
  const pricingSource: HostObservable<PricingSettings | undefined> = {
    getSnapshot: () => scope.getSnapshot().value,
    subscribe: listener => scope.subscribe(listener),
  }

  // Identity-stable writable flag for the CostLine correction entry (the
  // settings snapshot reference is stable between changes, so the cached
  // object only changes when the flag actually flips).
  let correctionSnapshot: CostCorrectionState = { writable: scope.getSnapshot().writable }
  const correctionSource: HostObservable<CostCorrectionState> = {
    getSnapshot: () => {
      const writable = scope.getSnapshot().writable
      if (writable !== correctionSnapshot.writable) correctionSnapshot = { writable }
      return correctionSnapshot
    },
    subscribe: listener => scope.subscribe(listener),
  }

  // The dock entry writes the correction delta (`corrected total − auto`);
  // the CostLine computes it from the projection before calling.
  const correctSpend = (delta: number): void => { void scope.set('manualSpend', delta) }

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: PRICING_SETTINGS_NAMESPACE,
    locale: NS,
    inject: () => card.inject(),
  }, PricingCard))

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'cost',
    order: 1,
    locale: NS,
    inject: () => ({
      hooks: { pricing: pricingSource, correction: correctionSource },
      correctSpend,
    }),
  }, CostLine))
}
