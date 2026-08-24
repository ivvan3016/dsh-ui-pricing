# dsh-ui-pricing

[English](README.md) | 中文

dsh 的可自定义费用定价插件：`pricing` settings 段（各模型基准价 + 一周每天独立的分时价格倍率）以及按会话的 `cost` session projection——它用每个用量样本自身时间戳所处的倍率定价 provider 上报的用量。任何内容都不写死：默认段让每天按基准价计价，插件配置卡片让你自定义时段策略——在 24 小时时间轴上拖动分割点、把某几天关联共享同一时段、为每段设置倍率（1.0 为基准价，0.5 即半价），并可逐模型编辑价格。

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
| `days` | 全部为空 | 一周每天独立的 `TimeSegment[]`；每段是带 `multiplier` 的 `HH:MM` 窗口。空的天整天按基准价计价；`end` 早于 `start` 的段跨午夜。 |
| `dayLinks` | `{}` | 共享另一天时段的关联，例如 `{ saturday: 'friday' }` 表示周六跟随周五的时段。 |

**设置** → **插件** → **插件配置** 中会显示"价格设置"卡片：一个逐模型价格表（模型行来自 wire 的 `llm.providers()` 发现，因此会显示部署实际拥有的模型）和一周每天各一条可拖动时间轴。在时间轴上：拖动分割点移动边界、点击轴插入新分割点、点击 × 删除、双击某段编辑其倍率。**跟随**选择器把某天关联到另一天的时段，因此共享模式（例如休息日全天谷价）只需配置一次。

`cost` projection 在段变更时重新注册，用新价格与时段重放持久日志。

## Session projection

当组合提供 `ctx.sessionProjections` 时，本包注册 `cost` 单元：对会话日志做持久折叠，按样本时间戳所处倍率定价每个 provider 用量样本，并按模型 × 倍率汇总。同一 `(turn, step)` 的样本替换而非重复计数；同一 step 的后续 chunk 会先减去较早的贡献。视图携带 `{ amount, currency }`；`models` 表中缺失的模型计为零。段变更时以递增的 state version 重新注册单元，丢弃过期的持久检查点并整体重算。

## Model Experience

无。本包只为已记录的 provider 用量样本定价，不注册任何提示词、消息、schema、工具或模型调用。

#### KV Cache effect

无。折叠只读取 provider 上报的缓存命中/写入 token 桶，从不改动请求前缀。

## Known Limitations and Deferred Work

- **未列出的模型计为零** —— `models` 表中缺失的模型 id 对投影无贡献；在卡片中添加入口即可定价。
- **时间轴分割点按整点吸附** —— 拖动与点击插入的是整点对齐的边界；分钟级时段需在设置文档中编辑。
- **天关联是单向的** —— `dayLinks` 让某天跟随另一天，没有双向分组编辑。跟随某天后编辑它，跟随者会同步更新。
