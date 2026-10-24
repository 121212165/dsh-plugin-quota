/** Official session-projection unit for quota: per-session usage folded from
 * committed assistant/message events. State is authoritative and fork/resume
 * safe (the registry replays the log); the in-memory map in plugin.ts stays
 * only as the cross-session daily rollup and the no-registry fallback.
 * @module projection */
import { z } from 'zod';
import { type PriceRow, type RawUsage, type UsageTotals } from './meter.ts';
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
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        quota: QuotaState;
    }
}
interface UsageEvent {
    type?: string;
    data?: {
        usage?: RawUsage;
        message?: {
            source?: {
                model?: string;
            };
        };
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
export declare const quotaProjection: (prices: PriceRow[]) => QuotaProjectionDefinition;
export {};
//# sourceMappingURL=projection.d.ts.map