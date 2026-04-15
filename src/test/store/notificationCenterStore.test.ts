import { beforeEach, describe, expect, it } from 'vitest';
import {
  useNotificationCenterStore,
  type NotificationPush,
} from '@/store/notificationCenterStore';
import { resolveConnectionNotifications } from '@/lib/notificationCenter';

function getStore() {
  return useNotificationCenterStore.getState();
}

function resetNotificationCenterStore() {
  useNotificationCenterStore.setState({
    items: [],
    filter: { status: 'all', severity: 'all', kind: 'all' },
    unreadCount: 0,
    unreadCriticalCount: 0,
  });
}

function makeNotification(overrides: Partial<NotificationPush> = {}): NotificationPush {
  return {
    kind: 'connection',
    severity: 'info',
    title: 'Connection notice',
    body: 'Connection updated',
    source: { type: 'system' },
    scope: { type: 'global' },
    ...overrides,
  };
}

describe('notificationCenterStore', () => {
  beforeEach(() => {
    resetNotificationCenterStore();
  });

  it('adds a notification as unread and tracks counts', () => {
    getStore().push(makeNotification());

    expect(getStore().items).toHaveLength(1);
    expect(getStore().items[0].status).toBe('unread');
    expect(getStore().unreadCount).toBe(1);
    expect(getStore().unreadCriticalCount).toBe(0);
  });

  it('dedupes by key and refreshes the existing item instead of appending', () => {
    getStore().push(makeNotification({
      dedupeKey: 'connection:node-1',
      title: 'Initial title',
      body: 'Initial body',
      createdAtMs: 100,
    }));

    getStore().push(makeNotification({
      dedupeKey: 'connection:node-1',
      kind: 'security',
      severity: 'error',
      title: 'Updated title',
      body: 'Updated body',
      createdAtMs: 200,
      source: { type: 'agent' },
      scope: { type: 'node', nodeId: 'node-1' },
    }));

    expect(getStore().items).toHaveLength(1);
    expect(getStore().items[0]).toMatchObject({
      kind: 'security',
      severity: 'error',
      title: 'Updated title',
      body: 'Updated body',
      createdAtMs: 200,
      source: { type: 'agent' },
      scope: { type: 'node', nodeId: 'node-1' },
      status: 'unread',
    });
    expect(getStore().unreadCount).toBe(1);
    expect(getStore().unreadCriticalCount).toBe(1);
  });

  it('marks a deduped notification unread again by default when the same issue reoccurs', () => {
    getStore().push(makeNotification({
      dedupeKey: 'connection:node-2',
      severity: 'warning',
      title: 'Transient issue',
    }));

    const firstId = getStore().items[0].id;
    getStore().markRead(firstId);

    expect(getStore().items[0].status).toBe('read');
    expect(getStore().unreadCount).toBe(0);

    getStore().push(makeNotification({
      dedupeKey: 'connection:node-2',
      severity: 'warning',
      title: 'Transient issue happened again',
      createdAtMs: 300,
    }));

    expect(getStore().items).toHaveLength(1);
    expect(getStore().items[0].id).toBe(firstId);
    expect(getStore().items[0].title).toBe('Transient issue happened again');
    expect(getStore().items[0].status).toBe('unread');
    expect(getStore().unreadCount).toBe(1);
  });

  it('preserves read state on dedupe when preserveReadStatusOnDedupe is enabled', () => {
    getStore().push(makeNotification({
      dedupeKey: 'update:v1.2.3',
      kind: 'update',
      title: 'New version available',
    }));

    const notificationId = getStore().items[0].id;
    getStore().markRead(notificationId);

    getStore().push(makeNotification({
      dedupeKey: 'update:v1.2.3',
      kind: 'update',
      title: 'New version available',
      body: 'v1.2.3',
      preserveReadStatusOnDedupe: true,
      createdAtMs: 400,
    }));

    expect(getStore().items).toHaveLength(1);
    expect(getStore().items[0]).toMatchObject({
      id: notificationId,
      status: 'read',
      body: 'v1.2.3',
      createdAtMs: 400,
    });
    expect(getStore().unreadCount).toBe(0);
  });

  it('dismisses all notifications scoped to a specific node (auto-resolve)', () => {
    getStore().push(makeNotification({
      title: 'Node A failure',
      scope: { type: 'node', nodeId: 'node-a' },
    }));
    getStore().push(makeNotification({
      title: 'Node B failure',
      scope: { type: 'node', nodeId: 'node-b' },
    }));
    getStore().push(makeNotification({
      title: 'Global notice',
      scope: { type: 'global' },
    }));

    expect(getStore().items).toHaveLength(3);

    getStore().dismissByScope({ type: 'node', nodeId: 'node-a' });

    expect(getStore().items).toHaveLength(2);
    expect(getStore().items.find((n) => n.title === 'Node A failure')).toBeUndefined();
    expect(getStore().items.find((n) => n.title === 'Node B failure')).toBeDefined();
    expect(getStore().items.find((n) => n.title === 'Global notice')).toBeDefined();
  });

  it('dismisses by dedupeKey prefix', () => {
    getStore().push(makeNotification({
      title: 'Chain failed 1',
      dedupeKey: 'connect-chain-failed:node-1',
    }));
    getStore().push(makeNotification({
      title: 'Chain failed 2',
      dedupeKey: 'connect-chain-failed:node-2',
    }));
    getStore().push(makeNotification({
      title: 'Update error',
      dedupeKey: 'update-error:v1.0.0',
    }));

    getStore().dismissByDedupePrefix('connect-chain-failed:');

    expect(getStore().items).toHaveLength(1);
    expect(getStore().items[0].title).toBe('Update error');
  });

  it('dismisses a specific set of notification ids without touching siblings', () => {
    getStore().push(makeNotification({
      id: 'n-1',
      title: 'Keep me',
      scope: { type: 'node', nodeId: 'node-a' },
    }));
    getStore().push(makeNotification({
      id: 'n-2',
      title: 'Dismiss me 1',
      scope: { type: 'node', nodeId: 'node-a' },
    }));
    getStore().push(makeNotification({
      id: 'n-3',
      title: 'Dismiss me 2',
      scope: { type: 'global' },
    }));

    getStore().dismissByIds(['n-2', 'n-3']);

    expect(getStore().items).toHaveLength(1);
    expect(getStore().items[0].id).toBe('n-1');
  });

  it('resolves only connection and security notifications for a node', () => {
    getStore().push(makeNotification({
      id: 'conn-1',
      kind: 'connection',
      title: 'Connection failed',
      scope: { type: 'node', nodeId: 'node-a' },
    }));
    getStore().push(makeNotification({
      id: 'sec-1',
      kind: 'security',
      title: 'Host key changed',
      scope: { type: 'node', nodeId: 'node-a' },
    }));
    getStore().push(makeNotification({
      id: 'health-1',
      kind: 'health',
      title: 'Health warning',
      scope: { type: 'node', nodeId: 'node-a' },
    }));
    getStore().push(makeNotification({
      id: 'conn-2',
      kind: 'connection',
      title: 'Other node failure',
      scope: { type: 'node', nodeId: 'node-b' },
    }));

    resolveConnectionNotifications('node-a');

    expect(getStore().items.map((item) => item.id)).toEqual(['health-1', 'conn-2']);
  });

  it('stores and preserves action handlers on notifications', () => {
    const handler = () => {};
    getStore().push(makeNotification({
      title: 'Retry me',
      actions: [
        { id: 'retry', label: 'Retry', variant: 'primary', handler },
      ],
    }));

    expect(getStore().items[0].actions).toHaveLength(1);
    expect(getStore().items[0].actions[0]).toMatchObject({
      id: 'retry',
      label: 'Retry',
      variant: 'primary',
    });
    expect(getStore().items[0].actions[0].handler).toBe(handler);
  });
});