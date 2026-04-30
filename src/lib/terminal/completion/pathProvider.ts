// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { api, nodeSftpListDir } from '@/lib/api';
import type {
  CommandBarCompletion,
  CommandBarCompletionProvider,
  CommandBarCompletionProviderArgs,
  FigArgType,
  ShellToken,
} from './types';

const LOCAL_TIMEOUT_MS = 300;
const REMOTE_TIMEOUT_MS = 800;
const CACHE_TTL_MS = 12_000;
type PathEntry = {
  name: string;
  path: string;
  file_type: string;
};
const pathCache = new Map<string, { createdAt: number; entries: PathEntry[] }>();

function looksPathLike(token: string): boolean {
  return token.startsWith('/')
    || token.startsWith('./')
    || token.startsWith('../')
    || token.startsWith('~')
    || token.includes('/');
}

function shouldRunPathProvider(token: ShellToken, activeArgType: FigArgType): boolean {
  return looksPathLike(token.value) || activeArgType === 'path' || activeArgType === 'file' || activeArgType === 'directory';
}

function inferHomeFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const match = cwd.match(/^\/Users\/[^/]+|^\/home\/[^/]+|^\/root\b/);
  return match?.[0] ?? null;
}

function normalizePathToken(token: ShellToken, cwd: string | null | undefined): {
  directory: string;
  query: string;
  displayPrefix: string;
} | null {
  const value = token.value;
  const home = inferHomeFromCwd(cwd);
  const expanded = value.startsWith('~') && home ? `${home}${value.slice(1)}` : value;
  const slashIndex = expanded.lastIndexOf('/');
  const cwdPath = cwd || '.';

  if (slashIndex >= 0) {
    const directory = slashIndex === 0 ? '/' : expanded.slice(0, slashIndex);
    const query = expanded.slice(slashIndex + 1);
    const displayPrefix = value.slice(0, value.lastIndexOf('/') + 1);
    return { directory, query, displayPrefix };
  }

  if (!cwdPath) return null;
  return { directory: cwdPath, query: expanded, displayPrefix: '' };
}

function escapePathForShell(value: string, quoted: boolean): string {
  if (quoted) return value.replace(/(["\\$`])/g, '\\$1');
  return value.replace(/([\s"'\\$`!&|;<>()[\]{}*?])/g, '\\$1');
}

function cacheKey(args: CommandBarCompletionProviderArgs, directory: string): string {
  const scope = args.context.terminalType === 'terminal' ? 'remote' : 'local';
  return [scope, args.context.nodeId ?? args.context.sessionId, args.context.cwd ?? '', directory].join('::');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });
  const result = await Promise.race([promise, timeout]).catch(() => null);
  if (timeoutId) clearTimeout(timeoutId);
  return signal.aborted ? null : result;
}

async function listEntries(args: CommandBarCompletionProviderArgs, directory: string): Promise<PathEntry[] | null> {
  const key = cacheKey(args, directory);
  const cached = pathCache.get(key);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return cached.entries;

  const isRemote = args.context.terminalType === 'terminal';
  if (isRemote && !args.context.nodeId) return null;

  const entries = await withTimeout<PathEntry[]>(
    isRemote
      ? nodeSftpListDir(args.context.nodeId!, directory)
      : api.localListDir(directory),
    isRemote ? REMOTE_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
    args.signal,
  );
  if (!entries) return null;
  pathCache.set(key, { createdAt: Date.now(), entries });
  return entries;
}

export const pathProvider: CommandBarCompletionProvider = async (args) => {
  const { parsed, activeArgType, signal } = args;
  if (!parsed.reliable || signal.aborted || !shouldRunPathProvider(parsed.currentToken, activeArgType)) {
    return [];
  }

  const pathParts = normalizePathToken(parsed.currentToken, args.context.cwd);
  if (!pathParts) return [];

  const entries = await listEntries(args, pathParts.directory);
  if (!entries || signal.aborted) return [];

  const wantedDirectory = activeArgType === 'directory';
  const wantedFile = activeArgType === 'file';
  const quoted = parsed.currentToken.quote !== null;

  return entries
    .filter((entry) => entry.name.toLowerCase().startsWith(pathParts.query.toLowerCase()))
    .filter((entry) => !wantedDirectory || entry.file_type === 'Directory')
    .filter((entry) => !wantedFile || entry.file_type !== 'Directory')
    .sort((left, right) => {
      const leftDir = left.file_type === 'Directory' ? 0 : 1;
      const rightDir = right.file_type === 'Directory' ? 0 : 1;
      return leftDir - rightDir || left.name.localeCompare(right.name);
    })
    .slice(0, 16)
    .map<CommandBarCompletion>((entry) => {
      const isDirectory = entry.file_type === 'Directory';
      const suffix = isDirectory ? '/' : '';
      const insertText = `${pathParts.displayPrefix}${escapePathForShell(entry.name, quoted)}${suffix}`;
      return {
        kind: isDirectory ? 'directory' : 'file',
        label: `${entry.name}${suffix}`,
        insertText,
        description: entry.path,
        source: 'path',
        executable: false,
        replacement: { start: parsed.currentToken.start, end: parsed.currentToken.end },
        score: (isDirectory ? 560 : 540) + entry.name.length,
        inlineSafe: true,
      };
    });
};

export function clearCommandBarPathCompletionCache(): void {
  pathCache.clear();
}
