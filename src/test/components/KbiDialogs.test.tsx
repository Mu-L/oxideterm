import { act, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { GlobalKbiDialog } from '@/components/modals/GlobalKbiDialog';

type TauriEvent<T> = {
  payload: T;
};

type EventCallback<T = unknown> = (event: TauriEvent<T>) => void;

const eventListeners = new Map<string, EventCallback[]>();

function emitTauriEvent<T>(eventName: string, payload: T) {
  act(() => {
    for (const callback of eventListeners.get(eventName) ?? []) {
      callback({ payload });
    }
  });
}

describe('GlobalKbiDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventListeners.clear();

    vi.mocked(invoke).mockResolvedValue(undefined as never);
    vi.mocked(listen).mockImplementation(((eventName: string, callback: EventCallback) => {
      const listeners = eventListeners.get(eventName) ?? [];
      listeners.push(callback);
      eventListeners.set(eventName, listeners);

      return Promise.resolve(() => {
        const current = eventListeners.get(eventName) ?? [];
        eventListeners.set(
          eventName,
          current.filter((entry) => entry !== callback),
        );
      });
    }) as typeof listen);
  });

  it('GlobalKbiDialog handles standalone prompts and closes on matching success', async () => {
    render(<GlobalKbiDialog />);

    await waitFor(() => {
      expect(listen).toHaveBeenCalledTimes(2);
    });

    emitTauriEvent('ssh_kbi_prompt', {
      authFlowId: 'standalone-a',
      name: 'OTP',
      instructions: 'Enter standalone code A',
      prompts: [{ prompt: 'Standalone prompt A', echo: false }],
      chained: false,
    });

    expect(await screen.findByLabelText('Standalone prompt A')).toBeInTheDocument();

    emitTauriEvent('ssh_kbi_result', {
      authFlowId: 'standalone-a',
      success: true,
    });

    await waitFor(() => {
      expect(screen.queryByLabelText('Standalone prompt A')).not.toBeInTheDocument();
    });
  });

  it('cancels overlapping prompt flows and keeps the active one mounted', async () => {
    render(<GlobalKbiDialog />);

    await waitFor(() => {
      expect(listen).toHaveBeenCalledTimes(2);
    });

    emitTauriEvent('ssh_kbi_prompt', {
      authFlowId: 'flow-a',
      name: 'OTP',
      instructions: 'Enter code A',
      prompts: [{ prompt: 'Prompt A', echo: false }],
      chained: false,
    });

    expect(await screen.findByLabelText('Prompt A')).toBeInTheDocument();
    vi.mocked(invoke).mockClear();

    emitTauriEvent('ssh_kbi_prompt', {
      authFlowId: 'flow-b',
      name: 'OTP',
      instructions: 'Enter code B',
      prompts: [{ prompt: 'Prompt B', echo: false }],
      chained: true,
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith('ssh_kbi_cancel', {
        request: { authFlowId: 'flow-b' },
      });
    });

    expect(screen.getByLabelText('Prompt A')).toBeInTheDocument();
    expect(screen.queryByLabelText('Prompt B')).not.toBeInTheDocument();
  });

  it('accepts a new flow after the previous one fails', async () => {
    render(<GlobalKbiDialog />);

    await waitFor(() => {
      expect(listen).toHaveBeenCalledTimes(2);
    });

    emitTauriEvent('ssh_kbi_prompt', {
      authFlowId: 'failed-flow',
      name: 'OTP',
      instructions: 'Enter old code',
      prompts: [{ prompt: 'Old prompt', echo: false }],
      chained: false,
    });

    expect(await screen.findByLabelText('Old prompt')).toBeInTheDocument();

    emitTauriEvent('ssh_kbi_result', {
      authFlowId: 'failed-flow',
      success: false,
      error: 'Authentication failed',
    });

    expect(await screen.findByText('Authentication failed')).toBeInTheDocument();
    vi.mocked(invoke).mockClear();

    emitTauriEvent('ssh_kbi_prompt', {
      authFlowId: 'retry-flow',
      name: 'OTP',
      instructions: 'Enter retry code',
      prompts: [{ prompt: 'Retry prompt', echo: false }],
      chained: true,
    });

    expect(await screen.findByLabelText('Retry prompt')).toBeInTheDocument();
    expect(screen.queryByText('Authentication failed')).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});