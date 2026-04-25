import { describe, expect, it } from 'vitest';
import {
  encodeTerminalInput,
  normalizeTerminalEncoding,
  TerminalEncodingMismatchDetector,
  TerminalOutputDecoder,
} from '@/lib/terminalEncoding';

describe('terminalEncoding', () => {
  it('normalizes unknown encodings to utf-8', () => {
    expect(normalizeTerminalEncoding('shift-jis')).toBe('shift_jis');
    expect(normalizeTerminalEncoding('nope')).toBe('utf-8');
  });

  it('keeps ASCII input on the synchronous byte fast path', () => {
    const encoded = encodeTerminalInput('ls -la\r', 'gbk');
    expect(ArrayBuffer.isView(encoded)).toBe(true);
    expect(Array.from(encoded as Uint8Array)).toEqual(Array.from(new TextEncoder().encode('ls -la\r')));
  });

  it('decodes legacy terminal output and re-encodes it for xterm', () => {
    const decoder = new TerminalOutputDecoder('gbk');
    const transformed = decoder.transform(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]));

    expect(transformed.text).toBe('中文');
    expect(new TextDecoder().decode(transformed.bytes)).toBe('中文');
  });

  it('suggests a legacy encoding when UTF-8 output looks garbled', () => {
    const detector = new TerminalEncodingMismatchDetector();
    const gbkChinese = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);
    let detection = null;

    for (let i = 0; i < 50; i += 1) {
      detection = detector.observe(gbkChinese);
    }

    expect(detection).not.toBeNull();
    expect(detection?.suggestions.length).toBeGreaterThan(0);
    expect(detection?.replacementCount).toBeGreaterThan(0);
  });
});
