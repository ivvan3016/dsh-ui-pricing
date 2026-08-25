# dsh-ui-pricing

English | [中文](README.zh.md)

User-configurable cost pricing for dsh: the `pricing` settings section (per-model list prices and per-day-of-week time segments with price multipliers) plus the per-session `cost` session projection that prices provider-reported usage with the multiplier in force at each sample's own timestamp, and a composer-dock **CostLine** that shows the current session's spend and a live 24-hour multiplier strip. Nothing is hardcoded: the default section prices every day at the list price, and a Plugins-settings card lets you define your own time policy — drag boundaries on a 24-hour timeline per day, link days that share a schedule, set each segment's multiplier (1.0 is the list price, 0.5 halves it), and edit per-model prices.

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

**Settings → Plugins → Plugin configuration** shows a **Pricing settings** card: a per-model price table (model rows are seeded from the wire `llm.models()` catalog, so the deployment's actual models appear), one **default timeline** that applies to every day, and **day-exception toggles** — enabling a weekday gives it its own timeline that overrides the default (e.g. a weekend that is off-peak all day). On a timeline, click inside a segment to split it, drag a handle to move a boundary (dragging never inserts), click × to remove a boundary, and type each segment's multiplier directly.

The `cost` projection re-registers whenever the section changes, replaying the durable log under the new prices and windows.

## Cost line

When the composition provides the composer dock, the package registers a **cost** occupant that shows the current session's priced spend (from the `cost` projection) next to the current local time, the multiplier in force, and a 24-hour strip painted by multiplier band — discount (below list price), premium (above), or neutral (list price) — with a marker at the current minute. The section's Beijing-clock segments are shifted into the browser's timezone so the strip tracks the wall clock.

## Session projection

When the composition provides `ctx.sessionProjections`, the package registers the `cost` unit: a durable fold over the session log that prices each provider usage sample under the multiplier at the sample's timestamp and totals per model per multiplier. Same-`(turn, step)` samples replace rather than double-count; a later chunk for the same step subtracts the earlier one. The view carries `{ amount, currency }`; a model absent from the `models` table prices to zero. A changed section re-registers the unit with a bumped state version, so stale persisted checkpoints are discarded and the whole log reprices.

## Model Experience

None, as the package prices already-logged provider usage samples and registers no prompt, message, schema, tool, or model call.

#### KV Cache effect

None; the fold only reads the cache-hit/cache-write token buckets providers report and never alters request prefixes.

## Known Limitations and Deferred Work

- **Unlisted models price to zero** — a model id absent from the `models` table contributes nothing to the projection; add an entry (in the card) to price it.
- **Timeline boundaries snap to whole hours** — dragging and clicking insert hour-aligned boundaries; minute-level segments must be edited in the settings document.
- **Overrides are copies, not references** — enabling a day exception copies the default schedule at that moment; later edits to the default do not propagate into an existing exception.
