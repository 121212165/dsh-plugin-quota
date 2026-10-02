/** Wire-level assembly tests for quota: the real apply() against a mock
 * context, driving real usage events through the session/event listener and
 * asserting on the meter panel, the live prompt section, and the cards.
 * @module test/plugin.test */

import assert from 'node:assert/strict';
import { test } from 'node:test';

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
  assert.ok(section.includes('1 轮'));

  const panel = harness.command('qm').handler({}).text;
  assert.ok(panel.includes('本会话'), panel);
  assert.ok(panel.includes('11k')); // 10000 input + 1000 output
  assert.ok(panel.includes('0.011 USD')); // (10000*1 + 1000*2 + 5000*0.1)/1M
  assert.ok(panel.includes('今日全部'));
});

test('an unknown current session falls back to today aggregate in the section', async () => {
  const harness = await mounted();
  harness.emitUsage('session-2026-10-02-x', 'stealth/space-bunny-alpha', usage);
  harness.setCurrentSession('session-other');
  const section = harness.sectionText();
  assert.ok(section.includes('实时用量：11k'), section);
});

test('budget bar appears with budgetTokens and over-budget warns in /qm', async () => {
  const harness = await mounted({ budgetTokens: 5_000 });
  harness.emitUsage('session-abc', 'stealth/space-bunny-alpha', usage);
  harness.setCurrentSession('session-abc');
  assert.ok(harness.sectionText().includes('▰'));
  const panel = harness.command('qm').handler({}).text;
  assert.ok(panel.includes('⚠ 已超出单会话预算 5k'), panel);
});

test('unpriced models accumulate tokens without money; unpriced today shows no crash', async () => {
  const harness = await mounted();
  harness.emitUsage('session-abc', 'mystery/model', usage);
  harness.setCurrentSession('session-abc');
  const panel = harness.command('qm').handler({}).text;
  assert.ok(panel.includes('11k'));
  assert.ok(!panel.includes('USD'));
});

test('/qm-reset clears everything; the tool renders cards over live totals', async () => {
  const harness = await mounted();
  harness.emitUsage('session-abc', 'stealth/space-bunny-alpha', usage);
  harness.setCurrentSession('session-abc');

  const text = await harness.tool('quota_meter').execute({});
  assert.ok(text.includes('会话实时用量'));
  assert.ok(text.includes('11k'));

  const reset = harness.command('qm-reset').handler({});
  assert.ok(reset.text.includes('已清零 1 个会话'), reset.text);
  assert.equal(harness.sectionText(), '');
  assert.equal(harness.command('qm').handler({}).text.includes('11k'), false);
});
