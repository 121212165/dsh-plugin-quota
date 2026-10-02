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
  lines.push(`输入 ${compactTokens(totals.inputTokens)}${cacheNote} · 输出 ${compactTokens(totals.outputTokens)} · ${totals.turns} 轮`);
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
  return `实时用量：${compactTokens(total)} tok${budgetPart} · ${totals.turns} 轮${money}（/qm 详情）`;
}

/** Generic presentation card for the calling state (while the tool runs). */
export function presentCallCard(title: string): { card: string; title: string; kind: string; rawInput: string } {
  return { card: 'generic', title, kind: 'other', rawInput: title };
}

/** Generic presentation card for the result state. */
export function presentResultCard(totals: UsageTotals, options: MeterOptions = {}): { card: string; title: string; kind: string; rawInput: string } {
  const price = options.prices?.[0];
  const money = totals.costMicros > 0 && price ? ` · ≈${formatMoney(totals.costMicros, price.currency)}` : '';
  return {
    card: 'generic',
    title: `${compactTokens(totals.inputTokens + totals.outputTokens)} tok · ${totals.turns} 轮${money}`,
    kind: 'other',
    rawInput: renderMeter('会话实时用量', totals, options),
  };
}
