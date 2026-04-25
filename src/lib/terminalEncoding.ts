// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { api } from './api';

export type TerminalEncoding =
  | 'utf-8'
  | 'gbk'
  | 'gb18030'
  | 'big5'
  | 'shift_jis'
  | 'euc-jp'
  | 'euc-kr'
  | 'windows-1252';

export const TERMINAL_ENCODINGS: readonly TerminalEncoding[] = [
  'utf-8',
  'gbk',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-jp',
  'euc-kr',
  'windows-1252',
] as const;

export function formatTerminalEncodingLabel(encoding: TerminalEncoding): string {
  switch (encoding) {
    case 'utf-8':
      return 'UTF-8';
    case 'gbk':
      return 'GBK';
    case 'gb18030':
      return 'GB18030';
    case 'big5':
      return 'Big5';
    case 'shift_jis':
      return 'Shift_JIS';
    case 'euc-jp':
      return 'EUC-JP';
    case 'euc-kr':
      return 'EUC-KR';
    case 'windows-1252':
      return 'Windows-1252';
  }
}

const utf8Encoder = new TextEncoder();

function hasOnlyAscii(input: string): boolean {
  for (let i = 0; i < input.length; i += 1) {
    if (input.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

export function normalizeTerminalEncoding(value: unknown): TerminalEncoding {
  if (typeof value !== 'string') return 'utf-8';
  const normalized = value.toLowerCase().replace(/_/g, '-');
  if (normalized === 'shift-jis') return 'shift_jis';
  return (TERMINAL_ENCODINGS as readonly string[]).includes(normalized)
    ? normalized as TerminalEncoding
    : 'utf-8';
}

export function isUtf8TerminalEncoding(encoding: TerminalEncoding): boolean {
  return encoding === 'utf-8';
}

export function encodeTerminalInput(
  input: string,
  encoding: TerminalEncoding,
): Uint8Array | Promise<Uint8Array> {
  if (isUtf8TerminalEncoding(encoding) || hasOnlyAscii(input)) {
    return utf8Encoder.encode(input);
  }

  return api.terminalEncodeText(input, encoding).then((bytes) => Uint8Array.from(bytes));
}

export type TerminalOutputTransform = {
  bytes: Uint8Array;
  text?: string;
};

export type TerminalEncodingDetection = {
  suggestions: TerminalEncoding[];
  reason: 'replacement' | 'mojibake';
  replacementCount: number;
  replacementRatio: number;
};

const DETECTION_CANDIDATES: readonly TerminalEncoding[] = [
  'gbk',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-jp',
  'euc-kr',
  'windows-1252',
];

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const _ of text.matchAll(pattern)) {
    count += 1;
  }
  return count;
}

function scoreDecodedCandidate(text: string, encoding: TerminalEncoding): number {
  if (!text) return Number.NEGATIVE_INFINITY;
  const replacements = countMatches(text, /\uFFFD/g);
  const controls = countMatches(text, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g);
  const cjk = countMatches(text, /[\u3400-\u9fff]/gu);
  const kana = countMatches(text, /[\u3040-\u30ff]/gu);
  const hangul = countMatches(text, /[\uac00-\ud7af]/gu);
  const latinExtended = countMatches(text, /[\u00c0-\u024f]/gu);
  const visible = text.length - replacements - controls;

  let score = visible - replacements * 30 - controls * 10;
  score += cjk * 4;
  score += latinExtended;
  if (encoding === 'shift_jis' || encoding === 'euc-jp') score += kana * 8;
  if (encoding === 'euc-kr') score += hangul * 8;
  if (encoding === 'windows-1252') score += latinExtended * 4;
  return score;
}

function rankEncodingCandidates(sample: Uint8Array): TerminalEncoding[] {
  return DETECTION_CANDIDATES
    .map((encoding) => {
      try {
        const text = new TextDecoder(encoding, { fatal: false }).decode(sample);
        return { encoding, score: scoreDecodedCandidate(text, encoding) };
      } catch {
        return { encoding, score: Number.NEGATIVE_INFINITY };
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.encoding);
}

export class TerminalEncodingMismatchDetector {
  private readonly sample: Uint8Array;
  private sampleBytes = 0;
  private observedBytes = 0;
  private invalidUtf8Bytes = 0;
  private pendingContinuationBytes = 0;
  private readonly maxSampleBytes: number;
  private active = true;

  constructor(maxSampleBytes = 2048) {
    this.maxSampleBytes = maxSampleBytes;
    this.sample = new Uint8Array(maxSampleBytes);
  }

  observe(data: Uint8Array): TerminalEncodingDetection | null {
    if (!this.active) return null;
    if (data.length === 0) return null;

    this.addSample(data);
    this.scanUtf8(data);
    this.observedBytes += data.length;

    if (this.observedBytes < 128 || this.sampleBytes < 64) {
      return null;
    }

    const invalidRatio = this.invalidUtf8Bytes / Math.max(1, this.observedBytes);
    const invalidTriggered = this.invalidUtf8Bytes >= 4 && invalidRatio >= 0.015;
    if (!invalidTriggered) {
      if (this.observedBytes >= 8192 && this.invalidUtf8Bytes === 0) {
        this.active = false;
      }
      return null;
    }

    const sample = this.sample.slice(0, this.sampleBytes);
    return {
      suggestions: rankEncodingCandidates(sample),
      reason: 'replacement',
      replacementCount: this.invalidUtf8Bytes,
      replacementRatio: invalidRatio,
    };
  }

  reset(): void {
    this.sampleBytes = 0;
    this.observedBytes = 0;
    this.invalidUtf8Bytes = 0;
    this.pendingContinuationBytes = 0;
    this.active = true;
  }

  private addSample(data: Uint8Array): void {
    if (this.sampleBytes >= this.maxSampleBytes) {
      return;
    }
    const byteCount = Math.min(data.length, this.maxSampleBytes - this.sampleBytes);
    if (byteCount > 0) {
      this.sample.set(data.subarray(0, byteCount), this.sampleBytes);
      this.sampleBytes += byteCount;
    }
  }

  private scanUtf8(data: Uint8Array): void {
    for (let i = 0; i < data.length; i += 1) {
      const byte = data[i];
      if (this.pendingContinuationBytes > 0) {
        if ((byte & 0xc0) === 0x80) {
          this.pendingContinuationBytes -= 1;
          continue;
        }
        this.invalidUtf8Bytes += 1;
        this.pendingContinuationBytes = 0;
        i -= 1;
        continue;
      }

      if (byte < 0x80) {
        continue;
      }
      if (byte >= 0xc2 && byte <= 0xdf) {
        this.pendingContinuationBytes = 1;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        this.pendingContinuationBytes = 2;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        this.pendingContinuationBytes = 3;
      } else {
        this.invalidUtf8Bytes += 1;
      }
    }
  }
}

export class TerminalOutputDecoder {
  private readonly encoding: TerminalEncoding;
  private readonly decoder: TextDecoder | null;

  constructor(encoding: TerminalEncoding) {
    this.encoding = encoding;
    this.decoder = isUtf8TerminalEncoding(encoding)
      ? null
      : new TextDecoder(encoding, { fatal: false });
  }

  transform(data: Uint8Array): TerminalOutputTransform {
    if (!this.decoder) {
      return { bytes: data };
    }

    const text = this.decoder.decode(data, { stream: true });
    return {
      bytes: utf8Encoder.encode(text),
      text,
    };
  }

  decodeText(data: Uint8Array): string {
    if (!this.decoder) {
      return new TextDecoder().decode(data);
    }
    return this.decoder.decode(data, { stream: true });
  }

  reset(): void {
    this.decoder?.decode();
  }

  getEncoding(): TerminalEncoding {
    return this.encoding;
  }
}
