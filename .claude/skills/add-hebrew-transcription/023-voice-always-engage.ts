import type { Migration } from './index.js';

/**
 * Per-wiring override: engage unconditionally on a transcribable voice
 * attachment, regardless of engage_mode/engage_pattern. For a group with a
 * text-prefix trigger (e.g. household's `^\.`), a voice note carries no text
 * to match the pattern against — normally that means dropped, untranscribed
 * (see isVoiceReplyToBot for the narrower reply-gesture alternative). This
 * column is the "just always engage on voice in this group" escape hatch,
 * for wirings where that's the desired default rather than an edge case.
 *
 * NULL/0 = off (default — existing behavior unaffected: text still needs its
 * usual trigger, voice notes engage only via the reply-to-bot gesture or the
 * wiring's own evaluateEngage). 1 = any transcribable voice attachment
 * engages this wiring, same effect as a reply-to-bot voice note. Text
 * messages are never affected by this column — see router.ts routeInbound,
 * where the override only ORs in when hasTranscribableVoiceAttachment is
 * true, leaving evaluateEngage's pattern/mention check untouched for text.
 */
export const migration023: Migration = {
  version: 23,
  name: 'voice-always-engage',
  up(db) {
    db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN voice_always_engage INTEGER;`);
  },
};
