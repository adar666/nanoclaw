/**
 * Explicit alias map from Hebrew/free-text project nicknames (as heard in
 * a Telegram message, e.g. "פאפי") to the real directory name under
 * ~/Projects that call.sh's --project expects. Deliberately NOT fuzzy —
 * every entry is an exact, human-reviewed mapping. An unmatched alias
 * warns and continues without project context (see apply.ts) — it never
 * blocks the recording, and it never guesses.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from '../../log.js';

const ALIASES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'project-aliases.json');

function loadAliases(): Record<string, string> {
  try {
    const raw = readFileSync(ALIASES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    log.error('project-aliases.json is not a flat object — ignoring, no project aliases available', {
      path: ALIASES_PATH,
    });
    return {};
  } catch (err) {
    log.error('failed to load project-aliases.json — continuing with no project aliases', { path: ALIASES_PATH, err });
    return {};
  }
}

// Loaded once at module init; edits to project-aliases.json take effect on
// next process restart, same tradeoff as any other static config file here.
const ALIASES = loadAliases();

export interface ProjectAliasResolution {
  /** Real directory name under ~/Projects, or null if unresolved. */
  dir: string | null;
  /** Set only when `raw` was non-empty but matched nothing. */
  warning: string | null;
}

export function resolveProjectAlias(raw: string | undefined | null): ProjectAliasResolution {
  const alias = typeof raw === 'string' ? raw.trim() : '';
  if (!alias) return { dir: null, warning: null };

  const dir = ALIASES[alias];
  if (dir) return { dir, warning: null };

  return {
    dir: null,
    warning: `Unknown project alias "${alias}" — no mapping in project-aliases.json. Continuing without project context.`,
  };
}
