import type { HighlightRule } from '@/types';

export type RuntimeDisabledHighlightRules = Map<string, string>;

function getRuleSignature(rule: HighlightRule): string {
  return [
    rule.id,
    rule.enabled ? '1' : '0',
    rule.pattern,
    rule.isRegex ? '1' : '0',
    rule.caseSensitive ? '1' : '0',
    rule.foreground ?? '',
    rule.background ?? '',
    rule.renderMode ?? '',
    String(rule.priority),
  ].join('\u001f');
}

export function getHighlightRulesSignature(rules: HighlightRule[]): string {
  return rules.map((rule) => getRuleSignature(rule)).join('\u001e');
}

export function markRuntimeDisabledHighlightRules(
  disabledRules: RuntimeDisabledHighlightRules,
  rules: HighlightRule[],
  ruleIds: string[],
): void {
  if (!ruleIds.length) {
    return;
  }

  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));

  for (const ruleId of ruleIds) {
    const rule = rulesById.get(ruleId);
    if (!rule) {
      continue;
    }
    disabledRules.set(ruleId, getRuleSignature(rule));
  }
}

export function applyRuntimeDisabledHighlightRules(
  disabledRules: RuntimeDisabledHighlightRules,
  rules: HighlightRule[],
): HighlightRule[] {
  if (!disabledRules.size) {
    return rules;
  }

  const activeRuleIds = new Set(rules.map((rule) => rule.id));
  for (const ruleId of Array.from(disabledRules.keys())) {
    if (!activeRuleIds.has(ruleId)) {
      disabledRules.delete(ruleId);
    }
  }

  let changed = false;
  const nextRules = rules.map((rule) => {
    const disabledSignature = disabledRules.get(rule.id);
    if (!disabledSignature) {
      return rule;
    }

    if (!rule.enabled) {
      disabledRules.delete(rule.id);
      return rule;
    }

    if (disabledSignature !== getRuleSignature(rule)) {
      disabledRules.delete(rule.id);
      return rule;
    }

    changed = true;
    return { ...rule, enabled: false };
  });

  return changed ? nextRules : rules;
}