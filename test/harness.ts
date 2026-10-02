/** Assembly-layer harness for quota: a scripted mock dsh context mounting the
 * real apply(), with the session/event listener captured so tests can drive
 * real usage events and watch the meter, the section, and the cards update.
 * Template ported from dsh-plugin-task-forge (methodology: dsh-auto-review).
 * @module test/harness */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

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
  const commands: CapturedCommand[] = [];
  const tools: CapturedTool[] = [];
  const sections: CapturedSection[] = [];
  let currentSession: string | undefined;

  const ctx = {
    logger(_name: string) {
      return { info() {}, warn() {}, debug() {} };
    },
    on(event: string, callback: (session: unknown, event: unknown) => void) {
      listeners.push({ event, callback });
    },
    commands: {
      register(definition: CapturedCommand) {
        commands.push(definition);
      },
    },
    tools: {
      register(definition: CapturedTool) {
        tools.push(definition);
      },
    },
    systemPrompt: {
      section(section: CapturedSection) {
        sections.push(section);
      },
    },
    agents: {
      currentInitiator() {
        return currentSession === undefined ? undefined : { session: { id: currentSession } };
      },
    },
  };
  const listeners: { event: string; callback: (session: unknown, event: unknown) => void }[] = [];

  const dataPath = join(mkdtempSync(join(tmpdir(), 'quota-wire-')), 'totals.json');
  after(() => rmSync(join(dataPath, '..'), { recursive: true, force: true }));

  let applied: Promise<void> | null = null;

  const harness: Harness = {
    commands,
    tools,
    sections,
    dataPath,
    apply(config: Record<string, unknown>) {
      applied ??= import('../src/plugin.ts').then(({ apply }) => apply(ctx as never, { enabled: true, dataPath, ...config } as never));
      return applied;
    },
    command(name: string): CapturedCommand {
      const found = commands.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`command ${name} was never registered`);
      return found;
    },
    tool(name: string): CapturedTool {
      const found = tools.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`tool ${name} was never registered`);
      return found;
    },
    sectionText(): string {
      const found = sections.find((candidate) => candidate.name === 'quota');
      if (!found) throw new Error('quota section was never registered');
      return found.text();
    },
    emitUsage(sessionId: string, model: string, usage: Record<string, number>): void {
      const listener = listeners.find((candidate) => candidate.event === 'session/event');
      if (!listener) throw new Error('session/event listener was never registered');
      listener.callback(
        { id: sessionId },
        { type: 'assistant/message', data: { usage, message: { source: { provider: 'relay', model } } } },
      );
    },
    setCurrentSession(sessionId: string | undefined): void {
      currentSession = sessionId;
    },
  };
  return harness;
}
