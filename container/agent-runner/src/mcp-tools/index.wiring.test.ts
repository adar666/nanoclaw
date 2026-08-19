import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

// This barrel is a separate process from index.ts's main() — spawned by the
// Claude Agent SDK as the `nanoclaw` MCP stdio server (index.wiring.test.ts
// in the parent directory guards its env inheritance; this guards a
// different gap in the same subprocess boundary). It can't be driven
// in-process for a real test (startMcpServer() blocks on stdio), so this
// guard is structural: assert the real entry point's source.
//
// What this protects: calendar.ts's calendarConfigHooks calls getConfig()
// (spec cal-2.3), which throws "Config not loaded" until loadConfig() has
// run *in this process*. main()'s own loadConfig() call (index.ts) runs in
// a different process and has no effect here. Found live in production,
// 2026-08-19: every calendar tool call failed deterministically with that
// exact error once this subprocess started running the config-dependent
// calendar registry code, because nothing in this file's own module
// lifecycle ever called loadConfig().
describe('mcp-tools subprocess config-loading wiring', () => {
  const barrelSrc = fs.readFileSync(path.join(import.meta.dir, 'index.ts'), 'utf-8');

  it('calls loadConfig() before starting the MCP server', () => {
    expect(barrelSrc).toMatch(/import\s*{\s*loadConfig\s*}\s*from\s*['"]\.\.\/config\.js['"]/);
    expect(barrelSrc).toMatch(/^loadConfig\(\);/m);
    // Order matters: the call must appear before startMcpServer() is
    // invoked, so any handler that could run has a loaded config.
    const loadConfigIdx = barrelSrc.indexOf('loadConfig();');
    const startServerIdx = barrelSrc.indexOf('startMcpServer()');
    expect(loadConfigIdx).toBeGreaterThan(-1);
    expect(startServerIdx).toBeGreaterThan(-1);
    expect(loadConfigIdx).toBeLessThan(startServerIdx);
  });
});
