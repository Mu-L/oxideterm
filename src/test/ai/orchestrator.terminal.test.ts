import { describe, expect, it, vi } from 'vitest';
import type { AiTarget } from '@/lib/ai/orchestrator';

const nodeIdeExecCommandMock = vi.hoisted(() => vi.fn());
const localExecCommandMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  nodeIdeExecCommand: nodeIdeExecCommandMock,
  api: {
    localExecCommand: localExecCommandMock,
  },
}));

vi.mock('@/lib/terminalRegistry', () => ({
  findPaneBySessionId: vi.fn(),
  getTerminalBuffer: vi.fn(),
  readScreen: vi.fn(),
  subscribeTerminalOutput: vi.fn(),
  waitForTerminalReady: vi.fn(),
  writeToTerminal: vi.fn(),
}));

import { runCommandOnTarget } from '@/lib/ai/capabilities/terminal';

const sshTarget: AiTarget = {
  id: 'ssh-node:node-1',
  kind: 'ssh-node',
  label: 'node-1',
  state: 'connected',
  capabilities: ['command.run'],
  refs: { nodeId: 'node-1' },
};

const localTarget: AiTarget = {
  id: 'local-shell:default',
  kind: 'local-shell',
  label: 'Local shell',
  state: 'available',
  capabilities: ['command.run'],
  refs: {},
};

describe('orchestrator terminal command execution', () => {
  it('rejects ssh-node command execution because remote commands must be visible', async () => {
    const result = await runCommandOnTarget({ target: sshTarget, command: 'ls -la' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'visible_terminal_required',
      recoverable: true,
    });
    expect(nodeIdeExecCommandMock).not.toHaveBeenCalled();
    expect(result.nextActions?.[0]).toMatchObject({ action: 'list_targets' });
  });

  it('treats local null exit code with captured output as successful when not timed out', async () => {
    localExecCommandMock.mockResolvedValueOnce({
      stdout: 'hello\n',
      stderr: '',
      exitCode: null,
      timedOut: false,
    });

    const result = await runCommandOnTarget({ target: localTarget, command: 'echo hello' });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.observations?.[0]).toContain('did not report an exit code');
  });
});
