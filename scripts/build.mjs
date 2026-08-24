/**
 * Self-contained build for git installs: pnpm runs `prepare` after
 * `dsh plugin add github:...` fetches sources, so this script must not
 * assume the monorepo checkout. The node half is plain ESM with all dsh
 * runtime dependencies external; the browser half mirrors the monorepo
 * client preset's loader handoff (`window.__ModuleLoader__.load`) so the
 * dsh web module table can mount the row. React, runtime, and ui-primitives
 * come from the module table; schemastery, zod, and clsx are bundled in. CSS
 * Modules are rewritten to prefixed class names and injected as a
 * plugin-owned style tag, like the preset does. Type declarations are
 * deliberately not regenerated: the npm/tarball artifacts carry .d.ts from
 * the monorepo build.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const PKG = 'dsh-ui-pricing'

// Node half: dsh seams stay external (host-provided); schemastery and zod are
// bundled so the package installs with zero registry dependencies.
await build({
  entryPoints: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2024',
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-invariants',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-projection',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
  ],
  outdir: 'lib',
  logLevel: 'warning',
})

/** Minimal CSS Modules: prefix each local class, inject the sheet once. */
const cssModules = {
  name: 'css-modules',
  setup(build) {
    build.onResolve({ filter: /\.module\.css$/ }, (args) => ({ path: resolve(args.resolveDir, args.path), namespace: 'cssmod' }))
    build.onLoad({ filter: /.*/, namespace: 'cssmod' }, async (args) => {
      const source = await readFile(args.path, 'utf8')
      const names = new Map()
      // Rewrite ONLY selector text (up to a `{`): values such as `0.4` or
      // `.16s` must survive untouched, and every class of a comma group is
      // prefixed. A class token starts with a letter/underscore and is not
      // preceded by an alphanumeric (a decimal's fraction would match both
      // guards and corrupt the value).
      const rewritten = source.replace(/([^{}]*)\{/g, (whole, selector) => {
        const mapped = selector.replace(/(?<![0-9a-zA-Z])\.([a-zA-Z_][a-zA-Z0-9_-]*)/g, (match, name) => {
          const renamed = `dshpricing-${name}`
          names.set(name, renamed)
          return `.${renamed}`
        })
        return `${mapped}{`
      })
      const tagId = `${PKG}/${args.path.split(/[\\/]/).pop()}`
      const contents = [
        `const css = ${JSON.stringify(rewritten)};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        `if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="' + tagId + '"]')) {`,
        `  const tag = document.createElement('style');`,
        `  tag.dataset.plugin = ${JSON.stringify(PKG)};`,
        `  tag.dataset.pluginCss = tagId;`,
        `  tag.textContent = css;`,
        `  document.head.appendChild(tag);`,
        `}`,
        `export default ${JSON.stringify(Object.fromEntries(names))};`,
      ].join('\n')
      return { contents, loader: 'js' }
    })
  },
}

// Browser half: the loader handoff format, CJS like the client preset.
await build({
  entryPoints: { client: 'src/client/index.ts' },
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2024',
  // Automatic JSX runtime: components never `import React`, so the classic
  // transform's `React.createElement` would ReferenceError at render time.
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-runtime/client', '@deepseek-ai/dsh-client-ui-primitives'],
  outdir: 'lib',
  plugins: [cssModules],
  banner: {
    js: `var module = { exports: {} }; var exports = module.exports;\nwindow.__ModuleLoader__.load({ id: ${JSON.stringify(PKG)}, factory: (require) => {`,
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'warning',
})
