import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsPanel } from '@/components/layout/NotificationsPanel';
import { useNotificationCenterStore } from '@/store/notificationCenterStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function resetNotificationCenterStore() {
  useNotificationCenterStore.setState({
    items: [],
    filter: { status: 'all', severity: 'all', kind: 'all' },
    dndEnabled: false,
    unreadCount: 0,
    unreadCriticalCount: 0,
  });
}

function seedNotifications() {
  const store = useNotificationCenterStore.getState();
  store.push({
    id: 'n-1',
    createdAtMs: Date.now() - 5_000,
    kind: 'connection',
    severity: 'warning',
    title: 'First unread',
    body: 'Connection unstable',
    source: { type: 'system' },
    scope: { type: 'node', nodeId: 'node-a' },
  });
  store.push({
    id: 'n-2',
    createdAtMs: Date.now() - 3_000,
    kind: 'connection',
    severity: 'error',
    title: 'Second unread',
    body: 'Connection failed',
    source: { type: 'system' },
    scope: { type: 'node', nodeId: 'node-a' },
    actions: [{ id: 'retry', label: 'Retry', variant: 'primary', handler: vi.fn() }],
  });
  store.push({
    id: 'n-3',
    createdAtMs: Date.now() - 1_000,
    kind: 'update',
    severity: 'info',
    title: 'Update available',
    body: 'v2.0.0',
    source: { type: 'system' },
    scope: { type: 'global' },
  });
  store.markRead('n-3');
}

describe('NotificationsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNotificationCenterStore();
  });

  it('marks a single unread notification as read when the row is clicked', async () => {
    seedNotifications();

    render(<NotificationsPanel />);

    fireEvent.click(screen.getByText('First unread'));

    await waitFor(() => {
      expect(useNotificationCenterStore.getState().items.find((item) => item.id === 'n-1')?.status).toBe('read');
      expect(useNotificationCenterStore.getState().unreadCount).toBe(1);
    });
  });

  it('marks all unread notifications as read from the toolbar action', async () => {
    seedNotifications();

    render(<NotificationsPanel />);

    fireEvent.click(screen.getByText('notifications.actions.mark_all_read'));

    await waitFor(() => {
      expect(useNotificationCenterStore.getState().unreadCount).toBe(0);
      expect(
        useNotificationCenterStore.getState().items.every((item) => item.status !== 'unread'),
      ).toBe(true);
    });
  });

  it('hides the mark-all-read action when no unread notifications remain', async () => {
    seedNotifications();

    render(<NotificationsPanel />);

    expect(screen.getByText('notifications.actions.mark_all_read')).toBeInTheDocument();
    fireEvent.click(screen.getByText('notifications.actions.mark_all_read'));

    await waitFor(() => {
      expect(screen.queryByText('notifications.actions.mark_all_read')).not.toBeInTheDocument();
    });
  });

  it('renders inline action buttons and calls handler on click', async () => {
    seedNotifications();

    render(<NotificationsPanel />);

    const retryButton = screen.getByText('Retry');
    expect(retryButton).toBeInTheDocument();

    fireEvent.click(retryButton);

    // The handler was called (from seeded n-2)
    const n2 = useNotificationCenterStore.getState().items.find((item) => item.id === 'n-2');
    expect(n2?.actions[0]?.handler).toHaveBeenCalledTimes(1);
  });

  it('groups notifications from the same node and shows group header for multi-item groups', async () => {
    seedNotifications();

    render(<NotificationsPanel />);

    // node-a has 2 notifications — should show group header with nodeId
    expect(screen.getByText('node-a')).toBeInTheDocument();

    // Both items should be visible (group expanded by default)
    expect(screen.getByText('First unread')).toBeInTheDocument();
    expect(screen.getByText('Second unread')).toBeInTheDocument();

    // Single-item group (update) renders inline without group header
    expect(screen.getByText('Update available')).toBeInTheDocument();
  });

  it('toggles do not disturb from the toolbar', async () => {
    seedNotifications();
    useNotificationCenterStore.getState().setDndEnabled(true);

    render(<NotificationsPanel />);

    fireEvent.click(screen.getByLabelText('notifications.dnd.disable'));

    await waitFor(() => {
      expect(useNotificationCenterStore.getState().dndEnabled).toBe(false);
      expect(screen.queryByText('notifications.dnd.on')).not.toBeInTheDocument();
    });
  });
});