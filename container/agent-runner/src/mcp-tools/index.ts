/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
import './core.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
import './recorder.js';
import './transcribe-audio.js';
import './documents.js';
import './calendar.js';
import './shared-context.js';
import { startMcpServer } from './server.js';
import { loadConfig } from '../config.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

// This file is a SEPARATE process from index.ts's main() — spawned by the
// Claude Agent SDK as an MCP stdio server (see index.ts's mcpServers config,
// AD-15's env-inheritance fix). It has its own module registry, and
// therefore its own independent config.ts `_config` singleton, which
// nothing here ever populated before this fix — main()'s own loadConfig()
// call runs in a different process entirely and has no effect here.
// calendar.ts's calendarConfigHooks calls getConfig() (spec cal-2.3),
// which throws "Config not loaded" until loadConfig() runs *in this
// process*. Found live: every calendar tool call failed with that exact
// error once this code reached production (see incident notes, 2026-08-19).
// container.json is mounted into the container this subprocess runs
// inside, same path, so a plain loadConfig() call here is enough — no
// second config-loading mechanism needed.
loadConfig();

startMcpServer().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
