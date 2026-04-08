// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { ContextMenuItem, ContextMenuTarget } from '@/types/plugin';

type PluginContextMenuRegistryEntry = {
  pluginId: string;
  target: string;
  items: ContextMenuItem[];
};

type PluginKeybindingEntry = {
  pluginId: string;
  keybinding: string;
  normalizedKey?: string;
  handler: () => void;
};

type PluginStatusBarRegistryEntry = {
  pluginId: string;
  text: string;
  tooltip?: string;
  icon?: string;
  onClick?: () => void;
  priority?: number;
  alignment?: 'left' | 'right';
};

export type VisiblePluginContextMenuItem = ContextMenuItem & {
  key: string;
  pluginId: string;
};

export type VisiblePluginStatusBarItem = PluginStatusBarRegistryEntry & {
  key: string;
};

function normalizePluginKeyPart(part: string): string {
  const normalized = part.trim().toLowerCase();

  switch (normalized) {
    case 'cmd':
    case 'command':
    case 'meta':
    case 'super':
    case 'win':
      return 'ctrl';
    case 'control':
      return 'ctrl';
    case 'option':
      return 'alt';
    case 'escape':
      return 'esc';
    case 'spacebar':
      return 'space';
    default:
      return normalized;
  }
}

function normalizeEventKey(key: string): string {
  if (key === ' ') return 'space';
  return normalizePluginKeyPart(key);
}

export function normalizePluginKeyCombo(keybinding: string): string {
  return keybinding
    .split('+')
    .map(normalizePluginKeyPart)
    .filter(Boolean)
    .sort()
    .join('+');
}

export function normalizePluginKeyboardEvent(event: KeyboardEvent): string {
  return normalizePluginComboDescriptor({
    key: event.key,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
  });
}

export function normalizePluginComboDescriptor(combo: {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}): string {
  const parts: string[] = [];

  if (combo.ctrl || combo.meta) parts.push('ctrl');
  if (combo.shift) parts.push('shift');
  if (combo.alt) parts.push('alt');

  parts.push(normalizeEventKey(combo.key));
  return parts.sort().join('+');
}

export function matchPluginKeybinding(
  event: KeyboardEvent,
  keybindings: Map<string, PluginKeybindingEntry>,
): (() => void) | undefined {
  if (keybindings.size === 0) return undefined;

  const normalizedKey = normalizePluginKeyboardEvent(event);
  for (const entry of keybindings.values()) {
    if ((entry.normalizedKey ?? normalizePluginKeyCombo(entry.keybinding)) === normalizedKey) {
      return entry.handler;
    }
  }

  return undefined;
}

export function selectVisiblePluginContextMenuItems(
  entries: Map<string, PluginContextMenuRegistryEntry>,
  target: ContextMenuTarget,
): VisiblePluginContextMenuItem[] {
  const result: VisiblePluginContextMenuItem[] = [];

  for (const [key, entry] of entries) {
    if (entry.target !== target) continue;

    for (let index = 0; index < entry.items.length; index += 1) {
      const item = entry.items[index];
      if (!item) continue;

      try {
        if (item.when && !item.when()) continue;
      } catch (error) {
        console.warn(`[PluginHostUI] Context menu predicate failed (${entry.pluginId}):`, error);
        continue;
      }

      result.push({
        ...item,
        key: `${key}:${index}`,
        pluginId: entry.pluginId,
      });
    }
  }

  return result;
}

export function selectVisiblePluginStatusBarItems(
  entries: Map<string, PluginStatusBarRegistryEntry>,
): VisiblePluginStatusBarItem[] {
  return Array.from(entries.entries())
    .map(([key, value]) => ({ key, ...value }))
    .sort((left, right) => {
      const leftPriority = left.priority ?? 0;
      const rightPriority = right.priority ?? 0;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return left.key.localeCompare(right.key);
    });
}