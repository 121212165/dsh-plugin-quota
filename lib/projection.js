/** Official session-projection unit for quota: per-session usage folded from
 * committed assistant/message events. State is authoritative and fork/resume
 * safe (the registry replays the log); the in-memory map in plugin.ts stays
 * only as the cross-session daily rollup and the no-registry fallback.
 * @module projection */
import { z } from 'zod';
import { addUsage, costMicrosOf, emptyTotals, priceFor } from './meter.js';
const totalsSchema = z.object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    turns: z.number().int().nonnegative(),
    costMicros: z.number().nonnegative(),
});
const stateSchema = totalsSchema.extend({ byModel: z.record(z.string(), totalsSchema).default({}) });
/** Factory: prices come from Config at apply() time, the fold itself is pure
 * and synchronous and returns the same reference for unrelated events. */
export const quotaProjection = (prices) => ({
    key: 'quota',
    // 1 stays: byModel is schema-defaulted, so pre-byModel checkpoints still validate
    stateVersion: 1,
    stateSchema,
    init: () => ({ ...emptyTotals(), byModel: {} }),
    apply: (state, event) => {
        if (event?.type !== 'assistant/message')
            return state;
        const usage = event.data?.usage;
        if (!usage)
            return state;
        const model = event.data?.message?.source?.model ?? 'unknown';
        const cost = costMicrosOf(priceFor(prices, model), usage);
        const totals = addUsage(state, usage);
        const bucket = addUsage(state.byModel[model] ?? emptyTotals(), usage);
        bucket.costMicros = bucket.costMicros + cost;
        return { ...totals, costMicros: totals.costMicros + cost, byModel: { ...state.byModel, [model]: bucket } };
    },
});
//# sourceMappingURL=projection.js.map