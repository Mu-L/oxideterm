import { describe, expect, it } from 'vitest';
import { SerialConsoleIngress } from '@/lib/terminal/serialConsoleIngress';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('serialConsoleIngress', () => {
  it('keeps boot text after an unterminated OSC sequence', () => {
    const ingress = new SerialConsoleIngress();

    const first = ingress.filter(encoder.encode('\x1b]boot-noise-without-terminator'));
    const second = ingress.filter(encoder.encode('I (30) boot: ESP-IDF v3.0.7\r\n'));

    expect(decoder.decode(first)).toBe('?boot-noise-without-terminator');
    expect(decoder.decode(second)).toContain('I (30) boot: ESP-IDF v3.0.7');
  });

  it('preserves ANSI CSI when ESC is split across chunks', () => {
    const ingress = new SerialConsoleIngress();

    expect(Array.from(ingress.filter(new Uint8Array([0x1b])))).toEqual([]);
    expect(Array.from(ingress.filter(encoder.encode('[31mred\x1b[0m')))).toEqual(
      Array.from(encoder.encode('\x1b[31mred\x1b[0m')),
    );
  });
});
