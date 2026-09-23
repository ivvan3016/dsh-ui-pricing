# dsh-ui-pricing

A standalone-published dsh (DeepSeek Harness) plugin that lets users configure cost pricing and see it live: per-model list prices and one default 24-hour time policy with price multipliers, edited through a Plugins-page card with a draggable timeline plus per-day exceptions, and a composer-dock CostLine showing the session spend and the live multiplier strip.

Targets dsh `0.1.7-alpha.2`.

## Project Overview

Two halves, both built from this repo:

- Node half (`src/index.ts`): declares the `pricing` plugin entry's live `Config` and registers the `cost` session projection unit that prices provider-reported usage.
- Client half (`src/client/`): renders the pricing card on the plugin's Plugins-page row (per-model prices seeded from the Host model catalogue, one default timeline, per-day exception toggles) and the composer-dock CostLine (spend + 24-hour multiplier strip).

The browser runs the client bundle as `/plugins/<id>/client.js?rev=<hash>`, loaded through the harness contract `window.__ModuleLoader__.load({ id, factory })`.

## Repository Layout

- `src/pricing.ts` — client-safe pricing vocabulary: `Weekday`, `TimeSegment`, `DaySchedule`, `DayOverride`, `PricingSettings`, defaults, the row-config key, and pure time/multiplier math (`multiplierAt`, `weekdayAt`, `effectiveSchedule`, `inSegment`, `settingsInOffset`, `priceAt`, `sampleCost`).
- `src/index.ts` — plugin entry; the entry's `Config` schema, `policyOf` (the captured policy snapshot), and the cost-projection wiring.
- `src/cost-projection.ts` — the `cost` session projection unit (prices usage samples at their timestamp's multiplier).
- `src/projection.ts` — the wire value and fold-state types plus the projection-table merges.
- `src/client/` — browser half: `index.ts` (apply, both slot registrations), `PricingCard.tsx` (+ `.module.css`), `DayTimeline.tsx` (+ `.module.css`), `CostLine.tsx` (+ `.module.css`), `pricing-form.ts` (staged form + catalogue discovery), `locales.ts`.
- `tests/` — vitest specs: `pricing.spec.ts` (pure math), `cost-projection.spec.ts` (fold + plugin registration), `pricing-card.client.spec.tsx` (card controller + component), `cost-line.client.spec.tsx` (CostLine component).
- `scripts/build.mjs` — esbuild build; runs as the package `prepare` script.
- `tsconfig.json` — declaration-only project emitting `lib/types/**/*.d.ts` from `src/`.
- `cordis.patch.yml` — dsh bundle patch layer; its `name` must match the package name, and its row `id` is the settings namespace.

## Common Commands

```sh
pnpm install            # install devDependencies (esbuild, typescript, vitest, schemastery, zod, clsx, ...)
pnpm run build          # bundle + emit declarations; runs as the package `prepare` script
pnpm test               # run the vitest specs
```

## Building

`pnpm run build` runs two phases: `scripts/build.mjs` bundles the runtime entry points with esbuild, then `tsc -p tsconfig.json` emits `lib/types/**/*.d.ts`. The package `prepare` script runs both, so a git install and an npm publish produce the same payload.

The node half bundles `@deepseek-ai/schemastery` (currently `~3.18.4`) and `zod` so the package installs with no registry dependencies. Two hard requirements, already fixed — do not regress them:

1. Every preference is declared `.volatile()`. The Host describes a settings section only for an entry whose schema publishes at least one live field, and a settings write must address a volatile path — without it the card never appears and every save is refused.
2. `src/index.ts` keeps `import type {} from '@deepseek-ai/cosmokit'` and the package keeps `@deepseek-ai/cosmokit` in devDependencies. `z.dict` infers through cosmokit's `Dict`, so the emitted declaration of `Config` must be able to name that module; dropping the edge brings back `TS2883` ("inferred type cannot be named") in the declaration phase.

`scripts/build.mjs` bundles the client half with esbuild. Two hard requirements, also already fixed:

1. `jsx: 'automatic'` — components never `import React`. Without it, the classic transform emits `React.createElement` and the card crashes at runtime with "React is not defined".
2. The CSS Modules rewrite must touch **selector text only**, via `/(?<![0-9a-zA-Z])\.([a-zA-Z_][a-zA-Z0-9_-]*)/g` inside `source.replace(/([^{}]*)\{/g, ...)`. Naive rewrites corrupt decimal values (`opacity: 0.4` → `opacity: 0.dshpricing-4`) and prefix only the first selector of comma groups. The prefix is `dshpricing-` here.

Sanity-check built `lib/client.js` for: `__ModuleLoader__.load({ id: "dsh-ui-pricing"`; zero `React.createElement`; `dshpricing-` class prefixes present; no `settingsScope`/`dsh-client-runtime`.

The declaration project compiles `src/` alone (no specs), so a Context or SlotMap merge that only the specs import must also be imported by the source using it — `import type {} from '…'` is the idiom (`ui-session` supplies the `useProjection` seat the CostLine reads, `ui-conversation` the dock's props).

## Testing

- `pricing.spec.ts` — pure math: `multiplierAt` per segment and per weekday, `effectiveSchedule` override-vs-default, clock helpers, `settingsInOffset`, `priceAt`/`sampleCost` at multipliers.
- `cost-projection.spec.ts` — the fold (usage samples priced at their timestamp's multiplier, same-step replacement, model switches, reprice) plus the plugin half over real `SessionStore`/`SessionProjectionRegistry` services: defaults, the every-session aggregate, re-registration on a published section revision, other entries ignored, and no projection registry composed.
- `pricing-card.client.spec.tsx` — the card controller (catalogue discovery and failure, model add/remove, bucket edits, default timeline, overrides, save/discard, refused writes, rebasing) and the component's two views driven through props.
- `cost-line.client.spec.tsx` — the CostLine component (spend, manual correction, multiplier strip, timezone shifts, minute-boundary re-tick).

`pnpm test` runs standalone. The specs import the `@deepseek-ai/*` peers at `0.1.7-alpha.2` from devDependencies, except one value peer that `vitest.config.ts` aliases to its source in the deepseek-harness checkout: `@deepseek-ai/dsh-client-store` (its published Node entry expects a host-provided state library). That alias needs a sibling `../deepseek-harness` checkout. After any build change, also spot-check the bundle (see Building).

## Host API Surface

- `@deepseek-ai/cordis` — `Context`, `Volatile` (the live Config fields), and the `settings/document-updated` event the projection re-registration listens to.
- `@deepseek-ai/schemastery` + `@deepseek-ai/cosmokit` — the entry `Config` schema (volatile fields; cosmokit is the nameable `Dict` reference, see Building).
- `@deepseek-ai/dsh-session-projection` — `ProjectionDefinition` and `ctx.sessionProjections.register()/stateOf()`.
- `@deepseek-ai/dsh-session` — `SessionStore` (`ctx.sessions.list()`), `SessionEvent`.
- `@deepseek-ai/dsh-llm` — `TokenUsage` and `lastAssistantStreamChunk` (a settlement's usage rides `assistant/message`'s `usage` or the last usage chunk of its compact stream).
- `zod` — the projection state and view schemas.

## Client API Surface

The browser half binds only through services and slot declarations — cross-package **value** imports are forbidden (the bundle purity gate) and every `@deepseek-ai/*` import outside the module-table seed words must stay type-only:

- `@deepseek-ai/cordis` — `Context` (the client context; there is no `ClientContext` export any more).
- `@deepseek-ai/dsh-client-store` — `createSnapshotStore`, `SnapshotStore`, `ObservableSnapshot` (a module-table seed word).
- `@deepseek-ai/dsh-client-ui-settings/client` — `ConfigForm`, `ConfigFormSnapshot` (`ctx.configForms.get(entryId)`, `whileServed([...])`).
- `@deepseek-ai/dsh-api-remotes/client` — `RemoteResult`, `ModelCatalog`, and the forwarded events (`llm/adapters-updated`, `settings/document-updated`) that refresh the catalogue.
- `@deepseek-ai/dsh-api-session-controller/client` — `UseProjection` (re-exported through the session standard kit).
- `@deepseek-ai/dsh-client-ui-session/client` — the session standard props (`useProjection`) the dock occupant receives.
- `@deepseek-ai/dsh-client-ui-conversation/client` — the `conversation.composer.dock` SlotMap merge.
- `@deepseek-ai/dsh-client-ui-plugin-manager/client` — the `plugins.row.config` SlotMap merge, `PluginConfigViewProps`, and `rowConfigKey(package, rowId)`.
- `@deepseek-ai/dsh-client-ui-slots` — `PropsRuntime`, `PropsLocale`, `InjectFace`, `HostObservable`, `LocaleNamespaceMap` (types only).
- `@deepseek-ai/dsh-client-ui-renderer/client` — owns `SlotRegistry` and the `ctx.slots` service (types only here).

## Settings Namespace

One active plugin entry publishes one settings section, keyed by that entry's id, so the namespace is the row id the bundle patch mounts: `pricing`. **Keep it unchanged** — renaming the row detaches the card from every stored price and policy. The id is intentionally distinct from the package name (`dsh-ui-pricing`).

Because the Host describes a section only for an entry whose schema publishes a live field, and because a settings write must address a volatile path, every field is declared `.volatile()`. The model price table is a `Record<modelId, { inputPeak, cacheHitPeak, outputPeak }>`; `defaultSchedule` is the `{ segments: TimeSegment[] }` every day uses unless overridden; `overrides` maps a weekday to its own `{ segments }`.

## Runtime Invariant

No `./invariant` companion is published, and none should be added back. The package owns pure fold mathematics and its own settings section; the session-projection registry owns the drive and the settings service owns section resolution, so no independent observations can diverge ([rule](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/AGENTS.md)). The fold, the registration, both surfaces, and their disposal are covered by this package's behavior specs.
