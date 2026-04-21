import { describe, expect, it, vi } from 'vitest';

import { encodeTerminalExecuteInput, encodeTerminalTextInput } from '@/lib/terminalInput';
import { createRemoteTerminalTransport } from '@/lib/terminal/trzsz/transport';
import { encodeDataFrame, encodeResizeFrame } from '@/lib/wireProtocol';

function createWebSocketMock() {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  } as unknown as WebSocket;
}

describe('createRemoteTerminalTransport', () => {
  it('sends raw input and binary input as data frames', () => {
    const ws = createWebSocketMock();
    const transport = createRemoteTerminalTransport({
      getWebSocket: () => ws,
      isInputLocked: () => false,
    });

    const rawResult = transport.sendRawInput('ls -la');
    const binaryResult = transport.sendBinaryInput('\u001bOA');

    expect(rawResult).toBe(true);
    expect(binaryResult).toBe(true);
    expect(vi.mocked(ws.send).mock.calls).toEqual([
      [encodeDataFrame(new TextEncoder().encode('ls -la'))],
      [encodeDataFrame(new Uint8Array([0x1b, 0x4f, 0x41]))],
    ]);
  });

  it('uses terminal formatting helpers for text and execute input', () => {
    const ws = createWebSocketMock();
    const transport = createRemoteTerminalTransport({
      getWebSocket: () => ws,
      isInputLocked: () => false,
    });

    transport.sendTextInput('git status\r\ngit diff');
    transport.sendExecuteInput('npm test');

    expect(vi.mocked(ws.send).mock.calls).toEqual([
      [encodeDataFrame(encodeTerminalTextInput('git status\r\ngit diff'))],
      [encodeDataFrame(encodeTerminalExecuteInput('npm test'))],
    ]);
  });

  it('blocks input and resize while the terminal is gated', () => {
    const ws = createWebSocketMock();
    const transport = createRemoteTerminalTransport({
      getWebSocket: () => ws,
      isInputLocked: () => true,
    });

    expect(transport.canSendInput()).toBe(false);
    expect(transport.sendRawInput('pwd')).toBe(false);
    expect(transport.sendResize(120, 32)).toBe(false);
    expect(vi.mocked(ws.send)).not.toHaveBeenCalled();
  });

  it('can bypass the input lock for controller cleanup transports', () => {
    const ws = createWebSocketMock();
    const transport = createRemoteTerminalTransport({
      getWebSocket: () => ws,
      isInputLocked: () => true,
      ignoreInputLock: true,
    });

    expect(transport.canSendInput()).toBe(true);
    expect(transport.sendRawInput('#fail:cleanup\n')).toBe(true);
    expect(vi.mocked(ws.send)).toHaveBeenCalledWith(
      encodeDataFrame(new TextEncoder().encode('#fail:cleanup\n')),
    );
  });

  it('sends resize frames when writable', () => {
    const ws = createWebSocketMock();
    const transport = createRemoteTerminalTransport({
      getWebSocket: () => ws,
      isInputLocked: () => false,
    });

    const sent = transport.sendResize(160, 48);

    expect(sent).toBe(true);
    expect(vi.mocked(ws.send)).toHaveBeenCalledWith(encodeResizeFrame(160, 48));
  });
});