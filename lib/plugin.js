import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { quotaProjection } from './projection.js';
import { addUsage, calibratePrices, compactTokens, costMicrosOf, emptyTotals, predictNextTurn, presentCallCard, presentResultCard, priceFor, projectBudget, projectWindow, promptGrowth, renderBudgetLine, renderCompactLine, renderForecastLine, renderMeter, renderModelTop, renderWindowLine, stepOf, summarise, } from './meter.js';
export const name = 'quota';
export const inject = ['commands', 'tools', 'systemPrompt'];
export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    dataPath: Schema.string(),
    budgetTokens: Schema.natural().default(0).description('单会话 token 预算，0 = 不显示进度条'),
    billingDbPath: Schema.string().description('new-api 的 one-api.db 路径；配置后自动从计费日志反推真实 $/M 价格，覆盖 prices'),
    inject: Schema.boolean().default(true).description('把实时仪表注入系统提示'),
    prices: Schema.array(Schema.object({
        match: Schema.string(),
        currency: Schema.string().default('CNY'),
        perMillion: Schema.object({
            input: Schema.number().default(0),
            output: Schema.number().default(0),
            cacheRead: Schema.number().default(0),
        }),
        contextWindow: Schema.number().description('该模型的上下文窗口，撑满预测的根据；缺省则不算撑满点'),
    })).default([]),
});
export function expandHome(path) {
    return path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
}
function writeAtomic(dest, content) {
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, dest);
}
/** Per-session step history backs the next-turn forecast. It lives in its own file
 * so `totals.json` stays the stable cross-plugin budget contract (task-forge reads it). */
const HISTORY_LIMIT = 64;
function isStep(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const step = value;
    return [step.input, step.output, step.cacheRead].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}
export class MeterStore {
    path;
    historyPath;
    summaryPath;
    constructor(dataPath) {
        this.path = dataPath ? expandHome(dataPath) : join(homedir(), '.dsh', 'quota', 'totals.json');
        this.historyPath = join(dirname(this.path), 'history.json');
        this.summaryPath = join(dirname(this.path), 'summary.json');
    }
    load() {
        if (!existsSync(this.path))
            return {};
        try {
            const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        }
        catch {
            return {};
        }
    }
    save(sessions) {
        writeAtomic(this.path, JSON.stringify(sessions, null, 2) + '\n');
    }
    loadHistory() {
        if (!existsSync(this.historyPath))
            return {};
        try {
            const parsed = JSON.parse(readFileSync(this.historyPath, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return {};
            const out = {};
            for (const [key, value] of Object.entries(parsed)) {
                if (Array.isArray(value))
                    out[key] = value.filter(isStep).slice(-HISTORY_LIMIT);
            }
            return out;
        }
        catch {
            return {};
        }
    }
    saveHistory(histories) {
        writeAtomic(this.historyPath, JSON.stringify(histories, null, 2) + '\n');
    }
    saveSummary(summary) {
        writeAtomic(this.summaryPath, JSON.stringify(summary, null, 2) + '\n');
    }
}
export function apply(ctx, config) {
    const log = ctx.logger('quota');
    if (!config.enabled)
        return void log.info('disabled by config');
    if (!Number.isFinite(config.budgetTokens) || config.budgetTokens < 0)
        throw new TypeError('quota: budgetTokens must be a non-negative finite number');
    if (config.budgetTokens > 0 && !Number.isInteger(config.budgetTokens))
        throw new TypeError('quota: budgetTokens must be an integer when set');
    for (const row of config.prices) {
        const contextWindow = row.contextWindow;
        if (contextWindow !== undefined && (!Number.isFinite(contextWindow) || contextWindow <= 0)) {
            throw new TypeError(`quota: prices[].contextWindow must be a positive finite number (match=${row.match})`);
        }
    }
    const store = new MeterStore(config.dataPath);
    const sessions = new Map(Object.entries(store.load()));
    /** daily rollup keyed YYYY-MM-DD — session ids are uuids without dates, so
     * "today" cannot be derived by filtering session keys. In-memory only:
     * restarts zero it, a pre-existing behavior /qm-top's 今日 inherits. */
    const daily = new Map();
    /** per-session step history + last-seen model: the basis for the next-turn forecast
     * and for both session projections (fill point, budget burn-out) */
    const histories = new Map(Object.entries(store.loadHistory()));
    const lastModel = new Map();
    let dirty = 0;
    let calibrated = [];
    if (config.billingDbPath) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const db = new DatabaseSync(expandHome(config.billingDbPath), { readOnly: true });
            const rows = db
                .prepare("SELECT model_name, quota, prompt_tokens + completion_tokens AS tokens FROM logs WHERE type = 2 ORDER BY created_at DESC LIMIT 500")
                .all();
            db.close();
            calibrated = calibratePrices(rows.map((row) => ({ model: row.model_name, quota: Number(row.quota), tokens: Number(row.tokens) })));
            if (calibrated.length)
                log.info(`prices calibrated from billing logs: ${calibrated.length} models`);
        }
        catch (error) {
            log.warn(`price calibration skipped: ${String(error)}`);
        }
    }
    const options = () => ({
        ...(config.budgetTokens > 0 ? { budgetTokens: config.budgetTokens } : {}),
        ...(calibrated.length ? { prices: calibrated } : config.prices.length ? { prices: config.prices } : {}),
    });
    // Official projection model: the registry folds committed events eagerly and
    // replays the log on fork/resume, so per-session totals survive restarts —
    // the in-memory map below remains only for the daily rollup and as a
    // fallback when the projection seam is absent.
    try {
        ctx.inject?.(['sessionProjections'], (sp) => {
            sp.register?.(quotaProjection(config.prices));
            log.info('quota projection registered');
        });
    }
    catch (error) {
        log.warn(`projection registration skipped: ${String(error)}`);
    }
    const readProjectedState = () => {
        try {
            const session = ctx.agents?.currentInitiator?.()?.session;
            if (!session)
                return null;
            const sp = ctx.sessionProjections;
            return sp?.stateOf?.(session, 'quota') ?? null;
        }
        catch {
            return null;
        }
    };
    const today = () => new Date().toISOString().slice(0, 10);
    /** Three folds stay per-model in lockstep — the projection (per-session state),
     * this in-memory fold (fallback + daily rollup) — so /qm-top reads the same
     * buckets no matter which path answered. */
    const fold = (map, key, usage, model) => {
        let totals = map.get(key);
        if (!totals) {
            totals = { ...emptyTotals(), byModel: {} };
            map.set(key, totals);
        }
        const cost = costMicrosOf(priceFor(config.prices, model), usage);
        const folded = addUsage(totals, usage);
        folded.costMicros = totals.costMicros + cost;
        const buckets = { ...(totals.byModel ?? {}) };
        const bucket = addUsage(buckets[model] ?? emptyTotals(), usage);
        bucket.costMicros = bucket.costMicros + cost;
        buckets[model] = bucket;
        folded.byModel = buckets;
        map.set(key, folded); // addUsage is pure — store the folded result back
    };
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'assistant/message')
            return;
        const usage = event.data.usage;
        if (!usage)
            return;
        const sessionId = String(session.id ?? 'session');
        const model = event.data.message?.source?.model ?? 'unknown';
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
    const forecastFor = (sessionId) => predictNextTurn(sessionId === undefined ? [] : histories.get(sessionId) ?? [], sessionId === undefined ? null : priceFor(config.prices, lastModel.get(sessionId) ?? 'unknown'));
    const usedOf = (totals) => totals ? totals.inputTokens + totals.outputTokens : 0;
    /** dsh gives plugins no model catalogue, so the context window comes from config —
     * the same price row that matched the model, or no fill point at all. */
    const contextWindowOf = (sessionId) => sessionId === undefined ? null : priceFor(config.prices, lastModel.get(sessionId) ?? 'unknown')?.contextWindow ?? null;
    /** the two session projections: when the window fills, when the budget burns out */
    const projectFor = (sessionId) => {
        const history = sessionId === undefined ? [] : histories.get(sessionId) ?? [];
        const contextWindow = contextWindowOf(sessionId);
        const window = contextWindow === null ? null : projectWindow(history, contextWindow, sessionId === undefined ? 0 : sessions.get(sessionId)?.turns);
        const budget = projectBudget(usedOf(sessionId === undefined ? undefined : sessions.get(sessionId)), config.budgetTokens, promptGrowth(history));
        return { contextWindow, window, budget };
    };
    const projectionLines = (sessionId) => {
        const { contextWindow, window, budget } = projectFor(sessionId);
        return [renderWindowLine(window, contextWindow), renderBudgetLine(budget)];
    };
    /** Republish the budget contract every time the meter is flushed — other plugins
     * read summary.json without knowing session ids. */
    const publish = () => {
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
    const currentSessionId = () => {
        try {
            const initiator = ctx.agents?.currentInitiator?.();
            const id = initiator?.session?.id;
            return id === undefined ? undefined : String(id);
        }
        catch {
            return undefined;
        }
    };
    const aggregateToday = () => daily.get(today()) ?? emptyTotals();
    const aggregateAll = () => {
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
                    const totals = readProjectedState() ?? (id !== undefined && sessions.has(id) ? sessions.get(id) : aggregateToday());
                    return totals.turns === 0 ? '' : renderCompactLine(totals, options());
                }
                catch (error) {
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
            const lines = [];
            const id = currentSessionId();
            const current = readProjectedState() ?? (id !== undefined ? sessions.get(id) : undefined);
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
        name: 'qm-top',
        description: '按模型用量排行：本会话与今日全部会话的分模型 Top5（/qm-top）',
        handler: () => {
            try {
                const id = currentSessionId();
                const current = readProjectedState() ?? (id !== undefined ? sessions.get(id) : undefined);
                const todayTotals = daily.get(today());
                return {
                    kind: 'success',
                    text: [renderModelTop('▍ 本会话', current?.byModel, options()), '', renderModelTop('▍ 今日全部', todayTotals?.byModel, options())].join('\n'),
                };
            }
            catch (error) {
                return { kind: 'error', text: `/qm-top 内部出错：${String(error)}` };
            }
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
    ctx.tools.register(defineTool({
        name: 'quota_meter',
        description: '查看当前会话的实时 token 用量、估算花费，以及按当前增速第几步撑满上下文、第几步烧完预算。用户问"花了多少/还剩多少预算/还能跑几步"或长任务开始前自查时用。',
        parameters: {},
        output: {
            schema: { type: 'string' },
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
            const totals = readProjectedState() ?? ((id !== undefined ? sessions.get(id) : undefined) ?? aggregateAll());
            const forecast = id === undefined ? null : forecastFor(id);
            return [renderMeter('会话实时用量', totals, options()), renderForecastLine(forecast), ...projectionLines(id)].join('\n');
        },
    }));
    log.info(`mounted · ${store.path} · budget=${config.budgetTokens || 'off'} · inject=${config.inject}`);
}
//# sourceMappingURL=plugin.js.map