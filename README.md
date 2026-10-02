# dsh-plugin-quota

dsh 插件：**实时用量仪表**——本会话 token/轮次/估算花费实时追踪；同时是 dsh 插件家族的**通用插件开发测试模板**。

## 它做什么

- **实时追踪**：监听 `session/event`（assistant/message usage），每次模型回复后实时累计本会话的输入/输出/缓存命中 token，带价格表时同时估算花费（微单位累计，显示时格式化）；
- **注入系统提示**：每回合给模型一行实时仪表（`实时用量：13.8k tok / 50k ▰▰▰▱… · 5 轮 · ≈0.0153 USD`），预算超限模型自己看得见；
- **/qm 面板**：本会话 + 今日全部会话合计，含预算进度条（`budgetTokens` > 0 时）和超预算警告；
- **quota_meter 工具**：模型可自查，调用与结果都渲染成 generic 卡片（`presentCall`/`presentResult`）。

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

14 个测试：6 纯函数（折算/定价/格式化/gauge/卡片契约）+ 8 装配层（真实 apply() 挂 mock ctx，真实 usage 事件驱动仪表/面板/section/重置）。
