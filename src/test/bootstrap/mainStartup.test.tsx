import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const portableApiMocks = vi.hoisted(() => ({
  getPortableStatus: vi.fn(),
  getPortableInfo: vi.fn(),
  getLinuxWebviewProfile: vi.fn(),
  frontendReady: vi.fn(),
}));

const initializeSettingsMock = vi.hoisted(() => vi.fn());

const i18nState = vi.hoisted(() => ({
  ready: Promise.resolve() as Promise<unknown>,
  tImpl: vi.fn((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key),
}));

const successStatus = {
  isPortable: false,
  activation: 'disabled' as const,
  hostKind: 'executableDir' as const,
  status: 'disabled' as const,
  canLaunchApp: true,
  hasKeystore: false,
  isUnlocked: false,
  keystorePath: null,
  portableRootDir: '/mock/OxideTerm',
  markerPath: '/mock/OxideTerm/portable',
  configPath: '/mock/OxideTerm/portable.json',
  instanceLockPath: null,
  supportsBiometricBinding: false,
  hasBiometricBinding: false,
  canBiometricUnlock: false,
};

const successInfo = {
  isPortable: false,
  activation: 'disabled' as const,
  hostKind: 'executableDir' as const,
  exeDir: '/mock/OxideTerm',
  hostDir: '/mock/OxideTerm',
  markerPath: '/mock/OxideTerm/portable',
  configPath: '/mock/OxideTerm/portable.json',
  dataDir: '/mock/OxideTerm/data',
  instanceLockPath: '/mock/OxideTerm/data/.portable.lock',
};

const lockedPortableStatus = {
  isPortable: true,
  activation: 'marker' as const,
  hostKind: 'executableDir' as const,
  status: 'locked' as const,
  canLaunchApp: false,
  hasKeystore: true,
  isUnlocked: false,
  keystorePath: '/mock/OxideTerm/data/keystore.vault',
  portableRootDir: '/mock/OxideTerm',
  markerPath: '/mock/OxideTerm/portable',
  configPath: '/mock/OxideTerm/portable.json',
  instanceLockPath: '/mock/OxideTerm/data/.portable.lock',
  supportsBiometricBinding: false,
  hasBiometricBinding: false,
  canBiometricUnlock: false,
};

const portableInfo = {
  isPortable: true,
  activation: 'marker' as const,
  hostKind: 'executableDir' as const,
  exeDir: '/mock/OxideTerm',
  hostDir: '/mock/OxideTerm',
  markerPath: '/mock/OxideTerm/portable',
  configPath: '/mock/OxideTerm/portable.json',
  dataDir: '/mock/OxideTerm/data',
  instanceLockPath: '/mock/OxideTerm/data/.portable.lock',
};

function createHandledRejectedPromise(error: Error): Promise<unknown> {
  const promise = Promise.reject(error);
  void promise.catch(() => {});
  return promise;
}

async function importMainWithMocks() {
  vi.resetModules();

  vi.doMock('../../App', () => ({
    default: ({ portableStatus }: { portableStatus?: { canLaunchApp?: boolean } | null }) => (
      <div>APP READY {portableStatus?.canLaunchApp ? 'YES' : 'NO'}</div>
    ),
  }));

  vi.doMock('../../i18n', () => ({
    __esModule: true,
    default: {
      t: (key: string, options?: { defaultValue?: string }) => i18nState.tImpl(key, options),
    },
    i18nReady: i18nState.ready,
  }));

  vi.doMock('../../store/settingsStore', () => ({
    initializeSettings: initializeSettingsMock,
  }));

  vi.doMock('../../bootstrap/initKeybindings', () => ({}));
  vi.doMock('../../lib/faultInjection', () => ({}));

  vi.doMock('../../components/bootstrap/PortableBootstrapShell', () => ({
    PortableBootstrapShell: () => <div>PORTABLE SHELL</div>,
  }));

  vi.doMock('../../lib/api', () => ({
    api: {
      getPortableStatus: portableApiMocks.getPortableStatus,
      getPortableInfo: portableApiMocks.getPortableInfo,
      getLinuxWebviewProfile: portableApiMocks.getLinuxWebviewProfile,
      frontendReady: portableApiMocks.frontendReady,
    },
  }));

  vi.doMock('@/components/ui/button', () => ({
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
  }));

  await act(async () => {
    await import('../../main');
  });
}

describe('main startup bootstrap', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.clearAllMocks();
    initializeSettingsMock.mockReset();
    portableApiMocks.getPortableStatus.mockReset();
    portableApiMocks.getPortableInfo.mockReset();
    portableApiMocks.getLinuxWebviewProfile.mockReset();
    portableApiMocks.frontendReady.mockReset();
    initializeSettingsMock.mockResolvedValue(undefined);
    portableApiMocks.getLinuxWebviewProfile.mockResolvedValue(null);
    portableApiMocks.frontendReady.mockResolvedValue(undefined);
    i18nState.ready = Promise.resolve();
    i18nState.tImpl.mockReset();
    i18nState.tImpl.mockImplementation((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key);
  });

  it('still enters the main app when i18n initialization fails', async () => {
    i18nState.ready = createHandledRejectedPromise(new Error('i18n boot failed'));
    portableApiMocks.getPortableStatus.mockResolvedValue(successStatus);
    portableApiMocks.getPortableInfo.mockResolvedValue(successInfo);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await importMainWithMocks();

    await waitFor(() => {
      expect(screen.getByText('APP READY YES')).toBeInTheDocument();
    });

    expect(screen.queryByText('Portable startup failed')).not.toBeInTheDocument();
    expect(portableApiMocks.getPortableStatus).toHaveBeenCalledTimes(1);
    expect(portableApiMocks.getPortableInfo).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('shows the bootstrap error page and retries portable IPC successfully', async () => {
    i18nState.ready = Promise.resolve();
    portableApiMocks.getPortableStatus
      .mockRejectedValueOnce(new Error('portable down'))
      .mockResolvedValue(successStatus);
    portableApiMocks.getPortableInfo.mockResolvedValue(successInfo);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await importMainWithMocks();

    await waitFor(() => {
      expect(screen.getByText('Portable startup failed')).toBeInTheDocument();
      expect(screen.getByText('portable down')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByText('APP READY YES')).toBeInTheDocument();
    });

    expect(portableApiMocks.getPortableStatus).toHaveBeenCalledTimes(2);
    expect(portableApiMocks.getPortableInfo).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('enters PortableBootstrapShell when portable mode is active and app launch is gated', async () => {
    i18nState.ready = Promise.resolve();
    portableApiMocks.getPortableStatus.mockResolvedValue(lockedPortableStatus);
    portableApiMocks.getPortableInfo.mockResolvedValue(portableInfo);

    await importMainWithMocks();

    await waitFor(() => {
      expect(screen.getByText('PORTABLE SHELL')).toBeInTheDocument();
    });

    expect(screen.queryByText('APP READY YES')).not.toBeInTheDocument();
    expect(screen.queryByText('Portable startup failed')).not.toBeInTheDocument();
    expect(portableApiMocks.getPortableStatus).toHaveBeenCalledTimes(1);
    expect(portableApiMocks.getPortableInfo).toHaveBeenCalledTimes(1);
  });
});
