# dsh-ui-pricing

English | [中文](README.zh.md)

User-configurable cost pricing for dsh: the `pricing` settings section (per-model list prices and per-day-of-week time segments with price multipliers) plus the per-session `cost` session projection that prices provider-reported usage with the multiplier in force at each sample's own timestamp. Nothing is hardcoded: the default section prices every day at the list price, and a Plugins-settings card lets you define your own time policy — drag boundaries on a 24-hour timeline per day, link days that share a schedule, set each segment's multiplier (1.0 is the list price, 0.5 halves it), and edit per-model prices.

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
| `days` | all empty | Per-day-of-week `TimeSegment[]`; a segment is an `HH:MM` window with a `multiplier`. An empty day prices the whole day at the list price; a segment whose `end` is earlier than its `start` wraps midnight. |
| `dayLinks` | `{}` | Days that share another day's schedule, e.g. `{ saturday: 'friday' }` makes Saturday follow Friday's segments. |

**Settings → Plugins → Plugin configuration** shows a **Pricing settings** card: a per-model price table (model rows are seeded from the wire `llm.providers()` discovery, so the deployment's actual models appear) and one draggable timeline per day of the week. On a timeline, drag a handle to move a boundary, click the axis to insert a new boundary, click × to remove one, and double-click a segment to edit its multiplier. The **follow** selector links a day to another day's schedule, so a shared pattern (e.g. a weekend that is off-peak all day) is configured once.

The `cost` projection re-registers whenever the section changes, replaying the durable log under the new prices and windows.

## Session projection

When the composition provides `ctx.sessionProjections`, the package registers the `cost` unit: a durable fold over the session log that prices each provider usage sample under the multiplier at the sample's timestamp and totals per model per multiplier. Same-`(turn, step)` samples replace rather than double-count; a later chunk for the same step subtracts the earlier one. The view carries `{ amount, currency }`; a model absent from the `models` table prices to zero. A changed section re-registers the unit with a bumped state version, so stale persisted checkpoints are discarded and the whole log reprices.

## Model Experience

None, as the package prices already-logged provider usage samples and registers no prompt, message, schema, tool, or model call.

#### KV Cache effect

None; the fold only reads the cache-hit/cache-write token buckets providers report and never alters request prefixes.

## Known Limitations and Deferred Work

- **Unlisted models price to zero** — a model id absent from the `models` table contributes nothing to the projection; add an entry (in the card) to price it.
- **Timeline boundaries snap to whole hours** — dragging and clicking insert hour-aligned boundaries; minute-level segments must be edited in the settings document.
- **Day links are one-way** — `dayLinks` makes one day follow another; there is no two-way group editing. Follow a day, edit it, and the followers update.
