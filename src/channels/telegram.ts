/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with a pairing
 * interceptor wrapped around onInbound to verify chat ownership before
 * registration. See telegram-pairing.ts for the why.
 */
import fs from 'fs/promises';
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../db/messaging-groups.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';

/**
 * Dedicated bot identity, non-threaded platform (supportsThreads:false), so
 * group engagement can never be sticky-per-thread — 'mention' keeps a group
 * wiring from staying engaged forever in the single shared session.
 */
const TELEGRAM_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

const CLOUD_API_BASE = 'https://api.telegram.org';

/**
 * Fixed work dir inside the `telegram-bot-api` local-server container
 * (matches the image's TELEGRAM_WORK_DIR default — see docker run command
 * in the operator's setup notes). When --local mode is on, getFile returns
 * an absolute path under this prefix instead of a fetchable URL; we swap it
 * for the host-side bind mount path (TELEGRAM_LOCAL_FILE_DIR) to read the
 * file directly instead of trying to HTTP-fetch a container-local path.
 */
const LOCAL_SERVER_CONTAINER_DIR = '/var/lib/telegram-bot-api';

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
    // Telegram's own signal for "this message's author is a bot account" —
    // reliable even without knowing our own bot's user id/username. One
    // caveat: if multiple agent groups share this one Telegram bot identity,
    // is_bot can't distinguish which agent's message was replied to — every
    // wired agent in the chat sees isBot:true alike. Fine while a chat has
    // one wired agent; revisit if that changes.
    isBot: reply.from?.is_bot === true,
  };
}

/** Look up the bot username via Telegram getMe. Cached after first call. */
async function fetchBotUsername(token: string, apiBase: string): Promise<string | null> {
  try {
    const res = await fetch(`${apiBase}/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

/**
 * Build an onInbound interceptor that consumes pairing codes before they
 * reach the router. On match: records the chat + its paired user, promotes
 * the user to owner if the instance has no owner yet, and short-circuits.
 * On miss: forwards to the host.
 */
/**
 * Send a one-shot confirmation back to the paired chat. Best-effort — failures
 * are logged but never propagated, so a Telegram outage can't undo a successful
 * pairing or trigger the interceptor's fail-open path.
 */
async function sendPairingConfirmation(token: string, apiBase: string, platformId: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`${apiBase}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Pairing success! Head back to the NanoClaw installer to finish setup.',
      }),
    });
    if (!res.ok) {
      log.warn('Telegram pairing confirmation non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram pairing confirmation failed', { err });
  }
}

export function createPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
  apiBase: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        await hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        await hostOnInbound(platformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        await hostOnInbound(platformId, threadId, message);
        return;
      }
      // Pairing matched — record the chat and short-circuit so the
      // code-bearing message never reaches an agent. Privilege is now a
      // property of the paired user, not the chat: upsert the user, and if
      // this instance has no owner yet, promote them to owner.
      const existing = getMessagingGroupByPlatform('telegram', platformId);
      if (existing) {
        updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'telegram',
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          // Same context-appropriate default as router auto-create, so a
          // paired chat behaves like any other telegram messaging group.
          unknown_sender_policy: (consumed.consumed!.isGroup ? TELEGRAM_DEFAULTS.group : TELEGRAM_DEFAULTS.dm)
            .unknownSenderPolicy,
          created_at: new Date().toISOString(),
        });
      }

      const pairedUserId = `telegram:${consumed.consumed!.adminUserId}`;
      upsertUser({
        id: pairedUserId,
        kind: 'telegram',
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, apiBase, platformId);
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      // Fail open: pass through so a pairing bug doesn't break normal traffic.
      await hostOnInbound(platformId, threadId, message);
    }
  };
}

registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_BASE_URL', 'TELEGRAM_LOCAL_FILE_DIR']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const token = env.TELEGRAM_BOT_TOKEN;
    // Points at a self-hosted `telegram-bot-api` server (--local mode) instead
    // of the cloud API when set — raises the getFile download cap from 20MB
    // to 2000MB. See docs/telegram-local-bot-api.md for setup.
    const apiBase = env.TELEGRAM_API_BASE_URL || CLOUD_API_BASE;
    const localFileDir = env.TELEGRAM_LOCAL_FILE_DIR || null;
    const telegramAdapter = createTelegramAdapter({
      botToken: token,
      mode: 'polling',
      apiBaseUrl: apiBase,
    });

    if (localFileDir) {
      // --local mode returns an absolute container-side path in `file_path`
      // instead of something fetchable over HTTP. Read it straight off the
      // bind-mounted host directory rather than hitting the network at all.
      // downloadFile/telegramFetch are `protected` in the package's types —
      // this is a deliberate instance-level override (JS has no real
      // privacy), not something worth forking the package for.
      const internals = telegramAdapter as unknown as {
        downloadFile: (fileId: string) => Promise<Buffer>;
        telegramFetch: (method: string, payload?: Record<string, unknown>) => Promise<{ file_path?: string }>;
      };
      const original = internals.downloadFile.bind(telegramAdapter);
      internals.downloadFile = async (fileId: string) => {
        const file = await internals.telegramFetch('getFile', { file_id: fileId });
        if (file.file_path?.startsWith(LOCAL_SERVER_CONTAINER_DIR)) {
          const hostPath = localFileDir + file.file_path.slice(LOCAL_SERVER_CONTAINER_DIR.length);
          return fs.readFile(hostPath);
        }
        return original(fileId);
      };
    }

    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext,
      supportsThreads: false,
      defaults: TELEGRAM_DEFAULTS,
      transformOutboundText: sanitizeTelegramLegacyMarkdown,
      maxTextLength: 4000,
    });

    const botUsernamePromise = fetchBotUsername(token, apiBase);

    const wrapped: ChannelAdapter = {
      ...bridge,
      resolveChannelName: async (platformId: string) => {
        const chatId = platformId.split(':').slice(1).join(':');
        if (!chatId) return null;
        try {
          const res = await fetch(`${apiBase}/bot${token}/getChat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId }),
          });
          const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
          return data.ok ? (data.result?.title ?? null) : null;
        } catch {
          return null;
        }
      },
      async setup(hostConfig: ChannelSetup) {
        const intercepted: ChannelSetup = {
          ...hostConfig,
          onInbound: createPairingInterceptor(botUsernamePromise, hostConfig.onInbound, token, apiBase),
        };
        return withRetry(() => bridge.setup(intercepted), 'bridge.setup');
      },
    };
    return wrapped;
  },
  defaults: TELEGRAM_DEFAULTS,
});
