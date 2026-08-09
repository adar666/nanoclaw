/**
 * Best-effort Telegram notification for host-startup failures.
 *
 * Fires when a startup precondition (e.g. the container runtime) can't be
 * satisfied — before channel adapters have started, so the normal delivery
 * pipeline (`src/delivery.ts`, `getDeliveryAdapter()`) doesn't exist yet.
 * This makes a raw Bot API call instead, independent of any running
 * adapter — mirrors the pattern in second-brain's `src/notify.ts`, which
 * does the same for its daily-sync Ollama preflight.
 *
 * Tier note: core code importing from the permissions module — same
 * tradeoff `modules/approvals/primitive.ts` already makes (see its header
 * comment). Permissions ships as a default module (`modules/index.ts`), so
 * this is safe on any install that runs `main()`.
 */
import { readEnvFile } from './env.js';
import { log } from './log.js';
import { getGlobalAdmins, getOwners } from './modules/permissions/db/user-roles.js';

/**
 * Direct-addressable channels (Telegram among them) stamp the platform
 * handle straight into the user id as `<channel>:<handle>` — see
 * `modules/permissions/user-dm.ts` header. For Telegram that handle IS the
 * chat id, so no DM resolution/adapter call is needed to find one.
 */
function findTelegramChatId(): string | null {
  for (const role of [...getOwners(), ...getGlobalAdmins()]) {
    if (role.user_id.startsWith('telegram:')) {
      return role.user_id.slice('telegram:'.length);
    }
  }
  return null;
}

/** Never throws — a failed notification must not mask the original startup error. */
export async function notifyStartupFailure(text: string): Promise<void> {
  try {
    const chatId = findTelegramChatId();
    if (!chatId) {
      log.warn('Startup-failure Telegram notification skipped: no owner/admin has a telegram identity');
      return;
    }

    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) {
      log.warn('Startup-failure Telegram notification skipped: TELEGRAM_BOT_TOKEN not set in .env');
      return;
    }

    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      log.warn('Startup-failure Telegram notification failed', { status: res.status, body });
      return;
    }

    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (!data.ok) {
      log.warn('Startup-failure Telegram notification rejected', { description: data.description });
      return;
    }

    log.info('Startup-failure Telegram notification sent');
  } catch (err) {
    log.warn('Startup-failure Telegram notification threw', { err });
  }
}
