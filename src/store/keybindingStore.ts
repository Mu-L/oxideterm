// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Keybinding Store — persists user keybinding overrides to localStorage.
 *
 * Only user-modified bindings are stored (diff-based).
 * On load the overrides are pushed into the registry via setOverrides().
 */

import { create } from 'zustand';
import {
  type ActionId,
  type KeyCombo,
  setOverrides,
  getDefaultDefinition,
  getDefaults,
  combosEqual,
} from '@/lib/keybindingRegistry';

// ─── Serialisation ───────────────────────────────────────────────────

const STORAGE_KEY = 'oxideterm_keybindings';

type SerializedOverride = {
  mac?: KeyCombo;
  other?: KeyCombo;
};

type SerializedData = Record<string, SerializedOverride>;

function loadOverrides(): Map<ActionId, SerializedOverride> {
  const map = new Map<ActionId, SerializedOverride>();
  const validIds = new Set(getDefaults().map((d) => d.id));
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return map;
    const parsed: SerializedData = JSON.parse(raw);
    for (const [id, override] of Object.entries(parsed)) {
      if (validIds.has(id as ActionId)) {
        map.set(id as ActionId, override);
      } else {
        console.warn('[KeybindingStore] Unknown ActionId in localStorage, skipping:', id);
      }
    }
  } catch (e) {
    console.error('[KeybindingStore] Failed to load overrides, resetting to defaults:', e);
    localStorage.removeItem(STORAGE_KEY);
  }
  return map;
}

function persistOverrides(overrides: Map<ActionId, SerializedOverride>): void {
  try {
    const obj: SerializedData = {};
    for (const [id, override] of overrides) {
      obj[id] = override;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch (e) {
    console.error('[KeybindingStore] Failed to persist overrides:', e);
  }
}

// ─── Store ───────────────────────────────────────────────────────────

type KeybindingStore = {
  overrides: Map<ActionId, SerializedOverride>;

  /**
   * Set (or clear) a user override for a specific action + platform side.
   * If the new combo matches the default, the override is removed (reset to default).
   */
  setBinding: (actionId: ActionId, side: 'mac' | 'other', combo: KeyCombo) => void;

  /**
   * Remove a user override for a specific action + platform side (reset to default).
   */
  resetBinding: (actionId: ActionId, side: 'mac' | 'other') => void;

  /**
   * Remove all user overrides (reset everything to defaults).
   */
  resetAll: () => void;
};

// Initialise: load from localStorage and push into registry immediately.
const initialOverrides = loadOverrides();
setOverrides(initialOverrides);

export const useKeybindingStore = create<KeybindingStore>((set) => ({
  overrides: initialOverrides,

  setBinding: (actionId, side, combo) => {
    set((state) => {
      const def = getDefaultDefinition(actionId);
      const isDefault = def && combosEqual(def[side], combo);

      const next = new Map(state.overrides);
      const existing = next.get(actionId) ?? {};

      if (isDefault) {
        // Remove override for this side — it matches the default
        const { [side]: _, ...rest } = existing;
        if (Object.keys(rest).length === 0) {
          next.delete(actionId);
        } else {
          next.set(actionId, rest);
        }
      } else {
        next.set(actionId, { ...existing, [side]: combo });
      }

      setOverrides(next);
      persistOverrides(next);
      return { overrides: next };
    });
  },

  resetBinding: (actionId, side) => {
    set((state) => {
      const next = new Map(state.overrides);
      const existing = next.get(actionId);
      if (!existing) return state;

      const { [side]: _, ...rest } = existing;
      if (Object.keys(rest).length === 0) {
        next.delete(actionId);
      } else {
        next.set(actionId, rest);
      }

      setOverrides(next);
      persistOverrides(next);
      return { overrides: next };
    });
  },

  resetAll: () => {
    set(() => {
      const next = new Map<ActionId, SerializedOverride>();
      setOverrides(next);
      persistOverrides(next);
      return { overrides: next };
    });
  },
}));
