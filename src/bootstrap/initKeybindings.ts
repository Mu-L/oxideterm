// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

// Force keybinding store initialization during app startup so persisted
// overrides are pushed into keybindingRegistry before any terminal mounts.
import '@/store/keybindingStore';

export {};