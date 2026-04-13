import { describe, expect, it } from 'vitest';

import {
  MAX_HIGHLIGHT_RULES,
  buildRuntimeHighlightRules,
  matchCompiledPatternSync,
  sanitizeHighlightRules,
} from '@/lib/terminal/highlightPattern';

describe('highlightPattern', () => {
  it('sanitizes duplicate ids, invalid colors, and normalizes priorities', () => {
    const rules = sanitizeHighlightRules([
      {
        id: 'dup',
        label: 'One',
        pattern: 'error',
        enabled: true,
        isRegex: false,
        caseSensitive: false,
        foreground: '#ff0000',
        background: 'not-a-color',
        renderMode: 'background',
        priority: 10,
      },
      {
        id: 'dup',
        label: 'Two',
        pattern: 'warn',
        enabled: true,
        isRegex: false,
        caseSensitive: false,
        foreground: 'rgb(255, 0, 0)',
        background: '#001122',
        renderMode: 'invalid',
        priority: 10,
      },
    ]);

    expect(rules).toHaveLength(2);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(2);
    expect(rules[0].background).toBeUndefined();
    expect(rules[1].renderMode).toBe('background');
    expect(new Set(rules.map((rule) => rule.priority)).size).toBe(2);
    expect(Math.max(...rules.map((rule) => rule.priority))).toBe(2);
  });

  it('rejects arbitrary alphabetic strings as colors', () => {
    const [rule] = sanitizeHighlightRules([
      {
        id: 'color-test',
        label: 'Color Test',
        pattern: 'error',
        enabled: true,
        isRegex: false,
        caseSensitive: false,
        foreground: 'alert',
        background: 'warning',
        priority: 1,
      },
    ]);

    expect(rule.foreground).toBeUndefined();
    expect(rule.background).toBeUndefined();
  });

  it('keeps CSS background colors but restricts foreground colors to terminal-safe hex', () => {
    const [rule] = sanitizeHighlightRules([
      {
        id: 'foreground-format-test',
        label: 'Foreground Format Test',
        pattern: 'error',
        enabled: true,
        isRegex: false,
        caseSensitive: false,
        foreground: 'rgb(255, 0, 0)',
        background: 'rgb(12, 34, 56)',
        priority: 1,
      },
    ]);

    expect(rule.foreground).toBeUndefined();
    expect(rule.background).toBe('rgb(12, 34, 56)');
  });

  it('caps persisted rules at the configured maximum', () => {
    const rules = sanitizeHighlightRules(
      Array.from({ length: MAX_HIGHLIGHT_RULES + 5 }, (_, index) => ({
        id: `rule-${index}`,
        label: `Rule ${index}`,
        pattern: `pattern-${index}`,
        enabled: true,
        isRegex: false,
        caseSensitive: false,
        priority: index,
      })),
    );

    expect(rules).toHaveLength(MAX_HIGHLIGHT_RULES);
  });

  it('disables runtime rules with invalid regex or empty pattern', () => {
    const rules = buildRuntimeHighlightRules([
      {
        id: 'bad-regex',
        label: 'Bad Regex',
        pattern: '[unterminated',
        enabled: true,
        isRegex: true,
        caseSensitive: false,
        priority: 5,
      },
      {
        id: 'empty',
        label: 'Empty',
        pattern: '   ',
        enabled: true,
        isRegex: false,
        caseSensitive: false,
        priority: 4,
      },
    ]);

    expect(rules[0].enabled).toBe(false);
    expect(rules[0].lastValidationError).toBe('invalid-regex');
    expect(rules[1].enabled).toBe(false);
    expect(rules[1].lastValidationError).toBe('empty-pattern');
  });

  it('rejects regex syntax outside the supported safe subset', () => {
    const rules = buildRuntimeHighlightRules([
      {
        id: 'lookahead',
        label: 'Lookahead',
        pattern: 'error(?=:)',
        enabled: true,
        isRegex: true,
        caseSensitive: false,
        priority: 2,
      },
      {
        id: 'backref',
        label: 'Backref',
        pattern: '(error)\\1',
        enabled: true,
        isRegex: true,
        caseSensitive: false,
        priority: 1,
      },
    ]);

    expect(rules[0].enabled).toBe(false);
    expect(rules[0].lastValidationError).toBe('unsupported-regex-syntax');
    expect(rules[1].enabled).toBe(false);
    expect(rules[1].lastValidationError).toBe('unsupported-regex-syntax');
  });

  it('matches regex rules without requiring wasm initialization', () => {
    const [rule] = buildRuntimeHighlightRules([
      {
        id: 'regex',
        label: 'Regex',
        pattern: 'err(or)?',
        enabled: true,
        isRegex: true,
        caseSensitive: false,
        priority: 1,
      },
    ]);

    expect(rule.compiled).toBeDefined();
    expect(matchCompiledPatternSync(rule.compiled!, 'warn error ERR')).toEqual([
      { index: 5, length: 5 },
      { index: 11, length: 3 },
    ]);
  });
});