import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

// main() can't be driven in-process (it reads /workspace/agent/container.json,
// spawns providers, and enters the poll loop), so this guard is structural:
// assert the real entry point's source, not a copy of the logic.
//
// What this protects: the `nanoclaw` MCP server is spawned by
// @modelcontextprotocol/sdk's StdioClientTransport as
// `{ ...getDefaultEnvironment(), ...server.env }`, and getDefaultEnvironment()
// only inherits HOME/LOGNAME/PATH/SHELL/TERM/USER (verified against the
// installed package at node_modules/@modelcontextprotocol/sdk/dist/esm/
// client/stdio.js). A literal `env: {}` on the nanoclaw entry silently drops
// HTTPS_PROXY/SSL_CERT_FILE/NODE_EXTRA_CA_CERTS from the MCP-tool subprocess
// — calendar.ts's fetch() would never reach the OneCLI gateway at all, no
// matter how correct the AD-15 TLS shim is. `nanoclaw` is this codebase's
// own first-party server, so full env inheritance is the right fix (the
// curated default exists to protect against an untrusted third-party
// server, which this isn't).
describe('nanoclaw MCP server env inheritance wiring', () => {
  const indexSrc = fs.readFileSync(path.join(import.meta.dir, 'index.ts'), 'utf-8');

  it('spawns the nanoclaw MCP server with a full process.env spread, not an empty object', () => {
    // Locate the nanoclaw mcpServers entry and assert its env field.
    const nanoclawEntryMatch = indexSrc.match(/nanoclaw:\s*{[^}]*}/s);
    expect(nanoclawEntryMatch).not.toBeNull();
    const entry = nanoclawEntryMatch![0];

    expect(entry).toMatch(/env:\s*{\s*\.\.\.process\.env\s*}/);
    // The literal empty-object regression this test exists to catch.
    expect(entry).not.toMatch(/env:\s*{\s*}/);
  });
});
