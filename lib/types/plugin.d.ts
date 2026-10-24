/**
 * dsh-plugin-quota — 实时用量仪表 + 家族通用插件开发测试模板。
 *
 * One session/event listener folds every assistant/message usage into a live
 * per-session meter; a system-prompt section injects the current session's
 * gauge each turn; /qm renders the panel; quota_meter gives the agent a card.
 * The panel and the tool also project where this session's context window fills and
 * where its budget burns out; the injected one-liner grows by nothing, because it
 * rides on every turn.
 * Every seam a family plugin touches appears here exactly once, with rich
 * presentation (presentCall/presentResult generic cards) as the display
 * reference. Methodology: dsh-tool-web's presentation hooks + cost-ledger's
 * event folding + task-forge's store/tests.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type PriceRow, type QuotaSummary, type StepUsage, type UsageTotals } from './meter.ts';
export declare const name = "quota";
export declare const inject: string[];
export interface Config {
    enabled: boolean;
    dataPath?: string;
    budgetTokens: number;
    inject: boolean;
    prices: PriceRow[];
    billingDbPath?: string;
}
export declare const Config: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    dataPath: Schema<string, string>;
    budgetTokens: Schema<number, number>;
    billingDbPath: Schema<string, string>;
    inject: Schema<boolean, boolean>;
    prices: Schema<({
        match?: string | null;
        currency?: string | null;
        perMillion?: ({
            input?: number | null;
            output?: number | null;
            cacheRead?: number | null;
        } & import("@deepseek-ai/cosmokit").Dict) | null;
        contextWindow?: number | null;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        match: Schema<string, string>;
        currency: Schema<string, string>;
        perMillion: Schema<Schemastery.ObjectS<{
            input: Schema<number, number>;
            output: Schema<number, number>;
            cacheRead: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            input: Schema<number, number>;
            output: Schema<number, number>;
            cacheRead: Schema<number, number>;
        }>>;
        contextWindow: Schema<number, number>;
    }>[]>;
}>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    dataPath: Schema<string, string>;
    budgetTokens: Schema<number, number>;
    billingDbPath: Schema<string, string>;
    inject: Schema<boolean, boolean>;
    prices: Schema<({
        match?: string | null;
        currency?: string | null;
        perMillion?: ({
            input?: number | null;
            output?: number | null;
            cacheRead?: number | null;
        } & import("@deepseek-ai/cosmokit").Dict) | null;
        contextWindow?: number | null;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        match: Schema<string, string>;
        currency: Schema<string, string>;
        perMillion: Schema<Schemastery.ObjectS<{
            input: Schema<number, number>;
            output: Schema<number, number>;
            cacheRead: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            input: Schema<number, number>;
            output: Schema<number, number>;
            cacheRead: Schema<number, number>;
        }>>;
        contextWindow: Schema<number, number>;
    }>[]>;
}>>;
export declare function expandHome(path: string): string;
export declare class MeterStore {
    readonly path: string;
    readonly historyPath: string;
    readonly summaryPath: string;
    constructor(dataPath: string | undefined);
    load(): Record<string, UsageTotals>;
    save(sessions: Record<string, UsageTotals>): void;
    loadHistory(): Record<string, StepUsage[]>;
    saveHistory(histories: Record<string, StepUsage[]>): void;
    saveSummary(summary: QuotaSummary): void;
}
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=plugin.d.ts.map