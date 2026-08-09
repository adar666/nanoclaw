import { describe, expect, it } from 'vitest';
import { resolveProjectAlias } from './project-aliases.js';

describe('resolveProjectAlias', () => {
  it('resolves a known alias to its real directory name', () => {
    expect(resolveProjectAlias('פאפי')).toEqual({ dir: 'pa-ai', warning: null });
  });

  it('returns dir: null, warning: null for an empty/absent alias', () => {
    expect(resolveProjectAlias('')).toEqual({ dir: null, warning: null });
    expect(resolveProjectAlias(undefined)).toEqual({ dir: null, warning: null });
    expect(resolveProjectAlias(null)).toEqual({ dir: null, warning: null });
  });

  it('warns and returns dir: null for an alias with no mapping, never blocks', () => {
    const result = resolveProjectAlias('some unknown nickname');
    expect(result.dir).toBeNull();
    expect(result.warning).toContain('Unknown project alias "some unknown nickname"');
  });

  it('trims whitespace before matching', () => {
    expect(resolveProjectAlias('  פאפי  ')).toEqual({ dir: 'pa-ai', warning: null });
  });
});
