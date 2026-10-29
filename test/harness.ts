/** Assembly-layer harness for quota: a scripted mock dsh context mounting the
 * real apply(), with the session/event listener captured so tests can drive
 * real usage events and watch the meter, the section, and the cards update.
 * The mock itself lives in @dsh-family/kit; this file only adds quota's
 * captures and event shape.
 * @module test/harness */

import { join } from 'node:path';

import { applyOnce, createMockCtx, tempDir } from '@dsh-family/kit/kit/test-harness';

export interface CapturedCommand {
  name: string;
  handler: (args: { rawInput?: string }) => { kind: string; text: string };
}

export interface CapturedTool {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface CapturedSection {
  name: string;
  text: () => string;
}

export interface Harness {
  commands: CapturedCommand[];
  tools: CapturedTool[];
  sections: CapturedSection[];
  dataPath: string;
  apply(config: Record<string, unknown>): Promise<void>;
  command(name: string): CapturedCommand;
  tool(name: string): CapturedTool;
  sectionText(): string;
  emitUsage(sessionId: string, model: string, usage: Record<string, number>): void;
  setCurrentSession(sessionId: string | undefined): void;
}

export function makeHarness(): Harness {
  let currentSession: string | undefined;

  const mock = createMockCtx<CapturedCommand, CapturedTool, CapturedSection>({
    agents: {
      currentInitiator() {
        return currentSession === undefined ? undefined : { session: { id: currentSession } };
      },
    },
  });

  const dataPath = join(tempDir('quota-wire-'), 'totals.json');

  // Schema defaults only apply through the host — restate them for direct apply().
  // The first apply() call decides the mount config; later calls reuse it.
  let pending: Record<string, unknown> = {};
  let mounted = false;
  const apply = applyOnce(() =>
    import('../src/plugin.ts').then(({ apply }) =>
      apply(mock.ctx as never, { enabled: true, budgetTokens: 0, inject: true, prices: [], dataPath, ...pending } as never),
    ),
  );

  return {
    commands: mock.commands,
    tools: mock.tools,
    sections: mock.sections,
    dataPath,
    apply(config: Record<string, unknown>) {
      if (!mounted) {
        mounted = true;
        pending = config;
      }
      return apply();
    },
    command: mock.command,
    tool: mock.tool,
    sectionText(): string {
      return mock.section('quota').text();
    },
    emitUsage(sessionId: string, model: string, usage: Record<string, number>): void {
      const callback = mock.listener('session/event').callback as unknown as (
        session: unknown,
        event: unknown,
      ) => void;
      callback(
        { id: sessionId },
        { type: 'assistant/message', data: { usage, message: { source: { provider: 'relay', model } } } },
      );
    },
    setCurrentSession(sessionId: string | undefined): void {
      currentSession = sessionId;
    },
  };
}
