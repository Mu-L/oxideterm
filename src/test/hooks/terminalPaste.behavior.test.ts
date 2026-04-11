import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

import { attachTerminalSmartCopy } from '@/hooks/useTerminalSmartCopy';
import { setOverrides } from '@/lib/keybindingRegistry';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  encodeTerminalTextInput,
} from '@/lib/terminalInput';
import { readSystemClipboardText } from '@/lib/clipboardSupport';

vi.mock('@/lib/clipboardSupport', () => ({
  readSystemClipboardText: vi.fn(),
  writeSystemClipboardText: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/platform', () => ({
  platform: {
    isWindows: true,
    isLinux: false,
    isMac: false,
  },
}));

type Handler = (event: KeyboardEvent) => boolean;

function createTerminalMock() {
  let handler: Handler | null = null;

  return {
    term: {
      attachCustomKeyEventHandler: vi.fn((nextHandler: Handler) => {
        handler = nextHandler;
      }),
      hasSelection: vi.fn(() => false),
      getSelection: vi.fn(() => ''),
    } as unknown as Terminal,
    getHandler: () => handler,
  };
}

function createShortcutEvent(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', init);
  vi.spyOn(event, 'preventDefault');
  vi.spyOn(event, 'stopPropagation');
  return event;
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('terminal paste behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOverrides(new Map());
  });

  it('dispatches one normalized multiline payload for the native Windows paste shortcut (#62 + #63)', async () => {
    const { term, getHandler } = createTerminalMock();
    const payloads: string[] = [];
    const onPasteShortcut = vi.fn(() => {
      void readSystemClipboardText().then((text) => {
        if (text === null) {
          return;
        }

        payloads.push(new TextDecoder().decode(encodeTerminalTextInput(text)));
      });
    });
    const event = createShortcutEvent({ key: 'v', ctrlKey: true, shiftKey: true });

    vi.mocked(readSystemClipboardText).mockResolvedValue('git status\r\ngit diff');

    attachTerminalSmartCopy(term, {
      isActive: () => true,
      isEnabled: () => true,
      onPasteShortcut,
    });

    const handled = getHandler()?.(event);
    await flushAsyncWork();

    expect(handled).toBe(false);
    expect(onPasteShortcut).toHaveBeenCalledOnce();
    expect(readSystemClipboardText).toHaveBeenCalledOnce();
    expect(payloads).toEqual([
      `${BRACKETED_PASTE_START}git status\ngit diff${BRACKETED_PASTE_END}`,
    ]);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it('keeps custom Ctrl+V remaps on the same single-dispatch normalized paste pipeline', async () => {
    const { term, getHandler } = createTerminalMock();
    const payloads: string[] = [];
    const onPasteShortcut = vi.fn(() => {
      void readSystemClipboardText().then((text) => {
        if (text === null) {
          return;
        }

        payloads.push(new TextDecoder().decode(encodeTerminalTextInput(text)));
      });
    });
    const event = createShortcutEvent({ key: 'v', ctrlKey: true });

    vi.mocked(readSystemClipboardText).mockResolvedValue('npm install\r\npnpm dev');
    setOverrides(new Map([
      ['terminal.paste', {
        other: { key: 'v', ctrl: true, shift: false, alt: false, meta: false },
      }],
    ]));

    attachTerminalSmartCopy(term, {
      isActive: () => true,
      isEnabled: () => true,
      onPasteShortcut,
    });

    const handled = getHandler()?.(event);
    await flushAsyncWork();

    expect(handled).toBe(false);
    expect(onPasteShortcut).toHaveBeenCalledOnce();
    expect(readSystemClipboardText).toHaveBeenCalledOnce();
    expect(payloads).toEqual([
      `${BRACKETED_PASTE_START}npm install\npnpm dev${BRACKETED_PASTE_END}`,
    ]);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
});