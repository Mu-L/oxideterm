// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { FigArgType } from './types';

export type FigCompatibleArgType = Exclude<FigArgType, null> | 'value' | 'command';

export interface FigCompatibleOptionSpec {
  name: string;
  description?: string;
  args?: FigCompatibleArgType;
}

export interface FigCompatibleSubcommandSpec {
  name: string;
  description?: string;
  options?: FigCompatibleOptionSpec[];
  args?: FigCompatibleArgType;
}

export interface FigCompatibleSpec {
  name: string;
  description?: string;
  subcommands?: FigCompatibleSubcommandSpec[];
  options?: FigCompatibleOptionSpec[];
  args?: FigCompatibleArgType;
}

// OxideTerm-maintained Fig-compatible curated specs.
// These are hand-written subsets inspired by common CLI shapes, not vendored
// from the full Fig autocomplete repository.
const COMMON_FILE_OPTIONS: FigCompatibleOptionSpec[] = [
  { name: '-h', description: 'Show help' },
  { name: '--help', description: 'Show help' },
  { name: '-v', description: 'Verbose output' },
  { name: '--version', description: 'Show version' },
];

function spec(
  name: string,
  description: string,
  subcommands: Array<string | FigCompatibleSubcommandSpec> = [],
  options: FigCompatibleOptionSpec[] = COMMON_FILE_OPTIONS,
  args?: FigCompatibleArgType,
): FigCompatibleSpec {
  return {
    name,
    description,
    subcommands: subcommands.map((entry) => typeof entry === 'string' ? { name: entry } : entry),
    options,
    args,
  };
}

export const FIG_COMPATIBLE_SPECS: FigCompatibleSpec[] = [
  spec('git', 'Distributed version control', [
    'add', 'branch', 'checkout', 'clone', 'commit', 'diff', 'fetch', 'init', 'log', 'merge',
    'pull', 'push', 'rebase', 'remote', 'reset', 'restore', 'show', 'stash', 'status', 'switch',
  ], [
    ...COMMON_FILE_OPTIONS,
    { name: '-C', description: 'Run as if git was started in path', args: 'directory' },
    { name: '--git-dir', args: 'directory' },
    { name: '--work-tree', args: 'directory' },
  ]),
  spec('npm', 'Node package manager', ['install', 'run', 'test', 'start', 'build', 'publish', 'update', 'init', 'exec'], COMMON_FILE_OPTIONS),
  spec('pnpm', 'Fast Node package manager', ['install', 'run', 'test', 'start', 'build', 'add', 'remove', 'update', 'exec', 'dlx'], COMMON_FILE_OPTIONS),
  spec('yarn', 'Node package manager', ['install', 'run', 'test', 'start', 'build', 'add', 'remove', 'upgrade', 'dlx'], COMMON_FILE_OPTIONS),
  spec('bun', 'JavaScript runtime and toolkit', ['run', 'test', 'install', 'add', 'remove', 'build', 'x'], COMMON_FILE_OPTIONS),
  spec('node', 'JavaScript runtime', [], [...COMMON_FILE_OPTIONS, { name: '-e', args: 'value' }], 'file'),
  spec('python', 'Python interpreter', ['-m'], [...COMMON_FILE_OPTIONS, { name: '-m', args: 'command' }], 'file'),
  spec('pip', 'Python package installer', ['install', 'uninstall', 'list', 'show', 'freeze', 'search'], COMMON_FILE_OPTIONS),
  spec('cargo', 'Rust package manager', ['build', 'check', 'clippy', 'doc', 'fmt', 'new', 'run', 'test', 'update'], COMMON_FILE_OPTIONS),
  spec('rustup', 'Rust toolchain manager', ['default', 'show', 'target', 'toolchain', 'update', 'component'], COMMON_FILE_OPTIONS),
  spec('docker', 'Container platform', ['build', 'compose', 'exec', 'images', 'logs', 'ps', 'pull', 'push', 'rm', 'rmi', 'run', 'start', 'stop'], COMMON_FILE_OPTIONS),
  spec('kubectl', 'Kubernetes CLI', ['apply', 'config', 'create', 'delete', 'describe', 'exec', 'get', 'logs', 'patch', 'port-forward'], [
    ...COMMON_FILE_OPTIONS,
    { name: '-f', description: 'Filename, directory, or URL', args: 'path' },
    { name: '--filename', args: 'path' },
    { name: '-n', description: 'Namespace', args: 'value' },
  ]),
  spec('ssh', 'OpenSSH remote login', [], [...COMMON_FILE_OPTIONS, { name: '-i', args: 'file' }, { name: '-p', args: 'value' }]),
  spec('scp', 'Secure copy', [], [...COMMON_FILE_OPTIONS, { name: '-i', args: 'file' }, { name: '-P', args: 'value' }], 'path'),
  spec('rsync', 'Fast file copy', [], [...COMMON_FILE_OPTIONS, { name: '-a' }, { name: '-z' }, { name: '--delete' }], 'path'),
  spec('tar', 'Archive utility', [], [...COMMON_FILE_OPTIONS, { name: '-f', args: 'file' }, { name: '-C', args: 'directory' }], 'path'),
  spec('curl', 'Transfer URLs', [], [...COMMON_FILE_OPTIONS, { name: '-o', args: 'file' }, { name: '-H', args: 'value' }, { name: '-X', args: 'value' }]),
  spec('wget', 'Download files', [], [...COMMON_FILE_OPTIONS, { name: '-O', args: 'file' }, { name: '-P', args: 'directory' }]),
  spec('grep', 'Search text', [], [...COMMON_FILE_OPTIONS, { name: '-r' }, { name: '-i' }, { name: '-n' }], 'path'),
  spec('rg', 'ripgrep search', [], [...COMMON_FILE_OPTIONS, { name: '-i' }, { name: '-n' }, { name: '--glob', args: 'value' }], 'path'),
  spec('find', 'Find files', [], [...COMMON_FILE_OPTIONS, { name: '-name', args: 'value' }, { name: '-type', args: 'value' }], 'directory'),
  spec('ls', 'List directory contents', [], [...COMMON_FILE_OPTIONS, { name: '-a' }, { name: '-l' }, { name: '-s' }, { name: '--all' }], 'path'),
  spec('cd', 'Change directory', [], [], 'directory'),
  spec('mkdir', 'Create directories', [], [...COMMON_FILE_OPTIONS, { name: '-p' }], 'directory'),
  spec('rm', 'Remove files', [], [...COMMON_FILE_OPTIONS, { name: '-r' }, { name: '-f' }], 'path'),
  spec('cp', 'Copy files', [], [...COMMON_FILE_OPTIONS, { name: '-r' }, { name: '-p' }], 'path'),
  spec('mv', 'Move files', [], COMMON_FILE_OPTIONS, 'path'),
  spec('chmod', 'Change file modes', [], [...COMMON_FILE_OPTIONS, { name: '-R' }], 'path'),
  spec('chown', 'Change owner/group', [], [...COMMON_FILE_OPTIONS, { name: '-R' }], 'path'),
  spec('ps', 'Process status', [], [...COMMON_FILE_OPTIONS, { name: '-a' }, { name: '-u' }, { name: '-x' }]),
  spec('kill', 'Send signal to process', [], [...COMMON_FILE_OPTIONS, { name: '-9' }, { name: '-TERM' }]),
  spec('systemctl', 'Control systemd', ['status', 'start', 'stop', 'restart', 'reload', 'enable', 'disable', 'list-units'], COMMON_FILE_OPTIONS),
  spec('brew', 'Homebrew package manager', ['install', 'uninstall', 'update', 'upgrade', 'search', 'info', 'services'], COMMON_FILE_OPTIONS),
  spec('gh', 'GitHub CLI', ['auth', 'browse', 'issue', 'pr', 'repo', 'run', 'workflow'], COMMON_FILE_OPTIONS),
];

export const FIG_SPEC_BY_NAME = new Map(FIG_COMPATIBLE_SPECS.map((entry) => [entry.name, entry]));
