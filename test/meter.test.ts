import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addUsage,
  compactTokens,
  costMicrosOf,
  emptyTotals,
  formatMoney,
  gauge,
  percentile,
  predictNextTurn,
  presentCallCard,
  presentResultCard,
  priceFor,
  renderCompactLine,
  renderForecastLine,
  renderMeter,
  stepOf,
  summarise,
  TOOL_SLACK,
  type PriceRow,
  type StepUsage,
} from '../src/meter.ts';

const prices: PriceRow[] = [
  { match: 'space-bunny', currency: 'USD', perMillion: { input: 1, output: 2, cacheRead: 0.1 } },
  { match: 'deepseek', currency: 'CNY', perMillion: { input: 2, output: 8, cacheRead: 0.4 } },
];

const usage = { inputTokens: 12_000, outputTokens: 1_500, cacheReadTokens: 9_000, reasoningTokens: 300 };

test('addUsage folds usage into totals; non-finite and negative stay zero', () => {
  let totals = addUsage(emptyTotals(), usage);
  assert.equal(totals.inputTokens, 12_000);
  assert.equal(totals.outputTokens, 1_800); // reasoning folded into output
  assert.equal(totals.cacheReadTokens, 9_000);
  assert.equal(totals.turns, 1);
  totals = addUsage(totals, { inputTokens: Number.NaN, outputTokens: -5, cacheReadTokens: 1_000 });
  assert.equal(totals.inputTokens, 12_000);
  assert.equal(totals.outputTokens, 1_800);
  assert.equal(totals.cacheReadTokens, 10_000);
  assert.equal(totals.turns, 2);
});

test('priceFor matches by case-insensitive substring, first row wins', () => {
  assert.equal(priceFor(prices, 'stealth/space-bunny-alpha')?.currency, 'USD');
  assert.equal(priceFor(prices, 'deepseek-v4-pro')?.currency, 'CNY');
  assert.equal(priceFor(prices, 'unknown/model'), null);
});

test('costMicrosOf prices input/output/cacheRead per million; unpriced is 0', () => {
  const micros = costMicrosOf(priceFor(prices, 'space-bunny'), usage);
  // (12000*1 + 1800*2 + 9000*0.1)/1M = 0.0165 USD = 16500 micros
  assert.equal(micros, 16_500);
  assert.equal(costMicrosOf(null, usage), 0);
  assert.equal(costMicrosOf(priceFor(prices, 'space-bunny'), { inputTokens: Number.NaN }), 0);
});

test('formatMoney and compactTokens pick human scales', () => {
  assert.equal(formatMoney(16_500, 'USD'), '0.017 USD');
  assert.equal(formatMoney(12_000, 'USD'), '0.012 USD');
  assert.equal(formatMoney(2_500_000, 'CNY'), '2.50 CNY');
  assert.equal(formatMoney(0, 'CNY'), '0');
  assert.equal(compactTokens(999), '999');
  assert.equal(compactTokens(12_000), '12k');
  assert.equal(compactTokens(9_500), '9.5k');
  assert.equal(compactTokens(2_500_000), '2.50M');
});

test('gauge clamps and renders the bar', () => {
  assert.equal(gauge(0), '▱'.repeat(10));
  assert.equal(gauge(1), '▰'.repeat(10));
  assert.equal(gauge(0.5, 4), '▰▰▱▱');
  assert.equal(gauge(5, 4), '▰▰▰▰');
  assert.equal(gauge(Number.NaN, 4), '▱▱▱▱');
});

test('renderMeter shows totals, money, and the budget bar; compact line fits one line', () => {
  const totals = addUsage(emptyTotals(), usage);
  totals.costMicros = 16_500;
  const text = renderMeter('▍ 本会话', totals, { budgetTokens: 50_000, prices });
  assert.ok(text.includes('输入 12k（缓存命中 9.0k）'), text);
  assert.ok(text.includes('输出 1.8k'));
  assert.ok(text.includes('0.017 USD'));
  assert.ok(text.includes('▰'));
  assert.ok(text.includes('14k/50k')); // compactTokens rounds ≥10k to whole k

  const line = renderCompactLine(totals, { budgetTokens: 50_000, prices });
  assert.equal(line.split('\n').length, 1);
  assert.ok(line.includes('/qm 详情'));
});

test('presentation cards carry the generic contract with a live title', () => {
  const totals = addUsage(emptyTotals(), usage);
  totals.costMicros = 16_500;
  const call = presentCallCard('读取实时用量');
  assert.deepEqual(call, { card: 'generic', title: '读取实时用量', kind: 'other', rawInput: '读取实时用量' });
  const result = presentResultCard(totals, { prices });
  assert.equal(result.card, 'generic');
  assert.ok(result.title.includes('13.8k tok') || result.title.includes('14k tok'), result.title);
  assert.ok(result.title.includes('0.017 USD'));
  assert.equal(result.content![0]!.text.includes('会话实时用量'), true, 'a result view carries its body in content');
  assert.ok(!('rawInput' in result) && !('kind' in result), 'no call-view fields on a result view');
});

test('stepOf reads one assistant/message step, reasoning counted as output', () => {
  assert.deepEqual(stepOf(usage), { input: 12_000, output: 1_800, cacheRead: 9_000 });
  assert.deepEqual(stepOf({}), { input: 0, output: 0, cacheRead: 0 });
  assert.deepEqual(stepOf({ inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: 1_000_000_000 }), { input: 0, output: 0, cacheRead: 1_000_000_000 });
});

test('percentile takes the nearest rank without mutating the input', () => {
  const values = [400, 100, 300, 200];
  assert.equal(percentile(values, 0.5), 200);
  assert.equal(percentile(values, 0.85), 400);
  assert.equal(percentile(values, 1), 400);
  assert.deepEqual(values, [400, 100, 300, 200], 'the caller history stays in step order');
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([7], 0.85), 7);
});

test('predictNextTurn grows the prompt by what the model just wrote', () => {
  const step: StepUsage = { input: 1_000, output: 500, cacheRead: 20_000 };
  const one = predictNextTurn([step], priceFor(prices, 'deepseek-chat'));
  assert.ok(one);
  assert.equal(one.basis, 1);
  assert.equal(one.inputEst, Math.round(1_500 * (1 + TOOL_SLACK)));
  assert.equal(one.cacheReadEst, 20_000, 'the cached prefix is expected to hit again');
  assert.equal(one.promptEst, one.inputEst + one.cacheReadEst);
  assert.equal(one.outputP50, 500);
  assert.equal(one.outputP85, 500);
  // 1725*2 + 500*8 + 20000*0.4 micro-per-million
  assert.equal(one.costP50Micros, 15_450);
  assert.equal(one.costP85Micros, 15_450);
  assert.equal(predictNextTurn([step], null)!.costP50Micros, 0, 'unpriced models forecast tokens without money');

  const series: StepUsage[] = [
    { input: 500, output: 100, cacheRead: 0 },
    { input: 900, output: 200, cacheRead: 4_000 },
    { input: 2_000, output: 300, cacheRead: 9_000 },
    { input: 5_000, output: 400, cacheRead: 100_000 },
  ];
  const many = predictNextTurn(series, null)!;
  assert.equal(many.basis, 4);
  assert.equal(many.inputEst, Math.round(5_400 * 1.15));
  assert.equal(many.cacheReadEst, 100_000);
  assert.equal(many.outputP50, 200);
  assert.equal(many.outputP85, 400);

  // no history, or nothing usable in it, is no forecast at all
  assert.equal(predictNextTurn([], null), null);
  assert.equal(predictNextTurn([{ input: Number.NaN, output: 1, cacheRead: 1 }], null), null);
});

test('renderForecastLine refuses to invent a number, then prices the next step', () => {
  const bare = renderForecastLine(null);
  assert.ok(bare.includes('还没有已完成的步'), bare);
  assert.equal(bare.split('\n').length, 1);

  const forecast = predictNextTurn([{ input: 1_000, output: 500, cacheRead: 20_000 }], priceFor(prices, 'deepseek-chat'));
  const line = renderForecastLine(forecast);
  assert.equal(line.split('\n').length, 1);
  assert.ok(line.includes('新输入 ~1.7k'), line);
  assert.ok(line.includes('缓存复用 20k'), line);
  assert.ok(line.includes('提示词 ~22k'), line);
  assert.ok(line.includes('输出 500（P50–P85，1 步为据）'), line);
  assert.ok(line.includes('≈0.015 CNY'), line);
  assert.ok(!line.includes('–0.015'), line, 'a one-step forecast has no spread to print');

  // money follows the row that matched the session model, never the first config row
  const unpriced = predictNextTurn([{ input: 1_000, output: 500, cacheRead: 20_000 }], null);
  assert.ok(renderForecastLine(unpriced).includes('新输入 ~1.7k'));
  assert.ok(!renderForecastLine(unpriced).includes('CNY'), renderForecastLine(unpriced));
  assert.ok(!renderForecastLine(unpriced).includes('USD'), renderForecastLine(unpriced));
});

test('summarise publishes the budget contract other plugins read', () => {
  const hot = { ...emptyTotals(), inputTokens: 40_000, outputTokens: 5_000 };
  const cool = { ...emptyTotals(), inputTokens: 1_000, outputTokens: 500 };
  const forecast = predictNextTurn([{ input: 1_000, output: 500, cacheRead: 20_000 }], null);
  const summary = summarise({
    sessions: [cool, hot],
    today: { ...emptyTotals(), inputTokens: 41_000, outputTokens: 5_500, costMicros: 9_900 },
    budgetTokens: 50_000,
    forecast,
    currency: 'CNY',
    now: new Date('2026-10-02T09:00:00Z'),
  });
  assert.equal(summary.updatedAt, '2026-10-02T09:00:00.000Z');
  assert.equal(summary.sessions, 2);
  assert.equal(summary.maxSessionTokens, 45_000);
  assert.equal(summary.maxSessionRatio, 0.9);
  assert.equal(summary.nextTurnEstTokens, forecast!.promptEst);
  assert.equal(summary.todayTokens, 46_500);
  assert.equal(summary.todayCostMicros, 9_900);
  assert.equal(summary.currency, 'CNY');

  // without a budget there is no ratio to report — consumers must not guess one
  const noBudget = summarise({ sessions: [], today: emptyTotals(), budgetTokens: 0, forecast: null });
  assert.equal(noBudget.maxSessionRatio, null);
  assert.equal(noBudget.maxSessionTokens, 0);
  assert.equal(noBudget.nextTurnEstTokens, null);
  assert.equal(noBudget.currency, 'CNY', 'currency falls back, never undefined');
});

test('the result card carries the forecast into its title and its body', () => {
  const totals = addUsage(emptyTotals(), usage);
  const forecast = predictNextTurn([{ input: 1_000, output: 500, cacheRead: 20_000 }], null);
  const withForecast = presentResultCard(totals, { prices }, forecast);
  assert.ok(withForecast.title.includes('下步 ~22k'), withForecast.title);
  assert.ok(withForecast.content![0]!.text.includes('下步预估'), withForecast.content![0]!.text);
  // the old two-argument call still renders exactly as before
  assert.ok(!presentResultCard(totals, { prices }).title.includes('下步'));
});
