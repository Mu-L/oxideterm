// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { ShellParseResult, ShellToken } from './types';

function unescapeToken(raw: string, quote: ShellToken['quote']): string {
  let value = raw;
  if (quote && value.startsWith(quote)) {
    value = value.slice(1);
  }
  if (quote && value.endsWith(quote)) {
    value = value.slice(0, -1);
  }
  return value.replace(/\\(.)/g, '$1');
}

function makeEmptyToken(index: number): ShellToken {
  return { raw: '', value: '', start: index, end: index, quote: null };
}

export function tokenizeCommandLine(input: string, cursorIndex = input.length): ShellParseResult {
  const cursor = Math.max(0, Math.min(input.length, cursorIndex));
  const tokens: ShellToken[] = [];
  let tokenStart = -1;
  let quote: ShellToken['quote'] = null;
  let escaped = false;
  let reliable = true;
  let tokenQuote: ShellToken['quote'] = null;

  const pushToken = (end: number) => {
    if (tokenStart < 0) return;
    const raw = input.slice(tokenStart, end);
    tokens.push({
      raw,
      value: unescapeToken(raw, tokenQuote),
      start: tokenStart,
      end,
      quote: tokenQuote,
    });
    tokenStart = -1;
    tokenQuote = null;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      if (tokenStart < 0) tokenStart = index;
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      if (tokenStart < 0) {
        tokenStart = index;
        tokenQuote = char;
      }
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      pushToken(index);
      continue;
    }

    if (tokenStart < 0) {
      tokenStart = index;
      tokenQuote = null;
    }
  }

  pushToken(input.length);
  if (quote || escaped) reliable = false;

  const currentTokenIndex = tokens.findIndex((token) => (
    cursor >= token.start && cursor <= token.end
  ));
  const currentToken = currentTokenIndex >= 0
    ? tokens[currentTokenIndex]
    : makeEmptyToken(cursor);

  return {
    input,
    cursorIndex: cursor,
    reliable,
    tokens,
    currentToken,
    currentTokenIndex,
    commandName: tokens[0]?.value || null,
  };
}
