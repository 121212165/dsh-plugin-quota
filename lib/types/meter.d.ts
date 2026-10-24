/** Pure meter model for dsh-plugin-quota: live per-session token/cost totals
 * folded from assistant/message usage events, rendered as a text gauge for the
 * system prompt, a full panel for /qm, and generic presentation cards.
 * Doubles as the family's reference template for universal plugin development
 * (events + command + tool + section + presentation hooks, all testable).
 * @module meter */
export interface UsageTotals {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    /** one per `assistant/message` event — dsh emits those per *step*, so the panel
     * says 步, not 轮 (a user turn runs many of them). */
    turns: number;
    /** micro-units of the configured currency; only accumulates for priced models */
    costMicros: number;
}
export declare function emptyTotals(): UsageTotals;
export interface RawUsage {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    reasoningTokens?: number;
}
export declare function addUsage(totals: UsageTotals, usage: RawUsage): UsageTotals;
/** One price row: matched by model id prefix (family style: simple + honest). */
export interface PriceRow {
    match: string;
    currency: string;
    perMillion: {
        input: number;
        output: number;
        cacheRead: number;
    };
    /** the model's context window, needed for the fill-point projection. dsh exposes no
     * model catalogue to plugins, so this is the only source; absent = no projection. */
    contextWindow?: number;
}
export declare function priceFor(rows: PriceRow[], modelId: string): PriceRow | null;
/** Micro-currency estimate for one usage event; 0 when the model is unpriced. */
export declare function costMicrosOf(price: PriceRow | null, usage: RawUsage): number;
export declare function formatMoney(micros: number, currency: string): string;
export declare function compactTokens(n: number): string;
/** ▰▰▰▱▱ bar of `width` cells at `ratio`, clamped to [0,1]. */
export declare function gauge(ratio: number, width?: number): string;
export interface MeterOptions {
    budgetTokens?: number;
    prices?: PriceRow[];
    /** currency shown when no price row matched (token-only mode renders no money) */
    now?: Date;
}
/** Full panel for /qm and the quota_meter tool: per-session gauge + totals. */
export declare function renderMeter(title: string, totals: UsageTotals, options?: MeterOptions): string;
/** Budget warning grades injected after the gauge: 80% is a heads-up, 100%
 * tells the model to wrap up — the section is the one channel guaranteed to
 * reach the model every turn, so the nudge rides there. */
export declare function budgetWarningGrade(total: number, budgetTokens: number | undefined): string;
/** One-line live gauge injected into the system prompt every turn. */
export declare function renderCompactLine(totals: UsageTotals, options?: MeterOptions): string;
/** Per-model leaderboard for /qm-top: rows sorted by input+output (the same
 * "used" figure the gauges show), capped at `limit`. Empty map renders a plain
 * "no data" line — a leaderboard over nothing must not look like a zero row. */
export declare function renderModelTop(title: string, byModel: Record<string, UsageTotals> | undefined, options?: MeterOptions, limit?: number): string;
/** One `assistant/message` step. dsh emits these per *step*, not per user turn:
 * `input` is the uncached prefix delta, `cacheRead` the reused prefix. */
export interface StepUsage {
    input: number;
    output: number;
    cacheRead: number;
}
export declare function stepOf(usage: RawUsage): StepUsage;
/** Tool results landing after the last step are the one part the meter cannot
 * see; 15% slack on the new content keeps the estimate from reading low. */
export declare const TOOL_SLACK = 0.15;
export interface TurnForecast {
    /** billable (uncached) input for the next step */
    inputEst: number;
    /** the already-cached prefix, expected to hit again */
    cacheReadEst: number;
    promptEst: number;
    outputP50: number;
    outputP85: number;
    costP50Micros: number;
    costP85Micros: number;
    /** currency the cost figures are in, from the row that actually matched the
     * session's model — never the first row of the price table */
    currency: string | null;
    basis: number;
}
/** Nearest-rank percentile over a copy; empty input is 0, one sample is itself. */
export declare function percentile(values: readonly number[], q: number): number;
/** Next-step estimate from the step history: the prefix grows by what the model
 * just wrote, the cached part stays cached, output is the session's own spread.
 * Null with no history — a forecast invented before the first step is a lie. */
export declare function predictNextTurn(history: readonly StepUsage[], price: PriceRow | null): TurnForecast | null;
/** The panel line: what the next step is going to cost before it happens. */
export declare function renderForecastLine(forecast: TurnForecast | null): string;
/** Median step-to-step prompt growth: a single huge tool result must not fake the
 * slope, so the middle delta wins and the mean never does. 0 below two steps. */
export declare function promptGrowth(history: readonly StepUsage[]): number;
export interface WindowProjection {
    /** prompt tokens in front of the model at the last observed step */
    promptNow: number;
    growthPerStep: number;
    /** more steps before promptNow reaches contextWindow; null = no honest fill point */
    stepsToFull: number | null;
    /** session step index where it fills; null with no fill point */
    fullAtStep: number | null;
    /** false for a flat or shrinking session — those never fill up */
    willGrow: boolean;
    /** steps behind the reading; under 2 the slope is not observable yet */
    basis: number;
}
/** When does this session's context window fill up? `observedSteps` is the session's
 * true step count when the retained history is shorter than the session (history is
 * capped per session), so the printed index is not off by the trim. */
export declare function projectWindow(history: readonly StepUsage[], contextWindow: number, observedSteps?: number): WindowProjection;
export interface BudgetProjection {
    totalUsed: number;
    budgetTokens: number;
    /** steps until cumulative usage crosses the budget; null = no budget or no growth,
     * 0 = already crossed */
    stepsLeft: number | null;
    /** used/budget; null when there is no budget, so no ratio exists to report */
    ratio: number | null;
}
/** How many steps of this session's own growth still fit in `budgetTokens`. */
export declare function projectBudget(totalUsed: number, budgetTokens: number, growthPerStep: number): BudgetProjection;
/** Panel line: the step at which this session runs out of context. */
export declare function renderWindowLine(projection: WindowProjection | null, contextWindow: number | null): string;
/** Panel line: the step at which this session runs out of budget. */
export declare function renderBudgetLine(budget: BudgetProjection): string;
/** The published budget contract. Other plugins read `summary.json` instead of
 * digging through session-keyed `totals.json`, so a per-session uuid layout stays
 * an internal detail of quota. */
export interface QuotaSummary {
    updatedAt: string;
    currency: string;
    budgetTokens: number;
    /** the hottest single session right now */
    maxSessionTokens: number;
    /** null when no budget is set — "how hot" has no meaning without one */
    maxSessionRatio: number | null;
    /** next-step prompt estimate for the session that is currently running */
    nextTurnEstTokens: number | null;
    /** running session's model context window, null when unconfigured. These three are
     * append-only to `summary.json` — task-forge and ide-hub read it, so nothing existing
     * here may be renamed or redefined, only added. */
    contextWindow: number | null;
    /** steps until the running session fills that window, null = no fill point */
    stepsUntilFull: number | null;
    /** steps until the running session crosses budgetTokens, null = no budget */
    stepsUntilBudget: number | null;
    todayTokens: number;
    todayCostMicros: number;
    sessions: number;
}
export declare function summarise(input: {
    sessions: readonly UsageTotals[];
    today: UsageTotals;
    budgetTokens: number;
    forecast: TurnForecast | null;
    currency?: string | undefined;
    now?: Date;
    contextWindow?: number | null;
    stepsUntilFull?: number | null;
    stepsUntilBudget?: number | null;
}): QuotaSummary;
/** These mirror GenericCallView/GenericResultView from @deepseek-ai/dsh-tools with the
 * fields this plugin always fills in made required — a UI bridge still accepts them
 * structurally, and callers stop having to unwrap `title?: string` everywhere. */
export interface CallCard {
    card: 'generic';
    title: string;
    /** the ToolCallKind for a pending call; a result view has no kind */
    kind: 'other';
    rawInput: string;
}
export interface ResultCard {
    card: 'generic';
    title: string;
    content: Array<{
        type: 'text';
        text: string;
    }>;
}
/** Generic presentation card for the calling state (while the tool runs). */
export declare function presentCallCard(title: string): CallCard;
/** Generic presentation card for the result state. A result view has no `kind`
 * or `rawInput` — those belong to the pending call; the body goes in `content`. */
export declare function presentResultCard(totals: UsageTotals, options?: MeterOptions, forecast?: TurnForecast | null): ResultCard;
/** One billing-log row, as new-api writes it: flat micro-quota for the whole
 * call, no cache split. */
export interface BillingRow {
    model: string;
    quota: number;
    tokens: number;
}
/** Derive real prices from the relay's own billing logs: $/M per model = quota
 * / 500000 (new-api's $1) / tokens * 1e6, averaged over each model's calls.
 * These are the numbers the user is ACTUALLY billed, not brochure prices. */
export declare function calibratePrices(rows: BillingRow[]): PriceRow[];
//# sourceMappingURL=meter.d.ts.map