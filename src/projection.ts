/** Official session-projection unit for quota: per-session usage folded from
 * committed assistant/message events. State is authoritative and fork/resume
 * safe (the registry replays the log); the in-memory map in plugin.ts stays
 * only as the cross-session daily rollup and the no-registry fallback.
 * @module projection */

import { z } from 'zod';

import { addUsage, costMicrosOf, emptyTotals, priceFor, type PriceRow, type RawUsage } from './meter.ts';

export interface QuotaState {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
  costMicros: number;
}

// The state table is merge-extensible by design (official pattern): a
// third-party host-only key augments SessionProjectionStateMap.
import type {} from '@deepseek-ai/dsh-session-projection/types';

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    quota: QuotaState;
  }
}

const stateSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  costMicros: z.number().nonnegative(),
});

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
  stateVersion: 1,
  stateSchema,
  init: () => emptyTotals(),
  apply: (state, event) => {
    if (event?.type !== 'assistant/message') return state;
    const usage = event.data?.usage;
    if (!usage) return state;
    const model = event.data?.message?.source?.model ?? 'unknown';
    const totals = addUsage(state, usage);
    return { ...totals, costMicros: totals.costMicros + costMicrosOf(priceFor(prices, model), usage) };
  },
});
