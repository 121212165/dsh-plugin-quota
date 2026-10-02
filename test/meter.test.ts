import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
  type PriceRow,
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
  assert.equal(result.kind, 'other'); // ToolCallKind enum
  assert.ok(result.title.includes('13.8k tok') || result.title.includes('14k tok'), result.title);
  assert.ok(result.title.includes('0.017 USD'));
  assert.ok(result.rawInput.includes('会话实时用量'));
});
