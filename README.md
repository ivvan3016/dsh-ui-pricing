# dsh-ui-pricing

English | [中文](README.zh.md)

User-configurable cost pricing for dsh: the `pricing` settings section (per-model list prices and a per-day time policy with price multipliers) plus the `cost` session projection that prices provider-reported usage with the multiplier in force at each sample's own timestamp, and a composer-dock **CostLine** that shows every live session's spend summed together (with an in-place correction entry) and a live 24-hour multiplier strip. Nothing is hardcoded: the default section prices every day at the list price, and a Plugins-settings card lets you define your own time policy — a default timeline applied to every day plus per-day exceptions, each segment's multiplier editable (1.0 is the list price, 0.5 halves it), and per-model prices.

## Install

```sh
# from npm (recommended)
dsh plugin --profile web add dsh-ui-pricing

# from GitHub
dsh plugin --profile web add github:ivvan3016/dsh-ui-pricing
```

The npm package ships prebuilt artifacts and installs without any further setup. Git installs fetch the source and rebuild it via `prepare`; pnpm blocks that build until the package is allowlisted. When a git install fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, copy the **exact key pnpm prints** into the profile's `pnpm-workspace.yaml` and re-run the command:

```yaml
allowBuilds:
  dsh-ui-pricing@https://codeload.github.com/ivvan3016/dsh-ui-pricing/tar.gz/<commit-hash>: true
```

The key is bound to one resolved commit — a bare package name does not match, and it changes only when you update the dependency to a newer commit.

## Uninstall

```sh
dsh plugin --profile web remove dsh-ui-pricing
```

Removing the plugin drops its bundle layer and removes the package from the profile.

## Configuration

The package registers the `pricing` settings namespace (see [dsh-settings](../../settings/settings/README.md)):

| Field | Default | Meaning |
|---|---|---|
| `currency` | `CNY` | Currency code the prices are denominated in. |
| `models` | V4 catalog | List prices per model id in currency units per one million tokens; a model with no entry is unpriced. Cache writes are billed at the cache-miss input rate (DeepSeek has no separate write price). |
| `defaultSchedule` | one 00:00–24:00 segment at multiplier 1 | The default time policy every day uses unless overridden; a segment is an `HH:MM` window with a `multiplier`. A segment whose `end` is earlier than its `start` wraps midnight. |
| `overrides` | `{}` | Per-day exceptions: a day present here uses its own `TimeSegment[]` instead of the default schedule. |
| `manualSpend` | `0` | Manual-spend correction delta added to the auto-computed total: a positive value tops the estimate up, a negative one trims it. The CostLine writes it when you correct the total in place (`corrected total − auto amount`), so the display reads `auto + manualSpend` and keeps accruing usage on top of the correction. |

**Settings → Plugins → Plugin configuration** shows a **Pricing settings** card: a per-model price table (model rows are seeded from the wire `llm.models()` catalog, so the deployment's actual models appear), one **default timeline** that applies to every day, and **day-exception toggles** — enabling a weekday gives it its own timeline that overrides the default (e.g. a weekend that is off-peak all day). On a timeline, click inside a segment to split it, drag a handle to move a boundary (dragging never inserts), click × to remove a boundary, and type each segment's multiplier directly.

The `cost` projection re-registers whenever the section changes, replaying the durable log under the new prices and windows.

## Cost line

When the composition provides the composer dock, the package registers a **cost** occupant that shows the total priced spend across **every live session** (the `cost` projection sums each session's fold) plus any `manualSpend` correction, with an "estimate" badge since it is computed from usage and multipliers, not a bill. Clicking the amount (when the deployment is writable) opens an in-place editor prefilled with the current total: typing a corrected total replaces the estimate, and later usage keeps accruing on top of it — the difference from the auto amount is stored as the correction delta (negative trims). The right side shows the current local time and the multiplier in force, and a 24-hour strip painted by multiplier band — discount (below list price), premium (above), or neutral (list price) — with a marker at the current minute. The section's Beijing-clock segments are shifted into the browser's timezone so the strip tracks the wall clock.

## Session projection

When the composition provides `ctx.sessionProjections`, the package registers the `cost` unit: a durable fold over each session log that prices every provider usage sample under the multiplier at the sample's timestamp and totals per model per multiplier. Same-`(turn, step)` samples replace rather than double-count; a later chunk for the same step subtracts the earlier one. The view sums every live session's fold — that is what the CostLine displays — and carries `{ amount, currency }`; a model absent from the `models` table prices to zero. A changed section re-registers the unit with a bumped state version, so stale persisted checkpoints are discarded and the whole log reprices.

## Model Experience

None, as the package prices already-logged provider usage samples and registers no prompt, message, schema, tool, or model call.

#### KV Cache effect

None; the fold only reads the cache-hit/cache-write token buckets providers report and never alters request prefixes.

## Known Limitations and Deferred Work

- **Unlisted models price to zero** — a model id absent from the `models` table contributes nothing to the projection; add an entry (in the card) to price it.
- **Timeline boundaries snap to whole hours** — dragging and clicking insert hour-aligned boundaries; minute-level segments must be edited in the settings document.
- **Overrides are copies, not references** — enabling a day exception copies the default schedule at that moment; later edits to the default do not propagate into an existing exception.
- **The total refreshes with the current session** — the readout re-reads the per-session projection when the current session emits events (or is re-opened), so other sessions' newly priced usage surfaces on the next such snapshot rather than instantly.
