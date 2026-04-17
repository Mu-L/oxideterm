import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMutableSelectorStore } from '@/test/helpers/mockStore';

const apiMocks = vi.hoisted(() => ({
  getGroups: vi.fn().mockResolvedValue([]),
  isAgentAvailable: vi.fn().mockResolvedValue(true),
  sshPreflight: vi.fn(),
  sshRemoveHostKey: vi.fn().mockResolvedValue(undefined),
  testConnection: vi.fn(),
}));

const appStoreState = vi.hoisted(() => ({
  modals: { newConnection: true },
  toggleModal: vi.fn(),
  createTab: vi.fn(),
  quickConnectData: null as null | { host: string; port: number; username: string },
}));

const sessionTreeState = vi.hoisted(() => ({
  addRootNode: vi.fn(),
  connectNode: vi.fn(),
  createTerminalForNode: vi.fn(),
}));

const toastState = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

const settingsStoreMock = vi.hoisted(() => ({
  getState: vi.fn(() => ({
    settings: {
      terminal: {
        scrollback: 3500,
      },
    },
  })),
}));

vi.mock('@/lib/api', () => ({ api: apiMocks }));
vi.mock('@/store/appStore', () => ({
  useAppStore: createMutableSelectorStore(appStoreState),
}));
vi.mock('@/store/sessionTreeStore', () => ({
  useSessionTreeStore: createMutableSelectorStore(sessionTreeState),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: settingsStoreMock,
  deriveBackendHotLines: (scrollback: number) => Math.min(12000, Math.max(5000, scrollback * 2)),
}));
vi.mock('@/hooks/useToast', () => ({
  useToast: () => toastState,
}));
vi.mock('@/components/modals/AddJumpServerDialog', () => ({
  AddJumpServerDialog: () => null,
}));
vi.mock('@/components/modals/HostKeyConfirmDialog', () => ({
  HostKeyConfirmDialog: ({
    open,
    status,
    onAccept,
    onRemoveSavedKey,
  }: {
    open: boolean;
    status: { status: string } | null;
    onAccept?: (persist: boolean) => void;
    onRemoveSavedKey?: () => void;
  }) => (
    open ? <div>
      <div data-testid="host-key-dialog-state">{status?.status}</div>
      {status?.status === 'changed' ? <button onClick={onRemoveSavedKey}>remove-saved-key</button> : null}
      {status?.status === 'unknown' ? <button onClick={() => onAccept?.(true)}>accept-host-key</button> : null}
    </div> : null
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { NewConnectionModal } from '@/components/modals/NewConnectionModal';

describe('NewConnectionModal host key flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appStoreState.modals.newConnection = true;
    appStoreState.quickConnectData = null;
    apiMocks.getGroups.mockResolvedValue([]);
    apiMocks.isAgentAvailable.mockResolvedValue(true);
  });

  it('keeps the dialog visible if removing a changed key is followed by a preflight error', async () => {
    apiMocks.sshPreflight
      .mockResolvedValueOnce({
        status: 'changed',
        expectedFingerprint: 'SHA256:old',
        actualFingerprint: 'SHA256:new',
        keyType: 'ssh-ed25519',
      })
      .mockResolvedValueOnce({
        status: 'error',
        message: 'network down',
      });

    await act(async () => {
      render(<NewConnectionModal />);
    });

    fireEvent.change(screen.getByLabelText('modals.new_connection.target_host *'), {
      target: { value: 'server.example.com' },
    });
    fireEvent.change(screen.getByLabelText('modals.new_connection.target_username *'), {
      target: { value: 'alice' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'modals.new_connection.test' }));

    await waitFor(() => {
      expect(screen.getByTestId('host-key-dialog-state')).toHaveTextContent('changed');
    });

    fireEvent.click(screen.getByText('remove-saved-key'));

    await waitFor(() => {
      expect(apiMocks.sshRemoveHostKey).toHaveBeenCalledWith({
        host: 'server.example.com',
        port: 22,
        keyType: 'ssh-ed25519',
        expectedFingerprint: 'SHA256:old',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('host-key-dialog-state')).toHaveTextContent('error');
    });
  });

  it('shows the host key dialog for an unknown host and continues testing after accept', async () => {
    apiMocks.sshPreflight.mockResolvedValueOnce({
      status: 'unknown',
      fingerprint: 'SHA256:new',
      keyType: 'ssh-ed25519',
    });
    apiMocks.testConnection.mockResolvedValue({
      success: true,
      latency_ms: 42,
      endpoint: { host: 'server.example.com', port: 22 },
      diagnostics: [],
    });

    await act(async () => {
      render(<NewConnectionModal />);
    });

    fireEvent.change(screen.getByLabelText('modals.new_connection.target_host *'), {
      target: { value: 'server.example.com' },
    });
    fireEvent.change(screen.getByLabelText('modals.new_connection.target_username *'), {
      target: { value: 'alice' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'modals.new_connection.test' }));

    await waitFor(() => {
      expect(screen.getByTestId('host-key-dialog-state')).toHaveTextContent('unknown');
    });

    fireEvent.click(screen.getByText('accept-host-key'));

    await waitFor(() => {
      expect(apiMocks.testConnection).toHaveBeenCalledWith(expect.objectContaining({
        host: 'server.example.com',
        port: 22,
        username: 'alice',
        auth_type: 'password',
        password: '',
        trust_host_key: true,
        expected_host_key_fingerprint: 'SHA256:new',
      }));
    });
  });

  it('can continue from changed to unknown and then run the test with the new fingerprint', async () => {
    apiMocks.sshPreflight
      .mockResolvedValueOnce({
        status: 'changed',
        expectedFingerprint: 'SHA256:old',
        actualFingerprint: 'SHA256:new',
        keyType: 'ssh-ed25519',
      })
      .mockResolvedValueOnce({
        status: 'unknown',
        fingerprint: 'SHA256:new',
        keyType: 'ssh-ed25519',
      });
    apiMocks.testConnection.mockResolvedValue({
      success: true,
      latency_ms: 42,
      endpoint: { host: 'server.example.com', port: 22 },
      diagnostics: [],
    });

    await act(async () => {
      render(<NewConnectionModal />);
    });

    fireEvent.change(screen.getByLabelText('modals.new_connection.target_host *'), {
      target: { value: 'server.example.com' },
    });
    fireEvent.change(screen.getByLabelText('modals.new_connection.target_username *'), {
      target: { value: 'alice' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'modals.new_connection.test' }));

    await waitFor(() => {
      expect(screen.getByTestId('host-key-dialog-state')).toHaveTextContent('changed');
    });

    fireEvent.click(screen.getByText('remove-saved-key'));

    await waitFor(() => {
      expect(screen.getByText('accept-host-key')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('accept-host-key'));

    await waitFor(() => {
      expect(apiMocks.testConnection).toHaveBeenCalledWith(expect.objectContaining({
        host: 'server.example.com',
        port: 22,
        username: 'alice',
        auth_type: 'password',
        password: '',
        trust_host_key: true,
        expected_host_key_fingerprint: 'SHA256:new',
      }));
    });
  });
});