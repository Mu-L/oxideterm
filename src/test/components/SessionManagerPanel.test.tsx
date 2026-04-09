import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMutableSelectorStore } from '@/test/helpers/mockStore';

const connectToSavedMock = vi.hoisted(() => vi.fn());

const sessionManagerState = vi.hoisted(() => ({
  connections: [{
    id: 'conn-1',
    name: 'Test Conn',
    group: null,
    host: 'example.com',
    port: 22,
    username: 'tester',
    auth_type: 'password',
    key_path: null,
    cert_path: null,
    created_at: '2026-01-01T00:00:00Z',
    last_used_at: null,
    color: null,
    tags: [],
    proxy_chain: [],
  }],
  allConnections: [{
    id: 'conn-1',
    name: 'Test Conn',
    group: null,
    host: 'example.com',
    port: 22,
    username: 'tester',
    auth_type: 'password',
    key_path: null,
    cert_path: null,
    created_at: '2026-01-01T00:00:00Z',
    last_used_at: null,
    color: null,
    tags: [],
    proxy_chain: [],
  }],
  groups: [],
  loading: false,
  folderTree: [],
  ungroupedCount: 1,
  selectedGroup: null as string | null,
  setSelectedGroup: vi.fn(),
  expandedGroups: new Set<string>(),
  toggleExpand: vi.fn(),
  searchQuery: '',
  setSearchQuery: vi.fn(),
  sortField: 'last_used_at',
  sortDirection: 'desc' as const,
  toggleSort: vi.fn(),
  selectedIds: new Set<string>(),
  toggleSelect: vi.fn(),
  toggleSelectAll: vi.fn(),
  clearSelection: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
}));

const appStoreState = vi.hoisted(() => ({
  createTab: vi.fn(),
}));

vi.mock('@/components/sessionManager/useSessionManager', () => ({
  useSessionManager: () => sessionManagerState,
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/hooks/useConfirm', () => ({
  useConfirm: () => ({
    confirm: vi.fn().mockResolvedValue(true),
    ConfirmDialog: null,
  }),
}));

vi.mock('@/hooks/useTabBackground', () => ({
  useTabBgActive: () => false,
}));

vi.mock('@/store/appStore', () => ({
  useAppStore: createMutableSelectorStore(appStoreState),
}));

vi.mock('@/lib/connectToSaved', () => ({
  connectToSaved: connectToSavedMock,
}));

vi.mock('@/components/sessionManager/FolderTree', () => ({
  FolderTree: () => <div>folder-tree</div>,
}));

vi.mock('@/components/sessionManager/ManagerToolbar', () => ({
  ManagerToolbar: () => <div>toolbar</div>,
}));

vi.mock('@/components/sessionManager/ConnectionTable', () => ({
  ConnectionTable: ({ onConnect, onDelete, connections }: { onConnect: (id: string) => void; onDelete: (conn: { id: string; name: string }) => void; connections: Array<{ id: string; name: string }> }) => (
    <>
      <button onClick={() => onConnect('conn-1')}>connect-row</button>
      <button onClick={() => onDelete(connections[0])}>delete-row</button>
    </>
  ),
}));

vi.mock('@/components/modals/EditConnectionModal', () => ({
  EditConnectionModal: ({ open, connection }: { open: boolean; connection: { id: string } | null }) => (
    open ? <div data-testid="connect-modal">{connection?.id}</div> : null
  ),
}));

vi.mock('@/components/modals/EditConnectionPropertiesModal', () => ({
  EditConnectionPropertiesModal: ({ open, connection }: { open: boolean; connection: { id: string } | null }) => (
    open ? <div data-testid="properties-modal">{connection?.id}</div> : null
  ),
}));

vi.mock('@/components/modals/OxideExportModal', () => ({
  OxideExportModal: () => null,
}));

vi.mock('@/components/modals/OxideImportModal', () => ({
  OxideImportModal: () => null,
}));

vi.mock('@/lib/api', () => ({
  api: {
    saveConnection: vi.fn(),
    deleteConnection: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { SessionManagerPanel } from '@/components/sessionManager/SessionManagerPanel';
import { api } from '@/lib/api';

describe('SessionManagerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the connect password modal instead of the properties modal for missing-password failures', async () => {
    connectToSavedMock.mockImplementation(async (_id: string, options: { onError?: (id: string, reason?: 'missing-password' | 'connect-failed') => void }) => {
      options.onError?.('conn-1', 'missing-password');
    });

    render(<SessionManagerPanel />);
    fireEvent.click(screen.getByText('connect-row'));

    await waitFor(() => {
      expect(screen.getByTestId('connect-modal')).toHaveTextContent('conn-1');
    });
    expect(screen.queryByTestId('properties-modal')).toBeNull();
  });

  it('broadcasts saved connection changes after deleting a connection', async () => {
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

    render(<SessionManagerPanel />);
    fireEvent.click(screen.getByText('delete-row'));

    await waitFor(() => {
      expect(api.deleteConnection).toHaveBeenCalledWith('conn-1');
      expect(sessionManagerState.refresh).toHaveBeenCalled();
      expect(dispatchEventSpy).toHaveBeenCalled();
    });
  });
});