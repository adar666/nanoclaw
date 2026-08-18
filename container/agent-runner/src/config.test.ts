import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import fs from 'fs';

import { loadConfig } from './config.js';

/**
 * Closes the verification-gap review's real finding: every calendar.test.ts
 * assertion about calendarRegistry stubs `calendarConfigHooks` and never
 * exercises the real `getConfig().calendarRegistry` line — nothing anywhere
 * proved loadConfig() actually parses a `calendarRegistry` field out of
 * container.json in the first place. This test reads the real function
 * against a canned file body (spec cal-2.3, review loop 1).
 *
 * loadConfig() caches into a module-level singleton after its first call
 * (by design — "Called once at startup"), so only one real read is
 * meaningful per process; this is that one read.
 */
describe('loadConfig — calendarRegistry (spec cal-2.3)', () => {
  afterEach(() => {
    spyOn(fs, 'readFileSync').mockRestore();
  });

  it('parses a calendarRegistry array out of container.json verbatim', () => {
    const registry = [{ name: 'family', calendarId: 'family-cal@group.calendar.google.com' }];
    spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        provider: 'claude',
        assistantName: 'Test',
        groupName: 'test',
        agentGroupId: 'ag-1',
        maxMessagesPerPrompt: 10,
        mcpServers: {},
        calendarRegistry: registry,
      }) as unknown as ReturnType<typeof fs.readFileSync>,
    );

    const config = loadConfig();

    expect(config.calendarRegistry).toEqual(registry);
  });
});
