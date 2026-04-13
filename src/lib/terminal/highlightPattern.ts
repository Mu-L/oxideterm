// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { HighlightRule, HighlightRuleRenderMode } from '@/types';

export const MAX_HIGHLIGHT_RULES = 32;
export const MAX_HIGHLIGHT_PATTERN_LENGTH = 512;
export const DEFAULT_HIGHLIGHT_RENDER_MODE: HighlightRuleRenderMode = 'background';

export type HighlightValidationError =
  | 'empty-pattern'
  | 'pattern-too-long'
  | 'invalid-regex'
  | 'unsupported-regex-syntax'
  | 'empty-match';

export type SafeCompiledPattern =
  | { kind: 'literal'; needle: string; caseSensitive: boolean }
  | { kind: 'regex'; source: string; flags: string };

export type SafeMatchResult =
  | { ok: true; matches: Array<{ index: number; length: number }> }
  | { ok: false; reason: 'timeout' | 'error' };

export type RuntimeHighlightRule = HighlightRule & {
  compiled?: SafeCompiledPattern;
  normalizedPriority: number;
  lastValidationError?: HighlightValidationError;
};

type SanitizedRuleCandidate = HighlightRule & {
  _sortPriority: number;
  _index: number;
};

const VALID_RENDER_MODES = new Set<HighlightRuleRenderMode>(['background', 'underline', 'outline']);
const VALID_BACKGROUND_COLOR_PATTERNS = [
  /^#[0-9a-f]{3,8}$/i,
  /^(?:rgb|rgba|hsl|hsla)\([^)]*\)$/i,
  /^var\(--[^)]+\)$/i,
];
const VALID_FOREGROUND_COLOR_PATTERNS = [
  /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i,
];

function generateHighlightRuleId(index: number): string {
  return `highlight-rule-${index + 1}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeColor(value: unknown, patterns: RegExp[]): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return patterns.some((pattern) => pattern.test(trimmed)) ? trimmed : undefined;
}

function normalizePattern(pattern: unknown): string {
  return typeof pattern === 'string' ? pattern.trim() : '';
}

function getRegexFlags(caseSensitive: boolean): string {
  return caseSensitive ? 'gu' : 'giu';
}

function hasUnsupportedRegexSyntax(pattern: string): boolean {
  let escaped = false;
  let inCharClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index];
    if (escaped) {
      if (!inCharClass && /[1-9]/.test(current)) {
        return true;
      }

      if (!inCharClass && current === 'k' && pattern[index + 1] === '<') {
        return true;
      }

      escaped = false;
      continue;
    }

    if (current === '\\') {
      escaped = true;
      continue;
    }

    if (current === '[') {
      inCharClass = true;
      continue;
    }

    if (current === ']' && inCharClass) {
      inCharClass = false;
      continue;
    }

    if (inCharClass || current !== '(' || pattern[index + 1] !== '?') {
      continue;
    }

    const third = pattern[index + 2];
    const fourth = pattern[index + 3];
    if (third === '=' || third === '!' || third === '>') {
      return true;
    }

    if (third === '<' && (fourth === '=' || fourth === '!')) {
      return true;
    }
  }

  return false;
}

function createRegexMatcher(source: string, flags: string): RegExp {
  return new RegExp(source, flags);
}

export function validateHighlightPattern(
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean,
): { valid: boolean; reason?: HighlightValidationError; compiled?: SafeCompiledPattern } {
  const normalizedPattern = normalizePattern(pattern);

  if (!normalizedPattern) {
    return { valid: false, reason: 'empty-pattern' };
  }

  if (normalizedPattern.length > MAX_HIGHLIGHT_PATTERN_LENGTH) {
    return { valid: false, reason: 'pattern-too-long' };
  }

  if (!isRegex) {
    return {
      valid: true,
      compiled: {
        kind: 'literal',
        needle: caseSensitive ? normalizedPattern : normalizedPattern.toLowerCase(),
        caseSensitive,
      },
    };
  }

  const flags = getRegexFlags(caseSensitive);

  try {
    const nativeRegex = new RegExp(normalizedPattern, flags);
    if (nativeRegex.exec('') !== null) {
      return { valid: false, reason: 'empty-match' };
    }
  } catch {
    return { valid: false, reason: 'invalid-regex' };
  }

  if (hasUnsupportedRegexSyntax(normalizedPattern)) {
    return { valid: false, reason: 'unsupported-regex-syntax' };
  }

  return {
    valid: true,
    compiled: {
      kind: 'regex',
      source: normalizedPattern,
      flags,
    },
  };
}

export function matchCompiledPatternSync(
  pattern: SafeCompiledPattern,
  line: string,
): Array<{ index: number; length: number }> {
  if (!line) {
    return [];
  }

  if (pattern.kind === 'literal') {
    const haystack = pattern.caseSensitive ? line : line.toLowerCase();
    const matches: Array<{ index: number; length: number }> = [];
    let searchFrom = 0;
    while (searchFrom < haystack.length) {
      const index = haystack.indexOf(pattern.needle, searchFrom);
      if (index === -1) {
        break;
      }
      matches.push({ index, length: pattern.needle.length });
      searchFrom = index + Math.max(pattern.needle.length, 1);
    }
    return matches;
  }

  const matcher = createRegexMatcher(pattern.source, pattern.flags);
  const matches: Array<{ index: number; length: number }> = [];
  matcher.lastIndex = 0;
  let result = matcher.exec(line);
  while (result) {
    const matchedText = result[0] ?? '';
    if (!matchedText.length) {
      break;
    }

    matches.push({ index: result.index, length: matchedText.length });
    result = matcher.exec(line);
  }

  return matches;
}

function createSanitizedCandidate(input: unknown, index: number, seenIds: Set<string>): SanitizedRuleCandidate {
  const source = input && typeof input === 'object' ? (input as Partial<HighlightRule>) : {};
  let id = typeof source.id === 'string' ? source.id.trim() : '';
  if (!id || seenIds.has(id)) {
    id = generateHighlightRuleId(index);
  }
  seenIds.add(id);

  const renderMode = VALID_RENDER_MODES.has(source.renderMode as HighlightRuleRenderMode)
    ? source.renderMode as HighlightRuleRenderMode
    : DEFAULT_HIGHLIGHT_RENDER_MODE;

  const priority = Number.isFinite(source.priority)
    ? Math.round(Number(source.priority))
    : MAX_HIGHLIGHT_RULES - index;

  return {
    id,
    label: typeof source.label === 'string' ? source.label.trim() : '',
    pattern: normalizePattern(source.pattern),
    isRegex: Boolean(source.isRegex),
    caseSensitive: Boolean(source.caseSensitive),
    foreground: sanitizeColor(source.foreground, VALID_FOREGROUND_COLOR_PATTERNS),
    background: sanitizeColor(source.background, VALID_BACKGROUND_COLOR_PATTERNS),
    renderMode,
    enabled: Boolean(source.enabled),
    priority,
    _sortPriority: priority,
    _index: index,
  };
}

function normalizeUniquePriorities(rules: SanitizedRuleCandidate[]): HighlightRule[] {
  // Keep the caller's array order stable while rewriting priorities into a
  // unique highest-to-lowest sequence derived from the requested sort weight.
  const sorted = [...rules].sort((left, right) => {
    if (right._sortPriority !== left._sortPriority) {
      return right._sortPriority - left._sortPriority;
    }
    return left._index - right._index;
  });

  const normalizedPriorityById = new Map<string, number>();
  const highestPriority = sorted.length;
  sorted.forEach((rule, index) => {
    normalizedPriorityById.set(rule.id, highestPriority - index);
  });

  return rules.map(({ _sortPriority: _ignoredPriority, _index: _ignoredIndex, ...rule }) => ({
    ...rule,
    priority: normalizedPriorityById.get(rule.id) ?? 1,
  }));
}

export function sanitizeHighlightRules(input: unknown): HighlightRule[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seenIds = new Set<string>();
  const candidates = input
    .slice(0, MAX_HIGHLIGHT_RULES)
    .map((rule, index) => createSanitizedCandidate(rule, index, seenIds));

  return normalizeUniquePriorities(candidates);
}

export function reindexHighlightRules(rules: HighlightRule[]): HighlightRule[] {
  const sanitized = sanitizeHighlightRules(rules);
  const total = sanitized.length;
  return sanitized.map((rule, index) => ({
    ...rule,
    priority: total - index,
  }));
}

export function createDefaultHighlightRule(overrides: Partial<HighlightRule> = {}): HighlightRule {
  const base: HighlightRule = {
    id: generateHighlightRuleId(0),
    label: '',
    pattern: '',
    isRegex: false,
    caseSensitive: false,
    foreground: '#f8fafc',
    background: '#991b1b',
    renderMode: 'background',
    enabled: true,
    priority: 1,
  };

  return sanitizeHighlightRules([{ ...base, ...overrides }])[0] ?? base;
}

export function buildRuntimeHighlightRules(input: unknown): RuntimeHighlightRule[] {
  const sanitized = sanitizeHighlightRules(input);
  return sanitized.map((rule) => {
    const validation = validateHighlightPattern(rule.pattern, rule.isRegex, rule.caseSensitive);
    return {
      ...rule,
      compiled: validation.compiled,
      enabled: validation.valid ? rule.enabled : false,
      normalizedPriority: rule.priority,
      lastValidationError: validation.reason,
    };
  });
}