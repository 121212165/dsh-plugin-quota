/** Pure meter model for dsh-plugin-quota: live per-session token/cost totals
 * folded from assistant/message usage events, rendered as a text gauge for the
 * system prompt, a full panel for /qm, and generic presentation cards.
 * Doubles as the family's reference template for universal plugin development
 * (events + command + tool + section + presentation hooks, all testable).
 * @module meter */
export function emptyTotals() {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0, costMicros: 0 };
}
const nonNeg = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
export function addUsage(totals, usage) {
    return {
        inputTokens: totals.inputTokens + nonNeg(usage.inputTokens),
        outputTokens: totals.outputTokens + nonNeg(usage.outputTokens) + nonNeg(usage.reasoningTokens),
        cacheReadTokens: totals.cacheReadTokens + nonNeg(usage.cacheReadTokens),
        turns: totals.turns + 1,
        costMicros: totals.costMicros,
    };
}
export function priceFor(rows, modelId) {
    return rows.find((row) => modelId.toLowerCase().includes(row.match.toLowerCase())) ?? null;
}
/** Micro-currency estimate for one usage event; 0 when the model is unpriced. */
export function costMicrosOf(price, usage) {
    if (!price)
        return 0;
    const m = 1_000_000;
    const input = nonNeg(usage.inputTokens) * price.perMillion.input;
    const output = (nonNeg(usage.outputTokens) + nonNeg(usage.reasoningTokens)) * price.perMillion.output;
    const cacheRead = nonNeg(usage.cacheReadTokens) * price.perMillion.cacheRead;
    return Math.round(((input + output + cacheRead) / m) * 1_000_000);
}
export function formatMoney(micros, currency) {
    if (micros <= 0)
        return '0';
    const value = micros / 1_000_000;
    const digits = value < 0.01 ? 4 : value < 1 ? 3 : 2;
    return `${value.toFixed(digits)} ${currency}`;
}
export function compactTokens(n) {
    if (n < 1000)
        return String(n);
    if (n < 1_000_000)
        return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}
/** ▰▰▰▱▱ bar of `width` cells at `ratio`, clamped to [0,1]. */
export function gauge(ratio, width = 10) {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
    const filled = Math.round(clamped * width);
    return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}
/** Full panel for /qm and the quota_meter tool: per-session gauge + totals. */
export function renderMeter(title, totals, options = {}) {
    const lines = [`${title}`];
    const cacheNote = totals.cacheReadTokens > 0 ? `（缓存命中 ${compactTokens(totals.cacheReadTokens)}）` : '';
    lines.push(`输入 ${compactTokens(totals.inputTokens)}${cacheNote} · 输出 ${compactTokens(totals.outputTokens)} · ${totals.turns} 步`);
    const price = options.prices?.[0];
    if (totals.costMicros > 0 && price)
        lines.push(`估算花费 ≈ ${formatMoney(totals.costMicros, price.currency)}`);
    if (options.budgetTokens && options.budgetTokens > 0) {
        const total = totals.inputTokens + totals.outputTokens;
        lines.push(`预算 ${gauge(total / options.budgetTokens)} ${compactTokens(total)}/${compactTokens(options.budgetTokens)}`);
    }
    return lines.join('\n');
}
/** Budget warning grades injected after the gauge: 80% is a heads-up, 100%
 * tells the model to wrap up — the section is the one channel guaranteed to
 * reach the model every turn, so the nudge rides there. */
export function budgetWarningGrade(total, budgetTokens) {
    if (!budgetTokens || budgetTokens <= 0 || !Number.isFinite(budgetTokens))
        return '';
    const ratio = total / budgetTokens;
    if (ratio >= 1)
        return ' · ⚠ 预算已烧穿，强烈建议开新会话';
    if (ratio >= 0.8)
        return ' · ⚠ 预算已过 80%，注意收尾';
    return '';
}
/** One-line live gauge injected into the system prompt every turn. */
export function renderCompactLine(totals, options = {}) {
    const total = totals.inputTokens + totals.outputTokens;
    const budgetPart = options.budgetTokens && options.budgetTokens > 0 ? ` / ${compactTokens(options.budgetTokens)} ${gauge(total / options.budgetTokens, 8)}` : '';
    const price = options.prices?.[0];
    const money = totals.costMicros > 0 && price ? ` · ≈${formatMoney(totals.costMicros, price.currency)}` : '';
    const warning = budgetWarningGrade(total, options.budgetTokens);
    return `实时用量：${compactTokens(total)} tok${budgetPart} · ${totals.turns} 步${money}${warning}（/qm 详情）`;
}
/** Per-model leaderboard for /qm-top: rows sorted by input+output (the same
 * "used" figure the gauges show), capped at `limit`. Empty map renders a plain
 * "no data" line — a leaderboard over nothing must not look like a zero row. */
export function renderModelTop(title, byModel, options = {}, limit = 5) {
    const entries = Object.entries(byModel ?? {}).filter(([, totals]) => totals.turns > 0);
    if (!entries.length)
        return `${title}：还没有分模型数据（跑一步后再看）`;
    entries.sort((a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens));
    const currency = options.prices?.[0]?.currency;
    const lines = [`${title} 按模型 Top ${Math.min(limit, entries.length)}（共 ${entries.length} 个模型）`];
    for (const [model, totals] of entries.slice(0, limit)) {
        const money = totals.costMicros > 0 && currency ? ` · ≈${formatMoney(totals.costMicros, currency)}` : '';
        lines.push(`- ${model}：${compactTokens(totals.inputTokens + totals.outputTokens)} tok · ${totals.turns} 步${money}`);
    }
    return lines.join('\n');
}
export function stepOf(usage) {
    return {
        input: nonNeg(usage.inputTokens),
        output: nonNeg(usage.outputTokens) + nonNeg(usage.reasoningTokens),
        cacheRead: nonNeg(usage.cacheReadTokens),
    };
}
/** Tool results landing after the last step are the one part the meter cannot
 * see; 15% slack on the new content keeps the estimate from reading low. */
export const TOOL_SLACK = 0.15;
/** Nearest-rank percentile over a copy; empty input is 0, one sample is itself. */
export function percentile(values, q) {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length)
        return 0;
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
    return sorted[rank - 1];
}
const usableSteps = (history) => history.filter((step) => step && Number.isFinite(step.input) && Number.isFinite(step.output) && Number.isFinite(step.cacheRead));
/** Next-step estimate from the step history: the prefix grows by what the model
 * just wrote, the cached part stays cached, output is the session's own spread.
 * Null with no history — a forecast invented before the first step is a lie. */
export function predictNextTurn(history, price) {
    const steps = usableSteps(history);
    if (!steps.length)
        return null;
    const last = steps[steps.length - 1];
    const inputEst = Math.round((last.input + last.output) * (1 + TOOL_SLACK));
    const cacheReadEst = last.cacheRead;
    const outputs = steps.map((step) => step.output);
    const outputP50 = percentile(outputs, 0.5);
    const outputP85 = percentile(outputs, 0.85);
    const at = (output) => costMicrosOf(price, { inputTokens: inputEst, outputTokens: output, cacheReadTokens: cacheReadEst });
    return {
        inputEst,
        cacheReadEst,
        promptEst: inputEst + cacheReadEst,
        outputP50,
        outputP85,
        costP50Micros: at(outputP50),
        costP85Micros: at(outputP85),
        currency: price?.currency ?? null,
        basis: steps.length,
    };
}
/** The panel line: what the next step is going to cost before it happens. */
export function renderForecastLine(forecast) {
    if (!forecast)
        return '下步预估：还没有已完成的步（跑完一步再来看）';
    const low = forecast.currency ? formatMoney(forecast.costP50Micros, forecast.currency) : '';
    const high = forecast.currency ? formatMoney(forecast.costP85Micros, forecast.currency) : '';
    // the spread is printed only when it survives rounding — "0.02–0.02 USD" is noise
    const money = forecast.currency && forecast.costP85Micros > 0 ? ` · ≈${low === high ? low : `${low}–${high}`}` : '';
    const cachePart = forecast.cacheReadEst > 0 ? ` + 缓存复用 ${compactTokens(forecast.cacheReadEst)}` : '';
    const outputs = forecast.outputP85 > forecast.outputP50 ? `${compactTokens(forecast.outputP50)}–${compactTokens(forecast.outputP85)}` : compactTokens(forecast.outputP50);
    return `下步预估：新输入 ~${compactTokens(forecast.inputEst)}${cachePart}（提示词 ~${compactTokens(forecast.promptEst)}） · 输出 ${outputs}（P50–P85，${forecast.basis} 步为据）${money}`;
}
/** What the model saw at one step: the uncached delta, the reused prefix, and what
 * it wrote back — which is the bulk of the *next* step's prompt. */
const promptOf = (step) => step.input + step.cacheRead + step.output;
/** Median step-to-step prompt growth: a single huge tool result must not fake the
 * slope, so the middle delta wins and the mean never does. 0 below two steps. */
export function promptGrowth(history) {
    const steps = usableSteps(history);
    if (steps.length < 2)
        return 0;
    return percentile(steps.slice(1).map((step, index) => promptOf(step) - promptOf(steps[index])), 0.5);
}
/** When does this session's context window fill up? `observedSteps` is the session's
 * true step count when the retained history is shorter than the session (history is
 * capped per session), so the printed index is not off by the trim. */
export function projectWindow(history, contextWindow, observedSteps) {
    const steps = usableSteps(history);
    const promptNow = steps.length ? promptOf(steps[steps.length - 1]) : 0;
    const growthPerStep = promptGrowth(steps);
    const willGrow = growthPerStep > 0;
    const usable = Number.isFinite(contextWindow) && contextWindow > 0;
    let stepsToFull = null;
    if (usable && promptNow >= contextWindow)
        stepsToFull = 0;
    else if (usable && willGrow)
        stepsToFull = Math.ceil((contextWindow - promptNow) / growthPerStep);
    const at = Math.max(steps.length, observedSteps ?? 0);
    return { promptNow, growthPerStep, stepsToFull, fullAtStep: stepsToFull === null ? null : at + stepsToFull, willGrow, basis: steps.length };
}
/** How many steps of this session's own growth still fit in `budgetTokens`. */
export function projectBudget(totalUsed, budgetTokens, growthPerStep) {
    if (!Number.isFinite(budgetTokens) || budgetTokens <= 0)
        return { totalUsed, budgetTokens, stepsLeft: null, ratio: null };
    const remaining = budgetTokens - totalUsed;
    const stepsLeft = remaining <= 0 ? 0 : growthPerStep > 0 ? Math.ceil(remaining / growthPerStep) : null;
    return { totalUsed, budgetTokens, stepsLeft, ratio: totalUsed / budgetTokens };
}
/** Panel line: the step at which this session runs out of context. */
export function renderWindowLine(projection, contextWindow) {
    const head = '撑满预测：';
    if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0)
        return `${head}未配置该模型的 contextWindow，算不出撑满点`;
    if (!projection || projection.basis === 0)
        return `${head}还没有已完成的步（跑完一步再来看）`;
    const limit = compactTokens(contextWindow);
    const now = `~${compactTokens(projection.promptNow)}/${limit}`;
    if (projection.stepsToFull === 0)
        return `${head}~${compactTokens(projection.promptNow)} 已顶到 ${limit} 上限 · 立刻 /compact 或换会话`;
    if (projection.stepsToFull === null) {
        return projection.basis < 2
            ? `${head}${now} · 只有 1 步，还看不出增速`
            : `${head}${now} · 看不到撑满的迹象（增速 ≤ 0）`;
    }
    return `${head}按当前增速，第 ${projection.fullAtStep} 步（再 ${projection.stepsToFull} 步）撑满 ${limit} 上下文 · 建议在那之前 /compact 或换会话`;
}
/** Panel line: the step at which this session runs out of budget. */
export function renderBudgetLine(budget) {
    const head = '预算预测：';
    if (budget.ratio === null)
        return `${head}未配置 budgetTokens，没有预算可烧`;
    const used = `已用 ${Math.round(budget.ratio * 100)}%`;
    if (budget.stepsLeft === 0)
        return `${head}⚠ 已烧穿 ${compactTokens(budget.budgetTokens)} 预算（${used}）· 该收尾了`;
    if (budget.stepsLeft === null)
        return `${head}~${compactTokens(budget.totalUsed)}/${compactTokens(budget.budgetTokens)} · 看不到烧穿的迹象（增速 ≤ 0）`;
    return `${head}按当前增速，再 ${budget.stepsLeft} 步烧到 ${compactTokens(budget.budgetTokens)}（${used}）`;
}
export function summarise(input) {
    const used = input.sessions.map((totals) => totals.inputTokens + totals.outputTokens);
    const maxSessionTokens = used.length ? Math.max(...used) : 0;
    const budgetTokens = Math.max(0, Math.round(input.budgetTokens));
    return {
        updatedAt: (input.now ?? new Date()).toISOString(),
        currency: input.currency ?? 'CNY',
        budgetTokens,
        maxSessionTokens,
        maxSessionRatio: budgetTokens > 0 ? maxSessionTokens / budgetTokens : null,
        nextTurnEstTokens: input.forecast ? input.forecast.promptEst : null,
        contextWindow: input.contextWindow ?? null,
        stepsUntilFull: input.stepsUntilFull ?? null,
        stepsUntilBudget: input.stepsUntilBudget ?? null,
        todayTokens: input.today.inputTokens + input.today.outputTokens,
        todayCostMicros: input.today.costMicros,
        sessions: input.sessions.length,
    };
}
/** Generic presentation card for the calling state (while the tool runs). */
export function presentCallCard(title) {
    return { card: 'generic', title, kind: 'other', rawInput: title };
}
/** Generic presentation card for the result state. A result view has no `kind`
 * or `rawInput` — those belong to the pending call; the body goes in `content`. */
export function presentResultCard(totals, options = {}, forecast) {
    const price = options.prices?.[0];
    const money = totals.costMicros > 0 && price ? ` · ≈${formatMoney(totals.costMicros, price.currency)}` : '';
    const next = forecast ? ` · 下步 ~${compactTokens(forecast.promptEst)}` : '';
    return {
        card: 'generic',
        title: `${compactTokens(totals.inputTokens + totals.outputTokens)} tok · ${totals.turns} 步${money}${next}`,
        content: [{ type: 'text', text: renderMeter('会话实时用量', totals, options) + (forecast ? `\n${renderForecastLine(forecast)}` : '') }],
    };
}
/** Derive real prices from the relay's own billing logs: $/M per model = quota
 * / 500000 (new-api's $1) / tokens * 1e6, averaged over each model's calls.
 * These are the numbers the user is ACTUALLY billed, not brochure prices. */
export function calibratePrices(rows) {
    const buckets = new Map();
    for (const row of rows) {
        if (!row.model || !Number.isFinite(row.quota) || row.quota <= 0 || !Number.isFinite(row.tokens) || row.tokens <= 0)
            continue;
        const bucket = buckets.get(row.model) ?? { billed: 0, tokens: 0, calls: 0 };
        bucket.billed += row.quota;
        bucket.tokens += row.tokens;
        bucket.calls += 1;
        buckets.set(row.model, bucket);
    }
    const prices = [];
    for (const [model, bucket] of buckets) {
        if (bucket.tokens < 1000)
            continue; // not enough data to be meaningful
        const usdPerMillion = (bucket.billed / bucket.tokens) * 1e6 / 500_000;
        if (!Number.isFinite(usdPerMillion) || usdPerMillion <= 0)
            continue;
        const rounded = Math.round(usdPerMillion * 100) / 100;
        prices.push({ match: model, currency: 'USD', perMillion: { input: rounded, output: rounded, cacheRead: rounded } });
    }
    return prices.sort((a, b) => a.match.localeCompare(b.match));
}
//# sourceMappingURL=meter.js.map