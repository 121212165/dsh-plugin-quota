/** Official session-projection unit for quota: per-session usage folded from
 * committed assistant/message events. State is authoritative and fork/resume
 * safe (the registry replays the log); the in-memory map in plugin.ts stays
 * only as the cross-session daily rollup and the no-registry fallback.
 * @module projection */

import { z } from 'zod';

import { addUsage, costMicrosOf, emptyTotals, priceFor, type PriceRow, type RawUsage, type UsageTotals } from './meter.ts';

export interface QuotaState {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
  costMicros: number;
  /** per-model buckets, added for /qm-top. Optional-in/schema-defaulted so old
   * checkpoints validate unchanged — stateVersion stays 1 and nothing is replayed. */
  byModel: Record<string, UsageTotals>;
}

// The state table is merge-extensible by design (official pattern): a
// third-party host-only key augments SessionProjectionStateMap.
import type {} from '@deepseek-ai/dsh-session-projection/types';

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    quota: QuotaState;
  }
}

const totalsSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  costMicros: z.number().nonnegative(),
});

const stateSchema = totalsSchema.extend({ byModel: z.record(z.string(), totalsSchema).default({}) });

interface UsageEvent {
  type?: string;
  data?: {
    usage?: RawUsage;
    message?: { source?: { model?: string } };
  };
}

export type QuotaProjectionDefinition = {
  key: 'quota';
  stateVersion: number;
  stateSchema: z.ZodType<QuotaState>;
  init: () => QuotaState;
  apply: (state: QuotaState, event: UsageEvent) => QuotaState;
};

/** Factory: prices come from Config at apply() time, the fold itself is pure
 * and synchronous and returns the same reference for unrelated events. */
export const quotaProjection = (prices: PriceRow[]): QuotaProjectionDefinition => ({
  key: 'quota',
  // 1 stays: byModel is schema-defaulted, so pre-byModel checkpoints still validate
  stateVersion: 1,
  stateSchema,
  init: () => ({ ...emptyTotals(), byModel: {} }),
  apply: (state, event) => {
    if (event?.type !== 'assistant/message') return state;
    const usage = event.data?.usage;
    if (!usage) return state;
    const model = event.data?.message?.source?.model ?? 'unknown';
    const cost = costMicrosOf(priceFor(prices, model), usage);
    const totals = addUsage(state, usage);
    const bucket = addUsage(state.byModel[model] ?? emptyTotals(), usage);
    bucket.costMicros = bucket.costMicros + cost;
    return { ...totals, costMicros: totals.costMicros + cost, byModel: { ...state.byModel, [model]: bucket } };
  },
});
