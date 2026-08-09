/**
 * Second-brain media ingestion — Telegram photos/documents whose mime type
 * is an image or PDF, host-only. Later phases add audio, Office docs, and
 * video; not built here, but nothing below assumes image/PDF specifically
 * beyond MEDIA_MIME_WHITELIST and the photo/document kind distinction — a
 * future phase extends the whitelist and adds a kind, not a restructure.
 *
 * Run ONCE per inbound event, before the per-agent fan-out (router.ts),
 * NOT per engaged agent like voice-transcription.ts's applyVoiceTranscription
 * — second-brain ingestion targets a TENANT's own db, not a session, so
 * re-running it once per wired agent would mean duplicate downloads and
 * duplicate `sb-ingest-telegram-media` invocations for what is structurally
 * one event. The (possibly rewritten) content string this returns is what
 * every wired agent's own writeSessionMessage call ends up storing.
 *
 * Isolation: this module never opens a tenant .db file directly — it always
 * shells out to second-brain's own `dist/bin/ingest-telegram-media.js`,
 * mirroring src/modules/recorder/apply.ts's call into
 * `dist/bin/ingest-recorder.js`. household.db is never a target: household
 * is a projection destination, not a raw ingestion source (see
 * second-brain's src/ingest.ts — ingestSourceEvents asserts this at the db
 * layer too, so this module's own routing is defense in depth, not the only
 * thing standing between a household-group message and household.db).
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { log } from './log.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from './db/messaging-groups.js';
import type { AgentGroup } from './types.js';

const execFileAsync = promisify(execFile);

// Overridable for tests; real deployments are both repos checked out as
// siblings under ~/Projects (see recorder/guard.ts's identical pattern) and
// second-brain's own data dir default (src/config.ts's DEFAULT_DATA_DIR).
// Read LAZILY (functions, not module-level consts) so tests can override
// via process.env in beforeEach without fighting ESM's static-import
// hoisting — a module-level const would capture whatever was set (or
// wasn't) at first import, before any test gets to touch it.
function secondBrainRoot(): string {
  return process.env.SECOND_BRAIN_ROOT || path.join(os.homedir(), 'Projects', 'second-brain');
}
function secondBrainDataDir(): string {
  return process.env.SECOND_BRAIN_DATA_DIR || path.join(os.homedir(), 'second-brain-data');
}

// Homebrew on Apple Silicon isn't on NanoClaw's launchd job's PATH — same
// gotcha, same fix, as voice-transcription.ts and recorder/apply.ts. Not
// load-bearing for THIS module today (no homebrew binary is invoked here,
// only `node`), kept for consistency in case a future media phase needs one.
const SPAWN_ENV = { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin` };

export type MediaTenant = 'uriel' | 'partner';
export type MediaKind = 'telegram-photo' | 'telegram-document';

/**
 * Independent of second-brain's src/attachments.ts (that whitelist is
 * gmail-specific, coupled to gmail's per-sender byte caps) — deliberately
 * its own list so a future phase (Office docs, etc.) extends this one
 * without touching gmail's ingestion at all.
 */
const MEDIA_MIME_WHITELIST = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']);

/** Bot API's own hard cap on file downloads — not a NanoClaw policy choice.
 *  A local Bot API server removes this cap; deliberately not used here
 *  (no new runtime service — see the router change's design note). */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export const MEDIA_TAG = '[MEDIA]';
export const MEDIA_FILED_TAG = '[MEDIA-FILED]';
/** Short codes, same taxonomy style as voice-transcription.ts's
 *  `not-installed | timeout | error` — the tag stays terse; the agent's
 *  persona doc is where the human-facing explanation for each code lives,
 *  not the tag itself. */
export type MediaRejectReason = 'unresolved_sender' | 'too_large' | 'download_failed' | 'write_failed';
export function mediaRejectedTag(reason: MediaRejectReason): string {
  return `[MEDIA-REJECTED: ${reason}]`;
}

// Which agent-group folder maps to which second-brain tenant. Resolved by
// folder name at each call (not hardcoded agent-group ids), matching
// src/modules/recorder/guard.ts's RECORDER_AGENT_GROUP_FOLDER pattern — a
// reseeded/migrated DB doesn't silently lose this wiring. household is
// deliberately ABSENT here: it is never a fixed ingestion target (see
// resolveMediaTenant) — it has no tenant db of its own to raw-ingest into.
const FIXED_TENANT_FOLDERS: Record<string, MediaTenant> = {
  'dm-with-uriel': 'uriel',
  'dm-with-partner': 'partner',
};
const HOUSEHOLD_FOLDER = 'household';

interface TelegramAttachment {
  type?: string;
  mimeType?: string;
  size?: number;
  name?: string;
  data?: string; // base64 — present because chat-sdk-bridge already fetched it via Bot API before router.ts ever sees this event
}

/** True Telegram photo: chat-sdk's own adapter maps `raw.photo` to
 *  `{type:'image'}` with no mimeType (Telegram's PhotoSize objects have no
 *  mime_type field at all — always JPEG in practice, never declared).
 *  Confirmed against @chat-adapter/telegram's own extractAttachments. */
function isPhotoAttachment(att: TelegramAttachment): boolean {
  return att.type === 'image';
}

/** True Telegram document whose declared mime type is an image or PDF —
 *  chat-sdk maps `raw.document` to `{type:'file'}` with Telegram's own
 *  document.mime_type carried through untouched. A document with a
 *  non-whitelisted mime (docx, zip, ...) is simply not detected — later
 *  phase, not this one, not a rejection. */
function isEligibleDocumentAttachment(att: TelegramAttachment): boolean {
  return att.type === 'file' && typeof att.mimeType === 'string' && MEDIA_MIME_WHITELIST.has(att.mimeType);
}

export interface DetectedMedia {
  kind: MediaKind;
  mimeType: string;
  declaredBytes: number | undefined;
  attachment: TelegramAttachment;
}

/** Parses inbound content once; returns the first eligible photo/PDF-or-image
 *  document attachment, or null. A message with more than one such
 *  attachment is unusual for Telegram (one media item per message is the
 *  norm) — only the first is handled; this is a scope choice, not a bug,
 *  matching Telegram's own "single attachment per message" UI convention. */
export function detectMedia(contentStr: string): DetectedMedia | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return null;
  }
  const attachments = parsed.attachments as TelegramAttachment[] | undefined;
  if (!Array.isArray(attachments)) return null;

  for (const att of attachments) {
    if (isPhotoAttachment(att)) {
      return { kind: 'telegram-photo', mimeType: 'image/jpeg', declaredBytes: att.size, attachment: att };
    }
    if (isEligibleDocumentAttachment(att)) {
      return { kind: 'telegram-document', mimeType: att.mimeType!, declaredBytes: att.size, attachment: att };
    }
  }
  return null;
}

export type MediaTenantResolution =
  | { kind: 'fixed'; tenant: MediaTenant }
  | { kind: 'household-sender'; tenant: MediaTenant }
  | { kind: 'unresolved-sender' }
  | { kind: 'not-configured' };

/**
 * DM groups (dm-with-uriel, dm-with-partner) have a fixed tenant — every
 * message in that chat is from that one person. The household group has
 * NO fixed tenant: household.db is a projection destination, never a raw
 * ingestion source (decided explicitly — see git history/conversation for
 * the reasoning), so media sent into the household chat routes by SENDER
 * IDENTITY into that person's own private tenant db instead, exactly as if
 * they'd sent it in their own DM. Resolved by matching the sender's
 * `telegram:<id>` against the platform_id of the uriel/partner DM
 * messaging groups — for a Telegram DM, platform_id IS the user's own
 * Telegram id (chat_id == user_id for a 1:1 chat), so this is a direct,
 * derived match, not a hardcoded id map. No fallback to a default tenant:
 * an unresolved sender means nothing gets ingested anywhere.
 */
export function resolveMediaTenant(agentGroup: AgentGroup, senderId: string | null): MediaTenantResolution {
  const fixed = FIXED_TENANT_FOLDERS[agentGroup.folder];
  if (fixed) return { kind: 'fixed', tenant: fixed };
  if (agentGroup.folder !== HOUSEHOLD_FOLDER) return { kind: 'not-configured' };
  if (!senderId) return { kind: 'unresolved-sender' };

  for (const [folder, tenant] of Object.entries(FIXED_TENANT_FOLDERS)) {
    const dmAgentGroup = getAgentGroupByFolder(folder);
    if (!dmAgentGroup) continue;
    const dms = getMessagingGroupsByAgentGroup(dmAgentGroup.id);
    const isThisSender = dms.some(
      (mg) => mg.is_group === 0 && mg.channel_type === 'telegram' && mg.platform_id === senderId,
    );
    if (isThisSender) return { kind: 'household-sender', tenant };
  }
  return { kind: 'unresolved-sender' };
}

/** Same charset/control-character/path-traversal discipline as
 *  second-brain's src/attachments.ts sanitizeFilenameFragment — duplicated
 *  rather than imported (this module shells out to second-brain, it
 *  doesn't import its TS), kept in sync by hand if that logic ever changes. */
function sanitizeFilenameFragment(rawName: string): string {
  const lastSegment = rawName.split(/[\\/]/).pop() ?? '';
  let noControlChars = '';
  for (const ch of lastSegment) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint >= 0x20 && codePoint !== 0x7f) noControlChars += ch;
  }
  const allowedCharset = noControlChars.replace(/[^\p{L}\p{N}\- ._]/gu, '_');
  const noLeadingDots = allowedCharset.replace(/^\.+/, '');
  const trimmed = noLeadingDots.trim().slice(0, 60);
  return trimmed.length > 0 ? trimmed : 'attachment';
}

function monthBucket(timestamp: string): string {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * The single entry point router.ts calls, once per inbound event, before
 * any per-agent delivery. Returns the FULL rewritten content string (tag +
 * caption, mirroring voice-transcription.ts's tag-prepending composition) —
 * the caller assigns this straight over event.message.content. Returns
 * null when there's nothing to do: no eligible attachment, or this agent
 * group has no media tenant configured at all (not one of the three groups
 * this feature is wired for) — the common case for most messages, and
 * event.message.content is left completely untouched.
 */
export async function ingestTelegramMedia(
  contentStr: string,
  agentGroup: AgentGroup,
  senderId: string | null,
  messageId: string,
  timestamp: string,
): Promise<string | null> {
  const detected = detectMedia(contentStr);
  if (!detected) return null;

  const resolution = resolveMediaTenant(agentGroup, senderId);
  if (resolution.kind === 'not-configured') return null;

  if (resolution.kind === 'unresolved-sender') {
    log.info('Media ingestion: unresolved sender, rejecting', { agentGroupId: agentGroup.id, senderId, messageId });
    return rewriteContent(contentStr, mediaRejectedTag('unresolved_sender'));
  }

  if (typeof detected.declaredBytes === 'number' && detected.declaredBytes > MAX_MEDIA_BYTES) {
    log.info('Media ingestion: file too large, rejecting', {
      agentGroupId: agentGroup.id,
      messageId,
      declaredBytes: detected.declaredBytes,
    });
    return rewriteContent(contentStr, mediaRejectedTag('too_large'));
  }

  const base64Data = detected.attachment.data;
  if (!base64Data) {
    log.warn('Media ingestion: attachment has no data (download failed upstream), rejecting', {
      agentGroupId: agentGroup.id,
      messageId,
    });
    return rewriteContent(contentStr, mediaRejectedTag('download_failed'));
  }

  const bytes = Buffer.from(base64Data, 'base64');
  if (bytes.length > MAX_MEDIA_BYTES) {
    // Authoritative re-check against the real byte length — never trust
    // the declared size alone, same discipline as second-brain's
    // storeAttachment re-checking checkAttachmentPolicy's pre-check.
    log.info('Media ingestion: real byte length exceeds cap (declared size was wrong or absent), rejecting', {
      agentGroupId: agentGroup.id,
      messageId,
      actualBytes: bytes.length,
    });
    return rewriteContent(contentStr, mediaRejectedTag('too_large'));
  }

  const tenant = resolution.tenant;
  const rawName = detected.kind === 'telegram-photo' ? 'photo.jpg' : (detected.attachment.name ?? 'attachment');
  const filename = `${messageId}-${sanitizeFilenameFragment(rawName)}`;
  const dir = path.join(secondBrainDataDir(), 'attachments', tenant, monthBucket(timestamp));
  const filePath = path.join(dir, filename);

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  } catch (err) {
    log.error('Media ingestion: failed to write file to second-brain attachments dir', {
      agentGroupId: agentGroup.id,
      messageId,
      err,
    });
    return rewriteContent(contentStr, mediaRejectedTag('write_failed'));
  }

  const occurredAt = Math.floor(new Date(timestamp).getTime() / 1000);
  const caption = extractCaption(contentStr);

  try {
    const args = [
      path.join(secondBrainRoot(), 'dist/bin/ingest-telegram-media.js'),
      '--tenant',
      tenant,
      '--message-id',
      messageId,
      '--sender',
      senderId ?? 'unknown',
      '--occurred-at',
      String(occurredAt),
      '--path',
      filePath,
      '--mime',
      detected.mimeType,
      '--bytes',
      String(bytes.length),
      '--kind',
      detected.kind,
      ...(caption ? ['--caption', caption] : []),
    ];
    await execFileAsync(process.execPath, args, { cwd: secondBrainRoot(), timeout: 30_000, env: SPAWN_ENV });
  } catch (err) {
    log.error('Media ingestion: second-brain ingest CLI failed (file is still on disk)', {
      agentGroupId: agentGroup.id,
      messageId,
      filePath,
      err,
    });
    // File is safe on disk even though the events row failed — same
    // "transcript is safe, ingest failed" pattern as recorder/apply.ts's
    // stopAndIngest. Tell the DM agent the truth: it has a path, but no
    // durable memory of this file yet.
  }

  if (resolution.kind === 'household-sender') {
    // No mount into this container reaches the file — household has no
    // attachments mount of its own (see resolveMediaTenant's doc comment).
    // Passing a path here would be either unreachable or would leak the
    // sender's own tenant directory layout into a shared group's context.
    return rewriteContent(contentStr, MEDIA_FILED_TAG);
  }

  // Fixed-tenant DM: this agent's own container DOES have this tenant's
  // attachments dir mounted (groups/<folder>/container.json) — the path is
  // reachable, pass it along with the caption.
  return rewriteContent(contentStr, `${MEDIA_TAG} ${filePath} (${detected.kind}, ${detected.mimeType})`);
}

function extractCaption(contentStr: string): string | null {
  try {
    const parsed = JSON.parse(contentStr) as { text?: string };
    return parsed.text?.trim() ? parsed.text.trim() : null;
  } catch {
    return null;
  }
}

/** Prepends `tag` to content.text, same composition as
 *  voice-transcription.ts's VOICE_TRANSCRIPT_TAG prepending — the caption
 *  (the user's actual question) stays in `text` below the tag, so "pass
 *  BOTH the path and the caption" falls out of one field rather than two. */
function rewriteContent(contentStr: string, tag: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return contentStr;
  }
  const existingText = typeof parsed.text === 'string' ? parsed.text : '';
  parsed.text = `${tag}\n${existingText}`;
  return JSON.stringify(parsed);
}
