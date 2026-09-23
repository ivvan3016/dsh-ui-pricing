import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/** Absolute path into the deepseek-harness checkout that owns the peer sources. */
const harness = (path: string): string =>
  fileURLToPath(new URL(`../../deepseek-harness/${path}`, import.meta.url))

/**
 * Standalone vitest config for this plugin's specs. The snapshot-store engine
 * is imported as a value, and its published Node entry expects a
 * host-provided state library, so the specs resolve it to its source in the
 * deepseek-harness checkout. Every other `@deepseek-ai/*` import is type-only
 * or a plain library entry and resolves from the plugin's own node_modules.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@deepseek-ai\/dsh-client-store$/, replacement: harness('packages/client/store/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
  },
})
