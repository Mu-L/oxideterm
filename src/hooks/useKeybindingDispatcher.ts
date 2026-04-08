// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Unified Keybinding Dispatcher
 *
 * Single capture-phase window.keydown listener that replaces the
 * scattered handlers in App.tsx (useAppShortcuts + native fallback)
 * and useSplitPaneShortcuts.
 *
 * Uses the keybinding registry's matchAction() for key matching,
 * respects user overrides, and applies terminal gating logic.
 *
 * Terminal-scope actions are NOT handled here — they stay in
 * useTerminalViewShortcuts (per-component, bubbling phase).
 */

import { useEffect, useRef } from 'react';
import {
  matchAction,
  getDefaultDefinition,
  getBinding,
  type ActionId,
} from '@/lib/keybindingRegistry';
import { usePluginStore } from '@/store/pluginStore';
import { matchPluginKeybinding } from '@/lib/plugin/pluginHostUi';
import { matchPluginShortcut } from '@/lib/plugin/pluginTerminalHooks';
import { platform } from '@/lib/platform';

export type DispatcherContext = {
  /** Whether a terminal tab is currently active/focused */
  isTerminalActive: boolean;
  /** Whether a UI panel (search, AI, shell launcher) is open */
  isPanelOpen: boolean;
};

/**
 * Hook that registers a single capture-phase keydown handler for all
 * global, split, and palette keyboard shortcuts.
 *
 * @param handlers — Map from ActionId to handler function. Only actions with
 *                   registered handlers will be intercepted; unmatched actions
 *                   pass through (e.g. terminal-scope actions bubble to
 *                   useTerminalViewShortcuts).
 * @param context  — Current terminal/panel state for gating decisions.
 */
export function useKeybindingDispatcher(
  handlers: Partial<Record<ActionId, () => void>>,
  context: DispatcherContext,
) {
  const ctxRef = useRef(context);
  ctxRef.current = context;

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if window lost OS-level focus (e.g. another app in front)
      if (!document.hasFocus()) return;

      const ctx = ctxRef.current;
      const map = handlersRef.current;

      // Match against the registry (all scopes — unhandled matches pass through)
      const actionId = matchAction(e);
      if (actionId) {
        const handler = map[actionId];
        // If no handler registered for this action, let the event pass through.
        // Terminal-scope actions intentionally have no handler here;
        // they bubble to useTerminalViewShortcuts in the component.
        if (!handler) return;

        const def = getDefaultDefinition(actionId);
        if (!def) return;

        // ── Terminal gating ──
        if (ctx.isTerminalActive) {
          const combo = getBinding(actionId);
          if (!combo) return;

          // On macOS, shortcuts using ⌘ (meta) never conflict with terminal
          // Ctrl shortcuts, so they should always fire regardless of
          // terminalBehavior — EXCEPT for 'when-panel-open' which still
          // requires a panel to be open.
          const isSafeMetaShortcut = platform.isMac && combo.meta && !combo.ctrl;

          if (isSafeMetaShortcut) {
            // Meta shortcuts are safe from terminal conflict, but still
            // respect 'when-panel-open' gating.
            if (def.terminalBehavior === 'when-panel-open' && !ctx.isPanelOpen) return;
          } else {
            switch (def.terminalBehavior) {
              case 'never':
                return; // Let key pass to terminal
              case 'when-panel-open':
                if (!ctx.isPanelOpen) return;
                break;
              case 'always':
                break;
            }
          }
        }

        e.preventDefault();
        e.stopPropagation();
        handler();
        return;
      }

      const pluginKeybindingHandler = matchPluginKeybinding(e, usePluginStore.getState().keybindings);
      if (pluginKeybindingHandler) {
        e.preventDefault();
        e.stopPropagation();
        pluginKeybindingHandler();
        return;
      }

      // Plugin shortcuts (lowest priority — only if no built-in match)
      const pluginHandler = matchPluginShortcut(e);
      if (pluginHandler) {
        e.preventDefault();
        e.stopPropagation();
        pluginHandler();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);
}
