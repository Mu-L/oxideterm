#!/usr/bin/env node
/* eslint-disable no-console */

const { spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const tauriRoot = path.join(repoRoot, 'src-tauri');

const CASES = [
  {
    id: 'upload-file',
    description: 'single-file upload path',
    command: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      'src/test/lib/terminal/trzsz/TauriFileReader.test.ts',
      '-t',
      'opens an upload handle lazily and advances chunk offsets for file reads',
    ],
    cwd: repoRoot,
  },
  {
    id: 'upload-directory',
    description: 'directory upload entry hydration',
    command: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      'src/test/lib/terminal/trzsz/TauriFileReader.test.ts',
      '-t',
      'builds readers for recursive directory uploads and preserves relative paths',
    ],
    cwd: repoRoot,
  },
  {
    id: 'chunk-limit',
    description: 'frontend policy propagates max chunk limit into a new transfer handshake',
    command: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      'src/test/lib/terminal/trzsz/filter.policy.test.ts',
      '-t',
      'passes the configured max chunk size into each new transfer handshake',
    ],
    cwd: repoRoot,
  },
  {
    id: 'file-count-limit',
    description: 'upload-side file count limit enforcement',
    command: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      'src/test/lib/terminal/trzsz/TauriFileReader.test.ts',
      '-t',
      'rejects uploads that exceed the configured file count limit',
    ],
    cwd: repoRoot,
  },
  {
    id: 'total-bytes-limit',
    description: 'download-side total byte limit enforcement',
    command: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      'src/test/lib/terminal/trzsz/TauriFileWriter.test.ts',
      '-t',
      'rejects download chunks that exceed the configured total byte limit',
    ],
    cwd: repoRoot,
  },
  {
    id: 'upload-timeout',
    description: 'frontend upload initialization timeout and policy snapshot path',
    command: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      'src/test/lib/terminal/trzsz/filter.test.ts',
      '-t',
      'snapshots the latest policy for uploads and rejects when the handshake times out',
    ],
    cwd: repoRoot,
  },
  {
    id: 'input-intercept-cancel',
    description: 'transfer-state input interception and Ctrl+C cancel path',
    command: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      'src/test/lib/terminal/trzsz/filter.test.ts',
      '-t',
      'intercepts terminal input while a transfer is active and cancels on Ctrl\\+C',
    ],
    cwd: repoRoot,
  },
  {
    id: 'download-file',
    description: 'single-file download write and finish path',
    command: 'cargo',
    args: ['test', 'trzsz::download::tests::writes_and_finishes_download_via_temp_file', '--lib'],
    cwd: tauriRoot,
  },
  {
    id: 'download-directory',
    description: 'directory download creation path',
    command: 'cargo',
    args: ['test', 'trzsz::download::tests::creates_empty_directory_inside_prepared_root', '--lib'],
    cwd: tauriRoot,
  },
  {
    id: 'cancel',
    description: 'abort cleanup for canceled download',
    command: 'cargo',
    args: ['test', 'trzsz::download::tests::abort_removes_temp_file', '--lib'],
    cwd: tauriRoot,
  },
  {
    id: 'malicious-path',
    description: 'path traversal rejection',
    command: 'cargo',
    args: ['test', 'trzsz::path_guard::tests::rejects_traversal_components', '--lib'],
    cwd: tauriRoot,
  },
  {
    id: 'download-conflict',
    description: 'download conflict rejection for exclusive directory creation',
    command: 'cargo',
    args: [
      'test',
      'trzsz::download::tests::rejects_reusing_existing_directory_when_creation_must_be_exclusive',
      '--lib',
    ],
    cwd: tauriRoot,
  },
  {
    id: 'symlink-directory',
    description: 'directory upload rejects embedded symlinks',
    command: 'cargo',
    args: ['test', 'trzsz::upload::tests::rejects_symlink_during_directory_scan', '--lib'],
    cwd: tauriRoot,
  },
  {
    id: 'owner-cleanup',
    description: 'owner cleanup removes temp files and staged directories',
    command: 'cargo',
    args: [
      'test',
      'trzsz::download::tests::cleanup_owner_removes_temp_files_and_uncommitted_directories',
      '--lib',
    ],
    cwd: tauriRoot,
  },
  {
    id: 'settings-toggle',
    description: 'runtime settings toggle disposes controller and keeps old controller out of the input path',
    command: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      'src/test/components/terminal/TerminalView.trzsz.test.tsx',
      '-t',
      'disposes the controller when the in-band transfer setting is disabled at runtime',
    ],
    cwd: repoRoot,
  },
  {
    id: 'capabilities-mismatch',
    description: 'backend capability api mismatch blocks handshake before file selection starts',
    command: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      'src/test/lib/terminal/trzsz/controller.test.ts',
      '-t',
      'fails transfer handshakes when the backend capability version mismatches',
    ],
    cwd: repoRoot,
  },
  {
    id: 'reconnect-isolation',
    description: 'disconnect and reconnect isolate stale controller and websocket callbacks',
    command: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      'src/test/components/terminal/TerminalView.trzsz.test.tsx',
      '-t',
      'disposes the controller on disconnect, recreates it on ws_url change, and releases onBinary on unmount',
    ],
    cwd: repoRoot,
  },
  {
    id: 'stale-dialog-runtime',
    description: 'pending dialog results clean up on the original websocket after the controller runtime is invalidated',
    command: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      'src/test/lib/terminal/trzsz/controller.test.ts',
      '-t',
      'keeps cleanup protocol pinned to the original transport after the controller runtime is invalidated',
    ],
    cwd: repoRoot,
  },
  {
    id: 'frontend-suite',
    description: 'full frontend trzsz maintenance suite',
    command: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      'src/test/lib/terminal/trzsz/transport.test.ts',
      'src/test/lib/terminal/trzsz/controller.test.ts',
      'src/test/lib/terminal/trzsz/filter.test.ts',
      'src/test/lib/terminal/trzsz/filter.policy.test.ts',
      'src/test/lib/terminal/trzsz/TauriFileReader.test.ts',
      'src/test/lib/terminal/trzsz/TauriFileWriter.test.ts',
      'src/test/components/terminal/TerminalView.trzsz.test.tsx',
      'src/test/store/settingsStore.test.ts',
    ],
    cwd: repoRoot,
  },
  {
    id: 'rust-suite',
    description: 'full Rust trzsz suite',
    command: 'cargo',
    args: ['test', 'trzsz::', '--lib'],
    cwd: tauriRoot,
  },
];

function printCases() {
  console.log('[trzsz-regression] Cases:');
  for (const testCase of CASES) {
    const rendered = [testCase.command, ...testCase.args].join(' ');
    console.log(`- ${testCase.id}: ${testCase.description}`);
    console.log(`  ${rendered}`);
  }
}

function runCase(testCase) {
  console.log(`\n[trzsz-regression] ${testCase.id}: ${testCase.description}`);
  const result = spawnSync(testCase.command, testCase.args, {
    cwd: testCase.cwd,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const caseIndex = args.indexOf('--case');
  const selectedCaseId = caseIndex >= 0 ? args[caseIndex + 1] : null;

  if (listOnly) {
    printCases();
    return;
  }

  const selectedCases = selectedCaseId
    ? CASES.filter((testCase) => testCase.id === selectedCaseId)
    : CASES;

  if (selectedCases.length === 0) {
    console.error(`[trzsz-regression] Unknown case: ${selectedCaseId}`);
    process.exit(1);
  }

  console.log('[trzsz-regression] Matrix source: src/lib/terminal/trzsz/UPSTREAM_DIFF.md');
  for (const testCase of selectedCases) {
    runCase(testCase);
  }
  console.log('\n[trzsz-regression] All requested cases passed.');
}

main();