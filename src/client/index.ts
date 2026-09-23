/**
 * Pricing plugin, browser half: registers the card that edits the `pricing`
 * entry's live Config — per-model list prices, a default per-day time policy
 * with per-day exceptions — on the plugin's Plugins-page row, and the
 * composer-dock CostLine that shows every session's priced spend summed
 * together (with an in-place correction entry) plus the live multiplier
 * strip. The model rows are seeded from the Host's session model catalogue so
 * the card covers the deployment's actual models. The package issues no RPC
 * beyond that read and renders nothing outside the card and the dock row.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the ConfigForm contract and the ctx.configForms Context merge.
// Cross-plugin collaboration goes through the service, never a value import
// (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the plugins.row.config SlotMap merge declared by the Plugins page
// (the row page this card occupies).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: the ui-conversation SlotMap merge (the composer dock entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the ctx.slots Context merge owned by the renderer registry.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { PRICING_ROW_CONFIG_KEY, PRICING_SETTINGS_NAMESPACE, type PricingSettings } from '../pricing.ts'
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

/** Required services: the settings forms, locale, slots, and the session Remote namespace. */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

/**
 * Client plugin body: register the dictionaries, bind the Host entry's
 * configuration form, wire the card controller to the Host model catalogue,
 * and register the Plugins-page card and the composer-dock CostLine that read
 * the section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-pricing: dictionaries')
  const form = ctx.configForms.get<PricingSettings>(PRICING_SETTINGS_NAMESPACE)
  const card = new PricingCardController(form, ctx.remote.session)

  // Identity-stable bare source over the mirrored section (the renderer binds
  // usePricing once per source; undefined until the Host syncs the namespace).
  const pricingSource: HostObservable<PricingSettings | undefined> = {
    getSnapshot: () => form.getSnapshot().value,
    subscribe: listener => form.subscribe(listener),
  }

  // Identity-stable writable flag for the CostLine correction entry (the
  // settings snapshot reference is stable between changes, so the cached
  // object only changes when the flag actually flips).
  let correctionSnapshot: CostCorrectionState = { writable: form.getSnapshot().writable }
  const correctionSource: HostObservable<CostCorrectionState> = {
    getSnapshot: () => {
      const writable = form.getSnapshot().writable
      if (writable !== correctionSnapshot.writable) correctionSnapshot = { writable }
      return correctionSnapshot
    },
    subscribe: listener => form.subscribe(listener),
  }

  // The dock entry writes the correction delta (`corrected total − auto`);
  // the CostLine computes it from the projection before calling.
  const correctSpend = (delta: number): void => { void form.set('manualSpend', delta) }

  // The catalogue is not part of any settings section: adapters come and go, a
  // document commit elsewhere can change which routes are stored, a credential
  // decides whether a route is servable, and a reconnect replaces the whole
  // Host generation.
  ctx.effect(
    () => ctx.remote.$on('llm/adapters-updated', () => { card.refreshCatalog() }),
    'ui-pricing: adapter invalidations',
  )
  ctx.effect(
    () => ctx.remote.$on('settings/document-updated', () => { card.refreshCatalog() }),
    'ui-pricing: settings invalidations',
  )
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', () => { card.refreshCatalog() }),
    'ui-pricing: credential invalidations',
  )
  ctx.effect(
    () => ctx.on('connection/reset', () => { card.refreshCatalog() }),
    'ui-pricing: connection generation',
  )

  // The card appears only while the Host serves the namespace: an entry that
  // publishes no live settings has no section, and a deployment without this
  // plugin shows no trace of the page.
  ctx.effect(() => ctx.configForms.whileServed([PRICING_SETTINGS_NAMESPACE], () => ctx.slots.inject(
    'plugins.row.config',
    () => ctx.slots.register({
      name: 'plugins.row.config',
      key: PRICING_ROW_CONFIG_KEY,
      locale: NS,
      inject: () => card.inject(),
    }, PricingCard),
  )), 'ui-pricing: settings card')

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
