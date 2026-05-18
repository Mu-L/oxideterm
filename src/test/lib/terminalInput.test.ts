import { describe, expect, it } from 'vitest';

import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  encodeTerminalExecuteInput,
  encodeTerminalTextInput,
  formatTerminalPasteInput,
  formatTerminalTextInput,
  normalizeTerminalLineEndings,
  prepareTerminalPasteText,
  shouldUseBracketedPaste,
} from '@/lib/terminalInput';

describe('normalizeTerminalLineEndings', () => {
  it('converts Windows CRLF to LF', () => {
    expect(normalizeTerminalLineEndings('line 1\r\nline 2')).toBe('line 1\nline 2');
  });

  it('converts lone carriage returns to LF', () => {
    expect(normalizeTerminalLineEndings('line 1\rline 2')).toBe('line 1\nline 2');
  });
});

describe('shouldUseBracketedPaste', () => {
  it('returns false for single-line input', () => {
    expect(shouldUseBracketedPaste('ls -la')).toBe(false);
  });

  it('returns true for multiline input', () => {
    expect(shouldUseBracketedPaste('line 1\nline 2')).toBe(true);
  });

  it('treats CRLF content as multiline input', () => {
    expect(shouldUseBracketedPaste('line 1\r\nline 2')).toBe(true);
  });
});

describe('formatTerminalTextInput', () => {
  it('keeps single-line input unchanged', () => {
    expect(formatTerminalTextInput('pwd')).toBe('pwd');
  });

  it('wraps multiline input in bracketed paste markers', () => {
    expect(formatTerminalTextInput('git status\ngit diff')).toBe(
      `${BRACKETED_PASTE_START}git status\ngit diff${BRACKETED_PASTE_END}`
    );
  });

  it('normalizes CRLF before wrapping multiline input in bracketed paste markers', () => {
    expect(formatTerminalTextInput('git status\r\ngit diff')).toBe(
      `${BRACKETED_PASTE_START}git status\ngit diff${BRACKETED_PASTE_END}`
    );
  });

  it('preserves empty input', () => {
    expect(formatTerminalTextInput('')).toBe('');
  });
});

describe('prepareTerminalPasteText', () => {
  it('converts LF line endings to CR for terminal paste', () => {
    expect(prepareTerminalPasteText('line 1\nline 2')).toBe('line 1\rline 2');
  });

  it('converts CRLF line endings to CR for terminal paste', () => {
    expect(prepareTerminalPasteText('line 1\r\nline 2')).toBe('line 1\rline 2');
  });

  it('preserves existing CR line endings', () => {
    expect(prepareTerminalPasteText('line 1\rline 2')).toBe('line 1\rline 2');
  });
});

describe('formatTerminalPasteInput', () => {
  it('does not wrap multiline paste when bracketed paste mode is disabled', () => {
    expect(formatTerminalPasteInput('git status\ngit diff', false)).toBe('git status\rgit diff');
  });

  it('wraps multiline paste when bracketed paste mode is enabled', () => {
    expect(formatTerminalPasteInput('git status\ngit diff', true)).toBe(
      `${BRACKETED_PASTE_START}git status\rgit diff${BRACKETED_PASTE_END}`
    );
  });

  it('keeps single-line paste unwrapped even when bracketed paste mode is enabled', () => {
    expect(formatTerminalPasteInput('pwd', true)).toBe('pwd');
  });
});

describe('encodeTerminalTextInput', () => {
  it('encodes bracketed multiline input as bytes', () => {
    const decoded = new TextDecoder().decode(encodeTerminalTextInput('a\nb'));

    expect(decoded).toBe(`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`);
  });

  it('encodes CRLF multiline input with normalized LF bytes', () => {
    const decoded = new TextDecoder().decode(encodeTerminalTextInput('a\r\nb'));

    expect(decoded).toBe(`${BRACKETED_PASTE_START}a\nb${BRACKETED_PASTE_END}`);
  });

  it('encodes single-line input without extra markers', () => {
    const decoded = new TextDecoder().decode(encodeTerminalTextInput('echo ok'));

    expect(decoded).toBe('echo ok');
  });
});

describe('encodeTerminalExecuteInput', () => {
  it('appends a newline for single-line execution', () => {
    const decoded = new TextDecoder().decode(encodeTerminalExecuteInput('echo ok'));

    expect(decoded).toBe('echo ok\n');
  });

  it('wraps multiline execution in bracketed paste before the final newline', () => {
    const decoded = new TextDecoder().decode(encodeTerminalExecuteInput('mkdir test\ncd test'));

    expect(decoded).toBe(
      `${BRACKETED_PASTE_START}mkdir test\ncd test${BRACKETED_PASTE_END}\n`
    );
  });

  it('normalizes CRLF before appending the final execution newline', () => {
    const decoded = new TextDecoder().decode(encodeTerminalExecuteInput('mkdir test\r\ncd test'));

    expect(decoded).toBe(
      `${BRACKETED_PASTE_START}mkdir test\ncd test${BRACKETED_PASTE_END}\n`
    );
  });
});
