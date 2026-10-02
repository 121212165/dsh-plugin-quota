/**
 * dsh-plugin-quota — 实时用量仪表 + 家族通用插件开发测试模板。
 *
 * One session/event listener folds every assistant/message usage into a live
 * per-session meter; a system-prompt section injects the current session's
 * gauge each turn; /qm renders the panel; quota_meter gives the agent a card.
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
  presentCallCard,
  presentResultCard,
  priceFor,
  renderCompactLine,
  renderMeter,
  type PriceRow,
  type RawUsage,
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

export class MeterStore {
  readonly path: string;
  constructor(dataPath: string | undefined) {
    this.path = dataPath ? expandHome(dataPath) : join(homedir(), '.dsh', 'quota', 'totals.json');
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
}

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger('quota');
  if (!config.enabled) return void log.info('disabled by config');
  if (!Number.isFinite(config.budgetTokens) || config.budgetTokens < 0) throw new TypeError('quota: budgetTokens must be a non-negative finite number');
  if (config.budgetTokens > 0 && !Number.isInteger(config.budgetTokens)) throw new TypeError('quota: budgetTokens must be an integer when set');

  const store = new MeterStore(config.dataPath);
  const sessions = new Map<string, UsageTotals>(Object.entries(store.load()));
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

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return;
    const usage = (event.data as { usage?: RawUsage }).usage;
    if (!usage) return;
    const sessionId = String((session as { id?: unknown }).id ?? 'session');
    const model = (event.data as { message?: { source?: { model?: string } } }).message?.source?.model ?? 'unknown';
    const totals = addUsage(totalsOf(sessionId), usage);
    totals.costMicros += costMicrosOf(priceFor(config.prices, model), usage);
    if (++dirty % 4 === 0) store.save(Object.fromEntries(sessions));
  });

  const currentSessionId = (): string | undefined => {
    try {
      const initiator = (ctx as unknown as { agents?: { currentInitiator?: () => { session?: { id?: unknown } | undefined } | undefined } }).agents?.currentInitiator?.();
      const id = initiator?.session?.id;
      return id === undefined ? undefined : String(id);
    } catch {
      return undefined;
    }
  };

  const aggregate = (filter?: (id: string) => boolean): UsageTotals => {
    const all = emptyTotals();
    for (const [id, totals] of sessions) {
      if (filter && !filter(id)) continue;
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
          const totals = id !== undefined && sessions.has(id) ? sessions.get(id)! : aggregate((key) => key.includes(today()));
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
    description: '实时用量仪表：本会话 token/轮次/估算花费，及今日全部会话合计',
    handler: () => {
      const lines: string[] = [];
      const id = currentSessionId();
      const current = id !== undefined ? sessions.get(id) : undefined;
      lines.push(renderMeter('▍ 本会话', current ?? emptyTotals(), options()));
      const dayTotals = aggregate((key) => key.includes(today()));
      lines.push('');
      lines.push(renderMeter(`▍ 今日全部（${sessions.size} 个会话）`, dayTotals, options()));
      if (config.budgetTokens > 0 && current) {
        const used = current.inputTokens + current.outputTokens;
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
      store.save({});
      return { kind: 'success', text: `已清零 ${count} 个会话的仪表，从下一轮重新计。` };
    },
  });

  ctx.tools.register(
    defineTool({
      name: 'quota_meter',
      description: '查看当前会话的实时 token 用量与估算花费。用户问"花了多少/还剩多少预算"或长任务开始前自查时用。',
      parameters: {},
      output: {
        schema: { type: 'string' } as const,
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      presentCall: () => presentCallCard('读取实时用量'),
      presentResult: (_args, _result) => {
        const id = currentSessionId();
        const totals = (id !== undefined ? sessions.get(id) : undefined) ?? emptyTotals();
        return presentResultCard(totals, options());
      },
      async execute() {
        const id = currentSessionId();
        const totals = (id !== undefined ? sessions.get(id) : undefined) ?? aggregate();
        return renderMeter('会话实时用量', totals, options());
      },
    }),
  );

  log.info(`mounted · ${store.path} · budget=${config.budgetTokens || 'off'} · inject=${config.inject}`);
}
