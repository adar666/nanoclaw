/**
 * read_shared_context — reads any `shared-facts.md` an operator has
 * explicitly mounted read-only from another agent group's memory into this
 * group's `/workspace/extra/`, via `ncl groups config add-mount --ro`
 * (spec 1.1, "Read a Fact Shared by Another Agent Group").
 *
 * The grant is entirely operator-configured, out-of-band from this tool —
 * there is no agent-initiated/self-service grant path (spine AD-2). This
 * tool only ever reads `shared-facts.md` files that already live under
 * `/workspace/extra/*-shared/`; it never reads any other mounted path, and
 * there is no write/save counterpart here — a source group's own agent
 * edits its `shared-facts.md` with its ordinary file tools, same as any
 * other memory `.md` file.
 *
 * No grant, a grant whose file hasn't been written yet, and a grant
 * rejected by mount-security (so the directory never materializes at all)
 * all produce the exact same "not shared" result — never an error, never
 * fabricated content. This is deliberate (I/O matrix, spec 1.1): the agent
 * has no way to distinguish "nobody has shared anything with you" from
 * "someone tried but it was rejected," and shouldn't guess.
 */
import fs from 'fs';
import path from 'path';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';
import { registerTools } from './server.js';

const SHARED_SUFFIX = '-shared';
const SHARED_FACTS_FILENAME = 'shared-facts.md';
// This subprocess's own path constant for the mount landing spot. Two OTHER
// places independently encode the same `-shared`/`/workspace/extra/`
// convention with no shared code to enforce it — different runtimes (host
// Node CLI vs. this container-side Bun tool), so an actual shared constant
// isn't possible; this comment is the drift-prevention mechanism instead
// (spine AD-5's convention: cross-reference, don't silently duplicate):
//   - `src/cli/resources/groups.ts`'s `config add-mount` guard: its own
//     regex, `/(^|\/)[^/]+-shared(\/|$)/`, matches the same `*-shared`
//     folder-name convention this file's `SHARED_SUFFIX` scans for.
//   - `src/modules/mount-security/index.ts`'s `validateMount()`: lands every
//     validated mount at `/workspace/extra/${containerPath}` — the same
//     `/workspace/extra` prefix as `WORKSPACE_EXTRA_DIR` below.
// If either of those changes its convention, this file's scan silently stops
// matching real mounts — there is no test that spans the process boundary to
// catch that automatically.
export const WORKSPACE_EXTRA_DIR = '/workspace/extra';

// A shared-facts file is scoped to durable, hand-maintained facts — never a
// document dump. Same size-cap-with-truncation precedent as documents.ts's
// MAX_INBOX_FILE_BYTES, sized in characters (not bytes) since this value
// only ever flows into a text response, never a binary read.
const MAX_SHARED_FACTS_CHARS = 20_000;

const NOT_SHARED_TEXT = 'Nothing has been shared with you yet — no other agent group has an active shared-facts grant into this group.';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Scans `extraDir` for `*-shared` subdirectories and reads each one's
 * `shared-facts.md` if present, labeling each by its source folder name
 * (the `-shared` suffix stripped). Exported (rather than only the tool's
 * `handler`) so tests can point it at a temp directory instead of the real
 * `/workspace/extra` — same injectable-base pattern as `documents.ts`'s
 * `*Impl(args, { baseDir })` functions.
 */
export function readSharedContextImpl(extraDir: string): CallToolResult {
  if (!fs.existsSync(extraDir)) return ok(NOT_SHARED_TEXT);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extraDir, { withFileTypes: true });
  } catch {
    // Unreadable /workspace/extra is indistinguishable from "nothing
    // mounted" from this tool's perspective — never surface an error here.
    return ok(NOT_SHARED_TEXT);
  }

  const sections: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !entry.name.endsWith(SHARED_SUFFIX)) continue;
    const sourceName = entry.name.slice(0, -SHARED_SUFFIX.length);
    const factsPath = path.join(extraDir, entry.name, SHARED_FACTS_FILENAME);
    if (!fs.existsSync(factsPath)) continue; // grant exists, file not yet written — same as no grant

    let content: string;
    try {
      content = fs.readFileSync(factsPath, 'utf-8');
    } catch {
      continue; // unreadable is treated the same as missing, never an error
    }
    const trimmed = content.trim();
    // review_loop_iteration 1: empty/whitespace-only content is treated
    // identically to "file not yet written" — never a section with an
    // empty body.
    if (trimmed.length === 0) continue;

    // review_loop_iteration 1 (round 2): slice on Array.from's code-point
    // iteration, not raw string indexing — a plain `.slice()` counts UTF-16
    // code units and can cut an astral character (emoji, some scripts) in
    // half at the boundary, leaving a lone surrogate in the output.
    const body =
      trimmed.length > MAX_SHARED_FACTS_CHARS
        ? `${Array.from(trimmed).slice(0, MAX_SHARED_FACTS_CHARS).join('')}\n\n[…truncated — shared-facts.md exceeds the ${MAX_SHARED_FACTS_CHARS}-character limit]`
        : trimmed;
    sections.push(`## Shared by ${sourceName}\n\n${body}`);
  }

  if (sections.length === 0) return ok(NOT_SHARED_TEXT);
  return ok(sections.join('\n\n---\n\n'));
}

export const readSharedContext: McpToolDefinition = {
  tool: {
    name: 'read_shared_context',
    description:
      'Read facts another agent group has explicitly shared with you (operator-configured only). ' +
      'Returns each shared group\'s content labeled by source, or a clean "nothing shared" result if none exists.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  handler: async () => readSharedContextImpl(WORKSPACE_EXTRA_DIR),
};

registerTools([readSharedContext]);
