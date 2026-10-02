/**
 * dsh-plugin-quota — 实时用量仪表 + 家族通用插件开发测试模板。
 *
 * One session/event listener folds every assistant/message usage into a live
 * per-session meter; a system-prompt section injects the current session's
 * gauge each turn; /qm renders the panel; quota_meter gives the agent a card.
 * The panel and the tool also project where this session's context window fills and
 * where its budget burns out; the injected one-liner grows by nothing, because it
 * rides on every turn.
 * Every seam a family plugin touches appears here exactly once, with rich
 * presentation (presentCall/presentResult generic cards) as the display
 * reference. Methodology: dsh-tool-web's presentation hooks + cost-ledger's
 * event folding + task-forge's store/tests.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-commands';
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  addUsage,
  compactTokens,
  costMicrosOf,
  emptyTotals,
  predictNextTurn,
  presentCallCard,
  presentResultCard,
  priceFor,
  projectBudget,
  projectWindow,
  promptGrowth,
  renderBudgetLine,
  renderCompactLine,
  renderForecastLine,
  renderMeter,
  renderWindowLine,
  stepOf,
  summarise,
  type PriceRow,
  type QuotaSummary,
  type RawUsage,
  type StepUsage,
  type UsageTotals,
} from './meter.ts';

export const name = 'quota';
export const inject = ['commands', 'tools', 'systemPrompt'];

export interface Config {
  enabled: boolean;
  dataPath?: string;
  budgetTokens: number;
  inject: boolean;
  prices: PriceRow[];
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  dataPath: Schema.string(),
  budgetTokens: Schema.natural().default(0).description('单会话 token 预算，0 = 不显示进度条'),
  inject: Schema.boolean().default(true).description('把实时仪表注入系统提示'),
  prices: Schema.array(
    Schema.object({
      match: Schema.string(),
      currency: Schema.string().default('CNY'),
      perMillion: Schema.object({
        input: Schema.number().default(0),
        output: Schema.number().default(0),
        cacheRead: Schema.number().default(0),
      }),
      contextWindow: Schema.number().description('该模型的上下文窗口，撑满预测的根据；缺省则不算撑满点'),
    }),
  ).default([]),
});

export function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
}

function writeAtomic(dest: string, content: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, dest);
}

/** Per-session step history backs the next-turn forecast. It lives in its own file
 * so `totals.json` stays the stable cross-plugin budget contract (task-forge reads it). */
const HISTORY_LIMIT = 64;

function isStep(value: unknown): value is StepUsage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const step = value as Partial<StepUsage>;
  return [step.input, step.output, step.cacheRead].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}

export class MeterStore {
  readonly path: string;
  readonly historyPath: string;
  readonly summaryPath: string;
  constructor(dataPath: string | undefined) {
    this.path = dataPath ? expandHome(dataPath) : join(homedir(), '.dsh', 'quota', 'totals.json');
    this.historyPath = join(dirname(this.path), 'history.json');
    this.summaryPath = join(dirname(this.path), 'summary.json');
  }
  load(): Record<string, UsageTotals> {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, UsageTotals>) : {};
    } catch {
      return {};
    }
  }
  save(sessions: Record<string, UsageTotals>): void {
    writeAtomic(this.path, JSON.stringify(sessions, null, 2) + '\n');
  }
  loadHistory(): Record<string, StepUsage[]> {
    if (!existsSync(this.historyPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.historyPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, StepUsage[]> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(value)) out[key] = value.filter(isStep).slice(-HISTORY_LIMIT);
      }
      return out;
    } catch {
      return {};
    }
  }
  saveHistory(histories: Record<string, StepUsage[]>): void {
    writeAtomic(this.historyPath, JSON.stringify(histories, null, 2) + '\n');
  }
  saveSummary(summary: QuotaSummary): void {
    writeAtomic(this.summaryPath, JSON.stringify(summary, null, 2) + '\n');
  }
}

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger('quota');
  if (!config.enabled) return void log.info('disabled by config');
  if (!Number.isFinite(config.budgetTokens) || config.budgetTokens < 0) throw new TypeError('quota: budgetTokens must be a non-negative finite number');
  if (config.budgetTokens > 0 && !Number.isInteger(config.budgetTokens)) throw new TypeError('quota: budgetTokens must be an integer when set');
  for (const row of config.prices) {
    const contextWindow = row.contextWindow;
    if (contextWindow !== undefined && (!Number.isFinite(contextWindow) || contextWindow <= 0)) {
      throw new TypeError(`quota: prices[].contextWindow must be a positive finite number (match=${row.match})`);
    }
  }

  const store = new MeterStore(config.dataPath);
  const sessions = new Map<string, UsageTotals>(Object.entries(store.load()));
  /** daily rollup keyed YYYY-MM-DD — session ids are uuids without dates, so
   * "today" cannot be derived by filtering session keys. */
  const daily = new Map<string, UsageTotals>();
  /** per-session step history + last-seen model: the basis for the next-turn forecast
   * and for both session projections (fill point, budget burn-out) */
  const histories = new Map<string, StepUsage[]>(Object.entries(store.loadHistory()));
  const lastModel = new Map<string, string>();
  let dirty = 0;

  const totalsOf = (sessionId: string): UsageTotals => {
    let totals = sessions.get(sessionId);
    if (!totals) {
      totals = emptyTotals();
      sessions.set(sessionId, totals);
    }
    return totals;
  };

  const options = (): { budgetTokens?: number; prices?: PriceRow[] } => ({
    ...(config.budgetTokens > 0 ? { budgetTokens: config.budgetTokens } : {}),
    ...(config.prices.length ? { prices: config.prices } : {}),
  });

  const today = (): string => new Date().toISOString().slice(0, 10);

  const fold = (map: Map<string, UsageTotals>, key: string, usage: RawUsage, model: string): void => {
    let totals = map.get(key);
    if (!totals) {
      totals = emptyTotals();
      map.set(key, totals);
    }
    const folded = addUsage(totals, usage);
    folded.costMicros = totals.costMicros + costMicrosOf(priceFor(config.prices, model), usage);
    map.set(key, folded); // addUsage is pure — store the folded result back
  };

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return;
    const usage = (event.data as { usage?: RawUsage }).usage;
    if (!usage) return;
    const sessionId = String((session as { id?: unknown }).id ?? 'session');
    const model = (event.data as { message?: { source?: { model?: string } } }).message?.source?.model ?? 'unknown';
    fold(sessions, sessionId, usage, model);
    fold(daily, today(), usage, model);
    histories.set(sessionId, [...(histories.get(sessionId) ?? []), stepOf(usage)].slice(-HISTORY_LIMIT));
    lastModel.set(sessionId, model);
    if (++dirty % 4 === 0) {
      store.save(Object.fromEntries(sessions));
      store.saveHistory(Object.fromEntries(histories));
      publish();
    }
  });

  const forecastFor = (sessionId: string | undefined) =>
    predictNextTurn(sessionId === undefined ? [] : histories.get(sessionId) ?? [], sessionId === undefined ? null : priceFor(config.prices, lastModel.get(sessionId) ?? 'unknown'));

  const usedOf = (totals: UsageTotals | undefined): number => totals ? totals.inputTokens + totals.outputTokens : 0;

  /** dsh gives plugins no model catalogue, so the context window comes from config —
   * the same price row that matched the model, or no fill point at all. */
  const contextWindowOf = (sessionId: string | undefined): number | null =>
    sessionId === undefined ? null : priceFor(config.prices, lastModel.get(sessionId) ?? 'unknown')?.contextWindow ?? null;

  /** the two session projections: when the window fills, when the budget burns out */
  const projectFor = (sessionId: string | undefined) => {
    const history = sessionId === undefined ? [] : histories.get(sessionId) ?? [];
    const contextWindow = contextWindowOf(sessionId);
    const window = contextWindow === null ? null : projectWindow(history, contextWindow, sessionId === undefined ? 0 : sessions.get(sessionId)?.turns);
    const budget = projectBudget(usedOf(sessionId === undefined ? undefined : sessions.get(sessionId)), config.budgetTokens, promptGrowth(history));
    return { contextWindow, window, budget };
  };

  const projectionLines = (sessionId: string | undefined): string[] => {
    const { contextWindow, window, budget } = projectFor(sessionId);
    return [renderWindowLine(window, contextWindow), renderBudgetLine(budget)];
  };

  /** Republish the budget contract every time the meter is flushed — other plugins
   * read summary.json without knowing session ids. */
  const publish = (): void => {
    const id = currentSessionId();
    const { contextWindow, window, budget } = projectFor(id);
    const summary = summarise({
      sessions: [...sessions.values()],
      today: aggregateToday(),
      budgetTokens: config.budgetTokens,
      forecast: id === undefined ? null : forecastFor(id),
      currency: config.prices[0]?.currency,
      now: new Date(),
      contextWindow,
      stepsUntilFull: window?.stepsToFull ?? null,
      stepsUntilBudget: budget.stepsLeft,
    });
    store.saveSummary(summary);
  };

  const currentSessionId = (): string | undefined => {
    try {
      const initiator = (ctx as unknown as { agents?: { currentInitiator?: () => { session?: { id?: unknown } | undefined } | undefined } }).agents?.currentInitiator?.();
      const id = initiator?.session?.id;
      return id === undefined ? undefined : String(id);
    } catch {
      return undefined;
    }
  };

  const aggregateToday = (): UsageTotals => daily.get(today()) ?? emptyTotals();
  const aggregateAll = (): UsageTotals => {
    const all = emptyTotals();
    for (const totals of daily.values()) {
      all.inputTokens += totals.inputTokens;
      all.outputTokens += totals.outputTokens;
      all.cacheReadTokens += totals.cacheReadTokens;
      all.turns += totals.turns;
      all.costMicros += totals.costMicros;
    }
    return all;
  };

  if (config.inject) {
    ctx.systemPrompt.section({
      name: 'quota',
      order: 660,
      text: () => {
        try {
          const id = currentSessionId();
          const totals = id !== undefined && sessions.has(id) ? sessions.get(id)! : aggregateToday();
          return totals.turns === 0 ? '' : renderCompactLine(totals, options());
        } catch (error) {
          log.warn(`quota section skipped: ${String(error)}`);
          return '';
        }
      },
    });
  }

  ctx.commands.register({
    name: 'qm',
    description: '实时用量仪表：本会话 token/步数/估算花费、下步预估与撑满/烧穿预测，及今日全部会话合计',
    handler: () => {
      const lines: string[] = [];
      const id = currentSessionId();
      const current = id !== undefined ? sessions.get(id) : undefined;
      lines.push(renderMeter('▍ 本会话', current ?? emptyTotals(), options()));
      lines.push('');
      lines.push(renderForecastLine(current ? forecastFor(id) : null));
      lines.push(...projectionLines(id));
      lines.push('');
      lines.push(renderMeter('▍ 今日全部', aggregateToday(), options()));
      if (config.budgetTokens > 0 && current) {
        const used = usedOf(current);
        lines.push('');
        lines.push(used > config.budgetTokens ? `⚠ 已超出单会话预算 ${compactTokens(config.budgetTokens)}——收尾或 /qm-reset` : '');
      }
      return { kind: 'success', text: lines.filter((line) => line !== '').join('\n') };
    },
  });

  ctx.commands.register({
    name: 'qm-reset',
    description: '清零实时用量仪表（全部会话），/qm 重新计',
    handler: () => {
      const count = sessions.size;
      sessions.clear();
      daily.clear();
      histories.clear();
      lastModel.clear();
      store.save({});
      store.saveHistory({});
      publish();
      return { kind: 'success', text: `已清零 ${count} 个会话的仪表，从下一步重新计。` };
    },
  });

  ctx.tools.register(
    defineTool({
      name: 'quota_meter',
      description: '查看当前会话的实时 token 用量、估算花费，以及按当前增速第几步撑满上下文、第几步烧完预算。用户问"花了多少/还剩多少预算/还能跑几步"或长任务开始前自查时用。',
      parameters: {},
      output: {
        schema: { type: 'string' } as const,
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      presentCall: () => presentCallCard('读取实时用量'),
      presentResult: (_args, _result) => {
        const id = currentSessionId();
        const totals = (id !== undefined ? sessions.get(id) : undefined) ?? emptyTotals();
        return presentResultCard(totals, options(), id === undefined ? null : forecastFor(id));
      },
      async execute() {
        const id = currentSessionId();
        const totals = (id !== undefined ? sessions.get(id) : undefined) ?? aggregateAll();
        const forecast = id === undefined ? null : forecastFor(id);
        return [renderMeter('会话实时用量', totals, options()), renderForecastLine(forecast), ...projectionLines(id)].join('\n');
      },
    }),
  );

  log.info(`mounted · ${store.path} · budget=${config.budgetTokens || 'off'} · inject=${config.inject}`);
}
