# dsh-ui-pricing

[English](README.md) | 中文

dsh 的可自定义费用定价插件：`pricing` settings 段（各模型基准价 + 分时价格倍率）以及 `cost` session projection——它用每个用量样本自身时间戳所处的倍率定价 provider 上报的用量，外加一个 composer-dock 的 **CostLine** 显示所有会话的消费总金额（可就地修正）和实时的 24 小时倍率条。任何内容都不写死：默认段让每天按基准价计价，插件配置卡片让你自定义时段策略——一条默认时间轴适用于每一天、可添加特例天，为每段设置倍率（1.0 为基准价，0.5 即半价），并可逐模型编辑价格。

## Install

```sh
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-ui-pricing

# 从 GitHub 安装
dsh plugin --profile web add github:ivvan3016/dsh-ui-pricing
```

npm 包自带构建产物，安装即可用，无需额外配置。从 GitHub 安装会拉取源码并通过 `prepare` 脚本重新构建；pnpm 会拦截该构建，直到包被加入白名单。当安装报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 时，把 pnpm 打印的**精确 key** 复制到 profile 的 `pnpm-workspace.yaml`，然后重新执行命令：

```yaml
allowBuilds:
  dsh-ui-pricing@https://codeload.github.com/ivvan3016/dsh-ui-pricing/tar.gz/<commit-hash>: true
```

该 key 与解析出的具体 commit 绑定——仅写包名不会匹配，且只有把依赖更新到更新的 commit 时它才会变化。

## Uninstall

```sh
dsh plugin --profile web remove dsh-ui-pricing
```

卸载会移除该插件的 bundle 层并从 profile 中删除包。

## Configuration

本包注册 `pricing` settings 命名空间（见 [dsh-settings](../../settings/settings/README.md)）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `currency` | `CNY` | 价格所用的货币代码。 |
| `models` | V4 目录 | 各模型的基准价（每百万 token 的货币单位）；未列出的模型不计价。缓存写入按缓存未命中输入价计费（DeepSeek 无单独的写入价）。 |
| `defaultSchedule` | 一段 00:00–24:00、倍率 1 | 默认适用于所有天的时段策略；每段是带 `multiplier` 的 `HH:MM` 窗口。`end` 早于 `start` 的段跨午夜。 |
| `overrides` | `{}` | 特例天：出现在这里的天使用自己的 `TimeSegment[]`，覆盖默认时段。 |
| `manualSpend` | `0` | 手动修正增量，叠加到自动估算的总消费上：正值上调、负值下调。CostLine 上就地修正总消费时写入（`修正总额 − 自动金额`），显示为 `自动 + manualSpend`，后续用量继续在修正值上累加。 |

**设置** → **插件** → **插件配置** 中会显示"价格设置"卡片：一个逐模型价格表（模型行来自 wire 的 `llm.models()` 目录，因此会显示部署实际拥有的模型）、一条**默认时间轴**（适用于每一天）和**特例天开关**——开启某天后该天拥有自己的时间轴，覆盖默认时段（例如休息日全天谷价）。在时间轴上：单击段内分割新时段、拖动分割点调整位置（拖动不会新增）、点击 × 删除，并可直接输入每段的倍率。

`cost` projection 在段变更时重新注册，用新价格与时段重放持久日志。

## Cost line

当组合提供 composer dock 时，本包注册一个 **cost** 占用项：显示**所有活跃会话**的总消费（`cost` projection 将每个会话的折叠求和）加上任何 `manualSpend` 修正，并带"估算"徽标（费用由用量与倍率推算，并非账单）。点击金额（部署可写时）会打开就地编辑框，预填当前总额：输入修正后的总额即可替换估算值，之后的用量继续在此之上累加——与自动金额的差值作为修正增量存储（负值下调）。旁边是当前本地时间、生效倍率，以及一条按倍率分档着色（折扣 <1、溢价 >1、中性 =1）的 24 小时条，带当前分钟标记。段中的北京时钟会平移到浏览器时区，使条跟随本地时钟。

## Session projection

当组合提供 `ctx.sessionProjections` 时，本包注册 `cost` 单元：对每个会话日志做持久折叠，按样本时间戳所处倍率定价每个 provider 用量样本，并按模型 × 倍率汇总。同一 `(turn, step)` 的样本替换而非重复计数；同一 step 的后续 chunk 会先减去较早的贡献。视图对每个活跃会话的折叠求和——这正是 CostLine 显示的值——并携带 `{ amount, currency }`；`models` 表中缺失的模型计为零。段变更时以递增的 state version 重新注册单元，丢弃过期的持久检查点并整体重算。

## Model Experience

无。本包只为已记录的 provider 用量样本定价，不注册任何提示词、消息、schema、工具或模型调用。

#### KV Cache effect

无。折叠只读取 provider 上报的缓存命中/写入 token 桶，从不改动请求前缀。

## Known Limitations and Deferred Work

- **未列出的模型计为零** —— `models` 表中缺失的模型 id 对投影无贡献；在卡片中添加入口即可定价。
- **时间轴分割点按整点吸附** —— 拖动与点击插入的是整点对齐的边界；分钟级时段需在设置文档中编辑。
- **特例天是拷贝而非引用** —— 开启某天特例时会复制当时的默认时段；之后修改默认时段不会同步进已存在的特例。
- **总额随当前会话刷新** —— 读数在当前会话产生事件（或重新打开）时重读该会话的投影快照，其他会话新增的费用会在下一次这样的快照中体现，而非即时更新。
