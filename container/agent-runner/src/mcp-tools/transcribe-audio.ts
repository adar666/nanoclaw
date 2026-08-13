/**
 * transcribe_audio — on-demand transcription of an uploaded audio FILE
 * (not a short voice note; those already auto-transcribe before the agent
 * ever sees them). Fire-and-forget: writes an outbound system row and
 * returns immediately. The host transcribes in the background and delivers
 * the result as a fresh inbound message tagged [AUDIO-TRANSCRIPT-COMPLETE]
 * or [AUDIO-TRANSCRIPT-FAILED: reason] — no polling, just continue and
 * react when it shows up. See transcribe-audio.instructions.md and the
 * audio-report container skill.
 */
import { writeMessageOut } from '../db/messages-out.js';
import type { McpToolDefinition } from './types.js';
import { registerTools } from './server.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function generateId(): string {
  return `audio-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const transcribeAudio: McpToolDefinition = {
  tool: {
    name: 'transcribe_audio',
    description:
      'Start transcribing an uploaded audio file in the background (NOT for short voice notes — ' +
      'those transcribe automatically already). Returns immediately; the result arrives later as a ' +
      'fresh message tagged [AUDIO-TRANSCRIPT-COMPLETE] or [AUDIO-TRANSCRIPT-FAILED: reason].',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative inbox path of the audio file, exactly as shown in the [audio: ...] line.',
        },
        note: {
          type: 'string',
          description: 'Optional context to carry through (not currently surfaced back, reserved for future use).',
        },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const filePath = args.path as string | undefined;
    if (!filePath) return err('path is required');

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'system',
      content: JSON.stringify({
        action: 'transcribe_audio',
        path: filePath,
        note: args.note as string | undefined,
      }),
    });

    return ok('Transcription started — you will get a message tagged [AUDIO-TRANSCRIPT-COMPLETE] when it is ready.');
  },
};

registerTools([transcribeAudio]);
