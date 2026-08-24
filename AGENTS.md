# dsh-ui-pricing

A standalone-published dsh (DeepSeek Harness) plugin that lets users configure cost pricing: per-model list prices and per-day-of-week time segments with price multipliers, edited through a Plugins-settings card with draggable 24-hour timelines.

## Project Overview

Two halves, both built from this repo:

- Node half (`src/index.ts`): registers the `pricing` settings namespace with its schema and the `cost` session projection unit that prices provider-reported usage.
- Client half (`src/client/`): renders the pricing settings card — a per-model price table seeded from the wire `llm.providers()` discovery, one draggable timeline per day, and day-link controls.

The browser runs the client bundle as `/plugins/<id>/client.js?rev=<hash>`, loaded through the harness contract `window.__ModuleLoader__.load({ id, factory })`.

## Repository Layout

- `src/pricing.ts` — client-safe pricing vocabulary: `Weekday`, `TimeSegment`, `DaySchedule`, `DayLinks`, `PricingSettings`, defaults, and pure time/multiplier math (`multiplierAt`, `weekdayAt`, `effectiveSchedule`, `inSegment`, `priceAt`, `sampleCost`).
- `src/index.ts` — plugin entry; node-half settings registration and cost projection wiring.
- `src/cost-projection.ts` — the `cost` session projection unit (prices usage samples at their timestamp's multiplier).
- `src/client/` — browser half: `index.ts` (apply), `PricingCard.tsx` (+ `.module.css`), `DayTimeline.tsx` (+ `.module.css`), `pricing-form.ts` (staged form + model discovery), `locales.ts`.
- `tests/` — vitest specs: `pricing.spec.ts` (pure math), `cost-projection.spec.ts` (host fold).
- `scripts/build.mjs` — esbuild build; runs as the package `prepare` script.
- `cordis.patch.yml` — dsh bundle patch layer; its `name` must match the package name.

## Common Commands

```sh
pnpm install            # install devDependencies (esbuild, schemastery, zod, clsx, ...)
node scripts/build.mjs  # run the prepare build manually
```

## Building

`scripts/build.mjs` bundles the node half with esbuild and the client half with the loader handoff. Two hard requirements in the browser build, already fixed — do not regress them:

1. `jsx: 'automatic'` — components never `import React`. Without it, the classic transform emits `React.createElement` and the card crashes at runtime with "React is not defined".
2. The CSS Modules rewrite must touch **selector text only**, via `/(?<![0-9a-zA-Z])\.([a-zA-Z_][a-zA-Z0-9_-]*)/g` inside `source.replace(/([^{}]*)\{/g, ...)`. Naive rewrites corrupt decimal values (`opacity: 0.4` → `opacity: 0.dshpricing-4`) and prefix only the first selector of comma groups. The prefix is `dshpricing-` here.

Sanity-check built `lib/client.js` for: `__ModuleLoader__.load({ id: "dsh-ui-pricing"`; zero `React.createElement`; `dshpricing-` class prefixes present.

## Testing

- `pricing.spec.ts` — pure math: `multiplierAt` per segment and per weekday, `effectiveSchedule` through `dayLinks` chains and cycles, clock helpers, `priceAt`/`sampleCost` at multipliers.
- `cost-projection.spec.ts` — host fold: usage samples priced at their timestamp's multiplier, same-step replacement, model switches, policy reprice.

The specs import `@deepseek-ai/*` peers that exist at `0.1.0-rc.8` only in the deepseek-harness workspace, so they run from a temporary package inside that checkout. Sync the copied `src/` and `tests/` from this repo after editing, then run with a harness vitest config (see the deepseek-harness repo for the established pattern). After any build change, also spot-check the bundle (see Building).

## Settings Namespace

The settings namespace is `pricing`, registered by the node half. **Keep it unchanged.** It is intentionally shared with the surface plugin that reads the section; renaming it would break the cost display. The model price table is a `Record<modelId, { inputPeak, cacheHitPeak, outputPeak }>`; `days` is a `Record<Weekday, { segments: TimeSegment[] }>`; `dayLinks` maps a day to the day it follows.
