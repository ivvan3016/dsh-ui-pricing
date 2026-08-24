/**
 * Pricing settings plugin, browser half: registers the Plugins-settings card
 * that edits the `pricing` section — per-model list prices, per-day-of-week
 * time segments with price multipliers, and day links. The model rows are
 * seeded from the wire `llm.models()` catalog so the card covers the
 * deployment's actual models. The package issues no RPC beyond that read and
 * renders nothing outside the card.
 */
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.settingsScope Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings.plugin.item SlotMap merge declared by the Plugins
// configuration section (the card registers into that keyed slot).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { PRICING_SETTINGS_NAMESPACE, type PricingSettings } from '../pricing.ts'
import { PricingCardController } from './pricing-form.ts'
import { PricingCard } from './PricingCard.tsx'
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
 * the Plugins card that edits the preferences.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-pricing: dictionaries')
  const scope = ctx.settingsScope.bind<PricingSettings>({ namespace: PRICING_SETTINGS_NAMESPACE })
  const connection = ctx.get('connection') as ConnectionHandle
  const card = new PricingCardController(scope, connection.api)
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: PRICING_SETTINGS_NAMESPACE,
    locale: NS,
    inject: () => card.inject(),
  }, PricingCard))
}
