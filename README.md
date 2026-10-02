# dsh-plugin-quota

dsh 插件：**实时用量仪表**——本会话 token/步数/估算花费实时追踪，并给出**下一步预估**；同时是 dsh 插件家族的**通用插件开发测试模板**。

## 它做什么

- **实时追踪**：监听 `session/event`（assistant/message usage），每次模型回复后实时累计本会话的输入/输出/缓存命中 token，带价格表时同时估算花费（微单位累计，显示时格式化）；
- **注入系统提示**：每回合给模型一行实时仪表（`实时用量：13.8k tok / 50k ▰▰▰▱… · 5 步 · ≈0.0153 USD`），预算超限模型自己看得见；
- **/qm 面板**：本会话 + 今日全部会话合计，含预算进度条（`budgetTokens` > 0 时）和超预算警告；
- **下步预估**：`assistant/message` 的 `inputTokens` 就是上一步的未命中前缀，于是下一步的提示词 ≈ 上一步 input + 上一步 output（历史增量）+ 15% 工具结果裕量，缓存前缀按原样复用；输出区间取本会话各步的 P50/P85，按匹配到该模型的那一行价格折算，给成一个区间而不是假装精确的单个数。跑第一步之前**不编数字**，明说"还没有已完成的步"；
- **quota_meter 工具**：模型可自查，调用与结果都渲染成 generic 卡片（`presentCall`/`presentResult`），卡片标题带 `下步 ~30k`；
- **对家族发布预算契约**：见下表，别的插件读 `summary.json` 就够了，不需要知道会话 id 长什么样。

## 落盘与跨插件契约

`~/.dsh/quota/`（或 `dataPath` 所在目录）下三个文件，全原子写：

| 文件 | 内容 | 谁读 |
|---|---|---|
| `totals.json` | `{ <sessionId>: UsageTotals }`，本插件的内部账 | quota 自己（重启续算） |
| `history.json` | `{ <sessionId>: StepUsage[] }`，每会话最近 64 步，预测的根据 | quota 自己 |
| `summary.json` | `QuotaSummary`：`budgetTokens`/`maxSessionTokens`/`maxSessionRatio`/`nextTurnEstTokens`/`todayTokens`/`todayCostMicros`/`currency` | **家族契约**：task-forge `/relay` 派发前读它，预算吃紧就提前警告 |

没配 `budgetTokens` 时 `maxSessionRatio` 是 `null` 而不是 0——"烧到几成"没有预算是无意义的，读方不能自己猜一个。每 4 步（以及 `/qm-reset` 后）重新发布一次。

## 作为开发模板

这个插件把家族插件会碰到的每个 seam 各演示一遍，且全部有装配层测试：session/event 事件接线、命令注册、defineTool（含 presentation hooks）、systemPrompt.section、原子写持久化、配置探针（坏配置启动点名）。新插件的脚手架从这里抄。

## 安装

```bash
dsh plugin --profile <你的profile> add <本仓库克隆路径>
```

## 配置

```yaml
budgetTokens: 0      # 单会话 token 预算，0 = 不显示进度条
inject: true         # 实时仪表注入系统提示
prices:              # 按模型 id 子串匹配，命中才估花费
  - match: space-bunny
    currency: USD
    perMillion: { input: 1, output: 2, cacheRead: 0.1 }
```

## 借鉴来源与差异（不盲目抄）

| 来源 | 借鉴 | 改编 | 原创 |
|---|---|---|---|
| dsh-tool-web（官方） | `presentCall`/`presentResult` presentation hooks——工具卡片的正确渲染姿势（generic 卡契约） | 官方只给自己工具用；我们把 generic 卡变成家族工具的标准展示层 | —— |
| dsh-plugin-cost-ledger（自家） | session/event usage 折算、微单位计费 | 折算目标是"实时仪表"而非持久台账；价格按子串匹配极简化 | —— |
| dsh-plugin-task-forge（自家） | harness 装配层测试模板、原子写、store 模式 | —— | 当日聚合 fallback（currentSession 未知时按会话 id 含今日日期聚合） |

## 测试

```bash
npm run check   # typecheck + node --test + tsc build
```

23 个测试：13 纯函数（折算/定价/格式化/gauge/卡片契约/预测模型 percentile·predictNextTurn·summarise）+ 10 装配层（真实 apply() 挂 mock ctx，真实 usage 事件驱动仪表/面板/section/预测行/落盘契约/重置，以及坏 history 文件的降级）。
