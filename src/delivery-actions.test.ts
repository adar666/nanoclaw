/**
 * Delivery action registry.
 *
 * `registerDeliveryAction` is the hook modules use to handle system-kind
 * outbound messages; `getDeliveryAction` is the read side that makes those
 * registrations behavior-testable. Goes red if either half of the registry
 * is removed or the two stop sharing the same map. Every registration now
 * carries a guard spec or an explicit unguarded(<reason>) declaration —
 * omission is a type error.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import {
  registerDeliveryAction,
  getDeliveryAction,
  reenterGuardedDeliveryAction,
  type DeliveryActionHandler,
} from './delivery.js';
import { defineGuardedAction, ALLOW, HOLD, unguarded } from './guard/index.js';
import type { PendingApproval, Session } from './types.js';

const testUnguarded = unguarded('test — registry mechanics only');

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
}

function fakeApproval(): PendingApproval {
  return {
    approval_id: 'appr-test',
    session_id: 'sess-test',
    request_id: 'req-test',
    action: 'test_reenter_action',
    payload: '{}',
    created_at: new Date().toISOString(),
    agent_group_id: 'ag-test',
    channel_type: null,
    platform_id: null,
    platform_message_id: null,
    expires_at: null,
    status: 'approved',
    title: 't',
    options_json: '[]',
    approver_user_id: null,
  };
}

describe('delivery action registry', () => {
  it('getDeliveryAction returns the handler registerDeliveryAction registered', () => {
    const handler: DeliveryActionHandler = async () => {};
    registerDeliveryAction('test_registry_action', handler, testUnguarded);
    expect(getDeliveryAction('test_registry_action')).toBe(handler);
  });

  it('getDeliveryAction returns undefined for unregistered actions', () => {
    expect(getDeliveryAction('test_never_registered_action')).toBeUndefined();
  });

  it('re-registering an action overwrites the previous handler', () => {
    const first: DeliveryActionHandler = async () => {};
    const second: DeliveryActionHandler = async () => {};
    registerDeliveryAction('test_overwrite_action', first, testUnguarded);
    registerDeliveryAction('test_overwrite_action', second, testUnguarded);
    expect(getDeliveryAction('test_overwrite_action')).toBe(second);
  });

  it('refuses to replace a guard-wrapped action with an unguarded handler', () => {
    const guardAction = defineGuardedAction({
      action: 'test.guarded-overwrite',
      decide: () => HOLD('t'),
    });
    registerDeliveryAction('test_guarded_overwrite', async () => {}, {
      guardAction,
      requestHold: async () => {},
    });

    // Disarming the guard by re-registering unguarded must throw — otherwise
    // the action's catalog entry would still exist while the live path runs
    // unguarded.
    expect(() => registerDeliveryAction('test_guarded_overwrite', async () => {}, testUnguarded)).toThrow(
      /disarm the guard/,
    );

    // Re-registering WITH a spec stays allowed (a legitimate replacement
    // keeps the action guarded).
    registerDeliveryAction('test_guarded_overwrite', async () => {}, {
      guardAction,
      requestHold: async () => {},
    });
    expect(getDeliveryAction('test_guarded_overwrite')).toBeDefined();
  });

  // epic retro action item: `reenterGuardedDeliveryAction`'s ctx used to
  // drop `userId` — the admin who actually clicked approve
  // (ApprovalHandlerContext.userId, already resolved by response-handler.ts
  // before this callback ever runs) — on the floor before it ever reached
  // the handler body. Confirms it now threads through end to end.
  it('reenterGuardedDeliveryAction threads the approving userId through to the handler', async () => {
    const guardAction = defineGuardedAction({
      action: 'test.reenter-userid',
      decide: () => ALLOW('grant satisfies the hold'),
    });
    let receivedApproverUserId: string | undefined;
    registerDeliveryAction(
      'test_reenter_action',
      async (_content, _session, approverUserId) => {
        receivedApproverUserId = approverUserId;
      },
      { guardAction, requestHold: async () => {} },
    );

    const reenter = reenterGuardedDeliveryAction('test_reenter_action');
    await reenter({ session: fakeSession(), payload: {}, approval: fakeApproval(), userId: 'telegram:dana' });

    expect(receivedApproverUserId).toBe('telegram:dana');
  });

  it('reenterGuardedDeliveryAction normalizes an empty-string userId to undefined, never a falsy-but-present value', async () => {
    const guardAction = defineGuardedAction({
      action: 'test.reenter-empty-userid',
      decide: () => ALLOW('grant satisfies the hold'),
    });
    let receivedApproverUserId: string | undefined = 'unset';
    registerDeliveryAction(
      'test_reenter_empty_action',
      async (_content, _session, approverUserId) => {
        receivedApproverUserId = approverUserId;
      },
      { guardAction, requestHold: async () => {} },
    );

    const reenter = reenterGuardedDeliveryAction('test_reenter_empty_action');
    await reenter({ session: fakeSession(), payload: {}, approval: fakeApproval(), userId: '' });

    expect(receivedApproverUserId).toBeUndefined();
  });
});
