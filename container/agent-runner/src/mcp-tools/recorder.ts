/**
 * Recorder MCP tools: start_recorder, stop_recorder.
 *
 * Both are fire-and-forget — the tool writes a system action row and
 * returns immediately; the host runs negotiator's run.sh on the real
 * machine (this container has no audio device) and notifies back via a
 * chat message once it actually knows the outcome.
 *
 * Only succeeds when called from the one agent group the host has wired
 * for this (see src/modules/recorder/guard.ts on the host) — calling it
 * from anywhere else gets a denial notification back, not silent failure.
 *
 * `them`/`context` should be extracted from whatever the user actually
 * said ("call with Denis about HoursReportWebApp" → them="Denis",
 * context="HoursReportWebApp") — this is the metadata negotiator's own
 * session header records, and the whole reason a transcript is more than
 * "Other party"/"Me".
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export const startRecorder: McpToolDefinition = {
  tool: {
    name: 'start_recorder',
    description:
      'Start recording the current call (mic + system audio loopback — works for any call app: Zoom, Meet, WhatsApp, phone-on-speaker, doesn\'t matter which). Call this when the user says they\'re starting or joining a call, or explicitly asks you to start recording. Extract `them` and `context` from what they actually said. If they mention a project by name or nickname (e.g. "לגבי פאפי", "about HoursReportWebApp"), pass it as `project` VERBATIM — do not guess or normalize it into a real directory name yourself, the host resolves that deterministically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        them: { type: 'string', description: "Who the call is with — the other party's name, from the user's message." },
        context: { type: 'string', description: "One-line topic/subject of the call, from the user's message." },
        project: {
          type: 'string',
          description: 'Project name or nickname the call is about, exactly as the user said it — leave unset if not mentioned.',
        },
      },
      required: ['them', 'context'],
    },
  },
  async handler(args) {
    const them = args.them as string;
    const context = args.context as string;
    const project = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : undefined;
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'recorder_start', them, context, ...(project ? { project } : {}) }),
    });
    return ok("Requested. I'll confirm once it's actually recording — don't tell the user it's live yet.");
  },
};

export const stopRecorder: McpToolDefinition = {
  tool: {
    name: 'stop_recorder',
    description:
      'Stop the current recording. Call this when the user says the call ended (e.g. "סיימתי", "done with the call") — do not wait to be asked twice.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'recorder_stop' }),
    });
    return ok("Requested. I'll confirm once it's stopped and ingested — don't tell the user it's done yet.");
  },
};

registerTools([startRecorder, stopRecorder]);
