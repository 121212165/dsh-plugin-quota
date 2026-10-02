export { name, Config, apply, inject, expandHome, MeterStore } from './plugin.ts';
export type { Config as QuotaConfig } from './plugin.ts';
export {
  addUsage,
  compactTokens,
  costMicrosOf,
  emptyTotals,
  formatMoney,
  gauge,
  presentCallCard,
  presentResultCard,
  priceFor,
  renderCompactLine,
  renderMeter,
  type MeterOptions,
  type PriceRow,
  type RawUsage,
  type UsageTotals,
} from './meter.ts';
