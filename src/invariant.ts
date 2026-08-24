/**
 * Package-owned invariant companion for `dsh-ui-pricing`.
 * @module dsh-ui-pricing/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-ui-pricing'

/** Cordis companion plugin name. */
export const name = 'dsh-ui-pricing-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package contributes pure fold mathematics and a
 * settings section; the session-projection registry owns the drive, and the
 * settings registry owns section resolution. Both owning registries check
 * their own event/data relations.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
