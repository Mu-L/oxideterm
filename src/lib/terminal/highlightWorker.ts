// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import {
  matchCompiledPatternSync,
  type SafeCompiledPattern,
  type SafeMatchResult,
} from './highlightPattern';

type HighlightWorkerRequest = {
  id: number;
  pattern: SafeCompiledPattern;
  line: string;
};

type HighlightWorkerResponse = {
  id: number;
  result: SafeMatchResult;
};

self.onmessage = (event: MessageEvent<HighlightWorkerRequest>) => {
  const { id, pattern, line } = event.data;

  try {
    const matches = matchCompiledPatternSync(pattern, line);

    const response: HighlightWorkerResponse = {
      id,
      result: {
        ok: true,
        matches,
      },
    };
    self.postMessage(response);
  } catch {
    const response: HighlightWorkerResponse = {
      id,
      result: {
        ok: false,
        reason: 'error',
      },
    };
    self.postMessage(response);
  }
};

export {};