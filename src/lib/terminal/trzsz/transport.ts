import { encodeTerminalExecuteInput, encodeTerminalTextInput } from '@/lib/terminalInput';
import { encodeDataFrame, encodeResizeFrame } from '@/lib/wireProtocol';

export interface RemoteTerminalTransport {
  canSendInput(): boolean;
  sendEncodedPayload(payload: Uint8Array): boolean;
  sendRawInput(input: string): boolean;
  sendTextInput(input: string): boolean;
  sendExecuteInput(input: string): boolean;
  sendBinaryInput(input: string): boolean;
  sendResize(cols: number, rows: number): boolean;
}

type RemoteTerminalTransportOptions = {
  getWebSocket: () => WebSocket | null;
  isInputLocked: () => boolean;
  ignoreInputLock?: boolean;
};

function binaryStringToBytes(input: string): Uint8Array {
  const bytes = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    bytes[index] = input.charCodeAt(index) & 0xff;
  }
  return bytes;
}

export function createRemoteTerminalTransport(
  options: RemoteTerminalTransportOptions,
): RemoteTerminalTransport {
  const canSendInput = () => {
    if (!options.ignoreInputLock && options.isInputLocked()) {
      return false;
    }

    const ws = options.getWebSocket();
    return ws !== null && ws.readyState === WebSocket.OPEN;
  };

  const sendEncodedPayload = (payload: Uint8Array) => {
    if (!canSendInput()) {
      return false;
    }

    const ws = options.getWebSocket();
    if (!ws) {
      return false;
    }

    ws.send(encodeDataFrame(payload));
    return true;
  };

  return {
    canSendInput,
    sendEncodedPayload,
    sendRawInput(input: string) {
      return sendEncodedPayload(new TextEncoder().encode(input));
    },
    sendTextInput(input: string) {
      return sendEncodedPayload(encodeTerminalTextInput(input));
    },
    sendExecuteInput(input: string) {
      return sendEncodedPayload(encodeTerminalExecuteInput(input));
    },
    sendBinaryInput(input: string) {
      return sendEncodedPayload(binaryStringToBytes(input));
    },
    sendResize(cols: number, rows: number) {
      if (!canSendInput()) {
        return false;
      }

      const ws = options.getWebSocket();
      if (!ws) {
        return false;
      }

      ws.send(encodeResizeFrame(cols, rows));
      return true;
    },
  };
}