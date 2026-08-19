/**
 * Self-modification MCP tools: install_packages, add_mcp_server, add_calendar.
 *
 * All three are fire-and-forget — the tool writes a system action row and
 * returns immediately. The host processes the request (including admin
 * approval) and notifies the agent via a chat message when complete. Admin
 * approval is approval to apply the change: `install_packages` auto-rebuilds
 * the per-agent image and restarts the container; `add_mcp_server` and
 * `add_calendar` just update `container.json` and restart (bun runs TS
 * directly — no build step needed for a pure config wiring change,
 * deferred-work.md finding resolved 2026-08-19 — `add_calendar` gets the
 * same auto-restart+notify UX `ncl groups config add-calendar` never had).
 *
 * Package names / calendar ids are sanitized here at the tool boundary AND
 * re-validated on the host side (defense in depth).
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;

export const installPackages: McpToolDefinition = {
  tool: {
    name: 'install_packages',
    description:
      'Install apt and/or npm packages into YOUR per-agent container image. Requires admin approval; fire-and-forget. On approval, the image is rebuilt and the container is restarted automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        apt: { type: 'array', items: { type: 'string' }, description: 'apt packages to install (names only, no version specs or flags)' },
        npm: { type: 'array', items: { type: 'string' }, description: 'npm packages to install globally (names only, no version specs)' },
        reason: { type: 'string', description: 'Why these packages are needed' },
      },
    },
  },
  async handler(args) {
    const apt = (args.apt as string[]) || [];
    const npm = (args.npm as string[]) || [];
    if (apt.length === 0 && npm.length === 0) return err('At least one apt or npm package is required');
    if (apt.length + npm.length > MAX_PACKAGES) return err(`Maximum ${MAX_PACKAGES} packages per request`);

    const invalidApt = apt.find((p) => !APT_RE.test(p));
    if (invalidApt) return err(`Invalid apt package name: "${invalidApt}". Only lowercase letters, digits, and ._+- allowed.`);
    const invalidNpm = npm.find((p) => !NPM_RE.test(p));
    if (invalidNpm) return err(`Invalid npm package name: "${invalidNpm}". No version specs or shell characters.`);

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        apt,
        npm,
        reason: (args.reason as string) || '',
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}]`);
    return ok(`Package install request submitted. You will be notified when admin approves or rejects.`);
  },
};

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'Wire an EXISTING third-party MCP server into YOUR per-agent runtime config — you must already know the exact `command` + `args` to invoke it (e.g. `npx @modelcontextprotocol/server-github`). Requires admin approval; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        command: { type: 'string', description: 'Command to run the MCP server' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
        env: { type: 'object', description: 'Environment variables for the server' },
      },
      required: ['name', 'command'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    const command = args.command as string;
    if (!name || !command) return err('name and command are required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_mcp_server',
        name,
        command,
        args: (args.args as string[]) || [],
        env: (args.env as Record<string, string>) || {},
      }),
    });

    log(`add_mcp_server: ${requestId} → "${name}" (${command})`);
    return ok(`MCP server request submitted. You will be notified when admin approves or rejects.`);
  },
};

// Mirrors src/cli/resources/groups.ts's CALENDAR_ID_RE exactly — same
// plausibility-only check ("primary" or an email-shaped id), same rationale
// (catch an obvious typo before it becomes an opaque Google API error much
// later, at call time — not a full format validator).
const CALENDAR_ID_RE = /^(primary|[^\s@]+@[^\s@]+\.[^\s@]+)$/;

export const addCalendar: McpToolDefinition = {
  tool: {
    name: 'add_calendar',
    description:
      'Add (or override) a calendar name in YOUR per-agent group\'s calendar registry — extends the built-in ' +
      '"uriel" name (or overrides an existing registry entry) so create_calendar_event/list_calendar_events/' +
      'update_calendar_event/delete_calendar_event can target it by name. Requires admin approval; ' +
      'fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Calendar name to register (e.g. "family").' },
        calendarId: {
          type: 'string',
          description: 'Real Google Calendar id — "primary" or an email-shaped id (e.g. "user@gmail.com" or "...@group.calendar.google.com").',
        },
        reason: { type: 'string', description: 'Why this calendar is needed' },
      },
      required: ['name', 'calendarId'],
    },
  },
  async handler(args) {
    const name = (args.name as string | undefined)?.trim();
    const calendarId = (args.calendarId as string | undefined)?.trim();
    if (!name) return err('name is required');
    if (!calendarId) return err('calendarId is required');
    if (!CALENDAR_ID_RE.test(calendarId)) {
      return err(
        `calendarId "${calendarId}" doesn't look like a real Google Calendar id — expected "primary" or an ` +
          'email-shaped id (e.g. "user@gmail.com" or "...@group.calendar.google.com")',
      );
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_calendar',
        name,
        calendarId,
        reason: (args.reason as string) || '',
      }),
    });

    log(`add_calendar: ${requestId} → "${name}" (${calendarId})`);
    return ok(`Calendar registry request submitted. You will be notified when admin approves or rejects.`);
  },
};

registerTools([installPackages, addMcpServer, addCalendar]);
