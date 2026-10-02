/** Wire-level assembly tests for quota: the real apply() against a mock
 * context, driving real usage events through the session/event listener and
 * asserting on the meter panel, the live prompt section, and the cards.
 * @module test/plugin.test */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { makeHarness, type Harness } from './harness.ts';

const usage = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 5_000 };
const prices = [{ match: 'space-bunny', currency: 'USD', perMillion: { input: 1, output: 2, cacheRead: 0.1 } }];

async function mounted(config: Record<string, unknown> = {}): Promise<Harness> {
  const harness = makeHarness();
  await harness.apply({ prices, ...config });
  return harness;
}

test('bad config fails loud naming quota; disabled mounts nothing', async () => {
  const bad = makeHarness();
  await assert.rejects(bad.apply({ budgetTokens: -1 }), /quota: budgetTokens/);
  const off = makeHarness();
  await off.apply({ enabled: false });
  assert.equal(off.commands.length, 0);
});

test('apply wires two commands, the quota_meter tool, and the live section', async () => {
  const harness = await mounted();
  assert.deepEqual(
    harness.commands.map((command) => command.name).sort(),
    ['qm', 'qm-reset'],
  );
  assert.equal(harness.tool('quota_meter').name, 'quota_meter');
  assert.equal(harness.sectionText(), ''); // no usage yet
});

test('usage events land in /qm panel and the live section updates each read', async () => {
  const harness = await mounted();
  harness.emitUsage('session-abc', 'stealth/space-bunny-alpha', usage);

  harness.setCurrentSession('session-abc');
  const section = harness.sectionText();
  assert.ok(section.startsWith('实时用量：'), section);
  assert.ok(section.includes('1 步'));

  const panel = harness.command('qm').handler({}).text;
  assert.ok(panel.includes('本会话'), panel);
  assert.ok(panel.includes('输入 10k（缓存命中 5.0k）'), panel); // per-field, not summed
  assert.ok(panel.includes('估算花费'), panel);
  assert.ok(panel.includes('USD'));
  assert.ok(panel.includes('今日全部'));
});

test('an unknown current session falls back to today aggregate in the section', async () => {
  const harness = await mounted();
  harness.emitUsage('session-uuid-1', 'stealth/space-bunny-alpha', usage);
  harness.setCurrentSession('session-other');
  const section = harness.sectionText();
  assert.ok(section.includes('实时用量：11k tok'), section); // daily fallback, not per-session
});

test('budget bar appears with budgetTokens and over-budget warns in /qm', async () => {
  const harness = await mounted({ budgetTokens: 5_000 });
  harness.emitUsage('session-abc', 'stealth/space-bunny-alpha', usage);
  harness.setCurrentSession('session-abc');
  assert.ok(harness.sectionText().includes('▰'));
  const panel = harness.command('qm').handler({}).text;
  assert.ok(panel.includes('⚠ 已超出单会话预算 5.0k'), panel);
});

test('unpriced models accumulate tokens without money; unpriced today shows no crash', async () => {
  const harness = await mounted();
  harness.emitUsage('session-abc', 'mystery/model', usage);
  harness.setCurrentSession('session-abc');
  const panel = harness.command('qm').handler({}).text;
  assert.ok(panel.includes('输入 10k'));
  assert.ok(!panel.includes('USD'));
});

test('/qm-reset clears everything; the tool renders cards over live totals', async () => {
  const harness = await mounted();
  harness.emitUsage('session-abc', 'stealth/space-bunny-alpha', usage);
  harness.setCurrentSession('session-abc');

  const text = await harness.tool('quota_meter').execute({});
  assert.ok(text.includes('会话实时用量'));
  assert.ok(text.includes('输出 1.0k'));

  const reset = harness.command('qm-reset').handler({});
  assert.ok(reset.text.includes('已清零 1 个会话'), reset.text);
  assert.equal(harness.sectionText(), '');
  assert.equal(harness.command('qm').handler({}).text.includes('10k'), false);
});

/** Four events because the meter flushes its files every fourth step. */
const series = [
  { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 5_000 },
  { inputTokens: 11_000, outputTokens: 1_500, cacheReadTokens: 9_000 },
  { inputTokens: 12_000, outputTokens: 2_000, cacheReadTokens: 11_000 },
  { inputTokens: 13_000, outputTokens: 2_500, cacheReadTokens: 12_000 },
];

test('the next-turn forecast reaches the panel, the tool, and the published contract', async () => {
  const harness = await mounted({ budgetTokens: 100_000 });
  harness.setCurrentSession('session-abc');
  for (const step of series) harness.emitUsage('session-abc', 'stealth/space-bunny-alpha', step);

  const panel = harness.command('qm').handler({}).text;
  assert.ok(panel.includes('下步预估：新输入 ~18k + 缓存复用 12k（提示词 ~30k）'), panel);
  assert.ok(panel.includes('输出 1.5k–2.5k（P50–P85，4 步为据）'), panel);
  assert.ok(panel.includes('≈0.022 USD–0.024 USD'), panel);

  const toolText = await harness.tool('quota_meter').execute({});
  assert.ok(toolText.includes('下步预估'), toolText);

  const dir = dirname(harness.dataPath);
  const history = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'));
  assert.deepEqual(history['session-abc'], [
    { input: 10_000, output: 1_000, cacheRead: 5_000 },
    { input: 11_000, output: 1_500, cacheRead: 9_000 },
    { input: 12_000, output: 2_000, cacheRead: 11_000 },
    { input: 13_000, output: 2_500, cacheRead: 12_000 },
  ]);

  // the contract other plugins read: totals.json keeps its session-keyed shape
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  assert.equal(summary.sessions, 1);
  assert.equal(summary.budgetTokens, 100_000);
  assert.equal(summary.maxSessionTokens, 53_000);
  assert.equal(summary.maxSessionRatio, 0.53);
  assert.equal(summary.nextTurnEstTokens, 29_825);
  assert.equal(summary.currency, 'USD', 'money is stated in the row that matched the model');
  assert.deepEqual(JSON.parse(readFileSync(harness.dataPath, 'utf8'))['session-abc'].inputTokens, 46_000);

  const card = (harness.tools[0] as unknown as { presentResult: (a: Record<string, unknown>, r: string) => { title: string; content: Array<{ text: string }> } }).presentResult({}, '');
  assert.ok(card.title.includes('下步 ~30k'), card.title);
  assert.ok(card.content[0]!.text.includes('下步预估'), card.content[0]!.text);
});

test('/qm-reset clears the forecast and republishes a cold contract', async () => {
  const harness = await mounted({ budgetTokens: 100_000 });
  harness.setCurrentSession('session-abc');
  for (const step of series) harness.emitUsage('session-abc', 'stealth/space-bunny-alpha', step);
  harness.command('qm-reset').handler({});

  const panel = harness.command('qm').handler({}).text;
  assert.ok(panel.includes('下步预估：还没有已完成的步'), panel);
  const summary = JSON.parse(readFileSync(join(dirname(harness.dataPath), 'summary.json'), 'utf8'));
  assert.equal(summary.maxSessionTokens, 0);
  assert.equal(summary.nextTurnEstTokens, null);
  assert.equal(summary.maxSessionRatio, 0);
});

test('history reloads across a remount, dropping corrupt and out-of-range entries', async () => {
  const harness = await mounted();
  const { MeterStore } = await import('../src/plugin.ts');
  const store = new MeterStore(harness.dataPath);
  const dir = dirname(harness.dataPath);

  // a hand-edited or half-written history.json must not take the meter down
  writeFileSync(join(dir, 'history.json'), JSON.stringify({
    'session-ok': [{ input: 1, output: 2, cacheRead: 3 }, { input: 'x' }, null, { input: -4, output: 0, cacheRead: 0 }],
    'session-long': Array.from({ length: 100 }, (_, index) => ({ input: index, output: index, cacheRead: index })),
    junk: 'not-an-array',
  }), 'utf8');
  const loaded = store.loadHistory();
  assert.deepEqual(loaded['session-ok'], [{ input: 1, output: 2, cacheRead: 3 }]);
  assert.equal(loaded['session-long']!.length, 64, 'history is capped so the file cannot grow unbounded');
  assert.equal(loaded['session-long']![0]!.input, 36, 'the newest steps are the ones kept');
  assert.equal(loaded.junk, undefined);

  writeFileSync(join(dir, 'history.json'), '{ this is not json', 'utf8');
  assert.deepEqual(store.loadHistory(), {}, 'an unreadable history file degrades to no forecast, not a crash');

  store.saveHistory({ 'session-round': [{ input: 5, output: 6, cacheRead: 7 }] });
  assert.deepEqual(store.loadHistory()['session-round'], [{ input: 5, output: 6, cacheRead: 7 }]);
});

/** the 128k row is the only place a fill point can come from: dsh shows no catalogue */
const windowedPrices = [{ ...prices[0]!, contextWindow: 128_000 }];

test('a non-positive or non-finite prices[].contextWindow fails startup naming quota', async () => {
  for (const contextWindow of [0, -128_000, Number.NaN, Number.POSITIVE_INFINITY]) {
    const bad = makeHarness();
    await assert.rejects(bad.apply({ prices: [{ ...prices[0]!, contextWindow }] }), /quota: prices\[\]\.contextWindow/);
  }
  const ok = await mounted({ prices: windowedPrices });
  assert.equal(ok.commands.length, 2, 'a sane contextWindow mounts normally');
});

test('/qm projects the fill point and the budget burn-out under the forecast line', async () => {
  const harness = await mounted({ prices: windowedPrices, budgetTokens: 100_000 });
  harness.setCurrentSession('session-abc');
  for (const step of series) harness.emitUsage('session-abc', 'stealth/space-bunny-alpha', step);

  const panel = harness.command('qm').handler({}).text;
  const lines = panel.split('\n');
  const at = lines.findIndex((line) => line.startsWith('下步预估'));
  assert.ok(at >= 0, panel);
  // median slope 3.5k/step over prompts 16k, 21.5k, 25k, 27.5k; 53k of a 100k budget
  assert.equal(lines[at + 1], '撑满预测：按当前增速，第 33 步（再 29 步）撑满 128k 上下文 · 建议在那之前 /compact 或换会话');
  assert.equal(lines[at + 2], '预算预测：按当前增速，再 14 步烧到 100k（已用 53%）');
  assert.ok(!panel.includes('Infinity') && !panel.includes('NaN'), panel);

  const toolText = await harness.tool('quota_meter').execute({});
  assert.ok(toolText.includes('撑满预测：按当前增速，第 33 步'), toolText);
  assert.ok(toolText.includes('预算预测：按当前增速，再 14 步'), toolText);

  // the same two numbers go out on the cross-plugin contract, nothing old goes missing
  const summary = JSON.parse(readFileSync(join(dirname(harness.dataPath), 'summary.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(summary).filter((key: string) => !['contextWindow', 'stepsUntilFull', 'stepsUntilBudget'].includes(key)),
    ['updatedAt', 'currency', 'budgetTokens', 'maxSessionTokens', 'maxSessionRatio', 'nextTurnEstTokens', 'todayTokens', 'todayCostMicros', 'sessions'],
  );
  assert.equal(summary.nextTurnEstTokens, 29_825, 'the pre-existing fields keep their meaning');
  assert.equal(summary.maxSessionRatio, 0.53);
  assert.equal(summary.contextWindow, 128_000);
  assert.equal(summary.stepsUntilFull, 29);
  assert.equal(summary.stepsUntilBudget, 14);
});

test('an unconfigured contextWindow says so plainly instead of guessing a step', async () => {
  const blind = await mounted({ budgetTokens: 100_000 });
  blind.setCurrentSession('session-abc');
  for (const step of series) blind.emitUsage('session-abc', 'stealth/space-bunny-alpha', step);
  const panel = blind.command('qm').handler({}).text;
  assert.ok(panel.includes('撑满预测：未配置该模型的 contextWindow，算不出撑满点'), panel);
  assert.ok(!panel.includes('撑满预测：按当前增速'), 'no invented step index');

  // a model no price row matched has no window either — the row is the only source
  const stranger = await mounted({ prices: windowedPrices });
  stranger.setCurrentSession('session-abc');
  for (const step of series) stranger.emitUsage('session-abc', 'mystery/model', step);
  const strangerPanel = stranger.command('qm').handler({}).text;
  assert.ok(strangerPanel.includes('撑满预测：未配置该模型的 contextWindow'), strangerPanel);
});

test('the panel admits there is nothing to project, and when the window is already full', async () => {
  const harness = await mounted({ prices: windowedPrices, budgetTokens: 100_000 });
  harness.setCurrentSession('session-abc');
  const flatStep = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 5_000 };
  harness.emitUsage('session-abc', 'stealth/space-bunny-alpha', flatStep);
  harness.emitUsage('session-abc', 'stealth/space-bunny-alpha', flatStep);

  const panel = harness.command('qm').handler({}).text;
  assert.ok(panel.includes('撑满预测：~16k/128k · 看不到撑满的迹象（增速 ≤ 0）'), panel);
  assert.ok(panel.includes('预算预测：~22k/100k · 看不到烧穿的迹象（增速 ≤ 0）'), panel);
  assert.ok(!panel.includes('Infinity') && !panel.includes('NaN'), panel);

  // one step in: the slope itself is not observable yet
  const fresh = await mounted({ prices: windowedPrices });
  fresh.setCurrentSession('session-def');
  fresh.emitUsage('session-def', 'stealth/space-bunny-alpha', flatStep);
  const freshPanel = fresh.command('qm').handler({}).text;
  assert.ok(freshPanel.includes('只有 1 步，还看不出增速'), freshPanel);

  // already past a small window: it says so now, not "in N steps"
  const past = await mounted({ prices: [{ ...prices[0]!, contextWindow: 20_000 }] });
  past.setCurrentSession('session-ghi');
  for (const step of series) past.emitUsage('session-ghi', 'stealth/space-bunny-alpha', step);
  const pastPanel = past.command('qm').handler({}).text;
  assert.ok(pastPanel.includes('撑满预测：~28k 已顶到 20k 上限 · 立刻 /compact 或换会话'), pastPanel);
  assert.ok(!pastPanel.includes('Infinity') && !pastPanel.includes('NaN'), pastPanel);
});

test('the injected section stays byte-identical while the projections grow', async () => {
  const harness = await mounted({ prices: windowedPrices, budgetTokens: 100_000 });
  harness.setCurrentSession('session-abc');
  for (const step of series) harness.emitUsage('session-abc', 'stealth/space-bunny-alpha', step);

  assert.equal(
    harness.sectionText(),
    '实时用量：53k tok / 100k ▰▰▰▰▱▱▱▱ · 4 步 · ≈0.064 USD（/qm 详情）',
    'the section rides on every turn: growing it costs tokens and drifts the prefix',
  );
  const section = harness.sectionText();
  assert.equal(section.split('\n').length, 1);
  assert.ok(!section.includes('撑满') && !section.includes('预算预测'));
});
