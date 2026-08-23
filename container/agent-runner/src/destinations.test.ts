import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { buildSystemPromptAddendum, resolveSessionMode } from './destinations.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedDestination(name: string, displayName: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, displayName, channelType, platformId);
}

describe('buildSystemPromptAddendum — multi-destination routing guidance', () => {
  it('includes default-routing nudge when there are >1 destinations', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedDestination('whatsapp-mg-17780', 'whatsapp-mg-17780', 'whatsapp', 'phone-2@s.whatsapp.net');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('from="name"');
    expect(prompt).toContain('`casa`');
    expect(prompt).toContain('`whatsapp-mg-17780`');
  });

  it('describes message wrapping for a single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('`casa`');
  });

  it('handles the no-destination case without crashing', () => {
    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('no configured destinations');
    expect(prompt).not.toContain('default to addressing');
  });

  it('includes default-routing and wrapping instructions for single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('`casa`');
  });

  it('gives task sessions only explicit-tool delivery instructions', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa', { kind: 'task', taskId: 'daily-briefing-a25c' });

    expect(prompt).toContain('isolated task run');
    expect(prompt).toContain('send_message({ to: "name"');
    expect(prompt).toContain('tasks/daily-briefing-a25c.md');
    expect(prompt).toContain('Only notify someone when the task asks');
    expect(prompt).not.toContain('<message to=');
    expect(prompt).not.toContain('default to addressing');
  });

  it('gives eval sessions plain no-destination framing, distinct from task framing', () => {
    // Real eval sessions have zero destinations by design (AD-1) — the
    // no-destinations early-return path must NOT fire for eval mode.
    const prompt = buildSystemPromptAddendum('Casa', { kind: 'eval' });

    expect(prompt).toContain('automated evaluation run');
    expect(prompt).toContain('no attached chat');
    expect(prompt).not.toContain('tasks/');
    expect(prompt).not.toContain('ncl tasks append-log');
    expect(prompt).not.toContain('<message to=');
    expect(prompt).not.toContain('default to addressing');
  });

  it('eval framing still applies even if the agent group happens to have destinations configured', () => {
    // Real eval sessions never actually have destinations (AD-4's
    // assertNoDestinations runs before any session is created), but the
    // eval-mode framing text itself is unconditional on destination count.
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa', { kind: 'eval' });

    expect(prompt).toContain('automated evaluation run');
    expect(prompt).not.toContain('tasks/');
  });
});

describe("resolveSessionMode — index.ts's own real mode-resolution logic, extracted so it is testable (regression: previously inline in main(), which cannot be driven in-process)", () => {
  it('resolves task mode when a taskId is present, regardless of isEval', () => {
    expect(resolveSessionMode('daily-digest-a1b2', false)).toEqual({ kind: 'task', taskId: 'daily-digest-a1b2' });
  });

  it('task mode takes priority over eval mode if both were somehow true (adversarial — the two prefixes are mutually exclusive by construction, but the resolution order itself is asserted directly)', () => {
    expect(resolveSessionMode('daily-digest-a1b2', true)).toEqual({ kind: 'task', taskId: 'daily-digest-a1b2' });
  });

  it('resolves eval mode when isEval is true and no taskId', () => {
    expect(resolveSessionMode(null, true)).toEqual({ kind: 'eval' });
  });

  it('resolves chat mode when neither applies', () => {
    expect(resolveSessionMode(null, false)).toEqual({ kind: 'chat' });
  });
});
