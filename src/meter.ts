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

export function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0, costMicros: 0 };
}

export interface RawUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
}

const nonNeg = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

export function addUsage(totals: UsageTotals, usage: RawUsage): UsageTotals {
  return {
    inputTokens: totals.inputTokens + nonNeg(usage.inputTokens),
    outputTokens: totals.outputTokens + nonNeg(usage.outputTokens) + nonNeg(usage.reasoningTokens),
    cacheReadTokens: totals.cacheReadTokens + nonNeg(usage.cacheReadTokens),
    turns: totals.turns + 1,
    costMicros: totals.costMicros,
  };
}

/** One price row: matched by model id prefix (family style: simple + honest). */
export interface PriceRow {
  match: string;
  currency: string;
  perMillion: { input: number; output: number; cacheRead: number };
}

export function priceFor(rows: PriceRow[], modelId: string): PriceRow | null {
  return rows.find((row) => modelId.toLowerCase().includes(row.match.toLowerCase())) ?? null;
}

/** Micro-currency estimate for one usage event; 0 when the model is unpriced. */
export function costMicrosOf(price: PriceRow | null, usage: RawUsage): number {
  if (!price) return 0;
  const m = 1_000_000;
  const input = nonNeg(usage.inputTokens) * price.perMillion.input;
  const output = (nonNeg(usage.outputTokens) + nonNeg(usage.reasoningTokens)) * price.perMillion.output;
  const cacheRead = nonNeg(usage.cacheReadTokens) * price.perMillion.cacheRead;
  return Math.round(((input + output + cacheRead) / m) * 1_000_000);
}

export function formatMoney(micros: number, currency: string): string {
  if (micros <= 0) return '0';
  const value = micros / 1_000_000;
  const digits = value < 0.01 ? 4 : value < 1 ? 3 : 2;
  return `${value.toFixed(digits)} ${currency}`;
}

export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** ▰▰▰▱▱ bar of `width` cells at `ratio`, clamped to [0,1]. */
export function gauge(ratio: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const filled = Math.round(clamped * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export interface MeterOptions {
  budgetTokens?: number;
  prices?: PriceRow[];
  /** currency shown when no price row matched (token-only mode renders no money) */
  now?: Date;
}

const CURRENCY_FALLBACK = '$';

/** Full panel for /qm and the quota_meter tool: per-session gauge + totals. */
export function renderMeter(title: string, totals: UsageTotals, options: MeterOptions = {}): string {
  const lines = [`${title}`];
  const cacheNote = totals.cacheReadTokens > 0 ? `（缓存命中 ${compactTokens(totals.cacheReadTokens)}）` : '';
  lines.push(`输入 ${compactTokens(totals.inputTokens)}${cacheNote} · 输出 ${compactTokens(totals.outputTokens)} · ${totals.turns} 步`);
  const price = options.prices?.[0];
  if (totals.costMicros > 0 && price) lines.push(`估算花费 ≈ ${formatMoney(totals.costMicros, price.currency)}`);
  if (options.budgetTokens && options.budgetTokens > 0) {
    const total = totals.inputTokens + totals.outputTokens;
    lines.push(`预算 ${gauge(total / options.budgetTokens)} ${compactTokens(total)}/${compactTokens(options.budgetTokens)}`);
  }
  return lines.join('\n');
}

/** One-line live gauge injected into the system prompt every turn. */
export function renderCompactLine(totals: UsageTotals, options: MeterOptions = {}): string {
  const total = totals.inputTokens + totals.outputTokens;
  const budgetPart = options.budgetTokens && options.budgetTokens > 0 ? ` / ${compactTokens(options.budgetTokens)} ${gauge(total / options.budgetTokens, 8)}` : '';
  const price = options.prices?.[0];
  const money = totals.costMicros > 0 && price ? ` · ≈${formatMoney(totals.costMicros, price.currency)}` : '';
  return `实时用量：${compactTokens(total)} tok${budgetPart} · ${totals.turns} 步${money}（/qm 详情）`;
}

/** One `assistant/message` step. dsh emits these per *step*, not per user turn:
 * `input` is the uncached prefix delta, `cacheRead` the reused prefix. */
export interface StepUsage {
  input: number;
  output: number;
  cacheRead: number;
}

export function stepOf(usage: RawUsage): StepUsage {
  return {
    input: nonNeg(usage.inputTokens),
    output: nonNeg(usage.outputTokens) + nonNeg(usage.reasoningTokens),
    cacheRead: nonNeg(usage.cacheReadTokens),
  };
}

/** Tool results landing after the last step are the one part the meter cannot
 * see; 15% slack on the new content keeps the estimate from reading low. */
export const TOOL_SLACK = 0.15;

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
export function percentile(values: readonly number[], q: number): number {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
  return sorted[rank - 1]!;
}

/** Next-step estimate from the step history: the prefix grows by what the model
 * just wrote, the cached part stays cached, output is the session's own spread.
 * Null with no history — a forecast invented before the first step is a lie. */
export function predictNextTurn(history: readonly StepUsage[], price: PriceRow | null): TurnForecast | null {
  const steps = history.filter((step) => step && Number.isFinite(step.input) && Number.isFinite(step.output) && Number.isFinite(step.cacheRead));
  if (!steps.length) return null;
  const last = steps[steps.length - 1]!;
  const inputEst = Math.round((last.input + last.output) * (1 + TOOL_SLACK));
  const cacheReadEst = last.cacheRead;
  const outputs = steps.map((step) => step.output);
  const outputP50 = percentile(outputs, 0.5);
  const outputP85 = percentile(outputs, 0.85);
  const at = (output: number): number => costMicrosOf(price, { inputTokens: inputEst, outputTokens: output, cacheReadTokens: cacheReadEst });
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
export function renderForecastLine(forecast: TurnForecast | null): string {
  if (!forecast) return '下步预估：还没有已完成的步（跑完一步再来看）';
  const low = forecast.currency ? formatMoney(forecast.costP50Micros, forecast.currency) : '';
  const high = forecast.currency ? formatMoney(forecast.costP85Micros, forecast.currency) : '';
  // the spread is printed only when it survives rounding — "0.02–0.02 USD" is noise
  const money = forecast.currency && forecast.costP85Micros > 0 ? ` · ≈${low === high ? low : `${low}–${high}`}` : '';
  const cachePart = forecast.cacheReadEst > 0 ? ` + 缓存复用 ${compactTokens(forecast.cacheReadEst)}` : '';
  const outputs = forecast.outputP85 > forecast.outputP50 ? `${compactTokens(forecast.outputP50)}–${compactTokens(forecast.outputP85)}` : compactTokens(forecast.outputP50);
  return `下步预估：新输入 ~${compactTokens(forecast.inputEst)}${cachePart}（提示词 ~${compactTokens(forecast.promptEst)}） · 输出 ${outputs}（P50–P85，${forecast.basis} 步为据）${money}`;
}

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
  todayTokens: number;
  todayCostMicros: number;
  sessions: number;
}

export function summarise(input: {
  sessions: readonly UsageTotals[];
  today: UsageTotals;
  budgetTokens: number;
  forecast: TurnForecast | null;
  currency?: string;
  now?: Date;
}): QuotaSummary {
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
    todayTokens: input.today.inputTokens + input.today.outputTokens,
    todayCostMicros: input.today.costMicros,
    sessions: input.sessions.length,
  };
}

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
  content: Array<{ type: 'text'; text: string }>;
}

/** Generic presentation card for the calling state (while the tool runs). */
export function presentCallCard(title: string): CallCard {
  return { card: 'generic', title, kind: 'other', rawInput: title };
}

/** Generic presentation card for the result state. A result view has no `kind`
 * or `rawInput` — those belong to the pending call; the body goes in `content`. */
export function presentResultCard(totals: UsageTotals, options: MeterOptions = {}, forecast?: TurnForecast | null): ResultCard {
  const price = options.prices?.[0];
  const money = totals.costMicros > 0 && price ? ` · ≈${formatMoney(totals.costMicros, price.currency)}` : '';
  const next = forecast ? ` · 下步 ~${compactTokens(forecast.promptEst)}` : '';
  return {
    card: 'generic',
    title: `${compactTokens(totals.inputTokens + totals.outputTokens)} tok · ${totals.turns} 步${money}${next}`,
    content: [{ type: 'text', text: renderMeter('会话实时用量', totals, options) + (forecast ? `\n${renderForecastLine(forecast)}` : '') }],
  };
}
