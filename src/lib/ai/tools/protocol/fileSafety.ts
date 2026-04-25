// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

export interface FileReadData {
  path: string;
  content: string;
  encoding: string;
  size: number;
  mtime?: number | null;
  contentHash: string;
  truncated?: boolean;
}

export interface FileWriteRequest {
  path: string;
  content: string;
  encoding?: string;
  expectedHash?: string;
  expectedMtime?: number;
  createOnly?: boolean;
  append?: boolean;
  dryRun?: boolean;
}

export interface FileWriteData {
  path: string;
  size: number | null;
  mtime?: number | null;
  contentHash?: string;
  encoding?: string;
  atomic?: boolean;
  dryRun?: boolean;
  diffSummary?: FileDiffSummary;
}

export interface FileDiffSummary {
  beforeSize: number | null;
  afterSize: number;
  beforeHash?: string;
  afterHash: string;
  changed: boolean;
}

const textEncoder = new TextEncoder();

function fallbackHash(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashTextContent(content: string, encoding = 'utf-8'): Promise<string> {
  const bytes = textEncoder.encode(`${encoding}\0${content}`);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return fallbackHash(bytes);
  }

  const digest = await subtle.digest('SHA-256', bytes);
  return `sha256:${toHex(digest)}`;
}

export function byteLengthOfText(content: string): number {
  return textEncoder.encode(content).byteLength;
}

export function buildFileDiffSummary(input: {
  beforeContent?: string;
  beforeSize?: number | null;
  beforeHash?: string;
  afterContent: string;
  afterHash: string;
}): FileDiffSummary {
  const beforeSize = input.beforeSize ?? (input.beforeContent !== undefined ? byteLengthOfText(input.beforeContent) : null);
  return {
    beforeSize,
    afterSize: byteLengthOfText(input.afterContent),
    ...(input.beforeHash ? { beforeHash: input.beforeHash } : {}),
    afterHash: input.afterHash,
    changed: input.beforeHash ? input.beforeHash !== input.afterHash : input.beforeContent !== input.afterContent,
  };
}

export function parseFileWriteRequest(args: Record<string, unknown>): FileWriteRequest {
  return {
    path: typeof args.path === 'string' ? args.path.trim() : '',
    content: typeof args.content === 'string' ? args.content : '',
    ...(typeof args.encoding === 'string' ? { encoding: args.encoding } : {}),
    ...(typeof args.expectedHash === 'string' ? { expectedHash: args.expectedHash } : {}),
    ...(typeof args.expected_hash === 'string' ? { expectedHash: args.expected_hash } : {}),
    ...(typeof args.expectedMtime === 'number' ? { expectedMtime: args.expectedMtime } : {}),
    ...(typeof args.expected_mtime === 'number' ? { expectedMtime: args.expected_mtime } : {}),
    ...(args.createOnly === true || args.create_only === true ? { createOnly: true } : {}),
    ...(args.append === true ? { append: true } : {}),
    ...(args.dryRun === true || args.dry_run === true ? { dryRun: true } : {}),
  };
}

